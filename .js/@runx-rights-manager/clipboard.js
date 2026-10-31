'use strict';

/**
 * clipboard.js —— 内核剪贴板
 *
 * ── 为什么剪贴板要在内核里，而不是让应用各自读系统剪贴板 ─────────
 * 浏览器里的 `navigator.clipboard` 需要用户手势与焦点，Node 进程又根本够不到
 * 它。如果每个应用自己想办法，结果就是「有的能复制、有的不能、手机上全不能」。
 * 所以这里放一份**共享文本缓冲区**，两端都往它上面靠：
 *
 *   应用 → SDK → 这里 ← 桌面（在可能时同步系统剪贴板）
 *
 * ── 它不是系统剪贴板 ────────────────────────────────────────────
 * 桌面会在两个方向上尽力同步（页面里 copy 事件 → 写进来；应用写入 → 尝试
 * `navigator.clipboard.writeText`），但没有浏览器权限、页面没焦点、用户拒绝
 * 的时候同步会失败。那时这里仍然是一份**应用之间能用**的剪贴板 —— 功能没丢，
 * 只是没跨出浏览器。文档与 API 都按这个事实说话，不假装自己是系统剪贴板。
 *
 * ── 边界 ───────────────────────────────────────────────────────
 * 只存文本，单条上限 256KB（再大的东西应该走文件）；历史保留最近 20 条，
 * 每条最多 8KB —— 历史是给「我刚复制了什么」用的，不是备份。
 */

const fs = require('fs');
const path = require('path');

const MAX_TEXT = 256 * 1024;
const MAX_HISTORY = 20;
const HISTORY_TEXT = 8 * 1024;

/**
 * @param {{dir:string, log?:Function}} opts dir = var/runx
 */
function createClipboard(opts) {
  const log = opts.log || (() => {});
  const file = path.join(opts.dir, 'clipboard.json');
  let cache = null;

  function load() {
    if (cache) return cache;
    let d = null;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { d = null; }
    if (!d || d.schema !== 1) d = { schema: 1, seq: 0, item: null, history: [] };
    cache = d;
    return d;
  }

  function save(d) {
    const tmp = file + '.tmp.' + process.pid;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(d));
      fs.renameSync(tmp, file);
    } catch (e) {
      log('剪贴板写入失败：' + e.message);
      throw Object.assign(new Error('剪贴板写入失败：' + e.message), { code: 'EIO' });
    }
    cache = d;
  }

  /**
   * 写入。
   * @param {{text:string, mime?:string, by?:string, app?:string}} input
   * @returns {{seq:number, at:number, size:number, mime:string}}
   */
  function write(input) {
    const text = String(input && input.text != null ? input.text : '');
    if (!text) throw Object.assign(new Error('内容为空'), { code: 'EINVAL' });
    const buf = Buffer.from(text, 'utf8');
    if (buf.length > MAX_TEXT) {
      throw Object.assign(new Error(`单次写入超过 ${MAX_TEXT / 1024}KB`), { code: 'ETOOBIG' });
    }
    const d = load();
    const now = Date.now();
    d.seq = (d.seq || 0) + 1;
    d.item = {
      seq: d.seq, text, mime: String((input && input.mime) || 'text/plain'),
      at: now, by: (input && input.by) || null, app: (input && input.app) || null,
      size: buf.length,
    };
    d.history.unshift({
      seq: d.seq, text: text.length > HISTORY_TEXT ? text.slice(0, HISTORY_TEXT) : text,
      at: now, app: d.item.app, truncated: text.length > HISTORY_TEXT,
    });
    if (d.history.length > MAX_HISTORY) d.history.length = MAX_HISTORY;
    save(d);
    log(`剪贴板写入 ${buf.length}B by=${d.item.app || d.item.by || '?'}`);
    return { seq: d.item.seq, at: now, size: buf.length, mime: d.item.mime };
  }

  /** 读当前内容。空剪贴板返回 null，不抛错 —— 那是常态，不是异常 */
  function read() {
    const d = load();
    return d.item || null;
  }

  function history(n) {
    const d = load();
    const k = Math.max(1, Math.min(MAX_HISTORY, Number(n) || 10));
    return { seq: d.seq || 0, entries: d.history.slice(0, k) };
  }

  /** 清空：用户主动删掉刚复制的东西时用 */
  function clear() {
    save({ schema: 1, seq: (load().seq || 0) + 1, item: null, history: [] });
    return true;
  }

  return { write, read, history, clear, file, MAX_TEXT };
}

module.exports = { createClipboard, MAX_TEXT };
