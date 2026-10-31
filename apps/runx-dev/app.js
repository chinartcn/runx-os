'use strict';

/**
 * RunX Dev —— 开发者服务应用
 *
 * ── 它是谁 ───────────────────────────────────────────────────────
 * 开发者有两件反复要干的事：
 *   1. **管自己的包**：本地有哪些应用、清单对不对、装没装上、怎么更新。
 *   2. **上架**：把应用同步到商店，让别人能装。
 *
 * 这两件事以前都得手工：改 JSON、curl 商店 API、算 SHA、手动填表。
 * 这个应用把它们收进一个窗口。
 *
 * ── 三块能力 ────────────────────────────────────────────────────
 *   A. 包管理器   扫描本机应用 → 读 appex.json / meta.json → 校验 →
 *                 安装 / 更新 / 卸载（走内核 PaX）
 *   B. 清单生成   从 appex.json 生成商店用的 meta.json，
 *                 自动算 SHA256（包哈希 + meta 自身哈希）
 *   C. 上架助手   登录开发者账号 → 把 meta.json 同步到商店 → 看自己的应用
 *
 * ── 为什么要单独一个应用，而不是塞进商店里 ───────────────────────
 * 商店是给**用户**用的（浏览、安装）；这个是给**开发者**用的（管包、上架）。
 * 混在一起：开发者要登录才能进商店面板，而普通用户只想看列表。
 * 分开之后，商店那侧一行代码都不用管账号，开发者这边也不用迁就用户的界面。
 *
 * ── 权限 ────────────────────────────────────────────────────────
 * 它要读本机应用目录（fs.read）、写自己的 data（fs.write）、
 * 起子进程（跑 pnpm / 打包）。声明出来的每一项都会在安装时弹审批。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

let rx = null;
try { rx = require('@runx/sdk'); } catch (e) { rx = null; }

const PORT = Number(process.env.PORT) || 3481;
const HOST = process.env.RUNXDEV_HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const DATA = process.env.RUNX_APP_DATA || path.join(__dirname, 'data');
const GATEWAY = process.env.RUNX_GATEWAY || 'http://127.0.0.1:3000';
const ROOT = process.env.RUNX_ROOT || path.resolve(__dirname, '../..');

const API_BASE = (process.env.STORE_API_BASE || 'https://api.rtcnnavext.de5.net').replace(/\/+$/, '');

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
  // 占位符替换：html 和 js 都要替。
  // API_BASE / ROOT 定义在 dev.js 里（前端脚本是独立文件），
  // 只替 index.html 的话它们会原样留在脚本里 —— 请求打到
  // '__API_BASE__/api/...'，报 404，看着像「商店连不上」。
  if (/\.(html|js)$/i.test(rel)) {
    buf = Buffer.from(buf.toString('utf8')
      .replace(/__API_BASE__/g, API_BASE)
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

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch { return ''; }
}

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

/* ── 包管理器：扫描本机应用 ────────────────────────────────────── */

/**
 * 校验一份 meta.json —— 商店的 parseMeta 认哪些字段，这里就查哪些。
 *
 * 为什么要自己再校验一遍：商店的报错是「HTTP 502 拉取失败」或者
 * 「slug 非法」，都不告诉你**哪个字段**不对。开发者在本地跑一次校验，
 * 就能立刻看到「version 缺失」「permissions 不是数组」。
 */
function validateMeta(meta) {
  const problems = [];
  const warnings = [];

  if (!meta || typeof meta !== 'object') {
    return { ok: false, problems: ['不是一个 JSON 对象'], warnings };
  }
  const name = meta.name || meta.slug;
  if (!name) problems.push('缺 name（或 slug）—— 商店靠它认这个应用');
  else if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(name))) {
    problems.push('name 只能用字母、数字、点、下划线、连字符');
  }
  if (!meta.version) problems.push('缺 version');
  if (meta.permissions != null && !Array.isArray(meta.permissions)) {
    problems.push('permissions 必须是数组（能力字符串，如 "fs.read:./**"）');
  }
  if (meta.permissions && Array.isArray(meta.permissions)) {
    const bad = meta.permissions.filter((p) => typeof p !== 'string' || !/^[a-z]+\.[a-z]+(:.*)?$/.test(String(p).trim()));
    if (bad.length) problems.push('permissions 里有格式不对的项：' + bad.join('、'));
  }
  const src = meta.source || {};
  if (!src.download && !meta.download_url) {
    problems.push('缺 source.download —— 用户要能从这里下载到包');
  }
  if (!src.type) warnings.push('没写 source.type，商店会猜一个');
  if (!meta.summary && !meta.description) warnings.push('没有简介，商店列表里会显示成空白');
  if (!meta.icon && !meta.icon_url) warnings.push('没有图标');
  if (!src.subdir && !meta.subdir) {
    warnings.push('没写 source.subdir —— 如果包里不止一个应用，内核会要求你指定');
  }
  if (!meta.sha256) {
    warnings.push('没有 sha256 —— 用户下载后无法校验包的完整性（商店会自动用 meta 自身的哈希兜底）');
  }
  return { ok: !problems.length, problems, warnings };
}

