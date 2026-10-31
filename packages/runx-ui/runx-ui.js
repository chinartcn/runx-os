/**
 * RunX UI —— 运行时（对话框、Toast、主题、少量必须用 JS 才成立的交互）
 *
 * ── 边界 ────────────────────────────────────────────────────────────────
 * 能用 CSS 表达的一律留在 CSS 里（开关、复选、焦点环、进度条、骨架屏）。
 * 这里只做三件 CSS 做不到的事：
 *   1. 覆盖层（对话框 / Toast / 菜单）需要挂到 DOM 上并管理生命周期；
 *   2. 主题需要在刷新后记住（localStorage）；
 *   3. 分段控件 / 标签页 / 菜单的「点谁谁亮，并把状态告诉别人」。
 *
 * ── 别把状态藏在 JS 里 ───────────────────────────────────────────────────
 * 选中状态永远是 DOM 上的 class（`.on`）。JS 只负责改 class 并发事件，页面
 * 刷新后从自己的数据重新渲染即可 —— 不做「运行时的唯一真相源」，那样页面
 * 一旦被服务端渲染或热重载就会脱节。
 *
 * @version 1.0.0
 */
(function (global) {
  'use strict';

  var RX = { version: '1.0.0' };
  var STORE_KEY = 'rx-ui-theme';
  var root = null;

  /* ═══════════════════════════════════════════════════════════════
   * 0. 小工具
   * ═══════════════════════════════════════════════════════════════ */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** 覆盖层容器：body 不是 .rx 时也要有令牌，所以自带一个 .rx 壳 */
  function overlayRoot() {
    if (root && root.isConnected) return root;
    root = document.getElementById('rx-ui-root');
    if (!root) {
      // 注意：覆盖层壳也带 .rx（它要能拿到令牌），但它**不能有底色** ——
      // .rx 的 background 是画布色，一个 fixed + inset:0 的不透明壳会把
      // 整个页面盖住。所以再加一个 .rx-overlay-root，把底色摘掉。
      root = el('div', 'rx rx-overlay-root');
      root.id = 'rx-ui-root';
      // fixed + 无 transform：子元素里的 position:fixed 仍然相对视口
      root.style.cssText = 'position:fixed;inset:0;z-index:2000;pointer-events:none';
      root.setAttribute('data-theme', theme());
      document.body.appendChild(root);
    }
    return root;
  }

  function inOverlay(node) {
    var r = overlayRoot();
    // 覆盖层自己不应该挡鼠标：只让真正的弹层接收事件
    node.style.pointerEvents = 'auto';
    r.appendChild(node);
    return node;
  }

  /** 等一帧再加 .in，否则 transition 会因为「同一帧内改了两次样式」被跳过 */
  function enter(node) {
    requestAnimationFrame(function () { node.classList.add('in'); });
  }

  /* ═══════════════════════════════════════════════════════════════
   * 1. 主题
   * ═══════════════════════════════════════════════════════════════ */

  function theme(mode) {
    if (mode === undefined) {
      var saved = null;
      try { saved = localStorage.getItem(STORE_KEY); } catch (e) { /* 隐私模式 */ }
      if (saved === 'light' || saved === 'dark' || saved === 'auto') return saved;
      var first = document.querySelector('.rx');
      return (first && first.getAttribute('data-theme')) || 'auto';
    }
    var m = (mode === 'light' || mode === 'dark' || mode === 'auto') ? mode : 'auto';
    try { localStorage.setItem(STORE_KEY, m); } catch (e) { /* 存不了就只影响本次 */ }
    var nodes = document.querySelectorAll('.rx');
    for (var i = 0; i < nodes.length; i++) nodes[i].setAttribute('data-theme', m);
    paintCanvas();
    return m;
  }

  /* 把画布色同步到 <html>：html 是 body 的祖先，拿不到 body 上定义的
     --rx-canvas（自定义属性只往下传，不往上）。不补这一层的话，页面滚到
     body 之外时露出的仍是浏览器默认的白（暗色主题下会闪一下白边）。 */
  function paintCanvas() {
    var el = document.querySelector('.rx');
    if (!el || !global.document || !global.document.documentElement) return;
    var v = global.getComputedStyle(el).getPropertyValue('--rx-canvas');
    if (v) global.document.documentElement.style.background = String(v).trim();
  }

  /** 系统主题变化时通知（页面可以跟着重绘依赖主题的 canvas / 图表） */
  /* 首次加载：把 <html> 的画布色对上（body 上的主题属性此刻已生效） */
  try { paintCanvas(); } catch (e) { /* 样式还没加载就算了 */ }

  function onThemeChange(fn) {
    if (!global.matchMedia) return function () {};
    var mq = global.matchMedia('(prefers-color-scheme: dark)');
    var handler = function () { fn(theme(), mq.matches); };
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else if (mq.addListener) mq.addListener(handler);
    return function () {
      if (mq.removeEventListener) mq.removeEventListener('change', handler);
      else if (mq.removeListener) mq.removeListener(handler);
    };
  }

  /* ═══════════════════════════════════════════════════════════════
   * 2. Toast
   * ═══════════════════════════════════════════════════════════════ */

  var toastBox = null;

  function toast(text, opts) {
    var o = opts || {};
    if (!toastBox || !toastBox.isConnected) {
      toastBox = el('div', 'rx-toasts');
      inOverlay(toastBox);
    }
    var t = el('div', 'rx-toast' + (o.kind ? ' ' + o.kind : ''), String(text));
    toastBox.appendChild(t);
    enter(t);
    var ms = o.timeout === undefined ? 2600 : o.timeout;
    var timer = setTimeout(function () {
      t.classList.remove('in');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
    }, Math.max(600, ms));
    // 点一下立刻关掉：用户已经看到了
    t.addEventListener('click', function () { clearTimeout(timer); t.clicked = true; t.classList.remove('in'); });
    return function () { clearTimeout(timer); t.classList.remove('in'); };
  }

  /* ═══════════════════════════════════════════════════════════════
   * 3. 对话框
   * ═══════════════════════════════════════════════════════════════ */

  var openDialogs = 0;

  /**
   * @param {{title?:string, message?:string, body?:Node, actions?:Array, width?:'normal'|'wide',
   *          dismissable?:boolean}} opts
   * @returns {Promise<string|null>} 点击的动作 id；取消/关闭为 null
   */
  function dialog(opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var scrim = el('div', 'rx-scrim');
      var box = el('div', 'rx-dialog' + (o.width === 'wide' ? ' wide' : ''));
      scrim.appendChild(box);

      var head = el('div', 'rx-dialog-head');
      head.appendChild(el('div', 'rx-dialog-title', o.title || ''));
      if (o.dismissable !== false) {
        var x = el('button', 'rx-icon-btn', '✕');
        x.type = 'button';
        x.setAttribute('aria-label', '关闭');
        x.addEventListener('click', function () { done(null); });
        head.appendChild(x);
      }
      box.appendChild(head);

      var body = el('div', 'rx-dialog-body');
      if (o.message) body.appendChild(el('p', 'rx-body', o.message));
      if (o.body) body.appendChild(o.body);
      box.appendChild(body);

      var actions = o.actions || [{ id: 'ok', label: '好', kind: 'primary' }];
      var foot = el('div', 'rx-dialog-foot');
      var btnMap = {};
      actions.forEach(function (a) {
        var b = el('button', 'rx-btn' + (a.kind ? ' ' + a.kind : ''), a.label || a.id);
        b.type = 'button';
        b.addEventListener('click', function () { done(a.id, a.keep); });
        btnMap[a.id] = b;
        foot.appendChild(b);
      });
      box.appendChild(foot);

      var settled = false;
      function done(id, keepOpen) {
        if (settled && !keepOpen) return;
        if (keepOpen) { resolve(id); return; }
        settled = true;
        scrim.classList.remove('in');
        openDialogs--;
        document.removeEventListener('keydown', onKey, true);
        setTimeout(function () { if (scrim.parentNode) scrim.parentNode.removeChild(scrim); }, 200);
        resolve(id);
      }

      function onKey(e) {
        if (e.key === 'Escape' && o.dismissable !== false) { e.stopPropagation(); done(null); }
        else if (e.key === 'Enter' && !e.shiftKey) {
          var t = e.target;
          if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON')) return;
          e.preventDefault();
          done(actions[0] && actions[0].id);
        }
      }

      // 点遮罩关闭：只在允许关闭时生效（需要明确回答的对话框不给这条路）
      if (o.dismissable !== false) {
        scrim.addEventListener('click', function (e) { if (e.target === scrim) done(null); });
      }
      document.addEventListener('keydown', onKey, true);

      openDialogs++;
      inOverlay(scrim);
      enter(scrim);
      // 首个按钮/首个输入框拿焦点，键盘用户不必先 Tab 一圈
      setTimeout(function () {
        var focusable = body.querySelector('input,textarea,select') || btnMap[(actions[0] || {}).id];
        if (focusable && focusable.focus) focusable.focus();
      }, 40);
    });
  }

  function confirm(title, message, opts) {
    var o = opts || {};
    return dialog({
      title: title,
      message: message,
      actions: [
        { id: o.okId || 'ok', label: o.okLabel || '确定', kind: o.danger ? 'destructive' : 'primary' },
        { id: 'cancel', label: o.cancelLabel || '取消' },
      ],
    }).then(function (id) { return id === (o.okId || 'ok'); });
  }

  function prompt(title, opts) {
    var o = opts || {};
    var wrap = el('div', 'rx-field');
    if (o.label) wrap.appendChild(el('label', null, o.label));
    var input = el('input', 'rx-input');
    input.value = o.value || '';
    input.placeholder = o.placeholder || '';
    if (o.password) input.type = 'password';
    wrap.appendChild(input);
    return dialog({
      title: title,
      body: wrap,
      actions: [
        { id: 'ok', label: o.okLabel || '确定', kind: 'primary' },
        { id: 'cancel', label: '取消' },
      ],
    }).then(function (id) { return id === 'ok' ? input.value : null; });
  }

  /* ═══════════════════════════════════════════════════════════════
   * 4. 菜单
   * ═══════════════════════════════════════════════════════════════ */

  var openMenu = null;

  function menu(anchor, items, opts) {
    var o = opts || {};
    closeMenu();
    var m = el('div', 'rx-menu open');
    items.forEach(function (it) {
      if (it.sep) { m.appendChild(el('div', 'rx-menu-sep')); return; }
      var row = el('div', 'rx-menu-item' + (it.danger ? ' danger' : ''));
      row.appendChild(el('span', null, it.label));
      if (it.key) row.appendChild(el('span', 'rx-menu-key', it.key));
      row.addEventListener('click', function () {
        closeMenu();
        if (typeof it.onSelect === 'function') it.onSelect();
      });
      m.appendChild(row);
    });
    inOverlay(m);
    m.style.pointerEvents = 'auto';

    // 定位：优先贴着锚点下方左对齐，越界则上翻/右对齐
    var r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 20, bottom: 40, top: 40, right: 20 };
    var mw = m.offsetWidth, mh = m.offsetHeight;
    var left = Math.min(r.left, global.innerWidth - mw - 8);
    var top = r.bottom + 6;
    if (top + mh > global.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    // 锚点本身在视口外（长页面里的按钮）时，别把菜单放到看不见的地方
    top = Math.max(8, Math.min(top, global.innerHeight - mh - 8));
    m.style.left = Math.max(8, left) + 'px';
    m.style.top = top + 'px';
    m.style.position = 'fixed';

    openMenu = m;
    setTimeout(function () {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onDocKey, true);
    }, 0);

    function onDocClick(e) { if (!m.contains(e.target)) closeMenu(); }
    function onDocKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }

    function cleanup() {
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onDocKey, true);
      if (m.parentNode) m.parentNode.removeChild(m);
      if (openMenu === m) openMenu = null;
    }
    m._cleanup = cleanup;
    if (o.autoCloseOnScroll !== false) global.addEventListener('scroll', closeMenu, { once: true, passive: true });
    return { el: m, close: cleanup };
  }

  function closeMenu() {
    if (openMenu && openMenu._cleanup) openMenu._cleanup();
    openMenu = null;
  }

  /* ═══════════════════════════════════════════════════════════════
   * 5. 必须用 JS 的交互（事件委托，动态 DOM 也生效）
   * ═══════════════════════════════════════════════════════════════ */

  function emit(node, name, detail) {
    var ev;
    try { ev = new CustomEvent(name, { detail: detail, bubbles: true }); }
    catch (e) {
      ev = document.createEvent('CustomEvent');
      ev.initCustomEvent(name, true, false, detail);
    }
    node.dispatchEvent(ev);
  }

  /** 让同一组里的兄弟失去 .on，自己拿到 */
  function activate(node, siblingSel) {
    var group = node.parentNode;
    if (!group) return;
    var sibs = group.querySelectorAll(siblingSel);
    for (var i = 0; i < sibs.length; i++) sibs[i].classList.toggle('on', sibs[i] === node);
    if (group.hasAttribute('data-rx-value')) group.setAttribute('data-rx-value', node.getAttribute('data-value') || node.textContent.trim());
  }

  function start() {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;

      // 分段控件
      var seg = t.closest('.rx-seg > button');
      if (seg) {
        activate(seg, 'button');
        emit(seg.parentNode, 'rx:change', { value: seg.getAttribute('data-value') || seg.textContent.trim(), index: Array.prototype.indexOf.call(seg.parentNode.children, seg) });
        return;
      }

      // 标签页：切换 .on，并把对应 panel 显示出来（data-target="#id"）
      var tab = t.closest('.rx-tab');
      if (tab && tab.parentNode && tab.parentNode.classList.contains('rx-tabs')) {
        activate(tab, '.rx-tab');
        var target = tab.getAttribute('data-target');
        if (target) {
          var tabs = tab.parentNode.querySelectorAll('.rx-tab');
          for (var i = 0; i < tabs.length; i++) {
            var tg = tabs[i].getAttribute('data-target');
            var panel = tg && document.querySelector(tg);
            if (panel) panel.hidden = tabs[i] !== tab;
          }
        }
        emit(tab.parentNode, 'rx:tab', { target: target, index: Array.prototype.indexOf.call(tab.parentNode.children, tab) });
        return;
      }

      // 按钮组（.rx-btn-group 里的按钮同样是单选语义）
      var bg = t.closest('.rx-btn-group > .rx-btn');
      if (bg) {
        activate(bg, '.rx-btn');
        emit(bg.parentNode, 'rx:change', { value: bg.getAttribute('data-value') || bg.textContent.trim() });
        return;
      }

      // 步进器
      var step = t.closest('.rx-stepper > button');
      if (step) {
        var box = step.parentNode;
        var input = box.querySelector('input');
        if (!input) return;
        var d = Number(box.getAttribute('data-step') || 1);
        var min = input.min === '' ? -Infinity : Number(input.min);
        var max = input.max === '' ? Infinity : Number(input.max);
        var v = (Number(input.value) || 0) + (step.getAttribute('data-dir') === '-' ? -d : d);
        input.value = String(Math.max(min, Math.min(max, v)));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }

      // data-rx-menu='{"items":[...]}' 或者 data-rx-menu="#template"
      var trigger = t.closest('[data-rx-menu]');
      if (trigger) {
        var spec = trigger.getAttribute('data-rx-menu');
        var items = null;
        try { items = JSON.parse(spec); } catch (e) { items = null; }
        if (!items) {
          var tpl = document.querySelector(spec);
          if (tpl && tpl.content) {
            items = [];
            var kids = tpl.content.querySelectorAll('[data-label]');
            for (var k = 0; k < kids.length; k++) {
              (function (node) {
                if (node.hasAttribute('data-sep')) { items.push({ sep: true }); return; }
                items.push({ label: node.getAttribute('data-label'), key: node.getAttribute('data-key') || '' });
              })(kids[k]);
            }
          }
        }
        if (items) { e.preventDefault(); menu(trigger, items); }
        return;
      }

      // data-rx-close：关掉最近的遮罩（自定义对话框里用）
      var closer = t.closest('[data-rx-close]');
      if (closer) {
        var scrim = closer.closest('.rx-scrim');
        if (scrim) {
          scrim.classList.remove('in');
          setTimeout(function () { if (scrim.parentNode) scrim.parentNode.removeChild(scrim); }, 200);
        }
      }
    });

    // .rx-seg 上按左右键切换，键盘用户不必 Tab 每个按钮
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var t = e.target;
      if (!t || !t.closest || !t.closest('.rx-seg')) return;
      var seg = t.closest('.rx-seg');
      var btns = Array.prototype.slice.call(seg.querySelectorAll('button'));
      var i = btns.indexOf(t);
      if (i < 0) return;
      var next = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
      e.preventDefault();
      next.focus();
      next.click();
    });
  }

  /* ═══════════════════════════════════════════════════════════════
   * 6. 格式化助手（应用天天要写，顺手给）
   * ═══════════════════════════════════════════════════════════════ */

  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function duration(ms) {
    var s = Math.round(Number(ms) / 1000);
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
  }

  function time(ms) {
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* ═══════════════════════════════════════════════════════════════
   * 7. 导出
   * ═══════════════════════════════════════════════════════════════ */

  RX.theme = theme;
  RX.onThemeChange = onThemeChange;
  RX.toast = toast;
  RX.dialog = dialog;
  RX.confirm = confirm;
  RX.prompt = prompt;
  RX.menu = menu;
  RX.closeMenu = closeMenu;
  RX.bytes = bytes;
  RX.duration = duration;
  RX.time = time;
  /** 元素上的设计令牌取值：`RX.token('--rx-accent')` */
  RX.token = function (name, node) {
    return getComputedStyle(node || document.querySelector('.rx') || document.body).getPropertyValue(name).trim();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  global.RX = RX;
})(window);
