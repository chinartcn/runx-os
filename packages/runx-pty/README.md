# @runx/pty

伪 PTY 会话组件：给「要一个真终端」的应用用 —— 交互式 shell、TUI 程序
（htop / vim / python REPL）、任何需要行编辑 + 颜色 + 信号 + 窗口尺寸的应用。

**零原生依赖。** 用 util-linux 的 `script` 借一个真 PTY，不用 node-pty
（那需要 node-gyp 编译，离线 / 受限环境常失败）。

```js
const { SessionManager } = require('@runx/pty');
```

---

## 为什么不用 node-pty

| | node-pty | 本包 |
|---|---|---|
| 依赖 | 需要 node-gyp 编译原生模块 | 零依赖，只用 `script` |
| 离线环境 | 装不上 → 整个应用起不来 | 照常工作 |
| Termux / Android | 常常没有编译工具链 | 直接可用 |
| 行编辑 / 颜色 / 信号 | 原生支持 | 原生支持（真 PTY） |

`script -qfec 'bash -i' /dev/null` 由 util-linux 提供真实 PTY（termios +
信号 + 行编辑 + 颜色），外壳和 PTY 行为与真终端一致。

---

## 用法

### 基本

```js
const { SessionManager } = require('@runx/pty');

const mgr = new SessionManager();
const s = mgr.create(80, 24, null, null, { ns: 'terminal' });

s.onOutput = (sess, buf) => process.stdout.write(buf);
s.onExit = (sess, code, signal) => console.log('退出', code, signal);
s.start();

s.write('ls -la\n');
```

### 跑一条命令（不是交互式 shell）

```js
const s = mgr.create(100, 28, null, {
  argv: ['htop'],
  ephemeral: true,     // 窗口一关就结束
});
s.start();
```

`argv` 模式与 `shell` 模式必须分开，不能混：

- **argv 模式**（`shell: false`）—— 每个参数单独引号包裹。命令是**数据**，
  `;`、`|`、`$(...)` 在参数里就只是普通字符，不可能借它拼出第二条命令。
- **shell 模式**（`shell: true`）—— 整串交给 `sh -c`。用户显式要管道 / `&&` /
  重定向时才有意义，此时命令就是代码。

---

## 命名空间：把不同用途的会话隔开

同一个 `SessionManager` 可以同时管几类会话，用 `ns` 区分：

```js
const mgr = new SessionManager({
  namespaces: {
    terminal: { max: 8, idleMs: 30 * 60 * 1000 },
    tui:     { max: 8, idleMs: 5 * 60 * 1000 },
  },
});

mgr.create(80, 24, null, null, { ns: 'terminal' });   // 用户开的 shell 标签页
mgr.create(80, 24, null, { argv: ['htop'] }, { ns: 'tui' });  // 一次性 TUI 窗口

mgr.list('tui');        // 只列 TUI 的
mgr.count('terminal');  // 只数 shell 的
```

**为什么要命名空间**：早期终端应用只有一类会话，桌面上双击命令图标开出来的
一次性 TUI 窗口和用户自己开的 shell 标签页混在一起 —— TUI 会话被写进终端的
恢复列表，终端刷新时把它当成 shell 标签恢复，第一个标签页于是绑到一个已经
死掉的会话上，表现为「第一个标签页不能打字」。

隔开之后：

- 配额独立 —— TUI 开满 8 个也不影响用户还能开 8 个 shell 标签页
- 回收策略独立 —— terminal 30 分钟空闲回收，TUI 5 分钟
- 恢复列表互不干扰（前端配合：各自用不同的 localStorage key）

---

## 尺寸：原地改，不重建

`script` 自身没有设置窗口尺寸的接口。历史上 resize 是靠「杀掉整组重开一个
shell」实现的 —— 代价是前台程序（vi / top / ssh / 正在跑的构建）全部被终止，
shell 变量、目录、命令历史也一并丢失。拖动窗口边缘时会连续触发十几次
resize，等于反复杀进程。

但「script 不给接口」不等于「改不了尺寸」：PTY 的 winsize 属于内核设备属性，
只要拿到 slave 设备路径，任何进程都能用

```
stty -F /dev/pts/N rows R cols C
```

去 ioctl(TIOCSWINSZ)，内核随即向该 PTY 的前台进程组发送 SIGWINCH —— 这正是
xterm、gnome-terminal 等真终端 resize 做的事。

所以启动时让内层 shell 把 `tty` 的结果写进一个临时文件（不进 PTY 输出流），
Node 侧读一次即得 slave 路径；此后 resize 只跑一条 stty。进程、前台程序、
shell 状态全部原地保留。

