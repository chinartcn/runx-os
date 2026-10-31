'use strict';

/**
 * 伪 PTY 会话管理（基于 util-linux 的 `script`，零原生依赖）。
 *
 * 为什么不用 node-pty：需要 node-gyp 编译原生模块，离线/受限环境常失败。
 * `script -qfec 'bash -i' /dev/null` 由 util-linux 提供真实 PTY（termios +
 * 信号 + 行编辑 + 颜色），Termux 自带，零依赖。
 *
 * ## resize 为什么不重建会话
 *
 * `script` 自身没有设置窗口尺寸的接口，所以历史上 resize 是靠“杀掉整组
 * 重开一个 shell”实现的 —— 代价是前台程序（vi / top / ssh / 正在跑的
 * 构建）全部被终止，shell 变量、目录、命令历史也一并丢失。拖动窗口
 * 边缘时会连续触发十几次 resize，等于反复杀进程。
 *
 * 但“script 不给接口”不等于“改不了尺寸”：PTY 的 winsize 属于内核设备
 * 属性，只要拿到 slave 设备路径，任何进程都能用 `stty -F /dev/pts/N
 * rows R cols C` 去 ioctl(TIOCSWINSZ)，内核随即向该 PTY 的前台进程组
 * 发送 SIGWINCH —— 这正是 xterm、gnome-terminal 等真终端 resize 做的事。
 *
 * 所以启动时让内层 shell 把 `tty` 的结果写进一个临时文件（不进 PTY
 * 输出流），Node 侧读一次即得 slave 路径；此后 resize 只跑一条 stty。
 * 进程、前台程序、shell 状态全部原地保留。
 *
 * 拿不到路径（异常 shell / 受限环境）或 stty 不可用时，仍回落到
 * “重建会话”，保证功能不丢 —— 见 SessionManager.respawn()。
 *
 * 进程组：spawn 时 detached:true 让 script 成为进程组组长，
 * 清理时 process.kill(-pid, sig) 一次性回收 script + bash + 其后台孙进程，
 * 避免窗口关了、shell 还活着的僵尸问题。
 */

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SHELL = process.env.TERM_SHELL || 'bash';
// 交互式 shell 参数。默认 `-i`（读取用户 rc，得到真实环境/别名/PATH）。
// 注意 bash 要求 GNU 长选项（--norc 等）排在短选项（-i）之前，故本值拼在 `-i` 前面。
// 若用户 rc 与 bash 不兼容（如误 source 了 zsh 补全脚本），可设 TERM_SHELL_ARGS='--norc --noprofile'。
const SHELL_ARGS = process.env.TERM_SHELL_ARGS || '';
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const IDLE_MS = 30 * 60 * 1000;   // 30 分钟无连接且无输入 → 回收
const GRACE_MS = 5000;            // conn 全断后宽限
const KILL_GRACE_MS = 500;        // SIGTERM → SIGKILL 间隔

// PTY slave 路径的采集窗口：正常 <100ms 就能拿到，给足容错但绝不无限等
const TTY_DIR = process.env.TERM_TTY_DIR || os.tmpdir();
const TTY_WAIT_MS = 2000;
const TTY_POLL_MS = 40;
// slave 路径来自 `tty` 的输出，仍按白名单校验后再拼进命令行（防止
// 异常 shell 输出被当成参数注入）
const TTY_PATH_RE = /^\/dev\/pts\/\d+$/;

/** 定时器时长归一化：非法值（NaN/undefined/字符串）回落默认，防 setTimeout(NaN) → 1ms 空转 */
function safeMs(v, dflt, min, max) {
  let n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) n = dflt;
  return Math.min(max, Math.max(min, n));
}

const MAX_SESSIONS = safeMs(Number(process.env.TERM_MAX_SESSIONS), 8, 1, 256);

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 's' + Date.now() + Math.random().toString(16).slice(2));

/* ── 探测 `script` 的能力（-e 传退出码 / -f flush）── */
let SCRIPT_SUPPORT = null; // { ret:boolean, flush:boolean } | false
function probeScript() {
  if (SCRIPT_SUPPORT !== null) return SCRIPT_SUPPORT;
  try {
    cp.execFileSync('script', ['-qec', 'true', '/dev/null'], { stdio: 'ignore', timeout: 3000 });
    SCRIPT_SUPPORT = { ret: true, flush: true };
  } catch (e) {
    if (e && e.code === 'ENOENT') { SCRIPT_SUPPORT = false; }
    else {
      // -e 可能不被支持，退回不带 -e（退出码取不到，用 signal 兜底）
      try {
        cp.execFileSync('script', ['-qc', 'true', '/dev/null'], { stdio: 'ignore', timeout: 3000 });
        SCRIPT_SUPPORT = { ret: false, flush: true };
      } catch (e2) {
        SCRIPT_SUPPORT = (e2 && e2.code === 'ENOENT') ? false : { ret: false, flush: true };
      }
    }
  }
  return SCRIPT_SUPPORT;
}

