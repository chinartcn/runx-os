'use strict';

/**
 * @runx/host —— RunX 桌面 API（应用侧）
 *
 * 让一个跑在 RunX 里的 Node 应用知道自己「是个窗口」，而不只是一个端口：
 * 发通知、开子窗口、改标题、读主题、在事件总线上和其他应用说话。
 *
 * ── 为什么是 HTTP 而不是 postMessage ──────────────────────────────
 * 应用的页面在**另一个源**的 iframe 里（term 在 :3460，桌面在 :3000），桌面
 * 壳没法给页面注入任何变量，页面也没法凭自己证明「我是哪个应用」。而进程侧
 * 可以：supervisor 启动应用时注入 RUNX_APP_TOKEN，桌面后端按令牌反查应用名。
 * 所以调用从**服务端**发起，前端只负责表现。
 *
 * ── 不在 RunX 里跑会怎样 ─────────────────────────────────────────
 * 没有 RUNX_APP_NAME / RUNX_APP_TOKEN 时所有方法都抛 `ENOTRUNX`。这是刻意的
 * 显式失败：静默降级会让「本地调试没问题、装进 RunX 就不通知」这种 bug 藏
 * 很久。要写「有就用、没有就跳过」的应用，判断 `rx.enabled` 即可。
 *
 * 零依赖：只用 node 内置的 http / crypto / 全局 WebSocket（Node 21+）。
 */

const http = require('http');
const crypto = require('crypto');

const NAME = process.env.RUNX_APP_NAME || '';
const TOKEN = process.env.RUNX_APP_TOKEN || '';
const GATEWAY = process.env.RUNX_GATEWAY || 'http://127.0.0.1:3000';
const PORT = Number(process.env.RUNX_APP_PORT) || 0;
const DATA_DIR = process.env.RUNX_APP_DATA || '';

const ENABLED = !!(NAME && TOKEN);

function notRunning(what) {
  const e = new Error(
    '不在 RunX 中运行，无法' + what + '（缺 RUNX_APP_NAME / RUNX_APP_TOKEN）');
  e.code = 'ENOTRUNX';
  return e;
}

/* ── 传输层 ─────────────────────────────────────────────────────── */

/**
 * 极简 JSON POST。
 *
 * 不用 fetch：虽然 Node 18+ 自带，但 `AbortSignal.timeout` 在 16/17 上不存在，
 * 而这个包会被装进各种环境（Termux 里的 Node、用户自己的容器）。自己写 30 行
 * 反而更稳。
 */
function post(pathname, body, headers, timeoutMs) {
  const u = new URL(pathname, GATEWAY);
  const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname,
      port: Number(u.port) || 80,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
      }, headers || {}),
      timeout: timeoutMs || 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(j);
        const err = new Error((j && j.error && j.error.message) || ('HTTP ' + res.statusCode));
        err.code = (j && j.error && j.error.code) || res.statusCode;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * 调一个桌面 API 方法。
 *
 * 返回值是后端给的 `result`，不是整个信封 —— 调用方不该关心 {ok:true}。
 */
async function call(method, params, opts) {
  if (!ENABLED) throw notRunning(method);
  const r = await post('/runx/host', { method, params },
    { 'X-Runx-Token': TOKEN }, opts && opts.timeout);
  return r && Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : r;
}

/* ── 事件总线 ───────────────────────────────────────────────────── */

/**
 * 总线连接是懒建的：很多应用只发通知，不订阅任何东西，没必要一上来就开 WS。
 * 一旦建立就常驻，断线按 1s → 8s 退避重连，并把订阅重放一遍（内核重启后能
 * 自动恢复，不需要应用感知）。
 */
const bus = {
  ws: null,
  ready: null,
  subs: new Map(),     // pattern -> Set<fn>
  waiters: [],         // 等连接建立的回调
  retry: 1000,
  closing: false,
};

