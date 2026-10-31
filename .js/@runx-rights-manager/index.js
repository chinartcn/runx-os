'use strict';

/**
 * @runx-rights-manager —— 账号、授权、UAC、风险拦截
 *
 * ── 它解决的是「谁在让谁干什么」 ────────────────────────────────
 * 一个跑在 RunX 里的 Node 应用，默认拥有和内核一样的权限：能读 ~/.ssh、
 * 能写 /etc、能起子进程。桌面把它当窗口看，操作系统可不管它是谁。这个扩展
 * 在两者之间插一层：
 *
 *     应用 → /runx/sdk/*（带令牌）→ 认人 → 查权 → 不够就问人 → 执行
 *
 * ── 四个职责，一条链路 ──────────────────────────────────────────
 *   账号    谁在用这台机器（scrypt + 签名 Cookie，见 accounts.js）
 *   授权    某个应用允许做什么（能力 + 作用域，见 grants.js）
 *   审批    现在要不要允许（挂起 → 桌面弹框 → 决策，见 uac.js）
 *   拦截    高危操作必须先开管理员模式（@runx-administrator-mode 的票据）
 *
 * ── 多用户是怎么隔离的 ─────────────────────────────────────────
 * 每个用户在 var/runx/users/<uid>/ 下有自己的一份状态：授权表、应用启动者
 * 记录。桌面布局也按用户分文件（@runx-desktop 通过 session 模块拿当前用户）。
 * 应用进程仍然是同一批进程 —— 隔离的是「谁批准了什么」，不是内核 UID。
 *
 * ── 它不可能做到的事（写在这里，免得以为是 bug）─────────────────
 * 应用要是绕过 SDK 直接 require('fs') 读文件，这一层看不见。真正的强制力
 * 来自 @runx-node-safety 给进程加的 --permission 围栏；两者是「围栏 + 审批」
 * 的关系：围栏决定物理边界，审批决定围栏之内每一次调用的取舍。
 */

const path = require('path');
const fs = require('fs');

const { createAccounts } = require('./accounts');
const { createGrants, CAPS, assess } = require('./grants');
const { createUac } = require('./uac');
const { createDialog } = require('./dialog');
const { createClipboard } = require('./clipboard');
const { createBroker } = require('./broker');
const session = require('./session');

const API = '/runx';

// 模块级单例：onInit 填充，onRequest 直接取用（扩展在进程内只加载一次）
let S = null;

/* 未登录也放行的路径：登录接口本身、CSS/字体、字体资源、健康检查 */
const OPEN_PREFIX = [
  API + '/auth/',
  API + '/desktop-assets/',
  // 组件库的 CSS/JS/字体：应用页面在自己的源里引，不带 Cookie（SameSite=Lax），
  // 要求登录的结果是「样式偶尔加载失败」。它们不含任何数据。
  API + '/ui/',
  API + '/rights/rules',
  '/favicon.ico',
];

function json(status, obj, headers) {
  return {
    status,
    type: 'application/json; charset=utf-8',
    headers: headers || {},
    body: JSON.stringify(obj),
  };
}
function err(status, name, message, data) {
  return {
    status,
    type: 'application/json; charset=utf-8',
    body: JSON.stringify({ error: { code: status, name, message, data: data || null } }),
  };
}

