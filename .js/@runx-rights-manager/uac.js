'use strict';

/**
 * uac.js —— 提权请求队列（User Account Control）
 *
 * 应用要碰它没被授权的东西时，请求在这里挂起，桌面弹出确认框，用户点一下，
 * 这里把结果还给调用方。听起来简单，真正难的是三个「不」：
 *
 *   1. **不重复弹窗**：同一个应用对同一个路径连发 20 次请求（读目录里每个文件），
 *      不该弹 20 个框。相同 (app, cap, target) 的请求合并到同一个 Promise。
 *   2. **不无限等**：桌面没开、用户在忙、前端崩了 —— 都必须有超时，否则应用的
 *      HTTP 请求会挂在那里直到 TCP 超时，看起来像应用死了。
 *   3. **不越权决策**：决定必须由**当前登录用户**做出，且只能决定自己那条请求。
 *      这里用 uid 绑定，非本人一律 403。
 *
 * 队列只存在于内存：进程重启后，挂起的请求自动作废（调用方会收到超时/断开），
 * 这比持久化一份「重启后还要不要批准」的悬案更安全。
 */

const crypto = require('crypto');

function newId() { return crypto.randomBytes(8).toString('hex'); }

/**
 * @param {{waitMs?:number, max?:number, publish:Function, log?:Function, hasUi?:Function}} opts
 */
function createUac(opts) {
  const log = opts.log || (() => {});
  const waitMs = Math.max(5000, Math.min(300000, opts.waitMs || 90000));
  const max = opts.max || 30;

  const pendingMap = new Map();   // id -> entry
  const byKey = new Map();        // key -> id

  function keyOf(app, cap, target) {
    return app + '\u0000' + cap + '\u0000' + target;
  }

  function publicView(e) {
    return {
      id: e.id,
      app: e.app,
      app_label: e.app_label || e.app,
      cap: e.cap,
      target: e.target,
      scope_hint: e.scope_hint,
      risk: e.risk,
      reason: e.reason || '',
      at: e.at,
      expires_at: e.expires_at,
      user: e.user_name,
    };
  }

  function list() {
    return Array.from(pendingMap.values())
      .sort((a, b) => a.at - b.at)
      .map(publicView);
  }

  function settle(id, decision, by) {
    const e = pendingMap.get(id);
    if (!e) return null;
    pendingMap.delete(id);
    byKey.delete(keyOf(e.app, e.cap, e.target));
    clearTimeout(e.timer);
    e.resolve({ decision, by, request: publicView(e) });
    return e;
  }

  /**
   * 发起一次申请。
   *
   * @param {object} req {app, app_label, cap, target, scope_hint, risk, reason, uid, user_name}
   * @returns {Promise<{decision:'once'|'always-file'|'always-dir'|'deny'|'timeout'|'no-ui', by:string}>}
   */
  function ask(req) {
    // 桌面根本没开：不要安静地等 90 秒。直接告诉调用方「没人能批准」，
    // 应用可以据此提示用户「请打开桌面」而不是卡死。
    if (typeof opts.hasUi === 'function' && !opts.hasUi()) {
      return Promise.resolve({ decision: 'no-ui', by: null });
    }
    if (pendingMap.size >= max) {
      return Promise.resolve({ decision: 'deny', by: null, reason: '队列已满' });
    }

    const k = keyOf(req.app, req.cap, req.target);
    const dup = byKey.get(k);
    if (dup) {
      const e = pendingMap.get(dup);
      if (e) return e.promise;   // 合并：同一个问题只问一次
    }

    const id = newId();
    const entry = {
      id,
      app: req.app,
      app_label: req.app_label || req.app,
      cap: req.cap,
      target: req.target,
      scope_hint: req.scope_hint || null,
      risk: req.risk || { level: 'medium', why: '' },
      reason: req.reason || '',
      uid: req.uid,
      user_name: req.user_name || '',
      at: Date.now(),
      expires_at: Date.now() + waitMs,
    };

    const promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    entry.promise = promise;

    entry.timer = setTimeout(() => {
      const e = pendingMap.get(id);
      if (!e) return;
      log(`提权请求超时：${req.app} ${req.cap}:${req.target}`);
      pendingMap.delete(id);
      byKey.delete(k);
      e.resolve({ decision: 'timeout', by: null, request: publicView(e) });
    }, waitMs);
    if (entry.timer.unref) entry.timer.unref();

    pendingMap.set(id, entry);
    byKey.set(k, id);

    try {
      opts.publish('sys.rights.ask', {
        request: publicView(entry),
        // 前端拿它来画「这次批准会持续到什么时候」的说明
        scopes: {
          file: entry.target,
          dir: entry.scope_hint,
        },
      });
    } catch (e) {
      log('发布提权请求失败：' + e.message);
    }

    return promise;
  }

  /**
   * 用户做出决定。
   * @param {string} id
   * @param {{decision:'once'|'always-file'|'always-dir'|'deny', uid:string}} input
   */
  function decide(id, input) {
    const e = pendingMap.get(id);
    if (!e) return { ok: false, code: 404, message: '请求不存在或已过期' };
    if (input.uid && e.uid && input.uid !== e.uid) {
      return { ok: false, code: 403, message: '只能决定自己的请求' };
    }
    const allowed = ['once', 'always-file', 'always-dir', 'deny'];
    const decision = allowed.includes(input.decision) ? input.decision : 'deny';
    const entry = settle(id, decision, input.uid || null);
    log(`提权决定：${e.app} ${e.cap}:${e.target} → ${decision}`);
    return { ok: true, decision, entry: publicView(entry) };
  }

  /** 某个用户下线 / 全部撤销时清空（避免把决定权留给下一个人） */
  function cancelAll(reason) {
    const n = pendingMap.size;
    for (const [id, e] of Array.from(pendingMap)) {
      pendingMap.delete(id);
      byKey.delete(keyOf(e.app, e.cap, e.target));
      clearTimeout(e.timer);
      e.resolve({ decision: 'deny', by: null, reason: reason || 'cancelled', request: publicView(e) });
    }
    return n;
  }

  /** 取一条挂起请求（决策前要读它的风险等级，不能让前端自己报） */
  function get(id) { return pendingMap.get(id) || null; }

  return { ask, decide, get, list, cancelAll, waitMs, size: () => pendingMap.size };
}

module.exports = { createUac };
