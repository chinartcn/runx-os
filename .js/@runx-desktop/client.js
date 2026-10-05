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
  function safeMs(v, dflt, min, max) {
    var n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !isFinite(n)) n = dflt;
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
   * ═══════════════════════════════════════════════════════════════════ */
  var root = el('div');
  root.id = 'runx-desktop';
  document.body.appendChild(root);

  var menubar = el('div', 'rx-menubar rx-material-thin');
  menubar.setAttribute('role', 'menubar');
  var surface = el('div', 'rx-surface');
  root.appendChild(menubar);
  root.appendChild(surface);

  var brand = el('div', 'rx-brand');
  var brandMark = el('div', 'rx-brand-mark', 'R');
  var brandName = el('span', 'rx-brand-name', 'RunX OS');
  brand.appendChild(brandMark);
  brand.appendChild(brandName);
  brand.setAttribute('title', 'RunX OS');
  menubar.appendChild(brand);

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
  root.appendChild(toast);

  var live = el('div', 'rx-sr-only');
  live.setAttribute('aria-live', 'polite');
  root.appendChild(live);

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
  function isRunning(app) {
    return !!app && (app.state === 'running' || app.state === 'restarting' || app.type === 'web');
  }
  function winId(name) { return 'win-' + name; }

  /* ═══════════════════════════════════════════════════════════════════
   * 主题 / 壁纸
   * ═══════════════════════════════════════════════════════════════════ */
  function applyTheme() {
    root.setAttribute('data-theme', (cfg && cfg.theme) || 'auto');
  }
  function applyWallpaper() {
    var w = cfg && cfg.wallpaper;
    root.style.backgroundImage = '';
    if (!w) { root.removeAttribute('data-wallpaper'); return; }
    if (w.type === 'file' && w.path) {
      root.setAttribute('data-wallpaper', 'file');
      root.style.backgroundImage = 'url(' + BASE + '/' + w.path + ')';
    } else if (w.type === 'url' && w.url) {
      root.setAttribute('data-wallpaper', 'url');
      root.style.backgroundImage = 'url(' + w.url + ')';
    } else {
      root.setAttribute('data-wallpaper', 'builtin');
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 布局度量
   *
   * 导航条 / Dock 的高度从 CSS 变量里读实际值，不硬编码 ——
   * 窄屏媒体查询改了高度，JS 自动跟上，不会出现图标被导航条压住。
   * ═══════════════════════════════════════════════════════════════════ */
  function metric(name, fallback) {
    var v = getComputedStyle(root).getPropertyValue(name).trim();
    var n = parseFloat(v);
    return isFinite(n) && n > 0 ? n : fallback;
  }
  function navbarH() { return metric('--navbar-h', 40); }
  function viewport() {
    return { w: root.clientWidth || window.innerWidth, h: root.clientHeight || window.innerHeight };
  }
  /** 窗口可用的自由区域（扣掉导航条与 Dock） */
  function workArea() {
    var vp = viewport();
    var top = navbarH();
    return { top: top, left: 0, w: vp.w, h: vp.h - top, bottom: vp.h };
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
        openContextMenu(e.clientX, e.clientY, iconMenuItems(ic, app));
      });

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

  function pointOf(e) {
    if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches && e.changedTouches.length) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  function debouncedPatchIcon(ic) {
    clearTimeout(iconTimers[ic.id]);
    iconTimers[ic.id] = setTimeout(function () {
      api('/desktop/icons/' + encodeURIComponent(ic.id), {
        method: 'PATCH', body: JSON.stringify({ x: ic.x, y: ic.y }),
      }).catch(function (e) { showToast('图标位置没能保存：' + e.message); });
    }, safeMs(500, 500, 120, 4000));
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 窗口
   * ═══════════════════════════════════════════════════════════════════ */
  function defaultGeom(index) {
    var wa = workArea();
    // 窄屏：直接用满可用区（手机上开个小窗口没意义）
    if (narrow()) return { x: 6, y: 6, w: wa.w - 12, h: wa.h - 12 };
    // 唯一边距：新窗口稍微错开，像真桌面那样能看见下面那张
    var off = (index % 6) * 26;
    var w = Math.min(860, Math.max(320, wa.w - 120));
    var h = Math.min(580, Math.max(220, wa.h - 120));
    return {
      x: clamp(48 + off, 8, Math.max(8, wa.w - w - 8)),
      y: clamp(28 + off, 6, Math.max(6, wa.h - h - 6)),
      w: w, h: h,
    };
  }

  function narrow() {
    return !!(root.clientWidth && root.clientWidth <= 680);
  }

  function openApp(name) {
    var app = appOf(name);
    if (!app) { showToast('找不到应用「' + name + '」'); return; }
    var id = winId(name);

    var rec = windows[id];
    if (rec) {
      if (rec.hidden || rec.minimized) showWindow(id);
      else focusWindow(id);
      return;
    }

    var g = defaultGeom(order.length);
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
      openContextMenu(e.clientX, e.clientY, windowMenuItems(id));
    });

    focusWindow(id);
    announce(appTitle(app) + ' 已打开');
    renderDock();
    return recNew;
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
        openContextMenu(e.clientX, e.clientY, windowMenuItems(id));
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

    root.appendChild(dock);
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
    ];

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
    root.appendChild(m);
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
    return [
      { label: '新建终端窗口', glyph: '⌨', act: function () { openApp('term'); } },
      { label: '打开应用…', glyph: '↗', key: '⌘O', act: openLauncher },
      { sep: true },
      { label: '整理图标', glyph: '▦', act: tidyIcons },
      { label: '显示全部窗口', act: showAll },
      { sep: true },
      { head: '壁纸' },
      { label: '极光（内置）', glyph: !cfg || !cfg.wallpaper || cfg.wallpaper.type === 'builtin' ? '✓' : '',
        act: function () { setWallpaper({ type: 'builtin', id: 'aurora' }); } },
      { label: '纯色深空', act: function () { setWallpaper({ type: 'url', url: 'linear-gradient(160deg,#0b1020,#1b1030)' }); } },
      { sep: true },
      { label: '桌面设置…', glyph: '⚙', act: openSettings },
    ];
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
    root.appendChild(back);

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
    root.appendChild(back);
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
      ['⌘O', '打开应用'],
      ['⌘W', '关闭窗口'],
      ['⌘M', '最小化窗口'],
      ['⌘H', '隐藏窗口'],
      ['⌘⌥H', '隐藏其他窗口'],
      ['⌘⌃M', '最大化 / 还原'],
      ['⌘⌃F', '全屏 / 退出全屏'],
      ['⌘R', '重新加载应用'],
      ['⌘`', '切换窗口'],
      ['⌘,', '桌面设置'],
      ['Esc', '退出全屏 / 关菜单'],
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
    body.style.cssText = 'display:grid;gap:16px';

    // 主题
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

    // Dock
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

    // 网格
    body.appendChild(el('div', 'section-label', '图标网格'));
    var gridRow = el('div');
    gridRow.style.cssText = 'display:flex;align-items:center;gap:10px';
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

    // 动作
    body.appendChild(el('div', 'section-label', '操作'));
    var row = el('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    var b1 = el('button', 'rx-btn', '整理图标');
    b1.addEventListener('click', function () { tidyIcons(); });
    var b2 = el('button', 'rx-btn', '关闭全部窗口');
    b2.addEventListener('click', function () {
      order.slice().forEach(function (id) { closeWindow(id, false); });
      showToast('已关闭全部窗口');
    });
    row.appendChild(b1); row.appendChild(b2);
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
    api('/desktop/wallpaper', { method: 'PUT', body: JSON.stringify(w) })
      .then(function () { return reloadDesktop(); })
      .catch(function (e) { showToast('壁纸没能保存：' + e.message); });
    if (w.type === 'url' && /^linear-gradient/.test(w.url)) {
      // 渐变是 CSS 值不是地址，本地立刻应用免得等一个来回
      root.setAttribute('data-wallpaper', 'gradient');
      root.style.backgroundImage = w.url;
    }
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

  /* 点到空白处：关菜单 + 取消图标选中 */
  root.addEventListener('mousedown', function (e) {
    if (!e.target.closest || !e.target.closest('.rx-menu')) closeMenu();
    if (!e.target.closest || !e.target.closest('.rx-icon')) selectIcon(null);
  });
  window.addEventListener('blur', closeMenu);

  /* 桌面空白处右键 = 桌面菜单 */
  surface.addEventListener('contextmenu', function (e) {
    if (e.target.closest && e.target.closest('.rx-window')) return;
    e.preventDefault();
    selectIcon(null);
    openContextMenu(e.clientX, e.clientY, desktopMenuItems());
  });
  /* 双击桌面空白 = 打开应用启动器 */
  surface.addEventListener('dblclick', function (e) {
    if (e.target.closest && e.target.closest('.rx-icon, .rx-window')) return;
    openLauncher();
  });

  /** 把菜单放到鼠标位置（右键上下文） */
  function openContextMenu(cx, cy, items) {
    closeMenu();
    var m = buildMenu(items);
    m.dataset.rootLabel = '__ctx';
    m.style.left = px(clamp(cx, 6, viewport().w - 216));
    m.style.top = px(clamp(cy, 6, viewport().h - 200));
    m.classList.add('rx-menu-ctx');
    root.appendChild(m);
    openMenu = m;
    var r = m.getBoundingClientRect();
    if (r.right > viewport().w - 6) m.style.left = px(Math.max(6, viewport().w - r.width - 6));
    if (r.bottom > viewport().h - 6) m.style.top = px(Math.max(6, viewport().h - r.height - 6));
  }

  /* ═══════════════════════════════════════════════════════════════════
   * 视口变化：窗口重新约束在可视区内（手机旋屏常见）
   * ═══════════════════════════════════════════════════════════════════ */
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
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
    }, safeMs(140, 140, 60, 800));
  });

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
    renderIcons();
    renderDock();
    renderMenus();
  }

  Promise.all([api('/desktop'), api('/apps')]).then(function (res) {
    cfg = res[0] || {};
    if (cfg.meta && cfg.meta.assets_base) ASSET_BASE = cfg.meta.assets_base;
    apps = (res[1] && res[1].apps) || [];
    render();
    refreshApps().catch(function () { /* 首轮失败不影响桌面渲染 */ });
  }).catch(function (e) {
    console.error('RunX 桌面加载失败：', e);
    showToast('桌面加载失败：' + e.message, 6000);
  });

  // 暴露一点调试接口（控制台里 `__runx.windows` 很顺手）
  window.__runx = {
    get windows() { return windows; },
    get apps() { return apps; },
    get cfg() { return cfg; },
    open: openApp,
    close: closeWindow,
    showAll: showAll,
    hideOthers: hideOthers,
    tidy: tidyIcons,
    toast: showToast,
  };
})();
