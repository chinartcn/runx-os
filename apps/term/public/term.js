'use strict';
/* RunX 终端前端：单 WS 多 Terminal 实例 + 标签栏 + 复制粘贴 + 字号/主题 + 重连 */

(function () {
  var FitAddonClass = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
  var WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/term';

  var DARK = {
    background: '#0b0f1a', foreground: '#d7e0f5', cursor: '#6aa8ff', cursorAccent: '#0b0f1a',
    selectionBackground: 'rgba(106,168,255,0.30)',
    black: '#1a1f2e', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
    blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#c8ccd4',
    brightBlack: '#5c6370', brightRed: '#ff7b86', brightGreen: '#b3d98c',
    brightYellow: '#ffd68a', brightBlue: '#82c7ff', brightMagenta: '#e0a3f0',
    brightCyan: '#7fd6e0', brightWhite: '#ffffff',
  };
  var LIGHT = {
    background: '#fbfcfe', foreground: '#1c2436', cursor: '#3a6fd8', cursorAccent: '#fbfcfe',
    selectionBackground: 'rgba(80,130,255,0.25)',
    black: '#243044', red: '#c0392b', green: '#2e7d32', yellow: '#a17a00',
    blue: '#2962ff', magenta: '#8e24aa', cyan: '#00838f', white: '#546e7a',
    brightBlack: '#607d8b', brightRed: '#e74c3c', brightGreen: '#43a047',
    brightYellow: '#c9a227', brightBlue: '#448aff', brightMagenta: '#ab47bc',
    brightCyan: '#00acc1', brightWhite: '#263238',
  };

  var LS = {
    fontSize: 'runx.term.fontSize',
    theme: 'runx.term.theme',
    sessions: 'runx.term.sessions',
  };

  var state = {
    ws: null,
    connected: false,
    font: parseInt(localStorage.getItem(LS.fontSize), 10) || 14,
    theme: localStorage.getItem(LS.theme) || 'dark',
    sessions: {},        // id -> { term, fit, host, tabEl, labelEl, exited }
    order: [],           // 标签顺序
    active: null,
    pendingInput: [],    // 断线缓存
    pendingBytes: 0,
    reconnectDelay: 1000,
    resumeIds: readLsArray(LS.sessions),
    closing: false,
  };

  var el = {
    tablist: document.getElementById('tablist'),
    terminals: document.getElementById('terminals'),
    newtab: document.getElementById('newtab'),
    status: document.getElementById('status'),
    statusText: document.getElementById('status-text'),
    fontDec: document.getElementById('font-dec'),
    fontInc: document.getElementById('font-inc'),
    themeBtn: document.getElementById('theme-btn'),
    reconnect: document.getElementById('reconnect'),
    hint: document.getElementById('hint'),
  };

  /* ── utils ── */
  function readLsArray(k) { try { var v = JSON.parse(localStorage.getItem(k)); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function writeLsArray(k, arr) { try { localStorage.setItem(k, JSON.stringify(arr)); } catch (e) {} }
  function b64ToBytes(b64) {
    var bin = atob(b64), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function hint(msg) {
    el.hint.textContent = msg;
    el.hint.classList.add('show');
    clearTimeout(hint._t);
    hint._t = setTimeout(function () { el.hint.classList.remove('show'); }, 2200);
  }
  function setStatus(kind, text) {
    el.status.className = 'status' + (kind ? ' ' + kind : '');
    el.statusText.textContent = text;
  }

  /* ── 主题 ── */
  function applyTheme() {
    document.body.classList.toggle('theme-light', state.theme === 'light');
    var t = state.theme === 'light' ? LIGHT : DARK;
    Object.keys(state.sessions).forEach(function (id) {
      try { state.sessions[id].term.options.theme = t; } catch (e) {}
    });
  }

  /* ── 终端实例 ── */
  function makeTerminal(id, cols, rows) {
    if (state.sessions[id]) return state.sessions[id];
    var host = document.createElement('div');
    host.className = 'term-host';
    el.terminals.appendChild(host);

    var term = new window.Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: state.font,
      theme: state.theme === 'light' ? LIGHT : DARK,
      scrollback: 5000,
      allowProposedApi: true,
      convertEol: false,
    });
    var fit = null;
    if (FitAddonClass) { fit = new FitAddonClass(); term.loadAddon(fit); }
    term.open(host);

    var tabEl = document.createElement('div');
    tabEl.className = 'tab';
    var labelEl = document.createElement('span'); labelEl.className = 'tlabel'; labelEl.textContent = 'shell';
    var xEl = document.createElement('span'); xEl.className = 'tx'; xEl.textContent = '×'; xEl.title = '关闭会话';
    tabEl.appendChild(labelEl); tabEl.appendChild(xEl);
    tabEl.addEventListener('click', function (e) { if (e.target === xEl) return; activate(id); });
    xEl.addEventListener('click', function (e) { e.stopPropagation(); closeSession(id); });
    el.tablist.appendChild(tabEl);

    var rec = { term: term, fit: fit, host: host, tabEl: tabEl, labelEl: labelEl, exited: false, ro: null };
    state.sessions[id] = rec;
    state.order.push(id);

    term.onData(function (d) { sendInput(id, d); });
    term.onResize(function (sz) { sendResize(id, sz.cols, sz.rows); });

    // 容器尺寸变化 → fit（去抖 250ms）
    if (window.ResizeObserver) {
      rec.ro = new ResizeObserver(function () {
        clearTimeout(rec._rt);
        rec._rt = setTimeout(function () { if (state.active === id) doFit(id); }, 250);
      });
      rec.ro.observe(host);
    }
    return rec;
  }

  function doFit(id) {
    var rec = state.sessions[id];
    if (!rec || !rec.fit) return;
    try { rec.fit.fit(); } catch (e) {}
    sendResize(id, rec.term.cols, rec.term.rows);
  }

  function activate(id) {
    state.active = id;
    Object.keys(state.sessions).forEach(function (k) {
      state.sessions[k].host.classList.toggle('active', k === id);
      state.sessions[k].tabEl.classList.toggle('active', k === id);
    });
    var rec = state.sessions[id];
    if (rec) { doFit(id); rec.term.focus(); }
  }

  function setLabel(id, text) {
    var rec = state.sessions[id];
    if (!rec) return;
    rec.labelEl.textContent = text || 'shell';
    rec.tabEl.title = text || 'shell';
  }

  /* ── 会话操作 ── */
  function newSession() {
    if (!state.connected) { hint('尚未连接，稍后自动新建'); return; }
    var base = state.sessions[state.active];
    var cols = base ? base.term.cols : 80, rows = base ? base.term.rows : 24;
    wsSend({ type: 'create', cols: cols, rows: rows });
  }

  function closeSession(id) {
    if (state.sessions[id]) {
      try { state.sessions[id].term.dispose(); } catch (e) {}
      if (state.sessions[id].ro) state.sessions[id].ro.disconnect();
      state.sessions[id].host.remove();
      state.sessions[id].tabEl.remove();
      delete state.sessions[id];
      state.order = state.order.filter(function (x) { return x !== id; });
    }
    wsSend({ type: 'close', sessionId: id });
    persistSessions();
    if (state.active === id) {
      var next = state.order[state.order.length - 1] || null;
      if (next) activate(next);
      else { state.active = null; newSession(); }
    }
  }

  function persistSessions() {
    writeLsArray(LS.sessions, state.order.filter(function (id) { return !state.sessions[id] || !state.sessions[id].exited; }));
  }

  /* ── 输入 / 尺寸（含断线缓存）── */
  function sendInput(id, data) {
    if (state.connected) wsSend({ type: 'input', sessionId: id, data: data });
    else {
      state.pendingBytes += data.length;
      if (state.pendingBytes <= 65536) state.pendingInput.push({ sessionId: id, data: data });
    }
  }
  function sendResize(id, cols, rows) {
    if (state.connected && cols && rows) wsSend({ type: 'resize', sessionId: id, cols: cols, rows: rows });
  }

  function wsSend(obj) {
    if (!state.ws || state.ws.readyState !== 1) return false;
    try { state.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  /* ── WS ── */
  function connect() {
    clearTimeout(connect._t);
    setStatus('', '连接中…');
    var ws;
    try { ws = new WebSocket(WS_URL); } catch (e) { scheduleReconnect(); return; }
    state.ws = ws;

    ws.onopen = function () {
      state.connected = true;
      state.reconnectDelay = 1000;
      setStatus('ok', '已连接');
      var probe = state.sessions[state.active];
      wsSend({ type: 'hello', cols: probe ? probe.term.cols : 80, rows: probe ? probe.term.rows : 24, resume: state.resumeIds });
    };

    ws.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handle(msg);
    };

    ws.onclose = function () {
      state.connected = false;
      setStatus('bad', '连接中断，重连中…');
      scheduleReconnect();
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function scheduleReconnect() {
    clearTimeout(connect._t);
    connect._t = setTimeout(function () { state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000); connect(); }, state.reconnectDelay);
  }

  function handle(msg) {
    switch (msg.type) {
      case 'welcome':
        if (!msg.pty) { hint('当前环境不支持 PTY'); setStatus('bad', 'PTY 不可用'); }
        // 恢复已存在的会话
        if (state.resumeIds.length) {
          state.resumeIds.forEach(function (id) { wsSend({ type: 'attach', sessionId: id }); });
          state.resumeIds = [];
        } else if (state.order.length === 0) {
          wsSend({ type: 'create', cols: 80, rows: 24 });
        }
        flushPending();
        break;
      case 'created':
        var rec = makeTerminal(msg.sessionId, msg.cols, msg.rows);
        setLabel(msg.sessionId, 'shell ' + msg.cols + 'x' + msg.rows);
        activate(msg.sessionId);
        persistSessions();
        break;
      case 'session': // attach 成功 / 恢复
        var r = makeTerminal(msg.sessionId, msg.cols, msg.rows);
        setLabel(msg.sessionId, msg.title || 'shell');
        if (r.exited) { r.exited = false; }
        activate(msg.sessionId);
        persistSessions();
        break;
      case 'output':
        var t = state.sessions[msg.sessionId];
        if (t) t.term.write(b64ToBytes(msg.data_b64));
        break;
      case 'exit':
        var s = state.sessions[msg.sessionId];
        if (s) {
          s.exited = true;
          var codeStr = msg.code === null || msg.code === undefined ? 'signal=' + (msg.signal || '?') : 'code=' + msg.code;
          s.term.write('\r\n\x1b[2m[进程已退出 ' + codeStr + ']  按 Enter 重开\x1b[0m\r\n');
          s._lastExit = true;
        }
        break;
      case 'closed':
        if (state.sessions[msg.sessionId]) closeSession(msg.sessionId);
        break;
      case 'resized':
        if (state.sessions[msg.sessionId]) setLabel(msg.sessionId, 'shell ' + msg.cols + 'x' + msg.rows);
        break;
      case 'error':
        if (msg.message === 'session_not_found') {
          // 上次会话已丢失（如进程重启）：新建
          var lost = msg.sessionId;
          if (lost && state.sessions[lost]) { try { state.sessions[lost].term.dispose(); } catch (e) {} delete state.sessions[lost]; }
          if (!state.order.length || state.order.length === (lost ? 1 : 0)) { if (lost) hint('上次会话已丢失，已新建'); wsSend({ type: 'create', cols: 80, rows: 24 }); }
        } else {
          hint('错误：' + msg.message);
        }
        break;
      case 'pong':
        break;
    }
  }

  function flushPending() {
    while (state.pendingInput.length) {
      var m = state.pendingInput.shift();
      if (state.sessions[m.sessionId]) wsSend({ type: 'input', sessionId: m.sessionId, data: m.data });
    }
    state.pendingBytes = 0;
  }

  /* ── 复制粘贴 ── */
  function copySelection() {
    var rec = state.sessions[state.active];
    if (!rec) return;
    var sel = rec.term.getSelection();
    if (!sel) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(sel).then(function () { hint('已复制'); }, function () { legacyCopy(sel); });
    } else legacyCopy(sel);
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      hint('已复制');
    } catch (e) { hint('复制失败'); }
  }
  function pasteText(text) {
    var rec = state.sessions[state.active];
    if (rec && text) rec.term.paste(text);
  }

  /* ── 事件绑定 ── */
  el.newtab.addEventListener('click', newSession);
  el.reconnect.addEventListener('click', function () { try { state.ws && state.ws.close(); } catch (e) {} connect(); });
  el.fontInc.addEventListener('click', function () { setFont(state.font + 1); });
  el.fontDec.addEventListener('click', function () { setFont(state.font - 1); });
  el.themeBtn.addEventListener('click', function () {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem(LS.theme, state.theme);
    applyTheme();
  });

  function setFont(n) {
    state.font = Math.max(8, Math.min(28, n));
    localStorage.setItem(LS.fontSize, String(state.font));
    Object.keys(state.sessions).forEach(function (id) {
      try { state.sessions[id].term.options.fontSize = state.font; } catch (e) {}
    });
    if (state.active) doFit(state.active);
  }

  document.addEventListener('paste', function (e) {
    var text = (e.clipboardData || window.clipboardData).getData('text');
    if (text) { e.preventDefault(); pasteText(text); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) { e.preventDefault(); copySelection(); }
    else if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) { /* 交给原生 paste 事件 */ }
    else if (e.ctrlKey && e.shiftKey && (e.key === 'T' || e.key === 't')) { e.preventDefault(); newSession(); }
    else if (e.ctrlKey && e.shiftKey && (e.key === 'W' || e.key === 'w')) { e.preventDefault(); if (state.active) closeSession(state.active); }
  });
  window.addEventListener('beforeunload', function () { persistSessions(); });

  /* ── 启动 ── */
  applyTheme();
  connect();
})();
