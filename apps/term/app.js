'use strict';

/**
 * RunX 终端应用 —— 后端入口。
 *
 * 由 @runx-supervisor 以 `node app.js` 启动，监听 supervisor 注入的 PORT。
 * 提供：
 *   · HTTP：BASE 页面 + 静态资源（含离线 xterm.js）
 *   · WS  ：/ws/term，终端 I/O 双向流
 *
 * 所有终端 I/O 走应用自己的 WS（内核 event-bus 是发布/订阅语义，不适合流式 I/O）。
 *
 * ## 命名空间：终端 shell 与 TUI 是两套东西
 *
 * 这个服务同时服务两类会话：
 *
 *   · `terminal` —— 用户自己在终端标签页里开的交互式 shell。要能刷新后恢复、
 *     要长期存活。桌面打开终端应用时用的是这个。
 *   · `tui` —— 桌面上双击一个命令图标开出来的一次性窗口（htop / free -h）。
 *     进程跑完窗口就关，不该混进终端的标签栏，也不该占终端的名额。
 *
 * 早期两类混在一起，后果是：TUI 会话被写进终端的 localStorage 恢复列表，
 * 终端刷新时把它当成 shell 标签恢复出来，第一个标签页于是绑到一个死会话上，
 * 表现为「第一个标签页不能打字」。现在两套在协议层就分开（见 lib/pty.js
 * 与 public/term.js），配额、恢复列表、回收策略各自独立。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const ws = require('./lib/ws');
const host = require('./lib/host');
const {
  SessionManager, normalizeSpec, probeScript, probeSttyFileMode, GRACE_MS,
} = require('./lib/pty');

const PORT = Number(process.env.PORT) || 3460;
const HOST = process.env.TERM_HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const START_TS = Date.now();

/** 命名空间常量 —— 前端用 URL 参数声明自己是哪一类 */
const NS_TERMINAL = 'terminal';
const NS_TUI = 'tui';

// 两个命名空间的「连接全断后宽限多久再回收」。
// terminal 给得宽一些：页面刷新、切走再切回来都还在，终端不该「一碰就没」。
// tui 本来就是一次性的，宽限为 0（由 unbind 直接回收）。
const GRACE_BY_NS = {
  [NS_TERMINAL]: Number(process.env.TERM_GRACE_MS || 30000),
  [NS_TUI]: 0,
};

const sessions = new SessionManager();
// Dock 角标跟着终端自己的会话数走：窗口最小化后也能看出「终端里还挂着几个」
sessions.onChange = () => host.badge(sessions.count(NS_TERMINAL));
const connsBySession = new Map(); // sessionId -> Set<conn>
const pendingToReap = new Map();  // sessionId -> timeout（conn 全断后的宽限回收）

/* ── 会话 ↔ 连接 绑定 ──
 *
 * 一个 WS 连接可以同时连着多个会话（终端页面一条 WS 管全部标签页），
 * 所以绑定关系是双向的：conn 上记一组 sessionId，session 上记一组 conn。
 * 早期只记 `conn.sessionId` 一个字段 —— 后绑的覆盖先绑的，连接断开时
 * 只解绑最后一个，其余会话的 conns 里一直留着死连接：输出发给了空气，
 * 用户看到的现象就是「打字没反应」。
 */
function bind(conn, sessionId) {
  let set = connsBySession.get(sessionId);
  if (!set) { set = new Set(); connsBySession.set(sessionId, set); }
  set.add(conn);
  if (!conn.sessions) conn.sessions = new Set();
  conn.sessions.add(sessionId);
  conn.sessionId = sessionId; // 兼容：未显式指定 sessionId 时的默认值
  const s = sessions.get(sessionId);
  if (s) { s.conns = set; s.lastActive = Date.now(); }
  // 若该会话正被宽限回收，取消
  const t = pendingToReap.get(sessionId);
  if (t) { clearTimeout(t); pendingToReap.delete(sessionId); }
}

