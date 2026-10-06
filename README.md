# RunX OS

一个跑在浏览器里的**网页桌面操作系统**：基于 [NavExt](https://github.com/chinartcn/NavExt)（零依赖 Node.js 静态导航服务器 v2.8.3）改造的内核，叠加一组核心扩展，构成可安装、可托管 Web/Node 应用的桌面环境。

> 零运行时依赖。不需要 `npm install`、不需要编译原生模块。只要一台装了 Node.js 的机器（手机 / 平板 / 树莓派 / 服务器均可），`node server.js` 就能起来。

---

## 与 NavExt 版本的关系

从 NavExt **v2.8.3** 起，内置的**导航页（展示页）已从内核剥离**，降级为可选扩展 `.js/navext-ui/`。
没装该扩展时，内核按三层顺序回退：

| 顺序 | 条件 | 行为 |
|:---:|---|---|
| ① | 站点根目录存在 `index.html` | 服务该文件，**照常注入扩展**（`navext-client`、`__NAV_DATA__`） |
| ② | 没有 `index.html` | HTTP 200 + `Content-Length: 0`（零字节空页面） |
| ③ | — | 其他扩展在任何情况下都照常加载 |

**RunX OS 有意保留根目录的 `index.html`，走第 ① 层。** 原因很直接：RunX 桌面客户端（`.js/@runx-desktop/client.js`）依赖内核把 `navext-client` 脚本注入页面才能启动，而零字节页面没有 `<head>` 可供注入 —— 实测会落到「桌面完全不挂载」（`#runx-desktop` 不存在）。

`index.html` 只是 619 字节的启动占位（一行"正在启动 RunX OS 桌面…"），真正的桌面由扩展在客户端动态挂载。删掉它桌面就会消失。

另外，`/?format=json` 与 `/api/search` 是展示页的数据源，无展示页扩展时按设计**降级为 404**；RunX OS 不使用这两个接口。

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

**布局四层**

| 层 | 元素 | 说明 |
|---|---|---|
| 宿主 | `#runx-desktop` | 铺满真实视口，承载缩放徽标与系统级弹层 |
| 逻辑桌面 | `.rx-vscreen` | 尺寸 = 虚拟分辨率，`transform: scale()` 铺满（cover）缩放到视口 |
| 顶部 | `.rx-menubar` | 固定在顶部的 Flexbox 导航条（细分割线），含品牌、开始按钮、菜单栏、状态区 |
| 中间 | `.rx-surface` | 桌面内容层：图标网格 |
| 底部 | `.rx-dock` | 浮动 Liquid Glass 材质应用坞；已打开的应用 + 未打开应用的启动器 |

> `.rx-vscreen` 这一层是为了**虚拟显示器分辨率**：设了 1280×800 后，桌面内部一律用逻辑坐标，
> 缩放交给 CSS `transform`，于是窗口摆位与设备无关。自适应模式下它就等于视口、`scale=1`，
> 行为与没有这一层完全一致（保留结构是为了两套模式走同一条代码路径，不出分支 bug）。
> 缩放到视口时取 `max()`（**cover 铺满**）而非 `min()` —— 桌面必须填满可视区，
> 宁可裁掉边缘也不能四周留白：一旦留白，手机上一滑动就会露出桌面背后的宿主页面。

**开始菜单**（系统级命令总入口）

菜单栏最左侧的 **RunX OS 品牌标**（紫色圆角方块 + 白色 X 的 SVG logo，即开始按钮）/
`⌘␣`。与菜单栏分工明确：
菜单栏管**当前窗口**（文件/编辑/显示/窗口），开始菜单管**整个系统**（开应用 / 设置 / 关于 / 退出）。

- 搜索框自动聚焦，按名称或应用名实时过滤
- 每行含图标、标题、`node · :端口` 副标题、运行状态（运行中为语义绿）
- `↑` `↓` 移动选中项、`Enter` 打开、`Esc` 关闭、点外部关闭
- 底部固定三项：设置 / 关于 / 退出桌面

**触屏长按 = 右键**（`bindLongPress`）

手机上不会有 `contextmenu` 事件，而右键菜单承载了「图标整理 / 窗口操作 / 收起应用」这些
**没有其他入口**的命令，所以要给每个右键点补长按等价物：

| 长按位置 | 弹出 |
|---|---|
| 桌面空白 | 桌面菜单（新建终端 / 打开应用 / 整理图标 / 壁纸 / 分辨率 / 设置） |
| 桌面图标 | 图标菜单（打开 / 重命名 / 移到下一空格 / 从桌面移除） |
| 窗口工具栏 | 窗口菜单（重新加载 / 最大化 / 全屏 / 最小化 / 隐藏 / 关闭） |
| Dock 条目 | 窗口菜单 |

实现要点：**500ms** 阈值（短了与滑动冲突，长了手感迟钝）+ **10px 移动容差**
（手指按住后会抖，超过就视为滚动/拖动立刻取消）+ `navigator.vibrate(15)` 轻震反馈
（手机上判断「按够时间了」的主要体感信号）+ 命中后 `preventDefault` 吃掉随后的 click。
长按与拖拽通过 `iconDragActive` / `dragState` 互斥，否则拖图标走 500ms 会突然弹菜单。

**主题系统：明暗 + 强调色 + 壁纸**

- **明暗**：浅色 / 深色 / 跟随系统（`data-theme`），另适配 `prefers-contrast: more`。
- **强调色**：8 色预设（`data-accent`），每色各有浅色/深色两套值。它**不整体染色**（§2.2），
  只喂给 `--accent / --accent-hover / --accent-press`，`--accent-soft`（14%/22%）与
  `--accent-ring`（34%/42%）用 `color-mix` 从它派生 —— 所以选中态、焦点环、进度条自动跟着变，
  而语义色（红=危险 / 绿=正常）不受影响。
- **壁纸**：6 套内置渐变（`data-wallpaper-id`）/ 图片文件 / 任意图片 URL。
  填 CSS 渐变（如 `linear-gradient(...)`）时按原值应用，不套 `url()`。

枚举值（强调色、壁纸、分辨率预设、窗口位置策略）**全部由服务端 `meta` 下发**，
客户端不硬编码 —— 加一档只改服务端一处，菜单和设置面板自动多一项。

**虚拟显示器分辨率与窗口默认尺寸**

| 设置 | 可选值 | 说明 |
|---|---|---|
| 显示分辨率 | 自适应 / 1280×800 / 1920×1080 / 1024×768 / 414×896 / 2560×1440 / 自定义（320–5120 × 240–2880） | 桌面按此尺寸布局后**铺满**缩放 |
| 缩放 | 等比铺满 / 100% / 75% / 125% | `fit` 取 `max(pw/w, ph/h)`，桌面填满可视区（超出部分裁切） |
| 新窗口位置 | 层叠 / 居中 / 左半屏 / 右半屏 / 四分屏 / 几乎铺满 | `large` 与分区策略会盖过下面的宽高 |
| 新窗口尺寸 | 宽 320–5120 / 高 220–2880 | 默认 860×580 |

缩放 ≠1 时右下角显示 `1280×800 · 113%` 徽标。
**坐标换算统一收口**：`pointOf(e)` 返回逻辑坐标（经 `toLogical`），`pointOfPhysical(e)` 返回屏幕坐标。
若让各调用点自己换算，漏一处就会出现「手指走 100px 而窗口走 100/scale」的拖动跑偏。
上下文菜单挂在**宿主**上（不随桌面缩放）以免在 414px 逻辑宽度下文字缩到看不清，所以它用屏幕坐标定位。

**菜单栏**（§3.2，核心交互范式）：`RunX OS / 文件 / 编辑 / 显示 / 窗口 / 帮助`，共 50+ 条命令。
`窗口` 菜单实时列出所有窗口；`显示` 菜单管工具栏样式、明暗、**分辨率预设与强调色快捷项**（由服务端枚举生成）。

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

**窗口几何持久化**（§3.1）

窗口的位置、大小、最大化/全屏/最小化状态、工具栏样式与层级会写回
`var/runx/desktop.json` 的 `windows` 字段，**刷新页面后原样恢复**。

| 设计点 | 做法 | 原因 |
|---|---|---|
| 落盘时机 | 只在「稳定态」：松手、最大化/全屏切换、关闭、最小化、改工具栏样式 | 拖动/缩放每一帧都写会把内核写爆 |
| 合并 | 300ms debounce | 连续操作只发一次 PUT |
| 写入方式 | `PUT /runx/desktop/windows` 整体覆盖 | 客户端持有全量状态，无半更新；比逐窗口 PATCH 少很多请求 |
| 恢复夹取 | 按**当前** `workArea` 重新夹一遍，保证 ≥120px 标题栏可抓 | 手机横竖屏切换 / 换小屏后窗口不会「消失」在屏幕外 |
| 恢复顺序 | 按 `z` 升序开，先开的在下面 | 层级关系与关闭前一致 |
| 跳过条件 | 仅当应用已从 `apps.json` 卸载 | 见下方说明 |
| 安全子集 | 服务端只收 app/x/y/w/h/minimized/maximized/fullscreen/toolbarStyle/z，数值一律夹取，同 app 去重，上限 24 个 | 脏数据/伪造请求写不进状态文件 |

> **为什么不按「应用在不在跑」决定是否恢复**：早先是「没在跑就跳过」，但应用状态**会变** ——
> 崩溃重启中（`restarting`）能恢复、超过重启上限变 `failed` 就不恢复，同一个存档刷新两次
> 结果不一样，用户会以为窗口数据丢了。现在只在应用真的被卸载时跳过；没起来也照开窗口，
> 窗口里的错误态本身就能说明「应用没跑起来」，比窗口静默消失好得多。

> 恢复时是 **silent** 的：不弹提示、不抢焦点，避免刷新瞬间一串「已打开」糊满屏。
> 页面卸载前走 `pagehide` / `visibilitychange` 把待写快照用 `fetch(..., {keepalive:true})` 送出
> （不用 `beforeunload`：移动端常不触发，且一旦设 `returnValue` 就会弹原生确认框）。

**前端资源的送达方式**（一个不太显然的工程点）

内核把扩展的 `styles`/`scripts` **内联**进 HTML，而扩展目录位于 `.js/`（以点开头，静态路由一律拒绝）。
于是 CSS 里的 `url()` 引用（字体、图标）没有可达地址。桌面扩展因此自己注册了
`GET /runx/desktop-assets/*`：白名单扩展名 + 正确 MIME（woff2 必须有，否则字体静默失效）+
ETag 304 协商。内联的 CSS 在导出前会把相对 `url()` 改写成绝对前缀——
注意 CSS 里的相对地址是按 **CSS 文件自身所在目录** 解析的（`assets/tokens.css` 里写
`fonts/x.woff2` 实际指向 `assets/fonts/x.woff2`），所以重写时要带上基准目录。

### 移动端适配

桌面外壳把「手机能用」当作一等目标（Termux + 手机浏览器是主要场景之一），除了既有的
窄屏布局（≤680px）、触屏热区放大、四处**长按菜单**（长按 = 桌面右键）之外，还包括：

- **viewport 修正**：客户端启动时确保页面有正确的 `<meta name="viewport">` ——
  `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover`。
  `viewport-fit=cover` 是刘海屏安全区 `env(safe-area-inset-*)` 生效的前提；host 页面已有
  meta 时只**补齐**缺失项，不整体覆盖。
- **真实可视区（visualViewport）**：手机上地址栏收起、软键盘弹起时，布局视口
  （`innerWidth/Height`）往往纹丝不动、`window.resize` 不触发，但可见区域确实变了。
  `physViewport()` 优先读 `visualViewport`，并把 `#runx-desktop` 钉在可视区矩形内
  （`offsetTop/offsetLeft/width/height`），窗口和 Dock 不会被键盘盖住；
  `visualViewport` 的 `resize`/`scroll` 与 `orientationchange` 都会触发与 `resize`
  同一套防抖重算（先重算缩放、再夹取窗口，顺序不能反）。
- **手机分辨率回退**：窄形态下，以下情况**显示时**本地回退为「自适应」——
  ① 配置的是**桌面尺寸**预设（宽 > 680，如 1280×800）：否则 1280×800 的桌面在 390px
  宽的手机上会被缩到 30%，导航条小到没法点；② 预设**宽高比与可视区差异过大**
  （偏差 > 35%，如 414×896 竖屏预设放到 844×390 横屏）：否则铺满缩放会放大 2 倍、
  把导航条和 Dock 裁到视口外。**配置本身不动**（回到桌面端仍按原设置渲染），
  比例合适的窄预设（如手机选 414×896）不会被回退。
- **窄形态判定**（`narrow()`）：不看单一信号 —— ① 可视区宽 ≤680；② 设备屏宽 ≤680
  （真机开「桌面版网站」时 `screen.width` 仍是物理宽）；③ 无 hover + 粗指针的触摸设备
  且屏幕物理宽 ≤900（覆盖「桌面版网站」把布局视口撑到 ~980px 的情况；触屏笔记本是
  `(hover:hover)`，不会误判）；④ 视口被缩放（`visualViewport.scale > 1`）。
- **桌面铺满（cover）**：缩放取 `max(pv.w/vp.w, pv.h/vp.h)` 而非 `min()`，桌面**填满**
  可视区，超出部分由 `.rx-vscreen` 的 `overflow:hidden` 裁掉 —— 缩放后的桌面一旦填不满
  视口，四周留白就会露出宿主页面，手机上一滑动整页被滚走、彻底「露馅」。
- **宿主滚动锁**：注入 `html,body{overflow:hidden;height:100%}` + `body{position:fixed}`，
  彻底断掉宿主页面自身的滚动与 iOS 橡皮筋 —— 否则宿主页面的目录/文件列表会把桌面一起滚走。
- **安全区（刘海屏）**：导航条顶部预留 `safe-area-inset-top`、Dock 与 Toast 底部预留
  `safe-area-inset-bottom`（整体上移而不是内部留白），开始菜单的定位与最大高度也把
  上下安全区算进去。`navbarH()` 改为**量导航条的真实渲染高度**而不是读 CSS 变量，
  安全区、窄屏高度变化自动跟随，`workArea` 不需要手动加偏移。
- **触屏交互卫生**：`-webkit-tap-highlight-color: transparent` 去掉 Android 点击灰块、
  `touch-action: manipulation` 消除 300ms 点击延迟并禁用页面捏合缩放、
  `overscroll-behavior: none` 抑制页面级橡皮筋下拉；`(hover: none)` 下把 hover 背景降级为
  `:active` 瞬时反馈，避免触屏「粘」在 hover 态。
- **返回键拦截**：Android 系统返回键不再直接退出页面 —— 用一条 `history` 哨兵拦截
  `popstate`，按「下拉/上下文菜单 → 开始菜单 → 设置/关于/确认弹窗 → 最上层窗口」的
  顺序关掉最上层浮层并重新占位；**没有层可关时放行**，不把用户困在页面里。

### 图标体系（SVG，无 emoji）

界面上的所有图标一律是**内联 SVG 矢量图标**，不使用 emoji 或 Unicode 符号字形：
应用/窗口的兜底图标、Dock 条目、菜单字形（设置/关于/电源/全屏/最大化/勾选/搜索/
回收站/终端/闪电/网格/播放/停止等）全部来自 [Lucide](https://lucide.dev) 图标库
（ISC 许可）的路径数据，构建时已内联进 `client.js`，**零外部请求、离线可用**；
窗口工具栏沿用自绘的 16×16 线框图标。图标用 `currentColor` 描边，
自动跟随文字颜色与强调色，浅色/深色主题下都保持一致观感。

**RunX OS 品牌标识**：紫色圆角方块（填充跟随强调色 `var(--accent)`）+ 白色几何 X
（RunX 的签名）。同一 SVG 同时用于菜单栏品牌标（= 开始菜单入口，19px）、应用菜单
字形与「关于」对话框（48px）。

---

## 已知局限

1. **resize 会重建终端会话**：前台交互程序（`vim`/`top`/`ssh`）会重启。这是零原生依赖（不用 node-pty）的固有取舍。
2. **Termux / Android 上的 `fs.watch` 不可靠**：`watch` 已内置防抖 + 基于 `fs.stat` 的降级轮询兜底。
3. **单机单用户假设**：内核未内置鉴权；若要暴露到公网，请置于反向代理 + 鉴权之后。
4. **窗口「隐藏」状态不持久化**：`⌘H` 隐藏是**临时**操作，刷新后窗口会回来（这与最小化不同 ——
   最小化会记进 `desktop.windows`，刷新后它仍在 Dock 里）。理由是隐藏的语义就是「先收起来一下」，
   若它也持久化，用户重开页面会发现窗口「凭空少了」。
5. **窗口几何按 app 记录，不按窗口实例**：RunX 里同一应用只开一个窗口，所以 `desktop.windows`
   以 `app` 名为键。这既是限制也是简化 —— 未来若支持多实例，需要引入实例 id。

---

## 定时器健壮性

所有定时器时长（`restart_delay_ms` / `cache.*Ttl` / `watch` 防抖间隔等）在进入
`setTimeout` / `setInterval` 之前都会经 `ctx.os.safeMs(v, default, min, max)` 归一化。

原因：`setTimeout(fn, NaN)` 会让 Node 打印 `TimeoutNaNWarning` 并把时长**静默降级为 1ms**——
在手机上就是一个空转的 1ms 定时器，持续耗电。而这些时长常来自 `server.json` / `appex.json`，
可能是字符串、`null`、越界值或 `Infinity`。

归一化规则：非法值（NaN / undefined / null / 非数字字符串 / ±Infinity）→ 回落默认值；
合法数字 → 夹到 `[min, max]`。保证传给定时器的永远是有限正整数。

**支持人类可读的时长字符串**（`ctx.os.parseMs` / `safeMs` 同样接受）：

| 写法 | 解析为 |
|---|---|
| `1500` / `"1500"` | 1500 ms |
| `"500ms"` / `"500 msec"` | 500 ms |
| `"2s"` / `"2sec"` / `"2 seconds"` / `"1.5s"` | 秒 → ms |
| `"2m"` / `"2min"` / `"2 minutes"` | 分 → ms |
| `"1h"` / `"1hr"` / `"1 hour"` | 时 → ms |
| `"1d"` / `"1day"` | 天 → ms |

单位大小写不敏感、允许数字与单位间有空格、支持小数与复数形式。
无法识别的写法（`"abc"` / `"2x"` / 空串 / 对象）一律回落默认值。
`appex.json` 里因此可以直接写 `"restart_delay_ms": "1s"` 而不用换算成 `1000`。

---

## 进程守护与崩溃重启

`start.sh` 内置守护循环（`NO_GUARD=1` 可关闭）：

- **异常退出自动拉起**：内核以非 0 码退出（被 OOM/信号杀掉、抛未捕获异常）→ 自动重启。
  退出码为 0 视为「内核自己决定结束」，不重启。
- **指数退避**：连续快速崩溃时重启间隔 1s → 2s → 4s → 8s … 封顶 30s（`BACKOFF_BASE` / `BACKOFF_MAX`）。
  只要一次运行超过 `STABLE_SECS`（默认 30s），退避计数**归零** —— 偶发崩溃不累积惩罚。
- **连续崩溃停手**：`STABLE_SECS` 内崩了超过 `MAX_CRASH`（默认 6）次，停止重启并打印排查建议
  （怎么直接看崩溃栈、怎么查端口、怎么重建运行时状态），而不是无意义空转。
- **Ctrl+C 干净退出**：视为用户主动停止，不触发重启；先 `SIGTERM` 优雅关停，5s 未退再 `SIGKILL`。
- **不覆盖已有 `desktop.json`**：该文件承载图标位置、主题、壁纸与**窗口几何**，
  每次启动重写等于清空用户桌面布局 —— 只在文件不存在时写入默认值。

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `NO_GUARD` | `0` | `1` = 关掉守护重启（调试看崩溃栈时用） |
| `STABLE_SECS` | `30` | 运行多久算「稳定」（超过则退避归零） |
| `MAX_CRASH` | `6` | 连续快速崩溃多少次后停手 |
| `BACKOFF_BASE` / `BACKOFF_MAX` | `1` / `30` | 退避起点 / 上限（秒） |
| `PORT` | `3000` | 内核监听端口 |

> 实现上有个 bash 细节值得记一笔：`boot_kernel` 里**不能**直接 `wait "$SRV"`。
> bash 的 trap 要等当前前台命令返回才执行，而 `wait` 会阻塞到子进程退出 ——
> 结果就是 Ctrl+C 后 trap 不跑，用户得再按一次。也不能用 `wait "$SRV" &`
> （后台子 shell 里 `$SRV` 不是它的孩子，会报 `is not a child of this shell`）。
> 正确做法是主 shell 用 `sleep` 短轮询探活：`sleep` 是前台命令、能被信号立刻打断。

---

## 致谢 / 许可

- 内核改造自 [NavExt](https://github.com/chinartcn/NavExt)（MIT），当前基线 **v2.8.3**。
- 本项目版权归 chinartcn，采用 **MIT 许可**。

```
RunX OS = NavExt v2.8.3（内核）+ os.js（特权层）+ 5 个核心扩展 + 应用层
```
