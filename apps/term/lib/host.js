'use strict';

/**
 * 与 RunX 桌面窗体的可选集成：Dock 角标、长任务完成通知。
 *
 * ── 为什么是「可选」 ────────────────────────────────────────────
 * term 也能脱离 RunX 单独跑（`node app.js` 调试，或者别人把 apps/term 拿走
 * 自己用）。这种情况下 require('@runx/host') 可能装不上、也可能装上但没有
 * RUNX_APP_TOKEN。缺任何一样都退化成空函数，调用点不用写 if。
 *
 * ── 通知的取舍 ──────────────────────────────────────────────────
 * 不是每条命令结束都弹：`ls` 结束也弹的话，用户第一件事就是关掉通知权限。
 * 规则是「跑够了时间」或者「失败了」才值得打扰，其余静默。
 */

let hx = null;
try { hx = require('@runx/host'); } catch (e) { hx = null; }

const ON = !!(hx && hx.enabled);

/** 短于这个时长的命令，成功结束时不通知 */
const NOTIFY_AFTER_MS = 20000;

/** 通知标题/正文都截断：太长会被桌面裁掉，反而看不清重点 */
function clip(s, n) {
  const str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function humanMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分' + (s % 60 ? ' ' + (s % 60) + ' 秒' : '');
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
}

/** Dock 角标 = 当前会话数（0 会清掉角标） */
function badge(n) {
  if (!ON) return;
  const v = Number(n) || 0;
  hx.dock.badge(v).catch(() => { /* 桌面没开、令牌过期都不该影响终端本身 */ });
}

/**
 * 一个「跑指定命令」的会话结束了。
 *
 * 交互式 shell 不通知：用户自己敲 exit 关掉的，他当然知道。
 */
function exited(sess, code, signal) {
  if (!ON || !sess) return;
  if (!sess.spec) return;                      // 交互式 shell，不打扰
  if (sess.spec.ephemeral) return;             // 桌面双击的一次性命令，窗口就在眼前

  const ms = Date.now() - (sess.createdAt || Date.now());
  const ok = code === 0 && !signal;
  if (ok && ms < NOTIFY_AFTER_MS) return;      // 又快又成功，没必要说

  const cmd = sess.spec.argv ? sess.spec.argv.join(' ') : (sess.title || '命令');
  hx.notify({
    title: ok ? '命令完成' : '命令失败' + (signal ? '（' + signal + '）' : '（退出码 ' + code + '）'),
    body: clip(cmd, 60) + ' · ' + humanMs(ms),
  }).catch(() => {});
}

/** 宿主是否可用（调试用：/healthz 里能看到） */
function status() {
  return { available: ON, app: ON ? hx.app.name : null };
}

module.exports = { badge, exited, status, enabled: ON };
