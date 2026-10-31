/**
 * @runx-browser-api —— 浏览器能力层。
 *
 * ── 这个文件解决什么 ───────────────────────────────────────────
 * 同一个功能，在不同浏览器里可能是「有」「没有」「有但会抛异常」「有但需要用户
 * 手势」四种状态。散落在各处 if-else 的结果是：桌面里能用、手机浏览器里静默失败、
 * Safari 无痕里白屏，而且没人知道是哪一层挂的。
 *
 * 所以这里把每件事收成一个函数，内部**逐级降级**，并且把「这次实际用了哪一级」
 * 报出来（`caps` 表 + `degrade` 事件）。调用方只需要 `RunX.browser.clipboard.write(x)`，
 * 不需要知道底下是 Clipboard API 还是 execCommand。
 *
 * 降级链一览（越靠前越好，最后一级是保底）：
 *
 *   存储      IndexedDB        → localStorage  → 内存（不持久，刷新即失）
 *   剪贴板写  Clipboard API    → execCommand   → 抛 NEED_GESTURE
 *   剪贴板读  Clipboard API    → 抛 NEED_GESTURE（让调用方弹「按 ⌘V」）
 *   通知      Notification     → 桌面 toast    → 自绘 toast
 *   全屏      标准 API         → webkit 前缀   → 抛 UNSUPPORTED
 *   保存文件  showSaveFilePicker → <a download> → 新窗口打开
 *   选择文件  showOpenFilePicker → <input type=file>
 *   分享      navigator.share  → 复制链接 + toast
 *   震动      navigator.vibrate → 静默成功（桌面上本来就不该震）
 *
 * ── 为什么存储要单独做一层 ──────────────────────────────────────
 * 浏览器存储有三个坑，直接用 localStorage 都会踩：
 *   1. 私密模式 / 禁用第三方 Cookie 时 `setItem` 直接抛 QuotaExceededError，
 *      而不是「返回 false」—— 一个没 try 的写入就能让整个应用白屏；
 *   2. 配额是 5MB 且**按源**计，桌面、文件管理器、每个应用都往里写，很快就满；
 *   3. 满了以后 `setItem` 抛异常，但没有任何「谁占了多少」的接口。
 * 所以这里统一成异步 KV：优先 IndexedDB（配额按磁盘比例，几十 MB 起），
 * 写入失败时按「最久没更新」淘汰一批再重试，并把淘汰事件发出来。
 *
 * 全局挂载：`window.RunX.browser`（与 RunX.bus / RunX.files 同一命名空间）。
 */