/**
 * 构造 `script` 启动参数。
 *
 * 关键：`script` 自己分配 PTY 时用默认尺寸（实测 devpts 下是 0x0，也就是
 * `stty size` 报 "0 0"），且没有设置尺寸的命令行选项。由于该 PTY 就是
 * 子 shell 的 stdin/stdout，我们在 PTY 内先 `stty rows/cols` 设定 winsize，
 * 再把 slave 路径落盘供后续 resize 使用，最后 `exec` 进交互式 shell。
 *
 * 注意 `tty` 读的是 fd 0（PTY slave），但输出被重定向到文件，所以不会
 * 在终端里留下任何字符。
 */
function scriptArgs(cols, rows, ttyFile, spec) {
  const sup = probeScript();
  const flags = sup.ret ? '-qfec' : '-qfc';
  let inner = 'stty rows ' + rows + ' cols ' + cols + ' 2>/dev/null;';
  if (ttyFile) inner += " tty > " + shq(ttyFile) + ' 2>/dev/null;';
  inner += ' exec ' + (spec ? cmdText(spec) : shellText());
  return [flags, inner, '/dev/null'];
}

/** 默认会话：交互式登录 shell */
function shellText() {
  const args = SHELL_ARGS ? SHELL_ARGS.split(/\s+/).filter(Boolean) : [];
  return [SHELL].concat(args).concat(['-i']).join(' ');
}

/**
 * 把 spec 变成一条 `exec` 得动的命令行。
 *
 * 两条路必须分开，不能混：
 *   · shell=false —— 每个 argv 单独引号包裹。命令是**数据**，`;`、`|`、`$(...)`
 *     在参数里就只是普通字符，不可能借它拼出第二条命令。
 *   · shell=true  —— 整串交给 `sh -c`。用户显式要管道 / `&&` / 重定向时才有意义，
 *     此时命令就是代码，安全性只能靠「谁能创建这个快捷方式」来保证（只有本机 UI）。
 *
 * ⚠ 不能在 argv 模式下直接 `exec ls | grep`：`exec` 只作用于第一个命令，
 *   管道会额外 fork 一层，`exec` 的「替换当前进程」语义就丢了 —— 关闭窗口
 *   时杀的还是中间那层 shell，真正的程序会变孤儿。所以 shell 模式一律再套
 *   `sh -c`，让 exec 作用在 sh 上，sh 自己接管管道。
 */
function cmdText(spec) {
  if (spec.shell) return 'sh -c ' + shq(spec.argv.join(' '));
  return spec.argv.map(shq).join(' ');
}

/** 会话名：优先用用户起的名字，否则取命令首词的文件名 */
function cmdName(spec) {
  if (spec.label) return spec.label;
  const first = spec.shell ? spec.argv.join(' ') : spec.argv[0];
  const word = String(first || '').trim().split(/\s+/)[0] || SHELL;
  return path.basename(word);
}

/**
 * 校验并规整一个会话描述。
 *
 * 只做形状检查（是谁、跑什么、在哪跑），不判断命令是否存在 —— 不存在的命令
 * 会由 shell 自己报「command not found」，那条错误信息对用户更有用。
 *
 * @returns {null|{argv:string[],shell:boolean,cwd:string|null,label:string|null,ephemeral:boolean}}
 */
function normalizeSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let argv = raw.argv != null ? raw.argv : raw.command;
  if (typeof argv === 'string') argv = [argv];
  if (!Array.isArray(argv)) return null;
  argv = argv.map((v) => String(v)).filter((v) => v.length > 0);
  if (!argv.length) return null;

  let cwd = null;
  if (raw.cwd) {
    const c = path.resolve(String(raw.cwd));
    try { if (fs.statSync(c).isDirectory()) cwd = c; } catch (e) { /* 不存在就回退默认目录 */ }
  }
  return {
    argv,
    shell: !!raw.shell,
    cwd,
    label: raw.label ? String(raw.label).slice(0, 80) : null,
    ephemeral: !!raw.ephemeral,
  };
}

