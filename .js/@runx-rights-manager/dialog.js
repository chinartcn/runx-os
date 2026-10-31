'use strict';

/**
 * dialog.js —— 「让用户在桌面上回答一个问题」
 *
 * ── 它和 uac.js 的区别 ──────────────────────────────────────────
 * uac 的问题是**是非题**（允许 / 拒绝），答案是枚举里的一个。这里的答案是
 * **数据**：用户挑中的路径、输入的保存文件名、点的是「确定」还是「取消」。
 * 两者共用同一根管道（内核 → 事件总线 → 桌面弹框 → HTTP 回填），但结果类型
 * 不同，硬塞进 uac 会让两边都别扭。
 *
 * ── 一道安全关：应用不能指定路径 ────────────────────────────────
 * 文件对话框的价值在于「路径由用户选」。如果应用能传 `startIn: '/root/.ssh'`
 * 并且用户只是顺手点了一下确定，那这个框就成了摆设。所以：
 *   · `startIn` 只能是应用自己的沙箱或用户主目录，其他值一律忽略；
 *   · 应用不能预设已选中的文件（没有 `defaultPath` 之于 open 模式）；
 *   · 过滤只影响**显示**，不构成安全边界 —— 用户随时可以切到「所有文件」，
 *     所以拿到路径之后仍然要走 fs.read / fs.write 的授权（或由 broker 记一条
 *     「本次选择」的授权，见 broker.dialog）。
 *
 * ── 超时 ───────────────────────────────────────────────────────
 * 挑文件比点「允许」慢得多，所以默认给 180 秒。超时 = 取消（返回 cancelled），
 * 不抛错 —— 用户走开了不是异常。
 */

const crypto = require('crypto');
const path = require('path');

function newId() { return crypto.randomBytes(8).toString('hex'); }

const KINDS = ['open', 'save', 'message'];

/**
 * @param {{waitMs?:number, max?:number, publish:Function, log?:Function, hasUi?:Function, roots:Function}} opts
 */
