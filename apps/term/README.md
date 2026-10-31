# term — RunX 真实交互式终端

一个跑在 RunX 桌面里的**真实终端**：后端起真正的 shell（`bash -i`），前端用 xterm.js 渲染。
零原生依赖（不需要 `node-gyp` / `node-pty`），可在 Termux、受限容器、离线环境直接跑。

它是 RunX 平台的第一个「端到端测试用例」——同时验证了：PaX 安装、supervisor 托管、
`appex.json` 契约、桌面图标/开窗、`os.js` 特权层、以及纯 JS 自研 WebSocket。

---

## 目录结构

```
term/
├── appex.json          # RunX 应用清单（supervisor / desktop 读它）
├── app.js              # 后端入口：HTTP 静态 + /ws/term WebSocket + 会话编排
├── icon.svg            # 桌面图标
├── lib/
│   ├── ws.js           # 零依赖 WebSocket 服务端（RFC6455 子集）
│   ├── pty.js          # PTY 能力的转发层（真实实现在 @runx/pty 组件包）
│   └── host.js         # 与桌面的可选集成：Dock 角标 / 长任务完成通知
└── public/
    ├── index.html       # 标签栏 + 终端容器 + 工具栏
    ├── term.css
    ├── term.js          # 单 WS 多 Terminal，标签/主题/字号/重连
    └── vendor/          # 离线打包的 xterm.js + addon-fit
```

> PTY 能力已经抽成独立组件包 [`@runx/pty`](../../packages/runx-pty/)：
> 伪 PTY 会话、命名空间隔离、输出历史回放都在那里，别的应用（IDE、
> 日志查看器、任何要跑交互式程序的）可以直接复用。`lib/pty.js` 只是转发层。

---

## 它是怎么工作的

### 1. 伪 PTY：为什么不用 node-pty

`node-pty` 需要 node-gyp 编译原生模块，在 Termux / 精简镜像 / 离线环境经常编译失败。
本应用改用 util-linux 自带的 `script`：

```sh
script -qfec 'stty rows <R> cols <C> 2>/dev/null; exec bash -i' /dev/null
```

- `script` 会分配一个**真实 PTY**（termios / 信号 / 行编辑 / 256 色全都有），
  子 shell 的 stdin/stdout 就是它，所以 `top`、`vim`、`Ctrl-C` 等行为与真终端一致。
- `-e` 把子进程退出码透传出来（老版本不支持时自动降级探测）。
- 初始尺寸：`script` 没有「设尺寸」的命令行选项，我们在 PTY 内先 `stty rows/cols`
  再 `exec` 进 shell，从而让初始 winsize 真正生效。

### 2. resize 为什么不重建会话

`script` 分配 PTY 后，本进程没有那个 master fd，**不能直接 ioctl(TIOCSWINSZ)**。
（顺便一提：设置 `COLUMNS`/`LINES` 环境变量只影响 readline 的显示宽度，不改变内核 tty winsize。）

但「拿不到 master」不等于「改不了尺寸」：winsize 是内核设备属性，**只要知道 slave 设备路径，
任何进程都能用 `stty -F /dev/pts/N rows R cols C` 去 ioctl**，内核随即向该 PTY 的前台进程组
发 `SIGWINCH` —— 这正是 xterm / gnome-terminal 等真终端 resize 时做的事。

所以启动时让内层 shell 把 `tty` 的输出写进一个临时文件（输出重定向到文件，不进 PTY 流），
Node 侧轮询读一次得到 slave 路径，之后每次 resize 只跑一条 `stty`：

- shell 进程、cwd、变量、命令历史**全部原地保留**
- 前台程序（`vim` / `top` / `ssh` / 正在跑的构建）收到 `SIGWINCH` 自适应重绘，不被结束
- 拖动窗口边缘连续触发十几次 resize 也毫无感知

> 之前之所以是「杀掉重开」，是因为只知道没有 master fd 就停在了这一步。实测
> `stty -F` 在 GNU coreutils 与 util-linux 上都可用；BusyBox 不认 `-F`，则把 slave
> 设备直接接到 `stty` 的 stdin 上，效果相同。

**回落**：拿不到 slave 路径（异常 shell、非 `/dev/pts` 环境）或 `stty` 不可用时，
仍会退回「按新尺寸重建会话」，并在浮层提示
`已按 N×M 重建会话（当前环境不支持原地改尺寸，前台程序已重启）`。
`GET /health` 的 `resize` 字段会报 `inplace` 或 `respawn`，便于排查实际走的是哪条路。

### 3. 进程回收

`spawn` 时 `detached:true` 让 `script` 成为进程组组长；清理时：

