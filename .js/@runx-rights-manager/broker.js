'use strict';

/**
 * broker.js —— 真正干活的执行层（/runx/sdk/*）
 *
 * 应用不直接调 fs，而是把「我要读这个文件」告诉 broker。broker 做三件事：
 *   1. 认人：X-Runx-Token → 应用名（令牌由 supervisor 注入，应用无法自报）；
 *   2. 查权：这条能力在不在这个用户的授权表里；
 *   3. 执行：没有授权就发 UAC 请求，用户点了才动手。
 *
 * ── 为什么能力检查放在「路径解析之后」 ──────────────────────────
 * 如果先查权限再解析路径，`../../etc/shadow` 会以「相对路径」的形式通过
 * 一条 `fs.read:./**` 的授权，解析完才发现它落在 /etc 下。所以顺序永远是
 * 先 resolve 成绝对路径，再做匹配 —— 申请、授权、审计看到的都是同一个路径。
 *
 * ── 这里为什么可以 require fs / child_process ──────────────────
 * 本扩展是 core 扩展（mod.json: core=true），本身就是内核的受信部件。
 * 与应用的区别是：应用拿不到这份代码，只能通过 broker 的窄接口请求。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const cp = require('child_process');
const { URL } = require('url');

const { assess, normPath } = require('./grants');

const MAX_READ = 2 * 1024 * 1024;
const MAX_WRITE = 4 * 1024 * 1024;
const MAX_FETCH = 5 * 1024 * 1024;
const FETCH_TIMEOUT = 20000;

/** 云端元数据地址：能读它就等于能拿实例凭据，任何授权都不该放行 */
const BLOCKED_HOSTS = [/^169\.254\./, /^100\.100\.100\.200$/, /^metadata\./];

