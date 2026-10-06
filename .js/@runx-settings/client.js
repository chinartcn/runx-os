/* @runx-settings 客户端 —— 统一设置面板
 *
 * 分栏：通用 / 外观 / 显示 / 扩展 / 关于。
 *   · 通用、扩展：本扩展自己的面（数据来自 /runx/settings/overview）。
 *   · 外观、显示：数据来自桌面扩展（代理），改动经 /runx/settings/desktop/* 回写。
 * 所有写操作都如实展示服务端返回的错误（例如内核只读时 403），不静默吞掉。
 */
(function () {
  'use strict';

  var API = '/runx/settings';
  var ASSETS = '/runx/settings-assets/';
  var RunX = (window.RunX = window.RunX || {});

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function httpJson(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        if (!r.ok) {
          var m = (data && data.error && data.error.message) || ('HTTP ' + r.status);
          var err = new Error(m); err.status = r.status; err.data = data;
          throw err;
        }
        return data;
      });
    });
  }
  function post(url, body) {
    return httpJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }
  function put(url, body) {
    return httpJson(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }
  function toast(msg, bad) {
    if (RunX.desktop && typeof RunX.desktop.toast === 'function') { RunX.desktop.toast(msg); return; }
    if (bad) alert(msg);
    else console.log('[settings]', msg);
  }

  var SECTIONS = [
    { id: 'general', label: '通用' },
    { id: 'appearance', label: '外观' },
    { id: 'display', label: '显示' },
    { id: 'extensions', label: '扩展' },
    { id: 'about', label: '关于' },
  ];

  var panel = null;
  var ui = {};
  var ov = null;         // overview 数据
  var sec = 'general';

  function build() {
    var root = el('div', 'rxset');

    var nav = el('nav', 'rxset-nav');
    ui.nav = nav;
    SECTIONS.forEach(function (s) {
      var b = el('button', 'rxset-tab', s.label);
      b.dataset.sec = s.id;
      b.addEventListener('click', function () { goto(s.id); });
      nav.appendChild(b);
    });
    root.appendChild(nav);

    ui.pane = el('div', 'rxset-pane');
    root.appendChild(ui.pane);

    return root;
  }

  function paintTabs() {
    Array.prototype.forEach.call(ui.nav.children, function (b) {
      b.classList.toggle('on', b.dataset.sec === sec);
    });
  }

  function goto(id) {
    sec = id;
    paintTabs();
    render();
  }

  function render() {
    ui.pane.textContent = '';
    if (!ov) { ui.pane.appendChild(el('div', 'rxset-empty', '加载中…')); return; }
    if (sec === 'general') renderGeneral();
    else if (sec === 'appearance') renderAppearance();
    else if (sec === 'display') renderDisplay();
    else if (sec === 'extensions') renderExtensions();
    else if (sec === 'about') renderAbout();
  }

  function field(label, node, hint) {
    var f = el('div', 'rxset-field');
    f.appendChild(el('label', 'rxset-label', label));
    f.appendChild(node);
    if (hint) f.appendChild(el('div', 'rxset-hint', hint));
    return f;
  }

  function card(title) {
    var c = el('section', 'rxset-card');
    if (title) c.appendChild(el('h3', 'rxset-h', title));
    return c;
  }

  /* ── 通用：站点信息 ── */
  function renderGeneral() {
    var s = ov.site || {};
    var c = card('站点');
    var t = el('table', 'rxset-kv');
    var rows = [
      ['标题', (s.site && s.site.title) || '—'],
      ['根目录', s.root || '—'],
      ['配置文件', s.config_path || '—'],
      ['扩展目录', s.extensions_dir || '—'],
      ['文件数', s.file_count != null ? String(s.file_count) : '—'],
      ['目录数', s.dirs ? String(s.dirs.length) : '—'],
    ];
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('th', '', r[0]));
      tr.appendChild(el('td', '', r[1]));
      t.appendChild(tr);
    });
    c.appendChild(t);
    ui.pane.appendChild(c);

    var c2 = card('接口能力');
    var api = s.api || {};
    var fsApi = api.fs || {};
    var rows2 = [
      ['API 启用', api.enabled === false ? '已关闭' : '开启'],
      ['写接口', api.writable === false ? '只读（writable=false）' : '可写'],
      ['文件读', fsApi.read === false ? '关闭' : '开启'],
      ['文件写', fsApi.write ? '开启（注意：等价于远程改文件链路）' : '关闭'],
      ['单次读上限', fsApi.maxReadSize != null ? String(fsApi.maxReadSize) + ' 字节' : '—'],
    ];
    var t2 = el('table', 'rxset-kv');
    rows2.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('th', '', r[0]));
      tr.appendChild(el('td', '', r[1]));
      t2.appendChild(tr);
    });
    c2.appendChild(t2);
    ui.pane.appendChild(c2);
  }

  /* ── 外观：主题 / 强调色 / 壁纸（写回桌面扩展）── */
  function renderAppearance() {
    var d = ov.desktop || {};
    var dm = ov.desktop_meta || {};
    var cur = d;   // desktop.json 是扁平结构：theme/accent/wallpaper 直接在顶层
    var curWallId = (cur.wallpaper && cur.wallpaper.id) || null;

    var c = card('主题');
    var sel = el('select', 'rxset-input');
    ['light', 'dark', 'auto'].forEach(function (v) {
      var o = el('option', '', v === 'light' ? '浅色' : v === 'dark' ? '深色' : '跟随系统');
      o.value = v;
      if ((cur.theme || 'auto') === v) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      put(API + '/desktop/theme', { theme: sel.value })
        .then(function () { toast('主题已更新'); refreshDesktop(); })
        .catch(function (e) { toast('主题更新失败：' + e.message, true); });
    });
    c.appendChild(field('主题模式', sel));
    ui.pane.appendChild(c);

    var c2 = card('强调色');
    var wrap = el('div', 'rxset-swatches');
    var accents = dm.accents || [];
    (accents.length ? accents : [{ id: 'blue', label: '蓝色' }]).forEach(function (a) {
      var b = el('button', 'rxset-swatch');
      b.dataset.accent = a.id;
      b.title = a.label || a.id;
      b.appendChild(el('span', 'rxset-sw-' + a.id, ''));
      if ((cur.accent || 'blue') === a.id) b.classList.add('on');
      b.addEventListener('click', function () {
        put(API + '/desktop/accent', { accent: a.id })
          .then(function () { toast('强调色已更新'); refreshDesktop(); })
          .catch(function (e) { toast('失败：' + e.message, true); });
      });
      wrap.appendChild(b);
    });
    c2.appendChild(field('预设', wrap, '预设值都经过浅色与深色两套底色校验，避免与语义色撞车。'));
    ui.pane.appendChild(c2);

    var c3 = card('壁纸');
    var wwrap = el('div', 'rxset-walls');
    var walls = dm.wallpapers || [];
    walls.forEach(function (w) {
      var id = w.id || w;
      var label = w.label || id;
      var b = el('button', 'rxset-wall', label);
      b.dataset.wall = id;
      if (curWallId === id) b.classList.add('on');
      b.addEventListener('click', function () {
        // desktop.setWallpaper 要 { type, id } 结构，只发 id 会被 422 拒掉
        put(API + '/desktop/wallpaper', { type: 'builtin', id: id })
          .then(function () { toast('壁纸已更新'); refreshDesktop(); })
          .catch(function (e) { toast('失败：' + e.message, true); });
      });
      wwrap.appendChild(b);
    });
    if (!walls.length) wwrap.appendChild(el('span', 'rxset-hint', '桌面扩展未提供壁纸列表'));
    c3.appendChild(field('选择', wwrap));
    ui.pane.appendChild(c3);
  }

  /* ── 显示：分辨率 / 缩放 / 任务栏 / 图标栅格 / 窗口默认值 ── */
  function renderDisplay() {
    var d = ov.desktop || {};
    var dm = ov.desktop_meta || {};
    var cur = d;   // 扁平结构

    var c = card('分辨率与缩放');
    var sel = el('select', 'rxset-input');
    var empty = el('option', '', '自动（跟随窗口）');
    empty.value = 'auto';
    sel.appendChild(empty);
    (dm.display_presets || []).forEach(function (p) {
      var o = el('option', '', (p.label || p.id) + (p.width ? ' (' + p.width + '×' + p.height + ')' : ''));
      o.value = p.id || p;
      if ((cur.display && cur.display.preset) === (p.id || p)) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      // setDisplay 直接读顶层 preset（不是 { display: {...} }）
      put(API + '/desktop/display', { preset: sel.value })
        .then(function () { toast('显示已更新'); refreshDesktop(); })
        .catch(function (e) { toast('失败：' + e.message, true); });
    });
    c.appendChild(field('显示预设', sel));
    ui.pane.appendChild(c);

    var c2 = card('任务栏');
    var pos = el('select', 'rxset-input');
    [['top', '顶部'], ['bottom', '底部'], ['left', '左侧'], ['right', '右侧']].forEach(function (p) {
      var o = el('option', '', p[1]);
      o.value = p[0];
      if (((cur.taskbar || {}).position || 'bottom') === p[0]) o.selected = true;
      pos.appendChild(o);
    });
    pos.addEventListener('change', function () {
      put(API + '/desktop/taskbar', { position: pos.value })
        .then(function () { toast('任务栏位置已更新'); refreshDesktop(); })
        .catch(function (e) { toast('失败：' + e.message, true); });
    });
    c2.appendChild(field('位置', pos));

    var showClock = el('input', 'rxset-check');
    showClock.type = 'checkbox';
    showClock.checked = !((cur.taskbar || {}).show_clock === false);
    showClock.addEventListener('change', function () {
      put(API + '/desktop/taskbar', { show_clock: showClock.checked })
        .then(function () { toast('已更新'); refreshDesktop(); })
        .catch(function (e) { toast('失败：' + e.message, true); });
    });
    c2.appendChild(field('显示时钟', showClock));
    ui.pane.appendChild(c2);

    var c3 = card('新窗口默认尺寸');
    var wd = el('select', 'rxset-input');
    var auto = el('option', '', '自动（层叠）');
    auto.value = '';
    wd.appendChild(auto);
    (dm.window_default_presets || []).forEach(function (p) {
      var o = el('option', '', p);
      o.value = p;
      if (((cur.windowDefaults || {}).preset || '') === p) o.selected = true;
      wd.appendChild(o);
    });
    wd.addEventListener('change', function () {
      // setWindowDefaults 收 { preset }（不是 { window_defaults: {...} }）
      put(API + '/desktop/window-defaults', { preset: wd.value })
        .then(function () { toast('已更新'); refreshDesktop(); })
        .catch(function (e) { toast('失败：' + e.message, true); });
    });
    c3.appendChild(field('预设', wd));
    ui.pane.appendChild(c3);
  }

  /* ── 扩展：启用/停用 + 配置 ── */
  function renderExtensions() {
    var exts = ov.extensions;
    var all = Array.isArray(exts) ? exts : (exts && exts.extensions) || [];
    // 「隐藏内核扩展」开启时只列普通扩展：内核扩展（@runx-*）停用会直接影响
    // 站点可用性，不该出现在一个随手可点的列表里。
    var hideCore = !((ov.core || {}).show_core_extensions);
    var list = hideCore ? all.filter(function (x) { return !x.core; }) : all;
    var hiddenCount = all.length - list.length;

    var c = card('已安装扩展');
    if (hideCore && hiddenCount > 0) {
      c.appendChild(el('div', 'rxset-hint', '已隐藏 ' + hiddenCount + ' 个内核扩展（避免误停用；可在扩展配置中调整）'));
    }
    if (!list.length) { c.appendChild(el('div', 'rxset-empty', '没有可显示的扩展')); ui.pane.appendChild(c); return; }

    var t = el('table', 'rxset-table');
    var thead = el('thead');
    var htr = el('tr');
    ['扩展', '版本', '状态', '配置'].forEach(function (h) { htr.appendChild(el('th', '', h)); });
    thead.appendChild(htr);
    t.appendChild(thead);

    var tb = el('tbody');
    list.forEach(function (x) {
      var tr = el('tr');
      var tdN = el('td');
      tdN.appendChild(el('div', 'rxset-extname', x.name || x.id));
      tdN.appendChild(el('div', 'rxset-extid', x.id));
      tr.appendChild(tdN);
      tr.appendChild(el('td', 'rxset-num', x.version || '—'));

      var tdS = el('td');
      var tdSx = el('td', 'rxset-swrap');
      // id 以 @ 开头的是内置扩展。内核的 validateExtId 已支持 @ 前缀，
      // 所以它们和普通扩展一样可以启停 —— 只是额外挂一个「内置」标记，
      // 提醒用户停用后对应的面板 / 入口会一并消失。
      var sw = el('button', 'rxset-switch' + (x.enabled !== false ? ' on' : ''), x.enabled !== false ? '已启用' : '已停用');
      sw.addEventListener('click', function () {
        var next = x.enabled === false;
        sw.disabled = true;
        post(API + '/extensions/toggle', { id: x.id, enabled: next })
          .then(function () {
            x.enabled = next;
            toast((x.name || x.id) + (next ? ' 已启用' : ' 已停用'));
            // 切换扩展会改动注入，重载页面最稳
            setTimeout(function () { location.reload(); }, 600);
          })
          .catch(function (e) { toast('切换失败：' + e.message, true); sw.disabled = false; });
      });
      tdSx.appendChild(sw);
      if (x.id && x.id.charAt(0) === '@') {
        tdSx.appendChild(el('span', 'rxset-fixed', '内置'));
      }
      tdS.appendChild(tdSx);
      tr.appendChild(tdS);

      var tdC = el('td');
      if (x.hasConfig) {
        var b = el('button', 'rxset-btn rxset-btn-sm', '编辑配置');
        b.addEventListener('click', function () { editConfig(x); });
        tdC.appendChild(b);
      } else {
        tdC.appendChild(el('span', 'rxset-hint', '无配置'));
      }
      tr.appendChild(tdC);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    c.appendChild(t);
    ui.pane.appendChild(c);
  }

  function editConfig(x) {
    httpJson(API + '/extensions/' + encodeURIComponent(x.id) + '/config')
      .then(function (data) {
        var box = el('div', 'rxset-modal');
        var inner = el('div', 'rxset-modal-inner');
        inner.appendChild(el('h3', 'rxset-h', (x.name || x.id) + ' · 配置'));

        var fields = (data && data.fields) || [];
        var ta = el('textarea', 'rxset-editor');
        // 以 JSON 形态编辑用户配置：简单、通用、不猜 schema
        ta.value = JSON.stringify((data && data.values) || {}, null, 2);
        ta.rows = 14;

        if (fields.length) {
          var help = el('div', 'rxset-hint', '可配置字段：' + fields.map(function (f) { return f.key; }).join('、'));
          inner.appendChild(help);
        }
        inner.appendChild(ta);

        var foot = el('div', 'rxset-modalfoot');
        var bSave = el('button', 'rxset-btn', '保存');
        bSave.addEventListener('click', function () {
          var parsed;
          try { parsed = JSON.parse(ta.value); }
          catch (e) { toast('JSON 语法错误：' + e.message, true); return; }
          post(API + '/extensions/' + encodeURIComponent(x.id) + '/config', parsed)
            .then(function () {
              toast('已保存');
              box.remove();
              setTimeout(function () { location.reload(); }, 600);
            })
            .catch(function (e) { toast('保存失败：' + e.message, true); });
        });
        foot.appendChild(bSave);

        var bReset = el('button', 'rxset-btn', '还原默认');
        bReset.addEventListener('click', function () {
          if (!confirm('删除用户配置，恢复默认值？')) return;
          fetch(API + '/extensions/' + encodeURIComponent(x.id) + '/config', { method: 'DELETE' })
            .then(function () { toast('已还原'); box.remove(); setTimeout(function () { location.reload(); }, 600); })
            .catch(function (e) { toast('失败：' + e.message, true); });
        });
        foot.appendChild(bReset);

        var bClose = el('button', 'rxset-btn', '关闭');
        bClose.addEventListener('click', function () { box.remove(); });
        foot.appendChild(bClose);
        inner.appendChild(foot);

        box.appendChild(inner);
        box.addEventListener('click', function (e) { if (e.target === box) box.remove(); });
        panel.appendChild(box);
      })
      .catch(function (e) { toast('读取配置失败：' + e.message, true); });
  }

  /* ── 关于 ── */
  function renderAbout() {
    var c = card('RunX OS');
    var t = el('table', 'rxset-kv');
    var core = ov.core || {};
    var dm = ov.desktop_meta || {};
    var rows = [
      ['设置扩展', core.id || '@runx-settings'],
      ['桌面外壳版本', dm.version || '—'],
      ['站点版本', (ov.site && ov.site.site && ov.site.site.title) || '—'],
      ['分栏', (core.open_sections || []).join(' · ')],
    ];
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('th', '', r[0]));
      tr.appendChild(el('td', '', r[1]));
      t.appendChild(tr);
    });
    c.appendChild(t);
    c.appendChild(el('div', 'rxset-hint',
      '设置由 @runx-settings 统一承载：通用与扩展为本扩展自有，外观与显示代理到 @runx-desktop（desktop.json 为唯一真相源），扩展启用与配置代理到内核 /api/extensions。'));
    ui.pane.appendChild(c);
  }

  /**
   * 外观/显示改动后重新拉桌面状态。
   * 桌面扩展的改动是即时生效的（它会自己广播），设置面板只需刷新自己的
   * overview 副本，让选中态跟上。
   */
  function refreshDesktop() {
    return httpJson(API + '/overview').then(function (d) {
      ov = d;
      render();
    }).catch(function () { /* 下拉即时生效，刷新失败不打断操作 */ });
  }

  function load() {
    return httpJson(API + '/overview').then(function (d) {
      ov = d;
      render();
    }).catch(function (e) {
      ui.pane.textContent = '';
      ui.pane.appendChild(el('div', 'rxset-empty is-bad', '加载失败：' + e.message));
    });
  }

  function mount(host, section) {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = build();
    host.appendChild(panel);
    sec = section || sec;
    paintTabs();
    ui.pane.appendChild(el('div', 'rxset-empty', '加载中…'));
    return httpJson(API + '/meta').then(function (m) {
      if (m && m.default_section) sec = section || m.default_section;
      paintTabs();
      return load();
    }).catch(function () { return load(); });
  }

  function open(host, section) {
    if (host) return mount(host, section);
    var d = RunX.desktop;
    if (d && typeof d.openPanel === 'function') {
      return d.openPanel('settings', '设置', '@runx-settings', function (h) {
        h.classList.add('rx-panel-pad');
        mount(h, section);
      });
    }
    // 回落：直接铺在页面上
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = build();
    panel.classList.add('rxset-standalone');
    document.body.appendChild(panel);
    sec = section || sec;
    paintTabs();
    return load();
  }

  function close() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
  }

  RunX.settings = {
    open: open,
    close: close,
    goto: goto,
    reload: load,
    get panel() { return panel; },
    assets: ASSETS,
  };
})();
