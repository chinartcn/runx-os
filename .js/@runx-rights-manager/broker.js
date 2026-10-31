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

const crypto = require('crypto');
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

/** 分块读写的单块上限。流式传输的「安全阀」在这里，不在总量上 —— 总量
 *  可能是一个 8GB 的磁盘镜像，只要一块一块地过就不会把内核撑爆。 */
const MAX_CHUNK = 1024 * 1024;
/** 单个应用能同时开几个 watch。再多就是轮询滥用，不是正常需求。 */
const MAX_WATCHERS = 8;
/** watch 多久没人来取事件就自动关掉（应用崩了没调 unwatch 是常态） */
const WATCH_IDLE_MS = 5 * 60 * 1000;

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
  const watchers = new Map();   // id -> watch rec（fs.watch）

  const dialog = opts.dialog || { open: () => Promise.resolve({ cancelled: true, via: 'no-dialog' }) };
  const clipboard = opts.clipboard || null;

  const clampInt = (v, lo, hi) => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  };

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

  /* ── 分块 / 流式 ───────────────────────────────────────────── */

  /**
   * 读一段。
   *
   * 存在的理由是「2MB 上限」不是需求：视频、磁盘镜像、日志动辄几百 MB，
   * 靠 `fs.read` 整块读，要么被拒、要么把内核内存吃穿。分块之后总量不再是
   * 问题 —— 单块有上限，读多少块由应用自己决定，中间随时可以停。
   *
   * 返回的 `data` 永远是 base64：分块边界会切断多字节字符，服务端若按
   * UTF-8 返回字符串，半个汉字会被替换成 U+FFFD，且无法还原。让字节保持
   * 字节，解码交给应用（SDK 的 Readable 上 `setEncoding('utf8')` 会用
   * StringDecoder 正确跨块拼接）。
   */
  async function fsReadRange(app, uid, q) {
    const target = resolvePath(q.path, app.cwd);
    const auth = await authorize({ app, uid, cap: 'fs.read', target, label: '分段读取' });
    const st = fs.statSync(target);
    if (st.isDirectory()) throw fail('EISDIR', '这是一个目录，请用 fs.list');

    const offset = clampInt(q.offset, 0, st.size);
    const want = clampInt(q.length, 1, MAX_CHUNK);
    const room = Math.max(0, st.size - offset);
    const len = Math.min(want, room);
    const buf = Buffer.alloc(len);
    let fd = null;
    try {
      fd = fs.openSync(target, 'r');
      const n = len ? fs.readSync(fd, buf, 0, len, offset) : 0;
      return {
        path: target, offset, size: st.size, bytes: n,
        eof: offset + n >= st.size,
        data: buf.slice(0, n).toString('base64'),
        mtime: st.mtimeMs, auth,
      };
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
    }
  }

  /**
   * 写一段。
   *
   * 三种落点：`truncate`（新建/清空后写下这一块）、`append`（接在末尾）、
   * `offset`（写到指定位置，用于「只改中间某几个字节」）。不带任何参数时
   * 默认 offset=0 覆盖写 —— 那是块传输的第一步，后续块必须带 offset。
   */
  async function fsWriteRange(app, uid, q) {
    const target = resolvePath(q.path, app.cwd);
    const truncate = !!q.truncate;
    const auth = await authorize({
      app, uid, cap: 'fs.write', target,
      label: truncate ? '创建 / 覆盖文件' : '分段写入',
    });
    const buf = Buffer.from(String(q.data == null ? '' : q.data),
      q.encoding === 'utf8' ? 'utf8' : 'base64');
    if (buf.length > MAX_CHUNK) throw fail('ETOOBIG', `单块超过 ${MAX_CHUNK / 1024}KB`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    let size = 0;
    if (truncate) {
      fs.writeFileSync(target, buf);
      size = buf.length;
    } else if (q.append) {
      fs.appendFileSync(target, buf);
      size = fs.statSync(target).size;
    } else {
      const offset = clampInt(q.offset, 0, Number.MAX_SAFE_INTEGER);
      const exists = fs.existsSync(target);
      let fd = null;
      try {
        fd = fs.openSync(target, exists ? 'r+' : 'w+');
        if (buf.length) fs.writeSync(fd, buf, 0, buf.length, offset);
        size = fs.fstatSync(fd).size;
      } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关 */ } }
      }
    }
    return { path: target, bytes: buf.length, size, auth };
  }

  /* ── 监听 ─────────────────────────────────────────────────── */

  function reapWatchers() {
    const now = Date.now();
    for (const [id, rec] of watchers) {
      if (now - (rec.lastPoll || rec.created_at) > WATCH_IDLE_MS) closeWatcher(rec, 'idle');
    }
  }

  function closeWatcher(rec, why) {
    if (rec.closed) return;
    rec.closed = why || 'closed';
    try { rec.fsw.close(); } catch { /* 已经关过了 */ }
    watchers.delete(rec.id);
    // 等事件的一方要立刻醒过来，否则它的长轮询会挂到超时才返回「已关闭」
    rec.waiters.splice(0).forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    log(`watch 关闭：${rec.app} ${rec.path} (${rec.closed})`);
  }

  /**
   * 盯住一个路径。
   *
   * 为什么不用「应用自己 fs.watch」：应用进程可能被围栏挡住、可能跑在容器外，
   * 而且它看到的路径和内核看到的不一定是同一个。这里由内核盯，应用拿事件。
   *
   * 事件传输用长轮询（`fsPoll`）而不是 WebSocket：SDK 要能在 Node 18 上用，
   * 而 18 没有内置 WebSocket；长轮询每个应用都会写，代价只有一次打开的连接。
   */
  async function fsWatch(app, uid, q) {
    const target = resolvePath(q.path, app.cwd);
    const auth = await authorize({ app, uid, cap: 'fs.watch', target, label: '监听文件变化' });

    reapWatchers();
    const mine = Array.from(watchers.values()).filter((w) => w.app === app.name);
    if (mine.length >= MAX_WATCHERS) {
      // 先关最老的：应用大概是忘了 unwatch，继续拒绝会让它整个功能卡死
      mine.sort((a, b) => a.created_at - b.created_at);
      closeWatcher(mine[0], 'evicted');
    }

    const st = fs.statSync(target);   // 不存在就 ENOENT，别静默成功
    const rec = {
      id: crypto.randomBytes(6).toString('hex'),
      app: app.name, path: target, is_dir: st.isDirectory(),
      seq: 0, events: [], waiters: [], created_at: Date.now(), lastPoll: Date.now(),
      closed: null,
    };
    rec.fsw = fs.watch(target, { persistent: false, recursive: false }, (event, name) => {
      rec.seq++;
      rec.events.push({ seq: rec.seq, event, name: name == null ? null : String(name), at: Date.now() });
      if (rec.events.length > 200) rec.events.splice(0, rec.events.length - 200);
      rec.waiters.splice(0).forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    });
    rec.fsw.on('error', (e) => {
      rec.error = e.code || e.message;
      closeWatcher(rec, 'error');
    });
    if (rec.fsw.unref) rec.fsw.unref();
    watchers.set(rec.id, rec);
    log(`watch：${app.name} ${target}`);
    return { id: rec.id, path: target, watching: true, is_dir: rec.is_dir, auth };
  }

  /**
   * 取事件（长轮询）。
   *
   * `after` 是应用已处理到的序号。带 `timeout` 时，没事件就挂住最多 timeout
   * 毫秒 —— 比「每 200ms 发一次请求」省得多，也比 WebSocket 简单。
   * timeout 上限 25 秒：再长会遇到中间层（反代、手机浏览器）的空闲超时。
   */
  function fsPoll(app, q) {
    const rec = watchers.get(String(q.id || ''));
    if (!rec || rec.app !== app.name) throw fail('ENOENT', '监听不存在或已过期，请重新 fs.watch');
    const after = clampInt(q.after, 0, Number.MAX_SAFE_INTEGER);
    const timeout = clampInt(q.timeout, 0, 25000);
    rec.lastPoll = Date.now();

    const collect = () => ({
      id: rec.id, seq: rec.seq, closed: rec.closed || null,
      events: rec.events.filter((e) => e.seq > after),
    });
    const ready = collect();
    if (ready.events.length || !timeout || ready.closed) return Promise.resolve(ready);

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const i = rec.waiters.indexOf(finish);
        if (i >= 0) rec.waiters.splice(i, 1);
        resolve(collect());
      };
      // 这个 timer 不能 unref：unref 之后「等待」不再让事件循环活着，
      // 一个只在等文件变化的进程会**静默退出**，看起来像 poll 永远不返回。
      const timer = setTimeout(finish, timeout);
      rec.waiters.push(finish);
    });
  }

  function fsUnwatch(app, q) {
    const rec = watchers.get(String(q.id || ''));
    if (!rec || rec.app !== app.name) return { id: String(q.id || ''), closed: false };
    closeWatcher(rec, 'app');
    return { id: rec.id, closed: true };
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
    //
    // stdin 默认是 'ignore' 而不是 'pipe'：很多命令（cat、grep、任何等输入的
    // 交互程序）在有管道时会一直等，而应用若没打算喂数据，那个进程就永远不退出。
    // 需要喂的时候显式 { stdin: true }，那时才建管道。
    const wantStdin = !!q.stdin;
    const child = cp.spawn(argv[0], argv.slice(1), {
      cwd,
      env: Object.assign({}, process.env, q.env || {}),
      stdio: [wantStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: false,
    });
    const rec = {
      pid: child.pid, argv, started_at: Date.now(), out: '', err: '', running: true,
      stdin: wantStdin ? child.stdin : null, stdin_closed: !wantStdin,
    };
    if (rec.stdin) {
      // 子进程先退出时写 stdin 会 EPIPE。不接住就是一条未捕获异常，整个内核陪葬。
      rec.stdin.on('error', (e) => { rec.stdin_error = e.code || e.message; rec.stdin_closed = true; });
    }
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
      stdin: !!rec.stdin && !rec.stdin_closed, stdin_error: rec.stdin_error || null,
    };
  }

  function procKill(pid, sig) {
    const n = Number(pid);
    const rec = children.get(n);
    try { process.kill(n, sig || 'SIGTERM'); }
    catch (e) { return { pid: n, ok: false, message: e.message }; }
    return { pid: n, ok: true, ours: !!rec };
  }

  /**
   * 往子进程的 stdin 写一段。
   *
   * 单独开一个接口而不是「spawn 时一次给完」：`git commit`、`passwd`、
   * 任何 REPL 都是「先看到提示再回答」，一次给完它们会忽略后面的输入。
   */
  function procWrite(pid, q) {
    const n = Number(pid);
    const rec = children.get(n);
    if (!rec) throw fail('ENOENT', '进程不在运行中（可能已退出）');
    if (!rec.stdin || rec.stdin_closed) {
      throw fail('EINVAL', rec.stdin ? 'stdin 已关闭' : 'spawn 时没有请求 stdin（{stdin:true}）');
    }
    const buf = Buffer.from(String(q.data == null ? '' : q.data),
      q.encoding === 'utf8' ? 'utf8' : 'base64');
    if (buf.length > 64 * 1024) throw fail('ETOOBIG', '单次写入超过 64KB');
    try { rec.stdin.write(buf); }
    catch (e) { throw fail('EPIPE', '写入 stdin 失败：' + e.message); }
    return { pid: n, bytes: buf.length };
  }

  /** 关掉 stdin（发 EOF）。`cat` 这类命令靠这个才知道输入结束 */
  function procEnd(pid) {
    const n = Number(pid);
    const rec = children.get(n);
    if (!rec) return { pid: n, closed: false, reason: 'gone' };
    if (!rec.stdin || rec.stdin_closed) return { pid: n, closed: !!rec.stdin_closed };
    try { rec.stdin.end(); } catch { /* 已经断了 */ }
    rec.stdin_closed = true;
    return { pid: n, closed: true };
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

  /* ── 对话框 ───────────────────────────────────────────────── */

  /**
   * 让用户在桌面上挑一个文件 / 定一个保存位置 / 回答一个问题。
   *
   * ── 为什么这里不做 UAC ─────────────────────────────────────────
   * 「申请权限去申请权限」是荒谬的：对话框本身就是用户在做的决定。所以
   * `dialog.open` 不查授权表，改为三条约束：
   *   1. 同一应用同时只能有 1 个挂起的对话框（不能拿它刷屏）；
   *   2. 起始目录只能是应用沙箱或用户主目录（`startIn` 由 dialog.js 白名单校验）；
   *   3. 用户选中的路径会被记成一条**仅该路径**的读（保存框另加写）授权 ——
   *      但**高危路径除外**：挑中私钥仍然要走一次正常审批，因为「点了一个文件」
   *      和「知道这个应用要拿它做什么」是两件事。
   */
  async function dialogOpen(app, uid, q) {
    const kind = ['open', 'save', 'message'].includes(q.kind) ? q.kind : 'open';
    const risk = assess('dialog.open', '/dialog', { sandbox: app.sandbox });

    const ans = await dialog.open({
      kind,
      app: app.name, app_label: app.label, uid, user_name: q.user_name,
      title: q.title, message: q.message,
      options: {
        startIn: q.startIn, filters: q.filters, multiple: q.multiple,
        defaultName: q.defaultName, buttons: q.buttons,
      },
    });

    if (ans.cancelled) {
      return { cancelled: true, via: ans.via || 'user', risk };
    }
    if (kind === 'message') return { cancelled: false, value: ans.value, risk };

    // 选中的路径 = 一次明确授权（高危目标除外）
    const granted = [];
    const skipped = [];
    for (const p of (ans.paths || [])) {
      const caps = kind === 'save' ? ['fs.write', 'fs.read'] : ['fs.read'];
      for (const cap of caps) {
        if (assess(cap, p, { sandbox: app.sandbox }).level === 'high') { skipped.push(p); continue; }
        try {
          const g = opts.grants.grant(uid, {
            app: app.name, cap, scope: p, by: 'dialog', note: '用户在文件对话框中选择',
          });
          if (g && g.id) granted.push(g.id);
        } catch { /* 授权表满/格式问题：不影响本次返回，应用读的时候还会被问 */ }
      }
    }
    if (skipped.length) log(`对话框选中高危路径，未自动授权：${skipped.join(', ')}`);
    return {
      cancelled: false, path: ans.path, paths: ans.paths || [],
      granted, risk,
    };
  }

  /* ── 剪贴板 ───────────────────────────────────────────────── */

  async function clipboardRead(app, uid) {
    if (!clipboard) throw fail('ENOSYS', '剪贴板服务没有加载');
    const auth = await authorize({ app, uid, cap: 'clipboard.read', target: '/clipboard', label: '读取剪贴板' });
    const item = clipboard.read();
    return {
      text: item ? item.text : '', empty: !item,
      at: item ? item.at : 0, size: item ? item.size : 0,
      source: item ? (item.app || item.by || null) : null,
      auth,
    };
  }

  async function clipboardWrite(app, uid, q) {
    if (!clipboard) throw fail('ENOSYS', '剪贴板服务没有加载');
    const auth = await authorize({ app, uid, cap: 'clipboard.write', target: '/clipboard', label: '写入剪贴板' });
    const r = clipboard.write({ text: q.text, mime: q.mime, by: uid, app: app.name });
    return Object.assign({}, r, { auth });
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

  /** 应用停止时收拾它的 watch（supervisor 会调；漏了也有 idle 兜底） */
  function releaseApp(name) {
    let n = 0;
    for (const rec of Array.from(watchers.values())) {
      if (rec.app === name) { closeWatcher(rec, 'app-stop'); n++; }
    }
    return n;
  }

  return {
    authorize, resolvePath, defaultScope,
    read: fsRead, write: fsWrite, list: fsList, stat: fsStat,
    mkdir: fsMkdir, remove: fsRemove, copy: fsCopy,
    readRange: fsReadRange, writeRange: fsWriteRange,
    watch: fsWatch, poll: fsPoll, unwatch: fsUnwatch,
    spawn: procSpawn, procStatus, procKill, procWrite, procEnd,
    fetch: netFetch, info: sysInfo,
    dialog: dialogOpen,
    clipboardRead, clipboardWrite,
    releaseApp,
    children, watchers,
  };
}

module.exports = { createBroker, MAX_READ, MAX_WRITE, MAX_CHUNK };