/** 从 appex.json 生成一份商店用的 meta.json */
function genMetaFromAppex(appex, extra) {
  const src = appex.source || {};
  const meta = {
    schema: 1,
    name: appex.name,
    display_name: appex.display_name || appex.name,
    version: appex.version || '0.0.0',
    summary: (appex.description || '').split('\n')[0].slice(0, 120),
    description: appex.description || '',
    category: (extra && extra.category) || 'other',
    author: (extra && extra.author) || '',
    homepage: (extra && extra.homepage) || '',
    repo: (extra && extra.repo) || src.url || '',
    license: (extra && extra.license) || 'MIT',
    icon: (extra && extra.icon) || appex.icon || '',
    permissions: Array.isArray(appex.permissions) ? appex.permissions : [],
    source: {
      type: src.type || (extra && extra.source_type) || 'github',
      url: src.url || (extra && extra.repo) || '',
      download: src.download || (extra && extra.download) || '',
    },
  };
  if (src.subdir || (extra && extra.subdir)) {
    meta.source.subdir = src.subdir || extra.subdir;
  }
  return meta;
}

/**
 * 扫本机 apps/ 目录，把每个应用的清单读出来。
 *
 * 运行状态（装没装、跑没跑、端口多少）从**内核**问，不从文件读：
 * var/runx/apps.json 在围栏之外（应用的读权限只覆盖 apps/），而且文件是
 * 静态的 —— 内核那边才是真状态（进程刚起、刚停、重启预算都用它的）。
 */
function scanLocalApps(runtime) {
  const appsDir = path.join(ROOT, 'apps');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(appsDir); } catch { return out; }
  for (const n of names) {
    const dir = path.join(appsDir, n);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    const entry = { name: n, dir, has_appex: false, has_meta: false, meta: null, errors: [] };
    const appexPath = path.join(dir, 'appex.json');
    if (fs.existsSync(appexPath)) {
      entry.has_appex = true;
      try { entry.appex = JSON.parse(fs.readFileSync(appexPath, 'utf8')); }
      catch (e) { entry.errors.push('appex.json 解析失败：' + e.message); }
    }
    const metaPath = path.join(dir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      entry.has_meta = true;
      try { entry.meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
      catch (e) { entry.errors.push('meta.json 解析失败：' + e.message); }
      try {
        entry.meta_sha256 = sha256File(metaPath);
      } catch { /* 忽略 */ }
      const v = validateMeta(entry.meta);
      entry.validate = v;
    }
    // 应用是否在运行 —— 问内核
    const rec = (runtime || []).find((a) => a.name === n);
    if (rec) {
      entry.installed = true;
      entry.state = (rec.status && rec.status.state) || 'unknown';
      entry.port = rec.port || 0;
      entry.pid = (rec.status && rec.status.pid) || null;
      // fence 有三态：true=围栏开着，false=明确没围栏，null=没运行所以无从说起
      const fence = rec.status && rec.status.fence;
      entry.fenced = fence ? fence.applied !== false : null;
      if (fence && fence.reason) entry.fence_reason = fence.reason;
    }
    out.push(entry);
  }
  return out;
}

/* ── 路由 ───────────────────────────────────────────────────────── */

