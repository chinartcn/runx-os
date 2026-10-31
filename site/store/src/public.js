/**
 * 公共 API（api.rtcnnavext.de5.net）
 *
 * 四层架构里的「边缘计算层」：智能网关。
 * 前端的所有请求都从这里过 —— 跨域、缓存、代理、校验都在这一层收口。
 */

import { json, err, readJson, sha256Hex } from './http.js';
import { listApps, getAppBySlug, bumpDownload, stats, markDead, normalizeApp } from './db.js';
import { parseMeta } from './meta.js';

/**
 * 代理池：外部包下载失败时，自动轮询各种 GitHub 镜像代理。
 *
 * 顺序有讲究：先直连 GitHub（最权威、最快），再退到镜像。
 * 全部失败时返回最后一个错误，并把「所有尝试」都列出来 ——
 * 用户自己能看出是网络问题还是仓库真没了。
 */
export function mirrorChain(env, url) {
  const raw = env.MIRRORS || '';
  const mirrors = raw.split(',').map(s => s.trim()).filter(Boolean);
  const chain = [];
  // 直连放最前
  chain.push(url);
  for (const m of mirrors) {
    // 代理前缀 + 去掉末尾斜杠
    chain.push(m.endsWith('/') ? m + url.replace(/^https?:\/\//, '') : m + url);
  }
  return chain;
}

export async function handlePublic(request, env, url, ctx) {
  const path = url.pathname;

  if (path === '/api/apps' && request.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const category = url.searchParams.get('category') || '';
    const limit = Math.min(Number(url.searchParams.get('limit') || 100) || 100, 500);
    const offset = Math.max(Number(url.searchParams.get('offset') || 0) || 0, 0);
    const data = await listApps(env, { q, category, limit, offset });
    return json({ ok: true, ...data, cached_ttl: 600 });
  }

  if (path.startsWith('/api/apps/') && request.method === 'GET') {
    const slug = decodeURIComponent(path.slice('/api/apps/'.length));
    const app = await getAppBySlug(env, slug);
    if (!app) return err('not_found', '没有这个应用', 404);
    return json({ ok: true, app: normalizeApp(app) });
  }

  // SHA 强校验：下载前必须问一次后端拿最新 SHA。
  // 前端拿本地 SHA 来比 —— 对不上就静默刷新详情页。
  if (path === '/api/verify' && request.method === 'POST') {
    let body;
    try { body = await readJson(request); } catch (e) { return err(e.code || 'bad_json', '请求体解析失败', 400); }
    const app = await getAppBySlug(env, String(body.slug || ''));
    if (!app) return err('not_found', '没有这个应用', 404);
    const local = String(body.sha256 || '').toLowerCase();
    // 包哈希优先；开发者没提供时退回 meta 哈希（前端缓存比的是这个）
    const remote = (String(app.sha256 || '') || String(app.meta_sha256 || '')).toLowerCase();
    const which = app.sha256 ? 'package' : 'meta';
    return json({
      ok: true,
      slug: app.slug,
      version: app.version,
      sha256: app.sha256,
      meta_sha256: app.meta_sha256,
      // 校验的是哪一个：package = 包文件，meta = 清单本身
      verified_against: which,
      // 三种结果：没有本地 SHA（首次）、一样（可下载）、变了（先刷权限再下载）
      match: !local || !remote ? null : local === remote,
      changed: !!(local && remote && local !== remote),
      permissions: safeJson(app.permissions, []),
      download_url: app.download_url || app.source_url,
      updated_at: app.updated_at,
    });
  }

  // 下载计数 + 拿下载链接
  if (path === '/api/download' && request.method === 'POST') {
    let body;
    try { body = await readJson(request); } catch (e) { return err(e.code || 'bad_json', '请求体解析失败', 400); }
    const slug = String(body.slug || '');
    const app = await getAppBySlug(env, slug);
    if (!app) return err('not_found', '没有这个应用', 404);
    const updated = await bumpDownload(env, slug, app.version, request.headers.get('user-agent') || '');
    return json({
      ok: true,
      downloads: updated ? updated.downloads : 0,
      download_url: app.download_url || app.source_url,
      sha256: app.sha256,
      permissions: safeJson(app.permissions, []),
    });
  }

  // 代理下载：源站 404 时自动轮询镜像。
  // 这是「被动式更新」的一部分 —— 商店不主动去爬 GitHub，只在用户真要下载时救场。
  if (path === '/api/proxy' && request.method === 'GET') {
    const target = url.searchParams.get('url') || '';
    if (!/^https?:\/\//.test(target)) return err('bad_url', '只接受 http/https', 400);
    const chain = mirrorChain(env, target);
    const tries = [];
    for (const candidate of chain) {
      try {
        const r = await fetch(candidate, { redirect: 'follow' });
        if (r.ok) {
          return new Response(r.body, {
            status: 200,
            headers: {
              'content-type': r.headers.get('content-type') || 'application/octet-stream',
              'x-runx-mirror': candidate,
              'x-runx-tries': String(tries.length),
              'access-control-allow-origin': '*',
            },
          });
        }
        tries.push({ url: candidate, status: r.status });
        // 404 是「这个源真没了」，不必再试后面的镜像
        if (r.status === 404) break;
      } catch (e) {
        tries.push({ url: candidate, error: String(e && e.message || e) });
      }
    }
    return json({
      ok: false,
      error: 'all_mirrors_failed',
      message: '所有源都试过了，还是不行',
      tries,
      // 把锅甩给大厂：GitHub 自己挂了就说 GitHub，别让用户以为是商店坏了
      blame: tries.length && tries.every(t => t.status === 404)
        ? '源仓库不存在或已删除'
        : '网络或上游服务异常（GitHub 抽风），稍后再试',
    }, 502);
  }

  // 死链探针：用户下载失败（404）时上报，Worker 去问 GitHub/Gitee API 核实。
  // 仓库真没了就下架；API 抽风了就只记一笔，不下架。
  if (path === '/api/report' && request.method === 'POST') {
    let body;
    try { body = await readJson(request); } catch (e) { return err(e.code || 'bad_json', '请求体解析失败', 400); }
    const slug = String(body.slug || '');
    const app = await getAppBySlug(env, slug);
    if (!app) return err('not_found', '没有这个应用', 404);

    const failUrl = String(body.url || app.source_url || '');
    const status = String(body.status || '404');
    const probe = await recordProbe(env, failUrl, status);

    // 连续失败 2 次才去问上游 —— 一次 404 可能是代理抖了一下
    if (probe.fails < 2) {
      return json({ ok: true, action: 'recorded', fails: probe.fails });
    }

    const verdict = await verifyUpstream(failUrl);
    if (verdict.dead) {
      await markDead(env, slug, verdict.reason);
      return json({ ok: true, action: 'delisted', reason: verdict.reason });
    }
    if (verdict.uncertain) {
      // 上游 API 自己抽风 —— 只记一笔，责任归大厂
      return json({ ok: true, action: 'deferred', message: '上游接口暂时不可用，稍后再试' });
    }
    return json({ ok: true, action: 'alive' });
  }

  if (path === '/api/stats' && request.method === 'GET') {
    return json({ ok: true, stats: await stats(env) });
  }

  // 手动同步一个 meta.json（公开也能用，但只写不发布的开发流程走 api.user.*）
  if (path === '/api/meta' && request.method === 'GET') {
    const metaUrl = url.searchParams.get('url') || '';
    if (!/^https?:\/\//.test(metaUrl)) return err('bad_url', '只接受 http/https', 400);
    try {
      const r = await fetch(metaUrl, { redirect: 'follow' });
      if (!r.ok) return err('upstream_failed', '拉取 meta.json 失败：' + r.status, 502);
      const text = await r.text();
      const parsed = parseMeta(text, metaUrl);
      return json({ ok: true, meta: parsed, sha256: await sha256Hex(text) });
    } catch (e) {
      return err('upstream_failed', '拉取 meta.json 失败：' + String(e && e.message || e), 502);
    }
  }

  return null;
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/** 记一笔失败。同一个 URL 连续失败 2 次才去问上游。 */
async function recordProbe(env, url, status) {
  if (!url) return { fails: 0 };
  await env.DB.prepare(
    `INSERT INTO probes (url, fails, last_status, checked_at) VALUES (?,1,?,?)
     ON CONFLICT(url) DO UPDATE SET
       fails = fails + 1, last_status = excluded.last_status, checked_at = excluded.checked_at`
  ).bind(url, status, new Date().toISOString()).run();
  const row = await env.DB.prepare(`SELECT fails FROM probes WHERE url = ?`).bind(url).first();
  return { fails: (row && row.fails) || 1 };
}

/**
 * 核实源仓库是否真的没了。
 *
 * GitHub 用 API（能区分「删了」和「私有了」），但 API 会限流：
 * 未认证的请求从 Worker 出去经常直接 403。
 * 所以策略是：API 说了算就用 API；API 抽风就退回 HEAD 请求 ——
 * HEAD 拿到 404 同样是「没了」，只是说不清是删除还是转私有。
 * 两者都失败时才叫「不确定」，那时不下架。
 */
async function verifyUpstream(url) {
  try {
    const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)/.exec(url);
    if (m) {
      const api = `https://api.github.com/repos/${m[1]}/${m[2]}`;
      try {
        const r = await fetch(api, {
          headers: { 'user-agent': 'runx-store', 'accept': 'application/vnd.github+json' },
        });
        if (r.status === 404) return { dead: true, reason: 'GitHub 仓库不存在或已删除' };
        if (r.ok) return { dead: false, reason: '仓库还在' };
        if (r.status !== 403 && r.status !== 429) {
          return { uncertain: true, reason: 'GitHub 返回 ' + r.status };
        }
        // 403 / 429 = 限流或需要认证 —— 退回 HEAD 再试一次
      } catch {
        // API 根本连不上 —— 同样退回 HEAD
      }

      const h = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      if (h.status === 404) return { dead: true, reason: '源地址返回 404' };
      if (h.ok) return { dead: false, reason: '仓库还在' };
      return { uncertain: true, reason: 'GitHub 返回 ' + h.status + '（API 限流）' };
    }

    const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (r.status === 404) return { dead: true, reason: '源地址返回 404' };
    if (r.ok) return { dead: false, reason: '源还在' };
    return { uncertain: true, reason: '源返回 ' + r.status };
  } catch (e) {
    return { uncertain: true, reason: String(e && e.message || e) };
  }
}
