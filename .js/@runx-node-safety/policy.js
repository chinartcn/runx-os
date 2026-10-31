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

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

/**
 * 内核自带的两个包（@runx/host、@runx/sdk）永远可读。
 *
 * 应用要能 require('@runx/sdk') 才谈得上「走审批」，可这两个包在 packages/ 下、
 * 在应用自己的目录之外；用软链挂上去的还会被 realpath 解析到那边。不显式放行的话，
 * 围栏一开，应用第一行 require 就 ERR_ACCESS_DENIED —— 表现是「一启动就死」，
 * 而且报错还没提到权限，很难查。
 */
const KERNEL_PKGS = (() => {
  const base = path.resolve(__dirname, '../../packages');
  return ['runx-host', 'runx-sdk', 'runx-pty']
    .map((d) => path.join(base, d))
    .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
})();

/**
 * 系统包的**挂载点**也要可读：<root>/node_modules/@runx/。
 *
 * 为什么软链的真实路径放行了还不够：Node 解析 require('@runx/sdk') 时，
 * 先读的是「node_modules/@runx/sdk/package.json」这个**软链路径**，读到了
 * 才顺着软链去 packages/。Node 的 --allow-fs-read 按字面路径判定，
 * 软链路径不在名单里 → ERR_ACCESS_DENIED。
 *
 * 只放行 @runx 这个作用域目录，不放行整个 node_modules ——
 * 后者会把应用自己装的那些包（可能很大、可能有敏感内容）全放进来，
 * 那就不是围栏了。
 *
 * 装在应用自己目录里的软链不受影响：那条路径在应用的 cwd 里，
 * 已经被 baseline 的「读自身目录」覆盖了。
 */
const KERNEL_SCOPE_LINKS = (() => {
  const root = path.resolve(__dirname, '../..');
  const dir = path.join(root, 'node_modules', '@runx');
  try { return fs.statSync(dir).isDirectory() ? [dir] : []; } catch (e) { return []; }
})();

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
 * 去掉被别的路径**包含**的窄路径 —— 只对读路径用。
 *
 * 为什么读路径要去嵌套：Node 的权限模型里，一条更具体的 --allow-fs-read
 * 会**遮蔽**更宽的一条。给父目录和子目录同时开权限，结果是读父目录被拒 ——
 * 这跟直觉正好相反。
 *
 * 实测（Node 22）：
 *   --allow-fs-read=/apps            → readdir(/apps) 通过
 *   --allow-fs-read=/apps --allow-fs-read=/apps/foo
 *                                    → readdir(/apps) ERR_ACCESS_DENIED
 *   --allow-fs-read=/apps/foo        → readdir(/apps) 也被拒
 *
 * 对应用的实际影响：它声明了 fs.read:../**（要读同级的其他应用），
 * 而基线又自动加了 cwd（它自己的目录，正好是 ../** 的子路径）——
 * 于是「读同级应用」这条路被自己的目录挡死了。症状是扫出来 0 个应用，
 * 而权限声明看起来完全正确。
 *
 * 写路径不适用这套：实测父+子并存时两边都能写，只给父也能写子。
 * 所以写路径保持原样（见 plan 里的 uniq(writes)）。
 */
function dropNested(paths) {
  const list = uniq(paths);
  const out = [];
  for (const p of list) {
    const covered = list.some((q) => {
      if (p === q) return false;
      // q 覆盖 p：q 是 p 的祖先目录
      const a = q.endsWith(path.sep) ? q : q + path.sep;
      return p.startsWith(a);
    });
    if (!covered) out.push(p);
  }
  return out;
}

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

  // 基线：读自己的目录、写自己的 data。
  const reads = [cwd];
  const writes = [data];
  let childProcess = false;
  let worker = false;  let addons = false;
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
      } else if (cap === 'fs.watch') {
        // 监听只需要读：能看到目录内容就够，不需要写
        const n = toNodePath(scope, cwd); if (n) reads.push(n);
      } else if (cap === 'dialog.open' || cap === 'clipboard.read' || cap === 'clipboard.write') {
        // 这两类不进进程围栏：对话框由用户点、剪贴板是内核里的一份缓冲区。
        // 写进 notes 是让「为什么这里没有 --allow-*」有据可查。
        notes.push(cap + ' 由审批层（broker）控制，Node 权限模型没有对应开关');
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

  // SDK 所在的目录：无论应用怎么挂的（软链 / 复制 / 相对路径安装），都得能读
  for (const d of KERNEL_PKGS) reads.push(d);
  // 系统包的软链挂载点（node_modules/@runx/）—— 解析软链路径本身也要能读
  for (const d of KERNEL_SCOPE_LINKS) reads.push(d);

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
  // 读路径去嵌套：更具体的路径会遮蔽更宽的，只留最宽的那些（见 dropNested）
  for (const p of dropNested(reads)) argvFlags.push('--allow-fs-read=' + p);
  // 写路径不去嵌套：实测父+子并存时两边都能写，剔掉窄的反而会丢权限
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