function unbind(conn) {
  if (!conn.sessions || !conn.sessions.size) {
    // 兼容老路径：只记了一个 sessionId
    if (conn.sessionId) { const one = conn.sessionId; conn.sessions = new Set([one]); }
    else return;
  }
  const ids = Array.from(conn.sessions);
  conn.sessions = new Set();

  for (const sid of ids) {
    const set = connsBySession.get(sid);
    if (set) { set.delete(conn); if (set.size === 0) connsBySession.delete(sid); }
    if (connsBySession.has(sid)) continue; // 还有别的连接连着

    const sess = sessions.get(sid);
    // 一次性命令（TUI 图标）：窗口就是进程的外壳，关了窗口进程就该结束。
    // 宽限期的存在理由是「刷新页面别丢 shell」，对一条 `htop` 不成立。
    if (sess && sess.spec && sess.spec.ephemeral) { closeSession(sid); continue; }

    const grace = GRACE_BY_NS[sess ? sess.ns : NS_TERMINAL] ?? GRACE_MS;
    if (grace <= 0) { closeSession(sid); continue; }
    const t = setTimeout(() => {
      pendingToReap.delete(sid);
      if (!connsBySession.has(sid) && sessions.get(sid)) closeSession(sid);
    }, grace);
    t.unref();
    pendingToReap.set(sid, t);
  }
}

function broadcast(sessionId, obj) {
  const set = connsBySession.get(sessionId);
  if (!set) return 0;
  let n = 0;
  for (const c of set) { try { c.send(obj); n++; } catch { /* ignore */ } }
  return n;
}

/**
 * 关掉一个会话。
 *
 * @param {string} sid
 * @param {boolean} [notify] 是否广播 closed（显式关闭才广播；进程自己退出
 *   或连接已断时不必——对端已经知道发生了什么，再广播反而会把用户正在看的
 *   输出一起清掉）。
 */
function closeSession(sid, notify) {
  if (notify) broadcast(sid, { type: 'closed', sessionId: sid });
  const set = connsBySession.get(sid);
  if (set) {
    for (const c of set) {
      if (c.sessions) c.sessions.delete(sid);
      if (c.sessionId === sid) c.sessionId = null;
    }
    connsBySession.delete(sid);
  }
  const t = pendingToReap.get(sid);
  if (t) { clearTimeout(t); pendingToReap.delete(sid); }
  sessions.close(sid);
}

/* ── 会话输出 → WS（base64 承载原始字节，避免 chunk 边界切断 UTF-8/ANSI）── */
function wireSession(s) {
  s.onOutput = (sess, chunk) => {
    broadcast(sess.id, { type: 'output', sessionId: sess.id, data_b64: chunk.toString('base64'), seq: ++sess.seq });
  };
  s.onExit = (sess, code, signal) => {
    broadcast(sess.id, { type: 'exit', sessionId: sess.id, code, signal });
    // 跑久了的命令结束、或者失败了，才值得发一条桌面通知（见 lib/host.js）
    host.exited(sess, code, signal);
    // 一次性命令（TUI 图标）进程结束就没有意义了：给前端 2 秒发「关窗」，之后
    // 无论如何回收 —— 否则用户关掉窗口、页面卡住或没监听时，会话会挂到 30 分钟
    // 空闲回收，白占一个名额和一份 PTY。
    if (sess.spec && sess.spec.ephemeral) {
      const t = setTimeout(() => {
        const cur = sessions.get(sess.id);
        // 还有人连着 → 窗口还开着，用户正在看最后的输出，别删。
        // 没人连着说明窗口已经关了（unbind 那条路会更快地回收）。
        if (cur === sess && !cur.proc && (!cur.conns || cur.conns.size === 0)) {
          closeSession(sess.id);
        }
      }, 5000);
      t.unref();
    }
  };
  return s;
}

/* ── 消息处理 ── */
function handleMessage(conn, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return sendErr(conn, 400, 'bad_json'); }
  if (!msg || typeof msg !== 'object') return sendErr(conn, 400, 'bad_message');

  switch (msg.type) {
    case 'hello': return doHello(conn, msg);
    case 'create': return doCreate(conn, msg);
    case 'attach': return doAttach(conn, msg);
    case 'input': return doInput(conn, msg);
    case 'resize': return doResize(conn, msg);
    case 'close': return doClose(conn, msg);
    case 'ping': return conn.send({ type: 'pong', ts: msg.ts || Date.now() });
    default: return sendErr(conn, 400, 'unknown_type:' + msg.type);
  }
}