function isLoopback(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * 极简登录页。
 *
 * 为什么不复用桌面的登录弹窗：桌面本身要走 /runx/desktop 才能渲染，未登录时
 * 那个请求是 401 —— 先有鸡还是先有蛋。服务端直接吐一张自包含的页面最稳，
 * 不依赖任何前端脚本，也不怕 JS 挂了。
 */
function loginPage(next, error) {
  const action = API + '/auth/login';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>登录 · RunX</title><style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
  font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC","Segoe UI",system-ui,sans-serif;
  background:radial-gradient(120% 100% at 20% 0%,#1b2440 0%,#0b0f19 60%);
  color:#e8ecf5;-webkit-font-smoothing:antialiased}
.card{width:min(380px,100%);padding:28px 26px 24px;border-radius:18px;
  background:rgba(22,26,38,.72);border:1px solid rgba(255,255,255,.1);
  box-shadow:0 24px 60px rgba(0,0,0,.45);backdrop-filter:blur(24px) saturate(1.6)}
.logo{font-size:22px;font-weight:650;letter-spacing:.3px;margin:0 0 4px}
.sub{margin:0 0 20px;font-size:13px;color:#93a0b8}
label{display:block;font-size:12px;color:#93a0b8;margin:14px 0 6px}
input{width:100%;padding:11px 13px;border-radius:11px;border:1px solid rgba(255,255,255,.14);
  background:rgba(0,0,0,.28);color:#fff;font-size:15px;outline:none}
input:focus{border-color:#7c5cff;box-shadow:0 0 0 3px rgba(124,92,255,.22)}
button{width:100%;margin-top:20px;padding:12px;border:0;border-radius:11px;cursor:pointer;
  background:#7c5cff;color:#fff;font-size:15px;font-weight:600}
button:active{transform:scale(.99)}
.err{margin:0 0 6px;padding:9px 11px;border-radius:9px;font-size:13px;
  background:rgba(255,80,80,.14);border:1px solid rgba(255,80,80,.3);color:#ffb4b4}
.foot{margin-top:16px;font-size:12px;color:#6f7b91;text-align:center}
.foot code{display:inline-block;margin-top:4px;font-size:11.5px;word-break:break-all;color:#8b96ad}
</style></head>
<body>
<form class="card" method="post" action="${esc(action)}">
  <h1 class="logo">RunX</h1>
  <p class="sub">这台机器需要登录后使用</p>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <input type="hidden" name="next" value="${esc(next || '/')}">
  <label for="u">用户名</label>
  <input id="u" name="name" autocomplete="username" autocapitalize="none" required autofocus>
  <label for="p">密码</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">登录</button>
  <p class="foot">忘记密码：在服务器终端执行<br><code>node .js/@runx-rights-manager/cli.js passwd &lt;用户名&gt;</code></p>
</form>
</body></html>`;
}

module.exports = {
  onInit(ctx) {
    const os = ctx.os;
    const root = ctx.root;
    const stateDir = path.join(root, 'var', 'runx');
    const log = (m) => { try { os.logAppend('rights', m); } catch { /* 落盘失败不影响主流程 */ } };

    const accounts = createAccounts({ dir: stateDir, log });
    session.attach(accounts);

    const grants = createGrants({ dir: stateDir, log });

    /* 默认「回环即管理员」：桌面上就是本机浏览器，让用户每次开桌面都登录一遍
       是纯折磨。局域网访问仍然要登录。环境变量可关掉，用于测试多用户。 */
    const loopbackAdmin = process.env.RUNX_AUTH_NO_LOOPBACK !== '1';

    // 告诉其它扩展「本机回环是谁」：桌面的 per-user 布局、supervisor 记录应用
    // 归属都依赖它。没有这一步，回环访问在别人眼里就是「没有用户」。
    session.setFallback((req) => {
      if (!loopbackAdmin || !req || !isLoopback(req)) return null;
      const users = accounts.load().users;
      return users.find((u) => u.role === 'admin' && !u.disabled) || users[0] || null;
    });

    const adminStateOf = () => {
      const t = os.readState('admin.json', null) || {};
      const on = !!t.on && Number(t.until) > Date.now();
      return { on, until: t.until || 0, by: t.by || null, reason: t.reason || '' };
    };

    function appEntry(name) {
      const f = os.readState('apps.json', { apps: [] }) || { apps: [] };
      return (f.apps || []).find((a) => a.name === name) || null;
    }

    function resolveApp(token) {
      if (!token || typeof token !== 'string') return null;
      const tokens = os.readState('host-tokens.json', {}) || {};
      for (const [name, t] of Object.entries(tokens)) {
        if (t === token) {
          const e = appEntry(name);
          return {
            name,
            label: (e && (e.display_name || e.name)) || name,
            cwd: (e && e.cwd) || path.join(root, 'apps', name),
            sandbox: {
              cwd: (e && e.cwd) || path.join(root, 'apps', name),
              data: path.join((e && e.cwd) || path.join(root, 'apps', name), (e && e.data_dir) || 'data'),
            },
          };
        }
      }
      return null;
    }

    /** 应用属于启动它的那个用户 —— 谁开的应用，用谁的授权 */
    function appOwner(name) {
      const owners = os.readState('app-owners.json', {}) || {};
      if (owners[name]) return owners[name];
      const users = accounts.load().users;
      const admin = users.find((u) => u.role === 'admin' && !u.disabled) || users[0];
      return admin ? admin.id : null;
    }

    const uac = createUac({
      waitMs: Number(process.env.RUNX_UAC_TIMEOUT) || 90000,
      log,
      // 直接走内核 WS 广播：不依赖 @runx-event-bus 是否加载，也不自己发 HTTP
      publish: (event, payload) => os.bus.publish(event, 'rights', payload),
      hasUi: () => os.bus.clients() > 0,
    });

    /* 剪贴板：内核里的一份共享文本缓冲区，桌面尽力与系统剪贴板同步 */
    const clipboard = createClipboard({ dir: stateDir, log });

    /* 对话框：文件选择 / 保存 / 普通提问。答案不是枚举，所以不进 uac。 */
    const dialog = createDialog({
      waitMs: Number(process.env.RUNX_DIALOG_TIMEOUT) || 180000,
      log,
      publish: (event, payload) => os.bus.publish(event, 'rights', payload),
      hasUi: () => os.bus.clients() > 0,
      // startIn 白名单：应用只能把用户送到自己家或自己的沙箱
      roots: (name) => {
        const e = appEntry(name);
        const cwd = (e && e.cwd) || path.join(root, 'apps', name);
        return [path.join(cwd, (e && e.data_dir) || 'data'), cwd, require('os').homedir()];
      },
    });

    const broker = createBroker({
      root, log, grants, uac, dialog, clipboard,
      resolveApp,
      adminOn: () => adminStateOf().on,
      sandboxOf: (name) => {
        const e = appEntry(name);
        const cwd = (e && e.cwd) || path.join(root, 'apps', name);
        return { cwd, data: path.join(cwd, (e && e.data_dir) || 'data') };
      },
    });

    /* ── 会话解析 ─────────────────────────────────────────────── */

    function currentUser(req) {
      const s = accounts.fromRequest(req);
      if (s) return { user: s.user, via: 'cookie' };
      if (loopbackAdmin && isLoopback(req)) {
        const users = accounts.load().users;
        const owner = users.find((u) => u.role === 'admin' && !u.disabled) || users[0];
        if (owner) return { user: owner, via: 'loopback' };
      }
      return null;
    }

    function requireAdmin(req) {
      const c = currentUser(req);
      if (!c) return { error: err(401, 'AUTH_REQUIRED', '需要登录') };
      if (c.user.role !== 'admin') return { error: err(403, 'NOT_ADMIN', '需要管理员权限') };
      return c;
    }

    /* ── 审计（内存环形 + 落盘） ─────────────────────────────── */

    const audit = [];
    function note(line) {
      const rec = { at: Date.now(), line };
      audit.push(rec);
      if (audit.length > 500) audit.shift();
      log(line);
    }

    /* 应用停止时收拾它的 watch：idle 回收是兜底，这里才是正路 —— 一个崩掉
       的应用不该继续占着内核的 watch 句柄到五分钟。 */
    try {
      os.ipc.on('app:stopped', (name) => {
        const n = broker.releaseApp(name);
        if (n) log(`应用停止，关闭 ${n} 个 watch：${name}`);
      });
    } catch { /* 没有 ipc 通道就算了，idle 会兜住 */ }

    S = {
      accounts, grants, uac, dialog, clipboard, broker, currentUser, requireAdmin, loginPage,
      publish: (event, payload) => os.bus.publish(event, 'rights', payload),
      adminStateOf, appOwner, note, audit, loopbackAdmin, resolveApp,
      json, err, stateDir,
    };
  },

  onRequest(req, url, ctx) {
    if (!S) return undefined;
    const p = url.pathname;
    const method = req.method;
    const A = S.accounts;

    /* SDK 网关与账号接口都在 /runx 下，其余路径交给后面的扩展 */
    const isAuth = p.startsWith(API + '/auth/');
    const isSdk = p.startsWith(API + '/sdk/');
    const isRights = p.startsWith(API + '/rights/');

    /* ── 登录闸门 ──
     *
     * 放在最前面，且对**所有**路径生效：NavExt 的静态路由会把 .js/ 之外的
     * 项目文件直接吐出去，只挡住 API 等于「门锁了但墙是纸糊的」。
     *
     * 三种放行：① 账号还没建（首次运行，桌面里会引导创建，此时谁都进得来，
     * 所以文档要求先在终端跑 cli.js add 再暴露到局域网）；② 已在白名单里；
     * ③ 已登录 / 本机回环且开着免登录。
     */
    const open = OPEN_PREFIX.some((pfx) => p.startsWith(pfx));
    if (!open && A.count() > 0) {
      if (!S.currentUser(req)) {
        const wantsHtml = String(req.headers.accept || '').indexOf('text/html') >= 0;
        const next = (url.pathname || '/') + (url.search || '');
        if (wantsHtml && method === 'GET') {
          return {
            status: 401,
            type: 'text/html; charset=utf-8',
            body: S.loginPage(next, ''),
          };
        }
        return S.err(401, 'AUTH_REQUIRED', '需要登录');
      }
    }

    if (!isAuth && !isSdk && !isRights) return undefined;

    /* ═══ 账号 ═══ */

    if (method === 'GET' && p === API + '/auth/status') {
      const c = S.currentUser(req);
      const users = A.list();
      return S.json(200, {
        enabled: true,
        setup_required: users.length === 0,
        users_count: users.length,
        authenticated: !!c,
        user: c ? A.publicUser(c.user) : null,
        via: c ? c.via : null,
        loopback_admin: S.loopbackAdmin,
        is_loopback: isLoopback(req),
        admin_mode: S.adminStateOf(),
      });
    }

    if (method === 'POST' && p === API + '/auth/setup') {
      if (A.count() > 0) return S.err(409, 'ALREADY_SETUP', '已经初始化过了');
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then(async (b) => {
        try {
          const u = await A.create({ name: b.name, password: b.password, role: 'admin' });
          const user = A.getById(u.id);
          S.note(`初始化管理员账号：${u.name}`);
          return S.json(200, { user: u, token: 'cookie' }, {
            'Set-Cookie': A.cookieHeader(A.issue(user)),
          });
        } catch (e) {
          return S.err(e.code || 500, 'SETUP_FAILED', e.message);
        }
      });
    }

    if (method === 'POST' && p === API + '/auth/login') {
      const wantsHtml = String(req.headers.accept || '').indexOf('text/html') >= 0
        || String(req.headers['content-type'] || '').indexOf('application/x-www-form-urlencoded') >= 0;
      return Promise.resolve(
        wantsHtml ? readForm(ctx) : ctx.readJson().catch(() => ({}))
      ).then(async (b) => {
        const u = A.getByName(b.name);
        const ok = u && !u.disabled && await A.verifyPassword(u, b.password || '');
        if (!ok) {
          S.note(`登录失败：${b.name || '(空)'} from ${req.socket && req.socket.remoteAddress}`);
          if (wantsHtml) {
            return {
              status: 401, type: 'text/html; charset=utf-8',
              headers: { 'Set-Cookie': A.clearCookie() },
              body: S.loginPage(b.next || '/', '用户名或密码不对'),
            };
          }
          return S.err(401, 'BAD_CREDENTIALS', '用户名或密码不对');
        }
        A.touchLogin(u.id);
        S.note(`登录：${u.name} from ${req.socket && req.socket.remoteAddress}`);
        const cookie = A.cookieHeader(A.issue(u));
        if (wantsHtml) {
          const next = String(b.next || '/');
          // 只允许站内跳转：`next=//evil.com` 是开放重定向
          const safe = next.startsWith('/') && !next.startsWith('//') ? next : '/';
          return { status: 303, type: 'text/html; charset=utf-8', headers: { 'Set-Cookie': cookie, Location: safe }, body: '' };
        }
        return S.json(200, { user: A.publicUser(u), via: 'cookie' }, { 'Set-Cookie': cookie });
      });
    }

    if (method === 'POST' && p === API + '/auth/logout') {
      S.uac.cancelAll('logout');
      S.dialog.cancelAll('logout');
      return S.json(200, { ok: true }, { 'Set-Cookie': A.clearCookie() });
    }

    if (p === API + '/auth/users' || p.startsWith(API + '/auth/users/')) {
      const c = S.requireAdmin(req);
      if (c.error) return c.error;

      if (method === 'GET' && p === API + '/auth/users') {
        return S.json(200, { users: A.list() });
      }
      if (method === 'POST' && p === API + '/auth/users') {
        return Promise.resolve(ctx.readJson().catch(() => ({}))).then(async (b) => {
          try {
            const u = await A.create({ name: b.name, password: b.password, role: b.role });
            S.note(`${c.user.name} 创建账号：${u.name}`);
            return S.json(200, { user: u });
          } catch (e) {
            return S.err(e.code || 500, 'CREATE_FAILED', e.message);
          }
        });
      }
      if (method === 'PATCH' && p.startsWith(API + '/auth/users/')) {
        const id = decodeURIComponent(p.slice((API + '/auth/users/').length));
        return Promise.resolve(ctx.readJson().catch(() => ({}))).then(async (b) => {
          try {
            if (b.password) await A.setPassword(id, b.password);
            const u = A.patch(id, b);
            S.note(`${c.user.name} 修改账号：${u.name}`);
            return S.json(200, { user: u });
          } catch (e) {
            return S.err(e.code || 500, 'PATCH_FAILED', e.message);
          }
        });
      }
      if (method === 'DELETE' && p.startsWith(API + '/auth/users/')) {
        const id = decodeURIComponent(p.slice((API + '/auth/users/').length));
        try {
          A.remove(id);
          S.note(`${c.user.name} 删除账号 ${id}`);
          return S.json(200, { ok: true });
        } catch (e) {
          return S.err(e.code || 500, 'DELETE_FAILED', e.message);
        }
      }
      return S.err(405, 'METHOD_NOT_ALLOWED', '不支持的方法');
    }

    /* ═══ 授权与审批 ═══ */

    if (p === API + '/rights/rules') {
      return S.json(200, {
        caps: CAPS,
        note: '风险等级由服务端计算，前端传的不作数',
      });
    }

    if (p === API + '/rights/grants' || p.startsWith(API + '/rights/grants/')) {
      const c = S.currentUser(req);
      if (!c) return S.err(401, 'AUTH_REQUIRED', '需要登录');

      if (method === 'GET' && p === API + '/rights/grants') {
        return S.json(200, { grants: S.grants.list(c.user.id) });
      }
      if (method === 'POST' && p === API + '/rights/grants') {
        return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
          try {
            const g = S.grants.grant(c.user.id, {
              app: String(b.app || '*'), cap: String(b.cap || ''),
              scope: String(b.scope || ''), by: c.user.id, note: b.note || '手动添加',
            });
            S.note(`${c.user.name} 手动授权 ${g.app} ${g.cap}:${g.scope}`);
            return S.json(200, { grant: g });
          } catch (e) {
            return S.err(e.code || 500, 'GRANT_FAILED', e.message);
          }
        });
      }
      if (method === 'DELETE' && p.startsWith(API + '/rights/grants/')) {
        const id = decodeURIComponent(p.slice((API + '/rights/grants/').length));
        const ok = S.grants.revoke(c.user.id, id);
        if (!ok) return S.err(404, 'NOT_FOUND', '授权不存在');
        S.note(`${c.user.name} 撤销授权 ${id}`);
        return S.json(200, { ok: true });
      }
      return S.err(405, 'METHOD_NOT_ALLOWED', '不支持的方法');
    }

    if (method === 'GET' && p === API + '/rights/pending') {
      const c = S.currentUser(req);
      if (!c) return S.err(401, 'AUTH_REQUIRED', '需要登录');
      return S.json(200, { requests: S.uac.list(), wait_ms: S.uac.waitMs });
    }

    if (method === 'POST' && p === API + '/rights/decide') {
      const c = S.currentUser(req);
      if (!c) return S.err(401, 'AUTH_REQUIRED', '需要登录');
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        const id = String(b.id || '');
        let decision = String(b.decision || 'deny');
        // 高危操作不给「始终允许」：凭据、系统目录这类东西，一次一议。
        // 前端已经不显示那两个按钮了，这里再兜一层 —— 前端可以被绕过。
        const entry = S.uac.get(id);
        if (entry && entry.risk && entry.risk.level === 'high' && decision.indexOf('always') === 0) {
          decision = 'once';
        }
        const r = S.uac.decide(id, { decision, uid: c.user.id });
        if (!r.ok) return S.err(r.code || 400, 'DECIDE_FAILED', r.message);
        S.note(`${c.user.name} 决定 ${r.entry.app} ${r.entry.cap}:${r.entry.target} → ${r.decision}`);
        return S.json(200, { ok: true, decision: r.decision });
      });
    }

    if (method === 'GET' && p === API + '/rights/dialog/pending') {
      const c = S.currentUser(req);
      if (!c) return S.err(401, 'AUTH_REQUIRED', '需要登录');
      return S.json(200, { requests: S.dialog.list() });
    }

    if (method === 'POST' && p === API + '/rights/dialog/answer') {
      const c = S.currentUser(req);
      if (!c) return S.err(401, 'AUTH_REQUIRED', '需要登录');
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        const r = S.dialog.answer(String(b.id || ''), {
          uid: c.user.id,
          cancelled: !!b.cancelled,
          paths: b.paths, path: b.path, value: b.value,
        });
        if (!r.ok) return S.err(r.code || 400, 'ANSWER_FAILED', r.message);
        S.note(`${c.user.name} 回答对话框 ${r.cancelled ? '（取消）' : (r.path || r.value || '')}`);
        return S.json(200, r);
      });
    }

    /* 文件选择器的目录浏览。这是**人**在看目录，不是应用：权限来自登录会话，
       与应用的能力授权无关。 */
    if (method === 'GET' && p === API + '/rights/browse') {
      const c = S.currentUser(req);
      if (!c) return S.err(401, 'AUTH_REQUIRED', '需要登录');
      if (url.searchParams.get('roots') === '1') return S.json(200, { roots: browseRoots() });
      try {
        return S.json(200, browseDir(url.searchParams.get('path') || ''));
      } catch (e) {
        return S.err(e.code === 'ENOENT' ? 404 : 400, e.code || 'BROWSE_FAILED', e.message);
      }
    }

    /* 桌面侧的剪贴板读写：人自己的剪贴板，不需要应用授权 */
    if (p === API + '/rights/clipboard') {
      const c = S.currentUser(req);
      if (!c) return S.err(401, 'AUTH_REQUIRED', '需要登录');
      if (method === 'GET') {
        const it = S.clipboard.read();
        return S.json(200, { item: it, history: S.clipboard.history(10).entries });
      }
      if (method === 'POST') {
        return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
          try {
            const r = S.clipboard.write({ text: b.text, by: c.user.id, app: 'desktop' });
            return S.json(200, r);
          } catch (e) {
            return S.err(e.code === 'ETOOBIG' ? 413 : 422, e.code || 'CLIP_FAILED', e.message);
          }
        });
      }
      return S.err(405, 'METHOD_NOT_ALLOWED', '不支持的方法');
    }

    if (method === 'GET' && p === API + '/rights/audit') {
      const c = S.currentUser(req);
      if (!c) return S.err(401, 'AUTH_REQUIRED', '需要登录');
      return S.json(200, { entries: S.audit.slice(-100).reverse() });
    }

    /* ═══ SDK 网关 ═══ */

    if (p.startsWith(API + '/sdk/') && method === 'POST') {
      return handleSdk(req, url, ctx);
    }

    return undefined;

    /* ── 内部实现 ─────────────────────────────────────────────── */

    /** 登录表单是 urlencoded（无 JS 也能用），不是 JSON */
    function readForm(c) {
      return Promise.resolve(c.readBody ? c.readBody() : '').then((raw) => {
        const out = {};
        String(Buffer.isBuffer(raw) ? raw.toString('utf8') : (raw || ''))
          .split('&').forEach((kv) => {
            if (!kv) return;
            const i = kv.indexOf('=');
            const k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, ' '));
            const v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
            out[k] = v;
          });
        return out;
      });
    }

    /** 文件选择器的「位置」列表：家目录、应用目录、可移动介质 */
    function browseRoots() {
      const os = require('os');
      const out = [{ label: '主目录', path: os.homedir() }];
      const apps = (os_readState('apps.json', { apps: [] }) || { apps: [] }).apps || [];
      for (const a of apps) {
        if (a.cwd) out.push({ label: a.display_name || a.name, path: a.cwd });
      }
      for (const p of ['/sdcard', '/storage/emulated/0', '/tmp', '/']) {
        try { if (fs.statSync(p).isDirectory()) out.push({ label: p, path: p }); } catch { /* 不存在 */ }
      }
      return out;
    }

    /** 内核状态读取的薄封装：onInit 里的 os 在 onRequest 里不可见，这里补一条 */
    function os_readState(name, dflt) {
      try {
        const f = path.join(S.stateDir, name);
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch { return dflt; }
    }

    /**
     * 列一个目录（给文件选择器用）。
     *
     * 与 fs.list 的区别：这是**人**在浏览，不需要授权，也不做 path 白名单 ——
     * 用户在自己的文件选择器里应该能走到任何地方。上限 2000 条，超大目录
     * （如 /usr/bin）不至于把浏览器卡死。
     */
    function browseDir(raw) {
      const os = require('os');
      let p = String(raw || '');
      if (!p) p = os.homedir();
      if (p === '~' || p.startsWith('~/')) p = os.homedir() + p.slice(1);
      p = path.resolve(p);
      const st = fs.statSync(p);   // ENOENT 抛出去，前端显示「不存在」
      if (!st.isDirectory()) {
        return { path: p, parent: path.dirname(p), is_dir: false, entries: [] };
      }
      const all = fs.readdirSync(p, { withFileTypes: true });
      const entries = [];
      for (const d of all) {
        const full = path.join(p, d.name);
        let s2 = null;
        try { s2 = fs.lstatSync(full); } catch { /* 权限不足 */ }
        entries.push({
          name: d.name,
          type: d.isDirectory() ? 'dir' : (d.isSymbolicLink() ? 'link' : 'file'),
          size: s2 ? s2.size : 0,
          mtime: s2 ? s2.mtimeMs : 0,
          hidden: d.name.startsWith('.'),
        });
        if (entries.length >= 2000) break;
      }
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
      return {
        path: p, parent: p === '/' ? '/' : path.dirname(p), is_dir: true,
        entries, truncated: all.length > 2000,
      };
    }

    function handleSdk(r, u, cx) {
      const token = r.headers['x-runx-token'];
      const app = S.resolveApp(token);
      if (!app) return S.err(401, 'BAD_TOKEN', '应用令牌无效（X-Runx-Token）');

      const uid = S.appOwner(app.name);
      if (!uid) return S.err(409, 'NO_USER', '没有任何账号，先创建一个');

      // /runx/sdk/<area>/<op>
      const rest = u.pathname.slice((API + '/sdk/').length).split('/');
      const area = rest[0] || '';
      const op = rest[1] || '';

      return Promise.resolve(cx.readJson().catch(() => ({}))).then(async (b) => {
        const t0 = Date.now();
        try {
          const r2 = await dispatch(area, op, app, uid, b);
          if (r2 && r2.__passThrough) return undefined;
          S.note(`[sdk] ${app.name} ${area}.${op} ${b.path || b.url || ''} ok ${Date.now() - t0}ms`);
          return S.json(200, { ok: true, result: r2 });
        } catch (e) {
          S.note(`[sdk] ${app.name} ${area}.${op} ${b.path || b.url || ''} !${e.code || e.message}`);
          const status = e.code === 'EPERM' ? 403
            : e.code === 'NEED_ADMIN' ? 403
            : e.code === 'ETIMEDOUT' ? 504
            : e.code === 'ENOUI' ? 409
            : e.code === 'ENOENT' ? 404
            : e.code === 'EINVAL' ? 422
            : e.code === 'ETOOBIG' ? 413
            : e.code === 'ENOUSER' ? 409
            : 500;
          return S.err(status, e.code || 'SDK_ERROR', e.message, {
            risk: e.risk || null, cap: e.cap || null, target: e.target || null, app: e.app || null,
            decision: e.decision || null,
          });
        }
      });
    }

    function dispatch(area, op, app, uid, b) {
      const B = S.broker;
      const table = {
        'fs.read': () => B.read(app, uid, b.path, b),
        'fs.write': () => B.write(app, uid, b.path, b),
        'fs.list': () => B.list(app, uid, b.path),
        'fs.stat': () => B.stat(app, uid, b.path),
        'fs.mkdir': () => B.mkdir(app, uid, b.path, b),
        'fs.remove': () => B.remove(app, uid, b.path, b),
        'fs.copy': () => B.copy(app, uid, b.from, b.to, b),
        'fs.readRange': () => B.readRange(app, uid, b),
        'fs.writeRange': () => B.writeRange(app, uid, b),
        'fs.watch': () => B.watch(app, uid, b),
        'fs.poll': () => Promise.resolve(B.poll(app, b)),
        'fs.unwatch': () => Promise.resolve(B.unwatch(app, b)),
        'proc.spawn': () => B.spawn(app, uid, b),
        'proc.status': () => Promise.resolve(B.procStatus(b.pid)),
        'proc.kill': () => Promise.resolve(B.procKill(b.pid, b.signal)),
        'proc.write': () => Promise.resolve(B.procWrite(b.pid, b)),
        'proc.end': () => Promise.resolve(B.procEnd(b.pid)),
        'net.fetch': () => B.fetch(app, uid, b),
        // 三个 dialog 方法名就是意图本身：kind 由服务端定，不让请求体覆盖
        // （否则应用可以把 save 声明成 open，把「要写哪」藏起来）
        'dialog.open': () => B.dialog(app, uid, Object.assign({}, b, { kind: 'open' })),
        'dialog.save': () => B.dialog(app, uid, Object.assign({}, b, { kind: 'save' })),
        'dialog.message': () => B.dialog(app, uid, Object.assign({}, b, { kind: 'message' })),
        'clipboard.read': () => B.clipboardRead(app, uid),
        'clipboard.write': () => B.clipboardWrite(app, uid, b).then((r) => {
          // 让桌面把它镜像到系统剪贴板（尽力而为，失败只会 toast 一句）
          try {
            S.publish('sys.clipboard.write', {
              app: app.name, app_label: app.label,
              text: String(b.text == null ? '' : b.text), size: r.size, seq: r.seq,
            });
          } catch { /* 广播失败不影响写入结果 */ }
          return r;
        }),
        'sys.info': () => B.info(app, uid),
      };
      const key = area + '.' + op;
      const fn = table[key];
      if (!fn) throw Object.assign(new Error('未知接口：' + key), { code: 'EINVAL' });
      return fn();
    }
  },
};
