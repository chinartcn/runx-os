'use strict';

/**
 * 伪 PTY 会话管理（基于 util-linux 的 `script`，零原生依赖）。
 *
 * 为什么不用 node-pty：需要 node-gyp 编译原生模块，离线/受限环境常失败。
 * `script -qfec 'bash -i' /dev/null` 由 util-linux 提供真实 PTY（termios +
 * 信号 + 行编辑 + 颜色），Termux 自带，零依赖。代价是无法对已开 PTY 做
 * ioctl(TIOCSWINSZ) 动态改尺寸 —— 故 resize 采用“重建会话”策略（见下）。
 *
 * 进程组：spawn 时 detached:true 让 script 成为进程组组长，
 * 清理时 process.kill(-pid, sig) 一次性回收 script + bash + 其后台孙进程，
 * 避免窗口关了、shell 还活着的僵尸问题。
 */

const cp = require('child_process');
const crypto = require('crypto');
const os = require('os');

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
const MAX_SESSIONS = Number(process.env.TERM_MAX_SESSIONS) || 8;

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
 * 关键：`script` 自己分配 PTY 时用默认 80x24，且没有设置尺寸的命令行选项。
 * 由于该 PTY 就是子 shell 的 stdin/stdout，我们在 PTY 内先 `stty rows/cols`
 * 设定 winsize，再 `exec` 进交互式 shell，从而让初始尺寸真实生效。
 */
function scriptArgs(cols, rows) {
  const sup = probeScript();
  const flags = sup.ret ? '-qfec' : '-qfc';
  const parts = [SHELL].concat(SHELL_ARGS ? SHELL_ARGS.split(/\s+/).filter(Boolean) : []).concat(['-i']);
  const inner = 'stty rows ' + rows + ' cols ' + cols + ' 2>/dev/null; exec ' + parts.join(' ');
  return [flags, inner, '/dev/null'];
}

class Session {
  constructor(id, cols, rows) {
    this.id = id;
    this.cols = cols;
    this.rows = rows;
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    this.title = SHELL + ' ' + cols + 'x' + rows;
    this.proc = null;
    this.seq = 0;
    this.onOutput = null;   // (session, buf) => void
    this.onExit = null;     // (session, code, signal) => void
    this.silent = false;    // true 时丢弃子进程输出（重建/关闭期间用，屏蔽 script 的终止提示）
  }

  start() {
    const sup = probeScript();
    if (!sup) throw new Error('script_unavailable');
    const args = scriptArgs(this.cols, this.rows);
    const cwd = process.env.TERM_ROOT_CWD || process.env.HOME || os.homedir() || process.cwd();
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
      createdAt: s.createdAt, lastActive: s.lastActive, conns: s.conns ? s.conns.size : 0,
    }));
  }

  create(cols, rows, id) {
    if (this.sessions.size >= MAX_SESSIONS) {
      const err = new Error('max_sessions'); err.code = 'max_sessions'; throw err;
    }
    const sid = id || newId();
    const s = new Session(sid, clampCols(cols), clampRows(rows));
    this.sessions.set(sid, s);
    return s;
  }

  /**
   * 用新尺寸重建会话（保留 id）。用于 resize —— script 无法动态改 PTY 尺寸。
   */
  respawn(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.cols = clampCols(cols);
    s.rows = clampRows(rows);
    s.title = SHELL + ' ' + s.cols + 'x' + s.rows;
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

module.exports = { SessionManager, probeScript, SHELL, MAX_SESSIONS, GRACE_MS };
