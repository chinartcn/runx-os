'use strict';

/**
 * RunX 应用商店（原生应用）
 *
 * ── 为什么商店是一个「原生应用」而不是桌面插件 ──────────────────────
 * 之前商店是 @runx-store 扩展 + 桌面板子。面板的毛病很具体：
 * 它挂在桌面里、和桌面抢同一层，列表一多就把桌面撑开；而且它只能显示
 * 商店**代理过**的数据 —— 代理那一层是内核在做，等于「看商店」这件事
 * 也得内核参与。
 *
 * 做成原生应用之后：
 *   · 商店列表/详情由页面**直接请求商店 API**（api.rtcnnavext.de5.net），
 *     内核不参与读路径 —— 商店挂了不会影响桌面，看商店也不占内核的活。
 *   · 窗口就是普通应用窗口：能拖、能缩、能最小化，跟别的应用一个待遇。
 *
 * ── 但「安装」必须回到内核 ───────────────────────────────────────
 * 安装是特权操作：要往文件系统里写、要起进程。这件事只有内核能做
 * （@runx-pax 的安全解包：拒软链、拒绝对路径、拒 ../、64MB 上限）。
 * 所以这里的分工是：
 *
 *   页面 ──GET──▶ 商店 API            （读：直接去，不绕内核）
 *   页面 ──POST─▶ 本进程 ──▶ 内核 /runx/apps/install  （写：特权通道）
 *
 * 本进程只做一件事：把「装哪个」翻译成内核听得懂的话。下载也由内核走
 * 商店的 /api/proxy —— 整包不经过浏览器，省流量也省内存。
 *
 * ── 跨域 ────────────────────────────────────────────────────────
 * 页面在 http://host:3480，商店在 https://api.rtcnnavext.de5.net ——
 * 跨源。商店 Worker 的响应带 access-control-allow-origin: *，
 * 所以浏览器直连没问题，不需要这里的进程做中转。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

let rx = null;
try { rx = require('@runx/sdk'); } catch (e) { rx = null; }

let host = null;
try { host = require('@runx/host'); } catch (e) { host = null; }

const PORT = Number(process.env.PORT) || 3480;
const HOST = process.env.STORE_HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const DATA = process.env.RUNX_APP_DATA || path.join(__dirname, 'data');
const GATEWAY = process.env.RUNX_GATEWAY || 'http://127.0.0.1:3000';

/* 商店 API 的根。可以用环境变量改 —— 换源、指向自己的部署都靠它。 */
const API_BASE = (process.env.STORE_API_BASE || 'https://api.rtcnnavext.de5.net').replace(/\/+$/, '');

/* 安装包大小上限：跟内核 PaX 的上限对齐，超了直接拒，不浪费带宽。 */
const MAX_INSTALL_BYTES = 64 * 1024 * 1024;

fs.mkdirSync(DATA, { recursive: true });

/* ── 小工具 ─────────────────────────────────────────────────────── */

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fail(res, status, code, message, extra) {
  json(res, status, Object.assign({ ok: false, code, message }, extra || {}));
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, rel) {
  const file = path.join(PUBLIC, rel);
  // 目录穿越：解析后的路径必须还在 public/ 里
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) {
    res.writeHead(403); res.end('403'); return;
  }
  let buf;
  try { buf = fs.readFileSync(file); } catch { res.writeHead(404); res.end('404'); return; }

  // 占位符替换：html 和 js 都要替。
  //
  // 为什么 js 也要：API_BASE 定义在 store.js 里（前端脚本是独立文件），
  // 只替 index.html 的话，store.js 里的 '__API_BASE__' 原样留着 ——
  // 请求打到 '__API_BASE__/api/apps'，报 404，看起来像「商店连不上」，
  // 实际是本地字符串替换漏了。
  if (/\.(html|js)$/i.test(rel)) {
    buf = Buffer.from(buf.toString('utf8')
      .replace(/__API_BASE__/g, API_BASE)
      .replace(/__GATEWAY__/g, GATEWAY), 'utf8');
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(buf);
}

