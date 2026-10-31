'use strict';

/**
 * RunX 示例应用（demo）
 *
 * 这不是一个「功能演示页」，是一份**能跑起来的文档**：把 @runx/sdk 的每一项
 * 能力都用一遍，并且把「什么时候会弹框、为什么会被拒」直接显示在界面上。
 *
 * ── 它刻意做对的几件事 ──────────────────────────────────────────
 * 1. **所有文件访问都走 SDK**，没有一处 `require('fs')`。这样每一步都会经过
 *    内核的授权检查 —— 界面上的「已授权 / 待批准 / 被拒绝」才是真的。
 * 2. **不隐藏失败**。ENOUI（桌面没开）、NEED_ADMIN（高危）、EPERM（用户拒绝）
 *    都原样显示在对应的面板里，并附一句「那现在该怎么办」。
 * 3. **流式是真流式**：`rx.fs.createReadStream` 一块一块读，进度实时推给页面。
 *    换成 `readFile` 就会在 2MB 上限那里直接失败 —— 这正是要演示的差别。
 *
 * ── 浏览器 ↔ 本进程 ↔ 内核 ─────────────────────────────────────
 *   页面（iframe，另一个源）
 *      │  fetch / EventSource
 *      ▼
 *   本进程（node app.js，3470）── @runx/sdk ──▶ 内核 /runx/sdk/*（要授权）
 *
 * 页面不能直接跟内核说话（跨源 + 没有令牌），所以这里做一层很薄的转发。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

let rx = null;
try { rx = require('@runx/sdk'); } catch (e) { rx = null; }

// @runx/host 是「我该怎么表现」那一半：主题、标题、通知。
// 没挂这个包也能跑（下面每处都判了空），但那样窗口内外会是两种颜色。
let host = null;
try { host = require('@runx/host'); } catch (e) { host = null; }

const PORT = Number(process.env.PORT) || 3470;
const HOST = process.env.DEMO_HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const GATEWAY = process.env.RUNX_GATEWAY || 'http://127.0.0.1:3000';
const START = Date.now();

fs.mkdirSync(DATA, { recursive: true });

/* ── 主题：跟着桌面走 ─────────────────────────────────────────────
 * 页面在另一个源里，读不到桌面的 DOM；能拿到主题的只有进程侧（令牌换的）。
 * 所以由这里问一次、订阅一次，再把结果推给页面。
 * 拿不到就退回 'auto' —— 绝不让「主题同步失败」变成「页面没颜色」。 */
let themeMode = 'auto';

async function syncTheme() {
  if (!host || !host.enabled) return;
  try {
    const t = await host.theme.get();
    themeMode = (t && t.mode) || 'auto';
  } catch (e) { /* 读不到就保持上一个值 */ }
}

function watchTheme() {
  if (!host || !host.enabled) return;
  syncTheme();
  try {
    host.theme.onChange((t) => {
      themeMode = (t && t.mode) || 'auto';
      send('theme', { mode: themeMode });
    });
  } catch (e) { /* 总线没连上就算了，页面还有自己的分段控件 */ }
}

/* ── SSE：一个通道推所有实时事件（watch / stream / proc） ────────── */

const clients = new Set();

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 断了 */ } }, 20000);
  res.on('close', () => { clearInterval(ping); clients.delete(res); });
}

function send(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of Array.from(clients)) {
    try { c.write(payload); } catch { clients.delete(c); }
  }
}

/* ── 小工具 ─────────────────────────────────────────────────────── */

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve({}); }
    });
  });
}

/**
 * SDK 错误 → 给页面看的形状。
 *
 * 关键是把 `code` 和「人话 + 下一步」分开：页面用 code 决定要不要显示「去开
 * 管理员模式」这类按钮，用 message 直接显示。不把两者揉成一个字符串。
 */