(function () {
  'use strict';

  var RunX = (window.RunX = window.RunX || {});
  if (RunX.browser) return;   // 扩展热重载会重复注入，第二次直接跳过

  var VERSION = '0.1.0';
  var PREFIX = 'rx:';          // localStorage 的键前缀，避免和别人的键打架
  var DB_NAME = 'runx';
  var DB_STORE = 'kv';

  /* ═══════════════════════════════════════════════════════════════
   * 0. 基础设施
   * ═══════════════════════════════════════════════════════════════ */

  function now() { return Date.now(); }
  function noop() {}

  /** 给错误打上可判别的标记：调用方按 code 分流，不解析文案 */
  function tagged(code, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }

  /** 极简事件器：只有三个方法，够用就好 */
  function Emitter() { this._h = {}; }
  Emitter.prototype.on = function (ev, fn) {
    (this._h[ev] || (this._h[ev] = [])).push(fn);
    var self = this;
    return function () { self.off(ev, fn); };
  };
  Emitter.prototype.off = function (ev, fn) {
    var a = this._h[ev];
    if (!a) return;
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  Emitter.prototype.emit = function (ev, payload) {
    var a = this._h[ev];
    if (!a) return;
    for (var i = 0; i < a.length; i++) {
      try { a[i](payload); }
      catch (e) { /* 一个监听器抛错不该影响其它监听器 */ }
    }
  };

  var bus = new Emitter();

  /* ═══════════════════════════════════════════════════════════════
   * 1. 环境快照
   *
   * 只读、惰性求值不需要 —— 这些值在页面生命周期内基本不变，但网络状态会变，
   * 所以网络单独走 net.onChange，不进这里。
   * ═══════════════════════════════════════════════════════════════ */
  var env = (function () {
    var ua = navigator.userAgent || '';
    var mq = function (q) {
      try { return !!(window.matchMedia && window.matchMedia(q).matches); }
      catch (e) { return false; }
    };
    return {
      mobile: /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua) ||
        (navigator.maxTouchPoints > 1 && mq('(pointer: coarse)')),
      touch: ('ontouchstart' in window) || navigator.maxTouchPoints > 0,
      // 安装成 PWA 后没有浏览器地址栏，一些「打开新标签」的操作要换做法
      standalone: mq('(display-mode: standalone)') || navigator.standalone === true,
      // 安全上下文决定 Clipboard / ServiceWorker / getUserMedia 能不能用
      secure: !!window.isSecureContext,
      dark: mq('(prefers-color-scheme: dark)'),
      reducedMotion: mq('(prefers-reduced-motion: reduce)'),
      coarse: mq('(pointer: coarse)'),
      locale: navigator.language || 'zh-CN',
      tz: (function () {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
        catch (e) { return ''; }
      })(),
      dpr: window.devicePixelRatio || 1,
      cores: navigator.hardwareConcurrency || 0,
      // deviceMemory 只有 Chrome 有，单位 GB；0 表示未知
      memory: navigator.deviceMemory || 0,
      online: navigator.onLine !== false,
      saveData: !!(navigator.connection && navigator.connection.saveData),
      // 网络类型：4g / 3g / 2g / slow-2g，只有 Chrome 系提供
      netType: (navigator.connection && navigator.connection.effectiveType) || '',
      ios: /iPad|iPhone|iPod/.test(ua) || (ua.indexOf('Mac') >= 0 && navigator.maxTouchPoints > 1),
      safari: /^((?!chrome|android|crios|fxios).)*safari/i.test(ua),
    };
  })();

  /* ═══════════════════════════════════════════════════════════════
   * 2. 存储后端
   *
   * 三条实现共用一套接口（全异步，即使 localStorage 是同步的）：
   *   get(k) → entry|null    set(k, entry)    del(k)    keys() → string[]
   *   clear()
   * entry = { v: 值, e: 过期时间戳|null, t: 最后更新时间戳 }
   * ═══════════════════════════════════════════════════════════════ */

  function memBackend() {
    var map = {};
    return {
      kind: 'memory', durable: false,
      get: function (k) { return Promise.resolve(k in map ? map[k] : null); },
      set: function (k, e) { map[k] = e; return Promise.resolve(); },
      del: function (k) { delete map[k]; return Promise.resolve(); },
      keys: function () { return Promise.resolve(Object.keys(map)); },
      clear: function () { map = {}; return Promise.resolve(); },
    };
  }

  /**
   * localStorage 后端。
   *
   * 可用性判断必须**真写一次**：Safari 无痕模式下 `localStorage` 对象存在、
   * `setItem` 存在，但一写就抛 QuotaExceededError。只判断 `in window` 会误判。
   */
  function lsAvailable() {
    try {
      var k = PREFIX + '__probe__';
      localStorage.setItem(k, '1');
      var ok = localStorage.getItem(k) === '1';
      localStorage.removeItem(k);
      return ok;
    } catch (e) { return false; }
  }

  function lsBackend() {
    return {
      kind: 'localstorage', durable: true,
      get: function (k) {
        try {
          var raw = localStorage.getItem(PREFIX + k);
          if (raw == null) return Promise.resolve(null);
          return Promise.resolve(JSON.parse(raw));
        } catch (e) {
          // 别人写坏了（或者我们上一版格式不同）就当没有，不要让它变成致命错误
          return Promise.resolve(null);
        }
      },
      set: function (k, e) {
        try { localStorage.setItem(PREFIX + k, JSON.stringify(e)); }
        catch (err) { return Promise.reject(err); }
        return Promise.resolve();
      },
      del: function (k) {
        try { localStorage.removeItem(PREFIX + k); } catch (e) { /* 忽略 */ }
        return Promise.resolve();
      },
      keys: function () {
        var out = [];
        try {
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            // __probe__ / __migrated__ 这类内部键以双下划线开头，不暴露给调用方
            if (k && k.indexOf(PREFIX) === 0 && k.indexOf(PREFIX + '__') !== 0) {
              out.push(k.slice(PREFIX.length));
            }
          }
        } catch (e) { /* 读不到就当空 */ }
        return Promise.resolve(out);
      },
      clear: function () {
        var self = this;
        return self.keys().then(function (ks) {
          for (var i = 0; i < ks.length; i++) {
            try { localStorage.removeItem(PREFIX + ks[i]); } catch (e) { /* 忽略 */ }
          }
        });
      },
    };
  }

  function idbBackend(db) {
    function store(mode) { return db.transaction(DB_STORE, mode).objectStore(DB_STORE); }
    function wrap(req) {
      return new Promise(function (res, rej) {
        req.onsuccess = function () { res(req.result); };
        req.onerror = function () { rej(req.error || tagged('IDB', 'IndexedDB 操作失败')); };
      });
    }
    /**
     * 把「建事务 + 发请求」这步也算进 Promise。
     *
     * 这一步是会同步抛的：事务已经结束（TransactionInactiveError）、键类型不合法
     * （DataError）、或者浏览器在配额边缘直接抛 QuotaExceededError。同步异常穿不过
     * 后面的 `.catch`，淘汰逻辑就永远不会被触发 —— 表面上「写入失败了」，实际上
     * 是「错误没被接住」。
     */
    function op(mode, fn) {
      return new Promise(function (res, rej) {
        var req;
        try { req = fn(store(mode)); }
        catch (e) { return rej(e); }
        req.onsuccess = function () { res(req.result); };
        req.onerror = function () { rej(req.error || tagged('IDB', 'IndexedDB 操作失败')); };
      });
    }
    return {
      kind: 'indexeddb', durable: true,
      get: function (k) {
        return op('readonly', function (s) { return s.get(k); }).then(function (v) {
          return v === undefined ? null : v;
        });
      },
      set: function (k, e) { return op('readwrite', function (s) { return s.put(e, k); }); },
      del: function (k) { return op('readwrite', function (s) { return s.delete(k); }); },
      keys: function () {
        return op('readonly', function (s) { return s.getAllKeys(); }).then(function (a) { return a || []; });
      },
      clear: function () { return op('readwrite', function (s) { return s.clear(); }); },
    };
  }

  /**
   * 开库。
   *
   * 必须有超时：某些内嵌 WebView 和 Safari 无痕下 `indexedDB.open` 既不 success
   * 也不 error，回调永远不来。没有超时的话整个存储初始化会挂在那里，之后所有
   * await storage.* 的代码都静默不执行。
   */
  function openIDB() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) return resolve(null);
      var req;
      try { req = indexedDB.open(DB_NAME, 1); }
      catch (e) { return resolve(null); }

      var settled = false;
      var timer = setTimeout(function () { done(null); }, 3000);
      function done(v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }

      req.onupgradeneeded = function () {
        try {
          var db = req.result;
          if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
        } catch (e) { /* 建表失败会在 onerror 里体现 */ }
      };
      req.onsuccess = function () { done(req.result); };
      req.onerror = function () { done(null); };
      req.onblocked = function () { done(null); };
    });
  }

  /** 存储层就绪（后端选定 + 迁移完成）之前，所有操作都等它 */
  var readyBackend = (function () {
    return openIDB().then(function (db) {
      if (db) {
        var be = idbBackend(db);
        // 上一版可能用的是 localStorage，把旧键搬过来再删掉。
        // 只搬一次，用 __migrated__ 标记，避免每次启动都扫一遍。
        return be.get('__migrated__').then(function (flag) {
          if (flag || !lsAvailable()) return be;
          var ls = lsBackend();
          return ls.keys().then(function (ks) {
            return ks.reduce(function (p, k) {
              return p.then(function () {
                return ls.get(k).then(function (entry) {
                  if (!entry) return null;
                  return be.set(k, entry).then(function () { return ls.del(k); });
                });
              });
            }, Promise.resolve()).then(function () {
              return be.set('__migrated__', { v: 1, e: null, t: now() });
            }).then(function () { return be; });
          });
        }).catch(function () { return be; });
      }
      if (lsAvailable()) return lsBackend();
      return memBackend();   // 私密模式：能跑，但刷新就丢
    }).catch(function () {
      return lsAvailable() ? lsBackend() : memBackend();
    });
  })();

  /* ── 配额 ── */

  function isQuotaError(err) {
    if (!err) return false;
    // 三种写法都见过：DOMException.name、code 22、Safari 的老 code 1014
    return err.name === 'QuotaExceededError' ||
      err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      err.code === 22 || err.code === 1014;
  }

  function estimate() {
    if (navigator.storage && navigator.storage.estimate) {
      return navigator.storage.estimate().catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  /* ═══════════════════════════════════════════════════════════════
   * 3. 命名空间化存储
   *
   * 每个调用方（桌面、文件管理器、某个应用）拿自己的 store，键互不干扰；
   * 但配额是共享的，所以淘汰要跨命名空间做 —— 这也是为什么后端是全局单例。
   * ═══════════════════════════════════════════════════════════════ */

  function createStore(ns) {
    var prefix = (ns || 'default') + '/';

    function k(key) { return prefix + key; }

    var api = {
      ns: ns || 'default',

      /** 后端类型与是否持久 —— 调用方据此决定要不要提示「关掉浏览器就没了」 */
      backend: function () {
        return readyBackend.then(function (be) {
          return { kind: be.kind, durable: be.durable };
        });
      },

      get: function (key, dflt) {
        return readyBackend.then(function (be) {
          return be.get(k(key)).then(function (entry) {
            if (!entry) return dflt === undefined ? null : dflt;
            // 过期即删：读取时顺手清，省一个定时器
            if (entry.e && entry.e <= now()) {
              return be.del(k(key)).then(function () {
                return dflt === undefined ? null : dflt;
              });
            }
            return entry.v;
          });
        });
      },

      /**
       * @param {string} key
       * @param {*} value 必须能被结构化克隆（IndexedDB 的限制），函数/闭包不行
       * @param {{ttl?:number}} [opts] ttl 毫秒；不传则永不过期
       */
      set: function (key, value, opts) {
        var ttl = opts && opts.ttl;
        var entry = { v: value, e: ttl ? now() + ttl : null, t: now() };
        return readyBackend.then(function (be) {
          // 用 Promise.resolve().then 包一层：后端可能同步抛（localStorage 就是），
          // 直接 be.set(...).catch 的话同步异常根本走不到 catch
          return Promise.resolve().then(function () { return be.set(k(key), entry); }).catch(function (err) {
            if (!isQuotaError(err)) throw err;
            // 满了：淘汰最久没更新的一批再试一次。只重试一次 —— 再失败说明
            // 单个值本身比剩余空间还大，重试多少次都一样。
            return evict(0.25).then(function () {
              return be.set(k(key), entry);
            }).catch(function () {
              throw tagged('QUOTA', '浏览器存储空间已满，且清理后仍写不进去');
            });
          });
        }).then(function () { return value; });
      },

      del: function (key) {
        return readyBackend.then(function (be) { return be.del(k(key)); }).then(noop);
      },

      has: function (key) {
        return api.get(key, null).then(function (v) { return v !== null; });
      },

      /** 本命名空间下的所有键（不含前缀） */
      keys: function () {
        return readyBackend.then(function (be) {
          return be.keys().then(function (all) {
            return all.filter(function (x) {
              return x.indexOf(prefix) === 0 && x.indexOf('__') !== 0;
            }).map(function (x) { return x.slice(prefix.length); });
          });
        });
      },

      /** 清掉本命名空间，不动别人的 */
      clear: function () {
        return api.keys().then(function (ks) {
          return Promise.all(ks.map(api.del));
        }).then(noop);
      },

      /** 本命名空间占用的粗略字节数（JSON 长度，不算压缩与索引开销） */
      size: function () {
        return readyBackend.then(function (be) {
          return be.keys().then(function (all) {
            var mine = all.filter(function (x) { return x.indexOf(prefix) === 0; });
            return mine.reduce(function (p, key) {
              return p.then(function (sum) {
                return be.get(key).then(function (entry) {
                  if (!entry) return sum;
                  try { return sum + (key.length + JSON.stringify(entry.v).length) * 2; }
                  catch (e) { return sum; }
                });
              });
            }, Promise.resolve(0));
          });
        });
      },
    };

    return api;
  }

  /**
   * 淘汰：按最后更新时间升序删掉 ratio 比例。
   *
   * 只删「最近没动过」的，不删刚写的 —— 刚写的多半是当前页面正在用的东西，
   * 删了会立刻出现「刚存进去就没了」的灵异现象。
   */
  function evict(ratio) {
    return readyBackend.then(function (be) {
      return be.keys().then(function (all) {
        var live = all.filter(function (x) { return x.indexOf('__') !== 0; });
        return live.reduce(function (p, key) {
          return p.then(function (rows) {
            return be.get(key).then(function (entry) {
              if (entry) rows.push({ key: key, t: entry.t || 0 });
              return rows;
            });
          });
        }, Promise.resolve([])).then(function (rows) {
          rows.sort(function (a, b) { return a.t - b.t; });
          var n = Math.max(1, Math.round(rows.length * (ratio || 0.25)));
          var victims = rows.slice(0, n);
          return victims.reduce(function (p, row) {
            return p.then(function () { return be.del(row.key); });
          }, Promise.resolve()).then(function () {
            if (victims.length) {
              bus.emit('evict', {
                count: victims.length,
                keys: victims.map(function (v) { return v.key; }),
              });
              bus.emit('degrade', { what: 'storage', why: 'quota', detail: '已淘汰最久未更新的 ' + victims.length + ' 项' });
            }
            return victims.length;
          });
        });
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════
   * 4. 剪贴板
   * ═══════════════════════════════════════════════════════════════ */

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    // 不能用 display:none / visibility:hidden —— 那样选不中，execCommand 会失败。
    // 移出视口是唯一既不可见又能选中的做法。
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    var sel = document.getSelection();
    var saved = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    ta.select();
    ta.setSelectionRange(0, ta.value.length);   // iOS 上必须显式 setSelectionRange
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (saved && sel) { try { sel.removeAllRanges(); sel.addRange(saved); } catch (e) { /* 选区回不去也无所谓 */ } }
    return ok;
  }

  var clipboard = {
    /**
     * @returns {Promise<'clipboard'|'exec'>} 实际用了哪一级 —— 调试时有用，
     *   正常调用可以忽略返回值。
     */
    write: function (text) {
      var s = String(text == null ? '' : text);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(s).then(function () {
          return 'clipboard';
        }, function () {
          // 常见原因：不在安全上下文、页面没有焦点、用户没给权限。
          // 不管哪种，execCommand 这条老路在同样场景下往往还能用。
          return legacyCopy(s) ? 'exec' : Promise.reject(
            tagged('CLIPBOARD_DENIED', '复制被浏览器拒绝，请手动选中复制'));
        });
      }
      if (legacyCopy(s)) return Promise.resolve('exec');
      return Promise.reject(tagged('CLIPBOARD_DENIED', '当前浏览器不允许脚本写剪贴板'));
    },

    /**
     * 读剪贴板。绝大多数浏览器要求「用户手势 + 显式授权」，所以这里几乎总是
     * 走到「需要用户自己按粘贴」这一级 —— 调用方应该准备好对应 UI，而不是
     * 把错误当成失败。
     */
    read: function () {
      if (navigator.clipboard && navigator.clipboard.readText) {
        return navigator.clipboard.readText().then(function (t) {
          return { text: t, via: 'clipboard' };
        }, function () {
          return Promise.reject(tagged('NEED_GESTURE', '浏览器需要你在页面上按 ⌘V / Ctrl+V 才能读取剪贴板'));
        });
      }
      return Promise.reject(tagged('NEED_GESTURE', '当前浏览器不支持脚本读取剪贴板'));
    },

    /** 一次性捕获粘贴：返回 Promise，用户在任何地方按 ⌘V 都会 resolve */
    capture: function (timeout) {
      return new Promise(function (resolve, reject) {
        var done = false;
        function cleanup() {
          document.removeEventListener('paste', onPaste, true);
          clearTimeout(timer);
        }
        function onPaste(e) {
          if (done) return;
          done = true;
          cleanup();
          var t = '';
          try { t = (e.clipboardData || window.clipboardData).getData('text') || ''; } catch (err) { t = ''; }
          resolve(t);
        }
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          cleanup();
          reject(tagged('TIMEOUT', '没有等到粘贴操作'));
        }, timeout || 15000);
        document.addEventListener('paste', onPaste, true);
      });
    },
  };

  /* ═══════════════════════════════════════════════════════════════
   * 5. 通知
   * ═══════════════════════════════════════════════════════════════ */

  var toastHost = null;

  function selfToast(title, body) {
    if (!document.body) return false;
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:100000;display:flex;' +
        'flex-direction:column;gap:8px;pointer-events:none;max-width:min(320px,80vw)';
      document.body.appendChild(toastHost);
    }
    var card = document.createElement('div');
    card.style.cssText = 'pointer-events:auto;background:rgba(28,28,32,.92);color:#fff;border-radius:12px;' +
      'padding:10px 14px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.3);' +
      'opacity:0;transform:translateY(6px);transition:opacity .18s,transform .18s';
    var t = document.createElement('div');
    t.style.cssText = 'font-weight:600;margin-bottom:2px';
    t.textContent = title || '';
    card.appendChild(t);
    if (body) {
      var b = document.createElement('div');
      b.style.cssText = 'color:rgba(255,255,255,.72)';
      b.textContent = body;
      card.appendChild(b);
    }
    toastHost.appendChild(card);
    requestAnimationFrame(function () {
      card.style.opacity = '1';
      card.style.transform = 'none';
    });
    setTimeout(function () {
      card.style.opacity = '0';
      setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 220);
    }, 3600);
    return true;
  }

  function notify(o) {
    var opt = o || {};
    var title = String(opt.title || 'RunX');
    var body = String(opt.body || '');

    // ① 桌面壳里优先用它的提示条：位置、主题、动效都是现成的，
    //    系统通知在桌面里反而会跑到操作系统通知中心，和桌面割裂。
    if (window.__runx && typeof window.__runx.toast === 'function' && !opt.system) {
      try {
        window.__runx.toast(title + (body ? '：' + body : ''));
        return Promise.resolve('desktop');
      } catch (e) { /* 落到下一级 */ }
    }

    // ② 系统通知：只在**已经授权**时才用。主动 requestPermission 会弹一个大
    //    框，把用户正在做的事打断 —— 那应该由用户在设置里显式开启。
    if (window.Notification && Notification.permission === 'granted' && !env.standalone) {
      try {
        var n = new Notification(title, { body: body, icon: opt.icon || undefined, tag: opt.tag || undefined });
        if (opt.onClick) n.onclick = opt.onClick;
        return Promise.resolve('system');
      } catch (e) { /* 某些平台构造函数直接抛（Android Chrome） */ }
    }

    // ③ 自绘
    return Promise.resolve(selfToast(title, body) ? 'inline' : 'none');
  }

  /* ═══════════════════════════════════════════════════════════════
   * 6. 全屏 / 分享 / 震动 / 角标 / 文件
   * ═══════════════════════════════════════════════════════════════ */

  var fullscreen = {
    isOn: function () {
      return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
    },
    enter: function (el) {
      var node = el || document.documentElement;
      var fn = node.requestFullscreen || node.webkitRequestFullscreen || node.mozRequestFullScreen || node.msRequestFullscreen;
      if (!fn) return Promise.reject(tagged('UNSUPPORTED', '当前浏览器不支持全屏'));
      try {
        var r = fn.call(node);
        return (r && r.then) ? r : Promise.resolve(true);
      } catch (e) {
        // iOS Safari 只允许 <video> 全屏；调用会抛，这里如实报出来
        return Promise.reject(tagged('UNSUPPORTED', '当前浏览器拒绝全屏：' + e.message));
      }
    },
    exit: function () {
      var fn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
      if (!fn) return Promise.resolve(false);
      try {
        var r = fn.call(document);
        return (r && r.then) ? r : Promise.resolve(true);
      } catch (e) { return Promise.resolve(false); }
    },
    toggle: function (el) {
      return fullscreen.isOn() ? fullscreen.exit() : fullscreen.enter(el);
    },
  };

  function share(o) {
    var opt = o || {};
    if (navigator.share) {
      return navigator.share({
        title: opt.title || document.title,
        text: opt.text || '',
        url: opt.url || location.href,
      }).then(function () { return 'share'; }, function (err) {
        // 用户主动取消不算失败，但也不该当成功 —— 用 ABORT 区分
        if (err && err.name === 'AbortError') throw tagged('ABORT', '用户取消了分享');
        throw err;
      });
    }
    // 没有原生分享：把链接复制走，比弹一个「不支持」有用
    var link = opt.url || location.href;
    return clipboard.write(link).then(function (via) {
      selfToast('链接已复制', link);
      return 'copy:' + via;
    }).catch(function () {
      throw tagged('UNSUPPORTED', '当前浏览器不支持分享，也无法复制链接');
    });
  }

  function vibrate(pattern) {
    if (!navigator.vibrate) return false;
    try { return navigator.vibrate(pattern); } catch (e) { return false; }
  }

  var file = {
    /**
     * 选择文件。优先 File System Access API（能拿到 handle，可读写），
     * 否则退到 <input type=file>（只能读一次）。
     * @returns {Promise<File[]>}
     */
    pick: function (o) {
      var opt = o || {};
      if (window.showOpenFilePicker && !env.ios) {
        return window.showOpenFilePicker({
          multiple: !!opt.multiple,
          types: opt.accept ? [{ description: opt.description || '文件', accept: opt.accept }] : undefined,
        }).then(function (handles) {
          return Promise.all(handles.map(function (h) { return h.getFile(); }));
        }).catch(function (err) {
          if (err && err.name === 'AbortError') throw tagged('ABORT', '用户取消了选择');
          // 有些环境暴露了 API 但调用就抛（比如 iframe 没有权限），退到 input
          return inputPick(opt);
        });
      }
      return inputPick(opt);
    },

    /**
     * 保存。优先 showSaveFilePicker，否则造一个 <a download> 点一下。
     * @param {string} name 建议文件名
     * @param {Blob|string} data
     */
    save: function (name, data) {
      var blob = (data instanceof Blob) ? data : new Blob([data == null ? '' : data], { type: 'text/plain;charset=utf-8' });
      if (window.showSaveFilePicker && !env.ios) {
        return window.showSaveFilePicker({ suggestedName: name }).then(function (h) {
          return h.createWritable();
        }).then(function (w) {
          return w.write(blob).then(function () { return w.close(); });
        }).then(function () { return 'picker'; }).catch(function (err) {
          if (err && err.name === 'AbortError') throw tagged('ABORT', '用户取消了保存');
          return anchorSave(name, blob);
        });
      }
      return Promise.resolve(anchorSave(name, blob));
    },
  };

  function inputPick(opt) {
    return new Promise(function (resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      if (opt.multiple) input.multiple = true;
      if (opt.accept) input.accept = opt.accept;
      input.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(input);
      var settled = false;
      input.addEventListener('change', function () {
        settled = true;
        var files = [].slice.call(input.files || []);
        document.body.removeChild(input);
        if (!files.length) return reject(tagged('ABORT', '没有选择文件'));
        resolve(files);
      });
      // 用户点取消时没有 change 事件，只能靠窗口重新聚焦来判断 —— 加上超时兜底
      window.addEventListener('focus', function onFocus() {
        window.removeEventListener('focus', onFocus);
        setTimeout(function () {
          if (settled) return;
          settled = true;
          if (input.parentNode) input.parentNode.removeChild(input);
          reject(tagged('ABORT', '没有选择文件'));
        }, 500);
      });
      input.click();
    });
  }

  function anchorSave(name, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name || 'download';
    a.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(a);
    a.click();
    // 立刻 revoke 会让下载失败（Safari 尤其），等一拍再收
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 4000);
    return 'download';
  }

  /* ═══════════════════════════════════════════════════════════════
   * 7. 网络
   * ═══════════════════════════════════════════════════════════════ */

  var net = {
    online: function () { return navigator.onLine !== false; },
    onChange: function (cb) {
      function up() { cb({ online: true }); }
      function down() { cb({ online: false }); }
      window.addEventListener('online', up);
      window.addEventListener('offline', down);
      return function () {
        window.removeEventListener('online', up);
        window.removeEventListener('offline', down);
      };
    },
  };

  /* ═══════════════════════════════════════════════════════════════
   * 8. 能力表
   *
   * 不是「有没有这个 API」，而是「这个功能在这台设备上最终能不能用」——
   * 有些 API 存在但永远失败（比如 iOS 的 Notification），那对调用方来说
   * 就是不可用，必须如实报 false，否则调用方会写出「点了没反应」的按钮。
   * ═══════════════════════════════════════════════════════════════ */

  var caps = {
    // via 是异步填的（要开库才知道后端），初始化完成后由下面的 readyBackend 改写。
    // 这里不能用 getter：赋值会抛「only a getter」，而且每次读都返回新对象，
    // 外部改了也留不住。
    storage: { ok: true, via: null, why: '' },
    clipboardWrite: {
      ok: !!(navigator.clipboard && navigator.clipboard.writeText) || !!document.execCommand,
      via: (navigator.clipboard && navigator.clipboard.writeText) ? 'clipboard' : 'exec',
      why: env.secure ? '' : '非安全上下文（http），只能走 execCommand',
    },
    clipboardRead: {
      ok: !!(navigator.clipboard && navigator.clipboard.readText),
      via: 'clipboard',
      why: '读取剪贴板需要用户手势与授权',
    },
    notify: {
      ok: !!(window.Notification || (window.__runx && window.__runx.toast)),
      via: window.Notification ? 'system' : (window.__runx ? 'desktop' : 'inline'),
      why: '',
    },
    fullscreen: {
      ok: !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen),
      via: document.documentElement.requestFullscreen ? 'standard' : 'webkit',
      why: env.ios ? 'iOS 上只有 video 能全屏' : '',
    },
    share: {
      ok: !!navigator.share,
      via: navigator.share ? 'native' : 'copy',
      why: navigator.share ? '' : '没有原生分享，降级为复制链接',
    },
    vibrate: {
      ok: !!navigator.vibrate,
      via: 'vibrate',
      why: '',
    },
    filePicker: {
      ok: !!window.showOpenFilePicker || !!document.createElement('input').files,
      via: window.showOpenFilePicker ? 'fsp' : 'input',
      why: '',
    },
    fileSave: {
      ok: !!window.showSaveFilePicker || !!document.createElement('a').download,
      via: window.showSaveFilePicker ? 'fsp' : 'download',
      why: '',
    },
  };

  /* 存储后端是异步选的，初始化完把结果写回能力表并广播 */
  readyBackend.then(function (be) {
    caps.storage = {
      ok: true,
      via: be.kind,
      why: be.durable ? '' : '当前浏览器不允许持久化（无痕模式？），刷新后数据会丢',
    };
    bus.emit('ready', { storage: be.kind });
    if (!be.durable) bus.emit('degrade', { what: 'storage', why: 'volatile', detail: '只能用内存存储' });
  });

  /** 快照式能力表：给「我要一次性打印所有能力」的场景用 */
  function capsSnapshot() {
    var out = {};
    for (var k in caps) {
      if (!Object.prototype.hasOwnProperty.call(caps, k)) continue;
      out[k] = caps[k];
    }
    if (!out.storage.via) out.storage.via = 'pending';
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════
   * 9. 对外
   * ═══════════════════════════════════════════════════════════════ */

  RunX.browser = {
    version: VERSION,
    env: env,
    caps: caps,
    capsSnapshot: capsSnapshot,
    on: function (ev, fn) { return bus.on(ev, fn); },
    off: function (ev, fn) { bus.off(ev, fn); },

    storage: createStore('runx'),
    store: function (ns) { return createStore(ns); },
    estimate: estimate,
    evict: evict,

    clipboard: clipboard,
    notify: notify,
    fullscreen: fullscreen,
    share: share,
    vibrate: vibrate,
    file: file,
    net: net,
  };
})();
