'use strict';

/**
 * @runx-event-bus —— RunX 事件总线核心扩展（文档 §8）
 *
 * 基于 ctx.os.ws（内核只做握手+帧编解码+按路径路由）实现：
 *   · WS 主通道  /runx/event-bus（同时注册 /api/event-bus 以贴近文档）
 *   · HTTP 兜底  POST /runx/event-bus、GET /runx/event-bus/history、GET /runx/event-bus/log
 *   · 命名空间 <app>.<event> 强制校验，from 由主进程填（忽略客户端自报），非法 → 422
 *   · 通配符订阅（calc.* / *.done / *）、ring buffer(1000)、JSONL 落盘(批量+10MB 轮转)
 *   · 可选 ack（等 100ms 回 {ack, listeners}）、60s 心跳
 */

const API = '/runx';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NS_RE = /^[a-z][a-z0-9-]*\.[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const RING_MAX = 1000;
const ROTATE_BYTES = 10 * 1024 * 1024;
const KEEP_FILES = 4; // events.log + .1 + .2 + .3

let S = null;
const conns = new Set();
const ring = [];

function newId() { return (crypto.randomUUID ? crypto.randomUUID() : 'e' + Date.now() + Math.random().toString(16).slice(2)).slice(0, 26); }

/** 通配符匹配：* 末位吃掉剩余所有段；** 吃掉零或多段；其余逐段字面匹配 */
function matchPattern(pattern, event) {
  const p = pattern.split('.');
  const e = event.split('.');
  let i = 0, j = 0;
  while (i < p.length) {
    const seg = p[i];
    if (seg === '**') return true; // 吃掉剩余（零或多段）
    if (j >= e.length) return false;
    if (seg === '*') {
      if (i === p.length - 1) return true; // 末尾 *：吃掉剩余所有段
      i++; j++; continue;
    }
    if (seg !== e[j]) return false;
    i++; j++;
  }
  return j === e.length;
}

function json(status, obj) {
  return { status, type: 'application/json; charset=utf-8', body: JSON.stringify(obj) };
}
function err(code, message, data) {
  return { status: code, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: { code, message, data } }) };
}