function errOf(e) {
  const code = e && e.code ? e.code : 'EUNKNOWN';
  const HINT = {
    ENOTRUNX: '这个应用没有跑在 RunX 里（缺 RUNX_APP_NAME / RUNX_APP_TOKEN），所有 SDK 调用都不可用。',
    EPERM: '用户拒绝了，或者没有人能批准。可以再试一次，桌面会重新问。',
    NEED_ADMIN: '这是高危操作。先在菜单栏右上角的盾牌里开启「管理员模式」，再回来重试。',
    ENOUI: '桌面没打开，没有人能批准这次请求。先在桌面里打开这个应用。',
    ETIMEDOUT: '等审批超时了。桌面上的框还在的话可以直接点。',
    ENOENT: '路径不存在。',
    EISDIR: '这是一个目录，请用「列出目录」。',
    ETOOBIG: '超过单次读写的上限。大文件请用「流式读取」。',
    EINVAL: '参数不对。',
  };
  return {
    ok: false,
    code,
    message: (e && e.message) || code,
    hint: HINT[code] || '',
    detail: (e && e.detail) || null,
  };
}

/* ── 业务路由 ───────────────────────────────────────────────────── */

let watcher = null;      // 当前监听（同一时间只演示一个）
let procs = new Map();   // pid -> {timer, last}