1. `process.kill(-pid, 'SIGTERM')` —— 整组优雅退出；
2. 500ms 后 `SIGKILL` 整组 —— 交互式 shell 常忽略 SIGTERM，必须强杀；
3. 扫 `/proc/*/stat` 找 `pgrp === pid` 的残留进程逐个 `SIGKILL` 兜底。

关闭窗口 / 回落重建 / 进程退出（signal 钩子）都走这套，实测残留为 0。

### 4. WebSocket

`lib/ws.js` 是移植自 `os.js` 的零依赖实现：SHA1 握手、text/close/ping-pong 帧、
1MB 单帧上限、只接受 `/ws/term` 的 upgrade。

消息协议（JSON 文本帧）：

| 方向 | 类型 | 说明 |
|---|---|---|
| C→S | `hello` | 握手，带 `ns`（命名空间）与 `resume:[sessionId]` 恢复 |
| C→S | `create` | 新建会话（`cols`/`rows`） |
| C→S | `attach` / `input` / `resize` / `close` / `ping` | |
| S→C | `welcome` | 带 `ns`、`resumed`（已重绑的会话）、`missing`（已失效的） |
| S→C | `created` / `session` / `output` / `exit` / `closed` / `resized` / `error` / `pong` | |

**输出用 base64（`data_b64`）承载原始字节** —— 避免 UTF-8 多字节字符或 ANSI 转义序列
在 WS chunk 边界被切断。

### 5. 命名空间：终端 shell 与 TUI 是两套东西

同一个后端同时服务两类会话：

| 命名空间 | 谁开的 | 特点 |
|---|---|---|
| `terminal` | 用户自己开的终端标签页 | 多标签、可刷新恢复、长期存活 |
| `tui` | 桌面上双击命令图标 | 一次性、窗口关掉进程就结束 |

**早期这两类是混在一起的**，后果很具体：TUI 窗口与终端窗口同源（都在 `:3460`），
共享同一个 `localStorage['runx.term.sessions']`。TUI 窗口 attach 成功后把会话 id
写进了终端的恢复列表；终端刷新时把它当成 shell 标签恢复出来，第一个标签页于是
绑到一个已经死掉的会话上 —— **表现为「第一个标签页不能打字」**。

现在隔开了：

- **协议层**：`hello` 声明 `ns`；`attach` 时校验会话的 `ns` 与连接一致，不一致回
  `ns_mismatch`。终端接管不了 TUI 会话，反之亦然。
- **配额层**：`terminal` 与 `tui` 各有各的上限（各 8），TUI 开满不影响用户开 shell 标签页。
- **回收层**：`terminal` 断连后有 30 秒宽限（刷新页面别丢 shell）；`tui` 断连即回收。
- **前端层**：TUI 模式（`?ns=tui`）隐藏标签栏与「+」按钮、不进终端的恢复列表、
  标签名只给被点名的那个会话。

### 6. 防重置：屏幕不空

终端「刷新后屏幕空白」是很烦的体验：进程还在、shell 状态还在，但屏幕是空的，
用户得重新 `ls` 一遍才敢确认自己还在原来的目录。

做法是每个会话留一个**输出历史环形缓冲**（最近 256KB，见 `@runx/pty`）：

- 客户端 attach / 重连时，服务端把这段历史一并送回（`session.history_b64`）
- 前端在**新建终端实例**时回放它 —— 同一页面里 WS 断线重连时实例还在、屏幕本来
  就有内容，不重复回放

于是刷新页面后：标签页照旧恢复，屏幕内容也回来了，而且是「真的发生过的那几行」。

另外修了几处让终端「看起来被重置」的细节：

- `conn.sessionId` 原本只记一个 id，但一条 WS 连着多个标签页 —— 后绑的覆盖先绑的，
  连接断开时只解绑最后一个，其余会话的连接集合里一直留着死连接，**输出发给了空气**。
  现在连接上记的是一组 id。
- 恢复列表的过滤条件原本写反了（保留已消失的会话、丢掉活着的），于是恢复列表里
  全是死 id，刷新后怎么恢复都恢复不回来。
- `session_not_found` 时只从 `state.sessions` 删、没从 `state.order` 删 —— 顺序错位
  之后 `activate` 会把所有终端的高亮都取消，看上去就是「标签页点不动、也打不了字」。
- `.term-host` 原本用 `display:none` 隐藏，xterm `open()` 时量不到容器尺寸，FitAddon
  之后也算不出行列数。改成 `visibility` 隐藏：布局尺寸还在，只是不显示。

---

## 配置

### 经 `appex.json` 声明环境变量（推荐）

