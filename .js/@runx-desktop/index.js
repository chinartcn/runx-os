'use strict';

/**
 * @runx-desktop —— RunX 桌面外壳核心扩展（文档 §6 / §9）
 *
 * 服务端：维护 desktop.json（真相源，原子写），提供桌面布局 REST（/runx/desktop*）。
 * 客户端：注入可拖拽 / 缩放 / 最小化的窗口管理器 + 任务栏 + 图标网格（client.js）。
 *
 * REST 走 /runx 前缀（NavExt 内核自留 /api/*）。
 */

const API = '/runx';
const crypto = require('crypto');

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

  onInit(ctx) {
    const os = ctx.os;

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

    S = {
      json, err, load, save, addIcon, patchIcon, delIcon,
      addWidget, patchWidget, delWidget, setWallpaper, setTheme, setTaskbar,
    };
  },

  onRequest(req, url, ctx) {
    const p = url.pathname;
    if (!S) return undefined;
    const q = (k) => url.searchParams.get(k);

    if (req.method === 'GET' && p === API + '/desktop') return S.json(200, S.load());

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

    return undefined;
  },
};