async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '');
  const method = req.method;

  if (!rx || !rx.enabled) {
    return json(res, 200, {
      ok: false, code: 'ENOTRUNX',
      hint: '把应用装进 RunX（appex.json / apps.json）后由内核启动，SDK 才可用。',
    });
  }

  /* 状态：这个应用是谁、能干什么 */
  if (p === '/state' && method === 'GET') {
    let info = null, sysErr = null;
    try { info = await rx.sys.info(); } catch (e) { sysErr = errOf(e); }
    return json(res, 200, {
      ok: true,
      app: rx.app,
      sys: info,
      sys_error: sysErr,
      gateway: GATEWAY,
      theme: themeMode,
      uptime_s: Math.round((Date.now() - START) / 1000),
      node: process.version,
    });
  }

  /* 对话框 */
  if (p === '/dialog' && method === 'POST') {
    const b = await readJson(req);
    const kind = b.kind === 'save' ? 'save' : 'open';
    try {
      const r = kind === 'save'
        ? await rx.dialog.save({ title: b.title, defaultName: b.defaultName, filters: b.filters })
        : await rx.dialog.open({ title: b.title, filters: b.filters, multiple: false });
      return json(res, 200, { ok: true, result: r });
    } catch (e) { return json(res, 200, errOf(e)); }
  }

  /* 文件 */
  if (p === '/fs/list' && method === 'POST') {
    const b = await readJson(req);
    try { return json(res, 200, { ok: true, result: await rx.fs.list(b.path || '.') }); }
    catch (e) { return json(res, 200, errOf(e)); }
  }
  if (p === '/fs/read' && method === 'POST') {
    const b = await readJson(req);
    try {
      const r = await rx.fs.read(b.path);
      // 预览截断是页面的事，但要告诉它「这是不是全部」
      const content = r.encoding === 'base64' ? '(二进制内容，' + r.size + ' 字节)' : r.content.slice(0, 4000);
      return json(res, 200, {
        ok: true,
        result: {
          path: r.path, size: r.size, encoding: r.encoding, mtime: r.mtime,
          content, truncated: r.encoding === 'utf8' && r.content.length > 4000,
        },
      });
    } catch (e) { return json(res, 200, errOf(e)); }
  }
  if (p === '/fs/write' && method === 'POST') {
    const b = await readJson(req);
    try {
      const r = await rx.fs.write(b.path, String(b.text == null ? '' : b.text));
      return json(res, 200, { ok: true, result: r });
    } catch (e) { return json(res, 200, errOf(e)); }
  }

  /* 监听 */
  if (p === '/watch' && method === 'POST') {
    const b = await readJson(req);
    try {
      if (watcher) { try { await watcher.close(); } catch { /* 已关 */ } watcher = null; }
      const w = rx.fs.watch(b.path, (ev) => send('watch', ev), {
        onError: (e) => { send('watch-end', { code: e.code || 'ECLOSED', message: e.message }); watcher = null; },
      });
      const info = await w.ready;
      watcher = w;
      return json(res, 200, { ok: true, result: info });
    } catch (e) { watcher = null; return json(res, 200, errOf(e)); }
  }
  if (p === '/watch' && method === 'DELETE') {
    const w = watcher; watcher = null;
    if (w) { try { await w.close(); } catch { /* 已关 */ } }
    return json(res, 200, { ok: true, result: { closed: !!w } });
  }

  /* 流式读：把整个文件分块过一遍，进度实时推给页面 */
  if (p === '/stream' && method === 'POST') {
    const b = await readJson(req);
    const started = Date.now();
    let bytes = 0, chunks = 0;
    try {
      const st = await rx.fs.stat(b.path);
      if (!st.exists) throw Object.assign(new Error('文件不存在'), { code: 'ENOENT' });
      const total = st.size;
      const rs = rx.fs.createReadStream(b.path, { highWaterMark: 256 * 1024 });
      for await (const chunk of rs) {
        bytes += chunk.length;
        chunks++;
        send('stream', { bytes, total, chunks, ms: Date.now() - started });
      }
      send('stream-end', { bytes, total, chunks, ms: Date.now() - started });
      return json(res, 200, { ok: true, result: { bytes, total, chunks, ms: Date.now() - started } });
    } catch (e) {
      send('stream-end', { bytes, ms: Date.now() - started, error: (e && e.code) || 'EUNKNOWN' });
      return json(res, 200, errOf(e));
    }
  }

  /* 进程：起 → 喂 stdin → 收 stdout */
  if (p === '/proc/start' && method === 'POST') {
    const b = await readJson(req);
    const argv = Array.isArray(b.argv) && b.argv.length ? b.argv.map(String) : ['cat'];
    try {
      const r = await rx.proc.spawn(argv, { stdin: true });
      const rec = { pid: r.pid, last: '', lastErr: '', exit: null, timer: null };
      rec.timer = setInterval(async () => {
        try {
          const st = await rx.proc.status(rec.pid);
          if (st.stdout !== rec.last || st.stderr !== rec.lastErr || (st.exit && !rec.exit)) {
            rec.last = st.stdout; rec.lastErr = st.stderr; rec.exit = st.exit;
            send('proc', { pid: rec.pid, stdout: st.stdout, stderr: st.stderr, exit: st.exit || null });
          }
          if (st.exit) { clearInterval(rec.timer); procs.delete(rec.pid); }
        } catch (e) {
          // 别静默停掉：轮询失败时要让页面看见「为什么没有输出了」
          clearInterval(rec.timer); procs.delete(rec.pid);
          send('proc', { pid: rec.pid, stdout: rec.last, stderr: rec.lastErr, exit: null, error: (e && e.code) || 'EUNKNOWN', message: e && e.message });
        }
      }, 150);
      procs.set(rec.pid, rec);
      return json(res, 200, { ok: true, result: { pid: r.pid, argv } });
    } catch (e) { return json(res, 200, errOf(e)); }
  }
  if (p === '/proc/input' && method === 'POST') {
    const b = await readJson(req);
    try {
      const r = await rx.proc.write(Number(b.pid), String(b.text == null ? '' : b.text));
      if (b.end) await rx.proc.end(Number(b.pid));
      return json(res, 200, { ok: true, result: r });
    } catch (e) { return json(res, 200, errOf(e)); }
  }
  if (p === '/proc/end' && method === 'POST') {
    const b = await readJson(req);
    try { return json(res, 200, { ok: true, result: await rx.proc.end(Number(b.pid)) }); }
    catch (e) { return json(res, 200, errOf(e)); }
  }

  /* 剪贴板 */
  if (p === '/clipboard' && method === 'GET') {
    try { return json(res, 200, { ok: true, result: await rx.clipboard.read() }); }
    catch (e) { return json(res, 200, errOf(e)); }
  }
  if (p === '/clipboard' && method === 'POST') {
    const b = await readJson(req);
    try { return json(res, 200, { ok: true, result: await rx.clipboard.write(String(b.text == null ? '' : b.text)) }); }
    catch (e) { return json(res, 200, errOf(e)); }
  }

  /* 示例数据：在 data/ 里铺几个文件，方便第一次点开就有东西可玩 */
  if (p === '/seed' && method === 'POST') {
    const notes = [
      ['welcome.md', '# 欢迎\n\n这个应用是一个示例：它的每一次文件访问都经过 RunX 的授权。\n'],
      ['todo.txt', '- 试试「监听」：改一下这个文件\n- 试试「大文件」：读一个几 MB 的文件\n- 试试「剪贴板」：写入再读回\n'],
    ];
    const out = [];
    for (const [name, text] of notes) {
      try { out.push({ name, r: await rx.fs.write(path.join(DATA, name), text) }); }
      catch (e) { out.push({ name, error: errOf(e) }); }
    }
    try {
      const big = path.join(DATA, 'big.bin');
      try { fs.statSync(big); } catch {
        // 4MB 假数据：故意超过 fs.read 的 2MB 上限，用来对比「整块读」与「流式」
        const buf = Buffer.alloc(4 * 1024 * 1024);
        for (let i = 0; i < buf.length; i += 4096) buf.write('runx-demo-' + i + '\n', i, 'utf8');
        fs.writeFileSync(big, buf);
      }
      out.push({ name: 'big.bin (4MB, 本地直写)', size: 4 * 1024 * 1024 });
    } catch (e) {
      // 诊断用：把 code / resource 一起带出来（围栏拒绝时 message 里没有路径）
      out.push({ name: 'big.bin', error: e.message, code: e.code, resource: e.resource, stack: String(e.stack || '').split('\n').slice(0, 3) });
    }
    return json(res, 200, { ok: true, result: out });
  }

  return json(res, 404, { ok: false, code: 'ENOENT', message: '没有这个接口：' + p });
}

