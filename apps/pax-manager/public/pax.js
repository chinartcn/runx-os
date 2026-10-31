'use strict';

/**
 * PaX 包管理器 —— 前端
 *
 * 界面只有三块：安装、本机应用列表、详情。
 * 所有特权操作都发给自己这个进程，由它转给内核 PaX —— 页面永远不直接
 * 碰文件系统。
 */

var GATEWAY = '__GATEWAY__';
var ROOT = '__ROOT__';

var state = { apps: [], filter: '', detail: null, busy: false };

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, isErr) {
  var host = $('toasts');
  if (!host) return;
  var t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(function () {
    t.style.transition = 'opacity .2s';
    t.style.opacity = '0';
    setTimeout(function () { t.remove(); }, 220);
  }, isErr ? 5200 : 2600);
}

/** 调自己的进程（后端），不是直接调内核。 */
function api(path, body) {
  return fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) {
    return r.text().then(function (t) {
      var j = null;
      try { j = t ? JSON.parse(t) : null; } catch (e) { /* 非 JSON */ }
      if (!r.ok) {
        var err = new Error((j && j.message) || ('HTTP ' + r.status));
        err.code = (j && j.code) || r.status;
        throw err;
      }
      return j;
    });
  });
}

/* ── 列表 ───────────────────────────────────────────────────────── */

/**
 * 状态 → 点的颜色。
 * running 绿；stopped 灰；failed 红；restarting 琥珀色（在重启的间隙）。
 */
function dotClass(a) {
  if (a.state === 'running') return 'on';
  if (a.state === 'failed') return 'err';
  if (a.state === 'restarting') return 'warn';
  return '';
}

function stateText(a) {
  var map = {
    running: '运行中', stopped: '已停止', failed: '启动失败',
    restarting: '重启中', unknown: '未知',
  };
  return map[a.state] || a.state || '未知';
}

function matches(a, q) {
  if (!q) return true;
  var hay = ((a.name || '') + ' ' + (a.display_name || '') + ' ' + (a.description || '')).toLowerCase();
  return hay.indexOf(q.toLowerCase()) >= 0;
}

function render() {
  var box = $('list');
  if (!box) return;
  var list = state.apps.filter(function (a) { return matches(a, state.filter); });

  $('badge-count').textContent = state.apps.length + ' 个应用';

  if (!list.length) {
    box.innerHTML = '<div class="rx-empty">'
      + (state.apps.length ? '没有匹配的应用' : '这台机器上还没有应用')
      + '</div>';
    return;
  }

  box.innerHTML = list.map(function (a) {
    var perms = a.permissions || [];
    var risky = perms.filter(function (p) {
      return /^(proc|clipboard|fs\.write|sys\.admin)/.test(p);
    }).length;

    return '<div class="pkg" data-name="' + esc(a.name) + '">'
      + '<div class="icon">' + esc((a.display_name || a.name).slice(0, 1).toUpperCase()) + '</div>'
      + '<div class="main">'
      + '<div class="name"><span class="dot ' + dotClass(a) + '"></span>'
      + '<span>' + esc(a.display_name || a.name) + '</span>'
      + '<span class="ver">' + esc(a.version || '—') + '</span>'
      + '<span class="rx-badge">' + esc(stateText(a)) + '</span>'
      + (a.registered ? '' : '<span class="rx-badge">未登记</span>')
      + '</div>'
      + '<div class="desc">' + esc(a.description || a.name) + '</div>'
      + '</div>'
      + '<div class="acts">'
      + '<button class="rx-btn sm" data-act="detail">详情</button>'
      + (a.state === 'running'
        ? '<button class="rx-btn sm" data-act="stop">停止</button>'
        : '<button class="rx-btn sm" data-act="start">启动</button>')
      + '</div>'
      + '</div>';
  }).join('');
}

function loadApps() {
  return api('/api/apps').then(function (r) {
    state.apps = r.apps || [];
    if (r.kernel_error) {
      showListErr('内核没响应（' + r.kernel_error.message + '）—— 下面显示的是磁盘上的清单');
    } else {
      hideListErr();
    }
    render();
  }).catch(function (e) {
    showListErr(e.message || '取不到应用列表');
  });
}

function showListErr(msg) {
  var el = $('list-err');
  if (!el) return;
  el.textContent = msg;
  el.style.display = '';
}
function hideListErr() {
  var el = $('list-err');
  if (el) el.style.display = 'none';
}

/* ── 详情 ───────────────────────────────────────────────────────── */

function openDetail(name) {
  return api('/api/app?name=' + encodeURIComponent(name)).then(function (r) {
    var a = r.app || {};
    state.detail = a;
    $('detail-title').textContent = a.display_name || a.name;
    $('card-detail').hidden = false;

    var kv = [
      ['名字', a.name],
      ['版本', a.version || '—'],
      ['类型', a.type || '—'],
      ['端口', a.port ? (':' + a.port) : '—'],
      ['状态', stateText(a) + (a.pid ? ('（pid ' + a.pid + '）') : '')],
      ['目录', a.dir || '—'],
      ['占用', a.size ? (a.size > 1048576
        ? (a.size / 1048576).toFixed(1) + ' MB'
        : Math.round(a.size / 1024) + ' KB') : '—'],
      ['有 meta.json', a.has_meta ? '是' : '否'],
      ['已登记到内核', a.registered ? '是' : '否'],
    ];
    $('detail-kv').innerHTML = kv.map(function (p) {
      return '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>';
    }).join('');

    // 权限清单：高危项标出来 —— 这是应用能干什么的清单
    var perms = a.permissions || [];
    var box = $('detail-perms');
    if (!perms.length) {
      box.innerHTML = '<p class="hint">这个应用没有声明任何权限。</p>';
    } else {
      box.innerHTML = '<p class="rx-caption" style="margin:12px 0 0">权限</p><div class="perms">'
        + perms.map(function (p) {
          var risky = /^(proc|clipboard|fs\.write|sys\.admin|net)/.test(p);
          return '<span class="perm' + (risky ? ' risky' : '') + '">' + esc(p) + '</span>';
        }).join('')
        + '</div>';
    }

    $('detail-log').style.display = 'none';
    $('detail-err').style.display = 'none';
    $('detail-log').innerHTML = '';
  }).catch(function (e) {
    toast(e.message || '取不到详情', true);
  });
}

