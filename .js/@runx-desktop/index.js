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

// 内核端口：从请求头取实际监听端口，避免打到同机上的另一个实例
const { gwPortOf } = require('../@runx-store/gateway');

const ASSETS_PREFIX = API + '/desktop-assets/';

/* 可选依赖：账号体系。没装 @runx-rights-manager 就是单用户，桌面照样能用。 */
let Session = null;
try { Session = require('../@runx-rights-manager/session'); } catch { Session = null; }

/**
 * 桌面的真相源文件。多用户时每个用户一份（users/<uid>/desktop.json）：
 * 布局、壁纸、图标位置都该是「我的桌面」，而不是「这台机器的桌面」。
 * 用 session 的 AsyncLocalStorage 判断当前请求是谁，所以调用点在 load()/save()
 * 内部、藏在若干次 await 之后也没问题。
 */
function stateFile() {
  return Session && Session.scopedStateFile ? Session.scopedStateFile('desktop.json') : 'desktop.json';
}

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

// command / shell / icon 让一个图标可以代表「一条命令」（TUI 应用）而不仅是
// 「一个已安装应用」：app 仍然指向 term（谁提供 PTY），command 说明在里面跑什么。
// x11 让同一个图标改为「开一个 X11 图形会话」。桌面只负责存这个标志、把窗口
// 画出来；会话由 @runx-x11 扩展提供（没装就点不开，两边没有编译期依赖）。
const ICON_FIELDS = ['x', 'y', 'label', 'command', 'shell', 'icon', 'x11'];
const WIDGET_FIELDS = ['x', 'y', 'w', 'h', 'config'];
const TASKBAR_POSITIONS = ['top', 'bottom', 'left', 'right'];
const THEMES = ['light', 'dark', 'auto'];

/**
 * 强调色（§2.2 Accent Color）：给出若干预设，而不是让用户随便填色 ——
 * 随便填的色会和语义红/绿/黄撞车（用户把强调色设成红色，就看不出「危险」了），
 * 也没法保证在浅色与深色底上都有足够对比度。预设值都经过两套底色校验。
 */
const ACCENTS = {
  blue:   { light: '#0a6cff', dark: '#4a9eff', label: '蓝色' },
  purple: { light: '#7c3aed', dark: '#a78bfa', label: '紫色' },
  pink:   { light: '#db2777', dark: '#f472b6', label: '粉色' },
  red:    { light: '#d70015', dark: '#ff6b63', label: '红色' },
  orange: { light: '#c2410c', dark: '#fb923c', label: '橙色' },
  yellow: { light: '#a16207', dark: '#fbbf24', label: '黄色' },
  green:  { light: '#15803d', dark: '#4ade80', label: '绿色' },
  graphite:{ light: '#5b6470', dark: '#9aa4b2', label: '石墨' },
};

/** 内置壁纸：全部是零请求的 CSS 渐变，手机上也秒开 */
const WALLPAPERS = [
  { id: 'aurora',  label: '极光' },
  { id: 'sunset',  label: '日落' },
  { id: 'ocean',   label: '深海' },
  { id: 'forest',  label: '森林' },
  { id: 'mono',    label: '石墨' },
  { id: 'paper',   label: '宣纸' },
];

/**
 * 桌面分辨率预设。
 *
 * 语义是「虚拟显示器分辨率」：桌面渲染在一个固定尺寸的坐标系里，再用
 * transform 等比缩放到实际视口。这样手机上也能看到「1280×800 的桌面布局」，
 * 窗口摆位在不同设备上保持一致 —— 而不是各自排一套。
 *
 * scale: 'fit' 表示按视口自动等比缩放（推荐）；给数字则强制该倍率。
 */
