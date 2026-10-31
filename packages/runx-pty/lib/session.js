'use strict';

/**
 * @runx/pty —— 单个伪 PTY 会话。
 *
 * 一个 Session = 一条 `script` 进程组 = 一个真 PTY + 一个跑在里面的程序
 * （默认是交互式 bash，也可以是任意命令）。
 *
 * ## 为什么输出要留历史
 *
 * 终端「刷新后屏幕空白」是个很烦的体验：进程还在、shell 状态还在，但屏幕
 * 是空的，用户得重新 `ls` 一遍才敢确认自己还在原来的目录。
 *
 * 这里的做法是：每个会话留一个**环形缓冲**，记住最近若干 KB 的输出。
 * 客户端重连 / attach 时，服务端把这段历史回放给它 —— 屏幕就回来了，
 * 而且是「真的发生过的那几行」，不是重新执行一遍命令得到的。
 *
 * 为什么是环形而不是全量：终端输出可以很大（一个 `cat` 一个大文件就几十
 * MB），全留着会吃光内存。留最近 256KB，足够把「刚才发生了什么」讲清楚，
 * 又能自我限制。
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SHELL, TTY_DIR, TTY_WAIT_MS, TTY_POLL_MS, TTY_PATH_RE,
  probeScript, sttySetSize, scriptArgs, cmdName, clampCols, clampRows,
} = require('./support');

const KILL_GRACE_MS = 500;        // SIGTERM → SIGKILL 间隔
const HISTORY_BYTES = 256 * 1024; // 每个会话保留的输出历史（环形）

/**
 * 输出历史的环形缓冲。
 *
 * 按 chunk 存（不是按字节切开）—— ANSI 序列和 UTF-8 字符都可能被切开，
 * 按 chunk 保留才不会产生半个转义序列。
 */
class OutputHistory {
  constructor(limit) {
    this.limit = limit || HISTORY_BYTES;
    this.chunks = [];
    this.size = 0;
  }

  push(buf) {
    if (!buf || !buf.length) return;
    this.chunks.push(buf);
    this.size += buf.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= this.chunks.shift().length;
    }
  }

  /** 回放：返回一段合并后的 Buffer */
  snapshot() {
    if (!this.chunks.length) return Buffer.alloc(0);
    return Buffer.concat(this.chunks, this.size);
  }

  clear() {
    this.chunks = [];
    this.size = 0;
  }
}

class Session {
  /**
   * @param {string} id            会话 id
   * @param {number} cols
   * @param {number} rows
   * @param {object|null} spec     命令描述；null = 交互式 shell
   * @param {object} [opts]
   * @param {string} [opts.ns]     命名空间（terminal / tui …），用于配额与隔离
   */
  constructor(id, cols, rows, spec, opts) {
    this.id = id;
    this.cols = cols;
    this.rows = rows;
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    // spec 为空 = 交互式 shell；有 spec = 跑指定命令（TUI 应用）
    this.spec = spec || null;
    this.ns = (opts && opts.ns) || 'terminal';
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
    this.history = new OutputHistory((opts && opts.historyBytes) || HISTORY_BYTES);
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
      this.history.push(chunk);            // 留一份历史，重连时回放
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
        const pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
        for (const p of pids) {
          try {
            const stat = fs.readFileSync('/proc/' + p + '/stat', 'utf8');
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

  /** 输出历史快照（Buffer），用于重连回放 */
  historySnapshot() { return this.history.snapshot(); }
}

module.exports = { Session, OutputHistory, HISTORY_BYTES };
