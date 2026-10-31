'use strict';

/**
 * @runx-x11 —— X11 图形应用扩展（按需加载）。
 *
 * ── 为什么它是独立扩展而不是桌面的一部分 ──────────────────────────
 * 桌面外壳是每个人都要用的东西；X11 是「装了 xpra 才有」的东西。把两者绑在
 * 一起的后果是：一台没装 xpra 的机器，桌面代码里永远躺着一份用不上的会话管理
 * 器、端口分配器、进程收尸逻辑，还要在启动时 fork 一个 `xpra --version`。
 *
 * 拆出来之后，它对内核的依赖只有一条：从 js.list.json 里删掉这一行，图形功能
 * 就不存在了，其余一切照常。桌面那边通过探测 `/runx/x11/status` 是否 404 来
 * 判断「装了没装」，两边没有编译期依赖。
 *
 * mod.json 里的 `core: true` 只表示「需要 ctx.os 的进程能力」，不代表常驻 ——
 * 这个扩展完全可以被禁用到只剩一个图标点不开。术语上容易误会，所以写在这里。
 *
 * ── REST ────────────────────────────────────────────────────────
 *   GET    /runx/x11/status            探测结果 + 现存会话（前端据此画决策框）
 *   POST   /runx/x11/status/refresh    清掉探测缓存（用户刚装完 xpra）
 *   GET    /runx/x11/sessions          只列会话
 *   POST   /runx/x11/sessions          起一个会话
 *   DELETE /runx/x11/sessions/:id      关一个会话
 *
 * 错误码约定（前端按 code 分流，不解析文案）：
 *   422 X11_BAD_REQUEST        参数不对
 *   501 X11_UNSUPPORTED        平台不支持（Termux / Android）
 *   501 X11_NO_BACKEND         平台可以，但依赖没装全
 *   502 X11_START_FAILED       起了但没起来
 *   504 X11_START_TIMEOUT      等太久
 */

const path = require('path');
const manager = require('./manager');

const API = '/runx/x11';

let S = null;

function json(status, obj) {
  return { status, type: 'application/json; charset=utf-8', body: JSON.stringify(obj) };
}

function err(status, codeName, message, data) {
  return {
    status,
    type: 'application/json; charset=utf-8',
    body: JSON.stringify({ error: { code: status, name: codeName, message, data: data || null } }),
  };
}

module.exports = {
  onInit(ctx) {
    const os = ctx.os;
    const log = (m) => { try { ctx.log(m); } catch (e) { /* 记不了就算了 */ } };

    const mgr = manager.createManager({
      root: ctx.root,
      log,
      // 会话自己死掉（用户在里面退了最后一个程序 / xpra 崩了）：让桌面的窗口
      // 自己关掉，否则窗口会一直停在「connection lost」上，用户以为桌面卡了。
      //
      // 走事件总线的 HTTP 兜底而不是 os.bus.broadcast：后者是内核 WS 的原始帧
      // （{type:'event',event,from,payload}），桌面前端订阅的是同一个协议没错，
      // 但用 HTTP 发布能让「发事件」这件事不依赖本扩展和 WS 注册表的关系 ——
      // 桌面没连、总线没起，都只是这一条通知丢了，不影响会话本身。
      onGone: (id, info) => {
        if (!info || !info.winId) return;
        const port = Number(process.env.PORT) || 3000;
        Promise.resolve(ctx.fetch('http://127.0.0.1:' + port + '/runx/event-bus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'host.window.close', payload: { winId: info.winId, reason: 'exited' } }),
        })).catch((e) => log('通知桌面关窗失败：' + e.message));
      },
    });

    // 上次 RunX 被强杀留下的 xpra 进程组会占着显示号与端口，起来先收掉。
    // 放到下一轮事件循环：onInit 里同步 fork / 读一堆 /proc 会拖慢启动。
    const reap = () => { try { mgr.reap(); } catch (e) { log('x11 清理失败：' + e.message); } };
    ctx.timer ? ctx.timer(reap, 0) : setTimeout(reap, 0);

    // 退出时别把会话留在后台：xpra 是 detached 的，不主动收就是孤儿进程
    if (os.schedule) { /* 内核的 schedule 留给以后做空闲回收 */ }

    S = { json, err, mgr, api: API };
  },

  onRequest(req, url, ctx) {
    const p = url.pathname;
    if (!p.startsWith(API)) return undefined;
    if (!S) return undefined;
    const mgr = S.mgr;

    /* ── 探测 ── */
    if (p === API + '/status' && (req.method === 'GET' || req.method === 'HEAD')) {
      return mgr.status().then((r) => S.json(200, r))
        .catch((e) => S.err(500, 'X11_PROBE_FAILED', e.message));
    }

    if (p === API + '/status/refresh' && req.method === 'POST') {
      // provider 的探测缓存 60 秒，用户装完 xpra 立刻点「重试」时不该还在缓存里
      for (const pv of manager.PROVIDERS) {
        if (pv.resetCache) pv.resetCache();
      }
      return mgr.status().then((r) => S.json(200, r))
        .catch((e) => S.err(500, 'X11_PROBE_FAILED', e.message));
    }

    /* ── 会话列表 ── */
    if (p === API + '/sessions' && (req.method === 'GET' || req.method === 'HEAD')) {
      return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify({ sessions: mgr.list() }) };
    }

    /* ── 新建会话 ── */
    if (p === API + '/sessions' && req.method === 'POST') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then(async (b) => {
        const command = String(b.command || '').trim();
        if (!command) return S.err(422, 'X11_BAD_REQUEST', '命令不能为空');
        if (command.length > 512) return S.err(422, 'X11_BAD_REQUEST', '命令太长（上限 512 字）');

        try {
          const r = await mgr.create({
            cmd: command,
            label: String(b.label || command).slice(0, 80),
            winId: b.winId ? String(b.winId).slice(0, 64) : null,
            provider: b.provider ? String(b.provider) : null,
            force: !!b.force,          // 用户明确要求绕过平台判断（自带 X 服务的人）
          });
          return S.json(200, r);
        } catch (e) {
          // 平台不支持 / 后端缺失 / 启动失败 三种要分开，前端弹的东西完全不同
          if (e.code === 501 && e.code_name === 'X11_NO_BACKEND') {
            return S.err(501, 'X11_NO_BACKEND', e.message, e.status);
          }
          if (e.code === 501) {
            return S.err(501, 'X11_UNSUPPORTED', e.message, e.reason ? { reason: e.reason, api: e.api, detail: e.detail } : null);
          }
          if (e.code === 422) return S.err(422, 'X11_BAD_REQUEST', e.message);
          if (e.code === 504) return S.err(504, 'X11_START_TIMEOUT', e.message);
          return S.err(502, 'X11_START_FAILED', e.message, e.hint ? { hint: e.hint } : null);
        }
      });
    }

    /* ── 关闭会话 ── */
    if (req.method === 'DELETE' && p.startsWith(API + '/sessions/')) {
      const id = decodeURIComponent(p.slice((API + '/sessions/').length));
      if (!id) return S.err(422, 'X11_BAD_REQUEST', '缺少会话 id');
      return mgr.stop(id).then((r) => S.json(200, r))
        .catch((e) => S.err(500, 'X11_STOP_FAILED', e.message));
    }

    return undefined;   // 其它 /runx/x11/* 交给后面的扩展
  },
};
