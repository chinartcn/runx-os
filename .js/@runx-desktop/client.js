'use strict';

/**
 * RunX 桌面外壳客户端 —— 窗口管理器 SPA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 只在桌面页（'/'）注入并启动；应用 iframe 内部不会重复启动。
 *
 * 结构（对应 RunX.UI.md §3 / §4）：
 *   .rx-menubar    顶部导航条 —— 固定顶部、细分割线、Flexbox（§3.2 菜单栏）
 *   .rx-surface    桌面内容层 —— 图标网格，支持框选与拖拽
 *   .rx-dock       底部 Dock —— 浮动 Liquid Glass 材质（§3.4）
 *   窗口           顶部工具栏 + iframe 内容 + 八向缩放手柄（§3.1）
 *
 * 窗口能力（§3.1：支持调整大小、隐藏、显示、移动，并支持全屏）：
 *   移动     拖标题栏 / 触屏拖标题栏；拖到屏幕边缘自动吸附
 *   调整大小 八向手柄（含四边与四角），带最小尺寸与视口约束
 *   隐藏     关闭按钮 / ⌘W；「显示」经 Dock 或窗口菜单恢复（最小化 / 隐藏）
 *   全屏     ⌘⌃F 或窗口菜单；绿色点单击=最大化，双击=全屏（沿用桌面习惯）
 *   最大化   绿色点 / 双击标题栏 / ⌘⌃M
 *
 * 状态口径：
 *   REST 的 /runx/desktop 仍是**布局真相源**（图标坐标、壁纸、主题、Dock 位置）；
 *   窗口几何（位置/大小/层级）是**会话状态**，只存在内存里 —— 刷新即回到默认排布。
 *   §1.1「灵活定制」的持久化留给后续版本（会写进 desktop.windows），当前不做，
 *   以免在手机上把一堆半开窗口存进状态文件反而更难收拾。
 *
 * 依赖：无。零构建、零框架、ES5 语法内核 + 少量 ES6，兼容老 WebView。
 */
