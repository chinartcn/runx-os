'use strict';

/**
 * accounts.js —— RunX 的账号体系（多用户的地基）
 *
 * ── 为什么不直接用 Linux 用户 ────────────────────────────────────
 * 容器里通常只有一个 root；即便有多个用户，Node 进程也没法「以别人的身份」
 * 启动子进程而不付出 setuid / 重新挂载 home 的代价。而 RunX 需要的隔离是
 * **桌面状态与应用数据**的隔离，不是内核 UID 的隔离。所以这里自带一套账号，
 * 每个账号在 var/runx/users/<uid>/ 下有自己的一份状态。
 *
 * ── 存的是什么 ─────────────────────────────────────────────────
 * 永远不存明文，也不存可逆摘要。scrypt(password, salt) 存哈希；
 * 校验用 timingSafeEqual，避免按字节比较泄漏信息。
 *
 * ── 会话为什么不用服务端 session 表 ─────────────────────────────
 * 进程一重启，内存里的 session 表就没了 —— 用户正在拖窗口，服务端热重载了一下，
 * 桌面就退到登录页。这里用 **签名 Cookie**：uid.exp.hmac，密钥落在
 * var/runx/.secret（0600），重启后签名依旧有效。代价是「无法强制下线单个会话」，
 * 靠缩短过期时间 + 改密钥（全员下线）兜底 —— 对一个本地桌面来说够了。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE_NAME = 'runx_sid';
const SESSION_TTL = 30 * 24 * 3600 * 1000;   // 30 天
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function now() { return Date.now(); }

/** scrypt 走异步版本：同步版在 Termux 上会卡住事件循环 200ms 以上 */
function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (e, dk) => (e ? reject(e) : resolve(dk)));
  });
}

