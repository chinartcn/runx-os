'use strict';

/**
 * session.js —— 跨扩展共享的「当前用户」句柄
 *
 * 账号归 @runx-rights-manager 管，但别的扩展也要知道「这次请求是谁」：
 * 桌面的布局要按用户分文件，supervisor 要记录应用是谁启动的。内核没有
 * 请求级上下文传递机制（每个扩展拿到的 ctx 是各自新建的），所以这里放一个
 * 进程内单例：rights-manager 在 onInit 里 attach，其他扩展按需 require。
 *
 * ── 这种耦合是不是违背了微内核 ──────────────────────────────────
 * 是耦合，但是**可选**耦合：require 失败或没有 attach 时，所有函数返回 null，
 * 调用方必须自己处理「没有用户概念」的情况（单用户模式）。删掉
 * @runx-rights-manager 之后，其余扩展照常工作，只是回到单用户。
 * 这和「探测 /runx/x11/status 是不是 404」是同一个思路：能力在运行时发现，
 * 不是编译期依赖。
 */

let accounts = null;
let fallback = null;   // 由 rights-manager 注入：本机回环访问 → 默认管理员

/**
 * 请求级上下文。
 *
 * 为什么用 AsyncLocalStorage 而不是「在 ctx 上挂个字段」：内核给每个扩展新建
 * 一份 ctx，扩展之间传不进去；而桌面那边的 load()/save() 埋得很深，一条
 * await 之后才调用，靠全局变量记录「当前是谁」在并发请求下必然串号。
 * AsyncLocalStorage 跟着 Promise 链走，正是为这种场景设计的（Node 12.17+）。
 */
let als = null;
try { als = new (require('async_hooks').AsyncLocalStorage)(); } catch { als = null; }

function attach(inst) {
  accounts = inst;
  return inst;
}

/** 在「当前请求属于谁」的上下文里执行 fn，返回值原样透出（含 Promise） */
function runWith(req, fn) {
  if (!als) return fn();
  return als.run({ req }, fn);
}

function currentRequest() {
  const store = als && als.getStore();
  return store ? store.req : null;
}

function isEnabled() { return !!accounts; }

/**
 * 从请求里解析登录用户。
 *
 * 顺序：Cookie → 兜底规则（本机回环视为机器主人）→ null。
 * 兜底规则由 rights-manager 注入，因为它才持有「回环免登录是否开启」的策略；
 * 这里只负责把结果统一成「谁」。桌面的 stateFile()、supervisor 记录应用归属
 * 都靠这个，所以回环用户在网页上没 Cookie 时也得认出是 alice 而不是「没人」。
 */
function userFromRequest(req) {
  if (!accounts) return null;
  try {
    const s = accounts.fromRequest(req);
    if (s) return s.user;
  } catch { /* 继续看兜底 */ }
  if (fallback) { try { return fallback(req) || null; } catch { return null; } }
  return null;
}

/** 注入兜底规则（传 null 取消） */
function setFallback(fn) { fallback = fn; }

/** 默认归属人：第一个管理员（应用开机自启、没经过任何请求时必须有个归属） */
function ownerUid() {
  if (!accounts) return null;
  const users = accounts.load().users;
  const u = users.find((x) => x.role === 'admin' && !x.disabled) || users[0];
  return u ? u.id : null;
}

function userOf(req) {
  const u = userFromRequest(req);
  if (u) return u;
  if (!accounts) return null;
  return accounts.load().users.find((x) => x.id === ownerUid()) || null;
}

/** 当前用户的私有状态目录（var/runx/users/<uid>/），没有用户时返回 null */
function stateDirOf(user) {
  if (!accounts || !user) return null;
  return accounts.stateDirOf(user.id);
}

/**
 * 按用户区分的状态文件名：有用户 → users/<uid>/<name>，否则 <name>
 *
 * 不传 req 时用 AsyncLocalStorage 里的当前请求 —— 调用方（比如桌面的
 * load()/save()）埋在若干次 await 之下，手边根本没有 req。
 */
function scopedStateFile(name, req) {
  const r = req || currentRequest();
  const u = r ? userFromRequest(r) : null;
  if (!accounts || !u) return name;
  return 'users/' + u.id + '/' + name;
}

module.exports = {
  attach, setFallback, isEnabled, runWith, currentRequest,
  userFromRequest, userOf, ownerUid, stateDirOf, scopedStateFile,
};
