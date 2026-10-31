/**
 * @runx-administrator-mode 前端 —— 红条 + 开启确认
 *
 * ── 为什么是「一直挂着的红条」而不是一次性提示 ──────────────────
 * 提权最难的不是开启，是**忘记它开着**。所以生效期间桌面顶上永远有一条红色
 * 胶囊（剩余时间倒计时），外加一圈红色内发光压在视口边缘 —— 关掉之后再点
 * 「开启」才有反馈，不给「以为自己已经关了」留空间。
 *
 * ── 不打断布局 ─────────────────────────────────────────────────
 * 桌面的坐标系统是固定的（图标位置、窗口几何都按视口算），插一条占位的横条会
 * 让所有存量布局错位。所以用悬浮层：不占空间、pointer-events:none（红条本身
 * 除外），只在视觉上压住顶部中央那一条。
 *
 * 挂载：`window.RunX.admin`
 * @version 0.1.0
 */
(function () {
  'use strict';

  var RunX = (window.RunX = window.RunX || {});
  if (RunX.admin) return;

  var API = '/runx/admin';
  var state = { on: false, until: 0, reason: '', by: null };
  var timer = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function req(path, opts) {
    var o = Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, opts || {});
    return fetch(API + path, o).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { /* 非 JSON */ }
        if (!r.ok) {
          var e = new Error((j && j.error && j.error.message) || ('HTTP ' + r.status));
          e.code = r.status;
          throw e;
        }
        return j;
      });
    });
  }

  /** 挂在桌面根节点里（#runx-desktop 是层叠上下文，挂 body 会被它盖住） */
  function mount(node) {
    var desk = document.getElementById('runx-desktop');
    if (!desk) node.classList.add('rxam-solo');
    (desk || document.body).appendChild(node);
    return node;
  }

  function clock(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  /* ═══════════════════════════════════════════════════════════════
   * 红条
   * ═══════════════════════════════════════════════════════════════ */

  var band = null;
  var glow = null;

  function render() {
    if (!state.on) {
      if (band && band.parentNode) band.parentNode.removeChild(band);
      if (glow && glow.parentNode) glow.parentNode.removeChild(glow);
      band = glow = null;
      if (timer) { clearInterval(timer); timer = null; }
      return;
    }

    if (!glow) {
      glow = mount(el('div', 'rxam-glow'));
    }
    if (!band) {
      band = mount(el('div', 'rxam-band'));
      var ico = el('span', 'rxam-ico', '⚠');
      band.appendChild(ico);
      band.appendChild(el('span', 'rxam-t', '管理员模式'));
      var left = el('span', 'rxam-left');
      left.id = 'rxam-left';
      band.appendChild(left);
      var off = el('button', 'rxam-off', '关闭');
      off.type = 'button';
      off.addEventListener('click', function () { disable(); });
      band.appendChild(off);
      bindDrag(band);
      applyBandPos();
    }
    var leftEl = document.getElementById('rxam-left');
    if (leftEl) leftEl.textContent = '剩余 ' + clock(state.until - Date.now());
    if (band) band.title = state.reason ? ('原因：' + state.reason + (state.by ? '（' + state.by + '）' : '')) : '';

    if (!timer) {
      timer = setInterval(function () {
        var remain = state.until - Date.now();
        var l = document.getElementById('rxam-left');
        if (l) l.textContent = '剩余 ' + clock(remain);
        if (remain <= 0) { apply({ on: false }); }
      }, 1000);
    }
  }

  /* ═══════════════════════════════════════════════════════════════
   * 拖走红条
   *
   * 起因很实在：红条原本固定在顶部正中，**压着顶栏**（40px 高的导航条）。
   * 顶栏左边是开始菜单入口，右边是状态区 —— 红条一开，这两处都点不着。
   * 管理员模式恰恰是你在**干别的事**的时候开的（要装个包、要改个配置），
   * 于是「开着管理员模式就用不了桌面」，本末倒置。
   *
   * 所以红条改成可拖的：按住拖到别处去，不挡事。位置记在 localStorage，
   * 刷新后还在原地 —— 每次都要重新拖一遍是欠考虑。
   *
   * 拖动时用 transform，不改 left/top：transform 走合成层，拖起来不掉帧，
   * 也不会触发布局重算（红条是 fixed，改 left/top 会带着整个视口重排）。
   * ═══════════════════════════════════════════════════════════════ */

  var POS_KEY = 'runx.admin.band.pos';
  var dragging = false;
  var dragFrom = null;    // 按下时的指针坐标
  var dragBase = null;    // 按下时红条中心的位置
  var dragEnd = null;     // 当前算出来的红条中心位置（落盘用）
  var dragMoved = false;  // 是否真的移动过（区分「点击」与「拖动」）

  /** 读回上次拖到哪儿了。没有就用默认（顶部正中）。 */
  function readPos() {
    try {
      var raw = localStorage.getItem(POS_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
      return p;
    } catch { return null; }
  }

  function writePos(p) {
    try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* 隐私模式等 */ }
  }

  function clearPos() {
    try { localStorage.removeItem(POS_KEY); } catch { /* 忽略 */ }
  }

  /** 把记住的位置套到红条上 */
  function applyBandPos() {
    if (!band) return;
    var p = readPos();
    if (!p) {
      band.classList.remove('rxam-moved');
      band.style.left = '50%';
      band.style.top = '6px';
      band.style.setProperty('--rxam-x', '-50%');
      band.style.setProperty('--rxam-y', '0px');
      return;
    }
    // 记的是「红条中心点」，定位交给 CSS 的 translate(-50%,-50%) ——
    // 用百分比平移居中，就不用知道红条多宽。
    //
    // 为什么不能拿 offsetWidth 换算：字体还没加载完时量出来的宽度是错的
    // （Inter 到位后宽度会变），刷新后位置就会偏几十像素。现在这套
    // 「中心点 + 百分比平移」与宽度无关，字体什么时候到都不影响。
    band.classList.add('rxam-moved');
    band.style.left = '0px';
    band.style.top = '0px';
    band.style.setProperty('--rxam-x', p.x + 'px');
    band.style.setProperty('--rxam-y', p.y + 'px');
  }

  function bindDrag(node) {
    node.addEventListener('pointerdown', function (e) {
      // 只认左键；按钮上的 pointerdown 不参与拖动，否则「关闭」会连着拖一下
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target && e.target.tagName === 'BUTTON') return;
      var p = readPos();
      if (p) {
        dragBase = { x: p.x, y: p.y };
      } else {
        // 没拖过（还在默认位置）：默认是「顶栏正中」，用 getBoundingClientRect
        // 量真实位置 —— offsetWidth 在字体没加载完时是不准的，
        // 量出来的中心点会让红条第一次就被拽偏。
        var r = node.getBoundingClientRect();
        dragBase = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      dragFrom = { x: e.clientX, y: e.clientY };
      dragging = true;
      dragMoved = false;
      dragEnd = { x: dragBase.x, y: dragBase.y };
      node.classList.add('rxam-dragging');
      try { node.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
      e.preventDefault();
    });

    node.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - dragFrom.x;
      var dy = e.clientY - dragFrom.y;
      if (!dragMoved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;  // 抖动不算拖
      dragMoved = true;
      var rect = node.getBoundingClientRect();
      var w = rect.width || 200;
      var h = rect.height || 24;
      // 基准是「按下那一刻的位置」，全程不变；红条位置 = 基准 + 指针总位移。
      //
      // 为什么不能每帧更新基准（那看着像更常见的写法）：pointermove 的坐标是
      // **相对按下点**的总位移，不是增量。如果基准也跟着走，每一帧都会把
      // 「已经移动过的距离」再加一遍 —— 拖 300px 会跑出 3000px，
      // 表现为红条甩到边角停住。基准不动就没有这个问题。
      var nx = dragBase.x + dx;
      var ny = dragBase.y + dy;
      // 夹在视口内：不能拖到屏幕外找不回来，也不能被拖到只剩一条边
      nx = Math.max(w / 2 + 4, Math.min(window.innerWidth - w / 2 - 4, nx));
      ny = Math.max(h / 2 + 4, Math.min(window.innerHeight - h / 2 - 4, ny));
      node.classList.add('rxam-moved');
      node.style.left = '0px';
      node.style.top = '0px';
      // 定位交给 CSS 的 translate(-50%,-50%)：中心点直接给，不需要减去宽高
      node.style.setProperty('--rxam-x', nx + 'px');
      node.style.setProperty('--rxam-y', ny + 'px');
      // 记住最终位置（供 pointerup 落盘）；拖动基准 dragBase 保持不动
      dragEnd = { x: nx, y: ny };
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      node.classList.remove('rxam-dragging');
      try { node.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
      if (!dragMoved) return;
      writePos(dragEnd || dragBase);
    }
    node.addEventListener('pointerup', endDrag);
    node.addEventListener('pointercancel', endDrag);

    /* 双击：拖回默认位置（顶部正中）。
       拖走了之后想「恢复原样」不该去翻设置 —— 双击是桌面里的通用手势。 */
    node.addEventListener('dblclick', function () {
      clearPos();
      applyBandPos();
      toast('红条已归位');
    });

    // 视口尺寸变了（转屏、缩放）：记住的位置按比例挪，别让它跑到屏幕外
    window.addEventListener('resize', function () {
      if (dragging) return;
      applyBandPos();
    });
  }

  function apply(s) {
    state.on = !!s.on;
    state.until = s.until || 0;
    state.reason = s.reason || '';
    state.by = s.by_name || null;
    render();
  }

  /* ═══════════════════════════════════════════════════════════════
   * 开启确认
   * ═══════════════════════════════════════════════════════════════ */

  function enable() {
    return req('/challenge').then(openSheet, function (e) {
      if (e.code === 401) toast('请先登录');
      else if (e.code === 403) toast('只有管理员能开启');
      else toast(e.message);
    });
  }

  function toast(text) {
    var box = document.getElementById('rxam-toast');
    if (!box) {
      box = el('div', 'rxam-toast');
      box.id = 'rxam-toast';
      mount(box);
    }
    box.textContent = text;
    box.classList.add('in');
    clearTimeout(box._t);
    box._t = setTimeout(function () { box.classList.remove('in'); }, 2600);
  }

  function openSheet(ch) {
    var v = el('div', 'rxam-veil');
    mount(v);
    var box = el('div', 'rxam-box');
    v.appendChild(box);
    requestAnimationFrame(function () { v.classList.add('in'); });

    var head = el('div', 'rxam-head');
    head.appendChild(el('div', 'rxam-head-ico', '⚠'));
    var htxt = el('div', null);
    htxt.appendChild(el('div', 'rxam-title', '开启管理员模式'));
    htxt.appendChild(el('div', 'rxam-sub', '它会直接改写 var/runx/admin.json，并自动到期'));
    head.appendChild(htxt);
    box.appendChild(head);

    var body = el('div', 'rxam-body');
    body.appendChild(el('p', 'rxam-p', '开启后，应用在审批里通过的高风险操作不再逐个询问，直到票据到期或手动关闭。'));
    var ul = el('ul', 'rxam-list');
    [
      '能写 /etc、/usr 这些系统目录',
      '能读 ~/.ssh、各类密钥与 .env',
      '能起子进程 —— 等于把整台机器交出去',
    ].forEach(function (t) { ul.appendChild(el('li', null, t)); });
    body.appendChild(ul);

    var reason = el('input', 'rxam-input');
    reason.placeholder = '为什么需要它？（会记进审计日志）';
    body.appendChild(reason);

    var minutes = el('select', 'rxam-input');
    [10, 30, 60, 120].forEach(function (m) {
      var o = el('option', null, m + ' 分钟');
      o.value = String(m);
      if (m === 30) o.selected = true;
      minutes.appendChild(o);
    });
    body.appendChild(minutes);

    var confRow = el('label', 'rxam-check');
    var cb = el('input');
    cb.type = 'checkbox';
    confRow.appendChild(cb);
    confRow.appendChild(el('span', null, '我知道风险，并会在用完后立刻关闭'));
    body.appendChild(confRow);

    var phraseRow = el('div', 'rxam-phrase');
    phraseRow.appendChild(el('span', null, '请输入 '));
    var strong = el('b', null, ch.phrase);
    phraseRow.appendChild(strong);
    phraseRow.appendChild(el('span', null, ' 确认：'));
    body.appendChild(phraseRow);

    var input = el('input', 'rxam-input');
    input.placeholder = ch.phrase;
    input.autocapitalize = 'none';
    body.appendChild(input);

    var msg = el('p', 'rxam-err');
    msg.style.display = 'none';
    body.appendChild(msg);
    box.appendChild(body);

    var foot = el('div', 'rxam-foot');
    var cancel = el('button', 'rxam-btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', close);
    var go = el('button', 'rxam-btn danger', '开启');
    go.type = 'button';
    go.addEventListener('click', function () {
      msg.style.display = 'none';
      if (!cb.checked) { msg.textContent = '请先勾选「我知道风险」'; msg.style.display = ''; return; }
      if (reason.value.trim().length < 2) { msg.textContent = '写一句理由（至少 2 个字）'; msg.style.display = ''; return; }
      go.disabled = true;
      go.textContent = '开启中…';
      req('/enable', {
        method: 'POST',
        body: JSON.stringify({
          token: ch.token, phrase: input.value.trim(), confirm: cb.checked,
          reason: reason.value.trim(), minutes: Number(minutes.value),
        }),
      }).then(function (r) {
        close();
        apply({ on: true, until: r.until, reason: reason.value.trim() });
        toast('管理员模式已开启，' + r.minutes + ' 分钟后自动关闭');
      }, function (e) {
        go.disabled = false;
        go.textContent = '开启';
        msg.textContent = e.message;
        msg.style.display = '';
      });
    });
    foot.appendChild(cancel);
    foot.appendChild(go);
    box.appendChild(foot);

    function close() {
      v.classList.remove('in');
      setTimeout(function () { if (v.parentNode) v.parentNode.removeChild(v); }, 180);
    }
    v.addEventListener('click', function (e) { if (e.target === v) close(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });
    setTimeout(function () { reason.focus(); }, 60);
  }

  function disable() {
    return req('/disable', { method: 'POST', body: JSON.stringify({ reason: '桌面手动关闭' }) })
      .then(function () { apply({ on: false }); toast('管理员模式已关闭'); },
        function (e) { toast(e.message); });
  }

  /* ═══════════════════════════════════════════════════════════════
   * 启动
   * ═══════════════════════════════════════════════════════════════ */

  function refresh() {
    return req('/state').then(function (s) { apply(s); return s; }, function () { return null; });
  }

  function boot() {
    refresh();
    // 一分钟对一次时：多标签页/多设备时，别的地方关了这里也能收敛
    setInterval(refresh, 60000);
    var tries = 0;
    (function subscribe() {
      if (RunX.bus && RunX.bus.subscribe) {
        RunX.bus.subscribe('sys.admin.on', function (m) { apply({ on: true, until: m.payload.until, reason: m.payload.reason, by_name: m.payload.by }); });
        RunX.bus.subscribe('sys.admin.off', function () { apply({ on: false }); });
        return;
      }
      if (tries++ < 40) setTimeout(subscribe, 250);
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  RunX.admin = {
    version: '0.1.0',
    state: refresh,
    enable: enable,
    disable: disable,
  };
})();