async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/config' && req.method === 'GET') {
    return json(res, 200, {
      ok: true, api_base: API_BASE, gateway: GATEWAY, root: ROOT,
      sdk: !!(rx && rx.enabled),
    });
  }

  /* 本机应用清单 */
  if (p === '/api/packages' && req.method === 'GET') {
    // 运行状态来自内核（权威、带实时进程信息），清单来自本地磁盘
    let runtime = [];
    try {
      const r = await gw('/runx/apps');
      if (r.status === 200 && r.data && Array.isArray(r.data.apps)) runtime = r.data.apps;
    } catch { /* 内核问不到就只显示磁盘上的清单 */ }
    const list = scanLocalApps(runtime);
    return json(res, 200, { ok: true, packages: list, root: ROOT });
  }

  /* 读某个应用目录里的文件（看 meta.json / appex.json 原文） */
  if (p === '/api/file' && req.method === 'GET') {
    const app = String(url.searchParams.get('app') || '');
    const file = String(url.searchParams.get('file') || '');
    if (!app || !/^[a-z0-9._-]+$/i.test(app)) return fail(res, 400, 'EBADAPP', '应用名不对');
    if (!/^[a-z0-9._-]+$/i.test(file)) return fail(res, 400, 'EBADFILE', '文件名不对');
    const full = path.join(ROOT, 'apps', app, file);
    if (!full.startsWith(path.join(ROOT, 'apps', app) + path.sep)) {
      return fail(res, 403, 'EPATH', '路径不对');
    }
    try {
      const text = fs.readFileSync(full, 'utf8');
      return json(res, 200, { ok: true, path: full, text });
    } catch (e) {
      return fail(res, 404, 'ENOENT', '读不到：' + e.message);
    }
  }

  /* 校验一份 meta.json */
  if (p === '/api/validate' && req.method === 'POST') {
    const b = await readJson(req);
    let meta = b.meta;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); }
      catch (e) { return fail(res, 400, 'EBADJSON', 'JSON 解析失败：' + e.message); }
    }
    const v = validateMeta(meta);
    return json(res, 200, { ok: true, validate: v });
  }

  /* 生成 meta.json（从 appex.json 推导） */
  if (p === '/api/gen-meta' && req.method === 'POST') {
    const b = await readJson(req);
    const app = String(b.app || '').trim();
    if (!/^[a-z0-9._-]+$/i.test(app)) return fail(res, 400, 'EBADAPP', '应用名不对');
    const dir = path.join(ROOT, 'apps', app);
    let appex = null;
    try { appex = JSON.parse(fs.readFileSync(path.join(dir, 'appex.json'), 'utf8')); }
    catch (e) { return fail(res, 404, 'ENOAPEX', '这个应用没有 appex.json：' + e.message); }
    const meta = genMetaFromAppex(appex, b.extra || {});
    // 有现成的 meta.json 就沿用它填好的字段
    const metaPath = path.join(dir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const old = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        for (const k of ['category', 'author', 'homepage', 'repo', 'license', 'icon', 'summary', 'description', 'sha256']) {
          if (old[k] && !meta[k]) meta[k] = old[k];
        }
        if (old.source) {
          meta.source = Object.assign({}, meta.source, {
            type: old.source.type || meta.source.type,
            url: old.source.url || meta.source.url,
            download: old.source.download || meta.source.download,
            subdir: old.source.subdir || meta.source.subdir,
          });
        }
      } catch { /* 旧的读不了就用生成的 */ }
    }
    const v = validateMeta(meta);
    return json(res, 200, { ok: true, meta, validate: v });
  }

  /* 写回 meta.json */
  if (p === '/api/save-meta' && req.method === 'POST') {
    const b = await readJson(req);
    const app = String(b.app || '').trim();
    if (!/^[a-z0-9._-]+$/i.test(app)) return fail(res, 400, 'EBADAPP', '应用名不对');
    const dir = path.join(ROOT, 'apps', app);
    if (!fs.existsSync(dir)) return fail(res, 404, 'ENOENT', '没有这个应用目录');
    let meta = b.meta;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); }
      catch (e) { return fail(res, 400, 'EBADJSON', 'JSON 解析失败：' + e.message); }
    }
    const v = validateMeta(meta);
    if (!v.ok) return fail(res, 422, 'EINVAL', '清单还有问题', { validate: v });
    const file = path.join(dir, 'meta.json');
    const text = JSON.stringify(meta, null, 2) + '\n';

    // 写走 SDK 的审批通道，不直接 fs.writeFileSync。
    // 为什么：进程的 Node 围栏只能给目录前缀，写 apps/<app>/meta.json
    // 这种动态路径没法预先声明；而 SDK 这条路走的是授权表 ——
    // 用户批过 fs.write:./** 就能写，用户没批就弹审批。
    if (rx && rx.enabled && rx.fs && typeof rx.fs.write === 'function') {
      try {
        await rx.fs.write(file, text, { encoding: 'utf8' });
        return json(res, 200, { ok: true, path: file, meta_sha256: sha256File(file), via: 'sdk' });
      } catch (e) {
        return fail(res, 403, 'EDENIED', '写不了：' + String(e && e.message || e));
      }
    }

    // 没有 SDK（SDK 不可用）→ 退回直写。围栏没放行时这里会失败，
    // 失败信息本身就是有用的诊断。
    try {
      fs.writeFileSync(file, text, 'utf8');
    } catch (e) {
      return fail(res, 500, 'EWRITE', '写不进去：' + e.message);
    }
    return json(res, 200, { ok: true, path: file, meta_sha256: sha256File(file) });
  }

  /* 开发者会话 */
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
    } catch (e) { console.error('[runx-dev] 会话写入失败：', e.message); }
  }

  if (p === '/api/dev/session' && req.method === 'GET') {
    return json(res, 200, { ok: true, session: readSession() });
  }
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
    const s = readSession();
    if (s && s.token) {
      try {
        await fetch(API_BASE + '/api/user/logout', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.token },
          body: JSON.stringify({}),
        });
      } catch { /* 吊销失败不影响本地清空 */ }
    }
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

  /* 上架：把本机某个应用的 meta.json 发布出去。
   *
   * 两种源：
   *   local  —— 直接把本机这份 meta.json 发上去（商店存一份副本）
   *   url    —— 给一个公网地址，商店自己去拉（开发者改了 GitHub 就重新同步）
   *
   * 走 url 的模式更符合「开发者自带干粮」：包始终在开发者那儿，
   * 商店只存元数据。走 local 则是快照 —— 改了要重新同步。
   */
  if (p === '/api/dev/publish' && req.method === 'POST') {
    const s = readSession();
    if (!s || !s.token) return fail(res, 401, 'ENOLOGIN', '先登录开发者账号');
    const b = await readJson(req);
    const app = String(b.app || '').trim();
    if (!/^[a-z0-9._-]+$/i.test(app)) return fail(res, 400, 'EBADAPP', '应用名不对');

    let metaUrl = String(b.meta_url || '').trim();
    if (!metaUrl) {
      // 没给地址 → 用本机这份，先看能不能变成一个公网可拉的地址
      return fail(res, 400, 'ENOMETAURL',
        'meta.json 需要一个公网可拉的地址 —— 商店是在云端拉它的，没有地址就发不上去');
    }
    if (!/^https?:\/\//i.test(metaUrl)) {
      return fail(res, 400, 'EBADURL', 'meta 地址必须是 http/https');
    }
    try {
      const r = await fetch(API_BASE + '/api/user/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.token },
        body: JSON.stringify({ meta_url: metaUrl }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return fail(res, r.status, d.code || 'ESYNC', d.message || '同步失败');
      return json(res, 200, { ok: true, app: d.app || null });
    } catch (e) {
      return fail(res, 502, 'ESTORE', '商店不可达：' + String(e && e.message || e));
    }
  }

  /* 打包：把应用目录打成 tar.gz（商店上传包时用得上） */
  if (p === '/api/package' && req.method === 'POST') {
    const b = await readJson(req);
    const app = String(b.app || '').trim();
    if (!/^[a-z0-9._-]+$/i.test(app)) return fail(res, 400, 'EBADAPP', '应用名不对');
    const dir = path.join(ROOT, 'apps', app);
    if (!fs.existsSync(dir)) return fail(res, 404, 'ENOENT', '没有这个应用目录');
    const out = path.join(DATA, app + '.tar.gz');
    try {
      // 自己打包而不是 spawn tar：子进程要 --allow-child-process，
      // 那等于把「能 exec 任意程序」整个交出去，不值当。
      const r = require('./tarpack').pack(dir, out, { base: app });
      return json(res, 200, {
        ok: true, path: out, bytes: r.bytes, files: r.files, dirs: r.dirs,
        sha256: sha256File(out),
      });
    } catch (e) {
      return fail(res, 500, 'EPACK', '打包失败：' + e.message);
    }
  }

  return fail(res, 404, 'ENOENT', '没有这个接口');
}

/* ── 服务器 ─────────────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (url.pathname === '/healthz') {
    return json(res, 200, {
      ok: true, app: 'runx-dev', node: process.version,
      sdk: !!(rx && rx.enabled), root: ROOT, api_base: API_BASE,
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
  console.log(`[runx-dev] listening on ${HOST}:${PORT}  root=${ROOT}  api=${API_BASE}  sdk=${rx && rx.enabled ? 'on' : 'off'}`);
});

process.on('SIGTERM', () => {
  try { server.close(); } catch { /* 忽略 */ }
  process.exit(0);
});
