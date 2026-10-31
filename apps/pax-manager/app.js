'use strict';

/**
 * PaX 包管理器（原生应用）
 *
 * ── 它是谁 ───────────────────────────────────────────────────────
 * RunX 的 PaX 是内核里的包管理扩展（.js/@runx-pax）：装包、解包、落盘、
 * 更新、卸载 —— 全都是特权操作。它一直只有 API，没有界面。
 *
 * 这个应用就是那个 API 的图形外壳。页面上看到的每一个按钮，背后都是
 * 一次内核调用；**这个进程自己一行文件系统写操作都没有**。
 *
 * ── 为什么要有界面，而不是让人敲 curl ─────────────────────────────
 * 装包这件事的参数组合很啰嗦：source 类型（远程 tarball / 本地目录 /
 * 本地 tarball）、url、subdir（包内哪个目录是应用本体）。搞错一个
 * subdir，内核就报「包里找不到应用」。让用户在终端里手拼这些参数，
 * 等于把内核的实现细节暴露给每一个用户。
 *
 * 界面把这件事收拢成：填一个地址 → 内核自己探测包内结构 → 装上。
 *
 * ── 与「应用商店」的区别 ─────────────────────────────────────────
 *   商店 (apps/store)     —— 面向普通用户：浏览线上目录、点一下就装
 *   本应用 (pax-manager)  —— 面向本机运维：看装了什么、装本地的包、
 *                            更新已有应用、卸载不要的应用
 * 两者调的是同一套内核 API，区别只在「包从哪来」和「给谁看」。
 *
 * ── 权限 ────────────────────────────────────────────────────────
 * 只读：fs.read:../**（看 apps/ 下的清单，列出本机装了哪些）。
 * 安装/卸载/更新全部交给内核 —— 那个进程有真正的写权限，本进程没有，
 * 也不需要。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

let rx = null;
try { rx = require('@runx/sdk'); } catch (e) { rx = null; }

const PORT = Number(process.env.PORT) || 3482;
const HOST = process.env.PAXMGR_HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const DATA = process.env.RUNX_APP_DATA || path.join(__dirname, 'data');
const GATEWAY = process.env.RUNX_GATEWAY || 'http://127.0.0.1:3000';
const ROOT = process.env.RUNX_ROOT || path.resolve(__dirname, '../..');

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
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) {
    res.writeHead(403); res.end('403'); return;
  }
  let buf;
  try { buf = fs.readFileSync(file); } catch { res.writeHead(404); res.end('404'); return; }
  // 占位符替换：html 和 js 都要替 —— 只替 html 的话，
  // 独立的前端脚本里会留下字面量 '__GATEWAY__'，请求打到不存在的地址。
  if (/\.(html|js)$/i.test(rel)) {
    buf = Buffer.from(buf.toString('utf8')
      .replace(/__GATEWAY__/g, GATEWAY)
      .replace(/__ROOT__/g, ROOT), 'utf8');
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

/** 调内核。内核的 PaX 路由都在 /runx 前缀下。 */
async function gw(pathname, opts) {
  const o = opts || {};
  const init = { method: o.method || 'GET', headers: { accept: 'application/json' } };
  if (o.body) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(o.body);
  }
  const res = await fetch(GATEWAY + pathname, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

/**
 * 调内核的装包接口，失败时重试。
 *
 * 为什么需要重试：装包要**下载整个包**，一次网络抖动（GitHub 抽风、
 * 代理断了一下）就会让整次安装失败，用户看到的却是「安装失败」四个字。
 * 但包本身没问题，只是没传完 —— 重试一次通常就成了。
 *
 * 只重试「下载/传输」类的失败，不重试「包本身有问题」的失败：
 * 后者（包格式不对、找不到应用）重试多少次都是一样的错。
 */
async function gwInstall(pathname, payload, attempts) {
  const tries = attempts === undefined ? 3 : attempts;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await gw(pathname, { method: 'POST', body: payload });
      const d = r.data || {};
      const failed = r.status !== 200 || !!d.error;
      if (!failed) return r;
      lastErr = errOf(d);
      // 内核明确说了「包不对」→ 重试无意义，直接返回
      const permanent = ['EINVAL', 'EBADPKG', 'ENOAPP', 'EBADARCHIVE', 'EUNSAFEPATH'].indexOf(lastErr.code) >= 0;
      if (permanent) return r;
    } catch (e) {
      lastErr = { code: 'EGATEWAY', message: String(e && e.message || e) };
    }
    if (i < tries - 1) {
      // 退避：1s、2s
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return { status: 502, data: { error: { code: lastErr.code, message: lastErr.message } } };
}

/**
 * 内核的报错有两种形状：
 *   1) { error: { code, message } }   —— PaX 扩展的错误
 *   2) { error: { message } }          —— 内核统一的错误信封
 * 两种都要能读出「给人看的话」。
 */
function errOf(d) {
  if (!d) return { code: 'EUNKNOWN', message: '未知错误' };
  const e = d.error;
  if (!e) return { code: 'EUNKNOWN', message: '未知错误' };
  return { code: e.code || 'EUNKNOWN', message: e.message || String(e) };
}

/* ── 本机应用目录 ───────────────────────────────────────────────── */

/**
 * 列出 apps/ 下的应用目录。
 *
 * 内核的 /runx/apps 只给**已登记**的应用 —— 也就是被 start.sh 扫过、
 * 或通过 PaX 装过的。磁盘上可能有「目录在、但清单没登记」的半成品
 * （手工拷进去的、装到一半失败的），那才是运维真正要看见的东西。
 * 所以这里两边都读：内核的给运行状态，磁盘的给完整视图。
 */
function scanDisk() {
  const appsDir = path.join(ROOT, 'apps');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(appsDir); } catch { return out; }
  for (const n of names) {
    const dir = path.join(appsDir, n);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    if (n.startsWith('.')) continue;
    const item = { name: n, dir, has_appex: false, has_meta: false, errors: [] };
    const appexPath = path.join(dir, 'appex.json');
    if (fs.existsSync(appexPath)) {
      item.has_appex = true;
      try {
        const appex = JSON.parse(fs.readFileSync(appexPath, 'utf8'));
        item.appex = appex;
        item.display_name = appex.display_name || appex.name || n;
        item.version = appex.version || '';
        item.description = appex.description || '';
        item.permissions = Array.isArray(appex.permissions) ? appex.permissions : [];
        item.port = Number(appex.port) || 0;
      } catch (e) { item.errors.push('appex.json 解析失败：' + e.message); }
    } else {
      item.errors.push('没有 appex.json —— 这不是一个完整的应用');
    }
    const metaPath = path.join(dir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      item.has_meta = true;
      try { item.meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
      catch (e) { item.errors.push('meta.json 解析失败：' + e.message); }
    }
    try {
      const st = fs.statSync(dir);
      item.mtime = st.mtimeMs;
      item.size = dirSize(dir);
    } catch { /* 忽略 */ }
    out.push(item);
  }
  return out;
}

/** 目录占用大小（跳过 data/ 等运行时目录 —— 它们不是包的一部分） */
function dirSize(dir, depth) {
  const d = depth || 0;
  if (d > 6) return 0;
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.name === 'data' || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p, d + 1);
    else {
      try { total += fs.statSync(p).size; } catch { /* 忽略 */ }
    }
  }
  return total;
}

