/**
 * D1 数据访问层。
 *
 * KV 的用法只有一个：缓存「全量应用索引」。
 * 它挡住 90% 的 D1 读 —— 商店是「读多写极少」的典型负载。
 */

const INDEX_KEY = 'index:v1';
const INDEX_TTL = 600;   // 10 分钟：规划里定的「10 分钟本地缓存」同源

export function parseJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

export async function listApps(env, { q, category, limit = 100, offset = 0 } = {}) {
  // 读缓存：一次 KV.get 顶掉一次 D1 查询
  let index = null;
  if (env.CACHE) {
    const hit = await env.CACHE.get(INDEX_KEY, 'json');
    if (hit && Array.isArray(hit.apps)) index = hit;
  }
  if (!index) {
    const { results } = await env.DB.prepare(
      `SELECT id, slug, name, summary, description, icon_url, screenshots, category, version,
              author, homepage, repo, license, permissions, sha256, meta_sha256, size,
              source_type, source_url, download_url, source_subdir, downloads, status, updated_at
         FROM apps WHERE status = 1 ORDER BY downloads DESC, updated_at DESC`
    ).all();
    // permissions / screenshots 在库里是 JSON 文本。
    // 出口就解成数组 —— 前端不该知道「这个字段原来是字符串」。
    // （踩过一次：前端拿 string 调 .map 直接崩。）
    index = { apps: (results || []).map(normalizeApp) };
    if (env.CACHE) {
      await env.CACHE.put(INDEX_KEY, JSON.stringify(index), { expirationTtl: INDEX_TTL });
    }
  }

  let apps = index.apps;
  if (category) apps = apps.filter(a => a.category === category);
  if (q) {
    const needle = q.toLowerCase();
    apps = apps.filter(a =>
      (a.name || '').toLowerCase().includes(needle) ||
      (a.summary || '').toLowerCase().includes(needle) ||
      (a.author || '').toLowerCase().includes(needle) ||
      (a.slug || '').toLowerCase().includes(needle)
    );
  }
  return { total: apps.length, apps: apps.slice(offset, offset + limit) };
}

/** 把库里的 JSON 文本字段解成真数组。已经是数组就原样返回。 */
export function normalizeApp(app) {
  if (!app) return app;
  return {
    ...app,
    permissions: parseJson(app.permissions, []),
    screenshots: parseJson(app.screenshots, []),
  };
}

export async function getAppBySlug(env, slug) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM apps WHERE slug = ? LIMIT 1`
  ).bind(slug).all();
  return (results && results[0]) || null;
}

export async function getApp(env, id) {
  const { results } = await env.DB.prepare(`SELECT * FROM apps WHERE id = ? LIMIT 1`).bind(id).all();
  return (results && results[0]) || null;
}

export async function upsertApp(env, app) {
  const now = new Date().toISOString();
  const id = app.id || app.slug;
  const perms = JSON.stringify(app.permissions || []);
  const shots = JSON.stringify(app.screenshots || []);

  await env.DB.prepare(
    `INSERT INTO apps
       (id, slug, name, summary, description, icon_url, screenshots, category, version,
        author, homepage, repo, license, permissions, sha256, meta_sha256, size,
        source_type, source_url, download_url, source_subdir, meta_url, manifest, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
     ON CONFLICT(slug) DO UPDATE SET
       name=excluded.name, summary=excluded.summary, description=excluded.description,
       icon_url=excluded.icon_url, screenshots=excluded.screenshots, category=excluded.category,
       version=excluded.version, author=excluded.author, homepage=excluded.homepage,
       repo=excluded.repo, license=excluded.license, permissions=excluded.permissions,
       sha256=excluded.sha256, meta_sha256=excluded.meta_sha256, size=excluded.size,
       source_type=excluded.source_type,
       source_url=excluded.source_url, download_url=excluded.download_url,
       source_subdir=excluded.source_subdir,
       meta_url=excluded.meta_url, manifest=excluded.manifest, status=1, updated_at=excluded.updated_at`
  ).bind(
    id, app.slug, app.name || app.slug, app.summary || '', app.description || '',
    app.icon_url || '', shots, app.category || 'other', app.version || '',
    app.author || '', app.homepage || '', app.repo || '', app.license || 'MIT',
    perms, app.sha256 || '', app.meta_sha256 || '', app.size || 0,
    app.source_type || 'url', app.source_url || '', app.download_url || app.source_url || '',
    app.source_subdir || '', app.meta_url || '', app.manifest || '', now, now
  ).run();

  await invalidate(env);
  return getAppBySlug(env, app.slug);
}

/** 死链下架 —— 只标记，不删。历史记录留着。 */
export async function markDead(env, slug, reason) {
  await env.DB.prepare(
    `UPDATE apps SET status = 0, dead_reason = ?, last_checked = ?, updated_at = ? WHERE slug = ?`
  ).bind(reason || '', new Date().toISOString(), new Date().toISOString(), slug).run();
  await invalidate(env);
}

export async function bumpDownload(env, slug, version, ua) {
  const row = await getAppBySlug(env, slug);
  if (!row) return null;
  await env.DB.prepare(`UPDATE apps SET downloads = downloads + 1 WHERE slug = ?`).bind(slug).run();
  await env.DB.prepare(
    `INSERT INTO downloads_log (app, version, ua) VALUES (?,?,?)`
  ).bind(slug, version || '', (ua || '').slice(0, 120)).run();
  // 下载数变化 → 索引缓存失效（KV 里存的是旧数字）
  await invalidate(env);
  return getAppBySlug(env, slug);
}

/** 缓存失效：开发者的「一键同步」必须「瞬间全网生效」 */
export async function invalidate(env) {
  if (env.CACHE) await env.CACHE.delete(INDEX_KEY);
}

export async function stats(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status=1 THEN 1 ELSE 0 END) AS alive,
            SUM(downloads) AS downloads
       FROM apps`
  ).first();
  return {
    total: row && row.total || 0,
    alive: row && row.alive || 0,
    downloads: row && row.downloads || 0,
  };
}
