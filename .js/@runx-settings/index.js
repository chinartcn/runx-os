'use strict';

/**
 * @runx-settings —— RunX 全局设置核心扩展
 *
 * 服务端：把「内核级设置」与「桌面级设置」聚合成一个统一的设置面，并提供前端资源通道。
 * 客户端：分栏设置面板（通用 / 外观 / 显示 / 扩展 / 关于），见 client.js。
 *
 * REST 走 /runx/settings*（NavExt 内核自留 /api/*）。
 *
 * ── 与 @runx-desktop 的边界（本扩展接管全部设置）──
 * 桌面外壳仍持有 desktop.json 的**真相源**（外观 / 壁纸 / 强调色 / 显示 / 任务栏 /
 * 图标栅格 / 窗口默认值），本扩展**不复制**这些存储 —— 复制就会有两个真相源，
 * 迟早不一致。设置面板对这些项做**代理转发**到 /runx/desktop/*，只为它们提供
 * 统一的界面与一次性的元信息（选项枚举）。
 *
 * 于是职责划分是：
 *   · @runx-desktop —— 桌面布局与外观的存储与 REST（唯一真相源）。
 *   · @runx-settings —— ① 内核级设置（扩展启用/停用、扩展配置编辑、站点信息、
 *                        运行时概览）；② 桌面设置的代理与统一 UI。
 *
 * 桌面外壳里的「桌面设置…」入口改为调本扩展打开（见 desktop/client.js 的
 * openSettings 改为转发 RunX.settings.open），避免两套设置界面并存。
 *
 * ── 内核级设置的写操作 ──
 * 扩展启用/停用与扩展配置写入，代理到内核自留的 /api/extensions/*（内核才是
 * 扩展清单与配置的真相源）。内核默认 api.writable=true，但若站点管理员把它关了，
 * 这些写操作会返回 403 —— 本扩展只如实转达，不绕过。
 */

const API = '/runx';
const CORE_API = '/api';
const fs = require('fs');
const path = require('path');

const ASSETS_PREFIX = API + '/settings-assets/';

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

let S = null;

/**
 * Host 头是否是本机环回形态（防 SSRF）。
 * 接受：localhost / 127.x.x.x / [::1] / 本机各网卡 IP 不可知，故只认环回；
 * 带端口的形如 host:port 也接受（端口需为数字）。
 */
