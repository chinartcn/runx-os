'use strict';

/**
 * policy.js —— 把「应用声明的权限」翻译成 Node 的启动开关
 *
 * ── Node 自己就有围栏，为什么还要这一层 ─────────────────────────
 * Node 18+ 的 Permissions Model（`--permission` / `--experimental-permission`）
 * 能限制 fs / child_process / worker / addon，但它是**进程启动参数**：
 * 一旦 exec 就不能再改。而 RunX 里的应用是用户点一下才起来的，权限来自
 * 应用清单和用户的批准 —— 中间必须有人做翻译。这个文件就是那个翻译器。
 *
 * ── 三个必须承认的限制 ─────────────────────────────────────────
 * 1. **只管进程级粗粒度**。Node 模型不认 glob，只认目录前缀；`/sdcard/*.jpg`
 *    这种声明会被收窄成 `/sdcard/*`（Node 支持尾部 `*`），再细就做不到。
 * 2. **不覆盖网络**。Node 的模型里没有 net，`--allow-net` 不存在。网络审批
 *    只能靠 broker（@runx-rights-manager 的 UAC）在调用层做。
 * 3. **必须在 exec 前决定**。所以这里只做「算 argv」，不碰进程；真正的
 *    spawn 仍由 supervisor 执行（它才是进程的所有者）。
 */

const path = require('path');
const cp = require('child_process');

let probeCache = null;

/**
 * 探测当前 Node 支持哪个开关。
 *
 * 为什么不是查版本号：`--permission` 在 20.x 的某几个小版本里叫
 * `--experimental-permission`，按 major 判断必然有一批机器判断错。花 30ms
 * fork 一次 `node <flag> -e 0` 得到的是确定答案，而且只需要一次。
 */
function probeRuntime() {
  if (probeCache) return probeCache;
  const candidates = ['--permission', '--experimental-permission'];
  for (const flag of candidates) {
    try {
      const r = cp.spawnSync(process.execPath, [flag, '-e', '0'], { timeout: 5000, stdio: 'ignore' });
      if (r.status === 0) {
        probeCache = { supported: true, flag, version: process.version, checked_at: Date.now() };
        return probeCache;
      }
    } catch { /* 换下一个 */ }
  }
  probeCache = { supported: false, flag: null, version: process.version, checked_at: Date.now() };
  return probeCache;
}

function invalidate() { probeCache = null; }

/** 权限声明 `cap:scope` 里的 scope → Node 认的目录前缀 */
function toNodePath(scope, cwd) {
  let s = String(scope || '').trim();
  if (!s) return null;
  if (s === '**' || s === '/*') return path.parse(cwd || '/').root;
  // 尾部通配收窄：`/a/**` → `/a`；`/a/*.jpg` → `/a/*`
  s = s.replace(/\/\*\*$/, '').replace(/\/\*$/, '/*');
  // 中间还有通配的：取第一个通配符之前的目录，再挂一个尾通配
  // （`/sdcard/*.jpg` → `/sdcard/*`，Node 不支持按扩展名过滤）
  const star = s.indexOf('*');
  if (star >= 0 && star < s.length - 1) {
    const head = s.slice(0, star).replace(/\/+$/, '');
    s = (head || '/') + '/*';
  }
  if (!path.isAbsolute(s)) s = path.resolve(cwd || '/', s);
  return s;
}

function uniq(list) { return Array.from(new Set(list.filter(Boolean))); }

/**
 * 计算一个应用的启动参数。
 *
 * @param {{name:string, cmd:string, cwd:string, data_dir?:string, permissions?:string[], env?:object}} app
 * @param {{mode:string, extra?:string[]}} cfg
 * @returns {{applied:boolean, flag?:string, argv?:string[], permissions?:object[], reason?:string}}
 */