`appex.json` 支持 `env` 字段，PaX 安装时会校验（仅接受合法变量名 + 字符串值），
supervisor 启动时经 `os.spawn` 透传给应用进程：

```json
"env": { "TERM_SHELL_ARGS": "--norc --noprofile" }
```

> 框架注入的 `PORT` 优先级最高，应用无法覆盖。

### 支持的环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3460` | 监听端口（supervisor 按 appex.json 注入，应用不可覆盖） |
| `TERM_SHELL` | `bash` | 要启动的 shell |
| `TERM_SHELL_ARGS` | 空 | 附加参数，会拼在 `-i` **之前**（bash 要求长选项在前） |
| `TERM_ROOT_CWD` | `$HOME` | 会话起始目录 |
| `TERM_MAX_SESSIONS` | `8` | 并发会话上限（总） |
| `TERM_GRACE_MS` | `30000` | 终端会话断连后的宽限期（这段时间内刷新可恢复） |

> **关于 `TERM_SHELL_ARGS`**：默认空值 = 读取用户 `~/.bashrc`，得到真实环境（别名 / PATH /
> 提示符）。如果某些 rc 片段与 bash 不兼容（例如误 source 了 zsh 补全脚本，启动时报
> `zsh_eval_context: bad array subscript` / `compdef: command not found`），
> 设 `TERM_SHELL_ARGS='--norc --noprofile'` 可跳过 rc。本仓库 `appex.json` 默认即如此，
> 以保证在任何机器上开箱即用；如需自己的环境，删掉该字段即可。

---

## 安装到 RunX

```sh
# 打包
tar -czf term-1.0.0.tgz -C term .

# 经 PaX 安装（REST 走 /runx 前缀）
curl -s -X POST http://127.0.0.1:4125/runx/pax/install \
  -H 'Content-Type: application/json' \
  -d '{"tarball":"/tmp/term-1.0.0.tgz"}'

# 用 supervisor 启动
curl -s -X POST http://127.0.0.1:4125/runx/supervisor/start \
  -H 'Content-Type: application/json' -d '{"name":"term"}'

# 在桌面加图标
curl -s -X POST http://127.0.0.1:4125/runx/desktop/icons \
  -H 'Content-Type: application/json' \
  -d '{"id":"term","name":"终端","url":"http://127.0.0.1:3460/","icon":"/apps/term/icon.svg"}'
```

之后双击桌面「终端」图标即可开窗使用。

---

## 和桌面的集成（可选）

在 RunX 里跑时，term 会用 [`@runx/host`](../../packages/runx-host/) 做两件事：

| 时机 | 桌面上的表现 |
|---|---|
| 会话数变化 | Dock 角标显示当前有几个终端会话（0 自动清掉） |
| 跑够 20 秒的命令结束、或失败退出 | 一条通知：「命令完成 · `make build` · 3 分 12 秒」 |

两条都是**可选**的：`require('@runx/host')` 失败、没有 `RUNX_APP_TOKEN`、桌面没开，
都只是不显示，终端本身照常用。交互式 shell 退出不通知（自己敲的 `exit`，不用告诉
你），桌面双击的一次性命令也不通知（窗口就在眼前）。

装包：`node packages/link.js term`。`GET /healthz` 的 `host` 字段能看出有没有连上。

---

## 已知局限

1. **resize 在极端环境下会回落重建**：正常情况下（GNU / BusyBox `stty` 可用、PTY 在
   `/dev/pts` 下）resize 是原地 ioctl，前台程序不受影响；只有拿不到 slave 路径时才会
   退回「重建会话」并结束 `vim`/`top`/`ssh`。原因与判定方式见上文 §2。
2. **不随桌面自动停靠**：`appex.json` 里 `autostart:false`；窗口关闭后后端仍在跑，
   会话保留 30 分钟（无连接空闲）后回收。
3. **进程重启后 sessionId 失效**：后端重启后旧会话不存在，前端重连时 `resume` 只能恢复
   还活着的那部分，其余需要新建（失效的那些会被自动从恢复列表里清掉，不会错位）。
4. **单机单用户假设**：Origin 同源校验用于防跨站驱动 RCE；若要暴露到公网，请置于
   反向代理 + 鉴权之后。

---

## 安全

- `GET /assets/*` 有路径越界防护（`../` → 404）。
- WebSocket 升级校验 `Origin` 同源，拒绝跨站页面驱动命令执行。
- 会话数 / 单帧大小均有上限。

---

## 本地调试

```sh
PORT=3460 node app.js
curl -s localhost:3460/healthz   # {"ok":true,...,"pty":true}
# 浏览器打开 http://localhost:3460/
```
