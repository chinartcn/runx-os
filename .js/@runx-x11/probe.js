'use strict';

/**
 * 环境探测 —— 这台机器到底能不能跑 X11，以及该走哪条路。
 *
 * ── 为什么探测要和启动分开 ────────────────────────────────────────
 * 用户点一个图形应用图标时，最坏的情况是「等 25 秒，然后弹一句 xpra 启动超时」。
 * 而真实原因往往是「这台机器根本没装 xpra」。探测是毫秒级的（扫 PATH + 看几个
 * 文件），把它放在启动之前，就能在**点下去的瞬间**告诉用户该装什么、装多大、
 * 或者这台设备压根不支持。错误信息从「超时」变成「apt install xpra」。
 *
 * ── 探测结果要能直接变成 UI ─────────────────────────────────────
 * 前端不该自己拼文案。probe() 返回的是一份**可渲染的结构**：
 *   platform / supported / reason   能不能跑，为什么不能
 *   display                        宿主现有显示
 *   backends[]                     每条路通不通、缺什么
 *   install[]                      可执行的修复动作（含体积估算）
 * 前端只负责把它画成对话框，措辞和判断都留在这一侧，改文案不用动两处。
 */

const fs = require('fs');
const path = require('path');

/** PATH 里找可执行文件：不 fork `which`，探测必须是毫秒级 */
function which(cmd) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // Termux 的 /opt/bin 与 /usr/local/bin 常常不在 PATH 里，补上
  const extra = ['/usr/bin', '/usr/local/bin', '/bin', '/opt/bin',
    '/data/data/com.termux/files/usr/bin'];
  for (const d of new Set(dirs.concat(extra))) {
    const p = path.join(d, cmd);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (st.mode & 0o111)) return p;
    } catch (e) { /* 这个目录里没有 */ }
  }
  return null;
}

/**
 * 平台判断。
 *
 * Termux 是个特殊的坑：`process.platform` 报 'linux'，但它跑在 Android 上，
 * 没有 X server、没有 glibc 动态链接、apt 装出来的 xpra 全是 x86 包。硬上的
 * 办法只有 proot 里再套一个发行版 —— 那是「能跑」，不是「能用」：启动 10 秒、
 * 中文输入法直接没有、窗口重绘像幻灯片。所以这里明确判成**不支持**，并留下
 * 一条扩展口子（见 unsupported() 的 api 字段），将来谁有更好的方案可以接。
 */
function detectPlatform() {
  if (process.env.TERMUX_VERSION ||
      /com\.termux/.test(String(process.env.PREFIX || '')) ||
      fs.existsSync('/data/data/com.termux')) return 'termux';
  if (process.platform === 'android') return 'android';
  return process.platform;   // 'linux' / 'darwin' / 'win32'
}

/**
 * 宿主已有的 X 显示。
 *
 * 只认本机 socket：`DISPLAY=host:0` 指向另一台机器时，xpra 能连上，但 RunX
 * 跑在容器/服务器里，那条网络路径通常不通，让用户等到超时不如现在就说没有。
 */
function hostDisplay() {
  const d = String(process.env.DISPLAY || '').trim();
  const m = /^:(\d+)(?:\.\d+)?$/.exec(d);
  if (!m) return null;
  if (fs.existsSync('/tmp/.X11-unix/X' + m[1])) return d;
  return null;
}

/** 一次同步探测：不 spawn 任何东西，可以在路由里随便调 */
function env() {
  const platform = detectPlatform();
  const termux = platform === 'termux' || platform === 'android';
  const linux = platform === 'linux';
  const bins = {
    xpra: which('xpra'),
    Xvfb: which('Xvfb'),
    xvfbRun: which('xvfb-run'),
    x11vnc: which('x11vnc'),
    websockify: which('websockify'),
  };
  return {
    platform,
    termux,
    linux,
    usable: linux,              // 只有 Linux 走原生进程这条路
    display: termux ? null : hostDisplay(),
    bins,
    has: (k) => !!bins[k],
  };
}

/**
 * 不支持时的结构化拒绝。
 *
 * api 字段是留给「用户自己想办法」的口子：扩展加载着、图标存着，只是启动被拒。
 * 有能力的用户（比如自己拿 rootfs 跑了 Xvfb + termux-x11）可以直接打
 * POST /runx/x11/sessions 并带上 provider，绕过这里的判断 —— 见 index.js 的
 * `allowUnsupported` 配置。
 */
function unsupported(e) {
  const isTermux = e.termux;
  return {
    ok: false,
    platform: e.platform,
    supported: false,
    reason: isTermux ? 'termux' : 'platform',
    message: isTermux
      ? '当前是 Android / Termux 环境，暂不内置 X11 支持'
      : '当前平台（' + e.platform + '）没有可用的 X11 后端',
    detail: isTermux
      ? 'Termux 里跑图形应用只能靠 proot 再套一层发行版，启动慢、没有输入法、重绘卡顿 —— 能跑，但不是能用的水平，所以不内置。'
      : '',
    api: '/runx/x11/sessions',
    hint: isTermux
      ? '如果你自己搭了 X 服务（例如 termux-x11 + proot 发行版），可以直接调会话 API 接入。'
      : '',
    sessions: [],
    backends: [],
    install: [],
  };
}

module.exports = { which, env, unsupported, detectPlatform, hostDisplay };