function fail(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function typeOf(st) {
  if (st.isDirectory()) return 'dir';
  if (st.isSymbolicLink()) return 'link';
  if (st.isFile()) return 'file';
  return 'other';
}

/**
 * @param {{
 *   root:string, log?:Function, grants:object, uac:object,
 *   resolveApp:Function, adminOn:Function, sandboxOf:Function
 * }} opts
 */
function createBroker(opts) {
  const log = opts.log || (() => {});
  const children = new Map();   // pid -> child（还在跑的）
  const recent = new Map();     // pid -> rec（最近退出的，容量 20，供 proc.status 查收尾）

  function resolvePath(raw, cwd) {
    let p = String(raw == null ? '' : raw);
    if (!p) throw fail('EINVAL', '路径不能为空');
    if (p.indexOf('\u0000') >= 0) throw fail('EINVAL', '路径含非法字符');
    if (p === '~' || p.startsWith('~/')) p = os.homedir() + p.slice(1);
    if (!path.isAbsolute(p)) p = path.resolve(cwd || process.cwd(), p);
    return normPath(path.normalize(p));
  }

  /**
   * 统一的「申请 → 决定 → 执行」流程。
   *
   * @param {{app:object, uid:string, cap:string, target:string, label?:string, run:Function}} req
   */
  async function authorize(req) {
    const { app, uid, cap, target } = req;
    if (!uid) throw fail('ENOUSER', '没有可用的用户身份，无法批准');

    const rule = opts.grants.find(uid, { app: app.name, cap, target });
    if (rule) return { via: 'grant', rule };

    const risk = assess(cap, target, { sandbox: app.sandbox });
    if (risk.level === 'high' && !opts.adminOn()) {
      throw fail('NEED_ADMIN', '这是一次高风险操作，需要先开启管理员模式', {
        risk, cap, target, app: app.name,
      });
    }

    const scopeHint = req.scopeHint || defaultScope(cap, target);
    const ans = await opts.uac.ask({
      app: app.name,
      app_label: app.label,
      cap,
      target,
      scope_hint: scopeHint,
      risk,
      reason: req.label || '',
      uid,
      user_name: req.user_name || '',
    });

    if (ans.decision === 'deny' || ans.decision === 'timeout' || ans.decision === 'no-ui') {
      const map = {
        deny: ['EPERM', '用户拒绝了这次操作'],
        timeout: ['ETIMEDOUT', '等待用户授权超时'],
        'no-ui': ['ENOUI', '桌面没有打开，没有人能批准这次请求'],
      };
      const [code, msg] = map[ans.decision];
      throw fail(code, msg, { risk, cap, target, app: app.name, decision: ans.decision });
    }

    if (ans.decision === 'always-file' || ans.decision === 'always-dir') {
      const scope = ans.decision === 'always-file' ? target : scopeHint;
      opts.grants.grant(uid, { app: app.name, cap, scope, by: ans.by, note: 'UAC 批准' });
    }
    return { via: 'uac', decision: ans.decision, scope: ans.decision === 'always-file' ? target : scopeHint };
  }

  /** 「始终允许目录」时授予的范围：文件本身 → 取其父目录递归 */
  function defaultScope(cap, target) {
    if (cap === 'proc.spawn') return target;             // 命令名精确授权
    if (cap === 'net.fetch') {
      try { return new URL(target).origin + '/**'; } catch { return target; }
    }
    const t = normPath(target);
    const dir = t.endsWith('/') ? t : path.posix.dirname(t);
    return dir === '/' ? '/**' : dir + '/**';
  }

  /* ── 文件操作 ─────────────────────────────────────────────── */

  async function fsRead(app, uid, p, q) {
    const target = resolvePath(p, app.cwd);
    const auth = await authorize({ app, uid, cap: 'fs.read', target, label: '读取文件' });
    const st = fs.statSync(target);
    if (st.isDirectory()) throw fail('EISDIR', '这是一个目录，请用 fs.list');
    if (st.size > MAX_READ) throw fail('ETOOBIG', `文件超过 ${MAX_READ / 1048576}MB，请用 fs.stream 分段读`);
    const buf = fs.readFileSync(target);
    const enc = (q && q.encoding) === 'base64' ? 'base64' : detectEncoding(buf);
    return {
      path: target, size: buf.length, mtime: st.mtimeMs, encoding: enc,
      content: enc === 'base64' ? buf.toString('base64') : buf.toString('utf8'),
      auth,
    };
  }

  function detectEncoding(buf) {
    // 简单二判定：有 NUL 字节就当二进制。真正的探测（chardet）代价太大，
    // 应用只需要知道「这段内容能不能当文本用」。
    for (let i = 0; i < Math.min(buf.length, 4096); i++) if (buf[i] === 0) return 'base64';
    return 'utf8';
  }

  async function fsWrite(app, uid, p, q) {
    const target = resolvePath(p, app.cwd);
    const auth = await authorize({ app, uid, cap: 'fs.write', target, label: '写入文件' });
    const exists = fs.existsSync(target);
    const raw = q && q.encoding === 'base64'
      ? Buffer.from(String(q.content || ''), 'base64')
      : Buffer.from(String(q && q.content != null ? q.content : ''), 'utf8');
    if (raw.length > MAX_WRITE) throw fail('ETOOBIG', `单次写入超过 ${MAX_WRITE / 1048576}MB`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (q && q.append) fs.appendFileSync(target, raw);
    else fs.writeFileSync(target, raw);
    return { path: target, size: raw.length, created: !exists, auth };
  }

  async function fsList(app, uid, p) {
    const target = resolvePath(p, app.cwd);
    const auth = await authorize({ app, uid, cap: 'fs.list', target, label: '列出目录' });
    const entries = fs.readdirSync(target, { withFileTypes: true }).map((d) => {
      const full = path.join(target, d.name);
      let st = null;
      try { st = fs.lstatSync(full); } catch { /* 读权限不足或已删除 */ }
      return {
        name: d.name,
        type: d.isDirectory() ? 'dir' : (d.isSymbolicLink() ? 'link' : 'file'),
        size: st ? st.size : 0,
        mtime: st ? st.mtimeMs : 0,
      };
    });
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
    return { path: target, entries, auth };
  }

  async function fsStat(app, uid, p) {
    const target = resolvePath(p, app.cwd);
    const auth = await authorize({ app, uid, cap: 'fs.stat', target, label: '查看文件信息' });
    let st;
    try { st = fs.lstatSync(target); }
    catch (e) { if (e.code === 'ENOENT') return { path: target, exists: false, auth }; throw e; }
    return {
      path: target, exists: true, type: typeOf(st), size: st.size,
      mtime: st.mtimeMs, mode: '0' + (st.mode & 0o777).toString(8), auth,
    };
  }

  async function fsMkdir(app, uid, p, q) {
    const target = resolvePath(p, app.cwd);
    const auth = await authorize({ app, uid, cap: 'fs.mkdir', target, label: '创建目录' });
    fs.mkdirSync(target, { recursive: !(q && q.parents === false) });
    return { path: target, auth };
  }

  async function fsRemove(app, uid, p, q) {
    const target = resolvePath(p, app.cwd);
    if (target === '/' || target === os.homedir() || target === opts.root) {
      throw fail('EPERM', '拒绝删除这个路径');
    }
    const recursive = !!(q && q.recursive);
    const auth = await authorize({
      app, uid, cap: 'fs.remove', target,
      label: recursive ? '删除目录（含内容）' : '删除文件',
    });
    const st = fs.existsSync(target) ? fs.lstatSync(target) : null;
    if (!st) throw fail('ENOENT', '路径不存在');
    if (recursive && st.isDirectory()) fs.rmSync(target, { recursive: true, force: false });
    else fs.unlinkSync(target);
    return { path: target, removed: true, auth };
  }

  async function fsCopy(app, uid, from, to, q) {
    const src = resolvePath(from, app.cwd);
    const dst = resolvePath(to, app.cwd);
    const cap = q && q.move ? 'fs.write' : 'fs.read';
    const auth = await authorize({
      app, uid, cap: cap, target: q && q.move ? dst : src,
      label: q && q.move ? '移动' : '复制', scopeHint: q && q.move ? defaultScope('fs.write', dst) : null,
    });
    if (q && q.move) {
      // 跨设备 rename 会 EXDEV：退回「复制 + 删除」
      try { fs.renameSync(src, dst); }
      catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.cpSync(src, dst, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
      }
      return { from: src, to: dst, moved: true, auth };
    }
    fs.cpSync(src, dst, { recursive: !!(q && q.recursive) });
    return { from: src, to: dst, auth };
  }

  /* ── 进程 ─────────────────────────────────────────────────── */

  async function procSpawn(app, uid, q) {
    const argv = Array.isArray(q.argv) ? q.argv.map(String) : [];
    if (!argv.length) throw fail('EINVAL', '缺少 argv');
    if (argv.length > 64) throw fail('EINVAL', '参数太多');
    for (const a of argv) {
      if (a.length > 4096 || a.indexOf('\u0000') >= 0) throw fail('EINVAL', '参数非法');
    }
    const cwd = resolvePath(q.cwd || app.cwd, app.cwd);
    const target = normPath(argv[0]);
    const auth = await authorize({
      app, uid, cap: 'proc.spawn', target,
      label: '启动程序：' + argv.slice(0, 3).join(' '),
      scopeHint: target,
    });

    // 不用 shell：应用传的是 argv 数组，没有机会插一条 `; rm -rf /`
    const child = cp.spawn(argv[0], argv.slice(1), {
      cwd,
      env: Object.assign({}, process.env, q.env || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    const rec = { pid: child.pid, argv, started_at: Date.now(), out: '', err: '', running: true };
    const keep = (buf, chunk) => (buf + chunk.toString()).slice(-8192);
    child.stdout.on('data', (d) => { rec.out = keep(rec.out, d); });
    child.stderr.on('data', (d) => { rec.err = keep(rec.err, d); });
    child.on('exit', (code, signal) => {
      rec.exit = { code, signal, at: Date.now() };
      rec.running = false;
      children.delete(child.pid);
      // 退出后还要能被查一次（应用的第一个问题永远是「它到底打印了什么」），
      // 所以不删记录，只保留最近 20 条，避免长期运行攒成内存泄漏。
      recent.set(rec.pid, rec);
      while (recent.size > 20) recent.delete(recent.keys().next().value);
    });
    children.set(child.pid, rec);
    log(`[${app.name}] spawn ${argv[0]} pid=${child.pid}`);
    return { pid: child.pid, cwd, auth };
  }

  function procStatus(pid) {
    const n = Number(pid);
    const rec = children.get(n) || recent.get(n);
    if (!rec) return { pid: n, known: false };
    return {
      pid: rec.pid, known: true, running: !!rec.running, argv: rec.argv,
      started_at: rec.started_at, exit: rec.exit || null,
      stdout: rec.out, stderr: rec.err,
    };
  }

  function procKill(pid, sig) {
    const n = Number(pid);
    const rec = children.get(n);
    try { process.kill(n, sig || 'SIGTERM'); }
    catch (e) { return { pid: n, ok: false, message: e.message }; }
    return { pid: n, ok: true, ours: !!rec };
  }

  /* ── 网络 ─────────────────────────────────────────────────── */

  async function netFetch(app, uid, q) {
    let u;
    try { u = new URL(String(q.url || '')); }
    catch { throw fail('EINVAL', 'url 不合法'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw fail('EINVAL', '只支持 http/https');
    if (BLOCKED_HOSTS.some((re) => re.test(u.hostname))) {
      throw fail('EPERM', '云元数据地址被内核屏蔽（可被用于窃取实例凭据）');
    }
    const target = u.origin + '/**';
    const auth = await authorize({
      app, uid, cap: 'net.fetch', target,
      label: '访问网络：' + u.hostname, scopeHint: u.origin + '/**',
    });

    const body = q.body == null ? null : Buffer.from(String(q.body), 'utf8');
    const mod = u.protocol === 'https:' ? https : http;
    const res = await new Promise((resolve, reject) => {
      const r = mod.request({
        method: String(q.method || 'GET').toUpperCase(),
        hostname: u.hostname, port: u.port || undefined,
        path: u.pathname + u.search,
        headers: Object.assign({}, q.headers || {}, body ? { 'Content-Length': body.length } : {}),
        timeout: FETCH_TIMEOUT,
      }, (resp) => {
        const chunks = [];
        let size = 0;
        resp.on('data', (c) => {
          size += c.length;
          if (size > MAX_FETCH) { r.destroy(); return; }
          chunks.push(c);
        });
        resp.on('end', () => resolve({
          status: resp.statusCode,
          headers: resp.headers,
          content: Buffer.concat(chunks).toString('utf8'),
          truncated: size > MAX_FETCH,
        }));
      });
      r.on('timeout', () => r.destroy(fail('ETIMEDOUT', '请求超时')));
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });
    return Object.assign(res, { url: u.href, auth });
  }

  /* ── 系统信息（低危，仍记审计） ───────────────────────────── */

  async function sysInfo(app, uid) {
    const auth = await authorize({ app, uid, cap: 'sys.info', target: '/sys', label: '读取系统信息' });
    return {
      auth,
      platform: process.platform, arch: process.arch, node: process.version,
      hostname: os.hostname(), cpus: os.cpus().length,
      memory: { total: os.totalmem(), free: os.freemem() },
      uptime_s: Math.round(os.uptime()),
      homedir: os.homedir(),
      app: { name: app.name, cwd: app.cwd, data: app.sandbox && app.sandbox.data },
    };
  }

  return {
    authorize, resolvePath, defaultScope,
    read: fsRead, write: fsWrite, list: fsList, stat: fsStat,
    mkdir: fsMkdir, remove: fsRemove, copy: fsCopy,
    spawn: procSpawn, procStatus, procKill, fetch: netFetch, info: sysInfo,
    children,
  };
}

module.exports = { createBroker, MAX_READ, MAX_WRITE };