function createDialog(opts) {
  const log = opts.log || (() => {});
  const waitMs = Math.max(10000, Math.min(600000, opts.waitMs || 180000));
  const max = opts.max || 8;

  const pending = new Map();

  function publicView(e) {
    return {
      id: e.id,
      kind: e.kind,
      app: e.app,
      app_label: e.app_label || e.app,
      title: e.title || '',
      message: e.message || '',
      options: e.options || {},
      user: e.user_name || '',
      at: e.at,
      expires_at: e.expires_at,
    };
  }

  function list() { return Array.from(pending.values()).sort((a, b) => a.at - b.at).map(publicView); }
  function get(id) { return pending.get(id) || null; }

  function settle(id, result) {
    const e = pending.get(id);
    if (!e) return null;
    pending.delete(id);
    clearTimeout(e.timer);
    e.resolve(result);
    return e;
  }

  /**
   * 发起一次询问。
   * @param {{kind:string, app:string, app_label?:string, uid:string, user_name?:string,
   *          title?:string, message?:string, options?:object}} req
   * @returns {Promise<{cancelled:boolean, via?:string, paths?:string[], path?:string, value?:any}>}
   */
  function open(req) {
    const kind = KINDS.includes(req.kind) ? req.kind : 'open';

    if (typeof opts.hasUi === 'function' && !opts.hasUi()) {
      return Promise.resolve({ cancelled: true, via: 'no-ui' });
    }
    if (pending.size >= max) {
      return Promise.resolve({ cancelled: true, via: 'busy' });
    }
    // 同一应用同时只允许一个：否则它可以连开 8 个框，把整个桌面变成它的
    // 文件选择器。已在等的那一个不受影响（应用应复用同一次调用）。
    for (const e of pending.values()) {
      if (e.app === req.app) return Promise.resolve({ cancelled: true, via: 'busy' });
    }

    const o = Object.assign({}, req.options || {});
    // startIn 白名单：应用只能把用户送到自己家或自己的沙箱，别的地方不认
    const allowed = (opts.roots ? opts.roots(req.app) : []).filter(Boolean).map((p) => path.resolve(p));
    let startIn = o.startIn ? path.resolve(String(o.startIn)) : (allowed[0] || '');
    if (startIn && !allowed.some((a) => startIn === a || startIn.indexOf(a + '/') === 0)) {
      startIn = allowed[0] || '';
    }

    const id = newId();
    const entry = {
      id, kind,
      app: req.app,
      app_label: req.app_label || req.app,
      uid: req.uid,
      user_name: req.user_name || '',
      title: String(req.title || ''),
      message: String(req.message || ''),
      options: {
        startIn,
        filters: Array.isArray(o.filters) ? o.filters.map((f) => String(f).slice(0, 24)).slice(0, 12) : [],
        multiple: kind === 'open' && !!o.multiple,
        defaultName: kind === 'save' ? String(o.defaultName || '').replace(/[/\\]/g, '').slice(0, 120) : '',
        buttons: kind === 'message' ? normalizeButtons(o.buttons) : [],
      },
      at: Date.now(),
      expires_at: Date.now() + waitMs,
    };

    const promise = new Promise((resolve) => { entry.resolve = resolve; });
    entry.timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      log(`对话框超时：${entry.app} ${kind}`);
      entry.resolve({ cancelled: true, via: 'timeout' });
    }, waitMs);
    if (entry.timer.unref) entry.timer.unref();

    pending.set(id, entry);

    try {
      opts.publish('sys.dialog.open', { request: publicView(entry), wait_ms: waitMs });
    } catch (e) {
      log('发布对话框失败：' + e.message);
    }
    log(`对话框：${entry.app} ${kind}${entry.options.startIn ? ' in ' + entry.options.startIn : ''}`);
    return promise;
  }

  /** message 对话框的按钮：`[{id:'ok', label:'确定', kind:'primary'}]`，默认「确定 / 取消」 */
  function normalizeButtons(btns) {
    if (!Array.isArray(btns) || !btns.length) {
      return [{ id: 'ok', label: '确定', kind: 'primary' }, { id: 'cancel', label: '取消', kind: '' }];
    }
    return btns.slice(0, 4).map((b, i) => ({
      id: String(b.id || (i === 0 ? 'ok' : 'btn' + i)).slice(0, 32),
      label: String(b.label || '确定').slice(0, 40),
      kind: ['primary', 'danger', ''].includes(b.kind) ? b.kind : '',
    }));
  }

  /**
   * 用户做出了回答。
   * @param {string} id
   * @param {{uid:string, cancelled?:boolean, paths?:string[], path?:string, value?:any}} ans
   */
  function answer(id, ans) {
    const e = get(id);
    if (!e) return { ok: false, code: 404, message: '对话框不存在或已过期' };
    if (ans.uid && e.uid && ans.uid !== e.uid) {
      return { ok: false, code: 403, message: '只能回答自己的对话框' };
    }
    if (ans.cancelled) {
      settle(id, { cancelled: true, via: 'user' });
      log(`对话框取消：${e.app} ${e.kind}`);
      return { ok: true, cancelled: true };
    }

    if (e.kind === 'message') {
      const value = ans.value === undefined ? 'ok' : ans.value;
      settle(id, { cancelled: false, via: 'user', value });
      return { ok: true, value };
    }

    const paths = (Array.isArray(ans.paths) ? ans.paths : (ans.path ? [ans.path] : []))
      .filter((p) => typeof p === 'string' && p.startsWith('/'))
      .slice(0, e.options.multiple ? 32 : 1);
    if (!paths.length) return { ok: false, code: 422, message: '没有选择任何文件' };

    // 保存框允许一个还不存在的路径 —— 这正是它的用途
    if (e.kind === 'save') {
      settle(id, { cancelled: false, via: 'user', path: paths[0], paths: [paths[0]] });
      return { ok: true, path: paths[0] };
    }
    settle(id, { cancelled: false, via: 'user', path: paths[0], paths });
    log(`用户选择：${e.app} ${paths.join(', ')}`);
    return { ok: true, paths };
  }

  /** 用户下线 / 桌面关闭时统一收尾：不能把「选了什么」留给下一个人 */
  function cancelAll(reason) {
    const n = pending.size;
    for (const [id, e] of Array.from(pending)) {
      pending.delete(id);
      clearTimeout(e.timer);
      e.resolve({ cancelled: true, via: reason || 'cancelled' });
    }
    return n;
  }

  return { open, answer, list, get, cancelAll, waitMs, size: () => pending.size, kinds: KINDS };
}

module.exports = { createDialog, KINDS };
