/**
 * 开发者 API（api.user.rtcnnavext.de5.net）
 *
 * 工作流：
 *   1. 开发者写好代码，发版到 GitHub / npm / 自己的静态托管
 *   2. 登录商店后台，填个表单，点「一键同步」
 *   3. Worker 拉取最新 meta.json，写入 D1，清空 KV 缓存
 *   4. 瞬间全网生效
 *
 * 账号极简：用户名 + 密码，PBKDF2 派生值存 D1，会话 token 存 D1（可吊销）。
 * 不做第三方登录 —— 规划里要的是「零服务器成本」，加一个 OAuth 就多一份依赖和一份故障点。
 */

import { json, err, readJson, sha256Hex, tokenOf } from './http.js';
import { upsertApp, getAppBySlug, invalidate } from './db.js';
import { parseMeta, samePermissions } from './meta.js';

const SESSION_TTL = 30 * 24 * 3600;   // 30 天
// WebCrypto 的 PBKDF2 迭代上限是 100000 —— 超过会直接抛错。
// 用满上限，别再往上加。
const PBKDF2_ITER = 100000;

export async function handleUser(request, env, url, ctx) {
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization,x-runx-token',
      },
    });
  }

  try {
    // 注册
    if (path === '/api/user/register' && request.method === 'POST') {
      const body = await readJson(request);
      const name = String(body.name || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^[a-z0-9_.-]{3,32}$/.test(name)) {
        return err('bad_name', '用户名只能是小写字母、数字、_ . -，3 到 32 位', 400);
      }
      if (password.length < 8) return err('weak_password', '密码至少 8 位', 400);

      const exists = await env.DB.prepare(`SELECT id FROM developers WHERE name = ?`).bind(name).first();
      if (exists) return err('name_taken', '这个用户名已经被占了', 409);

      const id = 'dev_' + (await sha256Hex(name + ':' + Date.now())).slice(0, 16);
      await env.DB.prepare(
        `INSERT INTO developers (id, name, password_hash) VALUES (?,?,?)`
      ).bind(id, name, await hashPassword(password)).run();

      const token = await issueSession(env, name);
      return json({ ok: true, token, name });
    }

    // 登录
    if (path === '/api/user/login' && request.method === 'POST') {
      const body = await readJson(request);
      const name = String(body.name || '').trim().toLowerCase();
      const password = String(body.password || '');
      const row = await env.DB.prepare(`SELECT * FROM developers WHERE name = ?`).bind(name).first();
      // 无论用户不存在还是密码错，回同一个错 —— 别泄露「这个用户名存在」
      if (!row || !(await verifyPassword(password, row.password_hash))) {
        return err('bad_credentials', '用户名或密码不对', 401);
      }
      const token = await issueSession(env, name);
      return json({ ok: true, token, name });
    }

    // 登出（吊销当前 token）
    if (path === '/api/user/logout' && request.method === 'POST') {
      const body = await readJson(request);
      const token = tokenOf(request, body);
      if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
      return json({ ok: true });
    }

    // 我是谁
    if (path === '/api/user/me' && request.method === 'GET') {
      const token = tokenOf(request, null);
      const dev = await whoami(env, token);
      if (!dev) return err('unauthorized', '未登录或会话已过期', 401);
      return json({ ok: true, developer: { name: dev.name, id: dev.id } });
    }

    // 一键同步：拉 meta.json → 归一化 → 写 D1 → 清缓存
    if (path === '/api/user/sync' && request.method === 'POST') {
      const body = await readJson(request);
      const token = tokenOf(request, body);
      const dev = await whoami(env, token);
      if (!dev) return err('unauthorized', '未登录或会话已过期', 401);

      const metaUrl = String(body.meta_url || body.url || '').trim();
      if (!/^https?:\/\//.test(metaUrl)) {
        return err('bad_url', 'meta_url 必须是 http/https 地址', 400);
      }

      let text;
      try {
        const r = await fetch(metaUrl, { redirect: 'follow' });
        if (!r.ok) return err('upstream_failed', '拉取 meta.json 失败：HTTP ' + r.status, 502);
        text = await r.text();
      } catch (e) {
        return err('upstream_failed', '拉取 meta.json 失败：' + String(e && e.message || e), 502);
      }

      let meta;
      try {
        meta = parseMeta(text, metaUrl);
      } catch (e) {
        return err(e.code || 'bad_meta', e.message || 'meta.json 解析失败', 400);
      }

      // 已有应用：作者必须是同一个人（别人不能覆盖你的 slug）
      const old = await getAppBySlug(env, meta.slug);
      if (old && old.author && old.author !== dev.name) {
        return err('slug_taken', '这个 slug 已经属于 ' + old.author, 409);
      }

      const before = old ? safeJson(old.permissions) : [];
      meta.author = meta.author || dev.name;
      // meta.json 自身的哈希：开发者常常不提供包的 sha256，
      // 但前端缓存要比对「我看到的详情是不是最新的」—— meta 哈希正好干这个。
      meta.meta_sha256 = await sha256Hex(text);
      const app = await upsertApp(env, meta);

      return json({
        ok: true,
        app: {
          slug: app.slug, name: app.name, version: app.version,
          permissions: safeJson(app.permissions), downloads: app.downloads,
          updated_at: app.updated_at,
        },
        // 权限变了要告诉前端 —— 前端据此决定要不要重新弹 UAC
        permissions_changed: old ? !samePermissions(before, meta.permissions) : true,
        meta_sha256: meta.meta_sha256,
      });
    }

    // 我的应用列表
    if (path === '/api/user/apps' && request.method === 'GET') {
      const token = tokenOf(request, null);
      const dev = await whoami(env, token);
      if (!dev) return err('unauthorized', '未登录或会话已过期', 401);
      const { results } = await env.DB.prepare(
        `SELECT slug, name, version, summary, category, permissions, downloads, status, updated_at
           FROM apps WHERE author = ? ORDER BY updated_at DESC`
      ).bind(dev.name).all();
      return json({ ok: true, apps: results || [] });
    }

    // 下架自己的应用
    if (path === '/api/user/remove' && request.method === 'POST') {
      const body = await readJson(request);
      const token = tokenOf(request, body);
      const dev = await whoami(env, token);
      if (!dev) return err('unauthorized', '未登录或会话已过期', 401);
      const slug = String(body.slug || '');
      const app = await getAppBySlug(env, slug);
      if (!app) return err('not_found', '没有这个应用', 404);
      if (app.author !== dev.name) return err('forbidden', '这不是你的应用', 403);
      await env.DB.prepare(`UPDATE apps SET status = 0, updated_at = ? WHERE slug = ?`)
        .bind(new Date().toISOString(), slug).run();
      await invalidate(env);
      return json({ ok: true, action: 'delisted' });
    }

    return err('not_found', '没有这个接口', 404);
  } catch (e) {
    if (e && e.code === 'body_too_large') return err('body_too_large', '请求体太大', 413);
    if (e && e.code === 'bad_json') return err('bad_json', '请求体不是合法 JSON', 400);
    return json({ ok: false, error: 'internal', message: String(e && e.message || e) }, 500);
  }
}