const DISPLAY_PRESETS = [
  { id: 'auto',   label: '自适应',   w: 0,    h: 0,    scale: 'fit' },
  { id: 'laptop', label: '1280×800', w: 1280, h: 800,  scale: 'fit' },
  { id: 'fhd',    label: '1920×1080', w: 1920, h: 1080, scale: 'fit' },
  { id: 'tablet', label: '1024×768',  w: 1024, h: 768,  scale: 'fit' },
  { id: 'phone',  label: '414×896',   w: 414,  h: 896,  scale: 'fit' },
  { id: 'ultra',  label: '2560×1440', w: 2560, h: 1440, scale: 'fit' },
];

/** 新窗口默认尺寸预设（相对可用工作区） */
const WIN_DEFAULT_PRESETS = ['cascade', 'center', 'halfRight', 'halfLeft', 'quarter', 'large'];

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
    accent: 'blue',
    grid: { cell: 96, gap: 8 },
    icons: [], widgets: [],
    taskbar: { position: 'bottom', pinned: [], show_clock: true },
    // 虚拟显示器分辨率与缩放
    // mobileScale：窄形态（手机）下的「界面大小」——逻辑桌面放大 1/zoom 倍再整体
    //   缩放回视口，元素随之变小，一屏能放下更多。默认 0.85（手机上按 1:1 渲染
    //   时导航条 / 图标 / 字号普遍偏大）。桌面端不参与，不影响虚拟分辨率。
    display: { preset: 'auto', w: 0, h: 0, scale: 'fit', mobileScale: 0.85 },
    // 新窗口打开时的默认几何
    windowDefaults: { preset: 'cascade', w: 860, h: 580 },
    // windows：窗口几何的会话存档（供刷新后恢复）。
    // 只存「哪个 app 的窗口在哪、多大、是不是最大化/全屏」，不存窗口内容。
    windows: [],
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
    // 内核实际监听的端口（内核在 ctx.port 里给了）。桌面要回调内核自己 ——
    // 写死 3000 会在同机跑着第二个实例时打到别人家去。
    const GW_PORT = gwPortOf(ctx, null);

    function load() {
      const file = stateFile();
      let d = os.readState(file, null);
      // 新用户第一次进来：把安装时种下的全局桌面当**模板**（图标、壁纸、主题），
      // 但不继承窗口存档 —— 别人的窗口几何对他是噪音。第一次保存后就各自独立。
      if ((!d || d.schema !== 1) && file !== 'desktop.json') {
        const tpl = os.readState('desktop.json', null);
        if (tpl && tpl.schema === 1) d = Object.assign({}, tpl, { windows: [] });
      }
      return (d && d.schema === 1) ? d : defaultDesktop();
    }
    function save(d) {
      d.updated_at = Date.now();
      os.writeState(stateFile(), d);
      return d;
    }
    function findIcon(d, id) { return (d.icons || []).find((i) => i.id === id); }
    function findWidget(d, id) { return (d.widgets || []).find((w) => w.id === id); }

    function addIcon(body) {
      const d = load();
      const b = body || {};
      // 命令式快捷方式默认挂在 term 上：PTY 由它提供，桌面上只需要记「跑什么」。
      // X11 图标例外 —— 它不需要 PTY，显示由 x11 会话提供。
      if (!b.app && b.x11) b.app = 'x11';
      if (!b.app && b.command) b.app = 'term';
      if (!b.app) throw new Error('缺少 app');
      const cell = b.x != null && b.y != null ? { x: b.x, y: b.y } : nextFreeCell(d);
      const icon = { id: newId(), app: b.app, x: cell.x, y: cell.y, label: b.label || null };
      applyIconExtras(icon, b);
      d.icons = d.icons || [];
      d.icons.push(icon);
      save(d);
      return icon;
    }

    /**
     * 写入 command / shell / icon 三个可选字段。
     *
     * command 是**用户自己**在桌面右键里写的命令，所以这里不做白名单 —— 本机
     * 用户本来就能开终端敲同样的东西。真正要守的边界在别处：
     *   · 只有本机 UI 能创建（不开放远程接口，URL 里也不接受命令）
     *   · 执行时不拼 shell（除非显式勾选 shell 语法）
     *   · 长度封顶，避免把 icon 变成配置文件炸弹
     */
    function applyIconExtras(icon, b) {
      if (b.command !== undefined) {
        const c = b.command == null ? '' : String(b.command).trim();
        if (c.length > 512) throw Object.assign(new Error('命令太长（上限 512 字）'), { code: 422 });
        icon.command = c || null;
      }
      if (b.shell !== undefined) icon.shell = !!b.shell;
      if (b.x11 !== undefined) {
        icon.x11 = !!b.x11;
        // 同一个图标可以在两种模式之间切换，app 跟着改：它只影响「这个图标
        // 归谁管」的元数据，不改会让前端把 x11 图标当成终端图标去找应用。
        if (icon.command) icon.app = icon.x11 ? 'x11' : 'term';
      }
      if (b.icon !== undefined) {
        // emoji 图标：最多 4 个码点（"👨‍👩‍👧" 这类组合 emoji 也放得下）
        const e = b.icon == null ? '' : String(b.icon).trim();
        if ([...e].length > 8) throw Object.assign(new Error('图标只能是一个 emoji'), { code: 422 });
        icon.icon = e || null;
      }
      if (icon.command && icon.shell === undefined) icon.shell = false;
    }

    /* ════════════════════════════════════════════════════════════════
     * 桌面 API：应用 → 桌面
     *
     * 应用侧用 packages/runx-host 发起调用，落到 POST /runx/host：
     *   { method: 'notify', params: { title, body } }  + 头 X-Runx-Token
     *
     * 身份**只认 token**：body 里写了什么都不算数。令牌由 supervisor 在
     * 启动应用时生成并注入环境变量，本扩展从同一份状态文件反查 —— 谁都能
     * 在请求里自称 files，但拿不到 files 的令牌。
     * ════════════════════════════════════════════════════════════════ */

    function appByToken(tok) {
      if (!tok || String(tok).length < 16) return null;
      const table = os.readState('host-tokens.json', {}) || {};
      for (const name of Object.keys(table)) {
        if (table[name] === tok) return name;
      }
      return null;
    }

    /** 通过事件总线把指令推给前端（前端订阅 host.*） */
    function publishHost(kind, payload) {
      const port = GW_PORT;
      return fetch('http://127.0.0.1:' + port + API + '/event-bus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'host.' + kind, payload }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
    }

    /** 当前应用（按 token 反查）的端口，用于校验 window.open 的目标 */
    async function portOfApp(name) {
      const gw = GW_PORT;
      try {
        const r = await fetch('http://127.0.0.1:' + gw + API + '/apps',
          { signal: AbortSignal.timeout(3000) });
        const j = await r.json();
        const a = (j.apps || []).find((x) => x.name === name);
        return a ? Number(a.port) : 0;
      } catch (e) { return 0; }
    }

    function themeSummary(d) {
      const accentId = d.accent || 'blue';
      const acc = ACCENTS[accentId] || ACCENTS.blue;
      return {
        mode: d.theme || 'auto',
        accent: acc.light,
        accentDark: acc.dark,
        accentId,
        wallpaper: d.wallpaper || null,
      };
    }

    async function hostCall(body, token) {
      const appName = appByToken(token);
      if (!appName) throw Object.assign(new Error('令牌无效或已失效'), { code: 401 });
      const method = String((body && body.method) || '');
      const p = (body && body.params) || {};

      switch (method) {
        case 'ping':
          return { app: appName, api: 1, server_ts: Date.now() };

        case 'theme.get':
          return themeSummary(load());

        case 'notify': {
          const title = String(p.title || '').slice(0, 120);
          const text = String(p.body || '').slice(0, 400);
          if (!title && !text) throw Object.assign(new Error('title/body 至少给一个'), { code: 422 });
          await publishHost('notify', { app: appName, title, body: text });
          return { ok: true };
        }

        case 'window.open': {
          const raw = String(p.url || '');
          if (!raw) throw Object.assign(new Error('缺少 url'), { code: 422 });
          // 只允许开「自己的」页面：跨源 URL 会把窗口变成一个任意网页的容器，
          // 从而绕过「窗口 = 应用」这个前提（也就能伪装成别的应用钓鱼）。
          const port = await portOfApp(appName);
          let abs;
          try {
            abs = new URL(raw, 'http://127.0.0.1:' + (port || 80) + '/').href;
          } catch (e) {
            throw Object.assign(new Error('url 不合法'), { code: 422 });
          }
          const u = new URL(abs);
          if (!port || Number(u.port) !== port) {
            throw Object.assign(new Error('只能打开本应用自己端口下的页面'), { code: 403 });
          }
          await publishHost('window.open', {
            app: appName, url: abs,
            title: String(p.title || appName).slice(0, 80),
            w: Number(p.w) || 0, h: Number(p.h) || 0,
          });
          return { ok: true, url: abs };
        }

        case 'window.title': {
          await publishHost('window.title', {
            app: appName, title: String(p.title || '').slice(0, 80),
            subtitle: p.subtitle != null ? String(p.subtitle).slice(0, 80) : null,
          });
          return { ok: true };
        }

        case 'dock.badge': {
          const n = Number(p.count);
          await publishHost('dock.badge', { app: appName, count: isFinite(n) ? Math.min(99, Math.max(0, n)) : 0 });
          return { ok: true };
        }

        case 'bus.publish': {
          // 应用发布的事件统一前缀 app.<name>.，避免两个应用撞同一个 topic
          const topic = String(p.topic || '').replace(/[^a-z0-9.-]/gi, '');
          if (!topic) throw Object.assign(new Error('缺少 topic'), { code: 422 });
          const event = 'app.' + appName.replace(/[^a-z0-9-]/gi, '') + '.' + topic;
          const port = GW_PORT;
          const r = await fetch('http://127.0.0.1:' + port + API + '/event-bus', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, payload: p.payload, wantAck: true }),
            signal: AbortSignal.timeout(3000),
          });
          if (!r.ok) throw Object.assign(new Error('事件总线拒绝了这条事件'), { code: 502 });
          return { ok: true, event };
        }

        case 'app.info':
          return {
            name: appName,
            port: await portOfApp(appName),
            can: ['notify', 'window.open', 'window.title', 'dock.badge', 'theme.get', 'bus.publish'],
          };
      }
      throw Object.assign(new Error('未知方法：' + method), { code: 404 });
    }

    /* ── 命令式快捷方式的启动 ── */

    /** term 应用监听的端口：优先 env，其次问 supervisor 要，最后回退默认值 */
    async function termPort() {
      if (process.env.RUNX_TERM_PORT) return Number(process.env.RUNX_TERM_PORT);
      const gw = GW_PORT;
      try {
        const r = await fetch('http://127.0.0.1:' + gw + '/runx/apps',
          { signal: AbortSignal.timeout(3000) });
        const j = await r.json();
        const t = (j.apps || []).find((a) => a.name === 'term');
        if (t && t.port) return t.port;
      } catch (e) { /* supervisor 没响应：走默认端口 */ }
      return 3460;
    }

    /**
     * 把命令行拆成 argv。
     *
     * 只处理成对的引号，不做变量展开、通配符、重定向 —— 那些是 shell 的活。
     * 用户真要它们时勾上「在 shell 中运行」，那时整串原样交给 sh -c。
     */
    function splitArgv(str) {
      const out = [];
      const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
      let m;
      while ((m = re.exec(str)) !== null) {
        out.push(m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]));
      }
      return out.length ? out : [str];
    }

    /**
     * 为一条命令开一个新会话，返回 sessionId；桌面前端随后把窗口指向
     * `<term>/?session=<id>&ephemeral=1`。
     *
     * 由后端代理（而不是前端直接往 :3460 发请求）是这条链路的关键：
     * 前端与 term 不同源，跨源 POST 会被 term 的 sameOrigin 拒掉；后端 fetch
     * 不带 Origin，天然放行。于是「谁能创建任意命令」= 本机进程，网页不行。
     */
    async function startTui(body) {
      const cmd = String((body && body.command) || '').trim();
      if (!cmd) throw Object.assign(new Error('命令不能为空'), { code: 422 });
      if (cmd.length > 512) throw Object.assign(new Error('命令太长（上限 512 字）'), { code: 422 });

      const port = await termPort();
      const payload = {
        command: body.shell ? cmd : splitArgv(cmd),
        shell: !!body.shell,
        cwd: body.cwd || null,
        label: String(body.label || cmd).slice(0, 80),
        cols: body.cols || 100,
        rows: body.rows || 28,
        ephemeral: true,
      };
      let r, j;
      try {
        r = await fetch('http://127.0.0.1:' + port + '/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
        j = await r.json();
      } catch (e) {
        throw Object.assign(new Error('终端应用没有响应（' + port + '）'), { code: 502 });
      }
      if (!r.ok) throw Object.assign(new Error(j.message || j.error || '启动失败'), { code: 502 });
      return j;
    }

    function patchIcon(id, body) {
      const d = load();
      const icon = findIcon(d, id);
      if (!icon) throw Object.assign(new Error('图标不存在'), { code: 404 });
      for (const k of ['x', 'y', 'label']) if (body[k] != null) icon[k] = body[k];
      applyIconExtras(icon, body);
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

    /** 强调色：只接受预设名，不接受任意色值（理由见 ACCENTS 注释） */
    function setAccent(body) {
      const d = load();
      const name = body && body.accent;
      if (!Object.prototype.hasOwnProperty.call(ACCENTS, name)) {
        throw new Error('accent 必须是预设名：' + Object.keys(ACCENTS).join(' / '));
      }
      d.accent = name;
      save(d);
      return { accent: d.accent };
    }

    /**
     * 虚拟显示器分辨率。
     * preset 命中 DISPLAY_PRESETS 时按预设；preset === 'custom' 用 body.w/h。
     * 自定义尺寸夹到 [320, 5120]×[240, 2880]（手机到 5K 都能覆盖），
     * scale 允许 'fit' 或 0.25–3 的数字。
     */
    function setDisplay(body) {
      const d = load();
      const b = body || {};
      const cur = d.display || { preset: 'auto', w: 0, h: 0, scale: 'fit', mobileScale: 0.85 };
      const clampNum = (v, min, max, dflt) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
      };
      // 旧存档没有 mobileScale / mobilePreset —— 补上默认值。
      // mobileScale 缺省 0.85，否则手机上按 1:1 渲染（偏大）；
      // mobilePreset 缺省 auto，否则历史上给桌面端选的 1280×800 会突然
      // 在手机上生效，把整个界面压到 26%（工具栏只剩 9px，根本点不到）。
      if (cur.mobileScale == null) cur.mobileScale = 0.85;
      if (cur.mobilePreset == null) cur.mobilePreset = 'auto';
      if (b.mobileScale != null) {
        const ms = Number(b.mobileScale);
        if (!Number.isFinite(ms)) throw new Error('display.mobileScale 不是数字');
        // 0.5–1.2：低于 0.5 字小到读不清，高于 1.2 反而比 1:1 还大，没有意义
        cur.mobileScale = Math.min(1.2, Math.max(0.5, Math.round(ms * 100) / 100));
      }
      // 窄屏专用分辨率：与桌面端的 preset 分开存，互不干扰。
      if (b.mobilePreset != null) {
        const mp = String(b.mobilePreset);
        if (mp === '' || mp === 'auto') cur.mobilePreset = 'auto';
        else if (DISPLAY_PRESETS.some((p) => p.id === mp)) cur.mobilePreset = mp;
        else throw new Error('display.mobilePreset 非法：' + mp);
      }
      let preset = b.preset != null ? String(b.preset) : cur.preset;
      const hit = DISPLAY_PRESETS.find((p) => p.id === preset);
      if (hit) {
        cur.preset = hit.id;
        cur.w = hit.w; cur.h = hit.h;
        // 预设的 scale 是 fit；除非显式要求自定义倍率
        cur.scale = b.scale != null ? normScale(b.scale, hit.scale) : hit.scale;
      } else if (preset === 'custom') {
        cur.preset = 'custom';
        cur.w = clampNum(b.w != null ? b.w : cur.w, 320, 5120, 1280);
        cur.h = clampNum(b.h != null ? b.h : cur.h, 240, 2880, 800);
        cur.scale = normScale(b.scale != null ? b.scale : cur.scale, 'fit');
      } else {
        throw new Error('display.preset 非法：' + preset);
      }
      d.display = cur;
      save(d);
      return cur;
    }
    function normScale(v, dflt) {
      if (v === 'fit') return 'fit';
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(3, Math.max(0.25, Math.round(n * 100) / 100)) : dflt;
    }

    /** 新窗口默认几何 */
    function setWindowDefaults(body) {
      const d = load();
      const b = body || {};
      const cur = d.windowDefaults || { preset: 'cascade', w: 860, h: 580 };
      if (b.preset != null) {
        if (!WIN_DEFAULT_PRESETS.includes(b.preset)) {
          throw new Error('windowDefaults.preset 非法：' + b.preset);
        }
        cur.preset = b.preset;
      }
      const clampNum = (v, min, max, dflt) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
      };
      if (b.w != null) cur.w = clampNum(b.w, 280, 5120, 860);
      if (b.h != null) cur.h = clampNum(b.h, 180, 2880, 580);
      d.windowDefaults = cur;
      save(d);
      return cur;
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

    /**
     * 窗口几何存档（§3.1 窗口可移动/缩放 —— 关掉浏览器再回来应该还在原处）。
     *
     * 只收「安全子集」，客户端传什么脏数据都不会写进状态文件：
     *   · app     必填，字符串，长度上限 64（要能对上 apps.json 里的名字）
     *   · x/y/w/h 数字，夹到合理范围（负数允许，多屏/贴边场景合法）
     *   · minimized / maximized / fullscreen  布尔
     *   · toolbarStyle  仅 unified | unifiedCompact | expanded
     *   · z       层级（可选），夹到 1..9999
     *
     * 数量上限 MAX_WINDOWS：桌面上真正能用的窗口不会超过这个数，
     * 防止被伪造请求塞爆 desktop.json。
     */
    function setWindows(body) {
      const d = load();
      const list = (body && Array.isArray(body.windows)) ? body.windows : null;
      if (!list) throw new Error('windows 必须是数组');

      const NUM = (v, dflt, min, max) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return dflt;
        return Math.min(max, Math.max(min, Math.round(n)));
      };
      const out = [];
      const seen = new Set();
      for (const w of list) {
        if (!w || typeof w.app !== 'string') continue;
        const app = w.app.trim().slice(0, 64);
        if (!app || seen.has(app)) continue;   // 同一 app 只留一条（RunX 里同应用单窗口）
        seen.add(app);
        const rec = {
          app,
          x: NUM(w.x, 0, -20000, 20000),
          y: NUM(w.y, 0, -20000, 20000),
          w: NUM(w.w, 760, 280, 20000),
          h: NUM(w.h, 500, 180, 20000),
          minimized: !!w.minimized,
          maximized: !!w.maximized,
          fullscreen: !!w.fullscreen,
          toolbarStyle: ['unified', 'unifiedCompact', 'expanded'].includes(w.toolbarStyle)
            ? w.toolbarStyle : 'unified',
        };
        if (w.z != null) rec.z = NUM(w.z, 1, 1, 9999);
        out.push(rec);
        if (out.length >= 24) break;   // MAX_WINDOWS
      }
      d.windows = out;
      save(d);
      return { windows: d.windows };
    }
    function delWindow(app) {
      const d = load();
      const name = String(app || '').trim();
      d.windows = (d.windows || []).filter((w) => w.app !== name);
      save(d);
      return { ok: true, windows: d.windows };
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
        capabilities: ['windows.drag', 'windows.resize', 'windows.fullscreen', 'windows.persist',
          'menubar', 'toolbar', 'startmenu', 'longpress', 'accent', 'display', 'windowdefaults',
          'mobile', 'safearea', 'backguard'],
        // 外观与显示的枚举值由服务端下发：客户端不硬编码，
        // 以后加一个壁纸/强调色只改服务端一处。
        accents: Object.keys(ACCENTS).map((k) => ({ id: k, label: ACCENTS[k].label })),
        wallpapers: WALLPAPERS,
        display_presets: DISPLAY_PRESETS,
        window_default_presets: WIN_DEFAULT_PRESETS,
      };
    }

    S = {
      json, err, load, save, addIcon, patchIcon, delIcon, startTui, hostCall,
      publishTheme: () => publishHost('theme', themeSummary(load())),
      addWidget, patchWidget, delWidget, setWallpaper, setTheme, setTaskbar, setGrid, meta,
      setWindows, delWindow,
      // 本轮新增：外观与显示
      setAccent, setDisplay, setWindowDefaults,
      accents: ACCENTS, wallpapers: WALLPAPERS,
      displayPresets: DISPLAY_PRESETS, windowDefaultPresets: WIN_DEFAULT_PRESETS,
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

  /**
   * 请求入口。整个处理过程包在「当前是谁」的上下文里 —— 这样 load()/save()
   * 不必层层传 req，也能落到正确的用户目录（见 stateFile）。
   */
  onRequest(req, url, ctx) {
    // 内核调用时 this 是 undefined（严格模式下模块方法调用不绑定），所以这里
    // 显式走 module.exports，不依赖 this
    const run = () => module.exports.onRequestImpl(req, url, ctx);
    if (Session && Session.runWith) return Session.runWith(req, run);
    return run();
  },

  /* 下面这个名字不叫 onRequest，是为了让上面的包装保持十行以内 */
  onRequestImpl(req, url, ctx) {
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

    if (req.method === 'POST' && p === API + '/host') {
      const tok = req.headers['x-runx-token'];
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) =>
        S.hostCall(b, tok)
          .then((r) => S.json(200, { ok: true, result: r }))
          .catch((e) => S.err(e.code || 500, e.message)));
    }

    if (req.method === 'POST' && p === API + '/desktop/tui') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) =>
        S.startTui(b).then((r) => S.json(200, r))
          .catch((e) => S.err(e.code === 422 ? 422 : 502, e.message)));
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
        try {
          const r = S.setTheme(b);
          // 广播给所有应用：它们订阅 host.theme 才能跟着换肤。
          // 不 await —— 主题切换不该等一轮 HTTP 往返才返回。
          S.publishTheme();
          return S.json(200, r);
        } catch (e) { return S.err(422, e.message); }
      });
    }
    /* 外观与显示 */
    if (req.method === 'PUT' && p === API + '/desktop/accent') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        try {
          const r = S.setAccent(b);
          S.publishTheme();
          return S.json(200, r);
        } catch (e) { return S.err(422, e.message); }
      });
    }
    if (req.method === 'PUT' && p === API + '/desktop/display') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        try { return S.json(200, S.setDisplay(b)); } catch (e) { return S.err(422, e.message); }
      });
    }
    if (req.method === 'PUT' && p === API + '/desktop/window-defaults') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        try { return S.json(200, S.setWindowDefaults(b)); } catch (e) { return S.err(422, e.message); }
      });
    }
    /* 窗口几何：整体覆盖式写入（客户端持有全部窗口状态，这里只做校验与落盘） */
    if (req.method === 'PUT' && p === API + '/desktop/windows') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        try { return S.json(200, S.setWindows(b)); } catch (e) { return S.err(422, e.message); }
      });
    }
    if (req.method === 'DELETE' && p.startsWith(API + '/desktop/windows/')) {
      const app = decodeURIComponent(p.slice((API + '/desktop/windows/').length));
      try { return S.json(200, S.delWindow(app)); } catch (e) { return S.err(422, e.message); }
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
