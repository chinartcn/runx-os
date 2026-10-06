/* @runx-monitor 客户端 —— 状态监视器面板
 *
 * 设计要点：
 *   · 自包含 IIFE，不依赖桌面外壳的内部实现，只通过 window.RunX 约定做弱集成。
 *   · 通过桌面外壳的 openApp 机制挂载？不 —— 内核扩展没有 apps 记录，
 *     开始菜单列的是 apps/*。所以本面板自己注册成「可打开的面板」，
 *     由 @runx-settings 与桌面入口共同调用 RunX.monitor.open()。
 *   · 数据面：GET /runx/monitor 拉快照；WS /runx/monitor/stream 收实时事件。
 *     WS 连不上（或配置关闭）时自动降级为纯轮询，功能不缺失。
 */
(function () {
  'use strict';

  var API = '/runx/monitor';
  var STREAM = '/runx/monitor/stream';
  var ASSETS = '/runx/monitor-assets/';

  var RunX = (window.RunX = window.RunX || {});

  /* ── 小工具 ── */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function bytes(n) {
    if (!Number.isFinite(n)) return '—';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }
  function dur(ms) {
    if (!Number.isFinite(ms)) return '—';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 时 ' + (m % 60) + ' 分';
    return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 时';
  }
  function clockt(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    var p = function (x) { return String(x).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
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

  var STATE_LABEL = {
    running: '运行中', stopped: '已停止', restarting: '重启中',
    failed: '失败', unknown: '未知',
  };
  var STATE_CLASS = {
    running: 'ok', stopped: 'idle', restarting: 'warn', failed: 'bad', unknown: 'idle',
  };

  /* ── 面板 ── */
  var panel = null;        // 根节点
  var ui = {};             // 各区域引用
  var ws = null;
  var wsRetry = null;
  var pollTimer = null;
  var refreshMs = 3000;
  var events = [];         // 本地事件缓冲（与服务工作端环形缓冲互补）
  var lastSeq = 0;
  var streamOn = true;

  function build() {
    var root = el('div', 'rxmon');

    /* 头部：概览 + 操作 */
    var head = el('div', 'rxmon-head');
    var sum = el('div', 'rxmon-sum');
    ui.sum = sum;
    head.appendChild(sum);

    var acts = el('div', 'rxmon-acts');
    ui.conn = el('span', 'rxmon-conn', '连接中…');
    acts.appendChild(ui.conn);
    var bRefresh = el('button', 'rxmon-btn', '刷新');
    bRefresh.addEventListener('click', function () { pull(); });
    acts.appendChild(bRefresh);
    head.appendChild(acts);
    root.appendChild(head);

    /* 分栏：进程表 / 事件流 */
    var cols = el('div', 'rxmon-cols');

    var colA = el('div', 'rxmon-col');
    colA.appendChild(el('h3', 'rxmon-h', '应用与进程'));
    ui.apps = el('div', 'rxmon-apps');
    colA.appendChild(ui.apps);
    colA.appendChild(el('h3', 'rxmon-h', '运行时'));
    ui.proc = el('div', 'rxmon-proc');
    colA.appendChild(ui.proc);
    cols.appendChild(colA);

    var colB = el('div', 'rxmon-col');
    var hb = el('div', 'rxmon-hrow');
    hb.appendChild(el('h3', 'rxmon-h', '事件流'));
    var bClr = el('button', 'rxmon-btn rxmon-btn-sm', '清空');
    bClr.addEventListener('click', function () { events = []; drawEvents(); });
    hb.appendChild(bClr);
    colB.appendChild(hb);
    ui.events = el('div', 'rxmon-events');
    colB.appendChild(ui.events);
    cols.appendChild(colB);

    root.appendChild(cols);

    /* 日志查看抽屉 */
    ui.logBox = el('div', 'rxmon-logbox');
    var lh = el('div', 'rxmon-loghead');
    ui.logTitle = el('span', 'rxmon-logtitle', '日志');
    lh.appendChild(ui.logTitle);
    var bCloseLog = el('button', 'rxmon-btn rxmon-btn-sm', '关闭');
    bCloseLog.addEventListener('click', function () { ui.logBox.classList.remove('open'); });
    lh.appendChild(bCloseLog);
    ui.logBox.appendChild(lh);
    ui.logBody = el('pre', 'rxmon-logbody');
    ui.logBox.appendChild(ui.logBody);
    root.appendChild(ui.logBox);

    return root;
  }

  function drawSummary(snap) {
    var apps = snap.apps || [];
    var by = {};
    apps.forEach(function (a) { by[a.status] = (by[a.status] || 0) + 1; });
    ui.sum.textContent = '';
    var chips = [
      { k: '应用', v: apps.length, c: '' },
      { k: '运行中', v: by.running || 0, c: 'ok' },
      { k: '已停止', v: by.stopped || 0, c: 'idle' },
      { k: '失败', v: by.failed || 0, c: 'bad' },
      { k: '上行', v: dur(snap.process && snap.process.uptime_ms), c: '' },
      { k: '内存', v: bytes(snap.process && snap.process.memory && snap.process.memory.rss), c: '' },
    ];
    chips.forEach(function (ch) {
      var c = el('span', 'rxmon-chip ' + (ch.c ? 'is-' + ch.c : ''));
      c.appendChild(el('i', 'rxmon-chipk', ch.k));
      c.appendChild(el('b', 'rxmon-chipv', ch.v));
      ui.sum.appendChild(c);
    });
  }

  function drawApps(snap) {
    var apps = snap.apps || [];
    ui.apps.textContent = '';
    if (!apps.length) { ui.apps.appendChild(el('div', 'rxmon-empty', '没有登记的应用')); return; }

    var t = el('table', 'rxmon-table');
    var thead = el('thead');
    var tr = el('tr');
    ['应用', '状态', '端口', '重启', '日志'].forEach(function (h) { tr.appendChild(el('th', '', h)); });
    thead.appendChild(tr);
    t.appendChild(thead);

    var tb = el('tbody');
    apps.forEach(function (a) {
      var row = el('tr');
      var tdName = el('td', 'rxmon-name');
      tdName.appendChild(el('span', 'rxmon-appname', a.title || a.name));
      if (a.title && a.title !== a.name) tdName.appendChild(el('span', 'rxmon-appsub', a.name));
      row.appendChild(tdName);

      var st = a.status || 'unknown';
      var tdSt = el('td');
      tdSt.appendChild(el('span', 'rxmon-pill is-' + (STATE_CLASS[st] || 'idle'),
        STATE_LABEL[st] || st));
      row.appendChild(tdSt);

      row.appendChild(el('td', 'rxmon-num', a.port || '—'));
      row.appendChild(el('td', 'rxmon-num', a.restart || '—'));

      var tdAct = el('td');
      var b = el('button', 'rxmon-btn rxmon-btn-sm', '查看');
      b.addEventListener('click', function () { openLog(a.name); });
      tdAct.appendChild(b);
      row.appendChild(tdAct);

      tb.appendChild(row);
    });
    t.appendChild(tb);
    ui.apps.appendChild(t);
  }

  function drawProc(snap) {
    var p = snap.process || {};
    var m = p.memory || {};
    var gc = snap.gc || {};
    ui.proc.textContent = '';
    var rows = [
      ['Node', p.node || '—'],
      ['平台', (p.platform || '—') + ' / ' + (p.arch || '—')],
      ['主进程 PID', p.pid || '—'],
      ['堆用量', bytes(m.heap_used) + ' / ' + bytes(m.heap_total)],
      ['常驻内存', bytes(m.rss)],
      ['外部内存', bytes(m.external)],
    ];
    if (gc && typeof gc === 'object') {
      Object.keys(gc).slice(0, 6).forEach(function (k) {
        var v = gc[k];
        rows.push(['GC·' + k, typeof v === 'number' ? String(v) : JSON.stringify(v)]);
      });
    }
    var t = el('table', 'rxmon-kv');
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('th', '', r[0]));
      tr.appendChild(el('td', '', r[1]));
      t.appendChild(tr);
    });
    ui.proc.appendChild(t);
  }

  function drawEvents() {
    ui.events.textContent = '';
    if (!events.length) { ui.events.appendChild(el('div', 'rxmon-empty', '暂无事件')); return; }
    events.slice(-200).reverse().forEach(function (e) {
      var row = el('div', 'rxmon-ev');
      row.appendChild(el('span', 'rxmon-evts', clockt(e.ts)));
      // 事件的字段名统一为 type（与服务端环形缓冲的记录结构一致）：
      // sync 分支直接把服务端记录 push 进来，若这里另起 event 字段，
      // 同一个列表里就会混两种形状，渲染时必须两处都兜，很容易漏。
      row.appendChild(el('span', 'rxmon-evtype', e.type || e.event || ''));
      var pl = e.payload;
      row.appendChild(el('span', 'rxmon-evpl', pl ? (pl.name || JSON.stringify(pl)) : ''));
      ui.events.appendChild(row);
    });
  }

  function apply(snap) {
    if (!snap) return;
    if (snap.meta && Number.isFinite(snap.meta.refresh_ms)) refreshMs = snap.meta.refresh_ms;
    if (snap.meta && snap.meta.stream_enabled === false) streamOn = false;
    drawSummary(snap);
    drawApps(snap);
    drawProc(snap);
  }

  function pull() {
    return httpJson(API).then(apply).catch(function (e) {
      if (ui.conn) { ui.conn.textContent = '拉取失败：' + e.message; ui.conn.className = 'rxmon-conn bad'; }
    });
  }

  function openLog(name) {
    ui.logTitle.textContent = '日志 · ' + name;
    ui.logBody.textContent = '加载中…';
    ui.logBox.classList.add('open');
    httpJson(API + '/apps/' + encodeURIComponent(name) + '/logs')
      .then(function (r) {
        var lines = (r.lines || []).join('\n');
        ui.logBody.textContent = lines || '（空）';
        if (r.truncated) ui.logTitle.textContent = '日志 · ' + name + '（最近 ' + r.lines.length + ' / ' + r.total + ' 行）';
      })
      .catch(function (e) { ui.logBody.textContent = '读取失败：' + e.message; });
  }

  /* ── WS 实时流 ── */
  function setConn(cls, text) {
    if (!ui.conn) return;
    ui.conn.className = 'rxmon-conn ' + cls;
    ui.conn.textContent = text;
  }

  function connect() {
    if (!streamOn) { setConn('idle', '实时流已关闭'); return; }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { ws = new WebSocket(proto + '//' + location.host + STREAM); }
    catch (e) { setConn('bad', '无法建立实时连接'); return; }

    ws.onopen = function () {
      setConn('ok', '实时');
      ws.send(JSON.stringify({ type: 'sync', since: lastSeq }));
    };
    ws.onmessage = function (ev) {
      var msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || !msg.type) return;
      if (msg.type === 'welcome') {
        lastSeq = msg.seq || 0;
        apply(msg.snapshot);
      } else if (msg.type === 'sync') {
        lastSeq = msg.seq || lastSeq;
        (msg.events || []).forEach(function (r) { events.push(r); });
        apply(msg.snapshot);
        drawEvents();
      } else if (msg.type === 'event') {
        if (msg.seq) lastSeq = Math.max(lastSeq, msg.seq);
        events.push({ seq: msg.seq, ts: msg.ts, type: msg.event, payload: msg.payload });
        if (events.length > 600) events.splice(0, events.length - 600);
        drawEvents();
        // 状态类事件立刻重拉，让进程表跟手
        if (/^app:/.test(msg.event) || msg.event === 'apps:changed') pull();
      } else if (msg.type === 'pong') {
        /* 心跳应答，无需处理 */
      }
    };
    ws.onclose = function () {
      setConn('idle', '重连中…');
      ws = null;
      if (wsRetry) clearTimeout(wsRetry);
      wsRetry = setTimeout(connect, 2000);
    };
    ws.onerror = function () { /* onclose 会接管重连 */ };
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (refreshMs > 0) {
      pollTimer = setInterval(function () {
        // 实时流健康时轮询只做兜底，间隔放宽
        pull();
      }, Math.max(refreshMs, streamOn ? refreshMs : 1000));
    }
  }

  /* ── 挂载 / 卸载 ── */
  function mount(host) {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = build();
    host.appendChild(panel);
    pull().then(startPolling, startPolling);
    connect();
    return panel;
  }

  /**
   * 打开监视器。
   * 优先请桌面外壳开一个正真窗口（有工具栏/缩放/最小化）；desktop 不可用时
   * 退化为「挂到 body 上的全屏面板」，至少还能用。
   */
  function open(host) {
    if (host) return mount(host);
    var d = RunX.desktop;
    if (d && typeof d.openPanel === 'function') {
      return d.openPanel('monitor', '状态监视器', '@runx-monitor', mount);
    }
    // 回落：直接铺在页面上
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = build();
    panel.classList.add('rxmon-standalone');
    document.body.appendChild(panel);
    pull().then(startPolling, startPolling);
    connect();
    return panel;
  }

  function close() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (wsRetry) { clearTimeout(wsRetry); wsRetry = null; }
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
  }

  RunX.monitor = {
    open: open,
    close: close,
    refresh: pull,
    get panel() { return panel; },
    assets: ASSETS,
  };

  // 心跳：内核会自动回 pong，保持连接活跃（部分代理 60s 无流量会断）
  setInterval(function () {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {} }
  }, 30000);
})();