module.exports = {

  onInit(ctx) {
    const os = ctx.os;
    const root = ctx.root;
    const logDir = path.join(root, 'var', 'runx', 'logs', 'events');
    let logBuf = [];
    let lastFlush = Date.now();

    function flushLog() {
      if (!logBuf.length) { lastFlush = Date.now(); return; }
      fs.mkdirSync(logDir, { recursive: true });
      try { fs.appendFileSync(path.join(logDir, 'events.log'), logBuf.join('\n') + '\n'); }
      catch (e) { ctx.log('事件落盘失败：' + e.message); }
      logBuf = [];
      lastFlush = Date.now();
      try {
        const cur = path.join(logDir, 'events.log');
        if (fs.statSync(cur).size > ROTATE_BYTES) {
          for (let i = KEEP_FILES - 1; i >= 1; i--) {
            const f = path.join(logDir, 'events.log.' + i);
            if (fs.existsSync(f)) fs.renameSync(f, path.join(logDir, 'events.log.' + (i + 1)));
          }
          fs.renameSync(cur, path.join(logDir, 'events.log.1'));
        }
      } catch { /* 忽略 */ }
    }

    function logEvent(ev) { logBuf.push(JSON.stringify(ev)); if (logBuf.length >= 100) flushLog(); }

    /** 核心发布：落 ring + 落盘 + 按订阅过滤转发，返回命中连接数 */
    function publish(event, payload, opts) {
      opts = opts || {};
      const from = String(event.split('.')[0]);
      const ev = { event, from, payload, ts: Date.now(), id: newId() };
      ring.push(ev);
      if (ring.length > RING_MAX) ring.shift();
      logEvent(ev);

      let listeners = 0;
      for (const c of conns) {
        for (const pat of c.subs) {
          if (matchPattern(pat, event)) { c.send({ type: 'event', event, from, payload, ts: ev.ts, id: ev.id }); listeners++; break; }
        }
      }
      return { ev, listeners };
    }

    function handlePub(conn, msg) {
      const event = msg && msg.event;
      if (typeof event !== 'string' || !NS_RE.test(event)) {
        conn.send({ type: 'error', code: 422, message: 'invalid event namespace' });
        return;
      }
      // from 由主进程填（忽略客户端自报）；文档 §8.3 不商量
      const r = publish(event, msg.payload);
      if (msg.wantAck) {
        setTimeout(() => conn.send({ type: 'ack', id: r.ev.id, listeners: r.listeners }), 100);
      }
    }

    const handler = {
      onConnect(conn) {
        conn.subs = new Set();
        conn._pingPending = false;
        conns.add(conn);
        conn.send({ type: 'welcome', client_id: conn.id, server_ts: Date.now() });
      },
      onMessage(conn, text) {
        let m; try { m = JSON.parse(text); } catch { return; }
        if (!m || typeof m !== 'object') return;
        switch (m.type) {
          case 'pub': handlePub(conn, m); break;
          case 'sub': if (typeof m.pattern === 'string') conn.subs.add(m.pattern); break;
          case 'unsub': if (typeof m.pattern === 'string') conn.subs.delete(m.pattern); break;
          case 'pong': conn._pingPending = false; break;
          // 真实 WS ping(0x9) 由内核回 pong；这里只处理应用层 pong
        }
      },
      onClose(conn) { conns.delete(conn); },
    };
    os.ws.register(API + '/event-bus', handler);
    os.ws.register('/api/event-bus', handler); // 贴近文档路径

    // 60s 心跳：空闲超 60s 发 ping，再 60s 无 pong → 关闭
    os.schedule(60000, () => {
      const now = Date.now();
      for (const c of conns) {
        if (now - c.lastMsg >= 120000) { try { c.close(); } catch { /* 已断 */ } }
        else if (now - c.lastMsg >= 60000 && !c._pingPending) { c._pingPending = true; c.send({ type: 'ping' }); }
      }
    });

    // 应用生命周期事件落盘（文档 §9.3：应用生命周期 ✅ 记录）
    const sysLog = (event, name) => publish(event, { name }, { silent: true });
    os.ipc.on('app:started', (n) => sysLog('runx.app.started', n));
    os.ipc.on('app:stopped', (n) => sysLog('runx.app.stopped', n));
    os.ipc.on('app:failed', (n) => sysLog('runx.app.failed', n));

    process.on('SIGTERM', flushLog);
    ctx.os.ipc.on('runx:flush-events', flushLog);

    function readLog({ from, to, event, app, limit }) {
      const files = ['events.log', 'events.log.1', 'events.log.2', 'events.log.3']
        .map((f) => path.join(logDir, f)).filter((f) => fs.existsSync(f));
      const out = [];
      for (const f of files) {
        try {
          const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
          for (const line of lines) {
            let ev; try { ev = JSON.parse(line); } catch { continue; }
            if (from && ev.ts < from) continue;
            if (to && ev.ts > to) continue;
            if (app && ev.from !== app) continue;
            if (event && !matchPattern(event, ev.event)) continue;
            out.push(ev);
          }
        } catch { /* 忽略坏文件 */ }
      }
      out.sort((a, b) => a.ts - b.ts);
      const lim = Math.max(1, Math.min(5000, limit || 500));
      const truncated = out.length > lim;
      return { events: out.slice(-lim), truncated };
    }

    S = { json, err, publish, readLog };
  },

  onRequest(req, url, ctx) {
    const p = url.pathname;
    if (!S) return undefined;

    // POST /runx/event-bus（HTTP 发布兜底）
    if (req.method === 'POST' && p === API + '/event-bus') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((body) => {
        const event = body && body.event;
        if (typeof event !== 'string' || !/^[a-z][a-z0-9-]*\.[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(event)) {
          return S.err(422, 'invalid event namespace');
        }
        const r = S.publish(event, body.payload);
        if (body.wantAck) return S.json(200, { id: r.ev.id, listeners: r.listeners });
        return S.json(200, { id: r.ev.id });
      });
    }

    // GET /runx/event-bus/history
    if (req.method === 'GET' && p === API + '/event-bus/history') {
      const limit = Number(url.searchParams.get('limit')) || 100;
      const lim = Math.max(1, Math.min(1000, limit));
      const snap = ring.slice(-lim);
      return S.json(200, { events: snap, truncated: ring.length > lim });
    }

    // GET /runx/event-bus/log
    if (req.method === 'GET' && p === API + '/event-bus/log') {
      const r = S.readLog({
        from: Number(url.searchParams.get('from')) || 0,
        to: Number(url.searchParams.get('to')) || 0,
        event: url.searchParams.get('event') || '',
        app: url.searchParams.get('app') || '',
        limit: Number(url.searchParams.get('limit')) || 500,
      });
      return S.json(200, r);
    }

    return undefined;
  },
};