function sendErr(conn, code, message, sessionId) {
  conn.send(Object.assign({ type: 'error', code, message }, sessionId ? { sessionId } : {}));
}

/** 连接属于哪个命名空间：前端在 hello 里声明（URL 参数决定的） */
function nsOf(conn) {
  return conn.ns === NS_TUI ? NS_TUI : NS_TERMINAL;
}

function doHello(conn, msg) {
  conn.ns = msg.ns === NS_TUI ? NS_TUI : NS_TERMINAL;
  const ns = nsOf(conn);
  const cfg = sessions.namespaces[ns] || {};

  // 记住客户端想恢复的会话（下次 hello 也会带，用于重连后重新绑定）
  conn.resume = Array.isArray(msg.resume) ? msg.resume.slice(0, 32) : [];

  // 命中的会话：重新绑定连接（否则输出发给了空气）+ 回推历史输出
  const resumed = [];
  const missing = [];
  for (const id of conn.resume) {
    const s = sessions.get(id);
    if (!s || s.ns !== ns) { missing.push(id); continue; }
    bind(conn, s.id);
    resumed.push(s.id);
  }

  conn.send({
    type: 'welcome',
    pty: !!probeScript(),
    shell: process.env.TERM_SHELL || 'bash',
    cols: msg.cols || 80, rows: msg.rows || 24,
    max_sessions: cfg.max || 8,
    ns,
    resumed,
    missing,
    server_ts: Date.now(),
  });

  // 会话详情与历史输出单独推 —— 前端据此重建终端屏幕
  for (const id of resumed) sendSession(conn, sessions.get(id));
}

/** 把会话详情（含输出历史）发给一个连接 */
function sendSession(conn, s) {
  if (!s) return;
  const hist = s.historySnapshot ? s.historySnapshot() : Buffer.alloc(0);
  conn.send({
    type: 'session',
    sessionId: s.id,
    title: s.title,
    cols: s.cols,
    rows: s.rows,
    alive: !!s.proc,
    ns: s.ns,
    command: s.spec ? s.spec.argv.join(' ') : null,
    // 输出历史：刷新 / 重连后屏幕不至于一片空白
    history_b64: hist.length ? hist.toString('base64') : null,
  });
}

/**
 * 从消息里取会话描述。没有 argv/command 就是普通 shell 会话（返回 null）。
 *
 * 默认**不** ephemeral：用户手动点「+」开的终端要保留，刷新页面还得在。
 * 只有 TUI 图标那条路（桌面上双击一个命令）才显式传 ephemeral=true。
 */
function pickSpec(msg) {
  if (!msg || (!msg.command && !msg.argv)) return null;
  return {
    argv: msg.argv || msg.command,
    shell: !!msg.shell,
    cwd: msg.cwd || null,
    label: msg.label || null,
    ephemeral: !!msg.ephemeral,
  };
}

function doCreate(conn, msg) {
  if (!probeScript()) return sendErr(conn, 503, 'script_unavailable');
  const ns = nsOf(conn);
  let s;
  try { s = sessions.create(msg.cols, msg.rows, null, pickSpec(msg), { ns }); }
  catch (e) { return sendErr(conn, 429, e.code || 'create_failed'); }
  wireSession(s);
  s.start();
  bind(conn, s.id);
  conn.send({
    type: 'created', sessionId: s.id, pid: s.pid, cols: s.cols, rows: s.rows,
    title: s.title, ns: s.ns, command: s.spec ? s.spec.argv.join(' ') : null,
  });
}

function doAttach(conn, msg) {
  const s = sessions.get(msg.sessionId);
  if (!s) return sendErr(conn, 404, 'session_not_found', msg.sessionId);
  // 命名空间隔离：终端页面不许接管 TUI 会话，反之亦然
  if (s.ns !== nsOf(conn)) return sendErr(conn, 403, 'ns_mismatch', msg.sessionId);
  bind(conn, s.id);
  sendSession(conn, s);
}