function busPattern(topic) {
  // 应用能订阅的只有三类：自己的、系统的、桌面的。裸 topic 自动挂到自己的
  // 命名空间下 —— 否则两个应用都 subscribe('download.done') 会互相串台。
  if (/^(app|sys|host)\./.test(topic)) return topic;
  return 'app.' + safeName() + '.' + topic;
}
function safeName() {
  return String(NAME).toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/** 有没有内置 WebSocket（Node 21+ 才有）。没有的话订阅一律不可用，必须明说 */
function hasWS() {
  return typeof globalThis.WebSocket === 'function';
}

function openBus() {
  if (bus.ws || bus.closing) return;
  const WS = globalThis.WebSocket;
  if (typeof WS !== 'function') {
    const e = new Error('当前 Node 没有内置 WebSocket（需要 21+），事件总线不可用');
    e.code = 'ENOWEBSOCKET';
    throw e;
  }
  const url = GATEWAY.replace(/^http/, 'ws') + '/runx/event-bus';
  const ws = new WS(url);
  bus.ws = ws;

  ws.addEventListener('open', () => {
    bus.retry = 1000;
    for (const pattern of bus.subs.keys()) {
      try { ws.send(JSON.stringify({ type: 'sub', pattern })); } catch (e) { /* 断了 */ }
    }
    const w = bus.waiters.splice(0);
    for (const fn of w) { try { fn(); } catch (e) { /* 忽略 */ } }
  });

  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || m.type !== 'event') return;
    const set = bus.subs.get(m.event) || matchAny(m.event);
    if (!set) return;
    for (const fn of set) {
      // 一个订阅者抛错不该影响其他订阅者，更不该炸掉整条连接
      try { fn(m.payload, { event: m.event, from: m.from, ts: m.ts }); } catch (e) { /* 应用自己的 bug */ }
    }
  });

  const onDown = () => {
    bus.ws = null;
    if (bus.closing) return;
    // 退避重连：内核重启、网络抖动都会走到这里
    setTimeout(() => { try { openBus(); } catch (e) { /* 继续等下一次 */ } }, bus.retry);
    bus.retry = Math.min(bus.retry * 2, 8000);
  };
  ws.addEventListener('close', onDown);
  ws.addEventListener('error', () => { try { ws.close(); } catch (e) { /* 已关 */ } });
}

/** 精确订阅 + 通配订阅并存：`app.files.*` 也要能收到 `app.files.saved` */
function matchAny(event) {
  const out = new Set();
  for (const [pattern, set] of bus.subs) {
    if (pattern.indexOf('*') < 0) continue;
    if (matchPattern(pattern, event)) for (const fn of set) out.add(fn);
  }
  return out.size ? out : null;
}

/** `app.files.*` / `app.*.done` 这类通配；实现与内核事件总线保持同一套语义 */
function matchPattern(pattern, event) {
  if (pattern === event || pattern === '*') return true;
  const ps = pattern.split('.');
  const es = event.split('.');
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] === '**') return true;
    if (i >= es.length) return false;
    if (ps[i] === '*') continue;
    if (ps[i] !== es[i]) return false;
  }
  return ps.length === es.length;
}

function ensureBus() {
  if (bus.ws && bus.ws.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('事件总线连接超时'), { code: 'ETIMEDOUT' })), 5000);
    bus.waiters.push(() => { clearTimeout(timer); resolve(); });
    try { openBus(); } catch (e) { clearTimeout(timer); reject(e); }
  });
}

/* ── 公开 API ───────────────────────────────────────────────────── */

