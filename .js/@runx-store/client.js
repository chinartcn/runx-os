/* @runx-store 客户端 —— 桌面里的应用商店面板
 *
 * 数据面：GET /runx/store/config, /runx/store/apps, /runx/store/apps/:slug
 * 安装：POST /runx/store/install（服务端转给 @runx-pax 做安全解包）
 *
 * 面板用 RunX 自己的类名（rxrm- 前缀与桌面一致），不引入第二套视觉。
 */
(function () {
  'use strict';

  var API = '/runx/store';
  var RunX = (window.RunX = window.RunX || {});

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function bytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '—';
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }

  function httpJson(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = { ok: false, message: t }; }
        if (!r.ok || (data && data.ok === false)) {
          var msg = (data && (data.message || (data.error && data.error.message))) || ('HTTP ' + r.status);
          throw Object.assign(new Error(msg), { data: data });
        }
        return data;
      });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── 面板 ── */

  function openPanel(host) {
    host.innerHTML = '';
    host.className = 'rxrm-store';

    var bar = el('div', 'rxrm-store-bar');
    var title = el('div', 'rxrm-store-title', '应用商店');
    var search = el('input', 'rxrm-store-search');
    search.type = 'search';
    search.placeholder = '搜索应用…';
    var refresh = el('button', 'rxrm-store-btn', '刷新');
    var status = el('div', 'rxrm-store-status', '');
    bar.appendChild(title);
    bar.appendChild(search);
    bar.appendChild(refresh);
    bar.appendChild(status);

    var list = el('div', 'rxrm-store-list');
    var detail = el('div', 'rxrm-store-detail');
    detail.hidden = true;
    var main = el('div', 'rxrm-store-main');
    main.appendChild(list);
    main.appendChild(detail);

    host.appendChild(bar);
    host.appendChild(main);

    var state = { apps: [], cfg: { api_base: '', proxy_download: true } };

    function setStatus(t, kind) {
      status.textContent = t || '';
      status.className = 'rxrm-store-status' + (kind ? ' ' + kind : '');
    }

    function load() {
      setStatus('正在加载…');
      list.innerHTML = '';
      var q = search.value.trim();
      var url = API + '/apps' + (q ? '?q=' + encodeURIComponent(q) : '');
      return httpJson(url).then(function (j) {
        state.apps = j.apps || [];
        renderList();
        setStatus(state.apps.length ? state.apps.length + ' 个应用' : '还没有应用',
          state.apps.length ? '' : 'dim');
      }).catch(function (e) {
        setStatus('商店不可达：' + e.message, 'err');
      });
    }

    function renderList() {
      list.innerHTML = '';
      if (!state.apps.length) {
        var empty = el('div', 'rxrm-store-empty', '没有匹配的应用');
        list.appendChild(empty);
        return;
      }
      state.apps.forEach(function (a) {
        var card = el('div', 'rxrm-store-card');
        card.appendChild(el('div', 'rxrm-store-name', a.name || a.slug));
        card.appendChild(el('div', 'rxrm-store-sum', a.summary || ''));
        var meta = el('div', 'rxrm-store-meta');
        meta.appendChild(el('span', 'rxrm-store-tag', a.category || 'other'));
        meta.appendChild(el('span', '', 'v' + (a.version || '0')));
        meta.appendChild(el('span', '', (a.downloads || 0) + ' 次下载'));
        card.appendChild(meta);
        card.addEventListener('click', function () { openDetail(a.slug); });
        list.appendChild(card);
      });
    }

    function openDetail(slug) {
      setStatus('正在读取详情…');
      httpJson(API + '/apps/' + encodeURIComponent(slug)).then(function (j) {
        var a = j.app || {};
        detail.hidden = false;
        detail.innerHTML = '';

        var head = el('div', 'rxrm-store-dhead');
        head.appendChild(el('div', 'rxrm-store-dtitle', a.display_name || a.name || slug));
        head.appendChild(el('div', 'rxrm-store-dmeta',
          'v' + (a.version || '0') + ' · ' + (a.author || '未知作者') + ' · ' + (a.license || 'MIT')));
        detail.appendChild(head);

        var body = el('div', 'rxrm-store-dbody');
        if (a.summary) body.appendChild(el('p', 'rxrm-store-dsum', a.summary));
        if (a.description) {
          var d = el('p', 'rxrm-store-ddesc');
          d.textContent = a.description;
          body.appendChild(d);
        }

        var perms = Array.isArray(a.permissions) ? a.permissions : [];
        var rows = el('div', 'rxrm-store-rows');
        rows.appendChild(row('来源', (a.source_type || '') + ' · ' + (a.source_url || '')));
        rows.appendChild(row('大小', bytes(a.size)));
        var permCell = el('div', 'rxrm-store-perm');
        if (perms.length) {
          perms.forEach(function (p) { permCell.appendChild(el('div', 'rxrm-store-permline', p)); });
        } else {
          permCell.appendChild(el('div', 'rxrm-store-permline dim', '未申请任何能力'));
        }
        rows.appendChild(row('权限', permCell));
        body.appendChild(rows);

        if (perms.length) {
          var warn = el('div', 'rxrm-store-warn',
            '安装时这些能力会被逐条弹窗审批 —— 权限与上次不同会重新提示。');
          body.appendChild(warn);
        }

        var actions = el('div', 'rxrm-store-actions');
        var back = el('button', 'rxrm-store-btn', '返回');
        back.addEventListener('click', function () { detail.hidden = true; });
        var install = el('button', 'rxrm-store-btn primary', '安装');
        install.addEventListener('click', function () {
          install.disabled = true;
          install.textContent = '正在下载…';
          setStatus('正在下载并安装…');
          var dl = a.download_url || a.source_url;
          // subdir：应用在包内的相对路径。GitHub 仓库归档顶层是仓库名，
          // 内核要靠它找到 appex.json —— 商店的元数据里带了，一并传下去。
          var payload = { url: dl, slug: a.slug };
          if (a.source_subdir) payload.subdir = a.source_subdir;
          httpJson(API + '/install', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }).then(function (r) {
            install.disabled = false;
            install.textContent = '安装';
            setStatus('已安装 ' + (r.name || a.slug) + '（v' + (r.version || '?') + '）', 'ok');
            if (RunX.desktop && RunX.desktop.toast) {
              RunX.desktop.toast('已安装 ' + (r.name || a.slug), 'ok');
            }
          }).catch(function (e) {
            install.disabled = false;
            install.textContent = '安装';
            setStatus('安装失败：' + e.message, 'err');
          });
        });
        actions.appendChild(back);
        actions.appendChild(install);
        body.appendChild(actions);

        detail.appendChild(body);
        setStatus('');
      }).catch(function (e) {
        setStatus('读取详情失败：' + e.message, 'err');
      });
    }

    function row(k, v) {
      var r = el('div', 'rxrm-store-row');
      r.appendChild(el('div', 'rxrm-store-k', k));
      var val = el('div', 'rxrm-store-v');
      if (typeof v === 'string') val.textContent = v;
      else val.appendChild(v);
      r.appendChild(val);
      return r;
    }

    search.addEventListener('input', function () {
      clearTimeout(search._t);
      search._t = setTimeout(load, 260);
    });
    refresh.addEventListener('click', load);

    // 先拿配置（决定是否走代理），再拉列表
    httpJson(API + '/config').then(function (j) {
      state.cfg = j;
      if (j.api_base) {
        var a = el('span', 'rxrm-store-src', j.api_base.replace(/^https?:\/\//, ''));
        bar.appendChild(a);
      }
    }).catch(function () { /* 用默认配置继续 */ })
      .then(load);
  }

  // 打开商店面板。挂在 RunX.desktop 上时是一个窗口，
  // 没有桌面（扩展单独跑）时落成一个独立浮层 —— 与 @runx-files 同一套路。
  function open(host) {
    if (host) return openPanel(host);
    var d = RunX.desktop;
    if (d && typeof d.openPanel === 'function') {
      return d.openPanel('store', '应用商店', '@runx-store', openPanel);
    }
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = el('div', 'rxrm-store-standalone');
    document.body.appendChild(panel);
    return openPanel(panel);
  }

  function close() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
  }

  var panel = null;

  RunX.store = {
    open: open,
    close: close,
    api: API,
  };
})();