/* ── 会话 ── */

async function issueSession(env, name) {
  const token = 'st_' + (await sha256Hex(name + ':' + Date.now() + ':' + Math.random())).slice(0, 40);
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL;
  await env.DB.prepare(
    `INSERT INTO sessions (token, developer, expires_at) VALUES (?,?,?)`
  ).bind(token, name, expires).run();
  // KV 也放一份：鉴权是热路径，少一次 D1 读
  if (env.CACHE) await env.CACHE.put('sess:' + token, name, { expirationTtl: SESSION_TTL });
  return token;
}

async function whoami(env, token) {
  if (!token) return null;
  // 先看 KV（热路径）
  if (env.CACHE) {
    const cached = await env.CACHE.get('sess:' + token);
    if (cached) {
      const row = await env.DB.prepare(`SELECT id, name FROM developers WHERE name = ?`).bind(cached).first();
      if (row) return row;
    }
  }
  const row = await env.DB.prepare(
    `SELECT d.id, d.name FROM sessions s JOIN developers d ON d.name = s.developer
      WHERE s.token = ? AND s.expires_at > ?`
  ).bind(token, Math.floor(Date.now() / 1000)).first();
  if (!row) return null;
  if (env.CACHE) await env.CACHE.put('sess:' + token, row.name, { expirationTtl: SESSION_TTL });
  return row;
}

/* ── 密码 ── */

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256
  );
  return `pbkdf2$sha256$${PBKDF2_ITER}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, hash, iterStr, saltB64, dkB64] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const salt = unb64(saltB64);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: Number(iterStr), hash: 'SHA-256' }, key, 256
    );
    const a = new Uint8Array(bits);
    const b = unb64(dkB64);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch {
    return false;
  }
}

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return []; }
}
