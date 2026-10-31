'use strict';

/**
 * X11 会话管理 —— 一个 RunX 窗口 = 一个 X11 会话。
 *
 * ── 为什么一个窗口一个会话，而不是一个全局 X 服务器 ─────────────────
 * 全局会话意味着「关掉任意一个窗口里的应用，别的窗口也跟着没了」，而且所有
 * 图形应用挤在同一个显示号上，谁崩了都牵连别人。一次会话一个显示号 / 一个
 * 端口，窗口关掉就是进程组被收掉，彼此隔离得干净。
 *
 * 代价是每个会话有一份 Xvfb + xpra 的内存开销（实测空会话约 40MB）。对一个
 * 个人桌面来说这没问题：同时开三个图形应用的场景本来就不多，而每个会话都能
 * 独立重启才是用户真正在意的。
 *
 * native（整屏直通）是唯一例外：宿主显示只有一个，开两个会话就是同一个桌面
 * 镜像两遍。所以它标了 singleton —— 第二次点图标复用已有会话，只把命令丢进去。
 *
 * ── 这个文件管什么 ─────────────────────────────────────────────
 * provider 选择、显示号与端口分配、进程启动与就绪等待、注册表持久化、崩溃后
 * 清理、优雅关闭。**不**管「怎么起一个后端」—— 那是 provider 的事。
 */

const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const probe = require('./probe');

const DISPLAY_MIN = 100;
const DISPLAY_MAX = 199;
const PORT_MIN = 14700;
const PORT_MAX = 14799;
const READY_TIMEOUT = 25000;

const PROVIDERS = [
  require('./providers/xpra'),
  require('./providers/native'),
];

