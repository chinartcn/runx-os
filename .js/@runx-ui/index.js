'use strict';

/**
 * @runx-ui —— 把 packages/runx-ui 的静态资源发给应用页面
 *
 * ── 为什么单开一个扩展，而不是塞进 desktop 的 assets ────────────────
 * 桌面的资源和应用页面是两个源（应用跑在自己的端口上）。字体受 CORS 限制，
 * 直接从桌面目录引会失败；而且这些文件的生命周期与桌面无关 —— 桌面没装，
 * 应用也应该能用 RunX 的样式。所以单独一条路由，带 `Access-Control-Allow-Origin`。
 *
 * ── 这些文件不需要登录 ────────────────────────────────────────────
 * 它们只有 CSS/JS/字体，没有任何数据。要求登录反而会坏掉正事：应用页面在
 * 自己的源里、iframe 里的子资源请求不带 Cookie（SameSite=Lax），一律 401
 * 的结果就是「样式偶尔加载失败」。所以 /runx/ui/* 在白名单里，见
 * @runx-rights-manager 的 OPEN_PREFIX。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = '/runx/ui';
const SRC = path.join(__dirname, '../../packages/runx-ui');
const FONTS = path.join(__dirname, '../@runx-desktop/assets/fonts');

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

/** 允许被直接访问的文件：白名单，不是把目录整个吐出去 */
const ALLOW = new Set([
  'runx-ui.css', 'runx-ui.js', 'gallery.html', 'README.md', 'index.html',
]);

function hashOf(buf) {
  return '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"';
}

module.exports = {
  onRequest(req, url) {
    const p = url.pathname;
    if (!p.startsWith(API + '/')) return undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return {
        status: 405,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' },
        body: '405',
      };
    }

    let rel = decodeURIComponent(p.slice(API.length + 1));
    if (!rel || rel === '/') rel = 'gallery.html';

    // 字体来自桌面目录（同一份文件，不复制一份进来）
    let file = null;
    if (rel.startsWith('fonts/')) {
      const name = path.basename(rel);
      if (/^[\w.-]+\.woff2?$/.test(name)) file = path.join(FONTS, name);
    } else if (ALLOW.has(rel)) {
      file = path.join(SRC, rel);
    }
    if (!file) {
      return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: '404' };
    }

    let buf;
    try { buf = fs.readFileSync(file); }
    catch {
      return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: '404' };
    }

    const etag = hashOf(buf);
    const headers = {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'ETag': etag,
      'Cache-Control': 'no-cache',
      // 跨源引用（应用页面在自己的端口上）：字体必须带这个头才能加载
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    };
    if (req.headers['if-none-match'] === etag) return { status: 304, headers, body: '' };
    return { status: 200, headers, body: buf };
  },
};