function showDetailErr(msg) {
  var el = $('detail-err');
  if (!el) return;
  el.textContent = msg;
  el.style.display = '';
}

/* ── 操作 ───────────────────────────────────────────────────────── */

/** 装包。payload 里 url 与 path 二选一。 */
function doInstall(payload, btn) {
  if (btn) btn.disabled = true;
  return api('/api/install', payload).then(function (r) {
    var n = (r.installed && r.installed.name) || '';
    toast('装上了：' + n);
    return loadApps().then(function () {
      if (n) return openDetail(n);
    });
  }).catch(function (e) {
    var el = $('install-err');
    if (el) { el.textContent = e.message || '安装失败'; el.style.display = ''; }
    toast(e.message || '安装失败', true);
  }).finally(function () {
    if (btn) btn.disabled = false;
  });
}

function doUninstall(name) {
  if (!window.confirm('卸载「' + name + '」？\n\n应用目录会被删掉，运行数据（data/）也一并没了。这个操作不能撤销。')) return;
  return api('/api/uninstall', { name: name }).then(function () {
    toast('已卸载 ' + name);
    $('card-detail').hidden = true;
    state.detail = null;
    return loadApps();
  }).catch(function (e) {
    showDetailErr(e.message || '卸载失败');
    toast(e.message || '卸载失败', true);
  });
}

function doLifecycle(name, action) {
  return api('/api/lifecycle', { name: name, action: action }).then(function () {
    toast(action + ' 成功');
    return loadApps().then(function () {
      if (state.detail && state.detail.name === name) return openDetail(name);
    });
  }).catch(function (e) {
    toast(e.message || (action + ' 失败'), true);
  });
}

function loadLogs(name) {
  return api('/api/logs?name=' + encodeURIComponent(name) + '&lines=120').then(function (r) {
    var lines = (r.logs && r.logs.lines) || [];
    var box = $('detail-log');
    box.innerHTML = lines.length
      ? lines.map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('')
      : '<div>（没有日志）</div>';
    box.style.display = '';
  }).catch(function (e) {
    showDetailErr(e.message || '取不到日志');
  });
}

/* ── 事件绑定 ───────────────────────────────────────────────────── */

function bind() {
  $('btn-refresh').addEventListener('click', function () { loadApps(); });

  $('q').addEventListener('input', function (e) {
    state.filter = e.target.value.trim();
    render();
  });

  // 安装卡片开合
  $('btn-install').addEventListener('click', function () {
    var c = $('card-install');
    c.hidden = !c.hidden;
    if (!c.hidden) $('in-url').focus();
  });
  $('install-close').addEventListener('click', function () { $('card-install').hidden = true; });

  $('in-go').addEventListener('click', function () {
    var u = $('in-url').value.trim();
    if (!u) { toast('填一个下载地址', true); return; }
    var s = $('in-subdir').value.trim();
    doInstall({ url: u, subdir: s }, $('in-go'));
  });

  $('in-local').addEventListener('click', function () {
    var p = window.prompt('本地应用的绝对路径（目录或 .tar.gz）：', ROOT + '/apps/');
    if (!p) return;
    var s = $('in-subdir').value.trim();
    doInstall({ path: p.trim(), subdir: s }, $('in-local'));
  });

  // 列表里的操作（事件委托 —— 列表是重绘的，绑在容器上一次就够）
  $('list').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var row = btn.closest('.pkg');
    if (!row) return;
    var name = row.getAttribute('data-name');
    var act = btn.getAttribute('data-act');
    if (act === 'detail') openDetail(name);
    else if (act === 'start') doLifecycle(name, 'start');
    else if (act === 'stop') doLifecycle(name, 'stop');
  });

  // 详情里的操作
  $('detail-close').addEventListener('click', function () {
    $('card-detail').hidden = true;
    state.detail = null;
  });
  $('d-logs').addEventListener('click', function () {
    if (state.detail) loadLogs(state.detail.name);
  });
  $('d-uninstall').addEventListener('click', function () {
    if (state.detail) doUninstall(state.detail.name);
  });
  $('d-update').addEventListener('click', function () {
    if (!state.detail) return;
    var u = window.prompt('新版本的包地址（留空则用本地路径）：', '');
    if (u === null) return;
    var name = state.detail.name;
    var payload;
    if (u.trim()) payload = { name: name, url: u.trim() };
    else {
      var p = window.prompt('本地包路径（目录或 .tar.gz）：', '');
      if (!p) return;
      payload = { name: name, path: p.trim() };
    }
    api('/api/update', payload).then(function (r) {
      toast('已更新到 ' + ((r.updated && r.updated.version) || '新版本'));
      return loadApps().then(function () { return openDetail(name); });
    }).catch(function (e) {
      showDetailErr(e.message || '更新失败');
      toast(e.message || '更新失败', true);
    });
  });
}

/* ── 启动 ───────────────────────────────────────────────────────── */

function boot() {
  bind();
  loadApps();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