function plan(app, cfg) {
  const conf = cfg || {};
  const rt = probeRuntime();
  if (!rt.supported) {
    return { applied: false, reason: '当前 Node（' + process.version + '）不支持权限模型，需要 18+' };
  }
  if (conf.mode === 'off') return { applied: false, reason: '围栏已全局关闭' };

  // ── 没声明权限的应用怎么办 ──
  // 默认（declared）不围：Node 的权限模型是启动时全有全无，猜错的后果是应用
  // 一启动就 ERR_ACCESS_DENIED 死掉。没声明就等于没约定，硬套一个基线会把
  // 存量应用全打挂。想要「一律围栏」的机器设 mode:'strict'，那时还要自己
  // 补 permissions。
  const declaredIn = Array.isArray(app.permissions) ? app.permissions.filter((x) => typeof x === 'string') : null;
  if (!declaredIn && conf.mode !== 'strict') {
    return {
      applied: false,
      reason: '应用没有声明 permissions，未启用围栏（safety.json 设 mode:"strict" 可强制）',
    };
  }

  const cwd = app.cwd || process.cwd();
  const data = path.join(cwd, app.data_dir || 'data');
  const declared = declaredIn;

  const reads = [cwd];
  const writes = [data];
  let childProcess = false;
  let worker = false;
  let addons = false;
  const notes = [];

  // 没有声明权限的应用：给最小基线（读自己、写 data），并明确标注这是基线
  if (!declared) {
    notes.push('未声明权限，按基线处理：只读自身目录、只写 data 目录');
  } else {
    for (const p of declared) {
      const i = p.indexOf(':');
      const cap = i < 0 ? p : p.slice(0, i);
      const scope = i < 0 ? '' : p.slice(i + 1);
      if (cap === 'fs.read' || cap === 'fs.list' || cap === 'fs.stat') {
        const n = toNodePath(scope, cwd); if (n) reads.push(n);
      } else if (cap === 'fs.write' || cap === 'fs.mkdir' || cap === 'fs.remove') {
        const n = toNodePath(scope, cwd); if (n) { writes.push(n); reads.push(n); }
      } else if (cap === 'fs.copy') {
        const n = toNodePath(scope, cwd); if (n) { writes.push(n); reads.push(n); }
      } else if (cap === 'proc.spawn') {
        childProcess = true;
      } else if (cap === 'proc.worker') {
        worker = true;
      } else if (cap === 'sys.addons') {
        addons = true;
      } else if (cap === 'net.fetch') {
        notes.push('net.fetch 由审批层（broker）控制，Node 权限模型没有网络开关');
      } else {
        notes.push('未知能力，已忽略：' + p);
      }
    }
  }

  // 全局附加目录：extra 只读（放证书、字体这类共享资源），extra_write 才给写
  for (const p of (conf.extra || [])) {
    const n = toNodePath(p, cwd);
    if (n) reads.push(n);
  }
  for (const p of (conf.extra_write || [])) {
    const n = toNodePath(p, cwd);
    if (n) { reads.push(n); writes.push(n); }
  }

  const argvFlags = [rt.flag];
  for (const p of uniq(reads)) argvFlags.push('--allow-fs-read=' + p);
  for (const p of uniq(writes)) argvFlags.push('--allow-fs-write=' + p);
  if (childProcess) argvFlags.push('--allow-child-process');
  if (worker) argvFlags.push('--allow-worker');
  if (addons) argvFlags.push('--allow-addons');

  const parts = String(app.cmd || 'node app.js').split(/\s+/).filter(Boolean);
  const exe = parts[0];
  const base = path.basename(exe).replace(/\.exe$/i, '');
  if (base !== 'node' && base !== 'nodejs' && exe !== process.execPath) {
    return {
      applied: false,
      reason: '启动命令不是 node（' + exe + '），无法注入权限开关；请把应用改成 `node app.js`',
    };
  }

  return {
    applied: true,
    flag: rt.flag,
    version: rt.version,
    argv: [exe].concat(argvFlags, parts.slice(1)),
    permissions: declared || null,
    effective: {
      read: uniq(reads), write: uniq(writes),
      child_process: childProcess, worker, addons,
    },
    notes,
  };
}

module.exports = { probeRuntime, invalidate, plan, toNodePath };
