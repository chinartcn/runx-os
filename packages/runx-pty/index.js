'use strict';

/**
 * @runx/pty —— 伪 PTY 会话组件。
 *
 * 给「要一个真终端」的应用用：交互式 shell、TUI 程序（htop / vim / python
 * REPL）、任何需要行编辑 + 颜色 + 信号 + 窗口尺寸的应用。
 *
 * 零原生依赖 —— 用 util-linux 的 `script` 借一个真 PTY，不用 node-pty
 * （那需要 node-gyp 编译，离线环境常失败）。
 *
 * ## 用法
 *
 * ```js
 * const { SessionManager } = require('@runx/pty');
 *
 * const mgr = new SessionManager();
 * const s = mgr.create(80, 24, null, null, { ns: 'terminal' });
 * s.onOutput = (sess, buf) => process.stdout.write(buf);
 * s.start();
 * s.write('ls\n');
 * ```
 *
 * 命名空间（`ns`）用来隔离不同用途的会话：终端的 shell 标签页和桌面上
 * 一次性开出来的 TUI 窗口各有各的配额，互不挤占。详见 lib/manager.js。
 */

const support = require('./lib/support');
const { Session, OutputHistory, HISTORY_BYTES } = require('./lib/session');
const { SessionManager, DEFAULT_NAMESPACES, IDLE_MS, GRACE_MS } = require('./lib/manager');

module.exports = {
  // 主要 API
  SessionManager,
  Session,
  OutputHistory,

  // 会话描述
  normalizeSpec: support.normalizeSpec,
  cmdName: support.cmdName,
  cmdText: support.cmdText,

  // 环境探测
  probeScript: support.probeScript,
  probeSttyFileMode: support.probeSttyFileMode,
  sttySetSize: support.sttySetSize,

  // 常量
  SHELL: support.SHELL,
  MAX_SESSIONS: DEFAULT_NAMESPACES.terminal.max,
  DEFAULT_NAMESPACES,
  IDLE_MS,
  GRACE_MS,
  HISTORY_BYTES,
  safeMs: support.safeMs,
};