(function () {
  if (location.pathname !== '/') return;            // 应用 iframe 内部不启动
  if (document.getElementById('runx-desktop')) return;

  var API = '/runx';
  var BASE = location.origin;
  var ASSET_BASE = API + '/desktop-assets/';        // 由 meta 覆盖

  /* ═══════════════════════════════════════════════════════════════════
   * 小工具
   * ═══════════════════════════════════════════════════════════════════ */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgIcon(path, extra) {
    // 统一 16px / 1.6 线宽的图标体格，保证一组图标风格协调（§2.3）
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.6');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    s.appendChild(p);
    if (extra) extra.forEach(function (d) {
      var q = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      q.setAttribute('d', d); s.appendChild(q);
    });
    return s;
  }
  var ICON = {
    close:   'M4 4l8 8M12 4l-8 8',
    minus:   'M4 8h8',
    expand:  'M6 2H2v4M10 14h4v-4M2 6V2h4M14 10v4h-4',
    shrink:  'M6 6H2V2M10 10h4v4M2 2l4 4M14 14l-4-4',
    reload:  'M13.5 8a5.5 5.5 0 1 1-1.7-3.95M13.5 2v3.2h-3.2',
    home:    'M2.5 7.5 8 2.8l5.5 4.7M4 7v6.5h8V7',
    app:     'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z',
  };

  /** 时长归一化 —— 与内核 os.safeMs 同源思路：NaN 会让浏览器把定时器降级成 1ms */
  // 时长归一化。与内核 os.safeMs 同一套语义：接受数字毫秒，也接受
  // "500ms" / "2s" / "1.5m" / "1h" 这类单位字符串；坏值回落 dflt，再夹到 [min,max]。
  // 返回值**永远是有限数**，杜绝 setTimeout(NaN) 静默降级成 1ms 空转。
  var MS_UNITS = {
    ms: 1, msec: 1, msecs: 1, millisecond: 1, milliseconds: 1,
    s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
    h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
    d: 86400000, day: 86400000, days: 86400000
  };
  function parseMs(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (typeof v !== 'string') return NaN;
    var s = v.trim().toLowerCase();
    if (!s) return NaN;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) {
      var n = Number(s);
      return isFinite(n) ? n : NaN;
    }
    var m = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z]+)$/.exec(s);
    if (!m) return NaN;
    var num = Number(m[1]);
    var unit = MS_UNITS[m[2]];
    if (!unit || !isFinite(num)) return NaN;
    return isFinite(num * unit) ? num * unit : NaN;
  }
  function safeMs(v, dflt, min, max) {
    var n = parseMs(v);
    if (!isFinite(n)) n = dflt;
    if (!isFinite(n)) n = isFinite(min) ? min : 0;
    return Math.min(max, Math.max(min, n));
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function px(v) { return Math.round(v) + 'px'; }

  function api(path, opts) {
    return fetch(BASE + API + path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, opts)).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var msg = t;
          try { msg = JSON.parse(t).error.message; } catch (e) { /* 原样 */ }
          throw new Error(msg || ('HTTP ' + r.status));
        });
      }
      return r.status === 204 ? null : r.json();
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 状态
   * ═══════════════════════════════════════════════════════════════════ */
  var cfg = null;                 // desktop.json（含 meta）
  var apps = [];                  // /runx/apps → apps[]
  var zTop = 100;
  var windows = {};               // id -> 窗口记录
  var order = [];                 // 打开顺序（用于 ⌘` 轮换与「窗口」菜单）
  var activeId = null;
  var iconTimers = {};
  var toastTimer = null;
  var openMenu = null;            // 当前展开的菜单元素

  /* ═══════════════════════════════════════════════════════════════════
   * DOM 骨架
   *
   * 层次： #runx-desktop（宿主，铺满物理视口）
   *          └ .rx-vscreen（逻辑桌面，尺寸＝虚拟分辨率，等比缩放居中）
   *               ├ .rx-menubar  顶部导航条
   *               ├ .rx-surface  桌面图标层
   *               ├ .rx-dock     应用坞
   *               ├ 弹出层（菜单 / 对话框 / 开始菜单 / toast）
   *          └ .rx-vscreen-badge（缩放徽标；挂在宿主上，不随桌面缩放）
   *
   * 为什么要多一层 vscreen：设了虚拟分辨率（如 1280×800）后，桌面内部一律
   * 用逻辑坐标，缩放交给 CSS transform。这样窗口摆位与设备无关。
   * 自适应模式下 vscreen 就等于视口、scale=1，行为与没有这一层完全一致。
   * ═══════════════════════════════════════════════════════════════════ */
  var root = el('div');
  root.id = 'runx-desktop';
  document.body.appendChild(root);

  var vscreen = el('div', 'rx-vscreen');
  root.appendChild(vscreen);

  var menubar = el('div', 'rx-menubar rx-material-thin');
  menubar.setAttribute('role', 'menubar');
  var surface = el('div', 'rx-surface');
  vscreen.appendChild(menubar);
  vscreen.appendChild(surface);

  // 分辨率徽标挂在宿主上：它不该跟着桌面一起被缩放，否则小分辨率下看不见
  var badge = el('div', 'rx-vscreen-badge');
  root.appendChild(badge);

  var brand = el('div', 'rx-brand');
  var brandMark = el('div', 'rx-brand-mark', 'R');
  var brandName = el('span', 'rx-brand-name', 'RunX OS');
  brand.appendChild(brandMark);
  brand.appendChild(brandName);
  brand.setAttribute('title', 'RunX OS');
  menubar.appendChild(brand);

  /* 开始按钮：整个系统的应用总入口。放在品牌名右侧、菜单栏之前 ——
     与「菜单栏是命令总入口」并列，两者职责不同：菜单栏管**当前窗口**，
     开始菜单管**整个系统**（开应用 / 设置 / 退出）。 */
  var startBtn = el('button', 'rx-start-btn');
  startBtn.setAttribute('type', 'button');
  startBtn.setAttribute('aria-haspopup', 'true');
  startBtn.setAttribute('aria-expanded', 'false');
  startBtn.setAttribute('aria-label', '开始菜单');
  startBtn.setAttribute('title', '开始菜单');
  startBtn.appendChild(svgIcon(ICON.app));
  menubar.appendChild(startBtn);

  var menuHost = el('div', 'rx-menu-roots');
  menuHost.style.cssText = 'display:flex;align-items:center;gap:2px;min-width:0';
  menubar.appendChild(menuHost);

  // 弹性空隙：把菜单推到左边、状态推到右边（§附录：就是普通 Flexbox）
  var spacer = el('div', 'rx-menubar-spacer');
  menubar.appendChild(spacer);

  var statusHost = el('div', 'rx-menubar-status');
  statusHost.style.cssText = 'display:flex;align-items:center;gap:2px';
  menubar.appendChild(statusHost);

  var statusDot = el('span', 'rx-status-dot');
  var statusApps = el('span', 'rx-status-item optional');
  statusApps.appendChild(statusDot);
  var statusAppCount = el('span', null, '0 个应用');
  statusApps.appendChild(statusAppCount);
  var statusClock = el('span', 'rx-status-item rx-status-clock tabular', '--:--');
  statusHost.appendChild(statusApps);
  statusHost.appendChild(statusClock);

  var toast = el('div', 'rx-toast rx-material-thick');
  vscreen.appendChild(toast);

  var live = el('div', 'rx-sr-only');
  live.setAttribute('aria-live', 'polite');
  vscreen.appendChild(live);

  function announce(msg) { live.textContent = msg; }
  function showToast(msg, ms) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); },
      safeMs(ms, 1800, 600, 8000));
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 应用信息
   * ═══════════════════════════════════════════════════════════════════ */
  function appOf(name) {
    for (var i = 0; i < apps.length; i++) if (apps[i].name === name) return apps[i];
    return null;
  }
  function appTitle(app) {
    return (app && (app.display_name || app.name)) || '应用';
  }
  function appIconUrl(app) {
    if (!app || !app.icon) return null;
    return BASE + '/apps/' + app.name + '/' + app.icon;
  }
  function appOrigin(app) {
    // node 应用listen 在自己的端口上；web 应用是站点静态资源
    if (app.type === 'node') return 'http://' + location.hostname + ':' + app.port + '/';
    return BASE + '/apps/' + app.name + '/';
  }
  /**
   * 应用是否在运行。
   * /runx/apps 返回的形状是 { name, type, ..., status: { state, pid } } ——
   * 状态嵌在 status 里，不在顶层。历史上这里只读 app.state，于是恒为 false：
   * 图标角标永远不亮、恢复窗口时误判「没在跑」而跳过。两种形状都兼容。
   */
  function appState(app) {
    if (!app) return '';
    return (app.status && app.status.state) || app.state || '';
  }
  function isRunning(app) {
    if (!app) return false;
    var s = appState(app);
    return s === 'running' || s === 'restarting' || app.type === 'web';
  }
  function winId(name) { return 'win-' + name; }

  /* ═══════════════════════════════════════════════════════════════════
   * 主题 / 壁纸
   * ═══════════════════════════════════════════════════════════════════ */
  /**
   * 主题 = 明暗（data-theme） + 强调色（data-accent）。
   *
   * 强调色**不整体染色**（§2.2）：它只喂给 --accent / --accent-hover /
   * --accent-press 三个令牌，由 CSS 里 `[data-accent="X"]` 的规则接管；
   * 选中态、焦点环、进度条这些「有意义的强调」的地方自动跟着变，
   * 而语义色（红=危险 / 绿=正常）不受影响 —— 这是把强调色与语义色分开的理由。
   */
  function applyTheme() {
    root.setAttribute('data-theme', (cfg && cfg.theme) || 'auto');
    var accent = (cfg && cfg.accent) || 'blue';
    // 只认服务端下发的枚举；脏数据（手改 desktop.json）回落默认色，
    // 否则会写出一个没有对应 CSS 规则的属性值 → 强调色静默失效。
    var known = (cfg && cfg.meta && cfg.meta.accents) || [];
    if (known.length && !known.some(function (a) { return a.id === accent; })) accent = 'blue';
    root.setAttribute('data-accent', accent);
  }

  /**
   * 壁纸：内置（data-wallpaper-id 选渐变）/ 图片文件 / 任意图片 URL。
   *
   * 内置壁纸走 CSS 变量（见 styles.css），所以只写 data-wallpaper-id；
   * 外链图片用 backgroundImage 覆盖 —— 内置规则里 background-image 是
   * 用 var() 拼的，写在元素行内样式上的优先级更高，能正常盖住。
   */
  function applyWallpaper() {
    var w = cfg && cfg.wallpaper;
    root.style.backgroundImage = '';
    root.removeAttribute('data-wallpaper-id');
    if (!w) { root.removeAttribute('data-wallpaper'); return; }

    if (w.type === 'file' && w.path) {
      root.setAttribute('data-wallpaper', 'file');
      root.style.backgroundImage = 'url(' + BASE + '/' + w.path + ')';
    } else if (w.type === 'url' && w.url) {
      root.setAttribute('data-wallpaper', 'url');
      // 渐变是 CSS 值不是地址（右键菜单里的「纯色深空」就是这么传的）
      root.style.backgroundImage = /^\s*(linear|radial|conic)-gradient\(/i.test(w.url)
        ? w.url
        : 'url(' + w.url + ')';
    } else {
      root.setAttribute('data-wallpaper', 'builtin');
      root.setAttribute('data-wallpaper-id', w.id || 'aurora');
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 布局度量
   *
   * 导航条 / Dock 的高度从 CSS 变量里读实际值，不硬编码 ——
   * 窄屏媒体查询改了高度，JS 自动跟上，不会出现图标被导航条压住。
   *
   * ── 虚拟显示器分辨率（display）与这两层坐标 ──
   * · `viewport()` 返回**逻辑桌面**的尺寸，也就是窗口/图标坐标所在的坐标系。
   *   设了 1280×800 就恒返回 1280×800，与真实屏幕无关 —— 所有摆位逻辑
   *   都跑在逻辑坐标系里，因此手机和桌面端能摆出同一套布局。
   * · `physViewport()` 返回真实可视区尺寸。只用于两件事：
   *   计算缩放比、把 JSON 配置里的像素值换算成逻辑像素。
   * · 指针事件给的是**屏幕坐标**，必须经 `toLogical()` 换算回逻辑坐标，
   *   否则缩放 ≠1 时拖动会「跑偏」（手指走 100px，窗口走 100/scale）。
   * ═══════════════════════════════════════════════════════════════════ */
  function metric(name, fallback) {
    var v = getComputedStyle(root).getPropertyValue(name).trim();
    var n = parseFloat(v);
    return isFinite(n) && n > 0 ? n : fallback;
  }
  function navbarH() {
    // 量真实渲染高度：窄屏媒体查询改了 --navbar-h，且刘海屏要含安全区预留，
    // 直接量 menubar 比读变量更准，workArea 也不用再手动加 safe-area。
    var mb = root.querySelector('.rx-menubar');
    if (mb) { var r = mb.getBoundingClientRect(); if (r.height > 0) return r.height; }
    return metric('--navbar-h', 40);
  }
  /** 真实可视区（物理像素）。
   *  优先用 visualViewport：手机上地址栏收起、软键盘弹起时，布局视口
   *  (innerWidth/innerHeight) 可能纹丝不动，但「可见区域」确实变小了 ——
   *  window.resize 不触发，visualViewport 才会。 */
  function physViewport() {
    var vv = window.visualViewport;
    if (vv && vv.width && vv.height) return { w: vv.width, h: vv.height };
    return { w: root.clientWidth || window.innerWidth, h: root.clientHeight || window.innerHeight };
  }
  /**
   * 手机上的分辨率回退：视口窄于 680 且配置的是桌面尺寸预设（宽 > 680）时，
   * 本地回退为「自适应」—— 1280×800 的桌面在 390px 宽的手机上会被等比缩到
   * 30%，导航条和 Dock 小到没法点。配置本身不动（回到桌面端仍然生效），
   * 只在手机显示时临时按物理视口排布；想看「手机分辨率桌面」可显式选
   * 414×896 这类窄预设，不会被回退。
   */
  function mobileAutoOverride() {
    if (!narrow()) return false;
    var d = cfg && cfg.display;
    return !!(d && d.preset && d.preset !== 'auto' && d.w > 680);
  }
  /** 逻辑桌面尺寸：设了虚拟分辨率就用它，否则等于物理视口（自适应） */
  function viewport() {
    var d = cfg && cfg.display;
    if (mobileAutoOverride()) return physViewport();
    if (d && d.preset && d.preset !== 'auto' && d.w > 0 && d.h > 0) {
      return { w: d.w, h: d.h };
    }
    return physViewport();
  }
  /** 当前缩放比：逻辑 → 物理 */
  function displayScale() {
    var d = cfg && cfg.display;
    if (mobileAutoOverride()) return 1;
    if (!d || !d.preset || d.preset === 'auto' || !(d.w > 0 && d.h > 0)) return 1;
    if (d.scale === 'fit' || d.scale == null) {
      var pv = physViewport();
      // 取较小的一边，保证逻辑桌面完整可见（letterbox 而不是裁切）
      var s = Math.min(pv.w / d.w, pv.h / d.h);
      return isFinite(s) && s > 0 ? s : 1;
    }
    var n = Number(d.scale);
    return isFinite(n) && n > 0 ? n : 1;
  }
  /** 屏幕坐标 → 逻辑桌面坐标 */
  function toLogical(x, y) {
    var s = displayScale();
    if (!s || s === 1) return { x: x, y: y };
    var r = vscreen ? vscreen.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: (x - r.left) / s, y: (y - r.top) / s };
  }
  /** 把逻辑坐标尺寸拍成物理像素的 CSS（用于定位弹出的菜单/对话框） */
  function toPhysicalPx(n) {
    var s = displayScale();
    return Math.round(n * (s || 1));
  }
  /** 窗口可用的自由区域（扣掉导航条与 Dock），逻辑坐标 */
  function workArea() {
    var vp = viewport();
    var top = navbarH();
    return { top: top, left: 0, w: vp.w, h: vp.h - top, bottom: vp.h };
  }

  /**
   * 应用虚拟分辨率：把 #runx-desktop 的内容全部挂到 .rx-vscreen 上，
   * 给它逻辑尺寸 + transform: scale() 并居中。
   * 自适应（auto）时 vscreen 就等于视口、scale=1，等同于没有这一层 ——
   * 保留这一层结构是为了让两套模式走同一条代码路径，不出分支 bug。
   */
  function applyDisplay() {
    if (!vscreen) return;
    var vp = viewport(), pv = physViewport();
    var s = displayScale();
    var scaled = Math.abs(s - 1) > 0.001;

    vscreen.style.width = px(vp.w);
    vscreen.style.height = px(vp.h);
    vscreen.dataset.scaled = scaled ? '1' : '0';

    if (scaled) {
      // 居中：把缩放后的逻辑桌面摆在物理视口正中
      var ox = Math.max(0, (pv.w - vp.w * s) / 2);
      var oy = Math.max(0, (pv.h - vp.h * s) / 2);
      vscreen.style.transform = 'translate(' + px(ox) + ', ' + px(oy) + ') scale(' + s + ')';
      root.setAttribute('data-letterbox', '1');
    } else {
      vscreen.style.transform = '';
      root.removeAttribute('data-letterbox');
    }

    // 徽标：只有真的缩放（≠100%）且不是自适应时才提示，避免无意义打扰
    if (badge) {
      if (scaled && cfg && cfg.display && cfg.display.preset !== 'auto') {
        badge.textContent = vp.w + '×' + vp.h + ' · ' + Math.round(s * 100) + '%';
        badge.dataset.show = '1';
      } else {
        badge.dataset.show = '0';
      }
    }
  }

  /**
   * 让 #runx-desktop 贴合真实可视区（visualViewport）。
   * 手机上地址栏收起 / 软键盘弹起会让「可见区域」偏离布局视口：
   * visualViewport.offsetTop 在键盘顶起时变大、width/height 变小。
   * 把桌面钉在可视区矩形内，窗口与 Dock 就不会被键盘盖住。
   * 桌面端或无键盘时 vv 等于布局视口，效果等同 CSS 的 inset:0。
   */
  function applyViewportFrame() {
    var vv = window.visualViewport;
    if (!vv) return;                       // 旧浏览器：交给 CSS 的 inset:0
    root.style.left = (vv.offsetLeft || 0) + 'px';
    root.style.top = (vv.offsetTop || 0) + 'px';
    root.style.width = vv.width + 'px';
    root.style.height = vv.height + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 桌面图标网格
   * ═══════════════════════════════════════════════════════════════════ */
  function gridStep() {
    var g = (cfg && cfg.grid) || {};
    return safeMs(Number(g.cell), 96, 48, 240) + safeMs(Number(g.gap), 8, 0, 64);
  }

  function renderIcons() {
    var old = surface.querySelectorAll('.rx-icon');
    for (var i = 0; i < old.length; i++) old[i].remove();
    if (!cfg) return;

    var step = gridStep();
    var icons = cfg.icons || [];
    if (!icons.length) {
      var empty = el('div', 'rx-empty');
      empty.innerHTML = '桌面上还没有图标。<br>' +
        '在终端里跑 <kbd>curl -X POST ' + API + '/desktop/icons -d \'{"app":"term"}\'</kbd> 添加。';
      surface.appendChild(empty);
      return;
    }

    icons.forEach(function (ic) {
      var app = appOf(ic.app);
      var node = el('div', 'rx-icon');
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      node.setAttribute('aria-label', ic.label || appTitle(app));
      node.style.left = px(ic.x * step);
      node.style.top = px(ic.y * step);
      node.dataset.iconId = ic.id;

      var url = appIconUrl(app);
      if (url) {
        var img = el('img');
        img.src = url;
        img.alt = '';
        img.draggable = false;
        img.addEventListener('error', function () {
          // 图标文件缺失 / 404：换成占位方块，别在桌面上留个破图
          var ph = el('div', 'rx-emoji', '📦');
          if (img.parentNode) img.parentNode.replaceChild(ph, img);
        });
        node.appendChild(img);
      } else {
        node.appendChild(el('div', 'rx-emoji', '📦'));
      }
      node.appendChild(el('span', 'rx-label', ic.label || appTitle(app)));

      if (app && isRunning(app)) {
        node.appendChild(el('span', 'rx-badge'));
      }

      // 单击选中，双击打开 —— 与桌面惯例一致
      node.addEventListener('click', function (e) {
        e.stopPropagation();
        selectIcon(node);
      });
      node.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        openApp(ic.app);
      });
      node.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openApp(ic.app); }
      });
      // 右键上下文菜单（§3.5）
      node.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        selectIcon(node);
        var p = pointOfPhysical(e);
        openContextMenu(p.x, p.y, iconMenuItems(ic, app));
      });
      // 触屏长按 = 右键（手机上没有 contextmenu 事件）
      bindLongPress(node, function (x, y) {
        selectIcon(node);
        openContextMenu(x, y, iconMenuItems(ic, app));
      }, { when: function () { return !iconDragActive; } });
      makeIconDraggable(node, ic, step);
      surface.appendChild(node);
    });
  }

  var selectedIconEl = null;
  function selectIcon(node) {
    if (selectedIconEl && selectedIconEl !== node) selectedIconEl.classList.remove('selected');
    selectedIconEl = node;
    if (node) node.classList.add('selected');
  }

  /** 图标拖拽：跟随指针，松手吸附网格并写回 desktop.json */
  function makeIconDraggable(node, ic, step) {
    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0, startCell;

    function onDown(e) {
      if (e.button != null && e.button !== 0) return;
      dragging = true; moved = false;
      iconDragActive = true;
      var p = pointOf(e);
      sx = p.x; sy = p.y;
      ox = ic.x * step; oy = ic.y * step;
      startCell = { x: ic.x, y: ic.y };
      node.classList.add('dragging');
      selectIcon(node);
      bind(e);
    }

    function onMove(e) {
      if (!dragging) return;
      var p = pointOf(e);
      var dx = p.x - sx, dy = p.y - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;   // 抖动阈值：别把单击变拖拽
      moved = true;
      // 拖拽期间用 left/top 跟手（网格吸附发生在松手时）
      node.style.left = px(ox + dx);
      node.style.top = px(oy + dy);
      if (e.cancelable) e.preventDefault();
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      iconDragActive = false;
      node.classList.remove('dragging');
      unbind();
      if (!moved) return;

      var wa = workArea();
      var stepPx = step;
      var nx = clamp(Math.round(parseFloat(node.style.left) / stepPx), 0,
        Math.max(0, Math.floor((wa.w - 92) / stepPx)));
      var ny = clamp(Math.round(parseFloat(node.style.top) / stepPx), 0,
        Math.max(0, Math.floor((wa.h - 92) / stepPx)));
      ic.x = nx; ic.y = ny;
      node.style.left = px(nx * stepPx);
      node.style.top = px(ny * stepPx);

      if (nx !== startCell.x || ny !== startCell.y) {
        debouncedPatchIcon(ic);
        var occupant = (cfg.icons || []).filter(function (o) {
          return o.id !== ic.id && o.x === nx && o.y === ny;
        })[0];
        if (occupant) showToast('该格子已被「' + (occupant.label || occupant.app) + '」占用，位置已重叠', 2200);
      }
    }

    function bind(e) {
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp);
      window.addEventListener('touchcancel', onUp);
      if (e && e.cancelable) e.preventDefault();
    }
    function unbind() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('touchcancel', onUp);
    }
    node.addEventListener('mousedown', onDown);
    node.addEventListener('touchstart', onDown, { passive: false });
  }

  /**
   * 指针位置 → **逻辑桌面坐标**。
   *
   * 为什么在这里就换算掉：拖动 / 缩放 / 图标摆放全都跑在逻辑坐标系里，
   * 若让各调用点自己换算，漏一处就会出现「缩放 ≠1 时拖动跑偏」——
   * 手指走 100px 而窗口走 100/scale。统一在这里收口。
   * 需要**屏幕坐标**的场景（弹菜单定位）用 pointOfPhysical()。
   */
  function pointOf(e) {
    var x, y;
    if (e.touches && e.touches.length) { x = e.touches[0].clientX; y = e.touches[0].clientY; }
    else if (e.changedTouches && e.changedTouches.length) { x = e.changedTouches[0].clientX; y = e.changedTouches[0].clientY; }
    else { x = e.clientX; y = e.clientY; }
    return toLogical(x, y);
  }
  /** 指针位置 → 屏幕坐标（弹层定位用） */
  function pointOfPhysical(e) {
    if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches && e.changedTouches.length) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 触屏长按 → 右键菜单
   *
   * 手机上不会有 contextmenu 事件，可右键菜单承载了「图标整理 / 窗口操作 /
   * 收起应用」这些没有其他入口的命令。所以必须给每个右键点补一个长按等价物。
   *
   * 实现要点：
   *   · **500ms** 阈值 —— 短于这个时长会和滑动/滚动冲突；长于 600ms 手感迟钝。
   *   · **10px 容差**：手指按住后有轻微抖动很正常，超过 10px 视为滚动/拖动，
   *     立刻取消长按（否则用户一滑就误弹菜单）。
   *   · **要有震动反馈**：有 vibrate 就用 15ms 轻震，这是手机上「触发了」的
   *     主要体感信号，没有它用户不知道自己按够时间了。
   *   · 命中后调 preventDefault 阻止随后的 click / 滚动。
   *
   * @param {Element} node     绑定目标
   * @param {(x:number,y:number)=>void} handler 触发时的回调（坐标已换算好）
   * @param {{move?:number, ms?:number, when?:()=>boolean}} [opts]
   *        move 容差像素、ms 时长、when 额外条件（如「只在窄屏启用」）
   */
  function bindLongPress(node, handler, opts) {
    opts = opts || {};
    var MOVE = safeMs(opts.move, 10, 4, 40);
    var MS = safeMs(opts.ms, 500, 300, 1500);
    var timer = null, sx = 0, sy = 0, fired = false;

    function clear() {
      if (timer) { clearTimeout(timer); timer = null; }
    }
    function onStart(e) {
      if (opts.when && !opts.when()) return;
      if (e.touches && e.touches.length > 1) { clear(); return; }  // 多指是缩放，不是长按
      var p = pointOf(e);
      sx = p.x; sy = p.y; fired = false;
      clear();
      timer = setTimeout(function () {
        timer = null;
        fired = true;
        try { if (navigator.vibrate) navigator.vibrate(15); } catch (err) { /* 忽略 */ }
        handler(sx, sy, e);
      }, MS);
    }    function onMove(e) {
      if (!timer) return;
      var p = pointOf(e);
      if (Math.abs(p.x - sx) > MOVE || Math.abs(p.y - sy) > MOVE) clear();
    }
    function onEnd(e) {
      clear();
      // 长按已触发 → 吃掉这次 click，避免菜单刚弹出就被同一根手指点掉
      if (fired) {
        fired = false;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
      }
    }
    node.addEventListener('touchstart', onStart, { passive: true });
    node.addEventListener('touchmove', onMove, { passive: true });
    node.addEventListener('touchend', onEnd);
    node.addEventListener('touchcancel', function () { clear(); fired = false; });
    // 桌面端滚轮/鼠标按压期间滑走也要取消
    node.addEventListener('mouseleave', function () { if (timer && !fired) clear(); });
    return clear;
  }

  /** 是否触屏设备（用于决定提示文案与热区，不影响功能可用性） */
  function isTouch() {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  }

  /* 长按与拖拽是同一根手指上的两种意图，必须互斥 —— 否则拖着图标走
     500ms 会突然弹出菜单，手感很差。两个标志位在拖拽开始/结束时翻转。 */
  var iconDragActive = false;   // 正在拖桌面图标
  var longPressMute = false;    // 本次触摸起点在窗口/Dock 内，桌面长按不参与

  function debouncedPatchIcon(ic) {
    clearTimeout(iconTimers[ic.id]);
    iconTimers[ic.id] = setTimeout(function () {
      api('/desktop/icons/' + encodeURIComponent(ic.id), {
        method: 'PATCH', body: JSON.stringify({ x: ic.x, y: ic.y }),
      }).catch(function (e) { showToast('图标位置没能保存：' + e.message); });
    }, safeMs(500, 500, 120, 4000));
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 窗口几何持久化
   *
   * 目标（§3.1 窗口可移动/缩放）：刷新页面后窗口还在原来的位置和大小。
   *
   * 设计取舍：
   *   · **不做实时同步**。拖动/缩放过程中每一帧都发请求会把内核写爆 ——
   *     所以写盘只在「稳定状态」触发：松手、最大化/全屏切换、关闭、最小化，
   *     并且统一走 debounce（300ms）合并连续操作。
   *   · **整体覆盖式写入**。客户端持有全部窗口状态，PUT 一次写全量，
   *     比逐窗口 PATCH 少很多请求，也不会出现半更新状态。
   *   · **恢复时重新夹取**。存档里的几何是「当时的视口」下算出来的；用户
   *     可能把手机横过来、或换到更小的屏幕上。恢复时必须按**当前** workArea
   *     重新夹一遍，否则窗口会跑到屏幕外，用户以为数据丢了。
   *   · 只恢复**仍然存在**的 app（应用可能已被卸载）。
   * ═══════════════════════════════════════════════════════════════════ */
  var winSaveTimer = null;
  // 恢复流程中置位：期间 saveWindows 只记「待写」不真发请求，
  // 由 restoreWindows 收尾时统一落盘一次 —— 否则恢复 3 个窗口要发很多次 PUT。
  var restoring = false;

  function winSnapshot() {
    return order.map(function (id) {
      var rec = windows[id];
      if (!rec) return null;
      var g = rec.geom || currentGeom(rec);
      // 最大化/全屏时 offsetWidth 是铺满后的尺寸，要记住的是「还原后」的几何 ——
      // rec.restored 正是为此存的。
      if ((rec.maximized || rec.fullscreen) && rec.restored) g = rec.restored;
      return {
        app: rec.app.name,
        x: Math.round(g.x), y: Math.round(g.y),
        w: Math.round(g.w), h: Math.round(g.h),
        minimized: !!rec.minimized,
        maximized: !!rec.maximized,
        fullscreen: !!rec.fullscreen,
        toolbarStyle: toolbarStyleOf(rec),
        z: rec.el ? (parseInt(rec.el.style.zIndex, 10) || 1) : 1,
      };
    }).filter(Boolean);
  }

  function toolbarStyleOf(rec) {
    if (rec.el.classList.contains('unifiedCompact')) return 'unifiedCompact';
    if (rec.el.classList.contains('expanded')) return 'expanded';
    return 'unified';
  }

  function saveWindowsNow() {
    if (restoring) return;                 // 恢复期间不落盘，收尾时统一写
    var body = { windows: winSnapshot() };
    return api('/desktop/windows', { method: 'PUT', body: JSON.stringify(body) })
      .catch(function (e) { showToast('窗口布局没能保存：' + e.message); });
  }

  /** 合并短时间内的多次几何变化，避免拖动/缩放期间请求风暴 */
  function saveWindows() {
    if (restoring) return;
    if (winSaveTimer) clearTimeout(winSaveTimer);
    winSaveTimer = setTimeout(function () {
      winSaveTimer = null;
      saveWindowsNow();
    }, safeMs(300, 300, 80, 4000));
  }

  /** 页面要走了：把待写的快照尽力塞出去 */
  function flushWindows() {
    if (!winSaveTimer && !restoring) return;
    if (winSaveTimer) { clearTimeout(winSaveTimer); winSaveTimer = null; }
    restoring = false;                     // 收尾写盘要能真的执行
    var payload = JSON.stringify({ windows: winSnapshot() });
    try {
      // keepalive 让请求在页面卸载后仍能完成（Chrome/Safari 都支持）
      fetch(BASE + API + '/desktop/windows', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: payload, keepalive: true,
      }).catch(function () {});
      return;
    } catch (e) { /* 落到下面的同步兜底 */ }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', BASE + API + '/desktop/windows', false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(payload);
    } catch (e) { /* 页面卸载中，尽力而为 */ }
  }

  /**
   * 把存档里的几何夹回当前视口。
   * 规则与拖动一致：至少保留 120px（或半宽）标题栏在可视区内，
   * 这样即使用户从大屏切到手机，窗口也不会「消失」在屏幕外抓不到。
   */
  function clampGeomToView(g) {
    var wa = workArea(), view = viewport();
    var w = clamp(g.w, 280, Math.max(280, wa.w));
    var h = clamp(g.h, 180, Math.max(180, wa.h));
    var keepH = Math.min(120, w * 0.5);
    return {
      w: w, h: h,
      x: clamp(g.x, -(w - keepH), Math.max(-(w - keepH), view.w - keepH)),
      y: clamp(g.y, wa.top, Math.max(wa.top, view.h - 34)),
    };
  }

  /** 启动时按存档恢复窗口，返回恢复的个数 */
  function restoreWindows(saved) {
    if (!saved || !saved.length) return 0;
    restoring = true;
    // z 小的先开，这样 z 大的自然叠在上面
    var list = saved.slice().sort(function (a, b) { return (a.z || 1) - (b.z || 1); });
    var n = 0;
    try {
      list.forEach(function (s) {
        if (!s || !s.app) return;
        var app = appOf(s.app);
        if (!app) return;                                  // 应用已从 apps.json 卸载

        // 应用没在跑时是否恢复？这里有个容易搞错的取舍。
        // 早先的做法是「没在跑就跳过」，但 app 的状态是**会变**的：
        // 崩溃重启中（restarting）恢复、超过重启上限后变 failed 就不恢复 ——
        // 同一个存档刷新两次，结果不一样，用户会以为窗口数据丢了。
        // 所以现在只在「应用真的不在了」时跳过；没起来也照开窗口，
        // 窗口里的错误态本身就能告诉用户「应用没跑起来」，
        // 这比窗口静默消失好得多。
        var id = openApp(s.app, { silent: true, geom: clampGeomToView(s) });
        if (!id || !windows[id]) return;
        if (s.toolbarStyle && s.toolbarStyle !== 'unified') setToolbarStyle(id, s.toolbarStyle);
        if (s.minimized) minimizeWindow(id);
        if (s.maximized) toggleMaximize(id);
        if (s.fullscreen) toggleFullscreen(id);
        n++;
      });
      if (activeId) focusWindow(activeId);
    } finally {
      restoring = false;
    }
    // 夹取后的几何可能与存档不同，同步一次让存档与现状一致
    if (n) saveWindowsNow();
    return n;
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 窗口
   * ═══════════════════════════════════════════════════════════════════ */
  function defaultGeom(index) {
    var wa = workArea();
    // 窄屏：直接用满可用区（手机上开个小窗口没意义）
    if (narrow()) return { x: 6, y: 6, w: wa.w - 12, h: wa.h - 12 };

    var wd = (cfg && cfg.windowDefaults) || {};
    var w = clamp(Number(wd.w) || 860, 320, Math.max(320, wa.w - 16));
    var h = clamp(Number(wd.h) || 580, 220, Math.max(220, wa.h - 16));

    // 首选位置由「新建窗口默认位置」决定：
    //   cascade   —— 每开一个稍微错开，像真桌面那样能看见下面那张
    //   center    —— 正中
    //   large     —— 尽量铺满可用区（尺寸也不受 wd 限制）
    //   halfLeft / halfRight / quarter —— 平铺分区
    var mode = wd.preset || 'cascade';
    if (mode === 'large') {
      w = Math.max(320, wa.w - 120);
      h = Math.max(220, wa.h - 120);
      mode = 'center';
    }
    if (mode === 'center') {
      return {
        x: clamp(Math.round((wa.w - w) / 2), 8, Math.max(8, wa.w - w - 8)),
        y: clamp(wa.top + Math.round((wa.h - h) / 2), wa.top, Math.max(wa.top, wa.bottom - h - 6)),
        w: w, h: h,
      };
    }
    if (mode === 'halfLeft' || mode === 'halfRight') {
      var hw = Math.max(320, Math.floor(wa.w / 2) - 10);
      return {
        x: mode === 'halfLeft' ? 8 : Math.max(8, wa.w - hw - 8),
        y: wa.top + 8,
        w: hw, h: Math.max(220, wa.h - 24),
      };
    }
    if (mode === 'quarter') {
      var qw = Math.max(280, Math.floor(wa.w / 2) - 10);
      var qh = Math.max(200, Math.floor(wa.h / 2) - 10);
      var qn = index % 4;
      return {
        x: (qn % 2) ? Math.max(8, wa.w - qw - 8) : 8,
        y: wa.top + ((qn >= 2) ? Math.floor(wa.h / 2) : 8),
        w: qw, h: qh,
      };
    }
    // cascade（默认）
    var off = (index % 6) * 26;
    return {
      x: clamp(48 + off, 8, Math.max(8, wa.w - w - 8)),
      y: clamp(wa.top + 20 + off, wa.top, Math.max(wa.top, wa.bottom - h - 6)),
      w: w, h: h,
    };
  }

  function narrow() {
    return !!(root.clientWidth && root.clientWidth <= 680);
  }

  /**
   * 打开应用窗口。
   * @param {string} name  应用名
   * @param {{silent?:boolean, geom?:object}} [opts]
   *        silent —— 恢复流程中调用：不弹提示、不抢焦点、不触发落盘（由
   *                  restoreWindows 统一收尾），避免刷新时一串提示糊满屏
   *        geom   —— 指定初始几何（恢复存档时用），不传则走 defaultGeom
   * @returns {string|null} 窗口 id（已存在则返回既有 id）
   */
  function openApp(name, opts) {
    opts = opts || {};
    var app = appOf(name);
    if (!app) { showToast('找不到应用「' + name + '」'); return null; }
    var id = winId(name);

    var rec = windows[id];
    if (rec) {
      if (rec.hidden || rec.minimized) showWindow(id);
      else focusWindow(id);
      return id;
    }

    var g = opts.geom || defaultGeom(order.length);
    // 窄屏用紧凑工具栏：手机上垂直空间比「控件好按」更稀缺
    var initialStyle = narrow() ? 'unifiedCompact' : 'unified';
    var w = el('div', 'rx-window rx-material-regular' +
      (initialStyle !== 'unified' ? ' ' + initialStyle : ''));
    w.style.left = px(g.x);
    w.style.top = px(g.y);
    w.style.width = px(g.w);
    w.style.height = px(g.h);
    w.dataset.winId = id;
    w.setAttribute('role', 'dialog');
    w.setAttribute('aria-label', appTitle(app));

    /* — 工具栏（§3.1：承载窗口控件、标题和工具栏项）— */
    var toolbar = el('div', 'rx-win-toolbar');

    var dots = el('div', 'rx-win-dots');
    var bClose = el('button', 'rx-dot close');
    bClose.setAttribute('title', '关闭');
    bClose.setAttribute('aria-label', '关闭窗口');
    var bMin = el('button', 'rx-dot min');
    bMin.setAttribute('title', '最小化');
    bMin.setAttribute('aria-label', '最小化窗口');
    var bMax = el('button', 'rx-dot max');
    bMax.setAttribute('title', '最大化（双击进入全屏）');
    bMax.setAttribute('aria-label', '最大化窗口');
    dots.appendChild(bClose); dots.appendChild(bMin); dots.appendChild(bMax);

    var titleZone = el('div', 'rx-win-title-zone');
    var title = el('div', 'rx-win-title', appTitle(app));
    var subtitle = el('div', 'rx-win-subtitle',
      app.type === 'node' ? ('node · :' + app.port) : 'web');
    titleZone.appendChild(title);
    titleZone.appendChild(subtitle);

    var tools = el('div', 'rx-win-tools');
    var bHome = toolBtn(ICON.home, '回到应用首页', function () {
      iframe.src = appOrigin(app);
      failCount = 0; veil.classList.remove('hidden'); veilHint.textContent = '正在加载…';
    });
    var bReload = toolBtn(ICON.reload, '重新加载', function () {
      iframe.src = appOrigin(app);
      failCount = 0; veil.classList.remove('hidden'); veilHint.textContent = '正在加载…';
    });
    // 窗口工具栏样式切换（§3.1：unified / unifiedCompact / expanded）
    var styleGroup = el('div', 'rx-segmented rx-no-drag');
    styleGroup.setAttribute('role', 'tablist');
    styleGroup.setAttribute('aria-label', '工具栏样式');
    var STYLES = [['unified', '统一'], ['unifiedCompact', '紧凑'], ['expanded', '展开']];
    STYLES.forEach(function (pair) {
      var b = el('button', null, pair[1]);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', pair[0] === initialStyle ? 'true' : 'false');
      b.addEventListener('click', function () {
        setToolbarStyle(id, pair[0]);
        var kids = styleGroup.children;
        for (var i = 0; i < kids.length; i++) kids[i].setAttribute('aria-selected', 'false');
        b.setAttribute('aria-selected', 'true');
      });
      styleGroup.appendChild(b);
    });
    var bFull = toolBtn(ICON.expand, '全屏 (⌘⌃F)', function () { toggleFullscreen(id); });

    tools.appendChild(bHome);
    tools.appendChild(bReload);
    tools.appendChild(el('div', 'rx-tool-sep'));
    tools.appendChild(styleGroup);
    tools.appendChild(el('div', 'rx-tool-sep'));
    tools.appendChild(bFull);

    toolbar.appendChild(dots);
    toolbar.appendChild(titleZone);
    toolbar.appendChild(tools);

    /* — 内容区 — */
    var body = el('div', 'rx-win-body');
    var iframe = el('iframe');
    iframe.setAttribute('allow', 'autoplay; fullscreen; clipboard-read; clipboard-write');
    iframe.setAttribute('referrerpolicy', 'same-origin');

    var veil = el('div', 'rx-win-veil');
    var veilInner = el('div', 'rx-win-veil-inner');
    var spin = el('div', 'rx-spinner');
    var veilHint = el('div', null, '正在加载…');
    veilInner.appendChild(spin);
    veilInner.appendChild(veilHint);
    veil.appendChild(veilInner);

    var shield = el('div', 'rx-win-shield');

    body.appendChild(iframe);
    body.appendChild(shield);
    body.appendChild(veil);

    w.appendChild(toolbar);
    w.appendChild(body);

    /* — 八向缩放手柄 — */
    ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].forEach(function (dir) {
      var h = el('div', 'rx-win-resize');
      h.dataset.dir = dir;
      h.addEventListener('mousedown', function (e) { startResize(e, id, dir); });
      h.addEventListener('touchstart', function (e) { startResize(e, id, dir); }, { passive: false });
      w.appendChild(h);
    });

    surface.appendChild(w);

    var failCount = 0;
    iframe.addEventListener('load', function () {
      veil.classList.add('hidden');
      // 探测页面是否真的有内容（应用没起来时 iframe 会是错误页 / 空白）
      try {
        var d = iframe.contentDocument;
        if (d && (d.body === null || (d.body.textContent || '').trim() === '')) {
          veilHint.textContent = '应用还没响应，正在重试…';
          veil.classList.remove('hidden');
        }
      } catch (err) { /* 跨源读不到，说明加载正常 */ }
    });
    iframe.addEventListener('error', function () { onLoadFail(); });

    function onLoadFail() {
      failCount++;
      veilHint.textContent = failCount < 3
        ? '应用进程还没就绪，正在重试（' + failCount + '/3）…'
        : '应用没有响应。可以在「' + appTitle(app) + '」菜单里点「启动应用」，或检查内核日志。';
      veil.classList.remove('hidden');
      if (failCount <= 3) {
        setTimeout(function () {
          if (windows[id] && failCount <= 3) iframe.src = appOrigin(app);
        }, safeMs(1500 * failCount, 1500, 400, 12000));
      }
    }

    // 应用若是 node 且没在跑，先让 supervisor 拉起来再连（避免必然的第一次失败）
    if (app.type === 'node' && !isRunning(app)) {
      veilHint.textContent = '正在启动应用…';
      api('/apps/' + encodeURIComponent(name) + '/start', { method: 'POST' })
        .then(function () { return refreshApps(); })
        .then(function () { iframe.src = appOrigin(app); })
        .catch(function (e) {
          veilHint.textContent = '启动失败：' + e.message + '（可以点工具栏的刷新重试）';
        });
    } else {
      iframe.src = appOrigin(app);
    }

    var recNew = {
      id: id, app: app, el: w, iframe: iframe, title: title, subtitle: subtitle,
      geom: { x: g.x, y: g.y, w: g.w, h: g.h },
      restored: null,          // 最大化/全屏前的几何
      minimized: false,        // 收进 Dock（内容仍在跑）
      hidden: false,           // 完全隐藏（相当于关闭但保留进程）
      fullscreen: false, maximized: false,
      toolbarStyle: initialStyle,
      veil: veil, veilHint: veilHint, tools: tools,
      openTs: Date.now(),
    };
    windows[id] = recNew;
    order.push(id);

    bClose.addEventListener('click', function (e) { e.stopPropagation(); closeWindow(id, true); });
    bMin.addEventListener('click', function (e) { e.stopPropagation(); minimizeWindow(id); });
    bMax.addEventListener('click', function (e) { e.stopPropagation(); toggleMaximize(id); });
    bMax.addEventListener('dblclick', function (e) { e.stopPropagation(); toggleFullscreen(id); });

    // 拖动 / 聚焦
    toolbar.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('button, input, .rx-no-drag, .rx-segmented')) return;
      startDrag(e, id);
    });
    toolbar.addEventListener('touchstart', function (e) {
      if (e.target.closest && e.target.closest('button, input, .rx-no-drag, .rx-segmented')) return;
      startDrag(e, id);
    }, { passive: false });
    toolbar.addEventListener('dblclick', function (e) {
      if (e.target.closest && e.target.closest('button, input, .rx-no-drag, .rx-segmented')) return;
      toggleMaximize(id);
    });
    w.addEventListener('mousedown', function () { focusWindow(id); }, true);
    w.addEventListener('touchstart', function () { focusWindow(id); }, { passive: true, capture: true });
    // 右键窗口工具栏 → 窗口操作菜单
    toolbar.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var p = pointOfPhysical(e);
      openContextMenu(p.x, p.y, windowMenuItems(id));
    });
    // 同上的触屏等价物：工具栏空白处长按也能调出窗口菜单
    bindLongPress(toolbar, function (x, y) {
      openContextMenu(x, y, windowMenuItems(id));
    }, { when: function () { return !dragState; } });

    focusWindow(id);
    if (!opts.silent) {
      announce(appTitle(app) + ' 已打开');
      renderDock();
      saveWindows();          // 新窗口出现 → 记一笔，刷新后还能复原
    }
    return id;
  }

  function toolBtn(path, label, onClick) {
    var b = el('button', 'rx-tool');
    b.appendChild(svgIcon(path));
    b.setAttribute('title', label);
    b.setAttribute('aria-label', label);
    b.addEventListener('click', function (e) { e.stopPropagation(); onClick(); });
    return b;
  }

  function setToolbarStyle(id, style) {
    var rec = windows[id];
    if (!rec) return;
    rec.toolbarStyle = style;
    rec.el.classList.remove('unified', 'unifiedCompact', 'expanded');
    if (style !== 'unified') rec.el.classList.add(style);
    announce('工具栏样式：' + ({ unified: '统一', unifiedCompact: '紧凑', expanded: '展开' }[style] || style));
    saveWindows();            // 工具栏样式属于窗口偏好，值得记
  }

  function focusWindow(id) {
    var rec = windows[id];
    if (!rec) return;
    zTop++; rec.el.style.zIndex = zTop;
    activeId = id;
    for (var k in windows) {
      if (!Object.prototype.hasOwnProperty.call(windows, k)) continue;
      windows[k].el.classList.toggle('focused', k === id);
    }
    renderDock();
    renderMenus();
  }

  /** 隐藏：内容继续跑，只是不占屏幕（§3.1「隐藏」） */
  function hideWindow(id) {
    var rec = windows[id];
    if (!rec) return;
    rec.hidden = true;
    rec.el.style.display = 'none';
    if (activeId === id) activeId = nextVisibleId(id);
    renderDock(); renderMenus();
    announce(appTitle(rec.app) + ' 已隐藏');
  }
  function showWindow(id) {
    var rec = windows[id];
    if (!rec) return;
    rec.minimized = false;
    rec.hidden = false;
    // 关键：必须摘掉 minimizing 与 data-min（minimizing 的终态是 opacity:0）。
    // 只把 display 改回 flex 而留着它们，窗口会以全透明「恢复」——
    // 元素在、尺寸对、就是看不见也点不到（用户看到的是整个桌面失去响应）。
    rec.el.classList.remove('minimizing');
    delete rec.el.dataset.min;
    rec.el.style.display = 'flex';

    // 重新入场：从缩小 + 半透明浮上来，让用户看清是哪张窗口回来了
    try {
      rec.el.animate(
        [{ opacity: 0, transform: 'scale(0.94) translateY(14px)' },
         { opacity: 1, transform: 'none' }],
        { duration: 220, easing: 'cubic-bezier(0.22,1,0.36,1)' }
      );
    } catch (e) { /* 老浏览器不支持 WAAPI：没有动画也不影响可用性 */ }

    focusWindow(id);
    announce(appTitle(rec.app) + ' 已显示');
  }

  function minimizeWindow(id) {
    var rec = windows[id];
    if (!rec) return;
    rec.minimized = true;
    rec.el.dataset.min = '1';
    rec.el.classList.add('minimizing');
    setTimeout(function () {
      if (!windows[id] || !windows[id].minimized) return;
      windows[id].el.style.display = 'none';
    }, safeMs(200, 200, 0, 1200));
    if (activeId === id) activeId = nextVisibleId(id);
    renderDock(); renderMenus();
    saveWindows();            // 最小化状态也记下来：刷新后它仍在 Dock 里而不是弹回来
    announce(appTitle(rec.app) + ' 已最小化');
  }
  function nextVisibleId(exceptId) {
    for (var i = order.length - 1; i >= 0; i--) {
      var id = order[i];
      if (id === exceptId) continue;
      var r = windows[id];
      if (r && !r.hidden && !r.minimized) return id;
    }
    return null;
  }

  /** 关闭：真的销毁窗口（node 应用的进程由 supervisor 管，不随窗口关闭而停） */
  function closeWindow(id, notify) {
    var rec = windows[id];
    if (!rec) return;
    try { rec.iframe.src = 'about:blank'; } catch (e) { /* 忽略 */ }
    rec.el.remove();
    delete windows[id];
    var i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
    if (activeId === id) activeId = nextVisibleId(id);
    if (activeId) focusWindow(activeId);
    renderDock(); renderMenus();
    saveWindows();            // 关掉的窗口不该在刷新后复活
    if (notify !== false) announce(appTitle(rec.app) + ' 已关闭');
  }

  function toggleMaximize(id) {
    var rec = windows[id];
    if (!rec) return;
    if (rec.fullscreen) toggleFullscreen(id);       // 全屏下按最大化 → 退回窗口
    if (rec.maximized) {
      restoreGeom(rec);
      rec.maximized = false;
      rec.el.classList.remove('maximized');
      announce('已退出最大化');
    } else {
      rec.restored = currentGeom(rec);
      var wa = workArea();
      applyGeom(rec, { x: wa.left, y: wa.top, w: wa.w, h: wa.h });
      rec.maximized = true;
      rec.el.classList.add('maximized');
      announce('已最大化');
    }
    saveWindows();
  }

  function toggleFullscreen(id) {
    var rec = windows[id];
    if (!rec) return;
    if (rec.fullscreen) {
      rec.el.classList.remove('fullscreen');
      rec.fullscreen = false;
      restoreGeom(rec);
      announce('已退出全屏');
    } else {
      if (!rec.maximized) rec.restored = currentGeom(rec);
      applyGeom(rec, { x: 0, y: 0, w: viewport().w, h: viewport().h });
      rec.el.classList.add('fullscreen');
      rec.fullscreen = true;
      rec.maximized = false;
      announce('已进入全屏，按 ⌘⌃F 或 Esc 退出');
    }
    saveWindows();
  }

  function currentGeom(rec) {
    return {
      x: rec.el.offsetLeft, y: rec.el.offsetTop,
      w: rec.el.offsetWidth, h: rec.el.offsetHeight,
    };
  }
  function applyGeom(rec, g) {
    rec.el.style.left = px(g.x);
    rec.el.style.top = px(g.y);
    rec.el.style.width = px(g.w);
    rec.el.style.height = px(g.h);
  }
  function restoreGeom(rec) {
    var g = rec.restored;
    rec.restored = null;
    if (g) applyGeom(rec, g);
    else applyGeom(rec, defaultGeom(0));
  }

  /* — 拖动 — */
  var dragState = null;
  function startDrag(e, id) {
    var rec = windows[id];
    if (!rec || rec.fullscreen) return;               // 全屏下没有可拖的空间
    if (e.button != null && e.button !== 0) return;
    var p = pointOf(e);
    var g = currentGeom(rec);

    // 最大化状态拖动 → 先还原成窗口再跟手（沿用桌面习惯）
    if (rec.maximized) {
      var ratio = (p.x - g.x) / Math.max(1, g.w);
      toggleMaximize(id);
      g = currentGeom(rec);
      g.x = Math.round(p.x - g.w * ratio);
      applyGeom(rec, g);
    }
    dragState = { id: id, sx: p.x, sy: p.y, ox: g.x, oy: g.y, moved: false };
    rec.el.classList.add('dragging');
    focusWindow(id);
    bindGlobal(dragMove, dragEnd);
    if (e.cancelable) e.preventDefault();
  }
  function dragMove(e) {
    if (!dragState) return;
    var rec = windows[dragState.id];
    if (!rec) { dragEnd(); return; }
    var p = pointOf(e);
    var dx = p.x - dragState.sx, dy = p.y - dragState.sy;
    if (!dragState.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    dragState.moved = true;
    var wa = workArea();
    var view = viewport();
    var g = currentGeom(rec);

    // —— 约束：必须始终留出可抓的区域 ——
    // 水平：至少 120px 的标题栏留在视口里（否则拖到屏幕外就再也抓不回来）
    // 垂直：标题栏不得钻进导航条上方，也不得落到导航条之下
    var keepH = Math.min(120, g.w * 0.5);
    var minX = -(g.w - keepH);
    var maxX = view.w - keepH;
    var minY = wa.top;
    var maxY = view.h - 34;

    rec.el.style.left = px(clamp(dragState.ox + dx, minX, maxX));
    rec.el.style.top = px(clamp(dragState.oy + dy, minY, maxY));
    if (e.cancelable && e.type === 'touchmove') e.preventDefault();
  }
  function dragEnd() {
    if (!dragState) return;
    var rec = windows[dragState.id];
    if (rec) {
      rec.el.classList.remove('dragging');
      rec.geom = currentGeom(rec);
      // 松手吸附：贴到 8px 网格，桌面看起来是「摆放」而不是「漂着」
      var snapped = {
        x: Math.round(rec.geom.x / 8) * 8,
        y: Math.round(rec.geom.y / 8) * 8,
        w: rec.geom.w, h: rec.geom.h,
      };
      applyGeom(rec, snapped);
      rec.geom = snapped;
      saveWindows();          // 落位完成才写盘（拖动过程中不写）
    }
    dragState = null;
    unbindGlobal(dragMove, dragEnd);
  }

  /* — 缩放 — */
  var resizeState = null;
  function startResize(e, id, dir) {
    var rec = windows[id];
    if (!rec || rec.fullscreen || rec.maximized) return;
    if (e.button != null && e.button !== 0) return;
    var p = pointOf(e);
    var g = currentGeom(rec);
    resizeState = {
      id: id, dir: dir, sx: p.x, sy: p.y,
      ox: g.x, oy: g.y, ow: g.w, oh: g.h,
    };
    rec.el.classList.add('resizing');
    focusWindow(id);
    bindGlobal(resizeMove, resizeEnd);
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
  }
  function resizeMove(e) {
    if (!resizeState) return;
    var rec = windows[resizeState.id];
    if (!rec) { resizeEnd(); return; }
    var s = resizeState;
    var p = pointOf(e);
    var dx = p.x - s.sx, dy = p.y - s.sy;
    var wa = workArea();
    var minW = 280, minH = 180;

    var x = s.ox, y = s.oy, w = s.ow, h = s.oh;
    if (s.dir.indexOf('e') >= 0) w = clamp(s.ow + dx, minW, wa.w - s.ox);
    if (s.dir.indexOf('s') >= 0) h = clamp(s.oh + dy, minH, wa.bottom - s.oy);
    if (s.dir.indexOf('w') >= 0) {
      w = clamp(s.ow - dx, minW, s.ox + s.ow);
      x = s.ox + s.ow - w;
    }
    if (s.dir.indexOf('n') >= 0) {
      h = clamp(s.oh - dy, minH, s.oy + s.oh - wa.top);
      y = s.oy + s.oh - h;
    }
    applyGeom(rec, { x: x, y: y, w: w, h: h });
    if (e.cancelable && e.type === 'touchmove') e.preventDefault();
  }
  function resizeEnd() {
    if (!resizeState) return;
    var rec = windows[resizeState.id];
    if (rec) {
      rec.el.classList.remove('resizing');
      rec.geom = currentGeom(rec);
      showToastRect(rec);
      saveWindows();          // 缩放结束才写盘
    }
    resizeState = null;
    unbindGlobal(resizeMove, resizeEnd);
  }
  function showToastRect(rec) {
    var g = rec.geom || currentGeom(rec);
    // 只更新副标题（尺寸），不做弹窗 —— 拖动中的反馈要轻
    if (rec.subtitle) {
      rec.subtitle.textContent = (rec.app.type === 'node' ? 'node · :' + rec.app.port + ' · ' : '') +
        Math.round(g.w) + ' × ' + Math.round(g.h);
    }
  }

  function bindGlobal(move, end) {
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
  }
  function unbindGlobal(move, end) {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', end);
    window.removeEventListener('touchmove', move);
    window.removeEventListener('touchend', end);
    window.removeEventListener('touchcancel', end);
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Dock（§3.4：主要半透明元素，浮动 Liquid Glass）
   * ═══════════════════════════════════════════════════════════════════ */
  function renderDock() {
    var old = root.querySelector('.rx-dock');
    if (old) old.remove();
    var pos = (cfg && cfg.taskbar && cfg.taskbar.position) || 'bottom';
    surface.classList.toggle('has-dock', pos !== 'none');
    if (pos === 'none') return;

    var dock = el('div', 'rx-dock rx-material-thin');
    dock.setAttribute('role', 'toolbar');
    dock.setAttribute('aria-label', '应用坞');

    var ids = order.slice();
    if (!ids.length) {
      dock.appendChild(el('div', 'rx-dock-hint', '双击桌面图标打开应用'));
    }

    ids.forEach(function (id) {
      var rec = windows[id];
      if (!rec) return;
      var active = id === activeId && !rec.minimized && !rec.hidden;
      var b = el('button', 'rx-dock-item' + (active ? ' active' : '') +
        (rec.minimized || rec.hidden ? ' minimized' : ''));
      b.setAttribute('title', appTitle(rec.app) +
        (rec.minimized ? '（已最小化）' : rec.hidden ? '（已隐藏）' : ''));

      var url = appIconUrl(rec.app);
      if (url) {
        var img = el('img', 'rx-dock-ico');
        img.src = url; img.alt = ''; img.draggable = false;
        img.addEventListener('error', function () {
          var ph = el('span', 'rx-dock-ico', '📦');
          if (img.parentNode) img.parentNode.replaceChild(ph, img);
        });
        b.appendChild(img);
      } else {
        b.appendChild(el('span', 'rx-dock-ico', '📦'));
      }
      b.appendChild(el('span', 'rx-dock-name', appTitle(rec.app)));
      b.appendChild(el('span', 'rx-dock-ind'));

      b.addEventListener('click', function () {
        if (rec.hidden || rec.minimized) showWindow(id);
        else if (id === activeId) minimizeWindow(id);
        else focusWindow(id);
      });
      b.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var p = pointOfPhysical(e);
        openContextMenu(p.x, p.y, windowMenuItems(id));
      });
      // 触屏长按 Dock 图标：先震一下再弹菜单（震动是「触发了」的体感信号）
      bindLongPress(b, function (x, y) {
        openContextMenu(x, y, windowMenuItems(id));
      });
      dock.appendChild(b);
    });

    // 已登记但没开窗口的应用：一键启动（紧凑图标）
    var closed = apps.filter(function (a) { return !windows[winId(a.name)]; });
    if (closed.length) {
      if (ids.length) dock.appendChild(el('div', 'rx-dock-sep'));
      closed.slice(0, 8).forEach(function (a) {
        var b = el('button', 'rx-dock-item rx-dock-launcher');
        b.setAttribute('title', '打开 ' + appTitle(a));
        b.setAttribute('aria-label', '打开 ' + appTitle(a));
        var url = appIconUrl(a);
        if (url) {
          var img = el('img', 'rx-dock-ico');
          img.src = url; img.alt = ''; img.draggable = false;
          b.appendChild(img);
        } else {
          b.appendChild(el('span', 'rx-dock-ico', '📦'));
        }
        b.addEventListener('click', function () { openApp(a.name); });
        dock.appendChild(b);
      });
    }

    vscreen.appendChild(dock);
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 菜单（§3.2 菜单栏：App / 文件 / 编辑 / 显示 / 窗口 / 帮助）
   *
   * 大量命令是窗口级操作 —— 这正是 RunX 的交互范式：菜单栏是命令的
   * 唯一总入口，不依赖记忆快捷键。
   * ═══════════════════════════════════════════════════════════════════ */
  function menuDefs() {
    var rec = activeId ? windows[activeId] : null;
    var hasWin = !!rec;
    var disabled = !hasWin;
    var name = rec ? appTitle(rec.app) : 'RunX OS';

    var appMenu = [
      { label: '关于 RunX OS', glyph: 'ⓘ', act: showAbout },
      { sep: true },
      { label: '应用管理…', glyph: '▦', key: '⌘⇧A', act: openAppManager },
      { label: '桌面设置…', glyph: '⚙', key: '⌘,', act: openSettings },
      { sep: true },
      { label: '隐藏 ' + name, key: '⌘H', disabled: disabled, act: function () { hideWindow(activeId); } },
      { label: '隐藏其他', key: '⌘⌥H', disabled: disabled, act: hideOthers },
      { sep: true },
      { label: '退出 RunX OS 桌面', key: '⌘Q', act: function () {
          confirmAction('退出桌面', '桌面外壳会从页面上移除（内核继续运行）。按 F5 即可重新进入。', function () {
            root.remove();
            location.reload();
          });
        } },
    ];

    var fileMenu = [
      { label: '打开应用…', glyph: '↗', key: '⌘O', act: openLauncher },
      { label: '重新加载应用', glyph: '⟳', key: '⌘R', disabled: disabled, act: function () {
          var r = windows[activeId]; if (!r) return;
          r.veilHint.textContent = '正在加载…'; r.veil.classList.remove('hidden');
          r.iframe.src = appOrigin(r.app);
        } },
      { label: '让应用在浏览器新标签打开', glyph: '⎋', disabled: disabled, act: function () {
          var r = windows[activeId]; if (!r) return;
          window.open(appOrigin(r.app), '_blank', 'noopener');
        } },
      { sep: true },
      { label: '启动应用进程', glyph: '▶', disabled: disabled || isRunning(rec.app), act: function () {
          api('/apps/' + encodeURIComponent(rec.app.name) + '/start', { method: 'POST' })
            .then(refreshApps).then(function () { showToast('已启动 ' + appTitle(rec.app)); })
            .catch(function (e) { showToast('启动失败：' + e.message); });
        } },
      { label: '停止应用进程', glyph: '■', disabled: disabled || !isRunning(rec.app), act: function () {
          api('/apps/' + encodeURIComponent(rec.app.name) + '/stop', { method: 'POST' })
            .then(refreshApps).then(function () { showToast('已停止 ' + appTitle(rec.app)); })
            .catch(function (e) { showToast('停止失败：' + e.message); });
        } },
      { sep: true },
      { label: '关闭窗口', key: '⌘W', disabled: disabled, act: function () { closeWindow(activeId); } },
    ];

    var editMenu = [
      { label: '撤销', key: '⌘Z', disabled: disabled, act: function () { postToApp('undo'); } },
      { label: '重做', key: '⌘⇧Z', disabled: disabled, act: function () { postToApp('redo'); } },
      { sep: true },
      { label: '剪切', key: '⌘X', disabled: disabled, act: function () { postToApp('cut'); } },
      { label: '拷贝', key: '⌘C', disabled: disabled, act: function () { postToApp('copy'); } },
      { label: '粘贴', key: '⌘V', disabled: disabled, act: function () { postToApp('paste'); } },
      { label: '全选', key: '⌘A', disabled: disabled, act: function () { postToApp('selectAll'); } },
      { sep: true },
      { label: '在应用中查找…', glyph: '⌕', key: '⌘F', disabled: disabled, act: function () { postToApp('find'); } },
      { label: '清空终端会话', glyph: '⌫', disabled: disabled, act: function () {
          // 终端应用的清屏：往它的窗口里注入一条输入（应用自己解释）
          var r = windows[activeId];
          if (!r) return;
          try { r.iframe.contentWindow.postMessage({ runx: 'command', id: 'clear' }, '*'); }
          catch (e) { showToast('该应用不支持清屏'); }
        } },
    ];

    var viewMenu = [
      { label: rec && rec.fullscreen ? '退出全屏' : '进入全屏', glyph: '⛶', key: '⌘⌃F', disabled: disabled,
        act: function () { toggleFullscreen(activeId); } },
      { label: rec && rec.maximized ? '退出最大化' : '最大化', glyph: '▢', key: '⌘⌃M', disabled: disabled,
        act: function () { toggleMaximize(activeId); } },
      { label: '恢复正常大小', disabled: disabled || !(rec && (rec.maximized || rec.fullscreen)),
        act: function () {
          var r = windows[activeId]; if (!r) return;
          if (r.fullscreen) toggleFullscreen(activeId);
          if (r.maximized) toggleMaximize(activeId);
        } },
      { sep: true },
      { head: '工具栏样式' },
      { label: '统一', glyph: rec && rec.toolbarStyle === 'unified' ? '✓' : '', disabled: disabled,
        act: function () { setToolbarStyle(activeId, 'unified'); syncSegment(activeId, 'unified'); } },
      { label: '紧凑统一', glyph: rec && rec.toolbarStyle === 'unifiedCompact' ? '✓' : '', disabled: disabled,
        act: function () { setToolbarStyle(activeId, 'unifiedCompact'); syncSegment(activeId, 'unifiedCompact'); } },
      { label: '展开', glyph: rec && rec.toolbarStyle === 'expanded' ? '✓' : '', disabled: disabled,
        act: function () { setToolbarStyle(activeId, 'expanded'); syncSegment(activeId, 'expanded'); } },
      { sep: true },
      { head: '外观' },
      { label: '浅色', glyph: cfg && cfg.theme === 'light' ? '✓' : '', act: function () { setTheme('light'); } },
      { label: '深色', glyph: cfg && cfg.theme === 'dark' ? '✓' : '', act: function () { setTheme('dark'); } },
      { label: '跟随系统', glyph: !cfg || cfg.theme === 'auto' ? '✓' : '', act: function () { setTheme('auto'); } },
      { sep: true },
      { head: '显示分辨率' },
    ];

    // 分辨率与强调色的快捷项直接由服务端下发的枚举生成 ——
    // 加一个预设只改服务端，菜单自动多一项，不会两边不同步。
    ((cfg && cfg.meta && cfg.meta.display_presets) || []).forEach(function (p) {
      var on = ((cfg.display && cfg.display.preset) || 'auto') === p.id;
      viewMenu.push({
        label: p.label, glyph: on ? '✓' : '',
        act: function () { setDisplay({ preset: p.id, scale: p.scale || 'fit' }); },
      });
    });
    viewMenu.push({ label: '显示设置…', glyph: '⚙', act: openSettings });

    viewMenu.push({ sep: true }, { head: '强调色' });
    ((cfg && cfg.meta && cfg.meta.accents) || []).forEach(function (a) {
      viewMenu.push({
        label: a.label, glyph: (cfg.accent || 'blue') === a.id ? '✓' : '',
        act: function () { setAccent(a.id); },
      });
    });

    var windowMenu = [
      { label: '最小化', key: '⌘M', disabled: disabled, act: function () { minimizeWindow(activeId); } },
      { label: '隐藏', key: '⌘H', disabled: disabled, act: function () { hideWindow(activeId); } },
      { label: '显示全部隐藏窗口', disabled: order.every(function (id) {
          return !windows[id].hidden && !windows[id].minimized;
        }), act: showAll },
      { sep: true },
      { head: '窗口（' + order.length + '）' },
    ];
    order.slice().reverse().forEach(function (id) {
      var r = windows[id];
      if (!r) return;
      windowMenu.push({
        label: appTitle(r.app) + (r.hidden ? '（已隐藏）' : r.minimized ? '（已最小化）' : ''),
        glyph: id === activeId ? '●' : '',
        act: (function (wid) {
          return function () {
            var t = windows[wid]; if (!t) return;
            if (t.hidden || t.minimized) showWindow(wid); else focusWindow(wid);
          };
        })(id),
      });
    });
    if (!order.length) windowMenu.push({ label: '没有打开的窗口', disabled: true });

    var helpMenu = [
      { label: '快捷键', glyph: '⌘', act: showShortcuts },
      { label: 'RunX OS 文档', glyph: '?', act: function () { window.open(BASE + '/docs', '_blank', 'noopener'); } },
      { label: '内核状态', glyph: '⚡', act: showKernel },
      { sep: true },
      { label: '关于 RunX OS', act: showAbout },
    ];

    return [
      { label: name, cls: 'app', items: appMenu },
      { label: '文件', items: fileMenu },
      { label: '编辑', items: editMenu },
      { label: '显示', items: viewMenu },
      { label: '窗口', items: windowMenu },
      { label: '帮助', items: helpMenu },
    ];
  }

  function renderMenus() {
    // 记住已展开的根菜单，重绘后原位重开（否则聚焦变化会把菜单关掉，很打断操作）
    var reopen = openMenu && openMenu.dataset ? openMenu.dataset.rootLabel : null;
    menuHost.textContent = '';
    var defs = menuDefs();
    defs.forEach(function (def) {
      var b = el('button', 'rx-menu-root' + (def.cls ? ' ' + def.cls : ''), def.label);
      b.dataset.rootLabel = def.label;
      b.setAttribute('role', 'menuitem');
      b.setAttribute('aria-haspopup', 'true');
      b.setAttribute('aria-expanded', 'false');
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (openMenu && openMenu.dataset.rootLabel === def.label) { closeMenu(); return; }
        openMenuAt(b, def.items);
      });
      // 菜单栏滑过即切换（macOS 行为），但只在已有菜单打开时
      b.addEventListener('mouseenter', function () {
        if (openMenu && openMenu.dataset.rootLabel !== def.label) openMenuAt(b, def.items);
      });
      menuHost.appendChild(b);
    });
    if (reopen) {
      var again = menuHost.querySelector('[data-root-label="' + cssEscape(reopen) + '"]');
      if (again) {
        var d = defs.filter(function (x) { return x.label === reopen; })[0];
        if (d) openMenuAt(again, d.items);
      }
    } else {
      closeMenu();
    }
  }

  function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function syncSegment(id, style) {
    var rec = windows[id];
    if (!rec || !rec.tools) return;
    var group = rec.tools.querySelector('.rx-segmented');
    if (!group) return;
    for (var i = 0; i < group.children.length; i++) {
      var b = group.children[i];
      var want = [null, 'unified', 'unifiedCompact', 'expanded'][i + 0];
      // 顺序固定：统一 / 紧凑 / 展开
      var map = ['unified', 'unifiedCompact', 'expanded'];
      b.setAttribute('aria-selected', map[i] === style ? 'true' : 'false');
    }
  }

  function openMenuAt(rootBtn, items) {
    closeMenu();
    var r = rootBtn.getBoundingClientRect();
    var m = buildMenu(items);
    m.dataset.rootLabel = rootBtn.dataset.rootLabel;
    m.style.left = px(clamp(r.left, 6, viewport().w - 216));
    m.style.top = px(r.bottom + 3);
    vscreen.appendChild(m);
    openMenu = m;
    rootBtn.setAttribute('aria-expanded', 'true');
    // 超出视口就往上贴
    var mr = m.getBoundingClientRect();
    if (mr.bottom > viewport().h - 6) m.style.top = px(Math.max(6, r.top - mr.height - 3));
  }

  function buildMenu(items) {
    var m = el('div', 'rx-menu rx-material-thick');
    m.setAttribute('role', 'menu');
    items.forEach(function (it) {
      if (it.sep) { m.appendChild(el('div', 'rx-menu-sep')); return; }
      if (it.head) { m.appendChild(el('div', 'rx-menu-head', it.head)); return; }
      var b = el('button', 'rx-menu-item' + (it.destructive ? ' destructive' : ''));
      b.setAttribute('role', 'menuitem');
      var g = el('span', 'rx-menu-glyph', it.glyph || '');
      b.appendChild(g);
      b.appendChild(el('span', 'rx-menu-label', it.label));
      if (it.key) b.appendChild(el('span', 'rx-menu-key', it.key));
      if (it.disabled) b.setAttribute('disabled', '');
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        closeMenu();
        if (!it.disabled && it.act) it.act();
      });
      m.appendChild(b);
    });
    return m;
  }

  function closeMenu() {
    if (!openMenu) return;
    var rootLabel = openMenu.dataset.rootLabel;
    openMenu.remove();
    openMenu = null;
    var b = menuHost.querySelector('[data-root-label="' + cssEscape(rootLabel || '') + '"]');
    if (b) b.setAttribute('aria-expanded', 'false');
  }

  /** 桌面右键菜单 */
  function desktopMenuItems() {
    var items = [
      { label: '新建终端窗口', glyph: '⌨', act: function () { openApp('term'); } },
      { label: '打开应用…', glyph: '↗', key: '⌘O', act: openLauncher },
      { label: '开始菜单', glyph: '⊞', key: '⌘␣', act: openStartMenu },
      { sep: true },
      { label: '整理图标', glyph: '▦', act: tidyIcons },
      { label: '显示全部窗口', act: showAll },
      { sep: true },
      { head: '壁纸' },
    ];
    var cur = cfg && cfg.wallpaper;
    var curId = (!cur || cur.type === 'builtin') ? ((cur && cur.id) || 'aurora') : null;
    ((cfg && cfg.meta && cfg.meta.wallpapers) || []).forEach(function (w) {
      items.push({
        label: w.label, glyph: curId === w.id ? '✓' : '',
        act: function () { setWallpaper({ type: 'builtin', id: w.id }); },
      });
    });
    items.push(
      { sep: true },
      { head: '显示分辨率' });
    ((cfg && cfg.meta && cfg.meta.display_presets) || []).forEach(function (p) {
      var on = ((cfg.display && cfg.display.preset) || 'auto') === p.id;
      items.push({
        label: p.label, glyph: on ? '✓' : '',
        act: function () { setDisplay({ preset: p.id, scale: p.scale || 'fit' }); },
      });
    });
    items.push(
      { sep: true },
      { label: '桌面设置…', glyph: '⚙', key: '⌘,', act: openSettings });
    return items;
  }
  function iconMenuItems(ic, app) {
    return [
      { label: '打开', act: function () { openApp(ic.app); } },
      { label: '在浏览器新标签打开', disabled: !app, act: function () {
          if (app) window.open(appOrigin(app), '_blank', 'noopener');
        } },
      { sep: true },
      { label: '重命名…', act: function () {
          var name = window.prompt('图标名称', ic.label || appTitle(app));
          if (name == null) return;
          api('/desktop/icons/' + encodeURIComponent(ic.id), {
            method: 'PATCH', body: JSON.stringify({ label: name.trim() || null }),
          }).then(reloadDesktop).catch(function (e) { showToast('改名失败：' + e.message); });
        } },
      { label: '移到下一空格', act: function () { moveIconToFreeCell(ic); } },
      { sep: true },
      { label: '从桌面移除', destructive: true, act: function () {
          confirmAction('移除图标', '「' + (ic.label || appTitle(app)) + '」的图标会从桌面移除，应用本身不受影响。', function () {
            api('/desktop/icons/' + encodeURIComponent(ic.id), { method: 'DELETE' })
              .then(reloadDesktop).catch(function (e) { showToast('移除失败：' + e.message); });
          });
        } },
    ];
  }
  function windowMenuItems(id) {
    var rec = windows[id];
    if (!rec) return [];
    return [
      { label: '重新加载', key: '⌘R', act: function () {
          rec.veilHint.textContent = '正在加载…'; rec.veil.classList.remove('hidden');
          rec.iframe.src = appOrigin(rec.app);
        } },
      { label: rec.maximized ? '退出最大化' : '最大化', act: function () { toggleMaximize(id); } },
      { label: rec.fullscreen ? '退出全屏' : '进入全屏', act: function () { toggleFullscreen(id); } },
      { sep: true },
      { label: '最小化', act: function () { minimizeWindow(id); } },
      { label: '隐藏', act: function () { hideWindow(id); } },
      { sep: true },
      { label: '关闭窗口', key: '⌘W', destructive: true, act: function () { closeWindow(id); } },
    ];
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 命令实现
   * ═══════════════════════════════════════════════════════════════════ */
  function postToApp(cmd) {
    var rec = activeId ? windows[activeId] : null;
    if (!rec) return;
    try {
      // 尝试直接聚焦 iframe 并触发编辑命令（同源应用有效）
      rec.iframe.contentWindow.focus();
      rec.iframe.contentWindow.document.execCommand(cmd);
    } catch (e) {
      showToast('「' + appTitle(rec.app) + '」需要自己处理这个命令');
    }
  }

  function hideOthers() {
    var n = 0;
    order.forEach(function (id) {
      if (id === activeId || windows[id].hidden) return;
      windows[id].hidden = true;
      windows[id].el.style.display = 'none';
      n++;
    });
    renderDock(); renderMenus();
    announce('已隐藏 ' + n + ' 个窗口');
  }

  function showAll() {
    // 收集出名单后逐个走 showWindow —— 恢复逻辑（清 minimizing/data-min、
    // 置 display、进场动画、聚焦）只允许有一份实现，避免哪条路径漏清理。
    var pending = order.filter(function (id) {
      var r = windows[id];
      return r && (r.hidden || r.minimized);
    });
    pending.forEach(function (id) { showWindow(id); });
    if (pending.length) {
      renderDock(); renderMenus();
      showToast('已显示 ' + pending.length + ' 个窗口');
    }
  }

  function tidyIcons() {
    if (!cfg) return Promise.resolve();
    var step = gridStep();
    var wa = workArea();
    var perCol = Math.max(1, Math.floor(wa.h / step));
    var chain = Promise.resolve();
    (cfg.icons || []).forEach(function (ic, i) {
      var x = Math.floor(i / perCol);
      var y = i % perCol;
      if (ic.x === x && ic.y === y) return;
      ic.x = x; ic.y = y;
      chain = chain.then(function () {
        return api('/desktop/icons/' + encodeURIComponent(ic.id), {
          method: 'PATCH', body: JSON.stringify({ x: x, y: y }),
        });
      });
    });
    return chain.then(function () { return reloadDesktop(); })
      .then(function () { showToast('图标已整理'); })
      .catch(function (e) { showToast('整理失败：' + e.message); });
  }

  function moveIconToFreeCell(ic) {
    var occ = {};
    (cfg.icons || []).forEach(function (o) { occ[o.x + ',' + o.y] = true; });
    var wa = workArea();
    var perCol = Math.max(1, Math.floor(wa.h / gridStep()));
    for (var i = 0; i < 400; i++) {
      var x = Math.floor(i / perCol), y = i % perCol;
      if (!occ[x + ',' + y]) {
        api('/desktop/icons/' + encodeURIComponent(ic.id), {
          method: 'PATCH', body: JSON.stringify({ x: x, y: y }),
        }).then(reloadDesktop).catch(function (e) { showToast('移动失败：' + e.message); });
        return;
      }
    }
  }

  /* ── 弹窗（用桌面自己的材质，不调原生 alert）── */
  function confirmAction(title, body, onOk) {
    var back = el('div');
    back.className = 'rx-modal-back';
    back.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;z-index:600;' +
      'background:rgba(0,0,0,0.28);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)';
    var card = el('div', 'rx-material-thick');
    card.style.cssText = 'width:min(360px,86vw);padding:18px;border-radius:14px;' +
      'border:0.5px solid var(--hairline-strong);box-shadow:var(--shadow-menu);' +
      'box-sizing:border-box;';
    card.setAttribute('role', 'alertdialog');
    card.appendChild(el('div', 'subtitle', title));
    var p = el('p', 'body');
    p.style.cssText = 'margin:8px 0 16px;color:var(--label-secondary)';
    p.textContent = body;
    card.appendChild(p);

    var row = el('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    var cancel = el('button', 'rx-btn', '取消');
    var ok = el('button', 'rx-btn primary', '确定');
    row.appendChild(cancel); row.appendChild(ok);
    card.appendChild(row);
    back.appendChild(card);
    back.__close = done;
    vscreen.appendChild(back);

    function done(go) {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      if (go) onOk();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.stopPropagation(); done(true); }
    }
    cancel.addEventListener('click', function () { done(false); });
    ok.addEventListener('click', function () { done(true); });
    back.addEventListener('click', function (e) { if (e.target === back) done(false); });
    document.addEventListener('keydown', onKey, true);
    ok.focus();
  }

  function sheet(title, bodyNode, actions) {
    var back = el('div');
    back.className = 'rx-modal-back';
    back.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;z-index:600;' +
      'background:rgba(0,0,0,0.28);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)';
    var card = el('div', 'rx-material-thick');
    card.style.cssText = 'width:min(520px,90vw);max-height:82vh;overflow:auto;padding:20px;' +
      'border-radius:14px;border:0.5px solid var(--hairline-strong);' +
      'box-shadow:var(--shadow-menu);box-sizing:border-box;';
    card.setAttribute('role', 'dialog');
    var head = el('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:12px';
    head.appendChild(el('div', 'title', title));
    var sp = el('div'); sp.style.flex = '1';
    head.appendChild(sp);
    var x = el('button', 'rx-tool');
    x.appendChild(svgIcon(ICON.close));
    x.setAttribute('title', '关闭');
    head.appendChild(x);
    card.appendChild(head);
    card.appendChild(bodyNode);
    back.appendChild(card);
    back.__close = done;
    vscreen.appendChild(back);
    function done() { back.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); done(); } }
    x.addEventListener('click', done);
    back.addEventListener('click', function (e) { if (e.target === back) done(); });
    document.addEventListener('keydown', onKey, true);
    (actions || []).forEach(function (a) { a(done); });
    return done;
  }

  function showAbout() {
    var body = el('div');
    var p1 = el('p', 'body');
    p1.style.cssText = 'margin:0 0 10px;color:var(--label-secondary)';
    p1.textContent = 'RunX OS —— 基于 NavExt 内核改造的网页桌面操作系统：' +
      '特权层 os.js + supervisor / pax / event-bus / desktop / mounts 五个核心扩展。';
    body.appendChild(p1);
    var list = el('div');
    list.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font:var(--font-body)';
    [
      ['内核版本', (window.__NAV_DATA__ && window.__NAV_DATA__.serverVersion) || '—'],
      ['桌面扩展', (cfg && cfg.meta && cfg.meta.version) || '—'],
      ['已登记应用', apps.length + ' 个'],
      ['打开窗口', order.length + ' 个'],
      ['视口', viewport().w + ' × ' + viewport().h],
    ].forEach(function (kv) {
      var k = el('div', 'caption', kv[0]);
      var v = el('div', 'tabular');
      v.style.color = 'var(--label-primary)';
      v.textContent = kv[1];
      list.appendChild(k); list.appendChild(v);
    });
    body.appendChild(list);
    sheet('关于 RunX OS', body);
  }

  function showShortcuts() {
    var rows = [
      ['⌘␣', '开始菜单'],
      ['⌘O', '打开应用'],
      ['⌘W', '关闭窗口'],
      ['⌘M', '最小化窗口'],
      ['⌘H', '隐藏窗口'],
      ['⌘⌥H', '隐藏其他窗口'],
      ['⌘⌃M', '最大化 / 还原'],
      ['⌘⌃F', '全屏 / 退出全屏'],
      ['⌘R', '重新加载应用'],
      ['⌘⇧A', '应用管理'],
      ['⌘`', '切换窗口'],
      ['⌘,', '桌面设置'],
      ['Esc', '关菜单 / 退出全屏'],
    ];
    var body = el('div');
    body.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:7px 18px;font:var(--font-body)';
    rows.forEach(function (r) {
      var k = el('div', null, r[0]);
      k.style.cssText = 'font-family:var(--font-mono);font-size:12px;color:var(--label-secondary);' +
        'background:var(--surface-sunken);padding:1px 7px;border-radius:5px;text-align:center';
      body.appendChild(k);
      body.appendChild(el('div', 'body', r[1]));
    });
    sheet('快捷键', body);
  }

  function showKernel() {
    var body = el('div');
    body.appendChild(el('div', 'caption', '正在读取内核状态…'));
    sheet('内核状态', body);
    Promise.all([
      api('/apps').catch(function () { return { apps: [] }; }),
      api('/desktop').catch(function () { return {}; }),
      fetch(BASE + '/runx/event-bus/history?limit=12').then(function (r) { return r.json(); })
        .catch(function () { return { events: [] }; }),
    ]).then(function (res) {
      body.textContent = '';
      var appsData = (res[0] && res[0].apps) || [];
      var evs = (res[2] && res[2].events) || [];

      body.appendChild(el('div', 'section-label', '应用'));
      var t1 = el('div');
      t1.style.cssText = 'display:grid;gap:6px;margin:6px 0 16px';
      if (!appsData.length) t1.appendChild(el('div', 'caption', '没有已登记的应用'));
      appsData.forEach(function (a) {
        var row = el('div');
        row.style.cssText = 'display:flex;align-items:center;gap:9px';
        var dot = el('span', 'rx-status-dot');
        dot.style.background = isRunning(a) ? 'var(--semantic-green)' : 'var(--label-quaternary)';
        row.appendChild(dot);
        row.appendChild(el('div', 'body', appTitle(a)));
        var sp = el('div'); sp.style.flex = '1'; row.appendChild(sp);
        row.appendChild(el('div', 'caption tabular',
          (a.type === 'node' ? ':' + a.port : 'web') + ' · ' + (a.state || 'unknown')));
        t1.appendChild(row);
      });
      body.appendChild(t1);

      body.appendChild(el('div', 'section-label', '最近事件'));
      var t2 = el('div');
      t2.style.cssText = 'display:grid;gap:5px;font:var(--font-caption);' +
        'font-family:var(--font-mono);max-height:220px;overflow:auto';
      if (!evs.length) t2.appendChild(el('div', 'caption', '事件总线还没有记录'));
      evs.slice().reverse().forEach(function (ev) {
        var row = el('div');
        row.style.cssText = 'display:flex;gap:10px;color:var(--label-secondary)';
        var t = el('span', null, new Date(ev.ts).toTimeString().slice(0, 8));
        t.style.color = 'var(--label-tertiary)';
        row.appendChild(t);
        row.appendChild(el('span', null, ev.event));
        t2.appendChild(row);
      });
      body.appendChild(t2);
    });
  }

  function openAppManager() {
    var body = el('div');
    var t = el('div');
    t.style.cssText = 'display:grid;gap:8px';
    body.appendChild(t);

    function draw() {
      t.textContent = '';
      if (!apps.length) t.appendChild(el('div', 'caption', '还没有登记任何应用'));
      apps.forEach(function (a) {
        var row = el('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;' +
          'border-radius:8px;background:var(--surface-card);border:0.5px solid var(--hairline)';
        var url = appIconUrl(a);
        if (url) {
          var img = el('img');
          img.src = url;
          img.style.cssText = 'width:26px;height:26px;border-radius:7px;object-fit:cover';
          row.appendChild(img);
        } else row.appendChild(el('div', null, '📦'));
        var info = el('div');
        info.style.cssText = 'flex:1;min-width:0';
        info.appendChild(el('div', 'body', appTitle(a)));
        info.appendChild(el('div', 'caption',
          (a.description || '') + (a.type === 'node' ? ' · :' + a.port : ' · web')));
        row.appendChild(info);

        var st = el('span', 'caption tabular');
        st.style.color = isRunning(a) ? 'var(--semantic-green)' : 'var(--label-tertiary)';
        st.textContent = a.state || (isRunning(a) ? 'running' : 'stopped');
        row.appendChild(st);

        var open = el('button', 'rx-btn', '打开');
        open.addEventListener('click', function () { openApp(a.name); });
        row.appendChild(open);

        if (a.type === 'node') {
          var tgl = el('button', 'rx-btn', isRunning(a) ? '停止' : '启动');
          tgl.addEventListener('click', function () {
            var act = isRunning(a) ? 'stop' : 'start';
            tgl.disabled = true;
            api('/apps/' + encodeURIComponent(a.name) + '/' + act, { method: 'POST' })
              .then(refreshApps).then(function () { draw(); })
              .catch(function (e) { showToast(act + ' 失败：' + e.message); tgl.disabled = false; });
          });
          row.appendChild(tgl);
        }
        t.appendChild(row);
      });
    }
    draw();
    sheet('应用管理', body);
  }

  function openSettings() {
    var body = el('div');
    body.style.cssText = 'display:grid;gap:18px';

    /* ── 外观：明暗 ── */
    body.appendChild(el('div', 'section-label', '外观'));
    var seg = el('div', 'rx-segmented');
    [['light', '浅色'], ['dark', '深色'], ['auto', '跟随系统']].forEach(function (pair) {
      var b = el('button', null, pair[1]);
      b.setAttribute('aria-selected', (cfg.theme || 'auto') === pair[0] ? 'true' : 'false');
      b.addEventListener('click', function () {
        setTheme(pair[0]);
        for (var i = 0; i < seg.children.length; i++) seg.children[i].setAttribute('aria-selected', 'false');
        b.setAttribute('aria-selected', 'true');
      });
      seg.appendChild(b);
    });
    body.appendChild(seg);

    /* ── 强调色：8 色预设 ──
       只换「有意义的强调」（选中、焦点、进度），不整体染色（§2.2）。
       色块直接用服务端下发的 id 上的 computed 值取色 —— 不硬编码十六进制，
       否则以后调色还得改客户端。 */
    body.appendChild(el('div', 'section-label', '强调色'));
    var accentRow = el('div', 'rx-swatches');
    accentRow.setAttribute('role', 'radiogroup');
    accentRow.setAttribute('aria-label', '强调色');
    var accents = (cfg.meta && cfg.meta.accents) || [];
    accents.forEach(function (a) {
      var b = el('button', 'rx-swatch');
      b.type = 'button';
      b.dataset.accent = a.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('title', a.label);
      b.setAttribute('aria-label', a.label);
      b.setAttribute('aria-checked', (cfg.accent || 'blue') === a.id ? 'true' : 'false');
      b.addEventListener('click', function () {
        setAccent(a.id);
        var kids = accentRow.children;
        for (var i = 0; i < kids.length; i++) kids[i].setAttribute('aria-checked', 'false');
        b.setAttribute('aria-checked', 'true');
      });
      accentRow.appendChild(b);
    });
    if (!accents.length) accentRow.appendChild(el('span', 'caption', '服务端未下发强调色列表'));
    body.appendChild(accentRow);

    /* ── 壁纸 ── */
    body.appendChild(el('div', 'section-label', '壁纸'));
    var wallRow = el('div', 'rx-wall-grid');
    var walls = (cfg.meta && cfg.meta.wallpapers) || [];
    var curWall = cfg.wallpaper || {};
    walls.forEach(function (w) {
      var b = el('button', 'rx-wall');
      b.type = 'button';
      b.dataset.wallId = w.id;
      b.setAttribute('title', w.label);
      b.setAttribute('aria-label', w.label);
      b.setAttribute('aria-pressed',
        curWall.type !== 'url' && curWall.type !== 'file' && (curWall.id || 'aurora') === w.id ? 'true' : 'false');
      b.appendChild(el('span', 'rx-wall-name', w.label));
      b.addEventListener('click', function () {
        setWallpaper({ type: 'builtin', id: w.id });
        var kids = wallRow.children;
        for (var i = 0; i < kids.length; i++) kids[i].setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
      });
      wallRow.appendChild(b);
    });
    body.appendChild(wallRow);

    // 自定义图片地址（也允许直接填 CSS 渐变）
    var urlRow = el('div', 'rx-row');
    var urlInput = el('input', 'rx-field');
    urlInput.type = 'url';
    urlInput.placeholder = '图片地址，或 linear-gradient(…)';
    urlInput.style.flex = '1';
    urlInput.value = (curWall.type === 'url' && curWall.url) ? curWall.url : '';
    var urlBtn = el('button', 'rx-btn', '应用');
    urlBtn.addEventListener('click', function () {
      var v = urlInput.value.trim();
      if (!v) { showToast('请先填写图片地址'); return; }
      setWallpaper({ type: 'url', url: v });
      var kids = wallRow.children;
      for (var i = 0; i < kids.length; i++) kids[i].setAttribute('aria-pressed', 'false');
    });
    urlRow.appendChild(urlInput); urlRow.appendChild(urlBtn);
    body.appendChild(urlRow);

    /* ── 显示：虚拟分辨率 + 缩放 ──
       这是「桌面自己的分辨率」，与设备真实分辨率无关：设成 1280×800 后，
       整张桌面按 1280×800 布局再等比缩放居中，于是手机和电脑上摆出来的
       窗口位置是一致的。 */
    body.appendChild(el('div', 'section-label', '显示分辨率'));
    var cur = (cfg.display && cfg.display.preset) || 'auto';
    var presetWrap = el('div', 'rx-chip-wrap');
    presetWrap.setAttribute('role', 'radiogroup');
    presetWrap.setAttribute('aria-label', '显示分辨率');
    var presets = (cfg.meta && cfg.meta.display_presets) || [];
    presets.forEach(function (p) {
      var b = el('button', 'rx-chip');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', cur === p.id ? 'true' : 'false');
      b.textContent = p.label;
      b.addEventListener('click', function () {
        setDisplay({ preset: p.id, scale: p.scale || 'fit' });
        var kids = presetWrap.children;
        for (var i = 0; i < kids.length; i++) kids[i].setAttribute('aria-checked', 'false');
        b.setAttribute('aria-checked', 'true');
      });
      presetWrap.appendChild(b);
    });
    body.appendChild(presetWrap);

    // 自定义尺寸
    var cRow = el('div', 'rx-row');
    cRow.appendChild(el('span', 'caption', '自定义'));
    var cw = el('input', 'rx-field rx-field-num');
    cw.type = 'number'; cw.min = '320'; cw.max = '5120'; cw.placeholder = '宽';
    cw.value = String((cfg.display && cfg.display.w) || '');
    var ch = el('input', 'rx-field rx-field-num');
    ch.type = 'number'; ch.min = '240'; ch.max = '2880'; ch.placeholder = '高';
    ch.value = String((cfg.display && cfg.display.h) || '');
    var cBtn = el('button', 'rx-btn', '应用尺寸');
    cBtn.addEventListener('click', function () {
      var w = Number(cw.value), h = Number(ch.value);
      if (!(w >= 320 && w <= 5120) || !(h >= 240 && h <= 2880)) {
        showToast('宽需在 320–5120、高需在 240–2880 之间');
        return;
      }
      setDisplay({ preset: 'custom', w: w, h: h });
    });
    cRow.appendChild(cw);
    cRow.appendChild(el('span', 'caption', '×'));
    cRow.appendChild(ch);
    cRow.appendChild(cBtn);
    body.appendChild(cRow);

    // 缩放策略：等比铺满 / 固定比例
    var sRow = el('div', 'rx-row');
    sRow.appendChild(el('span', 'caption', '缩放'));
    var sSeg = el('div', 'rx-segmented');
    var curScale = (cfg.display && cfg.display.scale) || 'fit';
    [['fit', '等比铺满'], [1, '100%'], [0.75, '75%'], [1.25, '125%']].forEach(function (pair) {
      var b = el('button', null, pair[1]);
      b.setAttribute('aria-selected', String(curScale) === String(pair[0]) ? 'true' : 'false');
      b.addEventListener('click', function () {
        var d2 = Object.assign({}, cfg.display, { scale: pair[0] });
        if (!d2.preset) d2.preset = 'auto';
        setDisplay(d2);
        for (var i = 0; i < sSeg.children.length; i++) sSeg.children[i].setAttribute('aria-selected', 'false');
        b.setAttribute('aria-selected', 'true');
      });
      sSeg.appendChild(b);
    });
    sRow.appendChild(sSeg);
    body.appendChild(sRow);
    body.appendChild(el('div', 'caption',
      '当前逻辑桌面 ' + viewport().w + ' × ' + viewport().h +
      '，缩放 ' + Math.round(displayScale() * 100) + '%。手机横竖屏切换后会自动重算。' +
      (mobileAutoOverride()
        ? '手机上已临时回退为自适应（原设置保留，桌面端不受影响）。'
        : '')));

    /* ── 新建窗口的默认尺寸 ── */
    body.appendChild(el('div', 'section-label', '新窗口默认尺寸'));
    var wpRow = el('div', 'rx-row');
    wpRow.appendChild(el('span', 'caption', '位置'));
    var wpWrap = el('div', 'rx-chip-wrap');
    var wd = cfg.windowDefaults || {};
    [['cascade', '层叠'], ['center', '居中'], ['halfLeft', '左半屏'],
      ['halfRight', '右半屏'], ['quarter', '四分屏'], ['large', '几乎铺满']].forEach(function (pair) {
      var b = el('button', 'rx-chip');
      b.type = 'button';
      b.setAttribute('aria-checked', (wd.preset || 'cascade') === pair[0] ? 'true' : 'false');
      b.textContent = pair[1];
      b.addEventListener('click', function () {
        setWindowDefaults({ preset: pair[0] });
        for (var i = 0; i < wpWrap.children.length; i++) wpWrap.children[i].setAttribute('aria-checked', 'false');
        b.setAttribute('aria-checked', 'true');
      });
      wpWrap.appendChild(b);
    });
    wpRow.appendChild(wpWrap);
    body.appendChild(wpRow);

    var wsizeRow = el('div', 'rx-row');
    wsizeRow.appendChild(el('span', 'caption', '尺寸'));
    var ww = el('input', 'rx-field rx-field-num');
    ww.type = 'number'; ww.min = '320'; ww.max = '5120'; ww.placeholder = '宽';
    ww.value = String(wd.w || 860);
    var wh = el('input', 'rx-field rx-field-num');
    wh.type = 'number'; wh.min = '220'; wh.max = '2880'; wh.placeholder = '高';
    wh.value = String(wd.h || 580);
    var wBtn = el('button', 'rx-btn', '保存尺寸');
    wBtn.addEventListener('click', function () {
      var w2 = Number(ww.value), h2 = Number(wh.value);
      if (!(w2 >= 320 && w2 <= 5120) || !(h2 >= 220 && h2 <= 2880)) {
        showToast('宽需在 320–5120、高需在 220–2880 之间');
        return;
      }
      setWindowDefaults({ w: w2, h: h2 });
    });
    wsizeRow.appendChild(ww);
    wsizeRow.appendChild(el('span', 'caption', '×'));
    wsizeRow.appendChild(wh);
    wsizeRow.appendChild(wBtn);
    body.appendChild(wsizeRow);
    body.appendChild(el('div', 'caption', '层叠/居中/分区会盖过这里的宽高；四分屏与半屏按屏幕算。'));

    /* ── Dock ── */
    body.appendChild(el('div', 'section-label', '应用坞'));
    var dockSeg = el('div', 'rx-segmented');
    var curPos = (cfg.taskbar && cfg.taskbar.position) || 'bottom';
    [['bottom', '显示'], ['none', '隐藏']].forEach(function (pair) {
      var b = el('button', null, pair[1]);
      b.setAttribute('aria-selected', curPos === pair[0] ? 'true' : 'false');
      b.addEventListener('click', function () {
        setTaskbar({ position: pair[0] });
        for (var i = 0; i < dockSeg.children.length; i++) dockSeg.children[i].setAttribute('aria-selected', 'false');
        b.setAttribute('aria-selected', 'true');
      });
      dockSeg.appendChild(b);
    });
    body.appendChild(dockSeg);

    /* ── 网格 ── */
    body.appendChild(el('div', 'section-label', '图标网格'));
    var gridRow = el('div', 'rx-row');
    gridRow.appendChild(el('span', 'caption', '单元格尺寸'));
    var range = el('input');
    range.type = 'range';
    range.min = '64'; range.max = '160'; range.step = '8';
    range.value = String((cfg.grid && cfg.grid.cell) || 96);
    range.style.flex = '1';
    var out = el('span', 'caption tabular', range.value + 'px');
    range.addEventListener('input', function () { out.textContent = range.value + 'px'; });
    range.addEventListener('change', function () {
      cfg.grid = cfg.grid || {};
      cfg.grid.cell = Number(range.value);
      saveGrid();
    });
    gridRow.appendChild(range); gridRow.appendChild(out);
    body.appendChild(gridRow);

    /* ── 操作 ── */
    body.appendChild(el('div', 'section-label', '操作'));
    var row = el('div', 'rx-row');
    var b1 = el('button', 'rx-btn', '整理图标');
    b1.addEventListener('click', function () { tidyIcons(); });
    var b2 = el('button', 'rx-btn', '关闭全部窗口');
    b2.addEventListener('click', function () {
      order.slice().forEach(function (id) { closeWindow(id, false); });
      showToast('已关闭全部窗口');
    });
    var b3 = el('button', 'rx-btn', '重置外观');
    b3.addEventListener('click', function () {
      confirmAction('重置外观', '主题、强调色、壁纸都回到默认值，窗口与图标不受影响。', function () {
        setTheme('auto'); setAccent('blue');
        setWallpaper({ type: 'builtin', id: 'aurora' });
        showToast('外观已重置');
      });
    });
    row.appendChild(b1); row.appendChild(b2); row.appendChild(b3);
    body.appendChild(row);

    sheet('桌面设置', body);
  }

  function openLauncher() {
    var body = el('div');
    var search = el('input', 'rx-field');
    search.type = 'search';
    search.placeholder = '搜索应用…';
    search.style.cssText = 'width:100%;box-sizing:border-box;height:34px;font-size:14px;margin-bottom:12px';
    body.appendChild(search);
    var list = el('div');
    list.style.cssText = 'display:grid;gap:6px';
    body.appendChild(list);

    function draw(q) {
      list.textContent = '';
      var needle = (q || '').trim().toLowerCase();
      var hit = apps.filter(function (a) {
        return !needle || (appTitle(a) + ' ' + a.name).toLowerCase().indexOf(needle) >= 0;
      });
      if (!hit.length) { list.appendChild(el('div', 'caption', '没有匹配的应用')); return; }
      hit.forEach(function (a) {
        var b = el('button', 'rx-menu-item');
        b.style.height = '38px';
        var url = appIconUrl(a);
        if (url) {
          var img = el('img');
          img.src = url;
          img.style.cssText = 'width:22px;height:22px;border-radius:6px;object-fit:cover';
          b.appendChild(img);
        } else b.appendChild(el('span', 'rx-menu-glyph', '📦'));
        b.appendChild(el('span', 'rx-menu-label', appTitle(a)));
        b.appendChild(el('span', 'rx-menu-key', isRunning(a) ? '运行中' : '已停止'));
        b.addEventListener('click', function () { close(); openApp(a.name); });
        list.appendChild(b);
      });
    }
    var close = sheet('打开应用', body);
    search.addEventListener('input', function () { draw(search.value); });
    draw('');
    setTimeout(function () { search.focus(); }, 30);
  }

  /* ═══════════════════════════════════════════════════════════════════
   * REST 写操作
   * ═══════════════════════════════════════════════════════════════════ */
  function setTheme(theme) {
    cfg.theme = theme;
    applyTheme();
    renderMenus();
    api('/desktop/theme', { method: 'PUT', body: JSON.stringify({ theme: theme }) })
      .catch(function (e) { showToast('主题没能保存：' + e.message); });
  }
  function setWallpaper(w) {
    // 本地先应用（乐观更新）：换壁纸是纯视觉操作，等一个网络来回会显得卡。
    // 服务端成功后会 reloadDesktop，两边结果一致（服务端也会补全 id）。
    cfg.wallpaper = w;
    applyWallpaper();
    api('/desktop/wallpaper', { method: 'PUT', body: JSON.stringify(w) })
      .then(function () { return reloadDesktop(); })
      .catch(function (e) { showToast('壁纸没能保存：' + e.message); });
  }

  /** 强调色：本地立刻换（纯 CSS 变量），失败再回滚 */
  function setAccent(id) {
    var prev = cfg.accent;
    cfg.accent = id;
    applyTheme();
    api('/desktop/accent', { method: 'PUT', body: JSON.stringify({ accent: id }) })
      .catch(function (e) {
        cfg.accent = prev; applyTheme();
        showToast('强调色没能保存：' + e.message);
      });
  }

  /**
   * 虚拟显示器分辨率。
   * @param {{preset?:string, w?:number, h?:number, scale?:number|string}} d
   * 传 preset（服务端预设名）或 { preset:'custom', w, h } 自定义尺寸；
   * scale 传 'fit' 等比铺满，或 0.25–3 的数字表示固定缩放。
   */
  function setDisplay(d) {
    api('/desktop/display', { method: 'PUT', body: JSON.stringify(d) })
      .then(function () { return reloadDesktop(); })
      .then(function () { showToast('显示已切换：' + viewport().w + '×' + viewport().h); })
      .catch(function (e) { showToast('分辨率没能应用：' + e.message); });
  }

  /** 新建窗口的默认尺寸与位置策略 */
  function setWindowDefaults(d) {
    return api('/desktop/window-defaults', { method: 'PUT', body: JSON.stringify(d) })
      .then(function (r) {
        // 服务端会夹取并回填完整对象，以它为准；万一没回就本地合并兜底
        cfg.windowDefaults = (r && r.windowDefaults) ||
          Object.assign({ preset: 'cascade', w: 860, h: 580 }, cfg.windowDefaults, d);
        renderMenus();          // 「窗口」菜单里的勾选状态跟着变
        showToast('新窗口默认尺寸已更新');
        return cfg.windowDefaults;
      })
      .catch(function (e) { showToast('默认尺寸没能保存：' + e.message); });
  }
  function setTaskbar(p) {
    cfg.taskbar = Object.assign({ position: 'bottom', show_clock: true }, cfg.taskbar, p);
    renderDock();
    api('/desktop/taskbar', { method: 'PUT', body: JSON.stringify(p) })
      .catch(function (e) { showToast('Dock 设置没能保存：' + e.message); });
  }
  function saveGrid() {
    renderIcons();
    api('/desktop/grid', { method: 'PUT', body: JSON.stringify(cfg.grid) })
      .catch(function (e) { showToast('网格尺寸没能保存：' + e.message); });
  }

  function reloadDesktop() {
    return api('/desktop').then(function (d) { cfg = d; render(); });
  }
  function refreshApps() {
    return api('/apps').then(function (d) {
      apps = (d && d.apps) || [];
      // 把 status.state 摊到顶层：内核把状态放在 app.status 里，
      // 而 UI 各处（角标、菜单可用性、窗口恢复）都按 app.state 读。
      apps.forEach(function (a) { if (!a.state) a.state = appState(a); });
      renderIcons();
      renderDock();
      var running = apps.filter(isRunning).length;
      statusAppCount.textContent = running + '/' + apps.length + ' 运行';
      statusDot.setAttribute('data-state', running ? 'up' : 'down');
      return apps;
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 键盘
   *
   * §1.3：RunXOS 核心输入方式是指针与键盘，应广泛使用键盘快捷键。
   * ═══════════════════════════════════════════════════════════════════ */
  function isEditable(t) {
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }

  document.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;

    if (e.key === 'Escape') {
      if (startMenu) { closeStartMenu(); e.preventDefault(); return; }
      if (openMenu) { closeMenu(); e.preventDefault(); return; }
      var r = activeId ? windows[activeId] : null;
      if (r && r.fullscreen) { toggleFullscreen(activeId); e.preventDefault(); }
      return;
    }
    if (!mod) return;

    // 焦点在应用 iframe 的输入框里时，只拦我们自己定义的组合，其余放行
    var inApp = isEditable(document.activeElement);
    var k = (e.key || '').toLowerCase();

    var handled = true;
    if (e.altKey && k === 'h') hideOthers();
    else if (e.shiftKey && k === 'a') openAppManager();
    else if (e.shiftKey && k === 'z') postToApp('redo');
    else if (k === ' ') { toggleStartMenu(); }        // ⌘␣ 开始菜单
    else if (k === '`') cycleWindows(e.shiftKey ? -1 : 1);
    else if (k === 'o') openLauncher();
    else if (k === 'w') { if (activeId) closeWindow(activeId); else handled = false; }
    else if (k === 'm' && !e.altKey) { if (activeId) minimizeWindow(activeId); else handled = false; }
    else if (k === 'h') { if (activeId) hideWindow(activeId); else handled = false; }
    else if (k === 'r') {
      var rr = activeId ? windows[activeId] : null;
      if (rr) { rr.veilHint.textContent = '正在加载…'; rr.veil.classList.remove('hidden'); rr.iframe.src = appOrigin(rr.app); }
      else handled = false;
    }
    else if (k === 'f' && e.ctrlKey && !e.metaKey) { if (activeId) toggleFullscreen(activeId); else handled = false; }
    else if (k === 'm' && e.ctrlKey) { if (activeId) toggleMaximize(activeId); else handled = false; }
    else if (e.key === ',') openSettings();
    else if (k === 'q') {
      root.remove(); location.reload();
    }
    else handled = false;

    if (handled) e.preventDefault();
  });

  function cycleWindows(dir) {
    if (!order.length) return;
    var vis = order.filter(function (id) {
      var r = windows[id];
      return r && !r.hidden && !r.minimized;
    });
    if (!vis.length) { showAll(); return; }
    var i = vis.indexOf(activeId);
    var next = vis[((i < 0 ? 0 : i + (dir > 0 ? 1 : -1)) + vis.length) % vis.length];
    focusWindow(next);
    var r2 = windows[next];
    if (r2) showToast(appTitle(r2.app), 1100);
  }

  /* 点到空白处：关菜单 + 关开始菜单 + 取消图标选中 */
  root.addEventListener('mousedown', function (e) {
    var t = e.target;
    if (!t.closest || !t.closest('.rx-menu')) closeMenu();
    if (!t.closest || !t.closest('.rx-start, .rx-start-btn')) closeStartMenu();
    if (!t.closest || !t.closest('.rx-icon')) selectIcon(null);
  });
  window.addEventListener('blur', function () { closeMenu(); closeStartMenu(); });

  /* 桌面空白处右键 = 桌面菜单 */
  surface.addEventListener('contextmenu', function (e) {
    if (e.target.closest && e.target.closest('.rx-window')) return;
    e.preventDefault();
    selectIcon(null);
    var p = pointOfPhysical(e);
    openContextMenu(p.x, p.y, desktopMenuItems());
  });
  /* 触屏长按桌面空白 = 桌面菜单（手机端的右键等价物） */
  bindLongPress(surface, function (x, y) {
    selectIcon(null);
    openContextMenu(x, y, desktopMenuItems());
  }, { when: function () { return !longPressMute && !dragState && !iconDragActive; } });
  /* 长按在「已经在窗口里的内容区」时不弹桌面菜单 —— 应用自己的长按要能用 */
  surface.addEventListener('touchstart', function (e) {
    if (e.target.closest && e.target.closest('.rx-window, .rx-dock')) longPressMute = true;
    else longPressMute = false;
  }, { passive: true, capture: true });
  /* 双击桌面空白 = 打开应用启动器 */
  surface.addEventListener('dblclick', function (e) {
    if (e.target.closest && e.target.closest('.rx-icon, .rx-window')) return;
    openLauncher();
  });

  /* ═══════════════════════════════════════════════════════════════════
   * 开始菜单
   *
   * 一个操作系统基本都要有的东西：应用总入口 + 系统级命令。
   * 与菜单栏的分工（不重复造轮子）：
   *   · 菜单栏 = **当前窗口**的命令（文件/编辑/显示/窗口）
   *   · 开始菜单 = **整个系统**的命令（开应用 / 设置 / 关于 / 退出）
   *
   * 交互按「键盘优先、指针友好」来做（§1.3）：打开即聚焦搜索框，
   * ↑↓ 移动选中项、Enter 打开、Esc 关闭、点外部关闭。
   * ═══════════════════════════════════════════════════════════════════ */
  var startMenu = null;     // 当前展开的开始菜单元素
  var startIndex = -1;      // 键盘选中的行（-1 = 未选）

  function startMenuOpen() { return !!startMenu; }

  function closeStartMenu() {
    if (!startMenu) return;
    startMenu.remove();
    startMenu = null;
    startIndex = -1;
    startBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleStartMenu() {
    if (startMenu) closeStartMenu();
    else openStartMenu();
  }

  /** 开始菜单里列出的应用（含「没在运行」的，因为这就是启动入口） */
  function startApps(needle) {
    var q = (needle || '').trim().toLowerCase();
    return apps.filter(function (a) {
      if (!q) return true;
      return (appTitle(a) + ' ' + a.name).toLowerCase().indexOf(q) >= 0;
    });
  }

  function openStartMenu() {
    closeMenu();            // 菜单栏与开始菜单互斥，别叠两张
    closeStartMenu();

    var m = el('div', 'rx-start rx-material-thick');
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-label', '开始菜单');

    // ── 头：搜索 ──
    var head = el('div', 'rx-start-head');
    var search = el('input', 'rx-start-search');
    search.type = 'search';
    search.placeholder = '搜索应用…';
    search.setAttribute('aria-label', '搜索应用');
    head.appendChild(search);
    m.appendChild(head);

    // ── 列表 ──
    var list = el('div', 'rx-start-list');
    list.setAttribute('role', 'listbox');
    m.appendChild(list);

    // ── 脚：设置 / 关于 / 退出 ──
    var foot = el('div', 'rx-start-foot');
    [
      { label: '设置', glyph: '⚙', act: function () { closeStartMenu(); openSettings(); } },
      { label: '关于', glyph: 'ⓘ', act: function () { closeStartMenu(); showAbout(); } },
      { label: '退出桌面', glyph: '⏻', act: function () {
          closeStartMenu();
          confirmAction('退出桌面', '桌面外壳会从页面上移除（内核继续运行）。按 F5 即可重新进入。', function () {
            root.remove(); location.reload();
          });
        } },
    ].forEach(function (it) {
      var b = el('button', 'rx-menu-item');
      b.setAttribute('role', 'menuitem');
      b.appendChild(el('span', 'rx-menu-glyph', it.glyph));
      b.appendChild(el('span', 'rx-menu-label', it.label));
      b.addEventListener('click', function (e) { e.stopPropagation(); it.act(); });
      foot.appendChild(b);
    });
    m.appendChild(foot);

    var rows = [];          // 当前可见的行，供键盘导航

    function draw() {
      list.textContent = '';
      rows = [];
      var hit = startApps(search.value);
      if (!hit.length) {
        list.appendChild(el('div', 'rx-start-empty', '没有匹配的应用'));
        startIndex = -1;
        return;
      }
      hit.forEach(function (a) {
        var b = el('button', 'rx-start-app');
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', 'false');

        var url = appIconUrl(a);
        if (url) {
          var img = el('img', 'rx-start-ico');
          img.src = url; img.alt = ''; img.draggable = false;
          img.addEventListener('error', function () {
            if (img.parentNode) img.parentNode.replaceChild(el('span', 'rx-start-ico', '📦'), img);
          });
          b.appendChild(img);
        } else {
          b.appendChild(el('span', 'rx-start-ico', '📦'));
        }

        var meta = el('div', 'rx-start-meta');
        meta.appendChild(el('span', 'rx-start-name', appTitle(a)));
        meta.appendChild(el('span', 'rx-start-sub', a.type === 'node' ? ('node · :' + a.port) : 'web'));
        b.appendChild(meta);

        var on = isRunning(a);
        var st = el('span', 'rx-start-state', on ? '运行中' : '已停止');
        st.dataset.on = on ? '1' : '0';
        b.appendChild(st);

        if (windows[winId(a.name)]) b.dataset.active = '1';

        b.addEventListener('click', function () { closeStartMenu(); openApp(a.name); });
        b.addEventListener('mousemove', function () { setStartIndex(rows.indexOf(b)); });
        list.appendChild(b);
        rows.push(b);
      });
      // 重绘后保持选中项在范围内（搜索框每敲一个字都会重绘）
      if (startIndex >= rows.length) startIndex = rows.length - 1;
      setStartIndex(startIndex);
    }

    function setStartIndex(i) {
      startIndex = i;
      rows.forEach(function (r, k) {
        r.setAttribute('aria-selected', k === i ? 'true' : 'false');
      });
    }

    function move(d) {
      if (!rows.length) return;
      var n = startIndex < 0 ? (d > 0 ? 0 : rows.length - 1)
        : (startIndex + d + rows.length) % rows.length;
      setStartIndex(n);
      if (rows[n] && rows[n].scrollIntoView) rows[n].scrollIntoView({ block: 'nearest' });
    }

    function onKey(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); move(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        if (startIndex >= 0 && rows[startIndex]) rows[startIndex].click();
        else if (rows[0]) rows[0].click();
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        closeStartMenu();
      }
    }

    search.addEventListener('input', function () { startIndex = -1; draw(); });
    search.addEventListener('keydown', onKey);
    m.addEventListener('keydown', onKey);
    m.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    root.appendChild(m);
    startMenu = m;
    startBtn.setAttribute('aria-expanded', 'true');
    draw();
    // 进场动画用 data-anim 触发，动画结束后摘掉属性，
    // 否则下次打开时属性已在、动画不会重播。
    m.dataset.anim = 'in';
    m.addEventListener('animationend', function () { delete m.dataset.anim; }, { once: true });
    setTimeout(function () { if (startMenu === m) search.focus(); }, 20);
  }

  startBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleStartMenu();
  });

  /**
   * 把菜单放到指针位置（右键 / 触屏长按共用）。
   *
   * ⚠ 传入的必须是**屏幕坐标**（e.clientX / e.clientY）：菜单是挂到宿主
   * #runx-desktop 上的，不随 vscreen 缩放，所以定位要用物理像素。
   * 缩放 ≠1 时若直接拿逻辑坐标定 left/top，菜单会飘到桌面外。
   */
  function openContextMenu(px_, py_, items) {
    closeMenu();
    var m = buildMenu(items);
    m.dataset.rootLabel = '__ctx';
    m.classList.add('rx-menu-ctx');
    // 先挂上去再量尺寸，否则 getBoundingClientRect 拿不到真实宽高
    m.style.visibility = 'hidden';
    root.appendChild(m);

    var vw = physViewport().w, vh = physViewport().h;
    var r = m.getBoundingClientRect();

    // 边距上沿要避开导航条：菜单压住菜单栏很难看，也挡住了系统级入口。
    // 底沿留 6px 就够（下面就是桌面）。
    var topMin = navbarH() + 4;
    var left = px_ + r.width > vw - 6 ? px_ - r.width : px_;
    var top = py_ + r.height > vh - 6 ? py_ - r.height : py_;
    m.style.left = px(clamp(left, 6, Math.max(6, vw - r.width - 6)));
    m.style.top = px(clamp(top, topMin, Math.max(topMin, vh - r.height - 6)));
    m.style.visibility = '';

    openMenu = m;
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 视口变化：窗口重新约束在可视区内
   * （手机旋屏 / 软键盘弹起 / 地址栏伸缩都会触发，不止 resize）
   * ═══════════════════════════════════════════════════════════════════ */
  var resizeTimer = null;
  function relayout() {
    // 先重算虚拟显示器的缩放与居中、把桌面钉到真实可视区，
    // 再按新的可用区夹取窗口 —— 顺序反了会用旧坐标系算出错误位置。
    applyDisplay();
    applyViewportFrame();
    var wa = workArea();
    order.forEach(function (id) {
      var rec = windows[id];
      if (!rec) return;
      if (rec.fullscreen) { applyGeom(rec, { x: 0, y: 0, w: viewport().w, h: viewport().h }); return; }
      if (rec.maximized) { applyGeom(rec, { x: wa.left, y: wa.top, w: wa.w, h: wa.h }); return; }
      var g = currentGeom(rec);
      var w = Math.min(g.w, wa.w);
      var h = Math.min(g.h, wa.h);
      // 与拖动同一套约束：保证标题栏至少有 120px（或半宽）留在视口里
      var keepH = Math.min(120, w * 0.5);
      var x = clamp(g.x, -(w - keepH), Math.max(0, wa.w - keepH));
      var y = clamp(g.y, wa.top, Math.max(wa.top, viewport().h - 34));
      applyGeom(rec, { x: x, y: y, w: w, h: h });
      rec.geom = { x: x, y: y, w: w, h: h };
    });
  }
  function scheduleRelayout() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, safeMs(140, 140, 60, 800));
  }
  window.addEventListener('resize', scheduleRelayout);
  // 软键盘弹起/收起、地址栏伸缩：visualViewport 比 window.resize 更可靠
  var _vv = window.visualViewport;
  if (_vv) {
    _vv.addEventListener('resize', scheduleRelayout);
    // 键盘顶起时可视区被推高 → offsetTop 变化，触发 scroll（不是 resize）
    _vv.addEventListener('scroll', scheduleRelayout);
  }
  window.addEventListener('orientationchange', scheduleRelayout);

  /* ═══════════════════════════════════════════════════════════════════
   * 移动端 viewport：确保 host 页面有正确的 meta
   * （viewport-fit=cover 才能让安全区 env() 生效；user-scalable=no 配合
   *  touch-action:manipulation 消除移动端双击/捏合缩放与 300ms 点击延迟）
   * ═══════════════════════════════════════════════════════════════════ */
  function ensureViewportMeta() {
    var head = document.head || document.getElementsByTagName('head')[0];
    if (!head) return;
    var want = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    var meta = head.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'viewport';
      meta.content = want;
      head.appendChild(meta);
    } else {
      var c = (meta.getAttribute('content') || '');
      // 补齐关键项，不覆盖 host 已有的合理设置
      if (!/viewport-fit\s*=\s*cover/.test(c)) c = (c ? c + ',' : '') + 'viewport-fit=cover';
      if (!/user-scalable\s*=\s*no/.test(c)) c = c + ',user-scalable=no';
      if (!/maximum-scale/.test(c)) c = c + ',maximum-scale=1';
      meta.setAttribute('content', c);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Android 返回键 / 系统返回：关掉最上层浮层或窗口，而不是直接退出页面
   * 用 history 哨兵拦截 popstate：有层可关就关、并重新占位；
   * 没有层则放行，别把用户困在页面里。
   * ═══════════════════════════════════════════════════════════════════ */
  function installBackGuard() {
    var SENTINEL = '__runx_backguard__';
    function topModal() {
      var modals = root.querySelectorAll('.rx-modal-back');
      return modals.length ? modals[modals.length - 1] : null;
    }
    function closeTop() {
      if (openMenu) { closeMenu(); return true; }          // 下拉 / 上下文菜单
      if (startMenu) { closeStartMenu(); return true; }     // 开始菜单
      var m = topModal();                                   // 设置 / 关于 / 确认
      if (m) {
        if (typeof m.__close === 'function') m.__close();
        else m.remove();
        return true;
      }
      if (order.length) { closeWindow(order[order.length - 1]); return true; }  // 最上层窗口
      return false;
    }
    window.addEventListener('popstate', function () {
      // 有层可关 → 拦截返回、关掉最上层；否则放行（让浏览器后退/退出）
      if (closeTop()) history.pushState({ rx: SENTINEL }, '');
    });
    // 占一条历史，使第一次系统返回键落在哨兵上，而不是直接离开桌面
    if (!history.state || (history.state && history.state.rx) !== SENTINEL) {
      history.pushState({ rx: SENTINEL }, '');
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 时钟
   * ═══════════════════════════════════════════════════════════════════ */
  function tickClock() {
    var d = new Date();
    var wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    statusClock.textContent = wd + ' ' + d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  tickClock();
  setInterval(tickClock, safeMs(15000, 15000, 1000, 60000));

  /* 应用状态轮询：窗口标题旁的状态、Dock 角标、菜单里的启停可用性都靠它 */
  setInterval(function () { refreshApps().catch(function () { /* 内核可能正在重启 */ }); },
    safeMs(10000, 10000, 2000, 120000));

  /* ═══════════════════════════════════════════════════════════════════
   * 渲染入口
   * ═══════════════════════════════════════════════════════════════════ */
  function render() {
    applyTheme();
    applyWallpaper();
    applyDisplay();          // 必须在渲染图标/窗口之前：它定下逻辑坐标系
    applyViewportFrame();    // 把桌面钉到真实可视区（键盘/地址栏变化时）
    renderIcons();
    renderDock();
    renderMenus();
  }

  ensureViewportMeta();

  Promise.all([api('/desktop'), api('/apps')]).then(function (res) {
    cfg = res[0] || {};
    if (cfg.meta && cfg.meta.assets_base) ASSET_BASE = cfg.meta.assets_base;
    apps = (res[1] && res[1].apps) || [];
    render();
    refreshApps()
      .then(function () {
        // 应用状态拿到之后再恢复窗口：node 应用没起来时不该开出一堆死窗口。
        // silent，避免刷新时一串「已打开」提示糊满屏。
        try { restoreWindows(cfg.windows); } catch (e) { /* 恢复失败不该拖垮桌面 */ }
      })
      .catch(function () { /* 首轮失败不影响桌面渲染 */ });
  }).catch(function (e) {
    console.error('RunX 桌面加载失败：', e);
    showToast('桌面加载失败：' + e.message, 6000);
  });

  /* 离开页面前把待写的窗口几何塞出去。
     只用 pagehide/visibilitychange：beforeunload 在移动端常常不触发，
     而且它一旦设了 returnValue 就会弹原生确认框，很打扰。 */
  installBackGuard();

  window.addEventListener('pagehide', flushWindows);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushWindows();
  });

  // 暴露一点调试接口（控制台里 `__runx.windows` 很顺手）
  //
  // 注意 open/close 的参数口径不同：open 收**应用名**（'term'），而窗口记录的
  // key 是 winId = 'win-' + 应用名。close 两者都收 —— 传 'term' 或 'win-term'
  // 都行，免得在控制台里 `__runx.close('term')` 静默无效（windows['term']
  // 是 undefined，closeWindow 直接 return，什么都不发生，很难发现）。
  function resolveWinId(nameOrId) {
    if (!nameOrId) return null;
    if (windows[nameOrId]) return nameOrId;
    var byApp = winId(nameOrId);
    if (windows[byApp]) return byApp;
    return nameOrId;
  }
  window.__runx = {
    get windows() { return windows; },
    get apps() { return apps; },
    get cfg() { return cfg; },
    open: openApp,
    close: function (nameOrId) { return closeWindow(resolveWinId(nameOrId)); },
    focus: function (nameOrId) {
      var id = resolveWinId(nameOrId);
      if (!windows[id]) return false;
      if (windows[id].hidden || windows[id].minimized) showWindow(id); else focusWindow(id);
      return true;
    },
    showAll: showAll,
    hideOthers: hideOthers,
    tidy: tidyIcons,
    toast: showToast,
    // 调试窗口几何持久化：__runx.winSnapshot() 看当前快照，
    // __runx.saveWindows() 立刻落盘。
    winSnapshot: winSnapshot,
    saveWindows: saveWindowsNow,
    // 外观与显示：控制台里换主题/强调色/分辨率很方便
    start: openStartMenu,
    theme: setTheme,
    accent: setAccent,
    wallpaper: setWallpaper,
    display: setDisplay,
    windowDefaults: setWindowDefaults,
    applyDisplay: applyDisplay,
  };
})();
