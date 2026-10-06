'use strict';

/**
 * @runx-monitor —— RunX 状态监视器核心扩展
 *
 * 服务端：把内核与应用的运行状态聚合成一个快照，并提供一条 WebSocket 实时事件流。
 * 客户端：桌面窗口，显示进程表 / 端口 / 事件流 / 资源统计（client.js）。
 *
 * ── 数据从哪来（不重复造轮子）──
 *   · 应用清单：supervisor 落盘的 var/runx/apps.json（真相源），经 os.readState 读取。
 *   · 应用状态：订阅 os.ipc 的 apps:changed / app:started / app:stopped /
 *     app:restarting / app:failed 维护影子状态。
 *   · 应用日志：直接读 var/runx/logs/<name>.log（与 supervisor 同源）。
 *   · 进程内存与回收：os.gc.stats()。
 *
 * 跨扩展取数一律走各自落盘的真相源或内核 IPC，不做扩展间的 HTTP 中转 ——
 * 中转要拼端口、要处理对端未响应的降级，而真相源本就在本地。
 *
 * REST 走 /runx/monitor*（NavExt 内核自留 /api/*）。
 *
 * ── 关于 order=50 与 desktop 的路由争夺 ──
 * @runx-desktop（order=40）的 onRequest 会先拿到所有 /runx/* 请求，但它对不认识的
 * 路径会 return undefined 放行，所以本扩展仍能接管 /runx/monitor/*。前提是两边
 * 的路径前缀不撞车 —— 这里用 /runx/monitor 与 /runx/monitor-assets，不与
 * /runx/desktop* 重叠。
 */

const API = '/runx';
const fs = require('fs');
const path = require('path');

const ASSETS_PREFIX = API + '/monitor-assets/';
const STREAM_PATH = API + '/monitor/stream';

/**
 * 白名单：只发前端资源，避免把扩展目录变成可浏览的文件系统。
 * 与 desktop 同构 —— 新扩展各自开一条通道，互不影响。
 */
const ASSET_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.json': 'application/json; charset=utf-8',
};

/** 环形缓冲：只保留最近这些条事件，避免长时间运行把内存吃光 */
const RING_MAX = 300;

/** 单个应用日志默认拉取行数（用户可在扩展配置里覆盖） */
const LOG_DEFAULT_LINES = 200;

let S = null;

