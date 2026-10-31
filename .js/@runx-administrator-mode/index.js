'use strict';

/**
 * @runx-administrator-mode —— 有限期的提权票据
 *
 * ── 它解决的不是「给权限」，而是「给多久」 ──────────────────────
 * 高风险操作（写 /etc、读私钥、起子进程）确实有时候必须做。问题是「开了就
 * 一直开着」—— 用户点过一次「允许」，三个月后忘了，那台机器上所有应用都还
 * 在高危授权下跑。所以这里做的是一张**票据**：默认 30 分钟，到点自动作废，
 * 期间桌面顶上一直挂着红条，想忘都忘不掉。
 *
 * ── 谁说了算 ────────────────────────────────────────────────────
 * 票据文件 var/runx/admin.json 只由本扩展写；@runx-rights-manager 只读它
 * （判断高危操作要不要拦）。两个扩展之间没有函数调用、没有事件依赖，只有
 * 一份格式固定的文件 —— 删掉本扩展，rights-manager 读不到票据就等于「永远
 * 没开管理员模式」，高危操作一律拒绝，这是安全的方向。
 *
 * ── 双重确认在这里是什么 ────────────────────────────────────────
 * 1. 只有管理员账号能开（普通用户 403）；
 * 2. 必须填理由 + 勾选「我知道风险」+ 把确认词一字不差地打出来；
 * 3. 服务端校验确认词（由 challenge 接口下发，一次性），不是前端装样子。
 * 这不是防攻击者 —— 拿到管理员会话的人本来就赢了；它防的是**手滑**。
 *
 * REST：
 *   GET  /runx/admin/state       票据状态（桌面红条与 rights-manager 都读它）
 *   GET  /runx/admin/challenge   取一次性确认词
 *   POST /runx/admin/enable      {reason, confirm, phrase, token, minutes}
 *   POST /runx/admin/disable     {reason?}
 *   GET  /runx/admin/audit       最近的操作记录
 */

const crypto = require('crypto');

const API = '/runx/admin';

const DEFAULT_MINUTES = 30;
const MAX_MINUTES = 8 * 60;

let S = null;

function json(status, obj) {
  return { status, type: 'application/json; charset=utf-8', body: JSON.stringify(obj) };
}
function err(status, name, message, data) {
  return { status, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: { code: status, name, message, data: data || null } }) };
}

/** 会话模块是可选依赖：没有 @runx-rights-manager 时退回「只信本机」 */
let session = null;
try { session = require('../@runx-rights-manager/session'); } catch { session = null; }

