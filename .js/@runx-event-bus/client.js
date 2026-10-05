'use strict';

/**
 * RunX 事件总线——浏览器端 SDK（注入到桌面 / 应用页面）
 *
 * 用法：
 *   const bus = window.RunX.bus;
 *   bus.subscribe('calc.*', (ev) => console.log(ev.from, ev.payload));
 *   bus.publish('notes.added', { text: 'hi' });
 *
 * 约定（与内核一致）：
 *   · WS 主通道  /runx/event-bus（同时兼容 /api/event-bus）
 *   · 应用层心跳：收到 {type:'ping'} 回 {type:'pong'}
 *   · 事件命名空间必须是 <app>.<event>，否则服务端返回 422
 */
(function () {
  var WS_PATH = '/runx/event-bus';
  var WS_URL =
    (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + WS_PATH;

  function RunXBus() {
    this._subs = {};      // pattern -> [fn]
    this._once = {};
    this._ws = null;
    this._queue = [];
    this.connect();
  }

  RunXBus.prototype.connect = function () {
    var self = this;
    try { this._ws = new WebSocket(WS_URL); }
    catch (e) { return; }

    this._ws.onopen = function () {
      self._queue.forEach(function (m) { self._ws.send(JSON.stringify(m)); });
      self._queue = [];
      self._fire('__open', null);
    };
    this._ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || !m.type) return;
      if (m.type === 'ping') { self._ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (m.type === 'welcome') { self._fire('__welcome', m); return; }
      if (m.type === 'ack') { self._fire('__ack:' + m.id, m); return; }
      if (m.type === 'error') { self._fire('__error', m); return; }
      if (m.type === 'event') {
        Object.keys(self._subs).forEach(function (pat) {
          if (matchPattern(pat, m.event)) {
            (self._subs[pat] || []).forEach(function (fn) { fn(m); });
          }
        });
      }
    };
    this._ws.onclose = function () {
      self._fire('__close', null);
      setTimeout(function () { self.connect(); }, 2000); // 自动重连
    };
  };

  RunXBus.prototype._send = function (m) {
    if (this._ws && this._ws.readyState === 1) this._ws.send(JSON.stringify(m));
    else this._queue.push(m);
  };

  RunXBus.prototype._fire = function (key, m) {
    (this._subs[key] || []).forEach(function (fn) { fn(m); });
  };

  RunXBus.prototype.subscribe = function (pattern, fn) {
    (this._subs[pattern] = this._subs[pattern] || []).push(fn);
    this._send({ type: 'sub', pattern: pattern });
    return this;
  };

  RunXBus.prototype.unsubscribe = function (pattern) {
    delete this._subs[pattern];
    this._send({ type: 'unsub', pattern: pattern });
    return this;
  };

  RunXBus.prototype.publish = function (event, payload, wantAck) {
    this._send({ type: 'pub', event: event, payload: payload, wantAck: !!wantAck });
    if (wantAck) {
      return new Promise(function (resolve) {
        var t = setTimeout(function () { resolve(null); }, 1000);
        var orig = this._subs['__ack'] = this._subs['__ack'] || [];
        orig.push(function (m) { clearTimeout(t); resolve(m); });
      }.bind(this));
    }
    return Promise.resolve(null);
  };

  RunXBus.prototype.on = function (event, fn) {
    return this.subscribe(event, fn);
  };

  function matchPattern(pattern, event) {
    var p = pattern.split('.'), e = event.split('.'), i = 0, j = 0;
    while (i < p.length) {
      var seg = p[i];
      if (seg === '**') return true;
      if (j >= e.length) return false;
      if (seg === '*') { if (i === p.length - 1) return true; i++; j++; continue; }
      if (seg !== e[j]) return false;
      i++; j++;
    }
    return j === e.length;
  }

  window.RunX = window.RunX || {};
  window.RunX.bus = new RunXBus();
})();
