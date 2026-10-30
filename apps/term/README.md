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
│   └── pty.js          # 伪 PTY 会话管理（基于 util-linux `script`）
└── public/
    ├── index.html       # 标签栏 + 终端容器 + 工具栏
    ├── term.css
    ├── term.js          # 单 WS 多 Terminal，标签/主题/字号/重连
    └── vendor/          # 离线打包的 xterm.js + addon-fit
```

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
| C→S | `hello` | 握手，可带 `resume:[sessionId]` 恢复 |
| C→S | `create` | 新建会话（`cols`/`rows`） |
| C→S | `attach` / `input` / `resize` / `close` / `ping` | |
| S→C | `welcome` / `created` / `session` / `output` / `exit` / `closed` / `resized` / `error` / `pong` | |

**输出用 base64（`data_b64`）承载原始字节** —— 避免 UTF-8 多字节字符或 ANSI 转义序列
在 WS chunk 边界被切断。

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
| `TERM_MAX_SESSIONS` | `8` | 并发会话上限 |

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

## 已知局限

1. **resize 在极端环境下会回落重建**：正常情况下（GNU / BusyBox `stty` 可用、PTY 在
   `/dev/pts` 下）resize 是原地 ioctl，前台程序不受影响；只有拿不到 slave 路径时才会
   退回「重建会话」并结束 `vim`/`top`/`ssh`。原因与判定方式见上文 §2。
2. **不随桌面自动停靠**：`appex.json` 里 `autostart:false`；窗口关闭后后端仍在跑，
   会话保留 30 分钟（无连接空闲）后回收。
3. **进程重启后 sessionId 失效**：后端重启后旧会话不存在，前端重连时 `resume` 只能恢复
   还活着的那部分，其余需要新建。
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