function isLoopback(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

module.exports = {
  onInit(ctx) {
    const os = ctx.os;
    const log = (m) => { try { os.logAppend('admin', m); } catch { /* 忽略 */ } };

    // 一次性确认词：5 分钟有效，用过即废。放在内存里，重启后重新取 ——
    // 一张「重启还能用」的确认票据没有意义。
    let challenge = null;

    function read() {
      const t = os.readState('admin.json', null);
      if (!t || typeof t !== 'object') return { on: false };
      const on = !!t.on && Number(t.until) > Date.now();
      return Object.assign({}, t, { on, expired: !!t.on && !on });
    }

    function write(state) {
      os.writeState('admin.json', Object.assign({ schema: 1 }, state));
      return state;
    }

    /** 到点自动关：不依赖有人访问，定时器 + 读时兜底双保险 */
    function scheduleOff(until) {
      const ms = Math.max(0, until - Date.now());
      const t = setTimeout(() => {
        const cur = read();
        if (!cur.on) return;
        write({ on: false, until: 0, by: cur.by, by_name: cur.by_name, reason: cur.reason, off_at: Date.now(), off_reason: '到期自动关闭' });
        log(`管理员模式到期自动关闭（开启者 ${cur.by_name || cur.by}）`);
        publish('sys.admin.off', { reason: 'expired' });
      }, Math.min(ms, 0x7fffffff));
      if (t.unref) t.unref();
      return t;
    }

    function publish(event, payload) {
      try { os.bus.publish(event, 'admin', payload); } catch { /* 没桌面也不影响状态 */ }
    }

    function audit(uid, name, action, detail) {
      const line = `${name || uid || '?'} ${action}${detail ? '：' + detail : ''}`;
      log(line);
      const cur = os.readState('admin-audit.json', { schema: 1, entries: [] }) || { entries: [] };
      cur.entries.push({ at: Date.now(), by: uid || null, by_name: name || null, action, detail: detail || '' });
      if (cur.entries.length > 200) cur.entries = cur.entries.slice(-200);
      try { os.writeState('admin-audit.json', cur); } catch { /* 写不进就算了 */ }
    }

    /** 认出请求者是谁；没有账号体系时只认本机回环 */
    function who(req) {
      if (session && session.isEnabled && session.isEnabled()) {
        const u = session.userFromRequest(req);
        if (u) return { uid: u.id, name: u.name, role: u.role };
        // 回环 + 已登录免密的场景：session 里没 Cookie 但确实是本机主人
        if (isLoopback(req)) {
          const o = session.userOf(req);
          if (o) return { uid: o.id, name: o.name, role: o.role, via: 'loopback' };
        }
        return null;
      }
      if (isLoopback(req)) return { uid: null, name: 'local', role: 'admin', via: 'no-auth' };
      return null;
    }

    function canAdmin(req) {
      const u = who(req);
      if (!u) return { error: err(401, 'AUTH_REQUIRED', '需要登录') };
      if (u.role !== 'admin') return { error: err(403, 'NOT_ADMIN', '只有管理员能开启管理员模式') };
      return u;
    }

    // 启动时对齐一次：进程重启前留下的票据如果还没到期，继续生效并重新计时
    const cur = read();
    if (cur.on) scheduleOff(cur.until);

    S = { os, json, err, read, write, scheduleOff, publish, audit, who, canAdmin, log,
      getChallenge: () => challenge, setChallenge: (c) => { challenge = c; } };
  },

  onRequest(req, url, ctx) {
    if (!S) return undefined;
    const p = url.pathname;
    if (!p.startsWith(API)) return undefined;
    const method = req.method;

    if (method === 'GET' && p === API + '/state') {
      const st = S.read();
      return S.json(200, {
        on: st.on,
        until: st.on ? st.until : 0,
        remaining_ms: st.on ? Math.max(0, st.until - Date.now()) : 0,
        since: st.since || 0,
        by_name: st.by_name || null,
        reason: st.reason || '',
        expired: !!st.expired,
        default_minutes: 30,
        max_minutes: 480,
      });
    }

    if (method === 'GET' && p === API + '/challenge') {
      const c = S.canAdmin(req);
      if (c.error) return c.error;
      const phrase = '允许' + crypto.randomInt(100, 1000);
      const token = crypto.randomBytes(12).toString('hex');
      S.setChallenge({ token, phrase, uid: c.uid, exp: Date.now() + 5 * 60 * 1000 });
      return json(200, { token, phrase, expires_in: 300 });
    }

    if (method === 'POST' && p === API + '/enable') {
      const c = S.canAdmin(req);
      if (c.error) return c.error;
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        const ch = S.getChallenge();
        if (!ch || ch.token !== b.token || ch.uid !== c.uid || ch.exp < Date.now()) {
          return err(409, 'CHALLENGE_EXPIRED', '确认已过期，请重新确认');
        }
        if (String(b.phrase || '').trim() !== ch.phrase) {
          return err(422, 'PHRASE_MISMATCH', '确认词不对');
        }
        if (!b.confirm) return err(422, 'NOT_CONFIRMED', '必须勾选「我知道风险」');
        const reason = String(b.reason || '').trim();
        if (reason.length < 2) return err(422, 'NO_REASON', '写一句为什么需要它（至少 2 个字）');
        S.setChallenge(null);

        const minutes = Math.max(1, Math.min(MAX_MINUTES, Number(b.minutes) || DEFAULT_MINUTES));
        const until = Date.now() + minutes * 60000;
        const state = S.write({
          on: true, since: Date.now(), until, minutes,
          by: c.uid, by_name: c.name, reason,
        });
        S.scheduleOff(until);
        S.audit(c.uid, c.name, '开启管理员模式', `${minutes} 分钟 · ${reason}`);
        S.publish('sys.admin.on', { until, minutes, by: c.name, reason });
        return json(200, { on: true, until, minutes });
      });
    }

    if (method === 'POST' && p === API + '/disable') {
      const c = S.canAdmin(req);
      if (c.error) return c.error;
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        const cur = S.read();
        if (!cur.on) return json(200, { on: false });
        S.write({ on: false, until: 0, by: cur.by, by_name: cur.by_name, reason: cur.reason, off_at: Date.now(), off_reason: b.reason || '手动关闭' });
        S.audit(c.uid, c.name, '关闭管理员模式', b.reason || '');
        S.publish('sys.admin.off', { reason: 'manual', by: c.name });
        return json(200, { on: false });
      });
    }

    if (method === 'GET' && p === API + '/audit') {
      const c = S.canAdmin(req);
      if (c.error) return c.error;
      const f = S.os.readState('admin-audit.json', { entries: [] }) || { entries: [] };
      return json(200, { entries: f.entries.slice(-50).reverse() });
    }

    return undefined;
  },
};