function createManager(opts) {
  const root = opts.root;
  const log = opts.log || function () {};
  const dir = path.join(root, 'var', 'x11');
  const sessions = new Map();     // id -> session
  const onGone = opts.onGone || function () {};   // 会话自己死掉时的回调

  function ensureDir() {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 只读根目录下也无所谓 */ }
  }

  /**
   * 注册表落盘。
   *
   * 存在的理由只有一个：RunX 自己被 kill -9 时，xpra 进程组会活下来占着显示号
   * 和端口。下次启动读这份文件，把还活着的旧会话收掉，否则用户会看到「新会话
   * 起不来，但也没人报错」。
   */
  function persist() {
    ensureDir();
    const list = [];
    for (const s of sessions.values()) {
      list.push({
        id: s.id, provider: s.provider, display: s.display, port: s.port, pid: s.pid,
        cmd: s.cmd, started_at: s.started_at,
      });
    }
    try { fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(list, null, 0)); }
    catch (e) { log('x11 注册表写入失败：' + e.message); }
  }

  function pidIsXpra(pid) {
    try {
      const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
      return cmd.indexOf('xpra') >= 0;
    } catch (e) {
      return false;
    }
  }

  /** 启动时收尸：只杀「cmdline 里确实有 xpra」的旧 pid，避免误伤复用了 pid 的进程 */
  function reap() {
    const file = path.join(dir, 'sessions.json');
    let old = [];
    try { old = JSON.parse(fs.readFileSync(file, 'utf8')) || []; } catch (e) { old = []; }
    let n = 0;
    for (const s of old) {
      if (!s || !s.pid) continue;
      if (!pidIsXpra(s.pid)) continue;
      try { process.kill(-s.pid, 'SIGTERM'); } catch (e) { try { process.kill(s.pid, 'SIGTERM'); } catch (e2) { /* 已经没了 */ } }
      n++;
      // 被杀掉的会话不会自己收拾干净，等一会再清它的显示号
      if (s.display) setTimeout(() => cleanDisplay(s.display), 1200).unref();
    }
    if (n) log('收掉 ' + n + ' 个残留的 X11 会话');
    // 注册表可能早就丢了（被清理过、或者上一版还没写注册表），所以再扫一遍
    // 我们自己的显示号段：锁文件里的 pid 已死就一并清掉。
    let swept = 0;
    for (let i = DISPLAY_MIN; i <= DISPLAY_MAX; i++) {
      if (cleanDisplay(i)) swept++;
    }
    if (swept) log('清掉 ' + swept + ' 个残留的显示号');
    persist();
    return n;
  }

  /**
   * 清掉一个「已经死了但文件还在」的显示号。
   *
   * Xvfb 被 SIGKILL 时来不及删 /tmp/.X<n>-lock 与 /tmp/.X11-unix/X<n>，而
   * pickDisplay() 是看这两个文件判断占用的 —— 不清就会一路跳过，开够三次以后
   * 显示号用满，用户看到「没有空闲的显示号」却 ps 不到任何 X 进程。
   *
   * 判据是锁文件里的 pid 还活不活着，而不是文件在不在：别的 X server 正在用
   * 的显示号，锁文件里的 pid 是活的，绝不能动。
   */
  function cleanDisplay(n) {
    const lock = '/tmp/.X' + n + '-lock';
    const sock = '/tmp/.X11-unix/X' + n;
    let alive = false;
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(lock, 'utf8').trim());
      if (pid) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; } }
    } catch (e) { /* 没有锁文件：可能是 socket 孤儿，按死的处理 */ }
    if (alive) return false;
    let removed = false;
    try { fs.unlinkSync(lock); removed = true; } catch (e) { /* 本来就没有 */ }
    try { fs.unlinkSync(sock); removed = true; } catch (e) { /* 同上 */ }
    return removed;
  }

  /** 显示号：避开已有的 X socket / 锁文件，也避开本进程已分配的 */
  function pickDisplay(e) {
    const used = new Set();
    for (const s of sessions.values()) used.add(s.display);
    // 宿主自己的显示号也不能占：native 模式下它就是我们的目标
    const hostNum = e.display ? Number(String(e.display).replace(/^:/, '').split('.')[0]) : -1;
    for (let n = DISPLAY_MIN; n <= DISPLAY_MAX; n++) {
      if (used.has(n) || n === hostNum) continue;
      if (fs.existsSync('/tmp/.X' + n + '-lock')) continue;
      if (fs.existsSync('/tmp/.X11-unix/X' + n)) continue;
      return n;
    }
    const err = new Error('没有空闲的显示号了（' + DISPLAY_MIN + '–' + DISPLAY_MAX + ' 已用满）');
    err.code = 503;
    throw err;
  }

  function portFree(port) {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      try { srv.listen(port, '0.0.0.0'); } catch (e) { resolve(false); }
    });
  }

  async function pickPort() {
    const used = new Set();
    for (const s of sessions.values()) used.add(s.port);
    for (let p = PORT_MIN; p <= PORT_MAX; p++) {
      if (used.has(p)) continue;
      if (await portFree(p)) return p;
    }
    const err = new Error('没有空闲端口了（' + PORT_MIN + '–' + PORT_MAX + ' 已用满）');
    err.code = 503;
    throw err;
  }

  /** 选 provider：显式指定优先，否则按 PROVIDERS 顺序取第一个可用的 */
  async function pickProvider(e, want) {
    if (want) {
      const p = PROVIDERS.find((x) => x.name === want);
      if (!p) throw Object.assign(new Error('未知的 X11 后端：' + want), { code: 422 });
      const r = await p.probe(e);
      if (!r.ok) {
        throw Object.assign(new Error(r.hint || (p.label + ' 不可用')), {
          code: 501, code_name: 'X11_BACKEND_UNAVAILABLE', hint: r.hint || '',
        });
      }
      return p;
    }
    for (const p of PROVIDERS) {
      if (!p.available(e)) continue;
      const r = await p.probe(e);
      if (r.ok) return p;
    }
    return null;
  }

  /**
   * 探测全部后端 —— 返回给前端做决策的结构。
   *
   * 这里不做「不可用就抛错」：不可用是**正常状态**，用户可能正打算去装。
   * 所以返回 ok:false + install 建议，前端据此画对话框。
   */
  async function status() {
    const e = probe.env();
    if (!e.usable) return probe.unsupported(e);

    const backends = [];
    for (const p of PROVIDERS) {
      const r = await p.probe(e);
      backends.push({
        id: p.name,
        label: p.label,
        kind: p.kind,
        ok: !!r.ok,
        version: r.version || '',
        hint: r.hint || '',
        missing: r.missing || [],
      });
    }
    const best = backends.find((b) => b.ok);
    return {
      ok: !!best,
      platform: e.platform,
      supported: true,
      display: e.display || null,
      backends,
      recommended: best ? best.id : null,
      install: best ? [] : installHints(backends, e),
      sessions: list(),
    };
  }

  /**
   * 把「缺什么」翻成「可以照着敲的命令」。
   *
   * 只给包管理器的命令，不做自动安装：apt install 需要 root，RunX 通常以普通
   * 用户跑；而且 100MB 的下载应该由用户自己决定什么时候开始。
   */
  function installHints(backends, e) {
    const out = [];
    const all = backends.flatMap((b) => b.missing);
    const distro = readDistro();
    if (all.indexOf('xpra') >= 0) {
      out.push({
        id: 'xpra',
        title: '安装 Xpra 无缝窗口服务（推荐）',
        body: '提供窗口级转发、剪贴板与断线重连，一个窗口里可以同时开多个 X 程序。',
        cmd: pkgCmd(distro, 'xpra'),
        size: '约 100MB',
        recommended: true,
      });
    }
    if (!e.display) {
      out.push({
        id: 'display',
        title: '启动一个桌面环境',
        body: '直通模式需要一个正在运行的 X 服务器。没有桌面环境时请用上面的 Xpra 方案。',
        cmd: '',
        size: '',
        recommended: false,
      });
    }
    return out;
  }

  function readDistro() {
    try {
      const txt = fs.readFileSync('/etc/os-release', 'utf8');
      const id = (/^ID=(.*)$/m.exec(txt) || [])[1];
      const like = (/^ID_LIKE=(.*)$/m.exec(txt) || [])[1] || '';
      return String(id || like || '').replace(/"/g, '').trim();
    } catch (e) { return ''; }
  }

  function pkgCmd(distro, pkg) {
    if (/debian|ubuntu|raspbian|linuxmint|pop/.test(distro)) return 'sudo apt install ' + pkg;
    if (/fedora|rhel|centos/.test(distro)) return 'sudo dnf install ' + pkg;
    if (/arch|manjaro/.test(distro)) return 'sudo pacman -S ' + pkg;
    if (/alpine/.test(distro)) return 'sudo apk add ' + pkg;
    if (/opensuse|suse/.test(distro)) return 'sudo zypper install ' + pkg;
    return 'sudo apt install ' + pkg;
  }

  /**
   * 等会话就绪。
   *
   * 判据是「HTTP 端口能返回 200」，不是「进程还活着」—— xpra 起来以后还要建
   * 显示、加载 www 目录，这段时间窗口里会是一片白。等到真能发页面了再开窗口，
   * 用户的感受是「点一下，窗口就带着内容出现」。
   */
  function waitReady(port, child, deadline) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };

      const onExit = (code, signal) => {
        clearTimeout(timer);
        done(reject, Object.assign(
          new Error('X11 会话启动失败（xpra 退出 code=' + code + ' signal=' + signal + '）'),
          { code: 502 }));
      };
      child.once('exit', onExit);

      const timer = setTimeout(() => {
        child.removeListener('exit', onExit);
        done(reject, Object.assign(new Error('X11 会话启动超时（' + READY_TIMEOUT / 1000 + ' 秒）'), { code: 504 }));
      }, Math.max(1000, deadline - Date.now()));

      const tick = () => {
        if (settled) return;
        if (Date.now() > deadline) return;   // 交给 timer 报超时
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1200 }, (res) => {
          res.resume();
          if (res.statusCode === 200) {
            child.removeListener('exit', onExit);
            clearTimeout(timer);
            done(resolve, true);
          } else {
            setTimeout(tick, 250);
          }
        });
        req.on('error', () => setTimeout(tick, 250));
        req.on('timeout', () => { req.destroy(); });
      };
      tick();
    });
  }

  function logTail(file, lines) {
    try {
      const txt = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
      return txt.slice(-(lines || 4)).join(' / ');
    } catch (e) { return ''; }
  }

  /**
   * 起一个会话。
   *
   * @param {{cmd:string, label?:string, winId?:string, provider?:string, force?:boolean}} o
   * @returns {Promise<{id,port,display,path,provider,pid,reused?}>}
   */
  async function create(o) {
    const e = probe.env();
    if (!e.usable && !o.force) return Promise.reject(probe.unsupported(e));

    const pv = await pickProvider(e, o.provider);
    if (!pv) {
      const st = await status();
      const hint = st.install && st.install.length
        ? st.install.map((i) => i.title + (i.cmd ? '：' + i.cmd : '')).join('；')
        : '没有可用的 X11 后端';
      throw Object.assign(new Error('没有可用的 X11 后端。' + hint), {
        code: 501, code_name: 'X11_NO_BACKEND', status: st,
      });
    }

    /* singleton：宿主显示只有一个，第二个窗口直接复用第一个会话，把命令丢进去。
       这不是省资源的小聪明 —— 整屏镜像开两份，用户会看到两个窗口里是同一个桌面，
       点哪个都动，比报错更让人困惑。 */
    if (pv.singleton) {
      for (const s of sessions.values()) {
        if (s.provider !== pv.name) continue;
        if (pv.launch && o.cmd) {
          try { await pv.launch(s, o.cmd); }
          catch (err) {
            throw Object.assign(new Error('在已有会话里启动命令失败：' + err.message), { code: 502 });
          }
        }
        return { id: s.id, port: s.port, display: s.display, path: pv.urlPath(s), provider: pv.name, pid: s.pid, reused: true };
      }
    }

    const display = pickDisplay(e);
    const port = await pickPort();
    const id = 'x' + display + '-' + port;
    ensureDir();
    const logPath = path.join(dir, id + '.log');

    const spec = { display, port, cmd: o.cmd, hostDisplay: e.display };
    const args = pv.argv(spec);
    let fd;
    try {
      fd = fs.openSync(logPath, 'w');
    } catch (err) {
      fd = 'ignore';
    }

    // detached 让会话自成一个进程组：关窗口时 kill(-pid) 能连同它拉起的每个
    // X 客户端一起收掉。否则 xterm / gimp 会变成孤儿进程，继续占着内存。
    let child;
    try {
      child = cp.spawn('xpra', args, {
        detached: true,
        stdio: ['ignore', fd === 'ignore' ? 'ignore' : fd, fd === 'ignore' ? 'ignore' : fd],
      });
    } catch (err) {
      throw Object.assign(new Error('无法启动 xpra：' + err.message), { code: 502 });
    }
    if (fd !== 'ignore') { try { fs.closeSync(fd); } catch (err) { /* 已关 */ } }

    const started_at = Date.now();
    const s = {
      id, provider: pv.name, display, port, cmd: o.cmd, hostDisplay: e.display,
      label: o.label || o.cmd, winId: o.winId || null,
      pid: child.pid, child, started_at, logPath,
    };
    sessions.set(id, s);

    child.on('error', (err) => {
      sessions.delete(id);
      persist();
      log('x11 会话 ' + id + ' 进程错误：' + err.message);
    });

    child.on('exit', (code, signal) => {
      // 主动 stop() 时 sessions 里已经删掉了，这里只处理「自己死的」情况
      if (!sessions.has(id)) return;
      sessions.delete(id);
      persist();
      log('x11 会话 ' + id + ' 退出（code=' + code + ' signal=' + signal + '）');
      onGone(id, { code, signal, logPath, winId: s.winId });
    });

    try {
      await waitReady(port, child, started_at + READY_TIMEOUT);
    } catch (err) {
      const tail = logTail(logPath, 4);
      stopSession(s, pv, true);
      sessions.delete(id);
      persist();
      throw Object.assign(new Error(err.message + (tail ? '：' + tail : '')), { code: err.code || 502, hint: tail });
    }

    // 会话起来了，但有些 provider 的命令不是随会话启动的（native 是镜像宿主，
    // 没有 --start 这回事），得等它就绪后用 control 通道丢进去。
    if (pv.launch && o.cmd) {
      try {
        await pv.launch(s, o.cmd);
      } catch (err) {
        // 会话本身是好的，命令没起来只影响这一个应用：留着窗口让用户看到桌面，
        // 比把整个会话拆掉更合理。
        log('在 ' + pv.name + ' 会话里启动命令失败：' + err.message);
      }
    }

    persist();
    log('X11 会话 ' + id + ' 就绪（' + pv.name + '，display :' + display + '，端口 ' + port + '，' + o.cmd + '）');
    return { id, port, display, path: pv.urlPath(s), provider: pv.name, pid: s.pid };
  }

  /** 关一个会话：先走 provider 的优雅关闭，超时就强杀整个进程组 */
  function stopSession(s, pv, force) {
    const kill = () => {
      // native 会话绝不能杀进程组：那会连宿主的 X server 一起带走
      if (s.provider === 'native') {
        try { s.pid && process.kill(s.pid, 'SIGTERM'); } catch (e) { /* 已经没了 */ }
        return;
      }
      try { process.kill(-s.pid, 'SIGKILL'); }
      catch (e) { try { s.pid && process.kill(s.pid, 'SIGKILL'); } catch (e2) { /* 已经没了 */ } }
    };
    if (force) return kill();

    return Promise.resolve(pv.stop(s, s.child))
      .then(() => {
        // 优雅关闭返回后进程可能还没走完，给它 1.5 秒；还活着就收进程组
        return new Promise((resolve) => {
          const t = setTimeout(() => { kill(); resolve(); }, 1500);
          s.child.once('exit', () => { clearTimeout(t); resolve(); });
          if (s.child.exitCode !== null) { clearTimeout(t); resolve(); }
        });
      })
      .catch(() => kill());
  }

  async function stop(id) {
    const s = sessions.get(id);
    if (!s) return { ok: true, already: true };
    const pv = PROVIDERS.find((p) => p.name === s.provider) || PROVIDERS[0];
    sessions.delete(id);      // 先摘掉：exit 事件里就不会再触发 onGone
    persist();
    await stopSession(s, pv, false);
    // 强杀路径下 Xvfb 来不及删 socket/lock，留着会把显示号越吃越少
    if (s.provider !== 'native') setTimeout(() => cleanDisplay(s.display), 300).unref();
    log('X11 会话 ' + id + ' 已关闭');
    return { ok: true };
  }

  function list() {
    return [...sessions.values()].map((s) => ({
      id: s.id, provider: s.provider, display: s.display, port: s.port,
      cmd: s.cmd, label: s.label, pid: s.pid, started_at: s.started_at, winId: s.winId,
    }));
  }

  function stopAll() {
    const ids = [...sessions.keys()];
    return Promise.all(ids.map((id) => stop(id)));
  }

  return { status, probe: status, create, stop, list, stopAll, reap, cleanDisplay, dir };
}

module.exports = { createManager, PROVIDERS, PORT_MIN, PORT_MAX, DISPLAY_MIN, DISPLAY_MAX };
