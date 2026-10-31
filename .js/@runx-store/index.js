'use strict';

/**
 * @runx-store —— RunX 应用商店（内核扩展）
 *
 * 服务端：商店 API 的本地代理 + 安装入口。
 * 客户端：桌面里的商店面板（列表 + 详情 + 安装），见 client.js。
 *
 * ── 为什么要有这个扩展，而不是让前端直接 fetch 商店 ──
 * 两个原因：
 *   1. 商店 API 允许跨域，但**代理下载**（/api/proxy）会把整包搬过 Worker ——
 *      免费额度有限。让内核代理一次，只代理「下载这一步」。
 *   2. 安装是**特权操作**（写文件、起进程）。它必须走 @runx-pax 的安全解包，
 *      不能由前端直接把 tarball 塞进系统。
 *
 * ── 返回值约定 ──
 * 扩展的 onRequest 返回 {status, type, body}（不是 Response）——
 * 内核会把它转成 HTTP 响应。跟 @runx-files 一个套路。
 *
 * ── 能力面 ──
 *   读：ctx.config（api_base / proxy_download）
 *   联网：ctx.fetch（带超时，扩展重载时自动 abort）
 *   装：转发到 /runx/apps/install（@runx-pax 的安全解包）
 */

const API = '/runx';
const DEFAULT_API = 'https://api.rtcnnavext.de5.net';

// 内核端口：从请求头取实际监听端口（见 gateway.js 的说明）
const { gwPortOf } = require('./gateway');

// 扩展状态放模块作用域 —— onInit 与 onRequest 拿到的不是同一个 ctx 对象
// （ctx.S 只在 onInit 那一份上，onRequest 里读会是 undefined）。
let S = null;

module.exports = {
  onInit(ctx) {
    const cfg = Object.assign(
      { api_base: DEFAULT_API, proxy_download: true },
      ctx.config || {}
    );
    const base = String(cfg.api_base || DEFAULT_API).replace(/\/+$/, '');
    S = {
      base,
      proxy: cfg.proxy_download !== false,
      json: (status, obj) => ({
        status,
        type: 'application/json; charset=utf-8',
        body: JSON.stringify(obj),
      }),
      err: (status, message) => ({
        status,
        type: 'application/json; charset=utf-8',
        body: JSON.stringify({ ok: false, error: 'store_error', message }),
      }),
    };
  },

  onRequest(req, url, ctx) {
    const p = url.pathname;
    if (!S) return undefined;

    // GET /runx/store/config —— 前端拿当前配置（API 地址、是否走代理）
    if (req.method === 'GET' && p === API + '/store/config') {
      return S.json(200, {
        ok: true,
        api_base: S.base,
        proxy_download: S.proxy,
      });
    }

    // GET /runx/store/apps?q=&category= —— 代理商店列表
    if (req.method === 'GET' && p === API + '/store/apps') {
      const q = url.searchParams.get('q') || '';
      const category = url.searchParams.get('category') || '';
      const target = S.base + '/api/apps?q=' + encodeURIComponent(q) +
        (category ? '&category=' + encodeURIComponent(category) : '');
      return ctx.fetch(target, { headers: { accept: 'application/json' } })
        .then((r) => r.json())
        .then((j) => S.json(200, j))
        .catch((e) => S.err(502, '商店不可达：' + String(e && e.message || e)));
    }

    // GET /runx/store/apps/:slug —— 代理详情
    const m = p.match(new RegExp('^' + API + '/store/apps/([^/]+)$'));
    if (req.method === 'GET' && m) {
      const slug = decodeURIComponent(m[1]);
      return ctx.fetch(S.base + '/api/apps/' + encodeURIComponent(slug), {
        headers: { accept: 'application/json' },
      })
        .then((r) => r.json())
        .then((j) => S.json(200, j))
        .catch((e) => S.err(502, '商店不可达：' + String(e && e.message || e)));
    }

    // POST /runx/store/install —— 商店应用 → 交给 PaX 装
    if (req.method === 'POST' && p === API + '/store/install') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((body) => {
        const url = String(body.url || '').trim();
        if (!/^https?:\/\//i.test(url)) return S.err(400, '下载地址不对');
        // subdir：应用在包内的相对路径（如 "apps/demo"）。
        // GitHub 仓库归档的顶层是仓库名，解包后内核要靠它找 appex.json。
        // 没有它也能试（内核会自动探测），但包里多个应用时必须有。
        const subdir = String(body.subdir || '').trim();
        // 下载地址是前端给的 —— 但它必须指向 http/https，绝不接受 file:// 之类。
        // 是否套一层代理由扩展配置决定（proxy_download）。
        const installUrl = S.proxy
          ? S.base + '/api/proxy?url=' + encodeURIComponent(url)
          : url;
        // 转发给 PaX：它会做安全解包（拒软链 / 绝对路径 / ../）再落盘。
        // 端口从请求的 Host 头取 —— 那是内核**实际**监听的端口。
        // 只认 process.env.PORT 会在「内核跑在非 3000 端口」时转发到别的实例，
        // 症状是「装不上，报的错跟安装毫无关系」，极难排查。
        const gwPort = gwPortOf(ctx, req);
        const payload = { source: 'remote', url: installUrl };
        if (subdir) payload.subdir = subdir;
        return ctx.fetch('http://127.0.0.1:' + gwPort + API + '/apps/install', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then((r) => r.json())
          .then((j) => S.json(j && j.ok ? 200 : 422, j))
          .catch((e) => S.err(500, '安装失败：' + String(e && e.message || e)));
      });
    }

    return undefined;
  },
};