/* ── 静态资源 ───────────────────────────────────────────────────── */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function serveStatic(res, rel) {
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('403'); return; }
  let buf;
  try { buf = fs.readFileSync(file); } catch { res.writeHead(404); res.end('404'); return; }

  if (rel === 'index.html') {
    // 内核地址在运行时才知道：把占位符换成真的，页面里就能直接引 /runx/ui/*
    buf = Buffer.from(buf.toString('utf8')
      .replace(/__GATEWAY__/g, GATEWAY)
      .replace(/__APP__/g, process.env.RUNX_APP_NAME || 'demo'), 'utf8');
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(buf);
}

/* ── 服务器 ─────────────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (url.pathname === '/healthz') {
    return json(res, 200, {
      ok: true, app: 'demo', node: process.version,
      sdk: !!(rx && rx.enabled), gateway: GATEWAY,
      watcher: !!watcher, procs: procs.size,
      uptime_s: Math.round((Date.now() - START) / 1000),
    });
  }
  if (url.pathname === '/api/events') return sse(res);
  if (url.pathname.startsWith('/api/')) {
    return api(req, res, url).catch((e) => json(res, 500, { ok: false, code: 'EINTERNAL', message: e.message }));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('405'); return; }
  serveStatic(res, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
});

server.listen(PORT, HOST, () => {
  console.log(`[demo] listening on ${HOST}:${PORT}  sdk=${rx && rx.enabled ? 'on' : 'off'}  host=${host && host.enabled ? 'on' : 'off'}  gateway=${GATEWAY}`);
  watchTheme();
});

process.on('SIGTERM', () => {
  for (const rec of procs.values()) clearInterval(rec.timer);
  if (watcher) watcher.close().catch(() => {});
  server.close(() => process.exit(0));
});