/* ── 路由 ───────────────────────────────────────────────────────── */

async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/config' && req.method === 'GET') {
    return json(res, 200, {
      ok: true, gateway: GATEWAY, root: ROOT,
      sdk: !!(rx && rx.enabled),
    });
  }

  /* 应用列表：内核的运行状态 + 磁盘的真实目录 */
  if (p === '/api/apps' && req.method === 'GET') {
    let runtime = [];
    let kernelError = null;
    try {
      const r = await gw('/runx/apps');
      if (r.status === 200 && r.data && Array.isArray(r.data.apps)) runtime = r.data.apps;
      else kernelError = errOf(r.data);
    } catch (e) {
      kernelError = { code: 'EGATEWAY', message: String(e && e.message || e) };
    }
    const byName = new Map(runtime.map((a) => [a.name, a]));
    const disk = scanDisk();

    // 合并：磁盘为准（它一定是最新的），内核补上运行状态
    const merged = disk.map((d) => {
      const k = byName.get(d.name);
      byName.delete(d.name);
      return Object.assign({}, d, {
        registered: !!k,
        state: (k && k.status && k.status.state) || 'stopped',
        pid: (k && k.status && k.status.pid) || null,
        started_at: (k && k.status && k.status.started_at) || null,
        restart_count: (k && k.status && k.status.restart_count) || 0,
        fence: (k && k.status && k.status.fence) || null,
      });
    });
    // 内核里有、磁盘上扫不到的（理论上不该有，但别藏起来）
    for (const k of byName.values()) {
      merged.push({
        name: k.name, dir: '', registered: true, has_appex: false, has_meta: false,
        display_name: k.display_name || k.name, version: k.version || '',
        description: k.description || '', permissions: k.permissions || [],
        port: k.port || 0,
        state: (k.status && k.status.state) || 'stopped',
        pid: (k.status && k.status.pid) || null,
        errors: ['内核已登记，但磁盘上找不到目录'],
      });
    }
    merged.sort((a, b) => a.name.localeCompare(b.name));
    return json(res, 200, {
      ok: true, apps: merged, root: ROOT,
      kernel_error: kernelError,
    });
  }

  /* 单个应用的详情 */
  if (p === '/api/app' && req.method === 'GET') {
    const name = String(url.searchParams.get('name') || '');
    if (!/^[a-z0-9._-]+$/i.test(name)) return fail(res, 400, 'EBADAPP', '应用名不对');
    const dir = path.join(ROOT, 'apps', name);
    if (!fs.existsSync(dir)) return fail(res, 404, 'ENOENT', '没有这个应用');
    const one = scanDisk().find((d) => d.name === name);
    if (!one) return fail(res, 404, 'ENOENT', '没有这个应用');

    // 内核那边问两件事：应用登记了没有（registered）、现在跑没跑（status）
    let registered = false;
    let status = null;
    try {
      const r = await gw('/runx/apps/' + encodeURIComponent(name));
      if (r.status === 200) {
        registered = true;
        status = r.data.status || null;
      }
    } catch { /* 状态拿不到不影响看清单 */ }

    return json(res, 200, {
      ok: true,
      app: Object.assign({}, one, {
        registered,
        status,
        state: (status && status.state) || 'stopped',
        pid: (status && status.pid) || null,
      }),
    });
  }

  /* 安装：把「装哪个」翻译成内核 PaX 听得懂的话 */
  if (p === '/api/install' && req.method === 'POST') {
    const b = await readJson(req);
    const url2 = String(b.url || '').trim();
    const subdir = String(b.subdir || '').trim();
    const localPath = String(b.path || '').trim();

    let payload = null;
    if (url2) {
      if (!/^https?:\/\//i.test(url2)) return fail(res, 400, 'EBADURL', '地址必须是 http/https');
      payload = { source: 'remote', url: url2 };
    } else if (localPath) {
      // 本地目录 / tarball —— 必须是绝对路径，且不能有 ../ 往外跑
      if (!path.isAbsolute(localPath)) return fail(res, 400, 'EBADPATH', '本地路径要写成绝对路径');
      const norm = path.resolve(localPath);
      if (norm.split(path.sep).includes('..')) return fail(res, 400, 'EBADPATH', '路径里不能有 ..');
      payload = /\.(tar|gz|tgz)$/i.test(norm)
        ? { source: 'local', path: norm }
        : { source: 'local', path: norm };
    } else {
      return fail(res, 400, 'ENOSOURCE', '给一个下载地址，或者一个本地路径');
    }
    if (subdir) payload.subdir = subdir;

    try {
      const r = await gwInstall('/runx/apps/install', payload);
      const d = r.data || {};
      if (r.status !== 200 || d.error) {
        const em = errOf(d);
        return fail(res, 422, em.code, em.message, { detail: d });
      }
      return json(res, 200, {
        ok: true,
        installed: { name: d.name, version: d.version },
        bytes: d.bytes || 0,
      });
    } catch (e) {
      return fail(res, 502, 'EGATEWAY', '内核没响应：' + String(e && e.message || e));
    }
  }

  /* 更新：内核会先停进程、装新版本、再对齐 */
  if (p === '/api/update' && req.method === 'POST') {
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    if (!/^[a-z0-9._-]+$/i.test(name)) return fail(res, 400, 'EBADAPP', '应用名不对');
    const url2 = String(b.url || '').trim();
    const localPath = String(b.path || '').trim();
    let payload;
    if (url2) {
      if (!/^https?:\/\//i.test(url2)) return fail(res, 400, 'EBADURL', '地址必须是 http/https');
      payload = { source: 'remote', url: url2 };
    } else if (localPath) {
      if (!path.isAbsolute(localPath)) return fail(res, 400, 'EBADPATH', '本地路径要写成绝对路径');
      payload = { source: 'local', path: path.resolve(localPath) };
    } else {
      return fail(res, 400, 'ENOSOURCE', '更新要指定新的包地址或本地路径');
    }
    const subdir = String(b.subdir || '').trim();
    if (subdir) payload.subdir = subdir;

    try {
      const r = await gwInstall('/runx/apps/' + encodeURIComponent(name) + '/update', payload);
      const d = r.data || {};
      if (r.status !== 200 || d.error) {
        const em = errOf(d);
        return fail(res, 422, em.code, em.message, { detail: d });
      }
      return json(res, 200, { ok: true, updated: { name: d.name, version: d.version } });
    } catch (e) {
      return fail(res, 502, 'EGATEWAY', '内核没响应：' + String(e && e.message || e));
    }
  }

  /* 卸载 */
  if (p === '/api/uninstall' && req.method === 'POST') {
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    if (!/^[a-z0-9._-]+$/i.test(name)) return fail(res, 400, 'EBADAPP', '应用名不对');
    try {
      const r = await gw('/runx/apps/' + encodeURIComponent(name), { method: 'DELETE' });
      const d = r.data || {};
      if (r.status !== 200 || d.error) {
        const em = errOf(d);
        return fail(res, 422, em.code, em.message, { detail: d });
      }
      return json(res, 200, { ok: true, uninstalled: name });
    } catch (e) {
      return fail(res, 502, 'EGATEWAY', '内核没响应：' + String(e && e.message || e));
    }
  }

  /* 启停：包管理顺手能管进程，不用去翻日志 */
  if (p === '/api/lifecycle' && req.method === 'POST') {
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    const action = String(b.action || '').trim();
    if (!/^[a-z0-9._-]+$/i.test(name)) return fail(res, 400, 'EBADAPP', '应用名不对');
    if (['start', 'stop', 'restart'].indexOf(action) < 0) {
      return fail(res, 400, 'EBADACTION', '动作只能是 start / stop / restart');
    }
    try {
      const r = await gw('/runx/apps/' + encodeURIComponent(name) + '/' + action, { method: 'POST' });
      const d = r.data || {};
      if (r.status !== 200 || d.error) {
        const em = errOf(d);
        return fail(res, 422, em.code, em.message, { detail: d });
      }
      return json(res, 200, { ok: true, action, name });
    } catch (e) {
      return fail(res, 502, 'EGATEWAY', '内核没响应：' + String(e && e.message || e));
    }
  }

  /* 应用日志 */
  if (p === '/api/logs' && req.method === 'GET') {
    const name = String(url.searchParams.get('name') || '');
    if (!/^[a-z0-9._-]+$/i.test(name)) return fail(res, 400, 'EBADAPP', '应用名不对');
    const lines = Math.max(1, Math.min(500, Number(url.searchParams.get('lines')) || 100));
    try {
      const r = await gw('/runx/apps/' + encodeURIComponent(name) + '/logs?lines=' + lines);
      if (r.status !== 200) {
        const em = errOf(r.data);
        return fail(res, r.status || 500, em.code, em.message);
      }
      return json(res, 200, { ok: true, logs: r.data });
    } catch (e) {
      return fail(res, 502, 'EGATEWAY', '内核没响应：' + String(e && e.message || e));
    }
  }

  return fail(res, 404, 'ENOENT', '没有这个接口');
}

/* ── 服务器 ─────────────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (url.pathname === '/healthz') {
    return json(res, 200, {
      ok: true, app: 'pax-manager', node: process.version,
      sdk: !!(rx && rx.enabled), root: ROOT, gateway: GATEWAY,
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
  console.log(`[pax-manager] listening on ${HOST}:${PORT}  root=${ROOT}  gateway=${GATEWAY}`);
});

process.on('SIGTERM', () => {
  try { server.close(); } catch { /* 忽略 */ }
  process.exit(0);
});
