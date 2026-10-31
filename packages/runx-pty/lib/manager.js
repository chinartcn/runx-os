'use strict';

/**
 * @runx/pty —— 会话集合管理器。
 *
 * ## 命名空间（namespace）为什么要存在
 *
 * 终端应用同时服务两类完全不同的用户：
 *
 *   · **terminal** —— 用户自己在终端标签页里开的交互式 shell。要能刷新后
 *     恢复、要长期存活、要占住一个标签页的位置。
 *   · **tui** —— 桌面上双击一个命令图标开出来的一次性窗口（htop / free -h）。
 *     进程跑完窗口就没了，不该出现在终端的标签栏里，也不该占终端的名额。
 *
 * 早期这两类是混在一起的：TUI 会话被写进终端的 localStorage 恢复列表，
 * 终端刷新时把它当成 shell 标签恢复出来 —— 第一个标签页于是绑到一个已经
 * 死掉的 TUI 会话上，看起来就是「第一个标签页不能打字」。
 *
 * 所以这里用命名空间把它们隔开：
 *   · 各自独立的配额（`terminal` 用满 8 个，不影响 `tui` 再开 8 个）
 *   · 各自独立的空闲回收策略
 *   · `list(ns)` 可以只看一类
 *
 * 隔离的另一半在前端：终端页面和 TUI 页面**不是同一个页面**，各自只
 * 认自己的命名空间（见 apps/term/public/term.js）。
 */

const crypto = require('crypto');
const { Session } = require('./session');
const { normalizeSpec, clampCols, clampRows, safeMs } = require('./support');

const IDLE_MS = 30 * 60 * 1000;   // 30 分钟无连接且无输入 → 回收
const GRACE_MS = 5000;            // conn 全断后宽限

/**
 * 默认命名空间配置。
 *
 * `max` 是该命名空间内同时存活的最大会话数。
 * `idleMs` 是无连接空闲多久回收。
 *
 * 环境变量可覆盖：
 *   TERM_MAX_SESSIONS        —— terminal 命名空间的上限
 *   TERM_MAX_TUI_SESSIONS    —— tui 命名空间的上限
 *   TERM_IDLE_MS             —— terminal 的空闲回收时间
 *   TERM_TUI_IDLE_MS         —— tui 的空闲回收时间
 */
const DEFAULT_NAMESPACES = {
  // 用户自己开的 shell 标签页
  terminal: {
    max: safeMs(Number(process.env.TERM_MAX_SESSIONS), 8, 1, 256),
    idleMs: safeMs(Number(process.env.TERM_IDLE_MS), IDLE_MS, 1000, 24 * 3600 * 1000),
  },
  // 桌面上双击图标开的一次性命令窗口
  tui: {
    max: safeMs(Number(process.env.TERM_MAX_TUI_SESSIONS), 8, 1, 256),
    idleMs: safeMs(Number(process.env.TERM_TUI_IDLE_MS), 5 * 60 * 1000, 1000, 24 * 3600 * 1000),
  },
};

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 's' + Date.now() + Math.random().toString(16).slice(2));

class SessionManager {
  /**
   * @param {object} [opts]
   * @param {object} [opts.namespaces] 命名空间配置（覆盖默认）
   * @param {number} [opts.maxSessions] 全局上限（所有命名空间合计）
   */
  constructor(opts) {
    opts = opts || {};
    this.sessions = new Map();
    // 会话数量变化时的回调（与宿主集成用：Dock 角标 = 有几个会话）
    this.onChange = null;
    this.namespaces = Object.assign({}, DEFAULT_NAMESPACES, opts.namespaces || {});
    this.maxTotal = safeMs(Number(opts.maxSessions), 256, 1, 4096);
    this._sweeper = setInterval(() => this._sweep(), 60 * 1000);
    this._sweeper.unref();
  }

  /** 通知订阅者「会话集合变了」。宿主没装/没连上时这里什么都不发生 */
  _changed() {
    if (!this.onChange) return;
    try { this.onChange(this.sessions.size); } catch (e) { /* 订阅者自己的问题 */ }
  }

  get size() { return this.sessions.size; }
  get(id) { return this.sessions.get(id) || null; }

  /**
   * 某个命名空间当前存活多少个会话
   */
  count(ns) {
    if (!ns) return this.sessions.size;
    let n = 0;
    for (const s of this.sessions.values()) if (s.ns === ns) n++;
    return n;
  }

  /**
   * 列出会话。
   * @param {string} [ns] 只列某个命名空间；省略则列出全部
   */
  list(ns) {
    const out = [];
    for (const s of this.sessions.values()) {
      if (ns && s.ns !== ns) continue;
      out.push({
        id: s.id, title: s.title, cols: s.cols, rows: s.rows, pid: s.pid || null,
        ns: s.ns,
        command: s.spec ? s.spec.argv.join(' ') : null, shell: s.spec ? s.spec.shell : null,
        createdAt: s.createdAt, lastActive: s.lastActive, conns: s.conns ? s.conns.size : 0,
      });
    }
    return out;
  }

  /**
   * 新建一个会话。
   *
   * @param {number} cols
   * @param {number} rows
   * @param {string|null} id  指定 id（不传则随机生成）
   * @param {object|null} spec 命令描述；null = 交互式 shell
   * @param {object} [opts] { ns: 'terminal' | 'tui' }
   */
  create(cols, rows, id, spec, opts) {
    opts = opts || {};
    const ns = opts.ns || 'terminal';
    const cfg = this.namespaces[ns] || DEFAULT_NAMESPACES.terminal;

    // 命名空间配额与全局配额都要看：TUI 开再多也不该挤掉用户的 shell 标签页
    if (this.count(ns) >= cfg.max) {
      const err = new Error('max_sessions'); err.code = 'max_sessions'; err.ns = ns; throw err;
    }
    if (this.sessions.size >= this.maxTotal) {
      const err = new Error('max_sessions'); err.code = 'max_sessions'; throw err;
    }

    const sid = id || newId();
    const s = new Session(sid, clampCols(cols), clampRows(rows), normalizeSpec(spec), { ns });
    this.sessions.set(sid, s);
    this._changed();
    return s;
  }

  /**
   * 用新尺寸重建会话（保留 id）。
   *
   * resize 的正常路径是 Session.setSize()（原地 ioctl，前后台进程全保留），
   * 这里只是**回落**：拿不到 PTY slave 路径、stty 缺失或被目标平台拒绝时
   * 才会走到，代价是前台程序被重启（因此调用方要给出显式提示）。
   */
  respawn(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.cols = clampCols(cols);
    s.rows = clampRows(rows);
    s.title = s.name + ' ' + s.cols + 'x' + s.rows;
    return new Promise((resolve) => {
      s.kill(() => {
        s.start();
        resolve(s);
      });
    });
  }

  close(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.kill();
    this.sessions.delete(id);
    this._changed();
    return true;
  }

  _sweep() {
    const now = Date.now();
    let removed = 0;
    for (const [id, s] of this.sessions) {
      const noConns = !s.conns || s.conns.size === 0;
      const cfg = this.namespaces[s.ns] || DEFAULT_NAMESPACES.terminal;
      if (noConns && now - s.lastActive > cfg.idleMs) {
        s.kill();
        this.sessions.delete(id);
        removed++;
      }
    }
    if (removed) this._changed();
  }

  /** 进程退出时清理全部会话（含孙进程） */
  disposeAll() {
    for (const s of this.sessions.values()) s.kill();
    this.sessions.clear();
    this._changed();
  }
}

module.exports = { SessionManager, DEFAULT_NAMESPACES, IDLE_MS, GRACE_MS };
