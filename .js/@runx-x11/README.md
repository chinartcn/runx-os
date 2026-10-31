# @runx-x11

在 RunX 窗口里运行**真正的 X11 程序**。一个窗口 = 一个无缝 X 会话。

```
点桌面上的「图形终端」图标
  ↓  探测（毫秒级，不 fork 进程）
  ├─ 有 xpra             → 起一个 seamless 会话，窗口里就是那个程序
  ├─ 没有 xpra 但有桌面   → 提示两条路，让用户选「装 xpra」还是「直通现有桌面」
  └─ Android / Termux    → 说明为什么不内置，把 API 留给愿意自己折腾的人
```

## 为什么是独立扩展

桌面外壳每个人都用；X11 是「装了 xpra 才有」的东西。绑在一起的代价是：一台没装
xpra 的机器，桌面代码里也永远躺着一份用不上的会话管理器、端口分配器、进程收尸
逻辑，启动时还要 fork 一个 `xpra --version`。

拆开之后，从 `.js/js.list.json` 里删掉这一行，图形功能就不存在了，其余一切照常。
桌面那边靠「`GET /runx/x11/status` 是不是 404」判断装了没装 —— 两边没有编译期依赖。

> `mod.json` 里的 `core: true` 只表示「需要 `ctx.os` 的进程能力」，不代表常驻。
> 术语上容易误会，所以写在这里。

## 两种后端

| provider | 机制 | 窗口级 | 每个窗口独立 | 前提 |
|---|---|---|---|---|
| `xpra`（推荐） | 每个会话新起一个 Xvfb + xpra seamless | ✅ 一个窗口里能开多个 X 程序 | ✅ 关窗口即回收 | `apt install xpra` |
| `native` | 附着到宿主已有的 `$DISPLAY`，xpra shadow 整屏镜像 | ❌ 整屏 | ❌ singleton，多个图标共用一个会话 | 宿主跑着桌面环境 + xpra |

`native` 的意义是「这台机器本来就跑着 XFCE / 树莓派接着 HDMI / 用户另有 VNC」——
这时候再起一个空 Xvfb 是多余的。代价是整屏镜像：手机上看到的是缩放后的整块桌面，
所以它排在 `xpra` 后面，且只有探测到 `$DISPLAY` 的真实 socket 才会亮。

**为什么是 seamless 而不是「一块屏」**：seamless 是窗口级协议，X 应用各自的窗口
直接变成 HTML5 客户端里的窗口，没有窗口管理器、没有虚拟桌面背景，文本还能选中复制
（剪贴板直通）。KasmVNC 那种整屏像素方案在这里是错的：手机上你会得到一张缩小的
1920×1080 截图。

## 平台支持

| 平台 | 状态 | 说明 |
|---|---|---|
| Linux | ✅ | 主力场景 |
| Android / Termux | ❌ 明确不支持 | 见下 |
| macOS / Windows | ❌ | 没有 X server；也不是本项目要解决的问题 |

Termux 里跑图形应用只有一条路：proot 里再套一个发行版。那是「能跑」不是「能用」——
启动十秒起、没有中文输入法、重绘像幻灯片，还要吃掉几百 MB。所以这里判成不支持，
**但不关门**：

```http
POST /runx/x11/sessions
{ "command": "xterm", "provider": "xpra", "force": true }
```

`force: true` 绕过平台判断。自己搭了 termux-x11 / 远程 X 的人可以直接调它。

## REST

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/runx/x11/status` | 探测结果 + 会话列表（前端据此画决策框） |
| POST | `/runx/x11/status/refresh` | 清探测缓存（用户刚敲完 `apt install`） |
| GET | `/runx/x11/sessions` | 只列会话 |
| POST | `/runx/x11/sessions` | 起会话 → `{id, port, display, path, provider, pid, reused?}` |
| DELETE | `/runx/x11/sessions/:id` | 关会话 |

`status` 返回的是**可渲染的结构**，不是一句文案：

```jsonc
{
  "ok": false,                  // 现在能不能开
  "platform": "linux",
  "supported": true,            // 这个平台理论上支持吗
  "display": ":0",              // 宿主现有显示，没有就是 null
  "backends": [
    { "id": "xpra",   "ok": true,  "version": "3.1.5", "kind": "seamless", "hint": "" },
    { "id": "native", "ok": false, "kind": "screen", "hint": "没有检测到正在运行的 X 服务器" }
  ],
  "recommended": "xpra",
  "install": [                  // 缺什么、怎么补、多大
    { "id": "xpra", "cmd": "sudo apt install xpra", "size": "约 100MB", "recommended": true }
  ],
  "sessions": []
}
```

错误码（前端按 `error.name` 分流，不解析文案）：

| 状态 | name | 含义 |
|---|---|---|
| 422 | `X11_BAD_REQUEST` | 命令为空 / 太长 |
| 501 | `X11_UNSUPPORTED` | 平台不支持（Termux / 非 Linux） |
| 501 | `X11_NO_BACKEND` | 平台可以，但依赖没装全（附 `data` = status） |
| 502 | `X11_START_FAILED` | 起了但没起来（附日志尾巴） |
| 504 | `X11_START_TIMEOUT` | 25 秒还没就绪 |

## 前端接缝

扩展注入 `window.RunXX11`，只有三个方法：

```js
await RunXX11.ensure();          // 探测 + 必要时弹决策框；true = 可以继续
const s = await RunXX11.create({ id, command, label });  // → { port, display, path, ... }
RunXX11.stop(sessionId);         // 关窗时调
```

桌面在双击 `x11` 图标时调 `ensure()` → `create()` → 用 `http://<当前主机>:<port><path>`
开窗口。**主机名必须取浏览器的 `location.hostname`**：手机走局域网访问时，服务端写死的
127.0.0.1 指的是手机自己。

没加载本扩展时 `window.RunXX11` 不存在，桌面走「没有安装 X11 扩展」的分支 —— 图标还在
（它只是 `desktop.json` 里的一个字段），点开会有明确提示。

## 排错

**「没有空闲的显示号了」但 `ps` 里没有任何 X 进程**

Xvfb 被 SIGKILL 时来不及删 `/tmp/.X<n>-lock` 与 `/tmp/.X11-unix/X<n>`，而分配显示号
正是看这两个文件。扩展启动时会扫一遍 100–199，锁文件里的 pid 已死的就清掉；也可以手动：

```sh
rm -f /tmp/.X11{0..99}-lock /tmp/.X11-unix/X1{00..99}
```

**窗口里一片深蓝，没有程序**

`--start` 的命令退出了。看日志：

```sh
tail -20 var/x11/<session-id>.log
```

**会话关不掉 / 端口占着**

`xpra stop :<display>` 之后还有残留就 `kill -9 -<pid>`（整个进程组）。
注册表在 `var/x11/sessions.json`，下次启动会自动收尸。

## 以后可能加的 provider

| 后端 | 位置 | 说明 |
|---|---|---|
| `kasmvnc` | 整屏 | 只要一块屏、不要窗口级转发时的备选 |
| `x11vnc` + `noVNC` | 整屏 | 宿主已有桌面、又不想装 xpra 时的纯 VNC 路线 |

加一个 provider 只需要实现 `probe / argv / urlPath / stop`（seamless 还要 `launch`），
显示号与端口的分配、注册表、收尸都由 `manager.js` 统一处理。