module.exports = {
  onInit(ctx) {
    const os = ctx.os;
    const cfg = () => ctx.config || {};
    const intOf = (v, dflt, min, max) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return dflt;
      return Math.max(min, Math.min(max, Math.trunc(n)));
    };

    /* ── 事件环形缓冲：WS 断线期间新来的事件也攒着，重连后由客户端补拉 ── */
    const ring = [];
    let seq = 0;

    function pushEvent(type, payload) {
      seq += 1;
      const rec = { seq, ts: Date.now(), type, payload: payload === undefined ? null : payload };
      ring.push(rec);
      if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
      broadcastEvent(rec);
      return rec;
    }

    /* ── 定向推送 ──
     * 不用 os.ws.broadcast：那是系统级广播，会发给**所有** socket（event-bus
     * 的客户端也会收到监视器的事件，串台）。这里自己维护本流的连接集合，
     * 逐连接 conn.send() 定向投递。 */
    const conns = new Set();

    function broadcastEvent(rec) {
      if (cfg().stream_enabled === false) return;
      const msg = { type: 'event', event: rec.type, seq: rec.seq, ts: rec.ts, payload: rec.payload };
      for (const c of conns) {
        try { c.send(msg); } catch { conns.delete(c); }
      }
    }

    /* ── 应用清单：直接读 supervisor 的真相源 ── */
    function loadApps() {
      const doc = os.readState('apps.json', { schema: 1, apps: [] });
      const apps = (doc && Array.isArray(doc.apps)) ? doc.apps : [];
      return apps.map((a) => ({
        name: String(a.name || ''),
        cmd: a.cmd ? String(a.cmd) : '',
        cwd: a.cwd ? String(a.cwd) : '',
        port: Number.isFinite(Number(a.port)) ? Number(a.port) : null,
        restart: a.restart ? String(a.restart) : 'no',
        autostart: !!(a.autostart || a.auto_start),
        title: a.title ? String(a.title) : '',
      })).filter((a) => a.name);
    }

    /* ── 单个应用的运行状态：由 supervisor 维护，监视器只做只读汇总 ──
     * 说明：statusOf 的真实状态（pid / started_at / restart_count）属于 supervisor
     * 的进程内闭包，不落盘。这里通过 os.ipc 事件维护一份影子状态，并尝试从
     * supervisor 的 REST 兜底同步。取不到就标 unknown —— 不猜。 */
    const shadow = new Map();   // name -> { state, ts }

    function bump(name, state) {
      if (!name) return;
      shadow.set(name, { state, ts: Date.now() });
    }

    /* ── 快照：把各数据源拼起来，任何一个失败都不拖垮整体 ── */
    function snapshot() {
      const apps = loadApps();
      const rows = apps.map((a) => {
        const sh = shadow.get(a.name) || null;
        return Object.assign({}, a, {
          status: sh ? sh.state : 'unknown',
          status_ts: sh ? sh.ts : null,
        });
      });

      let gc = null;
      try { gc = os.gc.stats(); } catch { /* 忽略 */ }

      const mem = process.memoryUsage();
      return {
        server_ts: Date.now(),
        seq,
        apps: rows,
        streams: { path: STREAM_PATH, enabled: cfg().stream_enabled !== false },
        gc,
        process: {
          pid: process.pid,
          uptime_ms: Math.round(process.uptime() * 1000),
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          memory: {
            rss: mem.rss,
            heap_used: mem.heapUsed,
            heap_total: mem.heapTotal,
            external: mem.external,
          },
        },
      };
    }

    /* ── WS：注册一条实时流。内核只接受已注册路径的升级请求 ── */
    function registerStream() {
      os.ws.register(STREAM_PATH, {
        onConnect(conn) {
          conns.add(conn);
          conn.send({
            type: 'welcome',
            server_ts: Date.now(),
            seq,
            refresh_ms: intOf(cfg().refresh_ms, 3000, 0, 60000),
            snapshot: snapshot(),
          });
        },
        onMessage(conn, text) {
          let msg = null;
          try { msg = JSON.parse(text); } catch { return; }
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'ping') { conn.send({ type: 'pong', ts: Date.now() }); return; }
          // 断线重连后补拉遗漏事件：客户端带上 since（已经收到的最大 seq）
          if (msg.type === 'sync') {
            const since = Number(msg.since);
            const missed = Number.isFinite(since) ? ring.filter((r) => r.seq > since) : ring.slice(-50);
            conn.send({ type: 'sync', seq, events: missed, snapshot: snapshot() });
          }
        },
        onClose(conn) { conns.delete(conn); },
      });
      return () => conns.size;
    }

    const streamClients = registerStream();

    /* ── 订阅内核 IPC：应用状态变化即时入流 ── */
    const onIPC = (type) => (name) => {
      bump(name, type === 'app:started' ? 'running'
        : type === 'app:restarting' ? 'restarting'
          : type === 'app:failed' ? 'failed'
            : 'stopped');
      pushEvent(type, { name: name || null });
    };
    os.ipc.on('app:started', onIPC('app:started'));
    os.ipc.on('app:stopped', onIPC('app:stopped'));
    os.ipc.on('app:restarting', onIPC('app:restarting'));
    os.ipc.on('app:failed', onIPC('app:failed'));
    os.ipc.on('apps:changed', () => {
      pushEvent('apps:changed', { count: loadApps().length });
    });

    pushEvent('monitor:ready', { pid: process.pid });

    /* ── 前端资源 ── */
    function rewriteCssUrls(css, cssRel) {
      const dir = path.posix.dirname(cssRel.split(path.sep).join('/'));
      return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
        if (/^(data:|https?:|\/\/|#)/i.test(u)) return m;
        const joined = dir === '.' ? u : dir + '/' + u;
        const clean = joined.replace(/^\.\//, '');
        // path.posix.normalize 会把 ../ 消掉，避免产出带 .. 的 URL
        return 'url(' + q + ASSETS_PREFIX + path.posix.normalize(clean) + q + ')';
      });
    }

    function serveAsset(rel, reqEth) {
      const safe = rel.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!safe || safe.includes('\u0000')) return assetText(400, '非法路径');
      const ext = path.extname(safe).toLowerCase();
      const type = ASSET_MIME[ext];
      if (!type) return assetText(404, '找不到该资源');

      let full;
      try { full = ctx.fs.path(safe); }
      catch { return assetText(403, '禁止访问'); }

      let st;
      try { st = fs.statSync(full); } catch { return assetText(404, '找不到该资源'); }
      if (!st.isFile()) return assetText(404, '不是文件');

      const etag = '"' + st.mtimeMs.toString(36) + '-' + st.size.toString(36) + '"';
      const headers = {
        'Content-Type': type,
        'ETag': etag,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      };
      if (reqEth && reqEth === etag) return { status: 304, headers, body: '' };
      return { status: 200, headers, body: fs.readFileSync(full) };
    }

    function assetText(status, text) {
      return { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text };
    }

    /**
     * 读应用日志尾部。
     *
     * 直接读 **同一个文件**（var/runx/logs/<name>.log），不经 supervisor 的 REST
     * 中转 —— 中转要拼端口、要处理 supervisor 未响应的降级，而日志文件本就是
     * 双方共同的真相源。supervisor 自己也是这么读的（ctx.project.read）。
     */
    function logsOf(name, lines) {
      const n = intOf(lines, intOf(cfg().history_lines, LOG_DEFAULT_LINES, 20, 5000), 1, 5000);
      // 应用名限定字符集，避免拼出 ../ 之类越出日志目录
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return { error: '应用名非法' };
      let text = '';
      try { text = ctx.project.read('var/runx/logs/' + name + '.log'); }
      catch { return { error: '日志不存在', name }; }
      const arr = String(text).split('\n').filter((l) => l.length);
      const total = arr.length;
      return { name, lines: arr.slice(-n), total, truncated: total > n };
    }

    /* onRequest 用的闭包包（含 json/err 辅助）与 desktop / supervisor 同构 */
    S = {
      json: (status, obj) => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(obj) }),
      err: (code, message, data) => ({ status: code, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: { code, message, data } }) }),
      serveAsset,
      rewriteCssUrls,
      snapshot,
      loadApps,
      pushEvent,
      logsOf,
      ringOf: () => ring.slice(),
      clients: streamClients,
      meta: () => ({
        id: '@runx-monitor',
        stream_path: STREAM_PATH,
        assets_prefix: ASSETS_PREFIX,
        refresh_ms: intOf(cfg().refresh_ms, 3000, 0, 60000),
        history_lines: intOf(cfg().history_lines, LOG_DEFAULT_LINES, 20, 5000),
        stream_enabled: cfg().stream_enabled !== false,
      }),
    };

    /** stats() 必须同步 —— 内核 /api/extensions/:id/stats 会同步调用它 */
    ctx.log('monitor ready, stream=' + STREAM_PATH);
  },

  /** 内核统计端点用：必须同步返回 */
  stats() {
    if (!S) return { ready: false };
    const snap = S.snapshot();
    return {
      ready: true,
      apps: snap.apps.length,
      events: snap.seq,
      stream_clients: S.clients(),
      rss: snap.process.memory.rss,
      uptime_ms: snap.process.uptime_ms,
    };
  },

  onRequest(req, url, ctx) {
    const p = url.pathname;
    if (!p.startsWith(API + '/monitor')) return undefined;   // 其它 /runx/* 交给兄弟扩展
    if (!S) return undefined;

    /* 前端资源：/runx/monitor-assets/<相对扩展目录的路径> */
    if (p.startsWith(ASSETS_PREFIX)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return { status: 405, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' }, body: '405' };
      }
      const rel = decodeURIComponent(p.slice(ASSETS_PREFIX.length));
      const r = S.serveAsset(rel, req.headers['if-none-match']);
      if (r.status === 200 && typeof r.body === 'string' && /\.css$/i.test(rel)) {
        return Object.assign({}, r, { body: S.rewriteCssUrls(r.body, rel) });
      }
      return r;
    }

    if (req.method === 'GET' && p === API + '/monitor') {
      return S.json(200, Object.assign({}, S.snapshot(), { meta: S.meta() }));
    }
    if (req.method === 'GET' && p === API + '/monitor/meta') return S.json(200, S.meta());
    if (req.method === 'GET' && p === API + '/monitor/apps') return S.json(200, { apps: S.snapshot().apps });

    /* 事件流历史（WS 之外的 HTTP 兜底，便于脚本/无 WS 环境消费） */
    if (req.method === 'GET' && p === API + '/monitor/events') {
      const since = Number(url.searchParams.get('since'));
      const all = S.ringOf();
      const out = Number.isFinite(since) ? all.filter((r) => r.seq > since) : all;
      return S.json(200, { seq: S.snapshot().seq, events: out });
    }

    /* 单个应用的日志尾部 */
    if (req.method === 'GET' && p.startsWith(API + '/monitor/apps/') && p.endsWith('/logs')) {
      const name = decodeURIComponent(p.slice((API + '/monitor/apps/').length, -('/logs'.length)));
      if (!name) return S.err(400, '缺少应用名');
      const r = S.logsOf(name, url.searchParams.get('lines'));
      if (r.error) return S.err(r.error === '应用名非法' ? 400 : 404, r.error, { name });
      return S.json(200, r);
    }

    return S.err(404, '未知的监视器接口', { path: p });
  },
};