function rand(n) { return crypto.randomBytes(n); }

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    if (v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') v = v.slice(1, -1);
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

/**
 * @param {{dir:string, log?:Function}} opts  dir = var/runx
 */
function createAccounts(opts) {
  const dir = opts.dir;
  const log = opts.log || (() => {});
  const usersPath = path.join(dir, 'users.json');
  const secretPath = path.join(dir, '.session-secret');
  const stateDir = path.join(dir, 'users');

  let cache = null;        // { mtimeMs, data }
  let secret = null;

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
  }

  function readSecret() {
    if (secret) return secret;
    ensureDir();
    try {
      secret = fs.readFileSync(secretPath, 'utf8').trim();
      if (secret.length >= 32) return secret;
    } catch { /* 首次运行 */ }
    secret = rand(32).toString('hex');
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    try { fs.chmodSync(secretPath, 0o600); } catch { /* 某些文件系统不支持 */ }
    return secret;
  }

  function load() {
    ensureDir();
    let st = null;
    try { st = fs.statSync(usersPath); } catch { /* 还没有账号 */ }
    if (!st) return { schema: 1, users: [] };
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.data;
    let data = null;
    try { data = JSON.parse(fs.readFileSync(usersPath, 'utf8')); }
    catch (e) { log('users.json 解析失败，按空处理：' + e.message); data = null; }
    if (!data || data.schema !== 1 || !Array.isArray(data.users)) data = { schema: 1, users: [] };
    cache = { mtimeMs: st.mtimeMs, data };
    return data;
  }

  function save(data) {
    ensureDir();
    const tmp = usersPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, usersPath);
    try { fs.chmodSync(usersPath, 0o600); } catch { /* 忽略 */ }
    cache = null;
    return data;
  }

  async function hashPassword(password) {
    const salt = rand(16).toString('hex');
    const dk = await scryptAsync(String(password), salt, SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * 1024 * 1024 });
    return { algo: 'scrypt', salt, hash: dk.toString('hex'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
  }

  async function verifyPassword(user, password) {
    if (!user || !user.secret) return false;
    const s = user.secret;
    const dk = await scryptAsync(String(password), s.salt, s.hash.length / 2,
      { N: s.N || SCRYPT.N, r: s.r || SCRYPT.r, p: s.p || SCRYPT.p, maxmem: 128 * 1024 * 1024 });
    const a = Buffer.from(s.hash, 'hex');
    if (a.length !== dk.length) return false;
    return crypto.timingSafeEqual(a, dk);
  }

  function normalizeName(name) {
    return String(name || '').trim().toLowerCase();
  }

  function find(pred) { return load().users.find(pred) || null; }

  function getById(id) { return find((u) => u.id === id); }
  function getByName(name) {
    const n = normalizeName(name);
    return find((u) => u.name === n);
  }

  function publicUser(u) {
    if (!u) return null;
    return {
      id: u.id, name: u.name, role: u.role, created_at: u.created_at,
      last_login: u.last_login || null, disabled: !!u.disabled,
    };
  }

  function list() { return load().users.map(publicUser); }
  function count() { return load().users.length; }
  function hasAdmin() { return load().users.some((u) => u.role === 'admin' && !u.disabled); }

  /**
   * 建账号。caller 负责鉴权（首个用户 / 管理员）。
   * role 缺省 rule：第一个用户强制 admin —— 否则谁也进不来。
   */
  async function create(input) {
    const name = normalizeName(input.name);
    if (!/^[a-z0-9][a-z0-9_.-]{1,23}$/.test(name)) {
      throw Object.assign(new Error('用户名需 2–24 位，字母数字或 _ . -'), { code: 422 });
    }
    if (String(input.password || '').length < 6) {
      throw Object.assign(new Error('密码至少 6 位'), { code: 422 });
    }
    if (getByName(name)) throw Object.assign(new Error('用户名已存在'), { code: 409 });

    const data = load();
    const isFirst = data.users.length === 0;
    const user = {
      id: rand(6).toString('hex'),
      name,
      role: isFirst ? 'admin' : (input.role === 'admin' ? 'admin' : 'user'),
      secret: await hashPassword(input.password),
      created_at: now(),
      last_login: null,
      disabled: false,
    };
    data.users.push(user);
    save(data);
    fs.mkdirSync(path.join(stateDir, user.id), { recursive: true });
    log(`账号已创建：${name}（${user.role}）`);
    return publicUser(user);
  }

  async function setPassword(id, password) {
    if (String(password || '').length < 6) {
      throw Object.assign(new Error('密码至少 6 位'), { code: 422 });
    }
    const data = load();
    const u = data.users.find((x) => x.id === id);
    if (!u) throw Object.assign(new Error('账号不存在'), { code: 404 });
    u.secret = await hashPassword(password);
    u.pw_changed_at = now();
    save(data);
    return publicUser(u);
  }

  function patch(id, fields) {
    const data = load();
    const u = data.users.find((x) => x.id === id);
    if (!u) throw Object.assign(new Error('账号不存在'), { code: 404 });
    if (fields.role === 'admin' || fields.role === 'user') u.role = fields.role;
    if (typeof fields.disabled === 'boolean') u.disabled = fields.disabled;
    save(data);
    return publicUser(u);
  }

  function remove(id) {
    const data = load();
    const i = data.users.findIndex((x) => x.id === id);
    if (i < 0) throw Object.assign(new Error('账号不存在'), { code: 404 });
    const u = data.users[i];
    if (u.role === 'admin' && data.users.filter((x) => x.role === 'admin' && !x.disabled).length <= 1) {
      throw Object.assign(new Error('不能删除最后一个管理员'), { code: 409 });
    }
    data.users.splice(i, 1);
    save(data);
    // 只删状态目录里的账号私有数据；应用数据不在这里，不会误删
    try { fs.rmSync(path.join(stateDir, u.id), { recursive: true, force: true }); } catch { /* 忽略 */ }
    return true;
  }

  /* ── 会话：签名 Cookie ─────────────────────────────────────── */

  function sign(body) {
    return crypto.createHmac('sha256', readSecret()).update(body).digest('base64url');
  }

  function issue(user) {
    const exp = now() + SESSION_TTL;
    const body = user.id + '.' + exp;
    return body + '.' + sign(body);
  }

  /** @returns {{user:object, exp:number}|null} */
  function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [uid, expStr, mac] = parts;
    const body = uid + '.' + expStr;
    const expect = sign(body);
    const a = Buffer.from(mac);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < now()) return null;
    const u = getById(uid);
    if (!u || u.disabled) return null;
    return { user: u, exp };
  }

  /** 从请求里认人：优先 Cookie */
  function fromRequest(req) {
    const c = parseCookies(req && req.headers && req.headers.cookie);
    return verifyToken(c[COOKIE_NAME]);
  }

  function cookieHeader(token, opts) {
    const o = opts || {};
    const maxAge = Math.floor((o.maxAge != null ? o.maxAge : SESSION_TTL) / 1000);
    return COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge;
  }
  function clearCookie() {
    return COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
  }

  function touchLogin(id) {
    const data = load();
    const u = data.users.find((x) => x.id === id);
    if (!u) return;
    u.last_login = now();
    save(data);
  }

  function stateDirOf(id) { return path.join(stateDir, id); }

  return {
    COOKIE_NAME, SESSION_TTL,
    load, save, list, count, hasAdmin, publicUser,
    getById, getByName, create, setPassword, patch, remove,
    verifyPassword, issue, verifyToken, fromRequest, cookieHeader, clearCookie, touchLogin,
    stateDirOf, dir,
  };
}

module.exports = { createAccounts, parseCookies, COOKIE_NAME, SESSION_TTL };
