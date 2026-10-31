'use strict';

/**
 * Xpra provider —— 一个 RunX 窗口 = 一个 xpra seamless 会话。
 *
 * ── Provider 契约 ────────────────────────────────────────────────
 * provider 只回答三个问题：**装没装**、**怎么起**、**怎么停**。显示号/端口
 * 分配、进程生命周期、注册表持久化都由 manager.js 统一处理 —— 换后端
 * （kasmvnc / 原生直通）时不用重写这些。
 *
 *   {
 *     name:   'xpra',                  // 稳定标识，写进会话记录
 *     label:  'Xpra 无缝窗口',          // 给人看的名字
 *     kind:   'seamless' | 'screen',   // 窗口级 / 整屏级
 *     probe(env): Promise<{ok, version?, hint?, missing?}>
 *     argv(s): string[]                // s = {display, port, cmd}
 *     urlPath(s): string               // 前端 iframe 的路径部分（含查询串）
 *     stop(s, child): Promise<void>    // 优雅关闭；超时由调用方强杀进程组
 *   }
 *
 * `cmd` 是用户给的命令串（可能带引号）。provider 不解析它，原样交给自己信任的
 * 执行器 —— 对 xpra 而言是 `--start=...`，argv 数组直传，不经过 shell。
 *
 * ── 为什么是 seamless 而不是「一块屏」──────────────────────────────
 * seamless 是窗口级协议：X 应用各自的窗口直接变成 HTML5 客户端里的窗口，没有
 * 窗口管理器、没有虚拟桌面背景。一个会话里可以同时开 xterm、xclock、gimp，它们
 * 是**三个窗口**而不是一张截图，文本还能选中复制（剪贴板直通）。KasmVNC 那种
 * 整屏像素方案在这里是错的：手机上你会得到一张缩小的 1920×1080 截图。
 */

const cp = require('child_process');

let cache = null;   // {at, value}

/**
 * 探测 `xpra` 是否可用。
 *
 * 结果缓存 60 秒：桌面每次打开「新建」对话框都会问一次，没必要每次 fork 一个
 * python 进程；但也不能永久缓存 —— 用户可能正开着桌面去 apt install。
 */
function probe(e) {
  const now = Date.now();
  if (cache && now - cache.at < 60000 && cache.bin === (e && e.bins.xpra)) {
    return Promise.resolve(cache.value);
  }
  const bin = (e && e.bins.xpra) || 'xpra';

  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      cache = { at: Date.now(), value, bin: (e && e.bins.xpra) || null };
      resolve(value);
    };

    if (e && !e.bins.xpra) {
      return finish({
        ok: false,
        missing: ['xpra'],
        hint: '没有找到 xpra 命令。Debian/Ubuntu：apt install xpra（约 100MB）',
      });
    }

    let child;
    try {
      child = cp.spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return finish({ ok: false, missing: ['xpra'], hint: '无法执行 xpra：' + err.message });
    }

    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', () => finish({
      ok: false,
      missing: ['xpra'],
      hint: '找不到 xpra 命令。Debian/Ubuntu 上：apt install xpra',
    }));
    child.on('exit', (code) => {
      if (code !== 0) return finish({ ok: false, hint: 'xpra 无法运行（退出码 ' + code + '）' });
      // `xpra --version` 输出形如 "xpra v3.1.5"
      const m = /(\d+\.\d+(?:\.\d+)?)/.exec(out);
      const version = m ? m[1] : '';
      const major = version ? Number(version.split('.')[0]) : 0;
      // HTML5 客户端从 3.0 起随发行包提供，更早的版本要另装 www 目录
      if (major && major < 3) {
        return finish({ ok: false, version, hint: 'xpra ' + version + ' 太旧，需要 3.0+' });
      }
      finish({ ok: true, version });
    });
  });
}

/** xpra 只在 Linux 上可用；Termux 里 xpra 包是给 x86 编译的，装了也跑不起来 */
function available(e) {
  return !!(e && e.linux && e.bins.xpra);
}

/** 用户刚敲完 apt install 就点「重试」，不该还读到上一分钟的「没装」 */
function resetCache() {
  cache = null;
}

/**
 * 组命令行。
 *
 * 几个不能省的开关：
 *   --daemon=no         前台跑，父进程就是会话本身：关窗口 = 杀进程，不留僵尸
 *   --html=on           由 xpra 自己发 HTML5 客户端，不必再搭一层代理
 *   --start=...         会话起来就把应用拉起来，用户不用先看一个空桌面
 *   --encoding=png      无损。默认会协商到 h264，终端文字直接糊成一片
 *   --notifications=no  通知由 RunX 统一发（host.notify），别两边都弹
 *
 * 一律用 `--key=value` 而不是 `--no-key`：两种写法在不同大版本里各有缺席，
 * 显式赋值最稳。xpra 对**不认识的选项是直接退出**的（不是忽略），所以这里
 * 只保留 3.x 以来一直存在的开关。
 */
function argv(s) {
  const a = [
    'start', ':' + s.display,
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
  ];
  if (s.cmd) a.push('--start=' + s.cmd);
  return a;
}

/**
 * 前端地址里的查询串。
 *
 * floating_menu=no —— xpra 自带的浮动工具条（菜单 / 全屏 / 音量）和 RunX 的窗口
 * 工具条完全重复，两个叠在一起用户不知道点哪个。关掉它，全屏交给 RunX。
 * sound=no —— 音频还没接进 RunX 的语音链路，客户端开着只会报「服务器不支持」。
 */
function urlPath() {
  return '/?floating_menu=no&sound=no';
}

/**
 * 优雅关闭：走 `xpra stop :N`，它会顺手收掉会话里的 X 客户端。
 * 3 秒还没走人就返回，由调用方强杀整个进程组。
 */
function stop(s, child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const killer = cp.spawn('xpra', ['stop', ':' + s.display], { stdio: 'ignore' });
    killer.on('error', finish);
    killer.on('exit', finish);
    setTimeout(finish, 3000);
  });
}

module.exports = {
  name: 'xpra', label: 'Xpra 无缝窗口', kind: 'seamless',
  probe, available, resetCache, argv, urlPath, stop,
};
