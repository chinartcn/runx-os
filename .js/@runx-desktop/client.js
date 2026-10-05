'use strict';

/**
 * RunX 桌面客户端 —— 窗口管理器 SPA（注入到浏览器，仅在桌面页 '/' 启动）
 *
 * 职责：渲染图标网格、打开/拖动/缩放/最小化窗口、任务栏、壁纸与主题。
 * 应用内容用 <iframe> 加载（天然进程/样式隔离），node 应用指向 localhost:<port>，
 * web 应用指向 /apps/<name>/。图标拖拽结束（500ms 防抖）写回 /runx/desktop。
 */
(function () {
  if (location.pathname !== '/') return;            // 应用 iframe 内部不启动
  if (document.getElementById('runx-desktop')) return;

  var API = '/runx';
  var BASE = location.origin;
  function api(path, opts) {
    return fetch(BASE + API + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts))
      .then(function (r) { return r.json(); });
  }

  var desktop = document.createElement('div');
  desktop.id = 'runx-desktop';
  document.body.appendChild(desktop);

  var cfg = null;     // desktop.json
  var apps = [];      // /runx/apps
  var zTop = 10;
  var activeId = null;
  var windows = {};   // id -> { el, app, minimized, geom }
  var iconTimers = {};

  function appOf(name) { for (var i = 0; i < apps.length; i++) if (apps[i].name === name) return apps[i]; return null; }
  function winId(name) { return 'win-' + name; }

  function applyTheme() { desktop.setAttribute('data-theme', (cfg && cfg.theme) || 'auto'); }
  function applyWallpaper() {
    var w = cfg && cfg.wallpaper;
    if (!w) { desktop.removeAttribute('data-wallpaper'); desktop.style.backgroundImage = ''; return; }
    desktop.setAttribute('data-wallpaper', w.type);
    if (w.type === 'file') desktop.style.backgroundImage = 'url(' + BASE + '/' + (w.path || '') + ')';
    else if (w.type === 'url') desktop.style.backgroundImage = 'url(' + w.url + ')';
    else desktop.style.backgroundImage = '';
  }

  function render() {
    applyTheme();
    applyWallpaper();
    renderIcons();
    renderTaskbar();
  }

  function renderIcons() {
    var old = desktop.querySelectorAll('.rx-icon');
    for (var i = 0; i < old.length; i++) old[i].remove();
    if (!cfg) return;
    var step = (cfg.grid.cell || 96) + (cfg.grid.gap || 8);
    (cfg.icons || []).forEach(function (ic) {
      var app = appOf(ic.app);
      var el = document.createElement('div');
      el.className = 'rx-icon';
      el.style.left = (ic.x * step) + 'px';
      el.style.top = (ic.y * step + 52) + 'px';

      if (app && app.icon) {
        var img = document.createElement('img');
        img.src = BASE + '/apps/' + app.name + '/' + app.icon;
        el.appendChild(img);
      } else {
        var em = document.createElement('div'); em.className = 'rx-emoji'; em.textContent = '📦';
        el.appendChild(em);
      }
      var s = document.createElement('span');
      s.textContent = ic.label || (app ? app.display_name : ic.app) || ic.app;
      el.appendChild(s);

      el.addEventListener('dblclick', function () { openApp(ic.app); });
      makeDraggable(el, function () {
        var x = Math.max(0, Math.round(parseFloat(el.style.left) / step));
        var y = Math.max(0, Math.round((parseFloat(el.style.top) - 52) / step));
        ic.x = x; ic.y = y;
        debouncedPatchIcon(ic);
      });
      desktop.appendChild(el);
    });
  }

  function debouncedPatchIcon(ic) {
    clearTimeout(iconTimers[ic.id]);
    iconTimers[ic.id] = setTimeout(function () {
      api('/desktop/icons/' + ic.id, { method: 'PATCH', body: JSON.stringify({ x: ic.x, y: ic.y }) }).catch(function () {});
    }, 500);
  }

  function openApp(name) {
    var app = appOf(name);
    if (!app) return;
    var id = winId(name);
    if (windows[id]) { if (windows[id].minimized) windows[id].minimized = false, windows[id].el.style.display = 'flex'; focusWindow(id); return; }
    var w = document.createElement('div');
    w.className = 'rx-window';
    w.style.left = '120px'; w.style.top = '70px';
    w.style.width = 'min(820px, 80vw)'; w.style.height = 'min(560px, 78vh)';

    var bar = document.createElement('div'); bar.className = 'rx-titlebar';
    var title = document.createElement('div'); title.className = 'rx-title'; title.textContent = app.display_name || app.name;
    var cbtn = document.createElement('button'); cbtn.className = 'rx-btn close'; cbtn.textContent = '×';
    var mbtn = document.createElement('button'); mbtn.className = 'rx-btn min'; mbtn.textContent = '–';
    var xbtn = document.createElement('button'); xbtn.className = 'rx-btn max'; xbtn.textContent = '▢';
    bar.appendChild(cbtn); bar.appendChild(mbtn); bar.appendChild(xbtn); bar.appendChild(title);

    var iframe = document.createElement('iframe');
    iframe.src = app.type === 'node'
      ? ('http://' + location.hostname + ':' + app.port + '/')
      : (BASE + '/apps/' + app.name + '/');
    iframe.setAttribute('allow', 'autoplay; fullscreen');
    var resize = document.createElement('div'); resize.className = 'rx-resize';

    w.appendChild(bar); w.appendChild(iframe); w.appendChild(resize);
    desktop.appendChild(w);
    windows[id] = { el: w, app: app, minimized: false };
    cbtn.addEventListener('click', function (e) { e.stopPropagation(); closeWindow(id); });
    mbtn.addEventListener('click', function (e) { e.stopPropagation(); minimizeWindow(id); });
    xbtn.addEventListener('click', function (e) { e.stopPropagation(); maximizeWindow(id); });
    makeDraggable(w, null, bar);
    makeResizable(w, resize);
    w.addEventListener('mousedown', function () { focusWindow(id); });
    focusWindow(id);
  }

  function focusWindow(id) {
    var w = windows[id]; if (!w) return;
    zTop++; w.el.style.zIndex = zTop; activeId = id;
    Object.keys(windows).forEach(function (k) {
      if (windows[k].minimized) return;
      windows[k].el.style.boxShadow = (k === id) ? '' : '0 18px 50px rgba(0,0,0,0.45)';
    });
    renderTaskbar();
  }

  function minimizeWindow(id) {
    var w = windows[id]; if (!w) return;
    w.minimized = true; w.el.style.display = 'none';
    if (activeId === id) activeId = null;
    renderTaskbar();
  }

  function maximizeWindow(id) {
    var w = windows[id]; if (!w) return;
    if (w.geom) { var g = w.geom; w.el.style.left = g.l; w.el.style.top = g.t; w.el.style.width = g.w; w.el.style.height = g.h; w.el.style.zIndex = zTop; w.geom = null; }
    else { w.geom = { l: w.el.style.left, t: w.el.style.top, w: w.el.style.width, h: w.el.style.height }; w.el.style.left = '0'; w.el.style.top = '52px'; w.el.style.width = '100%'; w.el.style.height = 'calc(100% - 104px)'; }
  }

  function closeWindow(id) {
    var w = windows[id]; if (!w) return;
    w.el.remove(); delete windows[id];
    if (activeId === id) activeId = null;
    renderTaskbar();
  }

  function renderTaskbar() {
    var old = desktop.querySelector('.rx-taskbar');
    if (old) old.remove();
    if (!cfg) return;
    var tb = document.createElement('div');
    tb.className = 'rx-taskbar';
    tb.setAttribute('data-pos', (cfg.taskbar && cfg.taskbar.position) || 'bottom');

    Object.keys(windows).forEach(function (id) {
      var w = windows[id];
      var t = document.createElement('button');
      t.className = 'rx-task' + (id === activeId && !w.minimized ? ' active' : '');
      t.textContent = (w.app.display_name || w.app.name);
      t.addEventListener('click', function () {
        if (w.minimized) { w.minimized = false; w.el.style.display = 'flex'; focusWindow(id); }
        else if (id === activeId) minimizeWindow(id);
        else focusWindow(id);
      });
      tb.appendChild(t);
    });

    if (cfg.taskbar && cfg.taskbar.show_clock) {
      var clk = document.createElement('div'); clk.className = 'rx-clock';
      tb.appendChild(clk);
      var tick = function () { var d = new Date(); clk.textContent = d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); };
      tick(); setInterval(tick, 15000);
    }
    desktop.appendChild(tb);
  }

  /* —— 拖动：通用（图标用网格吸附回调，窗口用自由移动）—— */
  function makeDraggable(el, onDrop, handle) {
    var h = handle || el; var drag = false, sx, sy, ox, oy;
    h.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      drag = true; sx = e.clientX; sy = e.clientY;
      var r = el.getBoundingClientRect();
      ox = r.left; oy = r.top; e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      el.style.left = (ox + e.clientX - sx) + 'px';
      el.style.top = (oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', function () {
      if (!drag) return; drag = false; if (onDrop) onDrop();
    });
  }

  function makeResizable(w, handle) {
    var drag = false, sx, sy, ow, oh;
    handle.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      drag = true; sx = e.clientX; sy = e.clientY;
      ow = w.offsetWidth; oh = w.offsetHeight; e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      w.style.width = Math.max(240, ow + e.clientX - sx) + 'px';
      w.style.height = Math.max(160, oh + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', function () { drag = false; });
  }

  Promise.all([api('/desktop'), api('/apps')]).then(function (res) {
    cfg = res[0]; apps = (res[1] && res[1].apps) || [];
    render();
  }).catch(function (e) {
    console.error('RunX 桌面加载失败：', e);
  });
})();
