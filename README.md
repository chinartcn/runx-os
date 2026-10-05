# RunX OS

一个跑在浏览器里的**网页桌面操作系统**：基于 [NavExt](https://github.com/chinartcn/NavExt)（零依赖 Node.js 静态导航服务器 v2.8.0）改造的内核，叠加一组核心扩展，构成可安装、可托管 Web/Node 应用的桌面环境。

> 零运行时依赖。不需要 `npm install`、不需要编译原生模块。只要一台装了 Node.js 的机器（手机 / 平板 / 树莓派 / 服务器均可），`node server.js` 就能起来。

---

## 一键安装与启动

```bash
curl -fsSL https://raw.githubusercontent.com/chinartcn/runx-os/main/install.sh | bash
```

脚本会克隆仓库并启动。启动后打开：

- **桌面**：http://localhost:3000/
- **内置终端**：http://localhost:3460/ （桌面双击「终端」图标也可）

### 国内网络 / 加速镜像

安装脚本会**自动依次尝试「直连 GitHub → 多个加速镜像」**，克隆失败还会回退到 tarball 下载（无需 git）。若 `raw.githubusercontent.com` 本身被墙，用镜像版一行命令：

```bash
# 方式 A：gh-proxy 加速（注意镜像地址要拼两遍 https）
curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/chinartcn/runx-os/main/install.sh | bash

# 方式 B：jsDelivr CDN
curl -fsSL https://cdn.jsdelivr.net/gh/chinartcn/runx-os@main/install.sh | bash

# 方式 C：手动指定克隆镜像
RUNX_MIRROR=https://gh-proxy.org/ bash install.sh
```

内置镜像列表（按序尝试）：`github.com` 直连 → `gh-proxy.org` → `ghproxy.net` → `ghfast.top` → `codeload.github.com` tarball。

环境变量：

| 变量 | 说明 |
|---|---|
| `RUNX_MIRROR=<前缀>` | 只用指定镜像（如 `https://gh-proxy.org/`），跳过直连与自动探测 |
| `RUNX_MIRROR=off` | 只用 GitHub 直连，不走任何镜像 |
| `RUNX_BRANCH=<分支>` | 指定分支，默认 `main` |

也可手动：

```bash
git clone https://github.com/chinartcn/runx-os.git
cd runx-os
./start.sh                 # 前台运行，Ctrl+C 停止
PORT=8080 ./start.sh       # 自定义端口
```

要求：Node.js ≥ 14（桌面用到的 `ctx.fetch` 需要 ≥ 18），`bash`，以及 `git` 或 `curl` 二选一。

---

## 架构

```
RunX OS
├── server.js        NavExt 内核（静态服务 + 扩展系统 + 热重载）
├── os.js            特权层：受管进程 / 事件总线 / 文件系统护栏 / WS 原语
├── .js/             5 个核心扩展（core:true，独享 ctx.os 特权通道）
│   ├── @runx-supervisor   应用生命周期（启动 / 停止 / 重启 / autostart / 崩溃自愈）
│   ├── @runx-pax          应用安装（tarball / 目录安全解包 → appex.json → apps.json）
│   ├── @runx-event-bus    内核内事件总线（app:started / app:stopped / desktop:changed …）
│   ├── @runx-desktop      桌面 UI（导航条 / 菜单栏 / 可拖拽窗口 / Dock / 图标网格）
│   │   └── assets/        设计令牌 + Inter 可变字体（拉丁子集）
│   └── @runx-mounts       @runx-mounts 挂载点（文档 §7）
├── apps/            已部署应用（当前内置 term）
│   └── term/        RunX 真实交互式终端（script 伪 PTY + xterm.js）
├── var/runx/        运行时状态（apps.json / desktop.json / logs），gitignore
└── docs/            设计文档（RunX.OS.Termux.md / RunX.UI.md）
```

**扩展系统**：每个扩展是 `index.js`（服务端钩子）+ `client.js`（注入浏览器）+ `js.json`（配置 schema）+ `mod.json`（标记 `core:true`）。内核在 `/api/*` 之外预留 `/runx` 前缀给扩展 REST。

**特权通道 `ctx.os`**：仅 `core:true` 扩展可见，提供 `spawn / terminate / watch / poll / schedule / listen / secret / files / gc / ipc / ws` 等原语。`os.js` 是改造 NavExt 的关键——它解开了原版对扩展能力的限制。

---

## 内置应用：终端（term）

一个**真终端**：后端起真正的 `bash -i`，前端 xterm.js 渲染，零原生依赖（用 util-linux 的 `script` 伪 PTY 替代 node-pty）。

- 支持多标签、主题（深/浅）、字号调节、窗口缩放自适应。
- resize 采用「重建会话」策略（保留 scrollback），详见 `apps/term/README.md`。
- 进程清理：SIGTERM → SIGKILL → `/proc` 扫描兜底，关闭窗口无僵尸。

---

## 写一个自己的应用

应用用 `appex.json` 描述，经 PaX 安装即可出现在桌面：

```json
{
  "schema": 1,
  "name": "myapp",
  "version": "1.0.0",
  "type": "node",
  "entry": "app.js",
  "port": 3500,
  "display_name": "我的应用",
  "icon": "icon.svg",
  "autostart": false,
  "restart": "on-failure"
}
```

- `type: "node"`：由 supervisor 托管进程（要自己监听 `process.env.PORT`）。
- `type: "web"`：纯静态资源，由 NavExt 直接托管，无需进程。
- 桌面图标：双击打开。`node` 应用按 `http://<host>:<port>/` 用 iframe 加载；`web` 应用按 `/apps/<name>/` 加载。

REST（均走 `/runx` 前缀）：

| 动作 | 方法 + 路径 |
|---|---|
| 安装（目录或 tarball） | `POST /runx/apps/install` `{source:"local", path:"/abs/path"}` |
| 列表 / 详情 | `GET /runx/apps` · `GET /runx/apps/:name` |
| 启停 / 重启 | `POST /runx/apps/:name/start\|stop\|restart` |
| 桌面图标 | `POST /runx/desktop/icons` |

---

## 桌面 UI 与窗口

桌面外壳（`@runx-desktop`）按 `docs/RunX.UI.md` 设计规范实现：Apple HIG + Liquid Glass。

**布局三层**

| 层 | 元素 | 说明 |
|---|---|---|
| 顶部 | `.rx-menubar` | 固定在顶部的 Flexbox 导航条（细分割线），承载品牌标记与菜单栏 |
| 中间 | `.rx-surface` | 桌面内容层：图标网格 |
| 底部 | `.rx-dock` | 浮动 Liquid Glass 材质应用坞；已打开的应用 + 未打开应用的启动器 |

**菜单栏**（§3.2，核心交互范式）：`RunX OS / 文件 / 编辑 / 显示 / 窗口 / 帮助`，共 40+ 条命令。
`窗口` 菜单实时列出所有窗口；`显示` 菜单管工具栏样式与浅色/深色/跟随系统。

**窗口能力**（§3.1：调整大小、隐藏、显示、移动、全屏）

| 操作 | 手势 |
|---|---|
| 移动 | 拖标题栏（最大化状态下拖动会先还原成窗口再跟手） |
| 调整大小 | 八向手柄（四边 + 四角），带 280×180 最小尺寸与视口约束 |
| 最大化 | 绿点单击 / 双击标题栏 / `⌘⌃M` |
| 全屏 | 绿点双击 / 工具栏全屏按钮 / `⌘⌃F` / `Esc` 退出 |
| 最小化 | 黄点 / `⌘M`（内容继续跑，收进 Dock） |
| 隐藏 | `⌘H` / 应用菜单「隐藏」；`⌘⌥H` 隐藏其他 |
| 关闭 | 红点 / `⌘W`（销毁窗口，node 应用进程仍由 supervisor 托管） |

工具栏支持三种样式（§3.1 / §3.3）：`unified` 统一、`unifiedCompact` 紧凑、`expanded` 展开。
窄屏（≤680px）自动用紧凑样式并隐藏分段控件——次要操作降级到「显示」菜单（§3.3）。

**设计令牌**（`assets/tokens.css`）

- **字体**：Inter 可变字体（`wght 100–900` / `opsz 14–32`），拉丁子集 woff2 仅 103KB，
  加载失败立刻回落系统字体栈，不阻塞渲染。中文由系统字体承担，不会出豆腐块。
- **等宽数字**：全局 `font-feature-settings: "tnum"` —— 时钟、尺寸、日志行不抖动。
- **语义化文本**：`.title / .subtitle / .body / .caption / .status / .section-label`；
  字号行高字重收在 `--font-title / --font-body` 等层级变量里，不散落硬编码。
- **语义色**：`--label-primary/secondary/tertiary` 三级文本；`--accent` 只用于选中与有意义的强调；
  语义红/黄/绿仅传达状态。浅色 / 深色 / 跟随系统三套，另适配 `prefers-contrast: more`。
- **同心圆角**：`border-radius: calc(var(--outer-radius) - var(--padding))`，
  嵌套元素曲率对齐（菜单 10px → 菜单项 5px，Dock 胶囊 → 条目胶囊）。
- **材质**：`backdrop-filter: blur(12px)` + `rgba(255,255,255,0.7)`；三档材质禁止叠加，
  不支持 `backdrop-filter` 的环境自动回落到不透明面。

**前端资源的送达方式**（一个不太显然的工程点）

内核把扩展的 `styles`/`scripts` **内联**进 HTML，而扩展目录位于 `.js/`（以点开头，静态路由一律拒绝）。
于是 CSS 里的 `url()` 引用（字体、图标）没有可达地址。桌面扩展因此自己注册了
`GET /runx/desktop-assets/*`：白名单扩展名 + 正确 MIME（woff2 必须有，否则字体静默失效）+
ETag 304 协商。内联的 CSS 在导出前会把相对 `url()` 改写成绝对前缀——
注意 CSS 里的相对地址是按 **CSS 文件自身所在目录** 解析的（`assets/tokens.css` 里写
`fonts/x.woff2` 实际指向 `assets/fonts/x.woff2`），所以重写时要带上基准目录。

---

## 已知局限

1. **resize 会重建终端会话**：前台交互程序（`vim`/`top`/`ssh`）会重启。这是零原生依赖（不用 node-pty）的固有取舍。
2. **Termux / Android 上的 `fs.watch` 不可靠**：`watch` 已内置防抖 + 基于 `fs.stat` 的降级轮询兜底。
3. **单机单用户假设**：内核未内置鉴权；若要暴露到公网，请置于反向代理 + 鉴权之后。
4. **窗口几何不持久化**：图标坐标、壁纸、主题、Dock、网格尺寸都写回 `var/runx/desktop.json`；
   但窗口的位置/大小/层级只是会话状态，刷新即回到默认排布（`desktop.windows` 留给后续版本）。

---

## 定时器健壮性

所有定时器时长（`restart_delay_ms` / `cache.*Ttl` / `watch` 防抖间隔等）在进入
`setTimeout` / `setInterval` 之前都会经 `ctx.os.safeMs(v, default, min, max)` 归一化。

原因：`setTimeout(fn, NaN)` 会让 Node 打印 `TimeoutNaNWarning` 并把时长**静默降级为 1ms**——
在手机上就是一个空转的 1ms 定时器，持续耗电。而这些时长常来自 `server.json` / `appex.json`，
可能是字符串、`null`、越界值或 `Infinity`。

归一化规则：非法值（NaN / undefined / null / 非数字字符串 / ±Infinity）→ 回落默认值；
合法数字 → 夹到 `[min, max]`。保证传给定时器的永远是有限正整数。

---

## 致谢 / 许可

- 内核改造自 [NavExt](https://github.com/chinartcn/NavExt)（MIT）。
- 本项目版权归 chinartcn，采用 **MIT 许可**。

```
RunX OS = NavExt（内核）+ os.js（特权层）+ 5 个核心扩展 + 应用层
```