function isLoopbackHost(h) {
  const s = String(h || '').trim().toLowerCase();
  if (!s) return false;
  // 去掉合法端口
  let host = s;
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(s);
  if (m) host = m[1];
  if (host === 'localhost') return true;
  if (host === '[::1]' || host === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

module.exports = {
  onInit(ctx) {
    const os = ctx.os;
    const cfg = () => ctx.config || {};

    /**
     * 打本机内核 / 桌面扩展的 REST。
     *
     * ⚠ Host 头必须校验：直接用客户端给的 Host 拼 URL 是典型 SSRF ——
     * 伪造 `Host: evil.com` 就能让服务端替攻击者发出任意请求（还能读回响应）。
     * 这里只接受环回地址形态的 Host；不合法就回落到本机默认端口。
     */
    function proxy(method, pathname, search, headers, body) {
      const rawHost = String((headers && headers.host) || '');
      const host = isLoopbackHost(rawHost) ? rawHost : ('127.0.0.1:' + (cfg().__port || 3000));
      const url = 'http://' + host + pathname + (search || '');
      const to = Number(cfg().proxy_timeout_ms);
      const opts = { method: method, timeout: Number.isFinite(to) ? to : 8000 };
      if (body !== undefined && body !== null) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      return ctx.fetch(url, opts).then((r) => {
        return r.text().then((t) => ({
          status: r.status,
          contentType: (r.headers && r.headers.get && r.headers.get('content-type')) || '',
          text: t,
        }));
      });
    }

    /**
     * 代理「会触发扩展重载」的写操作（toggle / config 写入）。
     *
     * 为什么不能像读操作那样 await 结果：内核的 toggle 内部会调
     * getExtensions(app) 立即重载**所有**扩展，其中就包括本扩展自己 ——
     * 重载会跑 dispose，把本次请求里 ctx.fetch 注册的 abort 控制器清掉，
     * 于是 fetch 必然以 EXT_FETCH_ABORT 收场。实测：写操作永远失败，
     * 而同一代理的读操作 10ms 就回来了。
     *
     * 这个 abort 不代表写入失败：内核已经在此之前完成了校验、落盘与重载
     * （实测 mod.json 的 enabled 确实翻转了）。所以这里不把 abort 当错误 ——
     * 发得出请求就回 202，由客户端随后拉状态确认最终结果。
     */
    function relayWrite(p) {
      return p.then(
        (r) => {
          // proxy() 对 HTTP 错误是 resolve 而非 reject（fetch 语义），
          // 所以必须在这里自己判状态码 —— 否则上游的 400/403/404 会被
          // 一律吞成 200，调用方以为写成功了。
          const st = r && Number(r.status);
          if (!Number.isFinite(st) || st >= 400) {
            const msg = upstreamErrorText(r) || ('上游返回 ' + st);
            return S.err(Number.isFinite(st) && st >= 400 ? st : 502, '写入被拒绝：' + msg);
          }
          return S.json(200, { ok: true });
        },
        (e) => {
          const aborted = e && (e.code === 'EXT_FETCH_ABORT' || /超时或已取消/.test(e.message || ''));
          if (aborted) return S.json(202, { ok: true, reloading: true });
          return S.err(502, '写入失败：' + e.message);
        }
      );
    }

    /** 从上游响应里取出可读的错误文案（内核多返回 {error:"..."}） */
    function upstreamErrorText(r) {
      if (!r || !r.text) return '';
      const t = String(r.text || '').trim();
      if (!t) return '';
      if (t.charAt(0) === '{') {
        try {
          const j = JSON.parse(t);
          const e = j && j.error;
          if (typeof e === 'string') return e;
          if (e && typeof e.message === 'string') return e.message;
        } catch { /* 落回原文 */ }
      }
      return t.length > 200 ? t.slice(0, 200) + '…' : t;
    }

    /**
     * 把代理结果转成响应。
     *
     * 上游并非总是 JSON：内核与兄弟扩展对未知路径会回 HTML 404 页。这时**不要**
     * 把它包装成 { raw: '<html>...' } —— 那会让调用方以为请求成功、拿到一个
     * 看不出问题的对象。直接转成结构化的错误，把状态码如实透传。
     */
    function relay(p) {
      return p.then((r) => {
        const ct = r.contentType || '';
        const looksJson = /json/i.test(ct) || /^\s*[{[]/.test(r.text || '');
        let data = null;
        if (looksJson) {
          try { data = r.text ? JSON.parse(r.text) : null; } catch { data = null; }
        }
        if (data === null) {
          return {
            status: r.status >= 400 ? r.status : 502,
            type: 'application/json; charset=utf-8',
            body: JSON.stringify({ error: { code: r.status, message: '上游未返回 JSON（HTTP ' + r.status + '）' } }),
          };
        }
        return { status: r.status, type: 'application/json; charset=utf-8', body: JSON.stringify(data) };
      }).catch((e) => S.err(502, '上游不可达：' + e.message));
    }

    /* ── 内核级：聚合设置面的元信息 ── */
    function coreMeta() {
      return {
        id: '@runx-settings',
        assets_prefix: ASSETS_PREFIX,
        // 客户端行为开关：随 meta 下发，避免「配置改了界面没变」
        show_core_extensions: cfg().show_core_extensions !== false,
        proxy_timeout_ms: Number(cfg().proxy_timeout_ms) || 8000,
        // 哪些设置由本扩展自己持有（内核级），哪些代理给桌面扩展
        own: ['extensions', 'site', 'runtime'],
        proxied: {
          desktop: {
            endpoints: ['/runx/desktop', '/runx/desktop/meta', '/runx/desktop/theme',
              '/runx/desktop/accent', '/runx/desktop/wallpaper', '/runx/desktop/display',
              '/runx/desktop/taskbar', '/runx/desktop/grid', '/runx/desktop/window-defaults'],
            source: 'desktop.json',
          },
        },
        open_sections: ['general', 'appearance', 'display', 'extensions', 'about'],
      };
    }

    /* ── 站点信息（内核 /api/config 的白名单子集）── */
    function siteInfo() {
      return {
        title: cfg().site_title || null,
        version: cfg().server_version || null,
        port: cfg().__port || null,
      };
    }

    function rewriteCssUrls(css, cssRel) {
      const dir = path.posix.dirname(cssRel.split(path.sep).join('/'));
      return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
        if (/^(data:|https?:|\/\/|#)/i.test(u)) return m;
        const joined = dir === '.' ? u : dir + '/' + u;
        return 'url(' + q + ASSETS_PREFIX + path.posix.normalize(joined.replace(/^\.\//, '')) + q + ')';
      });
    }

    function serveAsset(rel, reqEth) {
      const safe = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
      if (!safe || safe.includes('\u0000')) return assetText(400, '非法路径');
      const ext = path.extname(safe).toLowerCase();
      const type = ASSET_MIME[ext];
      if (!type) return assetText(404, '找不到该资源');
      let full;
      try { full = ctx.fs.path(safe); } catch { return assetText(403, '禁止访问'); }
      let st;
      try { st = fs.statSync(full); } catch { return assetText(404, '找不到该资源'); }
      if (!st.isFile()) return assetText(404, '不是文件');
      const etag = '"' + st.mtimeMs.toString(36) + '-' + st.size.toString(36) + '"';
      const headers = {
        'Content-Type': type, 'ETag': etag,
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      };
      if (reqEth && reqEth === etag) return { status: 304, headers, body: '' };
      return { status: 200, headers, body: fs.readFileSync(full) };
    }

    function assetText(status, text) {
      return { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text };
    }

    S = {
      json: (status, obj) => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(obj) }),
      err: (code, message, data) => ({ status: code, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: { code, message, data } }) }),
      serveAsset, rewriteCssUrls, proxy, relay, relayWrite, coreMeta, siteInfo,
    };

    ctx.log('settings ready (接管全部设置；桌面级设置代理到 @runx-desktop)');
  },

  /** 内核统计端点用：必须同步返回 */
  stats() {
    if (!S) return { ready: false };
    return { ready: true, sections: S.coreMeta().open_sections };
  },

  onRequest(req, url, ctx) {
    const p = url.pathname;
    if (!p.startsWith(API + '/settings')) return undefined;   // 其它 /runx/* 交给兄弟扩展
    if (!S) return undefined;
    const q = (k) => url.searchParams.get(k);
    const search = url.search || '';

    /* 前端资源 */
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

    if (req.method === 'GET' && p === API + '/settings/meta') return S.json(200, S.coreMeta());

    /* 内核级总览：把设置面板首屏要用的东西一次给全 */
    if (req.method === 'GET' && p === API + '/settings/overview') {
      return Promise.all([
        S.proxy('GET', CORE_API + '/config', '', req.headers),
        S.proxy('GET', CORE_API + '/extensions', '', req.headers),
        S.proxy('GET', API + '/desktop', '', req.headers),
        S.proxy('GET', API + '/desktop/meta', '', req.headers),
      ]).then((rs) => {
        const parse = (r, dflt) => { try { return r.text ? JSON.parse(r.text) : dflt; } catch { return dflt; } };
        const config = parse(rs[0], null);
        const extsRaw = parse(rs[1], null);
        const desktop = parse(rs[2], null);
        const dmeta = parse(rs[3], null);

        // 内核 /api/extensions 的载荷里没有 core 字段，这里按命名惯例补上：
        // @runx-* 是内核扩展（停用会直接影响站点可用性），设置面板据此
        // 在「隐藏内核扩展」开启时把它们从列表里滤掉。
        const extList = extsRaw ? (Array.isArray(extsRaw) ? extsRaw : (extsRaw.extensions || [])) : [];
        const extensions = {
          count: extList.length,
          enabled: extsRaw ? extsRaw.enabled : undefined,
          extensions: extList.map((x) => Object.assign({}, x, {
            core: typeof x.id === 'string' && x.id.startsWith('@runx-'),
          })),
        };
        if (extsRaw && !Array.isArray(extsRaw)) {
          extensions.dir = extsRaw.dir;
          extensions.configFile = extsRaw.configFile;
        }

        return S.json(200, {
          core: S.coreMeta(),
          site: config ? {
            root: config.root, config_path: config.configPath, site: config.site,
            extensions_dir: config.extensions && config.extensions.dir,
            file_count: config.fileCount, dirs: config.dirs,
            api: config.api,
          } : null,
          extensions: extensions,
          desktop: desktop,
          desktop_meta: dmeta,
        });
      }).catch((e) => S.err(502, e.message));
    }

    /* ── 扩展启用 / 停用：代理到内核 ──
     * 内核扩展（@ 前缀）一并放行：validateExtId 已支持 @ 前缀，
     * 它们和普通扩展走同一条路径。注意写操作必然触发内核重载，
     * 所以要用 relayWrite 而不是 relay（见其注释）。 */
    if (req.method === 'POST' && p === API + '/settings/extensions/toggle') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        if (!b || !b.id) return S.err(400, '缺少扩展 id');
        return S.relayWrite(S.proxy('POST', CORE_API + '/extensions/toggle', '', req.headers, b));
      });
    }

    /* ── 扩展配置：读 / 写 / 还原 ── */
    if (p.startsWith(API + '/settings/extensions/')) {
      const rest = p.slice((API + '/settings/extensions/').length);
      const segs = rest.split('/');
      const id = decodeURIComponent(segs[0] || '');
      if (!id) return S.err(400, '缺少扩展 id');
      const tail = segs.slice(1).join('/');
      const upstream = CORE_API + '/extensions/' + encodeURIComponent(id) + (tail ? '/' + tail : '');

      if (req.method === 'GET' && segs.length === 1) return S.relay(S.proxy('GET', upstream, search, req.headers));
      if (req.method === 'GET' && tail === 'config') return S.relay(S.proxy('GET', upstream, search, req.headers));
      if (req.method === 'GET' && tail === 'config-schema') return S.relay(S.proxy('GET', CORE_API + '/extensions/' + encodeURIComponent(id) + '/config', search, req.headers));
      if (req.method === 'GET' && tail === 'stats') return S.relay(S.proxy('GET', upstream, search, req.headers));

      if (req.method === 'POST' && tail === 'config') {
        return Promise.resolve(ctx.readBody().catch(() => '')).then((raw) => {
          return S.relayWrite(S.proxy('POST', upstream, '', req.headers, raw));
        });
      }
      if (req.method === 'DELETE' && tail === 'config') {
        // 还原默认同样会 getExtensions 重载 → 走 relayWrite
        return S.relayWrite(S.proxy('DELETE', upstream, '', req.headers));
      }
      if (req.method === 'POST' && tail === 'toggle') {
        // 内核的 toggle 是「翻转 mod.json 的 enabled」或「按 body.enabled 设定」。
        // 这里必须把调用方给的 enabled 原样透传，不能写死 true ——
        // 写死的话「停用」按钮会变成「启用」，而且会真的去改 mod.json。
        return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
          const payload = (b && typeof b.enabled === 'boolean')
            ? { id: id, enabled: b.enabled }
            : { id: id, toggle: true };
          return S.relayWrite(S.proxy('POST', CORE_API + '/extensions/toggle', '', req.headers, payload));
        });
      }
      return S.err(404, '未知的设置接口', { path: p });
    }

    /* ── 桌面级设置：透明代理到 @runx-desktop（唯一真相源）── */
    if (p === API + '/settings/desktop' || p.startsWith(API + '/settings/desktop/')) {
      const tail = p.slice((API + '/settings/desktop').length);   // '' 或以 / 开头
      const upstream = API + '/desktop' + tail;
      if (req.method === 'GET') return S.relay(S.proxy('GET', upstream, search, req.headers));
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
        return Promise.resolve(ctx.readBody().catch(() => '')).then((raw) => {
          return S.relay(S.proxy(req.method, upstream, '', req.headers, raw || undefined));
        });
      }
      return S.err(405, '不支持的方法');
    }

    if (req.method === 'GET' && p === API + '/settings') {
      return S.json(200, { meta: S.coreMeta(), site: S.siteInfo() });
    }

    return S.err(404, '未知的设置接口', { path: p });
  },
};
