'use strict';

/**
 * @runx-node-safety —— 用 Node 自己的权限模型给应用划边界
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * RunX 的应用就是一个 node 进程，和内核同权限：读 ~/.ssh、写 /etc、起子进程
 * 全都做得到。@runx-rights-manager 的审批只能拦住「走 SDK 的调用」，拦不住
 * 应用直接 require('fs')。真正有强制力的是进程级围栏 —— 这就是这个扩展。
 *
 * ── 它怎么接进来的 ─────────────────────────────────────────────
 * 进程只能由 supervisor 起，所以这里不自己 spawn，只提供 policy.plan()：
 * 把清单里的 permissions 翻译成 `--permission --allow-fs-read=...` 这样的
 * argv。supervisor 在 spawn 时尝试 require 这个模块（不存在就跳过），拿到
 * argv 就用，拿不到就用原命令 —— 删掉这个扩展，一切照常，只是没有围栏。
 *
 * ── 三种状态，必须分清 ─────────────────────────────────────────
 *   applied  围栏已生效（argv 里带了 --permission）
 *   skipped  这台机器的 Node 不支持（<18），或命令不是 node（如 npm start）
 *   off      用户/清单显式关掉了（no_fence / safety.json 的 exempt）
 * 把 skipped 混进 applied 会让人误以为安全，所以 API 里分开报。
 *
 * REST：
 *   GET  /runx/safety/status          运行环境 + 每个应用的围栏计划
 *   POST /runx/safety/refresh         重新探测（刚换了 Node 版本）
 *   POST /runx/safety/mode            {mode:'declared'|'strict'|'off'} 全局策略
 *   POST /runx/safety/apps/:name      {exempt:true|false} 单个应用豁免
 */

const path = require('path');
const policy = require('./policy');

const API = '/runx/safety';

let S = null;

function json(status, obj) {
  return { status, type: 'application/json; charset=utf-8', body: JSON.stringify(obj) };
}
function err(status, name, message, data) {
  return { status, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: { code: status, name, message, data: data || null } }) };
}

module.exports = {
  onInit(ctx) {
    const os = ctx.os;
    const log = (m) => { try { os.logAppend('safety', m); } catch { /* 忽略 */ } };

    function loadConfig() {
      const c = os.readState('safety.json', null) || {};
      const modes = ['declared', 'strict', 'off'];
      return {
        mode: modes.includes(c.mode) ? c.mode : 'declared',
        exempt: Array.isArray(c.exempt) ? c.exempt : [],
        extra: Array.isArray(c.extra) ? c.extra : [],
        extra_write: Array.isArray(c.extra_write) ? c.extra_write : [],
      };
    }
    function saveConfig(c) { os.writeState('safety.json', Object.assign({ schema: 1 }, c)); }

    function apps() {
      const f = os.readState('apps.json', { apps: [] }) || { apps: [] };
      return f.apps || [];
    }

    function statusOf(entry, conf) {
      const exempt = entry.no_fence === true || conf.exempt.includes(entry.name);
      if (exempt) {
        return { name: entry.name, state: 'off', reason: '已豁免围栏（no_fence 或 safety.json 的 exempt）' };
      }
      if (entry.type === 'web') return { name: entry.name, state: 'skipped', reason: 'web 应用没有进程' };
      const p = policy.plan(entry, conf);
      return Object.assign({ name: entry.name, state: p.applied ? 'applied' : 'skipped' }, p);
    }

    function snapshot() {
      const conf = loadConfig();
      const rt = policy.probeRuntime();
      return {
        runtime: rt,
        config: conf,
        apps: apps().filter((a) => a.type !== 'web').map((a) => statusOf(a, conf)),
      };
    }

    S = { os, log, loadConfig, saveConfig, snapshot, statusOf, apps, json, err };
  },

  onRequest(req, url, ctx) {
    if (!S) return undefined;
    const p = url.pathname;
    if (!p.startsWith(API)) return undefined;
    const method = req.method;

    if (method === 'GET' && p === API + '/status') {
      return S.json(200, S.snapshot());
    }

    if (method === 'POST' && p === API + '/refresh') {
      policy.invalidate();
      return S.json(200, S.snapshot());
    }

    if (method === 'POST' && p === API + '/mode') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        const c = S.loadConfig();
        const modes = ['declared', 'strict', 'off'];
        c.mode = modes.includes(b.mode) ? b.mode : 'declared';
        S.saveConfig(c);
        S.log('围栏模式切换为 ' + c.mode);
        return S.json(200, S.snapshot());
      });
    }

    if (method === 'POST' && p.startsWith(API + '/apps/')) {
      const name = decodeURIComponent(p.slice((API + '/apps/').length));
      const entry = S.apps().find((a) => a.name === name);
      if (!entry) return S.err(404, 'APP_NOT_FOUND', '应用不存在');
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        const c = S.loadConfig();
        const set = new Set(c.exempt);
        if (b.exempt === false) set.delete(name); else set.add(name);
        c.exempt = Array.from(set);
        S.saveConfig(c);
        S.log(`${name} 围栏豁免：${b.exempt !== false}`);
        return S.json(200, { name, exempt: c.exempt.includes(name), restart_required: true });
      });
    }

    return undefined;
  },
};
