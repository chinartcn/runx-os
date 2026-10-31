// RunX 根域重定向 Worker
// ----------------------------------------------------------------------------
// 作用：访问根域 rtcnnavext.de5.net（apex）时，302 跳转到 www.rtcnnavext.de5.net，
//       保留原始路径与查询串（/foo?bar=1 → https://www.rtcnnavext.de5.net/foo?bar=1）。
// 只匹配 apex（通过 wrangler.toml 的 routes = ["rtcnnavext.de5.net/*"]），
// 子域 api/store/docs 不会被这个 Worker 接管，各自照常工作。
//
// 部署（需要 Cloudflare API Token，见 .secrets/.env 的 CF_TOKEN）：
//   cd site/redirect
//   CLOUDFLARE_API_TOKEN="<token>" npx wrangler deploy
//   # wrangler.toml 里的 routes 会在首次部署时自动绑定到根域
//
// 前置：根域的 DNS 记录需要是「橙色云」（proxied）。只有走 Cloudflare 边缘的
//       流量才会触发 Worker；若是灰色 DNS-only，Worker Route 不生效，根域仍直连隧道。
//       在 Cloudflare Dashboard → DNS 里把根域那条 CNAME 点亮小云即可。

const ROOT_HOST = 'rtcnnavext.de5.net';
const WWW_HOST = 'www.rtcnnavext.de5.net';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname.toLowerCase() === ROOT_HOST) {
      const target = new URL(request.url);
      target.hostname = WWW_HOST;
      target.port = '';
      target.protocol = 'https:';
      // 302：临时跳转，浏览器/搜索引擎不会把根域的权重并到 www
      return Response.redirect(target.toString(), 302);
    }
    // 非根域（理论上不会到这，因为 route 只绑 apex）原样放行
    return fetch(request);
  },
};
