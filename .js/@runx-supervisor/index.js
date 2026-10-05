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
const path = require('path');

// 内存运行时：name -> { state, pid, started_at, restart_count, last_exit, ... }
const runtime = new Map();
// 模块级单例（扩展在进程内只加载一次），onInit 填充，onRequest 直接取用
let S = null;

module.exports = {

  onInit(ctx) {
    const os = ctx.os;
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
      const delay = entry.restart_delay_ms || 1000;
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

    function spawnApp(entry) {
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

      const app = {
        name: entry.name,
        cmd: entry.cmd || 'node app.js',
        cwd,
        port: entry.port,
        env: entry.env || undefined,
        onExit: (code, signal) => onExit(entry.name, code, signal),
      };
      const r = os.spawn(app);
      rt.state = 'running'; rt.pid = r.pid; rt.started_at = Date.now();
      rt.restart_count = rt.restart_count || 0; rt._restartTs = rt._restartTs || [];
      runtime.set(entry.name, rt);
      ctx.log(`已启动 ${entry.name} (pid=${r.pid}, port=${entry.port})`);
      os.ipc.emit('app:started', entry.name);
      return { ok: true, pid: r.pid, port: r.port, started_at: rt.started_at };
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
    };
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
      const r = S.spawnApp(entry);
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
        S.spawnApp(entry);
        const r2 = runtime.get(name);
        return S.json(200, { pid: r2 ? r2.pid : null, port: entry.port, started_at: r2 ? r2.started_at : null });
      });
    }

    return undefined;
  },
};