/** 单引号包裹路径，防止临时目录里的空格 / 特殊字符破坏内层命令 */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * `stty -F <device>` 支持探测。
 *
 * GNU coreutils 与 util-linux 的 stty 都认 -F；BusyBox 的不认，但可以把
 * 设备直接接到 stty 的 stdin 上达到同样效果。这里探一次并缓存，避免每次
 * resize 都去试错。
 */
let STTY_FILE_MODE = null;
function probeSttyFileMode() {
  if (STTY_FILE_MODE !== null) return STTY_FILE_MODE;
  try {
    const r = cp.spawnSync('stty', ['-F', '/dev/null', 'rows', '24'],
      { encoding: 'utf8', timeout: 2000 });
    const err = String(r.stderr || '').toLowerCase();
    // 认 -F 时错误是 "Inappropriate ioctl for device"；
    // 不认时是 "invalid option" / "unrecognized option" / "illegal option"
    STTY_FILE_MODE = !/invalid option|unrecognized option|illegal option/.test(err);
  } catch (e) {
    STTY_FILE_MODE = false;
  }
  return STTY_FILE_MODE;
}

/**
 * 原地修改已存在 PTY 的窗口尺寸（不重建任何进程）。
 *
 * 成功时内核会向该 PTY 的前台进程组发 SIGWINCH，前台程序（vi / top /
 * ssh）据此自适应重绘，shell 变量与历史完全不受影响。
 *
 * @param {(ok:boolean)=>void} cb  stty 退出码为 0 时 ok=true
 */
function sttySetSize(tty, cols, rows, cb) {
  const args = ['rows', String(rows), 'cols', String(cols)];
  let settled = false;
  const done = (ok) => { if (settled) return; settled = true; cb(!!ok); };

  if (probeSttyFileMode()) {
    const ch = cp.spawn('stty', ['-F', tty].concat(args), { stdio: 'ignore' });
    ch.on('error', () => done(false));
    ch.on('exit', (code) => done(code === 0));
    return;
  }

  // BusyBox 等不认 -F：把 slave 设备本身接到 stty 的 stdin 上
  let fd;
  try { fd = fs.openSync(tty, 'r+'); } catch (e) { return done(false); }
  const closeFd = () => { try { fs.closeSync(fd); } catch (e) { /* ignore */ } };
  const ch = cp.spawn('stty', args, { stdio: [fd, 'ignore', 'ignore'] });
  ch.on('error', () => { closeFd(); done(false); });
  ch.on('exit', (code) => { closeFd(); done(code === 0); });
}

class Session {
  constructor(id, cols, rows, spec) {
    this.id = id;
    this.cols = cols;
    this.rows = rows;
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    // spec 为空 = 交互式 shell；有 spec = 跑指定命令（TUI 应用）
    this.spec = spec || null;
    this.name = spec ? cmdName(spec) : SHELL;
    this.title = this.name + ' ' + cols + 'x' + rows;
    this.proc = null;
    this.seq = 0;
    this.onOutput = null;   // (session, buf) => void
    this.onExit = null;     // (session, code, signal) => void
    this.silent = false;    // true 时丢弃子进程输出（重建/关闭期间用，屏蔽 script 的终止提示）
    this.ttyPath = null;    // PTY slave 路径（/dev/pts/N），拿到后 resize 走原地改尺寸
    this.ttyFile = path.join(TTY_DIR, 'runx-term-' + id + '.tty');
    this._ttyDone = false;  // slave 路径采集是否已结束（无论成功与否）
    this._ttyWait = null;   // 采集完成的 Promise，setSize 会等它
    this._ttyResolve = null;
    this._sizeBusy = false; // 正在跑 stty
    this._sizePending = null; // 高并发的 resize 只保留最新一档
  }

