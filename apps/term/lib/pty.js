'use strict';

/**
 * 终端应用的 PTY 能力 —— 来自 @runx/pty 组件包。
 *
 * 为什么还留这个文件：`apps/term` 里其它模块（app.js）历史上是
 * `require('./lib/pty')`。组件化之后真实实现只有一份（packages/runx-pty），
 * 这里只做转发，保证：
 *   · 应用目录里没有第二份实现，改组件即生效（软链）
 *   · 万一软链没挂上（link.js 没跑），能给出清晰、可执行的提示
 *
 * 组件本身提供：
 *   · SessionManager —— 带命名空间隔离的会话集合
 *   · Session —— 一个伪 PTY 会话（真终端：行编辑/颜色/信号/窗口尺寸）
 *   · normalizeSpec / probeScript / probeSttyFileMode / sttySetSize
 */

const path = require('path');

/** 按顺序尝试加载：软链 → 仓库内源码路径 */
function load() {
  const attempts = [
    { what: '@runx/pty', fn: () => require('@runx/pty') },
    // 兜底：应用可能被打包到别处（PaX tarball 里没有仓库根目录），但只要
    // 还能顺着相对路径找到仓库，就直接用源码 —— 比启动失败强。
    {
      what: path.join(__dirname, '../../../packages/runx-pty'),
      fn: () => require(path.join(__dirname, '../../../packages/runx-pty')),
    },
  ];
  const errors = [];
  for (const a of attempts) {
    try { return a.fn(); }
    catch (e) { errors.push(a.what + ' → ' + (e && e.message ? e.message : String(e))); }
  }
  throw new Error(
    '终端的 PTY 组件 @runx/pty 加载失败。请在仓库根目录执行：node packages/link.js --all\n' +
    '（说明：终端应用的 PTY 能力已抽成独立组件包 packages/runx-pty）\n' +
    errors.join('\n')
  );
}

module.exports = load();
