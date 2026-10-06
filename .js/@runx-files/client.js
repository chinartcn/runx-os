/* @runx-files 客户端 —— 文件管理器面板
 *
 * 布局：左侧目录列表（可进入/返回），右侧预览或编辑。
 * 数据面：GET /runx/files/list|stat|read，写操作 POST /runx/files/{write,mkdir,rename,delete}。
 * 写按钮的可用性完全由服务端 meta.allow_write 决定 —— 前端不自己臆断权限，
 * 只做置灰与提示，真正的闸门在服务端 assertWritable 那一层。
 */
(function () {
  'use strict';

  var API = '/runx/files';
  var ASSETS = '/runx/files-assets/';
  var RunX = (window.RunX = window.RunX || {});

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function bytes(n) {
    if (!Number.isFinite(n)) return '—';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }
  function when(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    var now = new Date();
    var p = function (x) { return String(x).padStart(2, '0'); };
    // 列表列很窄：同年只显示 MM-DD HH:mm，跨年才带年份
    var md = p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '-' + md;
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

  var panel = null;
  var ui = {};
  var meta = { allow_write: false, show_hidden: false };
  var cwd = '';
  var showHidden = false;
  var current = null;      // 当前预览的文件 stat
  var dirty = false;       // 编辑器有未保存改动

  function build() {
    var root = el('div', 'rxfile');

    /* 工具栏 */
    var bar = el('div', 'rxfile-bar');
    ui.crumbs = el('div', 'rxfile-crumbs');
    bar.appendChild(ui.crumbs);

    var acts = el('div', 'rxfile-acts');
    ui.bHidden = el('button', 'rxfile-btn rxfile-btn-sm', '隐藏项');
    ui.bHidden.title = '显示/隐藏以点开头的条目';
    ui.bHidden.addEventListener('click', function () {
      showHidden = !showHidden; ui.bHidden.classList.toggle('on', showHidden); load(cwd);
    });
    acts.appendChild(ui.bHidden);

    ui.bNewFile = el('button', 'rxfile-btn rxfile-btn-sm', '新建文件');
    ui.bNewFile.addEventListener('click', function () { doNew(false); });
    acts.appendChild(ui.bNewFile);

    ui.bNewDir = el('button', 'rxfile-btn rxfile-btn-sm', '新建目录');
    ui.bNewDir.addEventListener('click', function () { doNew(true); });
    acts.appendChild(ui.bNewDir);

    ui.bRead = el('button', 'rxfile-btn', '刷新');
    ui.bRead.addEventListener('click', function () { load(cwd); });
    acts.appendChild(ui.bRead);
    bar.appendChild(acts);
    root.appendChild(bar);

    ui.warn = el('div', 'rxfile-warn');
    root.appendChild(ui.warn);

    /* 主体：列表 + 预览 */
    var body = el('div', 'rxfile-body');

    var left = el('div', 'rxfile-left');
    ui.list = el('div', 'rxfile-list');
    left.appendChild(ui.list);
    body.appendChild(left);

    var right = el('div', 'rxfile-right');
    var rh = el('div', 'rxfile-rhead');
    ui.rtitle = el('span', 'rxfile-rtitle', '未选择文件');
    rh.appendChild(ui.rtitle);
    var racts = el('div', 'rxfile-racts');
    ui.bSave = el('button', 'rxfile-btn rxfile-btn-sm', '保存');
    ui.bSave.addEventListener('click', saveCurrent);
    racts.appendChild(ui.bSave);
    ui.bRename = el('button', 'rxfile-btn rxfile-btn-sm', '重命名');
    ui.bRename.addEventListener('click', function () { doRename(); });
    racts.appendChild(ui.bRename);
    ui.bDownload = el('button', 'rxfile-btn rxfile-btn-sm', '下载');
    ui.bDownload.addEventListener('click', function () {
      if (current) location.href = API + '/download?path=' + encodeURIComponent(current.path);
    });
    racts.appendChild(ui.bDownload);
    ui.bDelete = el('button', 'rxfile-btn rxfile-btn-sm is-danger', '删除');
    ui.bDelete.addEventListener('click', function () { doDelete(); });
    racts.appendChild(ui.bDelete);
    rh.appendChild(racts);
    right.appendChild(rh);

    ui.rmeta = el('div', 'rxfile-rmeta');
    right.appendChild(ui.rmeta);

    ui.viewer = el('div', 'rxfile-viewer');
    right.appendChild(ui.viewer);

    body.appendChild(right);
    root.appendChild(body);

    return root;
  }

  function paintPerms() {
    var w = meta.allow_write;
    ui.warn.textContent = w
      ? (meta.write_root ? '写入已开启，限定在 ' + meta.write_root + '/ 内。' : '写入已开启：除内核保护名单外均可修改。')
      : '只读模式：在扩展配置中开启「允许写入」后，才能新建 / 编辑 / 删除。';
    ui.warn.className = 'rxfile-warn ' + (w ? 'is-on' : 'is-off');
    [ui.bNewFile, ui.bNewDir, ui.bSave, ui.bRename, ui.bDelete].forEach(function (b) {
      b.disabled = !w;
      b.title = w ? '' : '写入未开启';
    });
  }

  function paintCrumbs() {
    ui.crumbs.textContent = '';
    var rootB = el('button', 'rxfile-crumb', '站点根');
    rootB.addEventListener('click', function () { load(''); });
    ui.crumbs.appendChild(rootB);
    if (!cwd) return;
    var parts = cwd.split('/');
    var acc = '';
    parts.forEach(function (seg) {
      acc = acc ? acc + '/' + seg : seg;
      var target = acc;
      ui.crumbs.appendChild(el('span', 'rxfile-sep', '/'));
      var b = el('button', 'rxfile-crumb', seg);
      b.addEventListener('click', function () { load(target); });
      ui.crumbs.appendChild(b);
    });
  }

  function fmtSize(e) { return e.isDir ? '—' : bytes(e.size); }

  function load(path) {
    return httpJson(API + '/list?path=' + encodeURIComponent(path || '') + (showHidden ? '&all=1' : ''))
      .then(function (r) {
        cwd = r.path || '';
        paintCrumbs();
        ui.list.textContent = '';

        if (cwd) {
          var up = el('button', 'rxfile-row is-up');
          up.appendChild(el('span', 'rxfile-ico', '↰'));
          up.appendChild(el('span', 'rxfile-nm', '返回上级'));
          up.addEventListener('click', function () {
            var p = cwd.split('/'); p.pop(); load(p.join('/'));
          });
          ui.list.appendChild(up);
        }

        if (!r.entries.length) {
          ui.list.appendChild(el('div', 'rxfile-empty', '（空目录）'));
          return;
        }

        r.entries.forEach(function (e) {
          var row = el('button', 'rxfile-row' + (e.protected ? ' is-prot' : ''));
          row.appendChild(el('span', 'rxfile-ico', e.isDir ? '📁' : (e.text ? '📄' : '📦')));
          row.appendChild(el('span', 'rxfile-nm', e.name));
          row.appendChild(el('span', 'rxfile-sz', fmtSize(e)));
          row.appendChild(el('span', 'rxfile-mt', when(e.mtime)));
          if (e.isDir) {
            row.addEventListener('click', function () { load(e.path); });
          } else {
            row.addEventListener('click', function () { open2(e.path); });
          }
          ui.list.appendChild(row);
        });
        if (r.truncated) ui.list.appendChild(el('div', 'rxfile-empty', '条目过多，已截断显示'));
      })
      .catch(function (e) {
        ui.list.textContent = '';
        ui.list.appendChild(el('div', 'rxfile-empty is-bad', '读取失败：' + e.message));
      });
  }

  function open2(path) {
    if (dirty && !confirm('当前编辑未保存，放弃改动？')) return;
    dirty = false;
    return httpJson(API + '/read?path=' + encodeURIComponent(path))
      .then(function (r) {
        current = { path: r.path };
        ui.rtitle.textContent = r.path;
        ui.rmeta.textContent = bytes(r.size) + ' · ' + (r.mime || '') + ' · ' + when(r.mtime);
        ui.viewer.textContent = '';
        if (r.tooLarge) { ui.viewer.appendChild(el('div', 'rxfile-empty', r.error || '文件过大')); return; }

        if (r.isText) {
          var ta = el('textarea', 'rxfile-editor');
          ta.value = r.content;
          ta.addEventListener('input', function () { dirty = true; });
          ui.viewer.appendChild(ta);
        } else {
          // 非文本：能内联预览的给 img，否则给下载入口
          if (/^image\//.test(r.mime || '')) {
            var img = el('img', 'rxfile-img');
            img.src = API + '/download?path=' + encodeURIComponent(r.path);
            ui.viewer.appendChild(img);
          } else {
            ui.viewer.appendChild(el('div', 'rxfile-empty', '二进制文件，请使用「下载」。'));
          }
        }
      })
      .catch(function (e) {
        ui.viewer.textContent = '';
        ui.viewer.appendChild(el('div', 'rxfile-empty is-bad', '读取失败：' + e.message));
      });
  }

  function saveCurrent() {
    var ta = ui.viewer.querySelector('.rxfile-editor');
    if (!ta || !current) return;
    return httpJson(API + '/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: current.path, content: ta.value }),
    }).then(function (r) {
      dirty = false;
      ui.rmeta.textContent = '已保存 · ' + bytes(r.bytes);
      load(cwd);
    }).catch(function (e) { alert('保存失败：' + e.message); });
  }

  function doNew(isDir) {
    var name = prompt(isDir ? '新目录名称' : '新文件名称');
    if (!name) return;
    var target = cwd ? cwd + '/' + name : name;
    var url = isDir ? '/mkdir' : '/write';
    var body = isDir ? { path: target } : { path: target, content: '' };
    httpJson(API + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function () { load(cwd); })
      .catch(function (e) { alert('创建失败：' + e.message); });
  }

  function doRename() {
    if (!current) return;
    var name = prompt('重命名为', current.path.split('/').pop());
    if (!name) return;
    var segs = current.path.split('/'); segs.pop(); segs.push(name);
    httpJson(API + '/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: current.path, to: segs.join('/') }),
    }).then(function () {
      current = null; ui.viewer.textContent = ''; ui.rtitle.textContent = '未选择文件';
      load(cwd);
    }).catch(function (e) { alert('重命名失败：' + e.message); });
  }

  function doDelete() {
    if (!current) return;
    if (!confirm('确定删除 ' + current.path + ' ？（不可恢复）')) return;
    httpJson(API + '/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: current.path }),
    }).then(function () {
      current = null; ui.viewer.textContent = ''; ui.rtitle.textContent = '未选择文件';
      load(cwd);
    }).catch(function (e) { alert('删除失败：' + e.message); });
  }

  function mount(host) {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = build();
    host.appendChild(panel);
    return httpJson(API + '/meta').then(function (m) {
      meta = m || meta;
      showHidden = !!meta.show_hidden;
      ui.bHidden.classList.toggle('on', showHidden);
      paintPerms();
      return load('');
    }).catch(function () { paintPerms(); return load(''); });
  }

  function open(host) {
    if (host) return mount(host);
    var d = RunX.desktop;
    if (d && typeof d.openPanel === 'function') {
      return d.openPanel('files', '文件管理器', '@runx-files', mount);
    }
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = build();
    panel.classList.add('rxfile-standalone');
    document.body.appendChild(panel);
    return httpJson(API + '/meta').then(function (m) {
      meta = m || meta;
      paintPerms(); return load('');
    }).catch(function () { paintPerms(); return load(''); });
  }

  function close() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null; current = null; dirty = false;
  }

  RunX.files = {
    open: open,
    close: close,
    reload: function () { return load(cwd); },
    get panel() { return panel; },
    assets: ASSETS,
  };
})();
