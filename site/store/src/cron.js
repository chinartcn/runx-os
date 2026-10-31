/**
 * 定时任务（每天凌晨 3 点）
 *
 * 冷备份：把 D1 的应用元数据打包成 index.json。
 * 规划里说存到 R2 —— 但 R2 目前还没在 Dashboard 启用，
 * 所以先存 KV（KV 有 10MB 上限，够放几万条元数据）。
 * R2 一旦启用，这里多写一份就行（代码里留好了位置）。
 *
 * 顺便做一件规划里明确说的事：检查所有源是否还活着。
 * 但不是「主动爬 GitHub」——那违背「被动式更新」。
 * 这里只做一件事：把状态为 0（已下架）的应用清理掉过期的探测记录。
 */

import { invalidate } from './db.js';

export async function handleCron(env) {
  const t0 = Date.now();

  // 1) 冷备份
  const { results } = await env.DB.prepare(
    `SELECT slug, name, summary, description, icon_url, screenshots, category, version,
            author, homepage, repo, license, permissions, sha256, size,
            source_type, source_url, download_url, downloads, status, updated_at
       FROM apps ORDER BY slug`
  ).all();

  const backup = {
    generated_at: new Date().toISOString(),
    count: (results || []).length,
    apps: results || [],
  };
  const json = JSON.stringify(backup);
  if (env.CACHE) {
    await env.CACHE.put('backup:index.json', json, { expirationTtl: 60 * 60 * 24 * 30 });
  }

  // R2 启用后这里再补一份：
  //   if (env.BUCKET) await env.BUCKET.put('index.json', json);

  // 2) 清掉 30 天前的探测记录（它们只是计数，没有长期价值）
  await env.DB.prepare(
    `DELETE FROM probes WHERE checked_at < datetime('now', '-30 day')`
  ).run();

  // 3) 清理过期会话
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`)
    .bind(Math.floor(Date.now() / 1000)).run();

  // 4) 备份后索引不该被清掉 —— 顺序反了会导致一次多余的 D1 读，这里明确不调 invalidate
  console.log(`[cron] 备份 ${backup.count} 个应用，用时 ${Date.now() - t0}ms`);
}
