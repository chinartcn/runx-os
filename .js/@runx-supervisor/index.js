'use strict';

/**
 * @runx-supervisor —— RunX 进程监管核心扩展
 *
 * 消费 ctx.os（仅 core 扩展可见）提供的受管 spawn / terminate，
 * 实现文档 §5 的进程生命周期、重启策略、重启预算、日志重定向与
 * 应用管理 API。运行时状态只留在内存（文档 §10：崩了重启即可，不恢复）。
 *
 * 与其它核心扩展的契约（经 ctx.os.ipc）：
 *   · 监听  'apps:changed'  —— @runx-pax 安装/卸载/更新后触发，重新对齐进程
 *   · 发出  'app:started' / 'app:stopped' / 'app:restarting' / 'app:failed'
 *
 * 注意：NavExt 内核自留了 /api/*，所以 RunX 的 REST 走 /runx 前缀。
 */

const API = '/runx';
const crypto = require('crypto');
const path = require('path');

/**
 * 给每个应用一个长期 token。
 *
 * 桌面 API（/runx/host）靠它认人：应用**不能自报名字** —— 谁都能在 body 里
 * 写 `{app:"files"}`，但拿不到 files 的 token。token 存在内核状态目录，由本
 * 扩展在启动时注入环境变量，桌面扩展按同一份文件反查。
 *
 * 为什么不是「每次启动重新生成」：应用被重启时（崩溃重启、手动重启）旧的
 * token 会立刻失效，正在跑的请求全部 401。稳定 token 也让应用不必在重启后
 * 重新握手。
 */
// 状态存储句柄。onInit 一开始就赋值 —— startApp 会被 reconcile() 在 S 建立
// 之前调用，那时拿不到 S，但拿得到 os。
let OSREF = null;
function readTokens() {
  if (!OSREF) return {};
  return OSREF.readState('host-tokens.json', {}) || {};
}
function writeTokens(t) {
  if (OSREF) OSREF.writeState('host-tokens.json', t);
}

function appToken(name) {
  const t = readTokens();
  if (!t[name]) {
    t[name] = crypto.randomBytes(20).toString('hex');
    writeTokens(t);
  }
  return t[name];
}

/** 注入给应用的运行环境：名字、令牌、网关地址、自己的端口与数据目录 */
function runxEnv(entry, cwd, uid) {
  return {
    RUNX_APP_NAME: entry.name,
    RUNX_APP_TOKEN: appToken(entry.name),
    RUNX_GATEWAY: 'http://127.0.0.1:' + (process.env.PORT || 3000),
    RUNX_APP_PORT: entry.port ? String(entry.port) : '',
    RUNX_APP_DATA: path.join(cwd, entry.data_dir || 'data'),
    // 启动者：应用的授权按这个人的账本算（broker 读 app-owners.json 校验）
    RUNX_APP_USER: uid || '',
  };
}

/**
 * 可选依赖：两个能力层扩展可能根本没装。
 *
 * require 失败不是错误 —— 删掉 @runx-node-safety 就是「没有围栏」，删掉
 * @runx-rights-manager 就是「单用户」，supervisor 的职责不该跟着变。
 */
function safeRequire(rel) {
  try { return require(rel); } catch { return null; }
}
const NodeSafety = safeRequire('../@runx-node-safety/policy');
const Session = safeRequire('../@runx-rights-manager/session');

/** 记录「这个应用是谁启动的」。broker 用同一份文件决定用谁的授权。 */
function recordOwner(name, uid) {
  if (!uid || !OSREF) return;
  const m = OSREF.readState('app-owners.json', {}) || {};
  if (m[name] === uid) return;
  m[name] = uid;
  OSREF.writeState('app-owners.json', m);
}

// 内存运行时：name -> { state, pid, started_at, restart_count, last_exit, ... }
const runtime = new Map();
// 模块级单例（扩展在进程内只加载一次），onInit 填充，onRequest 直接取用
let S = null;

