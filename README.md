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

也可手动：

```bash
git clone https://github.com/chinartcn/runx-os.git
cd runx-os
./start.sh                 # 前台运行，Ctrl+C 停止
PORT=8080 ./start.sh       # 自定义端口
```

要求：Node.js ≥ 14（桌面用到的 `ctx.fetch` 需要 ≥ 18），`git`，`bash`。

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
│   ├── @runx-desktop      桌面 UI（图标 / 窗口 / 任务栏 / 壁纸），iframe 隔离加载应用
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

## 已知局限

1. **resize 会重建终端会话**：前台交互程序（`vim`/`top`/`ssh`）会重启。这是零原生依赖（不用 node-pty）的固有取舍。
2. **Termux / Android 上的 `fs.watch` 不可靠**：`watch` 已内置防抖 + 基于 `fs.stat` 的降级轮询兜底。
3. **单机单用户假设**：内核未内置鉴权；若要暴露到公网，请置于反向代理 + 鉴权之后。

---

## 致谢 / 许可

- 内核改造自 [NavExt](https://github.com/chinartcn/NavExt)（MIT）。
- 本项目版权归 chinartcn，采用 **MIT 许可**。

```
RunX OS = NavExt（内核）+ os.js（特权层）+ 5 个核心扩展 + 应用层
```
