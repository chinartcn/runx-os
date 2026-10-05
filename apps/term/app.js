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
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ws = require('./lib/ws');
const { SessionManager, probeScript, MAX_SESSIONS, GRACE_MS } = require('./lib/pty');

const PORT = Number(process.env.PORT) || 3460;
const HOST = process.env.TERM_HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const START_TS = Date.now();

const sessions = new SessionManager();
const connsBySession = new Map(); // sessionId -> Set<conn>
const pendingToReap = new Map();  // sessionId -> timeout（conn 全断后的宽限回收）

/* ── 会话 ↔ 连接 绑定 ── */
function bind(conn, sessionId) {
  let set = connsBySession.get(sessionId);
  if (!set) { set = new Set(); connsBySession.set(sessionId, set); }
  set.add(conn);
  conn.sessionId = sessionId;
  const s = sessions.get(sessionId);
  if (s) { s.conns = set; s.lastActive = Date.now(); }
  // 若该会话正被宽限回收，取消
  const t = pendingToReap.get(sessionId);
  if (t) { clearTimeout(t); pendingToReap.delete(sessionId); }
}
function unbind(conn) {
  const sid = conn.sessionId;
  if (!sid) return;
  const set = connsBySession.get(sid);
  if (set) { set.delete(conn); if (set.size === 0) connsBySession.delete(sid); }
  // conn 全断 → 宽限后回收该会话（避免仅刷新页面就丢 shell）
  if (!connsBySession.has(sid)) {
    const t = setTimeout(() => {
      pendingToReap.delete(sid);
      if (!connsBySession.has(sid) && sessions.get(sid)) {
        sessions.close(sid);
      }
    }, GRACE_MS);
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

/* ── 会话输出 → WS（base64 承载原始字节，避免 chunk 边界切断 UTF-8/ANSI）── */
function wireSession(s) {
  s.onOutput = (sess, chunk) => {
    broadcast(sess.id, { type: 'output', sessionId: sess.id, data_b64: chunk.toString('base64'), seq: ++sess.seq });
  };
  s.onExit = (sess, code, signal) => {
    broadcast(sess.id, { type: 'exit', sessionId: sess.id, code, signal });
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

function doHello(conn, msg) {
  conn.send({
    type: 'welcome',
    pty: !!probeScript(),
    shell: process.env.TERM_SHELL || 'bash',
    cols: msg.cols || 80, rows: msg.rows || 24,
    max_sessions: MAX_SESSIONS,
    server_ts: Date.now(),
  });
  // 若前端带了想恢复的 sessionId 列表 → 告知哪些还活着
  if (Array.isArray(msg.resume)) {
    for (const id of msg.resume) {
      const s = sessions.get(id);
      if (s) conn.send({ type: 'session', sessionId: s.id, title: s.title, cols: s.cols, rows: s.rows, alive: true });
    }
  }
}

function doCreate(conn, msg) {
  if (!probeScript()) return sendErr(conn, 503, 'script_unavailable');
  let s;
  try { s = sessions.create(msg.cols, msg.rows); }
  catch (e) { return sendErr(conn, 429, e.code || 'create_failed'); }
  wireSession(s);
  s.start();
  bind(conn, s.id);
  conn.send({ type: 'created', sessionId: s.id, pid: s.pid, cols: s.cols, rows: s.rows });
}

function doAttach(conn, msg) {
  const s = sessions.get(msg.sessionId);
  if (!s) return sendErr(conn, 404, 'session_not_found', msg.sessionId);
  bind(conn, s.id);
  conn.send({ type: 'session', sessionId: s.id, title: s.title, cols: s.cols, rows: s.rows, alive: !!s.proc });
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

  // script 无法动态改 PTY 尺寸 → 重建会话（保留 id 与前端 scrollback）
  await sessions.respawn(s.id, cols, rows);
  const note = '\r\n\x1b[2m── 已按 ' + s.cols + 'x' + s.rows + ' 重建会话（前台程序已重启）──\x1b[0m\r\n';
  broadcast(s.id, { type: 'output', sessionId: s.id, data_b64: Buffer.from(note, 'utf8').toString('base64'), seq: ++s.seq });
  broadcast(s.id, { type: 'resized', sessionId: s.id, cols: s.cols, rows: s.rows });
}

function doClose(conn, msg) {
  const sid = msg.sessionId || conn.sessionId;
  const s = sessions.get(sid);
  if (!s) return sendErr(conn, 404, 'session_not_found', sid);

  // 先广播 closed（此时连接仍在 set 里，能收到通知），再解绑并销毁会话
  broadcast(sid, { type: 'closed', sessionId: sid });

  const set = connsBySession.get(sid);
  if (set) {
    for (const c of set) { c.sessionId = null; }
    connsBySession.delete(sid);
  }
  const t = pendingToReap.get(sid);
  if (t) { clearTimeout(t); pendingToReap.delete(sid); }
  sessions.close(sid);
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

const server = http.createServer((req, res) => {
  if (!sameOrigin(req)) { res.writeHead(403); return res.end('403 cross-origin'); }
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/healthz' || p === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, pid: process.pid, sessions: sessions.size, uptime_ms: Date.now() - START_TS, pty: !!probeScript() }));
  }
  if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
  if (p.startsWith('/assets/')) return serveStatic(res, p.slice('/assets/'.length));
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
