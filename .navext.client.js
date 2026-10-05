/* ═══════════════════════════════════════════════════════════════════════════
 *  navext.client.js — NavExt客户端库
 * ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var DATA = window.__NAV_DATA__ || { files: [], config: {}, extensions: [] };
  var VERSION = DATA.version || 'unknown';

  var cardIndex = new Map();
  var events = {};
  var injectedStyles = new Map();
  var extIndex = new Map();
  var disposers = new Map();      // extId -> [fn, ...]  清理函数注册表
  var extStates = new Map();      // extId -> 'active' | 'disposed'

  function normPath(p) {
    var s = String(p || '');
    while (s.charAt(0) === '/') s = s.slice(1);
    return s.toLowerCase();
  }

  /* ── 路径归一化（v2.7）──────────────────────────────────────────────
   * 与 server.js 的同名实现在行为上严格一致（含 index.html 规则）。
   *   URL 体系：'/docs/a.html'，首页 '/'
   *   相对体系：'docs/a.html'，首页 'index.html'
   * ────────────────────────────────────────────────────────────────── */
  var INDEX_NAME = 'index.html';

  function hasHtmlExt(p) { return /\.html?$/i.test(String(p)); }

  /* 末段是否带文件扩展名（区分「文件」与「目录」） */
  function hasFileExt(p) {
    var s = String(p == null ? '' : p);
    var last = s.slice(s.lastIndexOf('/') + 1);
    if (!last || last.charAt(0) === '.') return false;
    return /\.[a-zA-Z0-9]+$/.test(last);
  }

  function cleanPathInput(p) {
    var s = String(p == null ? '' : p);
    var hash = s.indexOf('#');
    if (hash >= 0) s = s.slice(0, hash);
    var q = s.indexOf('?');
    if (q >= 0) s = s.slice(0, q);
    try { s = decodeURIComponent(s); } catch (e) { /* 保留原样 */ }
    s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    s = s.replace(/(^|\/)\.\//g, '$1');
    while (s.indexOf('../') === 0) s = s.slice(3);
    return s;
  }

  function urlToRel(p, indexName) {
    var idx = indexName || INDEX_NAME;
    var s = cleanPathInput(p);
    var isUrl = String(p == null ? '' : p).charAt(0) === '/' || s === '' || s.charAt(0) === '/';
    s = s.replace(/^\/+/, '');
    if (s === '') return isUrl ? idx : '';
    if (s.charAt(s.length - 1) === '/') return s + idx;
    // 只要末段带扩展名就是文件（.html / .md / .json / .css … 一视同仁）
    if (hasFileExt(s)) return s;
    return isUrl ? (s + '/' + idx) : s;
  }

  function relToUrl(p, indexName) {
    var idx = indexName || INDEX_NAME;
    var s = cleanPathInput(p);
    s = s.replace(/^\/+/, '');
    if (s === '') return '/';
    if (s === idx) return '/';
    if (s.length > idx.length && s.slice(-(idx.length + 1)) === '/' + idx) {
      return '/' + s.slice(0, -idx.length);
    }
    return '/' + s;
  }

  function normalizePath(p) { return urlToRel(p).toLowerCase(); }

  function pathOf(p) {
    var raw = String(p == null ? '' : p);
    if (raw.charAt(0) === '/') return relToUrl(urlToRel(raw));
    return relToUrl(raw);
  }

  function isFn(f) { return typeof f === 'function'; }

  function getFiles() { return DATA.files.slice(); }

  function getFile(path) {
    var k = normPath(path);
    for (var i = 0; i < DATA.files.length; i++) {
      if (normPath(DATA.files[i].path) === k) return DATA.files[i];
    }
    return null;
  }

  function getConfig() { return DATA.config; }
  function getExtensions() { return DATA.extensions.slice(); }

  /**
   * 服务端搜索（v2.5）—— GET /api/search
   * 返回 Promise<{query,total,count,limit,truncated,items}>
   * 内核搜索是"按字段匹配已扫描文件"的最小实现；扩展可用 onRequest
   * 覆盖 /api/search 提供全文索引等更强能力，客户端无需改动。
   */
  function search(q, opts) {
    opts = opts || {};
    var qs = 'q=' + encodeURIComponent(q == null ? '' : String(q));
    if (opts.limit != null) qs += '&limit=' + encodeURIComponent(opts.limit);
    if (opts.dir) qs += '&dir=' + encodeURIComponent(opts.dir);
    // 默认排除 html.json 里 hidden 的条目；传 { hidden: true } 可包含
    if (opts.hidden) qs += '&hidden=1';
    return fetch('/api/search?' + qs).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (e) {
          var err = new Error((e && e.error) || ('搜索失败 (HTTP ' + r.status + ')'));
          err.status = r.status;
          throw err;
        });
      }
      return r.json();
    });
  }

  // ---------- 扩展作用域 ----------

  var CODE_STAR = 42;
  var CODE_QMARK = 63;

  function globMatch(s, p, si, pi) {
    while (si < s.length) {
      if (pi >= p.length) return false;
      var pc = p.charCodeAt(pi);
      if (pc === CODE_STAR) {
        for (var k = si; k <= s.length; k++) {
          if (globMatch(s, p, k, pi + 1)) return true;
        }
        return false;
      }
      if (pc === CODE_QMARK) {
        si++;
        pi++;
        continue;
      }
      if (pc === s.charCodeAt(si)) {
        si++;
        pi++;
        continue;
      }
      return false;
    }
    while (pi < p.length && p.charCodeAt(pi) === CODE_STAR) pi++;
    return pi >= p.length;
  }

  function matchGlob(str, pattern) {
    if (!pattern) return false;
    return globMatch(String(str).toLowerCase(), String(pattern).toLowerCase(), 0, 0);
  }

  function normalizeClientPath(p) {
    var x = String(p || '/');
    if (x.charCodeAt(0) !== 47) x = "/" + x;
    if (x.length > 1 && x.charCodeAt(x.length - 1) === 47) x = x.slice(0, -1);
    return x;
  }

  function currentPath() {
    if (typeof location !== 'undefined' && location && location.pathname) {
      return normalizeClientPath(location.pathname);
    }
    return "/";
  }

  function isExtActive(extId, pathname) {
    var e = extIndex.get(extId);
    if (!e) return false;
    if (!e.scope) return true;

    var p;
    if (pathname !== undefined) {
      p = normalizeClientPath(pathname);
    } else {
      p = currentPath();
    }

    var paths = [];
    if (Array.isArray(e.scope.paths)) paths = e.scope.paths;
    var exclude = [];
    if (Array.isArray(e.scope.exclude)) exclude = e.scope.exclude;
    var i;

    for (i = 0; i < exclude.length; i++) {
      if (matchGlob(p, exclude[i]) || matchGlob(p + "/", exclude[i])) return false;
    }
    if (!paths.length) return true;

    for (i = 0; i < paths.length; i++) {
      if (matchGlob(p, paths[i]) || matchGlob(p + "/", paths[i])) return true;
    }
    return false;
  }

  function getActiveExtensions(pathname) {
    var p;
    if (pathname !== undefined) {
      p = normalizeClientPath(pathname);
    } else {
      p = currentPath();
    }
    var out = [];
    for (var i = 0; i < DATA.extensions.length; i++) {
      var e = DATA.extensions[i];
      if (isExtActive(e.id, p)) out.push(e);
    }
    return out;
  }

  function getActiveExtIds(pathname) {
    return getActiveExtensions(pathname).map(function (e) { return e.id; });
  }




  function buildExtIndex() {
    extIndex = new Map();
    for (var i = 0; i < DATA.extensions.length; i++) {
      extIndex.set(DATA.extensions[i].id, DATA.extensions[i]);
    }
  }

  function getExtMeta(extId) { return extIndex.get(extId) || null; }

  function getExtConfig(extId) {
    var e = extIndex.get(extId);
    if (!e || !e.config) return {};
    return Object.assign({}, e.config);
  }

  function getExtConfigSchema(extId) {
    var e = extIndex.get(extId);
    if (!e || !Array.isArray(e.configSchema)) return [];
    return e.configSchema.slice();
  }

  function getExtStats(extId) {
    return request('/api/extensions/' + encodeURIComponent(extId) + '/stats')
      .then(function (r) { return r.stats; });
  }

  function getExtConfigField(extId, key) {
    var e = extIndex.get(extId);
    if (!e || !e.config) return undefined;
    return e.config[key];
  }

  function request(url, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined && init.method !== 'GET') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(url, init).then(function (r) {
      var ct = r.headers.get('content-type') || '';
      var parse = ct.indexOf('application/json') !== -1
        ? r.json()
        : r.text().then(function (t) { return { error: t }; });
      return parse.then(function (data) {
        if (!r.ok) {
          var msg = (data && data.error) || ('HTTP ' + r.status);
          var err = new Error(msg);
          err.status = r.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function setExtConfig(extId, values) {
    return request('/api/extensions/' + encodeURIComponent(extId) + '/config', {
      method: 'POST',
      body: { values: values || {} },
    }).then(function (payload) {
      var e = extIndex.get(extId);
      if (e && payload && payload.values) e.config = payload.values;
      emit('ext-config-changed', { id: extId, values: e ? e.config : {} });
      return payload;
    });
  }

  function resetExtConfig(extId) {
    return request('/api/extensions/' + encodeURIComponent(extId) + '/config', {
      method: 'DELETE',
    }).then(function (payload) {
      var e = extIndex.get(extId);
      if (e && payload && payload.values) e.config = payload.values;
      emit('ext-config-changed', { id: extId, values: e ? e.config : {} });
      return payload;
    });
  }

  function fsQuery(base, path, extra) {
    var q = '?path=' + encodeURIComponent(path || '');
    if (extra) {
      for (var k in extra) {
        if (extra[k] !== undefined && extra[k] !== null) {
          q += '&' + k + '=' + encodeURIComponent(extra[k]);
        }
      }
    }
    return base + q;
  }

  var fsApi = {
    list: function (path, opts) { return request(fsQuery('/api/fs/list', path, opts)); },
    stat: function (path) { return request(fsQuery('/api/fs/stat', path)); },
    read: function (path, opts) { return request(fsQuery('/api/fs/read', path, opts)); },
    exists: function (path) {
      return fsApi.stat(path).then(function () { return true; })
                             .catch(function () { return false; });
    },
  };

  function extFs(extId) {
    if (!extId || typeof extId !== 'string') {
      throw new Error('[NavExt] extFs 需要一个扩展 id');
    }
    var base = '/api/extensions/' + encodeURIComponent(extId) + '/fs';

    return {
      list: function (path, opts) { return request(fsQuery(base + '/list', path, opts)); },
      stat: function (path) { return request(fsQuery(base + '/stat', path)); },
      read: function (path, opts) { return request(fsQuery(base + '/read', path, opts)); },
      exists: function (path) {
        return this.stat(path).then(function () { return true; })
                              .catch(function () { return false; });
      },
      write: function (path, content, opts) {
        opts = opts || {};
        return request(base + '/write', {
          method: 'POST',
          body: {
            path: path,
            content: content,
            encoding: opts.encoding || 'utf8',
            mkdirp: opts.mkdirp !== false,
          },
        });
      },
      mkdir: function (path, opts) {
        opts = opts || {};
        return request(base + '/mkdir', {
          method: 'POST',
          body: { path: path, recursive: opts.recursive !== false },
        });
      },
      delete: function (path, opts) {
        opts = opts || {};
        return request(fsQuery(base + '/delete', path, {
          recursive: opts.recursive ? '1' : undefined,
        }), { method: 'DELETE' });
      },
      rename: function (from, to) {
        return request(base + '/rename', {
          method: 'POST',
          body: { from: from, to: to },
        });
      },
    };
  }

  function on(name, fn) {
    if (!name || !isFn(fn)) return function () {};
    var arr = events[name] || (events[name] = []);
    arr.push(fn);
    return function off() {
      var idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }

  function once(name, fn) {
    var off = on(name, function (payload) {
      off();
      fn(payload);
    });
    return off;
  }

  function emit(name, payload) {
    var arr = events[name];
    if (!arr || !arr.length) return;
    arr.slice().forEach(function (fn) {
      try { fn(payload); }
      catch (err) {
        if (window.console) console.warn('[NavExt] 事件 ' + name + ' 处理出错:', err);
      }
    });
  }

  /* ── 扩展生命周期（v2.7）────────────────────────────────────────────
   * 补齐"客户端无生命周期"缺口：扩展可注册清理函数，在
   *   · 自己调用 NavExt.dispose(extId)
   *   · 页面卸载（beforeunload / pagehide / bfcache 离开）
   * 时自动全部执行一次。重复 dispose 幂等，不会二次执行。
   * ────────────────────────────────────────────────────────────────── */

  function getExtIdFromCall() {
    // 扩展脚本运行在页面上，无参数时按"当前脚本所属扩展"推断不可行，
    // 因此要求显式传 extId；未传时退化为 '*'（全局清理）。
    return '*';
  }

  /**
   * 注册清理函数。返回一个取消注册的函数。
   * @param {string} extId   扩展 id（未传 = '*' 全局）
   * @param {Function} fn   清理函数
   */
  function disposer(extId, fn) {
    if (isFn(extId) && fn === undefined) { fn = extId; extId = '*'; }
    if (!isFn(fn)) return function () {};
    var id = String(extId || '*');
    var arr = disposers.get(id) || [];
    arr.push(fn);
    disposers.set(id, arr);
    return function off() {
      var i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  /**
   * 执行清理：调用该扩展注册的所有 disposer，并移除其注入的 CSS。
   * 幂等 —— 同一 extId 重复调用只生效一次。
   */
  function dispose(extId) {
    var id = String(extId || '*');
    var arr = disposers.get(id);
    var ran = false;

    if (arr && arr.length) {
      disposers.set(id, []);
      arr.slice().forEach(function (fn) {
        try { fn(); }
        catch (err) {
          if (window.console) console.warn('[NavExt] 扩展 ' + id + ' 清理出错:', err);
        }
      });
      ran = true;
    }

    try { removeCSS(id); } catch (e2) { /* 忽略 */ }

    if (ran || !extStates.has(id)) {
      extStates.set(id, 'disposed');
      emit('ext-disposed', { id: id });
    }
    return ran;
  }

  /** 判断扩展是否已 dispose */
  function isDisposed(extId) {
    return extStates.get(String(extId || '*')) === 'disposed';
  }

  /** 执行所有扩展的清理（页面卸载时由内核调用） */
  function disposeAll() {
    var ids = Array.from(disposers.keys());
    ids.forEach(function (id) { dispose(id); });
    emit('navext-unload', {});
  }

  // 页面卸载自动清理 —— 让"禁用/离开页面后定时器还在跑"的泄漏不再可能
  (function installUnloadHooks() {
    function onUnload() {
      try { disposeAll(); } catch (e) { /* 卸载路径不抛错 */ }
    }
    window.addEventListener('pagehide', onUnload, { capture: true });
    window.addEventListener('beforeunload', onUnload, { capture: true });

    // bfcache：进缓存时清理，恢复时重新派发 init 让扩展重建
    window.addEventListener('pageshow', function (e) {
      if (e && e.persisted) {
        extStates.clear();
        emit('init', { files: getFiles(), config: getConfig() });
      }
    });
  })();

  function collectCards() {
    cardIndex = new Map();
    var nodes = document.querySelectorAll('[data-ext-target="card"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = normPath(el.dataset.extPath || '');
      cardIndex.set(key, {
        el: el,
        icons: new Map(),
        badges: new Map(),
        classes: new Set(),
      });
    }
  }

  function getCardEl(path) {
    var entry = cardIndex.get(normPath(path));
    return entry ? entry.el : null;
  }

  function getVisibleCards() {
    var out = [];
    cardIndex.forEach(function (entry) {
      if (!entry.el.hidden) out.push(entry.el);
    });
    return out;
  }

  function ensureExtras(el) {
    var slot = el.querySelector('[data-ext-target="card-extras"]');
    if (!slot) {
      slot = document.createElement('div');
      slot.setAttribute('data-ext-target', 'card-extras');
      slot.className = 'ext-extras';
      el.appendChild(slot);
    }
    return slot;
  }

  function addCardIcon(path, iconUrl, opts) {
    opts = opts || {};
    var entry = cardIndex.get(normPath(path));
    if (!entry) return null;

    var key = opts.key || iconUrl;

    if (entry.icons.has(key)) {
      var exist = entry.icons.get(key);
      if (iconUrl && exist.src !== iconUrl) exist.src = iconUrl;
      if (opts.alt != null) exist.alt = opts.alt;
      if (opts.title != null) exist.title = opts.title;
      if (opts.size) {
        exist.style.width = opts.size + 'px';
        exist.style.height = opts.size + 'px';
      }
      return exist;
    }

    var img = document.createElement('img');
    img.setAttribute('data-ext-icon', key);
    img.className = 'ext-icon';
    img.src = iconUrl;
    img.alt = opts.alt || '';
    img.title = opts.title || '';
    img.loading = 'lazy';
    if (opts.size) {
      img.style.width = opts.size + 'px';
      img.style.height = opts.size + 'px';
    }

    ensureExtras(entry.el).appendChild(img);
    entry.icons.set(key, img);
    return img;
  }

  function contrastColor(bg) {
    if (typeof bg !== 'string') return '';
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(bg.trim());
    if (!m) return '';
    var hex = m[1];
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    var r = parseInt(hex.slice(0, 2), 16);
    var g = parseInt(hex.slice(2, 4), 16);
    var b = parseInt(hex.slice(4, 6), 16);
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? '#000' : '#fff';
  }

  function addCardBadge(path, text, color, opts) {
    opts = opts || {};
    var entry = cardIndex.get(normPath(path));
    if (!entry) return null;

    var key = opts.key || text;

    if (entry.badges.has(key)) {
      var exist = entry.badges.get(key);
      if (text != null) exist.textContent = String(text);
      if (color) {
        exist.style.background = color;
        exist.style.color = contrastColor(color);
      }
      return exist;
    }

    var span = document.createElement('span');
    span.setAttribute('data-ext-badge', key);
    span.className = 'ext-badge';
    span.textContent = String(text);
    if (color) {
      span.style.background = color;
      var fg = contrastColor(color);
      if (fg) span.style.color = fg;
    }

    ensureExtras(entry.el).appendChild(span);
    entry.badges.set(key, span);
    return span;
  }

  function addCardClass(path, className) {
    var entry = cardIndex.get(normPath(path));
    if (!entry || !className) return false;
    if (entry.classes.has(className)) return false;
    entry.el.classList.add(className);
    entry.classes.add(className);
    return true;
  }

  function removeCardClass(path, className) {
    var entry = cardIndex.get(normPath(path));
    if (!entry || !className) return false;
    if (!entry.classes.has(className)) return false;
    entry.el.classList.remove(className);
    entry.classes.delete(className);
    return true;
  }

  function setCardAttribute(path, name, value) {
    var entry = cardIndex.get(normPath(path));
    if (!entry) return false;
    if (value === null || value === undefined) entry.el.removeAttribute(name);
    else entry.el.setAttribute(name, String(value));
    return true;
  }

  function injectCSS(extId, css) {
    if (!extId || !css) return null;
    var style = document.createElement('style');
    style.setAttribute('data-ext-style', extId);
    style.textContent = String(css);
    document.head.appendChild(style);

    var arr = injectedStyles.get(extId) || [];
    arr.push(style);
    injectedStyles.set(extId, arr);
    return style;
  }

  function removeCSS(extId) {
    var arr = injectedStyles.get(extId);
    if (!arr) return;
    arr.forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    injectedStyles.delete(extId);
  }

  function notifyCardsChanged() {
    collectCards();
    var visible = getVisibleCards();
    emit('cards-updated', visible);   // 新事件名（正式）
    emit('cards-rendered', visible);  // 旧事件名（兼容）
  }

  // 外部 emit('cards-updated') 触发内部重新索引（替代直接调 _notifyCardsChanged）
  on('cards-updated', function () {
    collectCards();
    emit('cards-rendered', getVisibleCards());
  });

  /* ═══════════════════════════════════════════════════════════════════════
   *  内置 UI —— 视图切换（按目录 / 按时间） 与 主题控制（三档 + 自定义主题色）
   *  纯客户端、零依赖；状态落 localStorage；幂等挂载于 'cards-rendered'。
   * ═══════════════════════════════════════════════════════════════════════ */

  var LS = {
    view: 'navext.view',      // 'dir' | 'time'
    theme: 'navext.theme',    // 'system' | 'light' | 'dark'
    accent: 'navext.accent',  // '#rrggbb'
  };

  var DEFAULT_ACCENT = '#4f6ef7';

  var PRESET_ACCENTS = [
    { name: '靛蓝', color: '#4f6ef7' },
    { name: '翠绿', color: '#10a37f' },
    { name: '品红', color: '#e0447c' },
    { name: '琥珀', color: '#e08e0b' },
    { name: '天青', color: '#0aa2c0' },
    { name: '紫罗兰', color: '#8b5cf6' },
    { name: '朱红', color: '#e5484d' },
    { name: '石墨', color: '#5b6472' },
  ];

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function isHex6(c) { return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c); }

  // ---------- 主题（三档 + 自定义主题色） ----------

  function applyTheme(mode) {
    var de = document.documentElement;
    if (mode === 'dark' || mode === 'light') de.setAttribute('data-theme', mode);
    else de.removeAttribute('data-theme');   // 跟随系统
  }

  function applyAccent(color) {
    var de = document.documentElement;
    if (isHex6(color)) {
      de.style.setProperty('--brand', color);
      // 与 server.js 中 accentCss 的写法保持一致
      de.style.setProperty('--brand-ring', 'color-mix(in srgb, ' + color + ' 18%, transparent)');
    } else {
      de.style.removeProperty('--brand');
      de.style.removeProperty('--brand-ring');
    }
  }

  function setTheme(mode) {
    if (mode !== 'light' && mode !== 'dark') mode = 'system';
    applyTheme(mode);
    if (mode === 'system') lsDel(LS.theme); else lsSet(LS.theme, mode);
    syncThemePanel();
    emit('theme-changed', { theme: mode });
  }

  function setAccent(color) {
    if (color == null || color === '') {
      lsDel(LS.accent);
      applyAccent(null);           // 回落到 server.json / 默认
      // 回落后若站点配置了 accent，其值已在 BASE_STYLE 里；否则用默认
      var fallback = (DATA.config && DATA.config.site && DATA.config.site.accent) || DEFAULT_ACCENT;
      if (!isHex6(currentBrand())) applyAccent(fallback);
    } else if (isHex6(color)) {
      lsSet(LS.accent, color);
      applyAccent(color);
    }
    syncThemePanel();
    emit('accent-changed', { accent: currentBrand() });
  }

  function currentBrand() {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
    } catch (e) { return ''; }
  }

  function getTheme() { return lsGet(LS.theme) || 'system'; }
  function getAccent() {
    var a = lsGet(LS.accent);
    return isHex6(a) ? a : ((DATA.config && DATA.config.site && DATA.config.site.accent) || DEFAULT_ACCENT);
  }

  var CORE_UI_CSS = '.nx-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}' +
    '.nx-seg{display:inline-flex;background:var(--card);border:1px solid var(--line);border-radius:9px;padding:2px;gap:2px}' +
    '.nx-seg button{border:0;background:transparent;color:var(--muted);font:inherit;font-size:12.5px;' +
      'padding:5px 11px;border-radius:7px;cursor:pointer;transition:background .12s,color .12s}' +
    '.nx-seg button:hover{color:var(--text)}' +
    '.nx-seg button[aria-pressed="true"]{background:var(--brand);color:#fff}' +
    '.nx-btn{border:1px solid var(--line);background:var(--card);color:var(--muted);font:inherit;font-size:12.5px;' +
      'padding:6px 11px;border-radius:9px;cursor:pointer;transition:border-color .12s,color .12s}' +
    '.nx-btn:hover{border-color:var(--brand);color:var(--text)}' +
    '.nx-pop{position:absolute;z-index:60;margin-top:8px;right:0;width:264px;padding:14px;' +
      'background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}' +
    '.nx-pop h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.02em}' +
    '.nx-pop .nx-grp+.nx-grp{margin-top:14px}' +
    '.nx-swatches{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}' +
    '.nx-swatch{width:100%;aspect-ratio:1;border-radius:8px;border:2px solid transparent;cursor:pointer;padding:0;' +
      'transition:transform .1s}' +
    '.nx-swatch:hover{transform:scale(1.08)}' +
    '.nx-swatch[aria-pressed="true"]{border-color:var(--text)}' +
    '.nx-row{display:flex;align-items:center;gap:8px}' +
    '.nx-row input[type=color]{width:38px;height:30px;padding:0;border:1px solid var(--line);' +
      'border-radius:8px;background:var(--card);cursor:pointer}' +
    '.nx-row .nx-btn{flex:1}' +
    '.nx-holder{position:relative}' +
    // 时间视图：徽标样式
    '.nx-ago{font-size:10.5px;color:var(--brand);font-weight:600;white-space:nowrap}' +
    '.nx-ago::before{content:"⏱ "}' +
    // 时间视图下隐藏原目录分组外壳（保留 DOM，不删除）
    'main[data-nx-view="time"] > section[data-ext-target="section"]{display:none}' +
    'main[data-nx-view="time"] [data-nx-timewrap]{display:grid}';

  function injectCoreUI() {
    if (document.querySelector('style[data-nx-ui]')) return;
    var s = document.createElement('style');
    s.setAttribute('data-nx-ui', '1');
    s.textContent = CORE_UI_CSS;
    document.head.appendChild(s);
  }

  // ---------- 视图：按目录 / 按时间 ----------

  var applyingView = false;

  function relativeTime(ms) {
    var diff = Date.now() - Number(ms || 0);
    if (!isFinite(diff)) return '';
    var abs = Math.abs(diff);
    var MIN = 60000, HOUR = 3600000, DAY = 86400000;
    if (abs < MIN) return '刚刚';
    if (abs < HOUR) return Math.round(abs / MIN) + ' 分钟前';
    if (abs < DAY) return Math.round(abs / HOUR) + ' 小时前';
    var d = Math.round(abs / DAY);
    if (d < 30) return d + ' 天前';
    var mo = Math.round(d / 30);
    if (mo < 12) return mo + ' 个月前';
    return Math.round(mo / 12) + ' 年前';
  }

  /** 取（或创建）时间视图的平铺容器，插在 main 内的第一个 section 之前 */
  function getTimeWrap(main) {
    var w = main.querySelector('[data-nx-timewrap]');
    if (w) return w;
    w = document.createElement('section');
    w.setAttribute('data-nx-timewrap', '1');
    // 保留 grid 语义，扩展仍可识别
    var inner = document.createElement('div');
    inner.className = 'grid';
    inner.setAttribute('data-ext-target', 'grid');
    inner.setAttribute('data-nx-flat', '1');
    w.appendChild(inner);
    var firstSec = main.querySelector('section[data-ext-target="section"]');
    if (firstSec) main.insertBefore(w, firstSec); else main.appendChild(w);
    return w;
  }

  function applyView(mode) {
    var main = document.querySelector('main[data-ext-target="main"]');
    if (!main) return;
    if (mode !== 'time') mode = 'dir';

    // 防重入：applyView → notifyCardsChanged → emit('cards-rendered')
    // → mountUI → applyView 会无限递归，这里直接短路。
    if (applyingView) return;
    applyingView = true;
    try {
      applyViewInner(main, mode);
    } finally {
      applyingView = false;
    }
  }

  function applyViewInner(main, mode) {
    main.setAttribute('data-nx-view', mode);

    var wrap = getTimeWrap(main);
    var flat = wrap.querySelector('[data-nx-flat]');
    var cards = Array.prototype.slice.call(
      document.querySelectorAll('[data-ext-target="card"]')
    );

    if (mode === 'time') {
      // 按 mtime 降序平铺
      cards.sort(function (a, b) {
        return Number(b.dataset.extMtime || 0) - Number(a.dataset.extMtime || 0);
      });
      cards.forEach(function (c) {
        addAgoBadge(c);
        flat.appendChild(c);   // 移动节点（不改事件、不改索引）
      });
    } else {
      // 归还各 section 的 grid（按 data-ext-dir 找回原分组）
      var sections = main.querySelectorAll('section[data-ext-target="section"]');
      cards.forEach(function (c) {
        removeAgoBadge(c);
        var dir = c.dataset.extDir || '';
        var sec = null;
        for (var i = 0; i < sections.length; i++) {
          if ((sections[i].dataset.extDir || '') === dir) { sec = sections[i]; break; }
        }
        var target = sec
          ? sec.querySelector('[data-ext-target="grid"]')
          : flat;
        if (target) target.appendChild(c);
      });
      // 清空平铺容器，避免残留
      while (flat.firstChild) flat.removeChild(flat.firstChild);
    }

    lsSet(LS.view, mode);
    syncViewButtons();
    // 卡片节点被移动，重新应用当前搜索过滤词
    if (typeof window.__NAVEX_FILTER__ === 'function') {
      try { window.__NAVEX_FILTER__(); } catch (e) {}
    }
    // 让扩展重新索引（卡片节点被移动）
    try { notifyCardsChanged(); } catch (e) {}
    emit('view-changed', { view: mode });
  }

  function addAgoBadge(card) {
    if (card.querySelector('[data-nx-ago]')) return;
    var meta = card.querySelector('[data-ext-target="card-meta"]');
    if (!meta) return;
    var span = document.createElement('span');
    span.setAttribute('data-nx-ago', '1');
    span.className = 'nx-ago';
    span.textContent = relativeTime(card.dataset.extMtime);
    meta.appendChild(span);
  }

  function removeAgoBadge(card) {
    var b = card.querySelector('[data-nx-ago]');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  // ---------- UI 挂载 ----------

  var uiMounted = false;

  function syncViewButtons() {
    var seg = document.querySelector('[data-nx-viewseg]');
    if (!seg) return;
    var cur = lsGet(LS.view) || 'dir';
    Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', b.dataset.nxView === cur ? 'true' : 'false');
    });
  }

  function syncThemePanel() {
    var panel = document.querySelector('[data-nx-themepanel]');
    if (!panel) return;
    var t = getTheme(), a = getAccent();
    Array.prototype.forEach.call(panel.querySelectorAll('[data-nx-theme]'), function (b) {
      b.setAttribute('aria-pressed', b.dataset.nxTheme === t ? 'true' : 'false');
    });
    Array.prototype.forEach.call(panel.querySelectorAll('[data-nx-swatch]'), function (b) {
      b.setAttribute('aria-pressed', b.dataset.nxSwatch.toLowerCase() === a.toLowerCase() ? 'true' : 'false');
    });
    var picker = panel.querySelector('input[type=color]');
    if (picker && isHex6(a)) picker.value = a;
    var brand = currentBrand();
    var reset = panel.querySelector('[data-nx-reset]');
    if (reset) reset.hidden = !isHex6(lsGet(LS.accent)) && brand.toLowerCase() === a.toLowerCase();
  }

  function buildThemePanel() {
    var panel = document.createElement('div');
    panel.className = 'nx-pop';
    panel.setAttribute('data-nx-themepanel', '1');
    panel.hidden = true;

    var themeBtns = [
      { k: 'system', label: '跟随系统' },
      { k: 'light', label: '亮色' },
      { k: 'dark', label: '暗色' },
    ].map(function (o) {
      return '<button type="button" data-nx-theme="' + o.k + '" aria-pressed="false">' + o.label + '</button>';
    }).join('');

    var swatches = PRESET_ACCENTS.map(function (p) {
      return '<button type="button" class="nx-swatch" data-nx-swatch="' + p.color +
        '" title="' + p.name + '" style="background:' + p.color + '" aria-pressed="false"></button>';
    }).join('');

    panel.innerHTML =
      '<div class="nx-grp"><h4>主题</h4><div class="nx-seg" data-nx-themeseg>' + themeBtns + '</div></div>' +
      '<div class="nx-grp"><h4>主题色</h4><div class="nx-swatches">' + swatches + '</div>' +
        '<div class="nx-row" style="margin-top:9px">' +
          '<input type="color" aria-label="自定义主题色">' +
          '<button type="button" class="nx-btn" data-nx-pickbtn>应用</button>' +
          '<button type="button" class="nx-btn" data-nx-reset hidden>恢复默认</button>' +
        '</div>' +
      '</div>';

    panel.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || !panel.contains(b)) return;
      if (b.dataset.nxTheme) setTheme(b.dataset.nxTheme);
      else if (b.dataset.nxSwatch) setAccent(b.dataset.nxSwatch);
      else if (b.hasAttribute('data-nx-pickbtn')) {
        var p = panel.querySelector('input[type=color]');
        if (p) setAccent(p.value);
      } else if (b.hasAttribute('data-nx-reset')) {
        setAccent(null);
      }
    });
    panel.addEventListener('change', function (e) {
      if (e.target && e.target.type === 'color') setAccent(e.target.value);
    });
    return panel;
  }

  function mountUI() {
    injectCoreUI();

    var search = document.querySelector('[data-ext-target="search"]');
    var headerTop = document.querySelector('[data-ext-target="header-top"]');

    // 容器
    var tools = document.querySelector('[data-nx-tools]');
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'nx-tools';
      tools.setAttribute('data-nx-tools', '1');
      if (search && search.parentNode) search.parentNode.insertBefore(tools, search.nextSibling);
      else headerTop.appendChild(tools);
    }

    // 视图切换
    if (!tools.querySelector('[data-nx-viewseg]')) {
      var seg = document.createElement('div');
      seg.className = 'nx-seg';
      seg.setAttribute('data-nx-viewseg', '1');
      seg.innerHTML = '<button type="button" data-nx-view="dir">按目录</button>' +
                      '<button type="button" data-nx-view="time">按时间</button>';
      seg.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('button') : null;
        if (b && b.dataset.nxView) applyView(b.dataset.nxView);
      });
      tools.appendChild(seg);
    }

    // 主题入口 + 面板
    var holder = tools.querySelector('[data-nx-themeholder]');
    if (!holder) {
      holder = document.createElement('div');
      holder.className = 'nx-holder';
      holder.setAttribute('data-nx-themeholder', '1');
      holder.style.marginLeft = 'auto';

      var tbtn = document.createElement('button');
      tbtn.type = 'button';
      tbtn.className = 'nx-btn';
      tbtn.setAttribute('data-nx-themebtn', '1');
      tbtn.setAttribute('aria-label', '外观设置');
      tbtn.textContent = '外观';

      var panel = buildThemePanel();
      holder.appendChild(tbtn);
      holder.appendChild(panel);

      tbtn.addEventListener('click', function (e) {
        e.stopPropagation();
        panel.hidden = !panel.hidden;
        if (!panel.hidden) syncThemePanel();
      });
      document.addEventListener('click', function (e) {
        if (!panel.hidden && !holder.contains(e.target)) panel.hidden = true;
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !panel.hidden) panel.hidden = true;
      });
      tools.appendChild(holder);
    }

    // 恢复到上次的视图与主题
    applyTheme(getTheme());
    var savedAccent = lsGet(LS.accent);
    if (isHex6(savedAccent)) applyAccent(savedAccent);
    syncViewButtons();
    syncThemePanel();

    var cur = lsGet(LS.view) || 'dir';
    var mainEl = document.querySelector('main[data-ext-target="main"]');
    var curApplied = mainEl ? (mainEl.getAttribute('data-nx-view') || 'dir') : 'dir';
    if (cur === 'time' && curApplied !== 'time') applyView('time');

    uiMounted = true;
  }

  // ═══ 对外暴露的内置 UI 控制 ═══
  var uiApi = {
    setView: applyView,
    getView: function () { return lsGet(LS.view) || 'dir'; },
    setTheme: setTheme,
    getTheme: getTheme,
    setAccent: setAccent,
    getAccent: getAccent,
    presets: PRESET_ACCENTS.slice(),
  };

  // 幂等挂载：首次 init 与每次 cards-rendered 都尝试（防止被清空）
  on('cards-rendered', function () {
    try { mountUI(); }
    catch (err) {
      if (window.console) console.warn('[NavExt] 内置 UI 挂载失败:', err);
    }
  });

  window.NavExt = {
    version: VERSION,

    getFiles: getFiles,
    getFile: getFile,
    getConfig: getConfig,
    getExtensions: getExtensions,
    search: search,

    // ── 路径归一化（v2.7）：统一 URL / 相对两套体系 ──
    urlToRel: urlToRel,
    relToUrl: relToUrl,
    normalizePath: normalizePath,
    pathOf: pathOf,

    // ── 生命周期（v2.7）：扩展自清理 ──
    disposer: disposer,
    dispose: dispose,
    isDisposed: isDisposed,

    getExtMeta: getExtMeta,
    isExtActive: isExtActive,
    getActiveExtensions: getActiveExtensions,
    getActiveExtIds: getActiveExtIds,
    getExtConfig: getExtConfig,
    getExtConfigSchema: getExtConfigSchema,
    getExtConfigField: getExtConfigField,
    getExtStats: getExtStats,
    setExtConfig: setExtConfig,
    resetExtConfig: resetExtConfig,

    fs: fsApi,
    extFs: extFs,

    getCardEl: getCardEl,
    getVisibleCards: getVisibleCards,
    addCardIcon: addCardIcon,
    addCardBadge: addCardBadge,
    addCardClass: addCardClass,
    removeCardClass: removeCardClass,
    setCardAttribute: setCardAttribute,

    on: on,
    once: once,
    emit: emit,

    injectCSS: injectCSS,
    removeCSS: removeCSS,

    ui: uiApi,

    _notifyCardsChanged: notifyCardsChanged,   // 保留别名
    notifyCardsChanged: notifyCardsChanged,   // 正式名
  };

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  ready(function () {
    buildExtIndex();
    collectCards();
    emit('init', { files: getFiles(), config: getConfig() });
    setTimeout(function () {
      emit('cards-rendered', getVisibleCards());
    }, 0);
  });
})();
