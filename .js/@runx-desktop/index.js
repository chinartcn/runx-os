'use strict';

/**
 * @runx-desktop —— RunX 桌面外壳核心扩展（文档 §6 / §9）
 *
 * 服务端：维护 desktop.json（真相源，原子写），提供桌面布局 REST（/runx/desktop*）。
 * 客户端：注入可拖拽 / 缩放 / 最小化的窗口管理器 + 任务栏 + 图标网格（client.js）。
 *
 * REST 走 /runx 前缀（NavExt 内核自留 /api/*）。
 *
 * ── 前端资源为什么要经 onRequest 自己发（而不是丢进 js.json.styles）──
 * 内核的注入把 styles / scripts 一律作为「文本」内联进 HTML，扩展目录又位于
 * `.js/`（以点开头 → 静态路由一律拒绝）。于是 CSS 里的 url() 引用（Inter 字体、
 * 品牌图标）没有可达的地址。这里注册一条 /runx/desktop-assets/*：
 *   · 目录穿越被 fsResolveUnder 兜住；
 *   · 白名单扩展名 + 正确 MIME（woff2 必须有，否则字体静默失效）；
 *   · ETag/If-None-Match 304，字体与 CSS 只传一次（手机流量友好）。
 */

const API = '/runx';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ASSETS_PREFIX = API + '/desktop-assets/';

/** 白名单：只发前端资源，避免把扩展目录变成可浏览的文件系统 */
const ASSET_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.json': 'application/json; charset=utf-8',
};

let S = null;

const ICON_FIELDS = ['x', 'y', 'label'];
const WIDGET_FIELDS = ['x', 'y', 'w', 'h', 'config'];
const TASKBAR_POSITIONS = ['top', 'bottom', 'left', 'right'];
const THEMES = ['light', 'dark', 'auto'];

function newId() { return (crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(16).slice(2)).slice(0, 26); }
function json(status, obj) {
  return { status, type: 'application/json; charset=utf-8', body: JSON.stringify(obj) };
}
function err(code, message, data) {
  return { status: code, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: { code, message, data } }) };
}
/**
 * 把 CSS 里的相对 url() 改成绝对前缀。
 *
 * 两个坑叠在一起，所以必须显式传 cssRel：
 *   1. 内核把扩展的 styles 内联进 HTML，url("fonts/x.woff2") 的解析基准变成
 *      **页面地址**（站点根），而不是扩展目录 —— 字体必然 404；
 *   2. CSS 里的相对地址按 **CSS 文件自身所在目录** 解析。tokens.css 位于
 *      assets/，它写的 "fonts/x.woff2" 实际指向 assets/fonts/x.woff2。
 * 所以要按 cssRel 的目录名拼前缀，不能一律当成扩展根。
 *
 * 只处理相对路径；data: / http(s) / 协议相对 / 绝对路径 原样保留。
 *
 * @param {string} css      CSS 文本
 * @param {string} [cssRel] CSS 文件相对扩展目录的路径（用于算基准目录）
 */
function rewriteCssUrls(css, cssRel) {
  const dir = cssRel ? path.posix.dirname(String(cssRel).replace(/\\/g, '/')) : '';
  const base = (dir && dir !== '.') ? dir.replace(/^\/+|\/+$/g, '') + '/' : '';
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, quote, ref) => {
    const v = ref.trim();
    if (!v) return whole;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|data:)/i.test(v)) return whole;
    const rel = base + v.replace(/^\.\//, '');
    return 'url("' + ASSETS_PREFIX + rel + '")';
  });
}

function defaultDesktop() {
  return {
    schema: 1, updated_at: Date.now(),
    wallpaper: { type: 'builtin', id: 'aurora' },
    theme: 'auto',
    grid: { cell: 96, gap: 8 },
    icons: [], widgets: [],
    taskbar: { position: 'bottom', pinned: [], show_clock: true },
  };
}
function nextFreeCell(d) {
  const occ = new Set();
  (d.icons || []).forEach((i) => occ.add(i.x + ',' + i.y));
  (d.widgets || []).forEach((w) => {
    for (let yy = w.y; yy < w.y + (w.h || 1); yy++)
      for (let xx = w.x; xx < w.x + (w.w || 1); xx++) occ.add(xx + ',' + yy);
  });
  for (let y = 0; y < 30; y++)
    for (let x = 0; x < 40; x++)
      if (!occ.has(x + ',' + y)) return { x, y };
  return { x: 0, y: 0 };
}