module.exports = {

  onInit(ctx) {
    const os = ctx.os;
    OSREF = os;
    const root = ctx.root;

    const loadApps = () => {
      const f = os.readState('apps.json', { schema: 1, apps: [] });
      return (f && Array.isArray(f.apps)) ? f.apps : [];
    };
    const getEntry = (name) => loadApps().find((a) => a.name === name) || null;
    const relOf = (cwd) => (path.isAbsolute(cwd) ? path.relative(root, cwd) : cwd);

    function statusOf(name) {
      const rt = runtime.get(name);
      if (rt) {
        return {
          state: rt.state, pid: rt.pid || null, started_at: rt.started_at || null,
          restart_count: rt.restart_count || 0, last_exit: rt.last_exit || null,
          // 围栏与归属：/runx/apps 的调用方（桌面、CLI）据此显示「这个应用被关在笼子里」
          fence: rt.fence || null, owner: rt.owner || null,
        };
      }
      return { state: 'stopped', pid: null, started_at: null, restart_count: 0, last_exit: null };
    }

    /* —— 进程退出：应用重启策略 —— */
    function onExit(name, code, signal) {
      const rt = runtime.get(name);
      if (!rt) return;
      rt.last_exit = { code: code === null ? null : code, signal: signal || null, at: Date.now() };
      const entry = getEntry(name);
      const policy = entry ? entry.restart : 'no';

      // 文档 §5.3：进程死后通知 gc 清临时资源（supervisor 是唯一回收所有者）
      if (os.gc && typeof os.gc.sweepFor === 'function') {
        try {
          const swept = os.gc.sweepFor(name);
          if (swept && (swept.removed || swept.deadRecords)) {
            ctx.log(`gc：回收 ${name} 遗留资源 removed=${swept.removed} records=${swept.deadRecords}`);
          }
        } catch (e) { ctx.warn('gc 回收出错：' + e.message); }
      }

      // 收敛到 stopped/failed 的统一出口：保证 'app:stopped' 只发一次，
      // 供挂载点 / windowManager 等订阅者对齐状态。
      const settleStopped = () => {
        rt.state = 'stopped'; rt.pid = null;
        os.ipc.emit('app:stopped', name);
      };

      // 由本扩展主动停止（用户 stop / 清单移除）：不重启
      if (rt._intentionalStop) {
        rt._intentionalStop = false;
        settleStopped();
        if (rt._waiters) { rt._waiters.forEach((w) => w({ ok: true, exit: rt.last_exit })); rt._waiters = []; }
        return;
      }

      const failed = (code !== 0 && code !== null) || !!signal;
      if (policy === 'no') {
        // 非重启策略：无论正常/异常退出都视为停止（异常时额外标记，便于 UI 区分）
        if (failed) os.ipc.emit('app:failed', name);
        settleStopped();
      } else if (policy === 'on-failure') {
        if (!failed) settleStopped();
        else scheduleRestart(name, entry);
      } else if (policy === 'always') {
        scheduleRestart(name, entry);
      }

      // 若有等待者（并发 stop 请求），退出即结算
      if (rt._waiters && rt._waiters.length) {
        rt._waiters.forEach((w) => w({ ok: true, exit: rt.last_exit }));
        rt._waiters = [];
      }
    }

    function scheduleRestart(name, entry) {
      const rt = runtime.get(name);
      if (!rt) return;
      const max = entry.restart_max || 5;
      const win = entry.restart_window_ms || 60000;
      const now = Date.now();
      rt._restartTs = (rt._restartTs || []).filter((t) => now - t < win);
      if (rt._restartTs.length >= max) {
        rt.state = 'failed'; rt.pid = null;
        ctx.log(`应用 ${name} 重启超预算（${max} 次 / ${win}ms），标记 failed`);
        os.ipc.emit('app:failed', name);
        return;
      }
      rt.state = 'restarting';
      // 时长可能来自 apps.json（字符串/缺失/越界），统一归一化，防 setTimeout(NaN) → 1ms 空转
      const delay = os.safeMs(entry.restart_delay_ms, 1000, 0, 600000);
      os.ipc.emit('app:restarting', name);
      setTimeout(() => {
        const cur = runtime.get(name);
        if (cur && cur.state === 'restarting') {
          cur._restartTs.push(Date.now());
          spawnApp(entry);
        }
      }, delay);
    }

    function portInUse(port, exceptName) {
      for (const [n, r] of runtime) {
        if (n === exceptName) continue;
        const e = getEntry(n);
        if (e && e.port === port && (r.state === 'running' || r.state === 'restarting')) return true;
      }
      return false;
    }

    function spawnApp(entry, opts) {
      const o = opts || {};
      const rt = runtime.get(entry.name) || {};
      if (rt.state === 'running') return { error: 'already_running' };

      // web 应用是静态资源，由 NavExt 托管，不需要进程
      if (entry.type === 'web') {
        rt.state = 'running'; rt.pid = null; rt.started_at = Date.now();
        rt.restart_count = 0; rt._restartTs = [];
        runtime.set(entry.name, rt);
        os.ipc.emit('app:started', entry.name);
        return { ok: true, web: true };
      }

      const cwd = entry.cwd || path.join(root, 'apps', entry.name);
      const rel = relOf(cwd);
      if (!ctx.project.exists(rel)) return { error: 'cwd_missing', cwd };
      if (portInUse(entry.port, entry.name)) return { error: 'port_in_use', port: entry.port };

      // 围栏：把清单里的 permissions 翻译成 --permission --allow-fs-* 等开关。
      // 没有这个扩展 / Node 不支持 / 命令不是 node → plan 返回 applied:false，
      // 我们照原样启动，并把「为什么没上围栏」记进运行时状态（/runx/safety 会报）。
      const safetyConf = os.readState('safety.json', null) || {};
      const exempt = entry.no_fence === true
        || (Array.isArray(safetyConf.exempt) && safetyConf.exempt.includes(entry.name));
      const plan = (NodeSafety && !exempt)
        ? NodeSafety.plan(entry, safetyConf)
        : { applied: false, reason: exempt ? '已豁免' : '未安装 @runx-node-safety' };

      const owner = o.owner || (Session && Session.ownerUid ? Session.ownerUid() : null);
      const app = {
        name: entry.name,
        cmd: entry.cmd || 'node app.js',
        argv: plan.applied ? plan.argv : undefined,
        cwd,
        port: entry.port,
        // appex.json 里的 env 在前，RUNX_* 在后：应用无法用静态配置覆盖
        // 自己的身份（否则改个 appex.json 就能冒充别的应用）。
        env: Object.assign({}, entry.env || {}, runxEnv(entry, cwd, owner)),
        onExit: (code, signal) => onExit(entry.name, code, signal),
      };
      let r;
      try {
        r = os.spawn(app);
      } catch (e) {
        return { error: 'spawn_failed', message: e.message, fence: plan.applied };
      }
      rt.state = 'running'; rt.pid = r.pid; rt.started_at = Date.now();
      rt.restart_count = rt.restart_count || 0; rt._restartTs = rt._restartTs || [];
      rt.fence = plan.applied ? { flag: plan.flag, argv: plan.argv } : { applied: false, reason: plan.reason };
      rt.owner = owner || null;
      runtime.set(entry.name, rt);
      recordOwner(entry.name, owner);
      ctx.log(`已启动 ${entry.name} (pid=${r.pid}, port=${entry.port}${plan.applied ? ', 围栏开' : ''})`);
      os.ipc.emit('app:started', entry.name);
      return { ok: true, pid: r.pid, port: r.port, started_at: rt.started_at, fence: plan.applied };
    }

    function terminateApp(name, force) {
      return new Promise((resolve) => {
        const rt = runtime.get(name);
        if (!rt || rt.state !== 'running') return resolve({ ok: false, running: false });
        rt._intentionalStop = true;
        rt._waiters = rt._waiters || [];
        rt._waiters.push(resolve);
        os.terminate(name, force);
        // 文档 B.1：SIGTERM 后最长等 5s + 1s
        setTimeout(() => {
          const cur = runtime.get(name);
          if (cur && cur.state === 'running') {
            ctx.log(`应用 ${name} 5s 内未退出，强制 SIGKILL`);
            os.terminate(name, true);
          }
        }, 5000);
        setTimeout(() => {
          const cur = runtime.get(name);
          if (cur && cur._waiters && cur._waiters.length) {
            cur._waiters.forEach((w) => w({ ok: true, exit: cur.last_exit }));
            cur._waiters = [];
          }
        }, 6000);
      });
    }

    function reconcile() {
      const apps = loadApps();
      const wanted = new Set(apps.map((a) => a.name));
      for (const [name, rt] of runtime) {
        if (!wanted.has(name) && rt.state === 'running') {
          ctx.log(`清单已移除 ${name}，停止进程`);
          terminateApp(name, false);
        }
      }
      for (const entry of apps) {
        if (entry.type === 'node' && entry.autostart) {
          const rt = runtime.get(entry.name);
          if (!rt || rt.state === 'stopped' || rt.state === 'failed') spawnApp(entry);
        }
      }
    }

    function listApps() {
      return loadApps().map((e) => Object.assign({}, e, { status: statusOf(e.name) }));
    }

    function logsOf(name, lines) {
      const n = Math.max(1, Math.min(1000, lines || 100));
      let text = '';
      try { text = ctx.project.read(`var/runx/logs/${name}.log`); }
      catch { text = ''; }
      const arr = text.split('\n').filter((l) => l.length);
      const total = arr.length;
      return { lines: arr.slice(-n), total, truncated: total > n };
    }

    // 启动对齐：web 应用直接视为 running；node 应用按需拉起 autostart
    for (const e of loadApps()) {
      if (e.type === 'web') {
        runtime.set(e.name, { state: 'running', pid: null, started_at: Date.now(), restart_count: 0 });
      }
    }
    reconcile();

    os.ipc.on('apps:changed', () => {
      ctx.log('收到 apps:changed，重新对齐进程');
      reconcile();
    });

    // 供 onRequest 使用的闭包包（含 json/err 辅助）
    S = {
      json: (status, obj) => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(obj) }),
      err: (code, message, data) => ({ status: code, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: { code, message, data } }) }),
      loadApps, getEntry, spawnApp, terminateApp, reconcile, listApps, logsOf, statusOf,
      // 应用令牌表：与 apps.json 同目录，桌面扩展按同一份文件反查应用身份
      readTokens, writeTokens,
    };
  },

  /**
   * 内核退出时把子进程一并带走。
   *
   * ── 不做会怎样 ──────────────────────────────────────────────
   * 子进程是内核 spawn 出来的，进程树挂在内核下面。内核一走，它们不会跟着走 ——
   * 变成孤儿，继续占着端口、继续跑着业务逻辑。
   *
   * 症状很具体：重启内核后，supervisor 以为应用没在跑（内存状态清空了），
   * 又去起一个 —— 端口被孤儿占着，新进程 EADDRINUSE 退出，重启预算耗尽后
   * 标记 failed。日志里刷满 EADDRINUSE，但真正的原因是「上一轮的进程还在」。
   *
   * ── 为什么用 SIGTERM 而不是 SIGKILL ──────────────────────────
   * 给应用一点时间自己收尾（关文件、刷缓冲）。SIGTERM 之后还有 SIGKILL 兜底：
   * 有的应用不响应 SIGTERM，不能让它把内核的退出卡住。
   */
  onDispose(ctx) {
    const list = Array.from(runtime.entries());
    if (!list.length) return;
    ctx.log(`内核退出：终止 ${list.length} 个应用进程`);

    for (const [name, rt] of list) {
      if (!rt || rt.state !== 'running' || !rt.pid) continue;
      try { process.kill(rt.pid, 'SIGTERM'); }
      catch { /* 进程可能已经自己退了 */ }
    }

    // 给 1.5 秒收尾；不响应 SIGTERM 的用 SIGKILL 强制走
    const timer = setTimeout(() => {
      for (const [name, rt] of runtime) {
        if (!rt || rt.state !== 'running' || !rt.pid) continue;
        try { process.kill(rt.pid, 'SIGKILL'); }
        catch { /* 已经退了 */ }
      }
    }, 1500);
    if (timer.unref) timer.unref();
  },

  onRequest(req, url, ctx) {
    const p = url.pathname;
    if (!p.startsWith(API + '/apps') || !S) return undefined;
    const method = req.method;

    // GET /runx/apps  —— 应用列表（无 :name 段）
    if (method === 'GET' && p === API + '/apps') {
      return S.json(200, { apps: S.listApps() });
    }

    // /runx/apps/:name[/:action]   action ∈ {logs|start|stop|restart}
    const m = p.match(new RegExp('^' + API + '/apps/([^/]+)(?:/([a-z]+))?$'));
    if (!m) return undefined;
    const name = decodeURIComponent(m[1]);
    const action = m[2] || null;

    // GET /runx/apps/:name  —— 详情（必须无 action）
    if (method === 'GET' && !action) {
      const entry = S.getEntry(name);
      if (!entry) return S.err(404, '应用不存在');
      return S.json(200, Object.assign({}, entry, { status: S.statusOf(name) }));
    }

    // GET /runx/apps/:name/logs
    if (method === 'GET' && action === 'logs') {
      const entry = S.getEntry(name);
      if (!entry) return S.err(404, '应用不存在');
      const lines = Number(url.searchParams.get('lines')) || 100;
      return S.json(200, S.logsOf(name, lines));
    }

    // POST /runx/apps/:name/start
    if (method === 'POST' && action === 'start') {
      const entry = S.getEntry(name);
      if (!entry) return S.err(404, '应用不存在');
      // 谁点的启动，应用就归谁的授权 —— 授权不是「机器上所有人共用一份」
      const u = Session && Session.userFromRequest ? Session.userFromRequest(req) : null;
      const r = S.spawnApp(entry, { owner: u ? u.id : null });
      if (r.error === 'already_running') return S.err(409, '应用已在运行');
      if (r.error === 'cwd_missing') return S.err(422, 'cwd 不存在', { cwd: r.cwd });
      if (r.error === 'port_in_use') return S.err(409, '端口被占用', { port: r.port });
      const rt = runtime.get(name);
      return S.json(200, { pid: rt ? rt.pid : null, port: entry.port, started_at: rt ? rt.started_at : null });
    }

    // POST /runx/apps/:name/stop
    if (method === 'POST' && action === 'stop') {
      const entry = S.getEntry(name);
      if (!entry) return S.err(404, '应用不存在');
      return S.terminateApp(name, false).then((res) => {
        if (!res.running && res.ok === false) return S.err(404, '应用未运行');
        return S.json(200, { ok: true, exit: res.exit || null });
      });
    }

    // POST /runx/apps/:name/restart
    if (method === 'POST' && action === 'restart') {
      const entry = S.getEntry(name);
      if (!entry) return S.err(404, '应用不存在');
      const rt = runtime.get(name);
      if (rt) { rt.restart_count = 0; rt._restartTs = []; } // 主动重启清空预算
      return S.terminateApp(name, true).then(() => {
        const u = Session && Session.userFromRequest ? Session.userFromRequest(req) : null;
        S.spawnApp(entry, { owner: u ? u.id : null });
        const r2 = runtime.get(name);
        return S.json(200, { pid: r2 ? r2.pid : null, port: entry.port, started_at: r2 ? r2.started_at : null });
      });
    }

    return undefined;
  },
};