function readBody(req, limit) {
  const cap = limit || 256 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let got = 0;
    req.on('data', (c) => {
      got += c.length;
      if (got > cap) { reject(Object.assign(new Error('请求体过大'), { code: 'ETOOBIG' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('请求体不是 JSON'), { code: 'EBADJSON' }); }
}

/* ── 跟内核说话 ─────────────────────────────────────────────────── */

/**
 * 转发到内核。
 *
 * 端口用 GATEWAY（supervisor 注入的内核地址），不是写死 3000 ——
 * 内核跑在别的端口时，写死的版本会把请求打到另一个实例上，
 * 症状是「安装报错跟安装毫无关系」，极难查。
 */
async function gw(pathname, opts) {
  const o = opts || {};
  const url = GATEWAY + pathname;
  const init = { method: o.method || 'GET', headers: { accept: 'application/json' } };
  if (o.body) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(o.body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

/* ── 路由 ───────────────────────────────────────────────────────── */

async function api(req, res, url) {
  const p = url.pathname;

  /* 前端拿配置：商店 API 在哪、内核在哪、当前用户是谁。
   * 页面要直连商店 API，所以必须知道地址 —— 这是「只请求 api」的落点。 */
  if (p === '/api/config' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      api_base: API_BASE,
      gateway: GATEWAY,
      max_install_bytes: MAX_INSTALL_BYTES,
      sdk: !!(rx && rx.enabled),
    });
  }

  /* 已安装列表：从内核拿。商店不存包也不管安装，只管上架与分发。 */
  if (p === '/api/installed' && req.method === 'GET') {
    const r = await gw('/runx/apps');
    if (r.status !== 200) return fail(res, 502, 'EGATEWAY', '内核没响应', { detail: r.data });
    const apps = (r.data && r.data.apps) || [];
    return json(res, 200, {
      ok: true,
      apps: apps.map((a) => ({
        name: a.name,
        label: a.display_name || a.name,
        version: a.version || '',
        port: a.port || 0,
        state: (a.status && a.status.state) || 'unknown',
        icon: a.icon || '',
      })),
    });
  }

  /* 安装：特权操作，走内核。
   *
   * 页面给的是「商店上的下载地址」和「包内哪个目录是应用」；
   * 这里把下载地址套上商店的 /api/proxy（Worker 代下载，本机不出网），
   * 再交给内核做安全解包与落盘。
   */
  if (p === '/api/install' && req.method === 'POST') {
    const b = await readJson(req);
    const url2 = String(b.url || '').trim();
    if (!/^https?:\/\//i.test(url2)) return fail(res, 400, 'EBADURL', '下载地址不对');
    const subdir = String(b.subdir || '').trim();
    const slug = String(b.slug || '').trim();

    const proxyUrl = API_BASE + '/api/proxy?url=' + encodeURIComponent(url2);
    const payload = { source: 'remote', url: proxyUrl };
    if (subdir) payload.subdir = subdir;

    try {
      const r = await gw('/runx/apps/install', { method: 'POST', body: payload });
      const d = r.data || {};
      // 内核成功时返回 {name, version, installed_at, bytes} —— **没有 ok 字段**。
      // 所以判失败要看 error，而不是看 !ok：后者会把每一次成功都当成失败。
      if (r.status !== 200 || d.error) {
        const em = d.error || {};
        return fail(res, 422, em.code || 'EINSTALL', em.message || '安装失败', { detail: d });
      }
      return json(res, 200, {
        ok: true,
        installed: { name: d.name, version: d.version, slug },
        bytes: d.bytes || 0,
      });
    } catch (e) {
      return fail(res, 502, 'EGATEWAY', '内核没响应：' + String(e && e.message || e));
    }
  }

  /* 更新：跟安装同一条路，只是内核那边走 update 路由。 */
  if (p === '/api/update' && req.method === 'POST') {
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    const url2 = String(b.url || '').trim();
    if (!name) return fail(res, 400, 'ENONAME', '缺少应用名');
    if (!/^https?:\/\//i.test(url2)) return fail(res, 400, 'EBADURL', '下载地址不对');
    const subdir = String(b.subdir || '').trim();
    const proxyUrl = API_BASE + '/api/proxy?url=' + encodeURIComponent(url2);
    const payload = { source: 'remote', url: proxyUrl };
    if (subdir) payload.subdir = subdir;
    try {
      const r = await gw('/runx/apps/' + encodeURIComponent(name) + '/update', { method: 'POST', body: payload });
      const d = r.data || {};
      if (r.status !== 200 || d.error) {
        const em = d.error || {};
        return fail(res, 422, em.code || 'EUPDATE', em.message || '更新失败', { detail: d });
      }
      return json(res, 200, { ok: true, updated: { name: d.name || name, version: d.version } });
    } catch (e) {
      return fail(res, 502, 'EGATEWAY', '内核没响应：' + String(e && e.message || e));
    }
  }

  /* 卸载：也是特权操作。
   *
   * 注意内核的 uninstallApp 会**连目录一起删掉**。对「从商店装的应用」
   * 没问题（它整个是下载来的），但如果有人拿它去删一个装在源码目录里的
   * 应用（比如本仓库的 apps/demo），源码就跟着没了 —— 不可逆。
   *
   * 所以这里多问一句：这是不是个「装进来的」应用？判据是它有没有
   * meta.json（商店上上架的应用都有，源码目录里的没有）。
   */
  if (p === '/api/uninstall' && req.method === 'POST') {
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    if (!name) return fail(res, 400, 'ENONAME', '缺少应用名');
    try {
      const r = await gw('/runx/apps/' + encodeURIComponent(name));
      const entry = (r.data && r.data.apps || []).find((a) => a.name === name);
      const cwd = entry && entry.cwd ? String(entry.cwd) : '';
      const hasMeta = cwd ? fs.existsSync(path.join(cwd, 'meta.json')) : false;
      if (cwd && !hasMeta && !b.force) {
        return fail(res, 409, 'ESOURCE', '这个应用不是从商店装的 —— 卸载会连它的源码目录一起删掉。确认请带 force。',
          { cwd, name });
      }
      const d = await gw('/runx/apps/' + encodeURIComponent(name), { method: 'DELETE' });
      const j = d.data || {};
      if (d.status !== 200 || j.error) {
        const em = j.error || {};
        return fail(res, 422, em.code || 'EUNINSTALL', em.message || '卸载失败', { detail: j });
      }
      return json(res, 200, { ok: true, removed: name });
    } catch (e) {
      return fail(res, 502, 'EGATEWAY', '内核没响应：' + String(e && e.message || e));
    }
  }

  /* 开发者相关（上架、我的应用）也归这个进程管：
   * 它们要带开发者令牌，令牌存在本应用的 data 目录里 —— 存在这边，
   * 页面就能直接拿来用，不用再绕一圈。 */
  if (p === '/api/dev/session' && req.method === 'GET') {
    return json(res, 200, { ok: true, session: readSession() });
  }
  /* 注册：还没有账号的开发者先开一个。
   *
   * 注册即登录 —— 后端的 /api/user/register 成功后会直接发一个会话 token，
   * 所以这里不用再走一遍登录，省一次往返，也省用户再输一遍密码。 */
  if (p === '/api/dev/register' && req.method === 'POST') {
    const b = await readJson(req);
    const name = String(b.name || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!/^[a-z0-9_.-]{3,32}$/.test(name)) {
      return fail(res, 400, 'bad_name', '用户名只能是小写字母、数字、_ . -，3 到 32 位');
    }
    if (password.length < 8) {
      return fail(res, 400, 'weak_password', '密码至少 8 位');
    }
    try {
      const r = await fetch(API_BASE + '/api/user/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return fail(res, r.status, d.code || 'EREGISTER', d.message || '注册失败');
      writeSession({ token: d.token, name: d.name || name, at: Date.now() });
      return json(res, 200, { ok: true, user: { name: d.name || name } });
    } catch (e) {
      return fail(res, 502, 'ESTORE', '商店不可达：' + String(e && e.message || e));
    }
  }
  if (p === '/api/dev/login' && req.method === 'POST') {
    const b = await readJson(req);
    try {
      const r = await fetch(API_BASE + '/api/user/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: b.name, password: b.password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return fail(res, r.status, d.code || 'ELOGIN', d.message || '登录失败');
      writeSession({ token: d.token, name: b.name, at: Date.now() });
      return json(res, 200, { ok: true, user: { name: b.name } });
    } catch (e) {
      return fail(res, 502, 'ESTORE', '商店不可达：' + String(e && e.message || e));
    }
  }
  if (p === '/api/dev/logout' && req.method === 'POST') {
    writeSession(null);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/dev/my-apps' && req.method === 'GET') {
    const s = readSession();
    if (!s || !s.token) return json(res, 200, { ok: true, apps: [], logged_in: false });
    try {
      const r = await fetch(API_BASE + '/api/user/apps', {
        headers: { authorization: 'Bearer ' + s.token, accept: 'application/json' },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return fail(res, r.status, d.code || 'EAPPS', d.message || '取不到我的应用');
      return json(res, 200, { ok: true, logged_in: true, apps: d.apps || [] });
    } catch (e) {
      return fail(res, 502, 'ESTORE', '商店不可达：' + String(e && e.message || e));
    }
  }
  if (p === '/api/dev/sync' && req.method === 'POST') {
    const b = await readJson(req);
    const s = readSession();
    if (!s || !s.token) return fail(res, 401, 'ENOLOGIN', '先登录开发者账号');
    if (!/^https?:\/\//i.test(String(b.meta_url || ''))) {
      return fail(res, 400, 'EBADURL', 'meta 地址不对');
    }
    try {
      const r = await fetch(API_BASE + '/api/user/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.token },
        body: JSON.stringify({ meta_url: b.meta_url }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return fail(res, r.status, d.code || 'ESYNC', d.message || '同步失败');
      return json(res, 200, { ok: true, app: d.app || null });
    } catch (e) {
      return fail(res, 502, 'ESTORE', '商店不可达：' + String(e && e.message || e));
    }
  }

  return fail(res, 404, 'ENOENT', '没有这个接口');
}

/* ── 开发者会话（存在本应用的 data 目录） ──────────────────────── */

const SESSION_FILE = path.join(DATA, 'dev-session.json');

function readSession() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return (s && s.token) ? s : null;
  } catch { return null; }
}

function writeSession(s) {
  try {
    if (s) fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
    else fs.rmSync(SESSION_FILE, { force: true });
  } catch (e) {
    console.error('[store] 会话写入失败：', e.message);
  }
}

/* ── 服务器 ─────────────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (url.pathname === '/healthz') {
    return json(res, 200, {
      ok: true, app: 'store', node: process.version,
      sdk: !!(rx && rx.enabled), api_base: API_BASE, gateway: GATEWAY,
    });
  }
  if (url.pathname.startsWith('/api/')) {
    return api(req, res, url).catch((e) => {
      const code = e && e.code;
      const status = code === 'ETOOBIG' ? 413 : code === 'EBADJSON' ? 400 : 500;
      fail(res, status, code || 'EINTERNAL', String(e && e.message || e));
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('405'); return; }
  serveStatic(res, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
});

server.listen(PORT, HOST, () => {
  console.log(`[store] listening on ${HOST}:${PORT}  api=${API_BASE}  gateway=${GATEWAY}  sdk=${rx && rx.enabled ? 'on' : 'off'}`);
});

process.on('SIGTERM', () => {
  try { server.close(); } catch { /* 忽略 */ }
  process.exit(0);
});
