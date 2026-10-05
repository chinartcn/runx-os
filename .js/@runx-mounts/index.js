'use strict';

/**
 * @runx-mounts —— RunX 挂载点核心扩展（文档 §7）
 *
 * 让应用"长"在桌面上。两级注册：
 *   · 清单声明（appex.json 里的 mounts[]）—— 装上就有
 *   · 运行时注册（POST /runx/mounts/register）—— 跑起来才出现的
 *
 * 三类挂载点（§7.2）：
 *   · desktop.widget   桌面网格（iframe 型 / 声明型 render）
 *   · taskbar.button   任务栏图标 + 点击事件
 *   · app.background   后台扩展点（主进程加载的 JS 模块声明）
 *
 * 生命周期（§7.4，onAppStop）：
 *   · remove      应用停止即移除
 *   · keep-last   保留最后状态并标 "app-stopped"（默认）
 *   · keep-empty  保留占位（同样标 "app-stopped"，但清空 data）
 *
 * 运行时结构（§A.5）：内存，不持久化。进程重启即清空。
 *
 * REST 走 /runx 前缀（NavExt 内核自留 /api/*）：
 *   GET    /runx/mounts              列出所有挂载
 *   POST   /runx/mounts/register     运行时注册（覆盖同 app 同 id）
 *   DELETE /runx/mounts/:id          注销（非归属方 → 403）
 *   POST   /runx/mounts/:id/update   更新声明型 Widget（iframe 型 → 422）
 *
 * 与其它核心扩展的契约（经 ctx.os.ipc）：
 *   · 监听 'app:started' / 'app:stopped' / 'app:failed' —— 维护挂载点存活状态
 *   · 监听 'apps:changed'                              —— 重新扫描清单声明
 */

const API = '/runx';
const POINTS = new Set(['desktop.widget', 'taskbar.button', 'app.background']);
const ON_STOP = new Set(['remove', 'keep-last', 'keep-empty']);

let S = null;

function json(status, obj) {
  return { status, type: 'application/json; charset=utf-8', body: JSON.stringify(obj) };
}
function err(code, message, data) {
  return { status: code, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: { code, message, data } }) };
}