拿不到路径（异常 shell / 受限环境）或 stty 不可用时，回落到重建会话：

```js
const ok = await s.setSize(120, 40);   // true = 原地改了；false = 得重建
if (!ok) await mgr.respawn(s.id, 120, 40);
```

---

## 输出历史：重连后屏幕不空

每个会话留一个**环形缓冲**，记住最近 256KB 的输出：

```js
const hist = s.historySnapshot();   // Buffer
```

刷新页面 / WS 断线重连之后，进程还在、shell 状态还在，但屏幕是空的：用户得
重新 `ls` 一遍才敢确认自己还在原来的目录。把这段历史回放给客户端，屏幕就
回来了 —— 而且是「真的发生过的那几行」，不是重新执行一遍命令得到的。

按 chunk 存（不是按字节切开）—— ANSI 序列和 UTF-8 字符都可能被切开，按
chunk 保留才不会产生半个转义序列。

---

## 进程回收

spawn 时 `detached: true` 让 `script` 成为进程组组长。清理时：

1. 先 SIGTERM 整组（给前台程序机会优雅退出）
2. 500ms 后 SIGKILL 整组（此时 shell 也会被强杀）
3. 若组杀仍失败，遍历 `/proc` 找到组内残留 pid 逐个 SIGKILL 兜底

一次回收干净，不留「窗口关了、shell 还活着」的僵尸。

---

## API

### `new SessionManager(opts?)`

| 参数 | 说明 |
|---|---|
| `opts.namespaces` | 命名空间配置：`{ [ns]: { max, idleMs } }` |
| `opts.maxSessions` | 全局上限（所有命名空间合计） |

| 方法 | 说明 |
|---|---|
| `create(cols, rows, id?, spec?, opts?)` | 新建会话；`opts.ns` 指定命名空间。超出配额抛 `max_sessions` |
| `get(id)` | 取会话 |
| `list(ns?)` | 列出会话，`ns` 为空则列全部 |
| `count(ns?)` | 数会话数 |
| `respawn(id, cols, rows)` | 用新尺寸重建会话（保留 id） |
| `close(id)` | 关掉并回收会话 |
| `disposeAll()` | 清理全部会话 |

### `Session`

| 属性 / 方法 | 说明 |
|---|---|
| `id` / `cols` / `rows` / `title` / `ns` | 基本信息 |
| `spec` | 命令描述（null = 交互式 shell） |
| `onOutput(session, buf)` | 输出回调 |
| `onExit(session, code, signal)` | 退出回调 |
| `start()` | 启动 |
| `write(data)` | 写入 stdin |
| `setSize(cols, rows)` | 改尺寸，返回 `Promise<boolean>`（false = 需重建） |
| `kill(onDone?)` | 杀整个进程组 |
| `historySnapshot()` | 输出历史快照（Buffer） |

### 工具函数

| 函数 | 说明 |
|---|---|
| `normalizeSpec(raw)` | 校验并规整命令描述，返回 null 表示不合法 |
| `probeScript()` | 探测 `script` 是否可用及其能力 |
| `probeSttyFileMode()` | 探测 stty 是否支持 `-F` |
| `sttySetSize(tty, cols, rows, cb)` | 原地改 PTY 尺寸 |

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TERM_SHELL` | `bash` | 用哪个 shell |
| `TERM_SHELL_ARGS` | 空 | 追加的 shell 参数（如 `--norc --noprofile`） |
| `TERM_ROOT_CWD` | `$HOME` | 会话默认工作目录 |
| `TERM_TTY_DIR` | 系统临时目录 | slave 路径临时文件放哪 |

---

## 安装

不发 npm（`private: true`），从仓库分发：

```bash
node packages/link.js --all      # 软链进所有应用（推荐）
node packages/link.js term       # 只挂进 apps/term
```

软链比复制好在「更新即生效」：仓库拉到新版本，应用下次 require 就是新的，
不会出现「某个应用里躺着一份两年前的 SDK」这种事故。

---

## 已知限制

- **进程重启后 sessionId 失效** —— 会话是 `script` 进程组，父进程一死它就
  跟着去。终端应用会在 30 秒宽限期后回收会话，用户在这段时间内重新打开
  页面还能恢复（连同输出历史）；再之后就只能新开了。
- **`script` 不支持直接设窗口尺寸** —— 见上文，靠 `stty` 兜。
- **BusyBox 环境** —— `stty` 可能不认 `-F`，此时自动改用「把设备接到 stdin」
  的方式；连这个都不行就回落重建会话。
