'use strict';

/**
 * grants.js —— 能力、授权记录、风险判定
 *
 * ── 三条设计约束 ────────────────────────────────────────────────
 * 1. **能力是字符串，不是布尔**。`fs.read` 不够 —— 「能读自己的 data 目录」和
 *    「能读 ~/.ssh」是两件事。所以能力形如 `fs.read:/root/.ssh/**`，作用域
 *    跟着能力走。
 * 2. **授权永远是「某应用 + 某能力 + 某作用域」三元组**。只记应用会导致「装了
 *    一次文件管理器，所有应用都能写 /etc」；只记能力会导致「一个应用被批准，
 *    全家都搭便车」。
 * 3. **风险等级由服务端算，不由前端传**。前端传 risk 等于让申请者自己给自己
 *    打分。
 *
 * ── 作用域语法 ─────────────────────────────────────────────────
 * 绝对路径 + glob：`/root/.ssh/**`、`/sdcard/DCIM/*.jpg`、`**`（一切）。
 * `**` 吃任意层，`*` 只吃一层内的任意字符，`?` 一个字符。路径统一转成 posix
 * 分隔符再比 —— 否则 Windows 上 `C:\a\b` 和 `/a/b` 的规则互相匹配不上。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CAPS = [
  'fs.read', 'fs.write', 'fs.list', 'fs.stat', 'fs.remove', 'fs.mkdir', 'fs.copy', 'fs.watch',
  'proc.spawn', 'net.fetch', 'sys.info',
  // 不碰文件、但要经过用户的两件事：让用户自己挑一个文件（等于「我指定了它」），
  // 以及共享剪贴板（跨应用的数据通道，读的那一侧值得问一声）。
  'dialog.open', 'clipboard.read', 'clipboard.write',
];

/** 读能力家族：一条 fs.read 授权覆盖同作用域的 list / stat / watch */
const READ_FAMILY = new Set(['fs.list', 'fs.stat', 'fs.watch']);

/** 只读能力：同一作用域下写能力自动覆盖读能力，反之不成立 */
const READONLY = new Set(['fs.read', 'fs.list', 'fs.stat', 'fs.watch', 'sys.info']);

function newId() { return crypto.randomBytes(6).toString('hex'); }

function toPosix(p) { return String(p || '').replace(/\\/g, '/'); }

function normPath(p) {
  const s = toPosix(String(p || '')).replace(/\/+$/, '');
  return s || '/';
}

/** glob → RegExp。逐个字符走，避免 `**` 被当成两个 `*` 分别处理。 */
function globToRe(glob) {
  const g = normPath(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `/**` 吃掉「/ 加任意层」，且允许一层都没有（`/a/**` 要匹配 `/a` 本身）。
        // 前一个 '/' 已经进 re 了，先退掉，否则 `/a/**` 会变成 `/a/` 开头。
        if (g[i - 1] === '/') { re = re.slice(0, -1) + '(?:/.*)?'; i++; continue; }
        re += '.*'; i++; continue;
      }
      re += '[^/]*';
      continue;
    }
    if (c === '?') { re += '[^/]'; continue; }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

const reCache = new Map();
function reOf(glob) {
  let r = reCache.get(glob);
  if (!r) {
    if (reCache.size > 500) reCache.clear();
    r = globToRe(glob);
    reCache.set(glob, r);
  }
  return r;
}

/** 作用域是否覆盖目标。精确相等也算覆盖（用户选的是「仅此文件」）。 */
function covers(scope, target) {
  const s = normPath(scope);
  const t = normPath(target);
  if (s === '**' || s === '/*') return true;
  if (s === t) return true;
  if (s.indexOf('*') < 0 && s.indexOf('?') < 0) {
    // 无通配时按目录包含关系算：授权 /a/b 覆盖 /a/b/c，但不覆盖 /a/bc
    return t.indexOf(s + '/') === 0;
  }
  return reOf(s).test(t);
}

/* ═══════════════════════════════════════════════════════════════
 * 风险判定表
 *
 * 每一条都是「命中即定级」，取最高级。表里的路径都用绝对路径前缀写死：
 * 这些是「用户不会意外想改」的地方，命中就当高危处理 —— 不是禁止，而是
 * 必须走管理员模式 + 二次确认。
 * ═══════════════════════════════════════════════════════════════ */

const SYSTEM_PREFIXES = ['/etc', '/usr', '/bin', '/sbin', '/boot', '/lib', '/lib64', '/dev', '/proc', '/sys', '/var/runx'];

