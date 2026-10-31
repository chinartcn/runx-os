'use strict';

/**
 * 原生直通 provider —— 把宿主**已经存在**的桌面镜像进一个 RunX 窗口。
 *
 * ── 它和 xpra provider 的区别 ────────────────────────────────────
 *   xpra   每个会话新起一个 Xvfb，seamless（窗口级），互不干扰，推荐
 *   native 不新起 X server，附着到宿主现有的 $DISPLAY，整屏镜像
 *
 * native 存在的意义是「这台机器本来就跑着桌面环境」：服务器装了 XFCE、树莓派
 * 接着 HDMI、或者用户另有 VNC —— 这时候再起一个空的 Xvfb 反而是多余的。代价
 * 是整屏镜像（不是窗口级），所以：
 *   · 一个宿主显示只能有一个会话（singleton），多个图标共用它
 *   · 新程序用 `xpra control :N start` 丢进去，而不是每个应用开一个窗口
 *   · 手机上看到的是缩放后的整块桌面，不如 seamless 好用 —— 所以它排在 xpra 后面
 *
 * ── 为什么仍然需要 xpra ─────────────────────────────────────────
 * 把 X 协议转成 WebSocket + HTML5 客户端这件事本身要有人做。宿主上的 x11vnc
 * + noVNC 也能做（见 README 的降级路线），但那是另一套 provider；这里用 xpra
 * 的 shadow 模式，一条命令解决，不额外拉依赖。
 */

const cp = require('child_process');

/**
 * 探测。
 *
 * 三个条件缺一不可：Linux、宿主有活着的 X socket、装了 xpra 做协议转换。
 * 缺哪个就说哪个 —— 前端据此显示「方案一不可用」而不是笼统的「不可用」。
 */
function probe(e) {
  if (!e || !e.linux) {
    return { ok: false, missing: [], hint: '仅支持 Linux（当前 ' + ((e && e.platform) || '未知') + '）' };
  }
  if (!e.display) {
    return { ok: false, missing: [], hint: '没有检测到正在运行的 X 服务器（$DISPLAY 为空或 socket 不存在）' };
  }
  if (!e.bins.xpra) {
    return { ok: false, missing: ['xpra'], hint: '直通模式需要 xpra 做协议转换：apt install xpra' };
  }
  return { ok: true, version: '', display: e.display };
}

function available(e) {
  return !!(e && e.linux && e.display && e.bins.xpra);
}

/**
 * `xpra shadow` 而不是 `xpra start --xvfb=no`：
 * 后者在部分版本里会尝试自己接管显示号，宿主上已经有 X 时会冲突退出。
 * shadow 的语义就是「附着到别人开的显示上」，最明确。
 */
function argv(s) {
  const a = [
    'shadow', s.hostDisplay,
    '--daemon=no',
    '--html=on',
    '--bind-tcp=0.0.0.0:' + s.port,
    '--encoding=png',
    '--tray=no',
    '--pulseaudio=no',
    '--mdns=no',
    '--notifications=no',
    '--printing=no',
    '--webcam=no',
    // 不加这条，xpra 会去跑发行版的 /etc/X11/Xsession（参数是 "true"），
    // 容器里那个脚本常常失败并在页面上弹一个 xmessage：「unable to launch
    // "true" X session」。给它一个真实存在的、什么都不做的程序堵住这条路。
    '--start=/bin/true',
  ];
  return a;
}

/**
 * 后续程序：会话已经在跑，用 control 通道再起一个。
 * 这条路径在 xpra 里是「在会话的显示上执行命令」，进程归 xpra 管，关会话一起收。
 */
function launch(s, cmd) {
  return new Promise((resolve, reject) => {
    const c = cp.spawn('xpra', ['control', s.hostDisplay, 'start', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d.toString(); });
    c.on('error', reject);
    c.on('exit', (code) => (code === 0 ? resolve(true) : reject(new Error(err.trim() || ('control 失败 ' + code)))));
  });
}

function urlPath() {
  return '/?floating_menu=no&sound=no';
}

/**
 * 关闭：native 会话关掉时**不能**杀掉宿主的 X server —— 那是用户自己的桌面。
 * 只停 xpra 这一层转发，宿主上的程序继续跑。
 */
function stop(s, child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const killer = cp.spawn('xpra', ['stop', s.hostDisplay], { stdio: 'ignore' });
    killer.on('error', finish);
    killer.on('exit', finish);
    setTimeout(finish, 3000);
  });
}

module.exports = {
  name: 'native',
  label: '系统原生 X11 直通',
  kind: 'screen',
  singleton: true,
  probe, available, argv, launch, urlPath, stop,
};