  start() {
    const sup = probeScript();
    if (!sup) throw new Error('script_unavailable');
    this.ttyPath = null;
    const args = scriptArgs(this.cols, this.rows, this.ttyFile, this.spec);
    const cwd = (this.spec && this.spec.cwd) ||
      process.env.TERM_ROOT_CWD || process.env.HOME || os.homedir() || process.cwd();
    const child = cp.spawn('script', args, {
      cwd,
      detached: true,
      env: Object.assign({}, process.env, {
        TERM: 'xterm-256color',
        LANG: process.env.LANG || 'C.UTF-8',
        COLUMNS: String(this.cols),
        LINES: String(this.rows),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = child;
    this.pid = child.pid;
    this.silent = false; // 新进程开始，恢复转发
    this._watchTty();

    const onData = (chunk) => {
      if (!chunk || !chunk.length) return;
      this.lastActive = Date.now();
      if (this.silent) return;             // 重建/关闭期间静默，丢弃旧进程尾巴
      if (this.onOutput) this.onOutput(this, chunk);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('exit', (code, signal) => {
      if (this.proc !== child) return; // 已被重建替代，忽略旧进程
      this.proc = null;
      if (this.onExit) this.onExit(this, code, signal);
    });
    child.on('error', () => { /* 由 exit 兜底 */ });

    return this;
  }

  /**
   * 轮询等 `tty > file` 把 slave 路径写出来。拿到后立刻删文件并停止轮询。
   * 全程异步且 unref，不会拖住进程退出。
   *
   * 结束时（成功或超时）都 resolve `this._ttyWait`：刚创建的会话被立刻
   * resize 时 setSize 需要等这一步，否则会把“还没拿到”误判成“拿不到”
   * 而白重建一次。
   */
  _watchTty() {
    const child = this.proc;
    let tries = 0;
    this._ttyDone = false;
    this._ttyWait = new Promise((resolve) => { this._ttyResolve = resolve; });

    const cleanup = () => { try { fs.unlinkSync(this.ttyFile); } catch (e) { /* ignore */ } };
    const finish = (ok) => {
      if (this._ttyDone) return;
      this._ttyDone = true;
      cleanup();
      if (this._ttyResolve) { const r = this._ttyResolve; this._ttyResolve = null; r(ok); }
    };
    const tick = () => {
      if (this.proc !== child) return finish(false); // 已重建或已关闭
      let v = '';
      try { v = String(fs.readFileSync(this.ttyFile, 'utf8')).trim(); } catch (e) { /* 还没写出来 */ }
      if (TTY_PATH_RE.test(v)) {
        this.ttyPath = v;
        return finish(true);
      }
      if (++tries * TTY_POLL_MS > TTY_WAIT_MS) return finish(false);
      const t = setTimeout(tick, TTY_POLL_MS);
      t.unref();
    };
    const t = setTimeout(tick, TTY_POLL_MS);
    t.unref();
  }

  /**
   * 把 PTY 尺寸改成 cols×rows，**不重建进程**。
   *
   * 拖动窗口时前端会高频发 resize，所以这里做合并：同一时刻只跑一个
   * stty，期间到达的请求覆盖为“最新一档”，跑完立刻处理。既保证最终
   * 尺寸正确，也不会因为乱序让最后一次 resize 被前面的覆盖掉。
   *
   * @returns {Promise<boolean>} false = 无法原地改（调用方应回落重建）
   */
  setSize(cols, rows) {
    return new Promise((resolve) => {
      const p = this._sizePending || (this._sizePending = { cols, rows, waiters: [] });
      p.cols = cols;
      p.rows = rows;
      p.waiters.push(resolve);
      if (!this._sizeBusy) this._drainSize();
    });
  }

  _drainSize() {
    const p = this._sizePending;
    if (!p) return;
    this._sizePending = null;
    const settle = (ok) => { for (const w of p.waiters) { try { w(ok); } catch (e) { /* ignore */ } } };

    const apply = () => {
      // 拿不到 slave 路径（受限环境 / 非 /dev/pts）→ 交给调用方走重建
      if (!this.ttyPath || this.proc === null) {
        settle(false);
        return this._drainSize();
      }
      this._sizeBusy = true;
      sttySetSize(this.ttyPath, p.cols, p.rows, (ok) => {
        this._sizeBusy = false;
        if (ok) {
          this.cols = clampCols(p.cols);
          this.rows = clampRows(p.rows);
          this.title = this.name + ' ' + this.cols + 'x' + this.rows;
        }
        settle(ok);
        this._drainSize(); // 处理 stty 期间堆积的最新一档
      });
    };

    // slave 路径还在采集窗口内 → 等它出结果再判定。刚创建的会话会被前端
    // 立刻 fit + resize，若此时直接判定“拿不到”就会白重建一次。
    if (!this.ttyPath && !this._ttyDone && this._ttyWait && this.proc !== null) {
      this._ttyWait.then(apply);
      return;
    }
    apply();
  }

  write(data) {
    this.lastActive = Date.now();
    if (this.proc && this.proc.stdin.writable) {
      try { this.proc.stdin.write(data); } catch { /* ignore */ }
    }
  }

  /**
   * 杀整个进程组。交互式 shell 常常忽略 SIGTERM，所以：
   *   1) 先 SIGTERM 整组（给前台程序机会优雅退出）
   *   2) KILL_GRACE_MS 后 SIGKILL 整组（此时 shell 也会被强杀）
   *   3) 若组杀仍失败，遍历 /proc 找到组内残留 pid 逐个 SIGKILL 兜底
   * 完成后才回调 onDone —— respawn 依赖这一点，确保旧进程先死再起新的。
   */
  kill(onDone) {
    const child = this.proc;
    this.proc = null; // 断开关联，避免旧进程 exit 回调重复触发 onExit
    this.silent = true; // 屏蔽 script 被杀时打印的 "Session terminated, killing shell..."
    this.ttyPath = null;
    try { fs.unlinkSync(this.ttyFile); } catch (e) { /* ignore */ }
    // 采集窗口若还挂着，放它出来（否则 setSize 里 await 它的调用永远不返回）
    if (this._ttyResolve) {
      const r = this._ttyResolve;
      this._ttyResolve = null;
      this._ttyDone = true;
      r(false);
    }
    // 挂起的 resize 等待者统一放掉，否则 Promise 永远不 resolve
    const pend = this._sizePending;
    this._sizePending = null;
    if (pend) for (const w of pend.waiters) { try { w(false); } catch (e) { /* ignore */ } }
    if (!child || !child.pid) { if (onDone) onDone(); return; }
    const pid = child.pid;

    const groupKill = (s) => {
      try { process.kill(-pid, s); return true; }
      catch { try { child.kill(s); return true; } catch { return false; } }
    };
    // 组内残留兜底：扫 /proc 找 pgrp === pid 的进程逐个杀
    const sweepResidual = () => {
      try {
        const pids = require('fs').readdirSync('/proc').filter((n) => /^\d+$/.test(n));
        for (const p of pids) {
          try {
            const stat = require('fs').readFileSync('/proc/' + p + '/stat', 'utf8');
            // 字段 5 是 pgrp：pid (comm) state ppid pgrp ...
            const close = stat.lastIndexOf(')');
            const fields = stat.slice(close + 2).split(' ');
            const pgrp = Number(fields[2]);
            if (pgrp === pid && Number(p) !== process.pid) {
              try { process.kill(Number(p), 'SIGKILL'); } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    };

    groupKill('SIGTERM');
    let done = false;
    const finish = () => { if (done) return; done = true; if (onDone) onDone(); };

    const t = setTimeout(() => {
      groupKill('SIGKILL');
      sweepResidual();
      finish();
    }, KILL_GRACE_MS);
    t.unref();

    child.once('exit', () => { clearTimeout(t); finish(); });
  }

  size() { return { cols: this.cols, rows: this.rows }; }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this._sweeper = setInterval(() => this._sweep(), 60 * 1000);
    this._sweeper.unref();
  }

  get size() { return this.sessions.size; }
  get(id) { return this.sessions.get(id) || null; }
  list() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id, title: s.title, cols: s.cols, rows: s.rows, pid: s.pid || null,
      command: s.spec ? s.spec.argv.join(' ') : null, shell: s.spec ? s.spec.shell : null,
      createdAt: s.createdAt, lastActive: s.lastActive, conns: s.conns ? s.conns.size : 0,
    }));
  }

  create(cols, rows, id, spec) {
    if (this.sessions.size >= MAX_SESSIONS) {
      const err = new Error('max_sessions'); err.code = 'max_sessions'; throw err;
    }
    const sid = id || newId();
    const s = new Session(sid, clampCols(cols), clampRows(rows), normalizeSpec(spec));
    this.sessions.set(sid, s);
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
    return true;
  }

  _sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      const noConns = !s.conns || s.conns.size === 0;
      if (noConns && now - s.lastActive > IDLE_MS) {
        s.kill();
        this.sessions.delete(id);
      }
    }
  }

  /** 进程退出时清理全部会话（含孙进程） */
  disposeAll() {
    for (const s of this.sessions.values()) s.kill();
    this.sessions.clear();
  }
}

function clampCols(c) { const n = parseInt(c, 10); return !n || n < 2 ? DEFAULT_COLS : Math.min(n, 1000); }
function clampRows(r) { const n = parseInt(r, 10); return !n || n < 1 ? DEFAULT_ROWS : Math.min(n, 1000); }

module.exports = { SessionManager, normalizeSpec, probeScript, probeSttyFileMode, sttySetSize, SHELL, MAX_SESSIONS, GRACE_MS, safeMs };