function doInput(conn, msg) {
  const s = sessions.get(msg.sessionId || conn.sessionId);
  if (!s) return sendErr(conn, 404, 'session_not_found', msg.sessionId);
  if (typeof msg.data !== 'string') return sendErr(conn, 400, 'bad_input');
  if (msg.data.length > 65536) return sendErr(conn, 413, 'input_too_large');
  s.write(msg.data);
}

async function doResize(conn, msg) {
  const s = sessions.get(msg.sessionId || conn.sessionId);
  if (!s) return sendErr(conn, 404, 'session_not_found', msg.sessionId);
  const cols = parseInt(msg.cols, 10), rows = parseInt(msg.rows, 10);
  if (!cols || !rows) return;
  if (cols === s.cols && rows === s.rows) return; // 尺寸未变，忽略

  // 正常路径：用 stty 对已开 PTY 发 ioctl(TIOCSWINSZ)，内核随即向前台
  // 进程组发 SIGWINCH。shell 变量、cwd、历史、前台程序（vi / top / ssh）
  // 全部原地保留 —— 这才是真终端的 resize 语义。
  if (await s.setSize(cols, rows)) {
    // 成功时**不发 note**：真终端调整尺寸本来就是无声的。
    broadcast(s.id, { type: 'resized', sessionId: s.id, cols: s.cols, rows: s.rows });
    return;
  }

  // 回落：拿不到 PTY slave 路径或 stty 不可用（受限容器 / 非 /dev/pts），
  // 只能沿用“重建会话”。这种情况必须告诉用户前台程序被重启了。
  await sessions.respawn(s.id, cols, rows);
  broadcast(s.id, {
    type: 'resized', sessionId: s.id, cols: s.cols, rows: s.rows,
    note: '已按 ' + s.cols + '×' + s.rows + ' 重建会话（当前环境不支持原地改尺寸，前台程序已重启）',
  });
}

function doClose(conn, msg) {
  const sid = msg.sessionId || conn.sessionId;
  const s = sessions.get(sid);
  if (!s) return sendErr(conn, 404, 'session_not_found', sid);
  // 显式关闭：广播 closed（此时连接仍在 set 里，能收到通知），再销毁会话
  closeSession(sid, true);
}

