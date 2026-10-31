'use strict';

/**
 * @runx/pty —— 伪 PTY 的底层零件：能力探测、命令规整、尺寸原地改。
 *
 * 这些函数被 Session / SessionManager 依赖，也对外导出，方便宿主自己做
 * 「这个环境到底能不能跑交互式 shell」的判断（比如终端应用启动前先探一下，
 * 不支持就给出明确提示，而不是让用户对着一个空窗口猜）。
 */

const cp = require('child_process');
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

// PTY slave 路径的采集窗口：正常 <100ms 就能拿到，给足容错但绝不无限等
const TTY_DIR = process.env.TERM_TTY_DIR || os.tmpdir();
const TTY_WAIT_MS = 2000;
const TTY_POLL_MS = 40;
// slave 路径来自 `tty` 的输出，仍按白名单校验后再拼进命令行（防止
// 异常 shell 输出被当成参数注入）
const TTY_PATH_RE = /^\/dev\/pts\/\d+$/;

/**
 * 定时器时长归一化：非法值（NaN/undefined/字符串）回落默认，防 setTimeout(NaN) → 1ms 空转。
 * 支持 "500ms" / "2s" 这类带单位的字符串。
 */
function safeMs(v, dflt, min, max) {
  let n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    const s = typeof v === 'string' ? v.trim() : '';
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(s);
    if (m) {
      n = Number(m[1]);
      if (m[2] === 's') n *= 1000;
      else if (m[2] === 'm') n *= 60000;
    } else {
      n = dflt;
    }
  }
  return Math.min(max, Math.max(min, n));
}

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

function clampCols(c) { const n = parseInt(c, 10); return !n || n < 2 ? DEFAULT_COLS : Math.min(n, 1000); }
function clampRows(r) { const n = parseInt(r, 10); return !n || n < 1 ? DEFAULT_ROWS : Math.min(n, 1000); }

module.exports = {
  SHELL,
  SHELL_ARGS,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  TTY_DIR,
  TTY_WAIT_MS,
  TTY_POLL_MS,
  TTY_PATH_RE,
  safeMs,
  probeScript,
  probeSttyFileMode,
  sttySetSize,
  shellText,
  cmdText,
  cmdName,
  normalizeSpec,
  shq,
  scriptArgs,
  clampCols,
  clampRows,
};