module.exports = {

  onInit(ctx) {
    const os = ctx.os;

    // 运行时表：mountId -> Mount（§A.5）。内存，不持久化。
    const mounts = new Map();
    // 归属索引：(app + '\u0000' + localId) -> mountId
    const byAppId = new Map();
    const appKey = (app, localId) => app + '\u0000' + localId;

    const loadApps = () => {
      const f = os.readState('apps.json', { schema: 1, apps: [] });
      return (f && Array.isArray(f.apps)) ? f.apps : [];
    };

    function normalizeDecl(app, d) {
      const point = d && d.point;
      if (!POINTS.has(point)) throw Object.assign(new Error('未知挂载点：' + point), { code: 422 });
      const localId = String((d && d.id) || '').trim();
      if (!localId || localId.length > 64) throw Object.assign(new Error('挂载点 id 非法'), { code: 422 });
      const onAppStop = ON_STOP.has(d.onAppStop) ? d.onAppStop : 'keep-last';
      return {
        app,
        point,
        declared: {
          point,
          id: localId,
          title: d.title || localId,
          size: d.size || null,
          url: d.url || null,
          render: d.render !== undefined ? d.render : null,
          onAppStop,
        },
      };
    }

    function statusOfApp(name) {
      // web 应用恒被视为 running（无进程）；node 由 supervisor 事件驱动
      const live = liveApps.get(name);
      return live ? 'active' : 'app-stopped';
    }
    const liveApps = new Map(); // name -> true（运行中）

    function register(app, d, source) {
      const norm = normalizeDecl(app, d);
      const key = appKey(app, norm.declared.id);
      let id = byAppId.get(key);
      const now = Date.now();
      if (id && mounts.has(id)) {
        // 同 app 同 id 重复注册 → 覆盖旧声明
        const m = mounts.get(id);
        m.point = norm.point;
        m.declared = norm.declared;
        m.runtime.status = statusOfApp(app);
        m.runtime.last_update = now;
        m.source = source || m.source;
        return id;
      }
      id = 'mnt-' + now.toString(36) + Math.random().toString(36).slice(2, 8);
      mounts.set(id, {
        id,
        app,
        point: norm.point,
        declared: norm.declared,
        runtime: { status: statusOfApp(app), registered_at: now, last_update: null, data: null },
        source: source || 'runtime',
      });
      byAppId.set(key, id);
      return id;
    }

    function unregister(id, requester) {
      const m = mounts.get(id);
      if (!m) return { error: 'not_found' };
      if (requester && m.app !== requester) return { error: 'forbidden' };
      mounts.delete(id);
      byAppId.delete(appKey(m.app, m.declared.id));
      return { ok: true };
    }

    function updateData(id, data, requester) {
      const m = mounts.get(id);
      if (!m) return { error: 'not_found' };
      if (requester && m.app !== requester) return { error: 'forbidden' };
      if (!m.declared.render) return { error: 'not_render' };
      m.declared.render = data && data.render !== undefined ? data.render : (data && data.data);
      m.runtime.data = m.declared.render;
      m.runtime.last_update = Date.now();
      return { ok: true };
    }

    function list() {
      return Array.from(mounts.values()).map((m) => ({
        id: m.id,
        app: m.app,
        point: m.point,
        declared: m.declared,
        runtime: m.runtime,
      }));
    }

    /* —— 应用生命周期：维护存活状态 —— */
    function onAppStarted(name) {
      liveApps.set(name, true);
      for (const m of mounts.values()) {
        if (m.app === name && m.runtime.status === 'app-stopped') m.runtime.status = 'active';
      }
    }
    function onAppStopped(name) {
      liveApps.delete(name);
      for (const m of Array.from(mounts.values())) {
        if (m.app !== name) continue;
        const policy = m.declared.onAppStop || 'keep-last';
        if (policy === 'remove') {
          mounts.delete(m.id);
          byAppId.delete(appKey(m.app, m.declared.id));
        } else if (policy === 'keep-empty') {
          m.declared.render = null;
          m.runtime.data = null;
          m.runtime.status = 'app-stopped';
        } else { // keep-last
          m.runtime.status = 'app-stopped';
        }
      }
    }

    /* —— 从 apps.json 清单重新扫描声明（安装 / 更新 / 卸载后） —— */
    function rescan() {
      const apps = loadApps();
      const wanted = new Set(apps.map((a) => a.name));
      // 卸载的 app：连带清掉其声明型挂载
      for (const m of Array.from(mounts.values())) {
        if (m.source === 'declared' && !wanted.has(m.app)) {
          mounts.delete(m.id);
          byAppId.delete(appKey(m.app, m.declared.id));
        }
      }
      for (const a of apps) {
        const decls = Array.isArray(a.mounts) ? a.mounts : [];
        for (const d of decls) {
          try { register(a.name, d, 'declared'); }
          catch (e) { ctx.warn(`app ${a.name} 挂载声明被忽略：${e.message}`); }
        }
      }
    }

    // 启动：web 应用视为运行中；node 应用由后续 ipc 事件驱动
    for (const e of loadApps()) {
      if (e.type === 'web') liveApps.set(e.name, true);
    }
    rescan();

    os.ipc.on('app:started', (name) => onAppStarted(name));
    os.ipc.on('app:stopped', (name) => onAppStopped(name));
    os.ipc.on('app:failed', (name) => onAppStopped(name));
    os.ipc.on('apps:changed', () => rescan());

    S = { register, unregister, updateData, list, statusOfApp };
  },

  onRequest(req, url, ctx) {
    const p = url.pathname;
    if (!p.startsWith(API + '/mounts') || !S) return undefined;
    const method = req.method;

    // 请求方身份（归属校验用）。NavExt 无应用身份，这里以显式标记为准。
    const requesterOf = (body) => {
      const h = req.headers && (req.headers['x-runx-app'] || req.headers['x-runx-app-id']);
      if (h) return String(h);
      if (body && body.app) return String(body.app);
      return null;
    };

    // GET /runx/mounts
    if (method === 'GET' && p === API + '/mounts') {
      return json(200, { mounts: S.list() });
    }

    // POST /runx/mounts/register
    if (method === 'POST' && p === API + '/mounts/register') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((body) => {
        const app = requesterOf(body);
        if (!app) return err(422, '缺少归属标识（app 字段或 X-RunX-App 头）');
        if (!body || typeof body !== 'object') return err(422, '请求体必须是 JSON 对象');
        try {
          const mount_id = S.register(app, body, 'runtime');
          return json(200, { mount_id });
        } catch (e) {
          return err(e.code || 422, e.message);
        }
      });
    }

    // /runx/mounts/:id[/update]
    const m = p.match(new RegExp('^' + API + '/mounts/([^/]+)(?:/(update))?$'));
    if (!m) return undefined;
    const id = decodeURIComponent(m[1]);
    const action = m[2] || null;

    // DELETE /runx/mounts/:id
    if (method === 'DELETE' && !action) {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((body) => {
        const requester = requesterOf(body);
        const r = S.unregister(id, requester);
        if (r.error === 'not_found') return err(404, '挂载点不存在');
        if (r.error === 'forbidden') return err(403, '无权注销其它应用的挂载点');
        return json(200, { ok: true });
      });
    }

    // POST /runx/mounts/:id/update
    if (method === 'POST' && action === 'update') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((body) => {
        const requester = requesterOf(body);
        const r = S.updateData(id, body && (body.data !== undefined ? body : { render: body }), requester);
        if (r.error === 'not_found') return err(404, '挂载点不存在');
        if (r.error === 'forbidden') return err(403, '无权更新其它应用的挂载点');
        if (r.error === 'not_render') return err(422, '仅声明型挂载点可更新（iframe 型不支持）');
        return json(200, { ok: true });
      });
    }

    return undefined;
  },
};