/* ── HTTP 静态服务 ── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(res, relPath) {
  const full = path.resolve(PUBLIC_DIR, relPath);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); return res.end('403');
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

function sameOrigin(req) {
  // 防跨站驱动终端（真实 shell 被恶意网页驱动 = RCE）
  const origin = req.headers.origin;
  const host = req.headers.host || '';
  if (!origin) {
    // 无 Origin：可能是同源普通导航或非浏览器客户端，放行（原生导航不带 Origin）
    return true;
  }
  try {
    const o = new URL(origin);
    return o.host === host;
  } catch { return false; }
}

/** 读 JSON body（限长，超了直接丢弃连接） */
function readJson(req, limit) {
  return new Promise((resolve) => {
    let buf = '';
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      buf += chunk;
      if (buf.length > limit) { over = true; req.destroy(); resolve(null); }
    });
    req.on('end', () => { if (!over) { try { resolve(JSON.parse(buf || '{}')); } catch { resolve(null); } } });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  if (!sameOrigin(req)) { res.writeHead(403); return res.end('403 cross-origin'); }
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/healthz' || p === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, pid: process.pid, sessions: sessions.size, uptime_ms: Date.now() - START_TS,
      pty: !!probeScript(),
      host: host.status(),
      // resize 方式：inplace = 原地 ioctl（不重启前台程序）；respawn = 回落重建
      resize: probeSttyFileMode() ? 'inplace' : 'respawn',
      // 两个命名空间各自的会话数与配额
      namespaces: Object.keys(sessions.namespaces).map((k) => ({
        ns: k, count: sessions.count(k), max: sessions.namespaces[k].max,
      })),
    }));
  }
  if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
  if (p.startsWith('/assets/')) return serveStatic(res, p.slice('/assets/'.length));

  /* ── 命令会话（TUI 应用）──
   *
   * 桌面壳里双击一个「htop」图标，是先建会话、再开窗口：
   *   POST /sessions { command, shell, cols, rows, label }
   *   → { sessionId }
   * 前端随后 `?session=<id>` attach 到它。
   *
   * 为什么不走 WS 的 create：桌面前端在 :3000，本服务在 :3460，跨源。
   * 桌面壳让**自己的后端**去 fetch（服务端请求不带 Origin，sameOrigin 放行），
   * 前端永远不跨源。于是「谁能建任意命令会话」这个问题有了明确答案：本机进程，
   * 不是随便一个网页。浏览器直连这里会被 sameOrigin 挡掉。
   *
   * 这条路建出来的会话属于 `tui` 命名空间：和终端的 shell 标签页分开算配额、
   * 分开恢复、分开回收。
   */
  if (req.method === 'GET' && p === '/sessions') {
    const ns = url.searchParams.get('ns');
    return sendJson(res, 200, { sessions: sessions.list(ns || undefined) });
  }
  if (req.method === 'POST' && p === '/sessions') {
    return readJson(req, 8192).then((body) => {
      if (!body) return sendJson(res, 400, { error: 'bad_json' });
      if (!probeScript()) return sendJson(res, 503, { error: 'script_unavailable' });
      const spec = normalizeSpec(body);
      if (!spec) return sendJson(res, 422, { error: 'command_required' });
      // HTTP 建的会话没有连接，只有窗口：默认按一次性处理（关窗即结束）。
      // 想留一个常驻的，显式传 ephemeral:false。
      spec.ephemeral = body.ephemeral !== false;

      let s;
      try { s = sessions.create(body.cols, body.rows, body.id, spec, { ns: NS_TUI }); }
      catch (e) { return sendJson(res, 429, { error: e.code || 'create_failed' }); }
      wireSession(s);
      try { s.start(); } catch (e) {
        sessions.close(s.id);
        return sendJson(res, 500, { error: 'spawn_failed', message: String(e.message || e) });
      }
      // 90 秒内没人 attach（窗口没开成 / 前端报错）就当孤儿回收，
      // 否则一个点不动的图标会白占一个会话名额到 30 分钟空闲回收。
      const t = setTimeout(() => {
        const cur = sessions.get(s.id);
        if (cur && (!cur.conns || cur.conns.size === 0)) closeSession(s.id);
      }, 90000);
      t.unref();
      return sendJson(res, 200, {
        sessionId: s.id, pid: s.pid, cols: s.cols, rows: s.rows, title: s.title, ns: s.ns,
      });
    });
  }

  res.writeHead(404); res.end('404');
});

/* ── WS 挂载 ── */
ws.attach(server, '/ws/term', (conn) => {
  // WS 的 Origin 校验（浏览器 WS 不受 CORS 限制，必须自己查）
  if (conn.origin) {
    try {
      const o = new URL(conn.origin);
      if (o.host !== (process.env.TERM_HOST || '') && o.hostname !== 'localhost' && o.hostname !== '127.0.0.1') {
        // 允许任意 host 访问本机端口（与桌面 hostname 一致）；仅拒绝明显跨站
        // 更严格：要求 origin 的端口等于本服务端口时才算同源
        if (o.port && Number(o.port) !== PORT) { conn.close(); return; }
      }
    } catch { /* ignore */ }
  }
  conn.ns = NS_TERMINAL; // hello 之前先给个默认值
  conn.sessions = new Set();
  conn.onMessage = (raw) => handleMessage(conn, raw);
  conn.onClose = () => unbind(conn);
});

/* ── 生命周期 ── */
function shutdown() {
  sessions.disposeAll();
}
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('exit', () => { try { sessions.disposeAll(); } catch { /* ignore */ } });

server.on('error', (err) => {
  console.error('[term] server error:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('[term] listening on ' + HOST + ':' + PORT + ' (pty=' + !!probeScript() + ')');
});