/** 凭据类：读到就等于拿到身份 */
const SECRET_GLOBS = [
  '/root/.ssh/**', '/home/*/.ssh/**', '/root/.aws/**', '/home/*/.aws/**',
  '/root/.gnupg/**', '/etc/shadow', '/etc/sudoers', '/etc/ssh/**',
  '**/id_rsa', '**/id_ed25519', '**/*.pem', '**/*.key', '**/*.p12',
  '**/.env', '**/.npmrc', '**/.git-credentials',
];

/** 可执行文件 / 包目录：写进去等于装后门 */
const CODE_GLOBS = ['**/node_modules/**', '**/.git/config', '**/package.json'];

const RISK_ORDER = { low: 0, medium: 1, high: 2 };

function worst(a, b) { return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b; }

/**
 * 风险定级。
 *
 * @param {string} cap    能力名
 * @param {string} target 作用域（路径 / 命令 / 主机）
 * @param {{sandbox?:{cwd?:string,data?:string}}} ctx
 * @returns {{level:'low'|'medium'|'high', why:string}}
 */
function assess(cap, target, ctx) {
  const c = ctx || {};
  const sb = c.sandbox || {};
  const t = normPath(target);
  let level = 'low';
  const reasons = [];

  const inSandbox = (p) => {
    const roots = [sb.data, sb.cwd].filter(Boolean).map(normPath);
    return roots.some((r) => p === r || p.indexOf(r + '/') === 0);
  };
  /** 应用自己的程序文件（cwd 之内、data 之外）：写它等于改下次启动要跑的代码 */
  const inOwnCode = (p) => {
    if (!sb.cwd) return false;
    const cwd = normPath(sb.cwd);
    const data = sb.data ? normPath(sb.data) : null;
    const underCwd = p === cwd || p.indexOf(cwd + '/') === 0;
    const underData = !!data && (p === data || p.indexOf(data + '/') === 0);
    return underCwd && !underData;
  };

  if (cap === 'proc.spawn') {
    // 起进程 = 拿任意能力（起个 sh 就能绕开所有 fs 限制）
    return { level: 'high', why: '启动子进程可以绕过其余所有限制' };
  }

  if (cap === 'net.fetch') {
    const host = t.replace(/^https?:\/\//, '').split('/')[0];
    if (/^(127\.|localhost|::1|0\.0\.0\.0)/.test(host)) {
      return { level: 'medium', why: '访问本机回环地址，可能够到内核自己的接口' };
    }
    return { level: 'medium', why: '把数据发到外部主机的通道' };
  }

  if (cap === 'sys.info') return { level: 'low', why: '只读的系统信息' };

  /* 非文件能力：作用域不是路径，别拿它去跑路径规则 */
  if (cap === 'dialog.open') {
    // 用户自己在浏览器里点的文件，就是「我要给这个应用看这个文件」的表达。
    // 反过来说：不让应用自选路径的对话框，比让它直接读更安全。
    return { level: 'low', why: '由用户在桌面上亲自选择，应用无法指定路径' };
  }
  if (cap === 'clipboard.write') return { level: 'low', why: '只写不读，等于把文字放进共享缓冲区' };
  if (cap === 'clipboard.read') {
    return { level: 'medium', why: '剪贴板里可能刚复制过密码、验证码或私钥' };
  }

  // 以下都是文件类
  const readLike = cap === 'fs.read' || cap === 'fs.list' || cap === 'fs.stat' || cap === 'fs.watch';
  if (SYSTEM_PREFIXES.some((p) => t === p || t.indexOf(p + '/') === 0)) {
    level = worst(level, readLike ? 'medium' : 'high');
    reasons.push('系统目录');
  }
  if (SECRET_GLOBS.some((g) => covers(g, t))) {
    level = worst(level, 'high');
    reasons.push('凭据文件');
  }
  if (!readLike && CODE_GLOBS.some((g) => covers(g, t))) {
    level = worst(level, 'high');
    reasons.push('程序代码');
  }
  // 改自己的代码 = 改下次启动要跑的东西，和「装个后门」等价
  if (!readLike && inOwnCode(t)) {
    level = worst(level, 'high');
    reasons.push('应用自身的程序文件');
  }
  if (cap === 'fs.remove') {
    level = worst(level, 'medium');
    reasons.push('删除不可撤销');
  }
  if (!inSandbox(t) && readLike) {
    level = worst(level, 'medium');
    reasons.push('应用沙箱之外');
  }
  if (level === 'low' && inSandbox(t)) reasons.push('应用自己的目录');

  return { level, why: reasons.join('；') || '常规操作' };
}

/* ═══════════════════════════════════════════════════════════════
 * 授权存储：按用户分文件
 * ═══════════════════════════════════════════════════════════════ */

/**
 * @param {{dir:string, log?:Function}} opts dir = var/runx
 */
function createGrants(opts) {
  const dir = opts.dir;
  const log = opts.log || (() => {});
  const usersDir = path.join(dir, 'users');
  const mem = new Map();   // uid -> {mtimeMs, data}

  function fileOf(uid) { return path.join(usersDir, uid, 'grants.json'); }

  function load(uid) {
    if (!uid) return { schema: 1, grants: [] };
    const f = fileOf(uid);
    let st = null;
    try { st = fs.statSync(f); } catch { return { schema: 1, grants: [] }; }
    const hit = mem.get(uid);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
    let data = null;
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { data = null; }
    if (!data || data.schema !== 1 || !Array.isArray(data.grants)) data = { schema: 1, grants: [] };
    mem.set(uid, { mtimeMs: st.mtimeMs, data });
    return data;
  }

  function save(uid, data) {
    const d = path.join(usersDir, uid);
    fs.mkdirSync(d, { recursive: true });
    const f = fileOf(uid);
    const tmp = f + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, f);
    mem.delete(uid);
    return data;
  }

  /** 一条规则：{id, app, cap, scope, at, by, note} */
  function grant(uid, rule) {
    if (!CAPS.includes(rule.cap)) throw Object.assign(new Error('未知能力：' + rule.cap), { code: 422 });
    if (!rule.scope) throw Object.assign(new Error('缺少作用域'), { code: 422 });
    const data = load(uid);
    const app = rule.app || '*';
    const scope = String(rule.scope);
    const dup = data.grants.find((g) => g.app === app && g.cap === rule.cap && g.scope === scope);
    if (dup) { dup.at = Date.now(); save(uid, data); return dup; }
    const g = {
      id: newId(), app, cap: rule.cap, scope,
      at: Date.now(), by: rule.by || null, note: rule.note || '',
      expires: rule.expires || null,
    };
    data.grants.push(g);
    save(uid, data);
    log(`授权：${app} → ${rule.cap}:${scope}`);
    return g;
  }

  function revoke(uid, id) {
    const data = load(uid);
    const i = data.grants.findIndex((g) => g.id === id);
    if (i < 0) return false;
    data.grants.splice(i, 1);
    save(uid, data);
    return true;
  }

  function clear(uid, app) {
    const data = load(uid);
    const before = data.grants.length;
    data.grants = app ? data.grants.filter((g) => g.app !== app) : [];
    save(uid, data);
    return before - data.grants.length;
  }

  function list(uid) {
    const data = load(uid);
    const t = Date.now();
    return data.grants.filter((g) => !g.expires || g.expires > t);
  }

  /**
   * 找一条覆盖本次请求的规则。
   *
   * 语义细节：
   *   · 读能力可以被**同作用域的写授权**覆盖（能写就能读，这是用户的本意）；
   *   · 写能力不能被读授权覆盖；
   *   · `*` 应用规则匹配任意应用（管理员给「所有应用」开的口子）。
   */
  function find(uid, q) {
    const target = normPath(q.target);
    const rules = list(uid);
    let best = null;
    for (const g of rules) {
      if (g.app !== '*' && g.app !== q.app) continue;
      const same = g.cap === q.cap;
      const writeCoversRead = READONLY.has(q.cap) && g.cap === 'fs.write';
      // 读能力之间互相覆盖：一条 `fs.read:/data/**` 让 list / stat / watch 也通。
      // 不这么做的话，应用读一个文件要先被问「读」，再被问「看信息」，再被问
      // 「列目录」—— 用户面对的是同一个决定，问三遍只训练出盲点习惯。
      const readCoversRead = READ_FAMILY.has(q.cap) && g.cap === 'fs.read';
      if (!same && !writeCoversRead && !readCoversRead) continue;
      if (!covers(g.scope, target)) continue;
      // 多命中时优先「应用精确 → 作用域最窄」的那条，只是为了让 UI 显示得准
      if (!best || (best.app === '*' && g.app !== '*')) best = g;
    }
    return best;
  }

  return { load, save, grant, revoke, clear, list, find, fileOf };
}

module.exports = { CAPS, READONLY, READ_FAMILY, createGrants, assess, covers, globToRe, normPath, newId, RISK_ORDER, worst };