module.exports = {

  /**
   * 内联样式：直接导出内容而不是让 js.json 读文件。
   *
   * 为什么要绕这一下：内核把 styles 内联进 HTML 的 <style>，此时 CSS 里的
   * url("fonts/x.woff2") 按**页面地址**解析（站点根），扩展目录在 .js/ 下
   * 又被静态路由拒绝 → 字体必然 404。这里在导出前把相对 url() 改写成
   * /runx/desktop-assets/ 绝对前缀，注入后即可正常取到字体。
   */
  get styles() {
    const read = (rel) => {
      try { return rewriteCssUrls(fs.readFileSync(path.join(__dirname, rel), 'utf8'), rel); }
      catch { return ''; }
    };
    // tokens.css 必须排在前面：styles.css 全程消费它的变量
    return [read('assets/tokens.css'), read('styles.css')].filter(Boolean);
  },

  onInit(ctx) {
    const os = ctx.os;
    const extDir = ctx.extDir;

    function load() {
      const d = os.readState('desktop.json', null);
      return (d && d.schema === 1) ? d : defaultDesktop();
    }
    function save(d) {
      d.updated_at = Date.now();
      os.writeState('desktop.json', d);
      return d;
    }
    function findIcon(d, id) { return (d.icons || []).find((i) => i.id === id); }
    function findWidget(d, id) { return (d.widgets || []).find((w) => w.id === id); }

    function addIcon(body) {
      const d = load();
      if (!body || !body.app) throw new Error('缺少 app');
      const cell = body.x != null && body.y != null ? { x: body.x, y: body.y } : nextFreeCell(d);
      const icon = { id: newId(), app: body.app, x: cell.x, y: cell.y, label: body.label || null };
      d.icons = d.icons || [];
      d.icons.push(icon);
      save(d);
      return icon;
    }
    function patchIcon(id, body) {
      const d = load();
      const icon = findIcon(d, id);
      if (!icon) throw Object.assign(new Error('图标不存在'), { code: 404 });
      for (const k of ICON_FIELDS) if (body[k] != null) icon[k] = body[k];
      save(d);
      return icon;
    }
    function delIcon(id) {
      const d = load();
      d.icons = (d.icons || []).filter((i) => i.id !== id);
      save(d);
      return { ok: true };
    }
    function addWidget(body) {
      const d = load();
      const w = {
        id: newId(), app: body.app, x: body.x || 0, y: body.y || 0,
        w: body.w || 2, h: body.h || 1, config: body.config || null,
      };
      d.widgets = d.widgets || [];
      d.widgets.push(w);
      save(d);
      return w;
    }
    function patchWidget(id, body) {
      const d = load();
      const w = findWidget(d, id);
      if (!w) throw Object.assign(new Error('Widget 不存在'), { code: 404 });
      for (const k of WIDGET_FIELDS) if (body[k] != null) w[k] = body[k];
      save(d);
      return w;
    }
    function delWidget(id) {
      const d = load();
      d.widgets = (d.widgets || []).filter((w) => w.id !== id);
      save(d);
      return { ok: true };
    }
    function setWallpaper(body) {
      const d = load();
      if (!body || !body.type || !['builtin', 'file', 'url'].includes(body.type)) throw new Error('wallpaper.type 非法');
      d.wallpaper = { type: body.type, id: body.id, path: body.path, url: body.url };
      save(d);
      return d.wallpaper;
    }
    function setTheme(body) {
      const d = load();
      if (!body || !THEMES.includes(body.theme)) throw new Error('theme 必须是 light/dark/auto');
      d.theme = body.theme;
      save(d);
      return { theme: d.theme };
    }
    function setTaskbar(body) {
      const d = load();
      const tb = d.taskbar || { position: 'bottom', pinned: [], show_clock: true };
      if (body.position != null) {
        if (!TASKBAR_POSITIONS.includes(body.position)) throw new Error('taskbar.position 非法');
        tb.position = body.position;
      }
      if (Array.isArray(body.pinned)) tb.pinned = body.pinned;
      if (typeof body.show_clock === 'boolean') tb.show_clock = body.show_clock;
      d.taskbar = tb;
      save(d);
      return d.taskbar;
    }
    /** 网格尺寸：cell 是单元格边长，gap 是单元格间距（两者之和＝步长） */
    function setGrid(body) {
      const d = load();
      const g = d.grid || { cell: 96, gap: 8 };
      const clampNum = (v, min, max, dflt) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
      };
      if (body.cell != null) g.cell = clampNum(body.cell, 48, 240, 96);
      if (body.gap != null) g.gap = clampNum(body.gap, 0, 64, 8);
      d.grid = g;
      save(d);
      return d.grid;
    }

    /* 桌面自述信息：客户端据此拼资源地址与版本（便于以后做热重载/灰度） */
    function meta() {
      const pkgVersion = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(extDir, 'mod.json'), 'utf8')).version || ''; }
        catch { return ''; }
      })();
      return {
        assets_base: ASSETS_PREFIX,
        version: pkgVersion,
        // 客户端能力位：UI 层据此决定是否渲染扩展面板（现在只有基础外壳）
        capabilities: ['windows.drag', 'windows.resize', 'windows.fullscreen', 'menubar', 'toolbar'],
      };
    }

    S = {
      json, err, load, save, addIcon, patchIcon, delIcon,
      addWidget, patchWidget, delWidget, setWallpaper, setTheme, setTaskbar, setGrid, meta,
    };

    /* ── 前端资源：把扩展目录里白名单内的文件按正确 MIME 发出去 ──
       路径解析交给 ctx.fs.path()（内核已做越界 + 软链校验），这里只管 MIME 与缓存。 */
    function serveAsset(relRaw, reqEth) {
      const rel = String(relRaw || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel || rel.includes('\0')) return assetText(404, '找不到该资源');

      const dot = rel.lastIndexOf('.');
      const type = dot < 0 ? null : ASSET_MIME[rel.slice(dot).toLowerCase()];
      if (!type) return assetText(404, '不支持的类型');

      let full;
      try { full = ctx.fs.path(rel); }
      catch (e) { return assetText(403, '禁止访问'); }

      let st;
      try { st = fs.statSync(full); } catch { return assetText(404, '找不到该资源'); }
      if (!st.isFile()) return assetText(404, '不是文件');

      // ETag 用 mtime+size：内容改动即失效，不必额外记账
      const etag = '"' + st.mtimeMs.toString(36) + '-' + st.size.toString(36) + '"';
      const headers = {
        'Content-Type': type,
        'ETag': etag,
        // 资源本身用 ETag 协商，禁止启发式缓存，避免改样式后手机上看到旧的
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      };
      if (reqEth && reqEth === etag) return { status: 304, headers, body: '' };

      return { status: 200, headers, body: fs.readFileSync(full) };
    }

    function assetText(status, text) {
      return { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text };
    }

    S.serveAsset = serveAsset;
  },

  onRequest(req, url, ctx) {
    const p = url.pathname;
    if (!p.startsWith(API)) return undefined;   // 其它 /runx/* 交给兄弟扩展
    if (!S) return undefined;
    const q = (k) => url.searchParams.get(k);

    /* 前端资源：/runx/desktop-assets/<相对扩展目录的路径> */
    if (p.startsWith(ASSETS_PREFIX)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return { status: 405, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' }, body: '405' };
      }
      const rel = decodeURIComponent(p.slice(ASSETS_PREFIX.length));
      const r = S.serveAsset(rel, req.headers['if-none-match']);
      // CSS 里的 url() 是相对扩展目录写的，但内核把 CSS 内联进 HTML，
      // 相对路径会解析成站点根 → 字体必然 404。服务时统一改写成绝对前缀。
      if (r.status === 200 && typeof r.body === 'string' && /\.css$/i.test(rel)) {
        return Object.assign({}, r, { body: rewriteCssUrls(r.body, rel) });
      }
      return r;
    }

    if (req.method === 'GET' && p === API + '/desktop') {
      // 把自述信息一并带回：客户端不需要额外一次请求
      return S.json(200, Object.assign({}, S.load(), { meta: S.meta() }));
    }
    if (req.method === 'GET' && p === API + '/desktop/meta') return S.json(200, S.meta());

    if (req.method === 'POST' && p === API + '/desktop/icons') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        try { return S.json(200, S.addIcon(b)); } catch (e) { return S.err(422, e.message); }
      });
    }
    if (req.method === 'PATCH' && p.startsWith(API + '/desktop/icons/')) {
      const id = decodeURIComponent(p.slice((API + '/desktop/icons/').length));
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        try { return S.json(200, S.patchIcon(id, b)); } catch (e) { return S.err(e.code === 404 ? 404 : 422, e.message); }
      });
    }
    if (req.method === 'DELETE' && p.startsWith(API + '/desktop/icons/')) {
      const id = decodeURIComponent(p.slice((API + '/desktop/icons/').length));
      try { return S.json(200, S.delIcon(id)); } catch (e) { return S.err(404, e.message); }
    }

    if (req.method === 'POST' && p === API + '/desktop/widgets') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        try { return S.json(200, S.addWidget(b)); } catch (e) { return S.err(422, e.message); }
      });
    }
    if (req.method === 'PATCH' && p.startsWith(API + '/desktop/widgets/')) {
      const id = decodeURIComponent(p.slice((API + '/desktop/widgets/').length));
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        try { return S.json(200, S.patchWidget(id, b)); } catch (e) { return S.err(e.code === 404 ? 404 : 422, e.message); }
      });
    }
    if (req.method === 'DELETE' && p.startsWith(API + '/desktop/widgets/')) {
      const id = decodeURIComponent(p.slice((API + '/desktop/widgets/').length));
      try { return S.json(200, S.delWidget(id)); } catch (e) { return S.err(404, e.message); }
    }

    if (req.method === 'PUT' && p === API + '/desktop/wallpaper') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        try { return S.json(200, S.setWallpaper(b)); } catch (e) { return S.err(422, e.message); }
      });
    }
    if (req.method === 'PUT' && p === API + '/desktop/theme') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        try { return S.json(200, S.setTheme(b)); } catch (e) { return S.err(422, e.message); }
      });
    }
    if (req.method === 'PUT' && p === API + '/desktop/taskbar') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        try { return S.json(200, S.setTaskbar(b)); } catch (e) { return S.err(422, e.message); }
      });
    }
    if (req.method === 'PUT' && p === API + '/desktop/grid') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        try { return S.json(200, S.setGrid(b)); } catch (e) { return S.err(422, e.message); }
      });
    }

    return undefined;
  },
};
