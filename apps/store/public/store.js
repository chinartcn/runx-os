/* RunX 应用商店 —— 前端
 *
 * ── 读路径：直接请求商店 API ─────────────────────────────────────
 * 列表和详情直接 fetch 商店 Worker（api.rtcnnavext.de5.net），**不经过**本地
 * 进程。商店的响应带 access-control-allow-origin: *，跨源没问题。
 *
 * 为什么不走本地进程中转：多一跳就多一份拷贝，而商店 Worker 本来就在
 * 边缘，直连最快；而且「商店挂了」不该拖慢整个应用 —— 这里失败只影响列表。
 *
 * ── 写路径：走后端 ──────────────────────────────────────────────
 * 安装/更新/卸载是特权操作，页面不能自己做。它把参数发给同源的
 * /api/install，由那边转发给内核。
 */
(function () {
  'use strict';

  var API_BASE = '__API_BASE__';      // 由后端在渲染 index.html 时替换
  var GATEWAY = '__GATEWAY__';

  var state = {
    q: '',
    cat: '',
    apps: [],
    installed: {},     // name -> true
    detail: null,
    cfg: {},
  };

  /* ── 小工具 ─────────────────────────────────────────────────── */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(text, isErr) {
    var box = $('toast');
    box.textContent = text;
    box.classList.toggle('err', !!isErr);
    box.classList.add('in');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove('in'); }, 2600);
  }

  /** 调商店 API（跨源直连） */
  function storeGet(path) {
    return fetch(API_BASE + path, { headers: { accept: 'application/json' } })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = t ? JSON.parse(t) : null; } catch (e) { /* 非 JSON */ }
          if (!r.ok) {
            var err = new Error((j && j.message) || ('HTTP ' + r.status));
            err.code = r.status;
            throw err;
          }
          return j;
        });
      });
  }

  /** 调本地后端（特权操作走这条路） */
  function local(path, body) {
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
          err.code = r.status;
          throw err;
        }
        return j;
      });
    });
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function fmtDownloads(n) {
    n = Number(n) || 0;
    if (n >= 10000) return (n / 10000).toFixed(1) + ' 万次下载';
    return n + ' 次下载';
  }

  /* ── 列表 ───────────────────────────────────────────────────── */

  function loadApps() {
    var list = $('list');
    list.innerHTML = '<div class="rxst-loading">正在向商店取数据…</div>';

    var qs = [];
    if (state.q) qs.push('q=' + encodeURIComponent(state.q));
    if (state.cat) qs.push('category=' + encodeURIComponent(state.cat));
    var path = '/api/apps' + (qs.length ? '?' + qs.join('&') : '');

    return storeGet(path).then(function (j) {
      state.apps = (j && j.apps) || [];
      renderList();
      var st = (j && j.stats) || null;
      $('footStat').textContent = state.apps.length + ' 个应用'
        + (st && st.total ? ' / 全站 ' + st.total + ' 个' : '');
    }).catch(function (e) {
      list.innerHTML = '<div class="rxst-empty"><b>商店没连上</b>'
        + esc(e.message || String(e))
        + '<br>检查网络，或稍后再试。</div>';
      $('footStat').textContent = '—';
    });
  }

  function renderList() {
    var list = $('list');
    if (!state.apps.length) {
      list.innerHTML = '<div class="rxst-empty"><b>没有匹配的应用</b>'
        + '换个关键词或分类试试。</div>';
      return;
    }
    var html = state.apps.map(function (a) {
      var installed = state.installed[a.name] ? '<span class="rxst-badge">已安装</span>' : '';
      var perms = (a.permissions || []).length;
      var permTxt = perms
        ? '<span class="rxst-perms">◉ ' + perms + ' 项能力</span>' : '';
      var icon = a.icon_url
        ? '<div class="rxst-icon"><img src="' + esc(a.icon_url) + '" alt="" loading="lazy"></div>'
        : '<div class="rxst-icon">📦</div>';
      return '<article class="rxst-card' + (state.installed[a.name] ? ' installed' : '') + '" '
        + 'data-slug="' + esc(a.slug) + '" tabindex="0">'
        + icon
        + '<div class="rxst-info">'
        + '<div class="rxst-name">' + esc(a.name)
        + (a.version ? '<span class="rxst-ver">v' + esc(a.version) + '</span>' : '')
        + installed
        + '</div>'
        + '<div class="rxst-sum">' + esc(a.summary || a.description || '（没有简介）') + '</div>'
        + '<div class="rxst-meta">'
        + (a.author ? '<span>' + esc(a.author) + '</span>' : '')
        + '<span>' + fmtDownloads(a.downloads) + '</span>'
        + (a.size ? '<span>' + fmtSize(a.size) + '</span>' : '')
        + permTxt
        + '</div>'
        + '</div></article>';
    }).join('');

    list.innerHTML = html;

    Array.prototype.forEach.call(list.querySelectorAll('.rxst-card'), function (card) {
      card.addEventListener('click', function () { openDetail(card.getAttribute('data-slug')); });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDetail(card.getAttribute('data-slug'));
        }
      });
    });
  }

  /* ── 详情 ───────────────────────────────────────────────────── */

  function openDetail(slug) {
    return storeGet('/api/apps/' + encodeURIComponent(slug)).then(function (j) {
      var a = (j && j.app) || null;
      if (!a) { toast('这个应用下架了', true); return; }
      state.detail = a;
      renderDetail(a);
      $('detail').hidden = false;
    }).catch(function (e) {
      toast(e.message || '取不到详情', true);
    });
  }

  function renderDetail(a) {
    var perms = a.permissions || [];
    var permHtml = perms.length
      ? '<ul class="rxst-perm-list">' + perms.map(function (p) {
          return '<li><span class="rxst-perm-dot"></span>' + esc(p) + '</li>';
        }).join('') + '</ul>'
      : '<p class="rxst-d-text">没有声明任何能力 —— 只能做不需要授权的事。</p>';

    var installed = !!state.installed[a.name];
    var src = a.source_type === 'github' ? 'GitHub 仓库' : (a.source_type || '外部源');

    var html =
      '<div class="rxst-d-head">'
      + (a.icon_url
          ? '<div class="rxst-d-icon"><img src="' + esc(a.icon_url) + '" alt=""></div>'
          : '<div class="rxst-d-icon">📦</div>')
      + '<div><h2 class="rxst-d-name">' + esc(a.name) + '</h2>'
      + '<div class="rxst-d-ver">v' + esc(a.version || '0.0.0')
      + (a.author ? ' · ' + esc(a.author) : '') + '</div></div>'
      + '</div>'

      + '<div class="rxst-actions">'
      + (installed
          ? '<button class="rxst-btn ghost" data-act="update">更新到最新版</button>'
          : '<button class="rxst-btn" data-act="install">安装</button>')
      + '</div>'

      + (a.description || a.summary
          ? '<div class="rxst-d-sec"><h3>简介</h3><p class="rxst-d-text">'
            + esc(a.description || a.summary) + '</p></div>'
          : '')

      + '<div class="rxst-d-sec"><h3>安装时会被授予的能力</h3>'
      + permHtml
      + (perms.length
          ? '<div class="rxst-notice" style="margin-top:9px">安装时这些能力会逐条弹窗审批 —— '
            + '权限与上次不同会重新提示。</div>'
          : '')
      + '</div>'

      + '<div class="rxst-d-sec"><h3>来源</h3><dl class="rxst-kv">'
      + '<dt>类型</dt><dd>' + esc(src) + '</dd>'
      + (a.repo ? '<dt>仓库</dt><dd>' + esc(a.repo) + '</dd>' : '')
      + (a.homepage ? '<dt>主页</dt><dd>' + esc(a.homepage) + '</dd>' : '')
      + (a.license ? '<dt>许可</dt><dd>' + esc(a.license) + '</dd>' : '')
      + (a.size ? '<dt>体积</dt><dd>' + fmtSize(a.size) + '</dd>' : '')
      + '<dt>下载</dt><dd>' + fmtDownloads(a.downloads) + '</dd>'
      + '</dl></div>';

    $('detailBody').innerHTML = html;

    var btn = $('detailBody').querySelector('[data-act]');
    if (btn) btn.addEventListener('click', function () { onAction(a, btn); });
  }

  function onAction(a, btn) {
    var act = btn.getAttribute('data-act');
    btn.disabled = true;
    btn.textContent = act === 'install' ? '安装中…' : '更新中…';

    var p;
    if (act === 'install') {
      p = local('/api/install', {
        url: a.download_url || a.source_url,
        subdir: a.source_subdir || '',
        slug: a.slug,
      });
    } else {
      p = local('/api/update', {
        name: a.name,
        url: a.download_url || a.source_url,
        subdir: a.source_subdir || '',
      });
    }

    p.then(function (r) {
      toast((act === 'install' ? '已安装 ' : '已更新 ') + (r.installed && r.installed.name || r.updated && r.updated.name || a.name));
      state.installed[a.name] = true;
      btn.disabled = false;
      btn.textContent = '更新到最新版';
      loadInstalled();
      renderList();
    }).catch(function (e) {
      toast(e.message || '操作失败', true);
      btn.disabled = false;
      btn.textContent = act === 'install' ? '安装' : '更新到最新版';
    });
  }

  /* ── 已安装列表 ─────────────────────────────────────────────── */

  function loadInstalled() {
    return local('/api/installed').then(function (r) {
      var map = {};
      (r.apps || []).forEach(function (a) { map[a.name] = true; });
      state.installed = map;
    }).catch(function () { /* 拿不到就先空着，不影响浏览 */ });
  }

  /* ── 开发者面板 ─────────────────────────────────────────────── */

  function openDev() {
    var veil = $('devVeil');
    veil.hidden = false;
    return local('/api/dev/session').then(function (r) {
      renderDev(r.session);
    }).catch(function (e) {
      $('devBody').innerHTML = '<p class="rxst-hint">读不到会话：' + esc(e.message) + '</p>';
    });
  }

  function renderDev(session) {
    var body = $('devBody');
    if (!session || !session.token) {
      body.innerHTML =
        '<div class="rxst-field"><label>开发者账号</label>'
        + '<input id="devName" placeholder="用户名" autocomplete="username"></div>'
        + '<div class="rxst-field"><label>密码</label>'
        + '<input id="devPass" type="password" placeholder="密码" autocomplete="current-password"></div>'
        + '<button class="rxst-btn" id="devLogin">登录</button>'
        + '<p class="rxst-hint">登录后可以把自己的应用同步到商店。'
        + '上架只需一份 meta.json —— 商店沿用 appex.json 的字段，你不用学第二套格式。</p>'
        + '<div id="devAfter"></div>';
      $('devLogin').addEventListener('click', function () {
        var n = $('devName').value.trim();
        var p = $('devPass').value;
        if (!n || !p) { toast('用户名和密码都要填', true); return; }
        $('devLogin').disabled = true;
        local('/api/dev/login', { name: n, password: p }).then(function () {
          toast('已登录');
          return openDev();
        }).catch(function (e) {
          toast(e.message || '登录失败', true);
          $('devLogin').disabled = false;
        });
      });
      return;
    }

    body.innerHTML =
      '<div class="rxst-field"><label>已登录：' + esc(session.name || '?') + '</label></div>'
      + '<div class="rxst-field"><label>同步 meta.json</label>'
      + '<input id="syncUrl" placeholder="https://…/meta.json"></div>'
      + '<button class="rxst-btn" id="devSync">一键同步</button>'
      + '<button class="rxst-btn ghost" id="devLogout">退出登录</button>'
      + '<p class="rxst-hint">商店会拉取这个地址的 meta.json，写进 D1，然后全网立刻可见。</p>'
      + '<div class="rxst-mine" id="myApps"></div>';

    $('devSync').addEventListener('click', function () {
      var u = $('syncUrl').value.trim();
      if (!u) { toast('填一下 meta.json 的地址', true); return; }
      $('devSync').disabled = true;
      local('/api/dev/sync', { meta_url: u }).then(function (r) {
        toast('已上架：' + ((r.app && r.app.name) || '完成'));
        $('devSync').disabled = false;
        loadMyApps();
        loadApps();
      }).catch(function (e) {
        toast(e.message || '同步失败', true);
        $('devSync').disabled = false;
      });
    });
    $('devLogout').addEventListener('click', function () {
      local('/api/dev/logout', {}).then(function () { toast('已退出'); openDev(); });
    });
    loadMyApps();
  }

  function loadMyApps() {
    var box = $('myApps');
    if (!box) return;
    local('/api/dev/my-apps').then(function (r) {
      var apps = r.apps || [];
      if (!apps.length) { box.innerHTML = '<p class="rxst-hint">你还没有上架任何应用。</p>'; return; }
      box.innerHTML = '<h3 style="margin:14px 0 6px;font-size:12px;color:var(--rxst-text-3)">我的应用</h3>'
        + apps.map(function (a) {
            return '<div class="rxst-mine-item"><b>' + esc(a.name) + '</b> '
              + '<span style="color:var(--rxst-text-3)">v' + esc(a.version || '') + '</span> · '
              + fmtDownloads(a.downloads) + '</div>';
          }).join('');
    }).catch(function () { /* 静默 */ });
  }

  /* ── 启动 ───────────────────────────────────────────────────── */

  function boot() {
    local('/api/config').then(function (c) {
      state.cfg = c || {};
      $('footApi').textContent = '商店 ' + (c.api_base || API_BASE);
    }).catch(function () {
      $('footApi').textContent = '商店 ' + API_BASE;
    });

    loadInstalled();
    loadApps();

    // 搜索：输入停 250ms 再打 —— 每敲一个字打一次商店没必要
    var t = null;
    $('q').addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { state.q = $('q').value.trim(); loadApps(); }, 250);
    });

    Array.prototype.forEach.call(document.querySelectorAll('.rxst-tab'), function (tab) {
      tab.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.rxst-tab'), function (x) {
          x.classList.remove('on');
        });
        tab.classList.add('on');
        state.cat = tab.getAttribute('data-cat');
        loadApps();
      });
    });

    $('closeDetail').addEventListener('click', function () { $('detail').hidden = true; });
    $('btnDev').addEventListener('click', openDev);
    $('devClose').addEventListener('click', function () { $('devVeil').hidden = true; });
    $('devVeil').addEventListener('click', function (e) {
      if (e.target === $('devVeil')) $('devVeil').hidden = true;
    });
    $('btnRefresh').addEventListener('click', function () { loadApps(); loadInstalled(); });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!$('devVeil').hidden) $('devVeil').hidden = true;
        else $('detail').hidden = true;
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
