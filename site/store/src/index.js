/**
 * RunX Store · 公共 API + 商店前端
 *
 * 设计前提（来自规划）：
 *   · 零服务器成本 —— 全靠 Cloudflare 免费全家桶（Worker + D1 + KV + R2）
 *   · 去中心化 —— 开发者自带干粮（GitHub / npm），官方只做指路明灯
 *   · 被动式更新 —— 没有定时轮询，全靠用户请求和开发者手动触发
 *
 * 所以这里没有「下载代理服务器」：商店不存包，只存元数据与校验值。
 * R2 是可选的官方镜像桶，没启用也不影响主流程。
 */

import { json, html, preflight } from './http.js';
import { listApps, getApp, getAppBySlug, upsertApp, markDead, bumpDownload, stats } from './db.js';
import { handleUser } from './user.js';
import { handlePublic } from './public.js';
import { handleCron } from './cron.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname;
    const path = url.pathname;

    // 开发者域名：只服务 api.user.*，其余一律 404（避免两条线混在一起）
    if (host.startsWith('api.user.')) {
      return handleUser(request, env, url, ctx);
    }

    // CORS：商店前端可以放在任何地方（包括 GitHub Pages）
    if (request.method === 'OPTIONS') return preflight();

    try {
      // 商店前端（根路径）。store.* 是商店自己的域名；
      // api.* 上也放一份 —— 开发者调试时少记一个域名。
      if (path === '/' || path === '/index.html') {
        return html(INDEX_HTML, 200, {
          'cache-control': 'public, max-age=300',
        });
      }

      // 公共 API
      const r = await handlePublic(request, env, url, ctx);
      if (r) return r;

      // 开发者 API 也允许从主域名访问（方便调试）
      if (path.startsWith('/api/user/')) {
        return handleUser(request, env, url, ctx);
      }

      return json({ ok: false, error: 'not_found', path }, 404);
    } catch (e) {
      return json({ ok: false, error: 'internal', message: String(e && e.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  },
};

/* ───────────────────────────────────────────────────────────────
 * 商店前端。刻意做得极简：一屏列表 + 一个详情抽屉。
 * 它是纯静态的，没有任何构建步骤 —— 和 RunX OS 的内核一个脾气。
 * ─────────────────────────────────────────────────────────────── */
const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RunX Store</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%233b6ef5'/><path d='M8 22V10h4.5a4 4 0 0 1 0 8H12v4z' fill='white'/><path d='M17 10h7M17 14h7M17 18h5' stroke='white' stroke-width='1.8' stroke-linecap='round'/></svg>">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 20px 80px;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #fbfbfd; color: #16161a;
  }
  @media (prefers-color-scheme: dark) { body { background: #101014; color: #ececf1; } }
  .wrap { max-width: 900px; margin: 0 auto; }
  header { padding: 46px 0 22px; }
  h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: -.01em; }
  .sub { opacity: .62; margin: 0; }
  .bar { display: flex; gap: 10px; align-items: center; margin: 22px 0 6px; flex-wrap: wrap; }
  input, select {
    font: inherit; padding: 7px 11px; border-radius: 8px;
    border: 1px solid rgba(128,128,128,.35); background: transparent; color: inherit;
  }
  input { flex: 1; min-width: 180px; }
  input:focus, select:focus { outline: 2px solid #3b6ef5; outline-offset: 1px; }
  .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(250px,1fr)); margin-top: 16px; }
  .card {
    border: 1px solid rgba(128,128,128,.22); border-radius: 12px; padding: 14px;
    cursor: pointer; background: rgba(128,128,128,.05);
  }
  .card:hover { border-color: #3b6ef5; }
  .card h3 { margin: 0 0 3px; font-size: 15px; }
  .card p { margin: 0; font-size: 12.5px; opacity: .66; }
  .meta {
    display: flex; gap: 8px; margin-top: 9px; align-items: center;
    font-size: 11.5px; opacity: .6; flex-wrap: wrap;
  }
  .tag { padding: 1px 7px; border-radius: 999px; background: rgba(128,128,128,.16); }
  .dl { color: #3b6ef5; font-variant-numeric: tabular-nums; }
  .empty { text-align: center; padding: 70px 0; opacity: .55; }
  dialog {
    border: none; border-radius: 14px; padding: 0; max-width: 560px; width: calc(100% - 32px);
    background: Canvas; color: CanvasText; box-shadow: 0 20px 60px rgba(0,0,0,.3);
  }
  dialog::backdrop { background: rgba(0,0,0,.42); }
  .dlg-h { padding: 18px 20px 12px; border-bottom: 1px solid rgba(128,128,128,.22); }
  .dlg-h h2 { margin: 0 0 4px; font-size: 17px; }
  .dlg-b { padding: 16px 20px; max-height: 60vh; overflow: auto; }
  .dlg-f { padding: 12px 20px 18px; display: flex; gap: 8px; justify-content: flex-end; }
  .btn {
    font: inherit; padding: 7px 14px; border-radius: 8px; cursor: pointer;
    border: 1px solid rgba(128,128,128,.35); background: transparent; color: inherit;
  }
  .btn.primary { background: #3b6ef5; border-color: #3b6ef5; color: #fff; }
  .btn.primary:disabled { opacity: .45; cursor: default; }
  pre {
    background: rgba(128,128,128,.12); padding: 11px 13px; border-radius: 9px;
    overflow-x: auto; font-size: 12px; line-height: 1.65;
  }
  .perm { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
  .row { display: flex; gap: 10px; padding: 5px 0; align-items: baseline; }
  .row .k { flex: 0 0 92px; opacity: .55; font-size: 12px; }
  .warn { color: #d9822b; }
  .foot { text-align: center; padding: 40px 0 0; opacity: .5; font-size: 12px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>RunX Store</h1>
    <p class="sub">极致白嫖，按需驱动。商店只存元数据与校验值，包在开发者自己的源上。</p>
    <div class="bar">
      <input id="q" placeholder="搜索应用…">
      <select id="cat"><option value="">全部分类</option></select>
      <button class="btn" id="refresh">刷新</button>
    </div>
  </header>
  <div id="list" class="grid"></div>
  <div id="empty" class="empty" hidden>还没有应用。</div>
  <div class="foot">RunX Store · MIT 开源 · <a href="https://docs.rtcnnavext.de5.net/">文档</a></div>
</div>

<dialog id="dlg">
  <div class="dlg-h"><h2 id="d-title"></h2><div id="d-ver" class="sub" style="font-size:12px;opacity:.6"></div></div>
  <div class="dlg-b" id="d-body"></div>
  <div class="dlg-f">
    <button class="btn" id="d-close">关闭</button>
    <button class="btn primary" id="d-install">安装</button>
  </div>
</dialog>

<script>
const $ = (s) => document.querySelector(s);
let ALL = [], CUR = null;

async function load() {
  const r = await fetch('/api/apps?q=' + encodeURIComponent($('#q').value) +
                       (($('#cat').value) ? '&category=' + encodeURIComponent($('#cat').value) : ''));
  const j = await r.json();
  if (!j.ok) { document.getElementById('empty').textContent = j.error || '加载失败'; return; }
  ALL = j.apps || [];
  render();
  const cats = [...new Set(ALL.map(a => a.category))].sort();
  $('#cat').innerHTML = '<option value="">全部分类</option>' +
    cats.map(c => '<option>' + c + '</option>').join('');
}

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function render() {
  const box = $('#list');
  if (!ALL.length) { box.innerHTML = ''; $('#empty').hidden = false; return; }
  $('#empty').hidden = true;
  box.innerHTML = ALL.map(a => \`
    <div class="card" data-slug="\${esc(a.slug)}">
      <h3>\${esc(a.name)}</h3>
      <p>\${esc(a.summary)}</p>
      <div class="meta">
        <span class="tag">\${esc(a.category)}</span>
        <span>v\${esc(a.version)}</span>
        <span>\${esc(a.author)}</span>
        <span class="dl">\${a.downloads} 次下载</span>
      </div>
    </div>\`).join('');
  box.querySelectorAll('.card').forEach(c =>
    c.onclick = () => open(c.dataset.slug));
}

async function open(slug) {
  const a = ALL.find(x => x.slug === slug);
  if (!a) return;
  CUR = a;
  $('#d-title').textContent = a.name;
  $('#d-ver').textContent = 'v' + a.version + ' · ' + a.author + ' · ' + a.license;
  const perms = a.permissions || [];
  $('#d-body').innerHTML = \`
    \${a.summary ? '<p>' + esc(a.summary) + '</p>' : ''}
    \${a.description ? '<p style="opacity:.75">' + esc(a.description).replace(/\\n/g,'<br>') + '</p>' : ''}
    <div class="row"><span class="k">来源</span><span class="perm">\${esc(a.source_type)} · \${esc(a.source_url)}</span></div>
    <div class="row"><span class="k">SHA-256</span><span class="perm">\${esc(a.sha256 || '（开发者未提供）')}</span></div>
    <div class="row"><span class="k">大小</span><span>\${a.size ? (a.size/1048576).toFixed(2) + ' MB' : '—'}</span></div>
    <div class="row" style="align-items:flex-start"><span class="k">权限</span><span class="perm">\${perms.length
      ? perms.map(p => '<div>' + esc(p) + '</div>').join('')
      : '<span style="opacity:.6">未申请任何能力</span>'}</span></div>
    \${perms.length ? '<p class="warn" style="font-size:12px;margin:12px 0 0">安装时这些能力会被逐条弹窗审批 —— 权限与上次不同会重新提示。</p>' : ''}
    \${a.homepage ? '<div class="row"><span class="k">主页</span><span><a href="' + esc(a.homepage) + '" target="_blank" rel="noopener">' + esc(a.homepage) + '</a></span></div>' : ''}
  \`;
  $('#dlg').showModal();
}

$('#d-close').onclick = () => $('#dlg').close();
$('#d-install').onclick = () => {
  if (!CUR) return;
  window.location.href = CUR.download_url || CUR.source_url;
};
$('#q').oninput = load;
$('#cat').onchange = load;
$('#refresh').onclick = load;
load();
</script>
</body>
</html>`;