const api = {
  /** 应用身份。不在 RunX 里时 name 为空串，enabled 为 false。 */
  app: Object.freeze({
    name: NAME,
    port: PORT,
    dataDir: DATA_DIR,
    gateway: GATEWAY,
  }),

  /** 是否跑在 RunX 里。写「可选集成」的应用先判断这个。 */
  enabled: ENABLED,

  /** 握手：确认令牌有效，顺便拿到桌面认定的应用名 */
  ready() {
    return call('ping');
  },

  /** 逃生口：调用未封装的新方法 */
  call,

  theme: {
    /** {mode:'light'|'dark'|'auto', accent:'#7c5cff', accentId, wallpaper} */
    get() { return call('theme.get'); },

    /**
     * 主题变化时回调。返回取消订阅的函数。
     *
     * 只在**桌面主题真的变了**时触发；应用自己不该轮询 theme.get()，
     * 那是每秒一次 HTTP 的浪费。
     */
    onChange(fn) {
      return api.bus.subscribe('host.theme', (payload) => { fn(payload); });
    },
  },

  /**
   * 桌面通知。
   * @param {{title?:string, body?:string}} opts
   */
  notify(opts) {
    const o = opts || {};
    return call('notify', { title: o.title, body: o.body });
  },

  window: {
    /**
     * 开一个新窗口，url 必须落在**本应用自己的端口**上（后端会校验）。
     * 相对路径（'/detail'）也行，后端按应用端口补全。
     * @param {{url:string, title?:string, w?:number, h?:number}} opts
     */
    open(opts) {
      const o = opts || {};
      return call('window.open', { url: o.url, title: o.title, w: o.w, h: o.h });
    },
    /** 改自己所有窗口的标题（一个应用可能开了多个窗口） */
    setTitle(title, subtitle) {
      return call('window.title', { title, subtitle });
    },
  },

  dock: {
    /** Dock 角标数字（未读数 / 待办数）。传 0 清除。 */
    badge(count) { return call('dock.badge', { count }); },
  },

  bus: {
    /** 本机能不能订阅（Node 21+）。发布事件不需要它。 */
    get available() { return hasWS(); },

    /**
     * 发布事件。topic 会自动挂到 `app.<自己>.` 前缀下，不会和其他应用撞名。
     * 要发全局事件（谁都能收）就用 `sys.` 开头 —— 这条会被后端原样放行。
     * @returns {Promise<{ok:true, event:string}>}
     */
    publish(topic, payload) {
      return call('bus.publish', { topic, payload });
    },

    /**
     * 订阅事件。返回取消订阅函数（务必在不需要时调用，否则连接上会一直
     * 挂着闭包引用）。
     *
     *   rx.bus.subscribe('download.done', fn)   → app.<自己>.download.done
     *   rx.bus.subscribe('app.files.*', fn)     → 订阅别的应用
     *   rx.bus.subscribe('sys.*', fn)           → 系统事件
     */
    subscribe(topic, fn) {
      // 订阅在 Node 18/20 上是不可能实现的（没有内置 WebSocket）。这里同步抛，
      // 而不是让 ensureBus 的失败被 .catch 吞掉 —— 后者表现为「代码没错、事件
      // 就是不来」，用户能查一整天。想写兼容代码就判 `rx.bus.available`。
      if (!hasWS()) {
        throw Object.assign(
          new Error('当前 Node 没有内置 WebSocket（需要 21+），事件总线订阅不可用；' +
            '发布事件（bus.publish）不受影响'), { code: 'ENOWEBSOCKET' });
      }
      const pattern = busPattern(String(topic));
      let set = bus.subs.get(pattern);
      if (!set) {
        set = new Set();
        bus.subs.set(pattern, set);
        ensureBus().then(() => {
          if (bus.ws && bus.ws.readyState === 1) {
            try { bus.ws.send(JSON.stringify({ type: 'sub', pattern })); } catch (e) { /* 断了 */ }
          }
        }).catch(() => { /* 连不上就等重连后补订阅 */ });
      }
      set.add(fn);
      return function unsubscribe() {
        const cur = bus.subs.get(pattern);
        if (!cur) return;
        cur.delete(fn);
        if (!cur.size) bus.subs.delete(pattern);
      };
    },

    /**
     * 请求 / 响应。约定：请求方在 payload 里带 `__replyTo`，应答方按它回一条。
     * 需要对方配合，不适合当通用 RPC 用 —— 但两个应用之间握手足够了。
     *
     * @param {string} topic
     * @param {object} payload
     * @param {{timeout?:number}} opts
     */
    async request(topic, payload, opts) {
      const id = crypto.randomBytes(6).toString('hex');
      const replyTopic = 'app.' + safeName() + '.__rpc.' + id;
      const timeout = (opts && opts.timeout) || 15000;

      const answer = new Promise((resolve, reject) => {
        const off = api.bus.subscribe(replyTopic, (p) => {
          clearTimeout(timer);
          off();
          resolve(p);
        });
        const timer = setTimeout(() => {
          off();
          reject(Object.assign(new Error('请求超时：' + topic), { code: 'ETIMEDOUT' }));
        }, timeout);
      });

      // 顺序不能反：先订阅回复再发请求，否则对方的应答可能比订阅先到
      await ensureBus();
      await api.bus.publish(topic, Object.assign({}, payload, { __replyTo: replyTopic }));
      return answer;
    },
  },

  /** 断开总线（进程退出前调用；不调也会随进程结束） */
  close() {
    bus.closing = true;
    if (bus.ws) { try { bus.ws.close(); } catch (e) { /* 已关 */ } }
    bus.ws = null;
  },
};

module.exports = api;
