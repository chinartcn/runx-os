---
title: 安装与启动
---

# 安装与启动

## 一条命令

```bash
curl -fsSL https://raw.githubusercontent.com/chinartcn/runx-os/main/install.sh | bash
```

脚本会克隆仓库并启动。启动后打开：

- **桌面**：http://localhost:3000/
- **内置终端**：http://localhost:3460/ （桌面双击「终端」图标也可）

## 国内网络 / 加速镜像

安装脚本会**自动依次尝试「直连 GitHub → 多个加速镜像」**，克隆失败还会回退到 tarball 下载（无需 git）。

```bash
# 方式 A：gh-proxy 加速（注意镜像地址要拼两遍 https）
curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/chinartcn/runx-os/main/install.sh | bash

# 方式 B：jsDelivr CDN
curl -fsSL https://cdn.jsdelivr.net/gh/chinartcn/runx-os@main/install.sh | bash

# 方式 C：手动指定克隆镜像
RUNX_MIRROR=https://gh-proxy.org/ bash install.sh
```

内置镜像列表（按序尝试）：`github.com` 直连 → `gh-proxy.org` → `ghproxy.net` → `ghfast.top` → `codeload.github.com` tarball。

## 环境变量

| 变量 | 说明 |
|---|---|
| `RUNX_MIRROR=<前缀>` | 只用指定镜像，跳过直连与自动探测 |
| `RUNX_MIRROR=off` | 只用 GitHub 直连 |
| `RUNX_BRANCH=<分支>` | 指定分支，默认 `main` |

## 手动安装

```bash
git clone https://github.com/chinartcn/runx-os.git
cd runx-os
./start.sh                 # 前台运行，Ctrl+C 停止
PORT=8080 ./start.sh       # 自定义端口
node server.js             # 不经守护脚本直接起内核
```

**端口优先级**：`--port` 命令行参数 > 环境变量 `PORT` > `server.json` 的 `port` > 3000。
容器/托管平台（Cloud Run、Railway、Heroku、fly.io…）注入的 `PORT` 会被采纳。

## 环境要求

- **Node.js ≥ 18**（桌面用到的 `ctx.fetch` 需要 ≥ 18；内核本身 ≥ 14）
- `bash`
- `git` 或 `curl` 二选一

## 目录结构

```text
runx-os/
├── server.js          内核（零依赖）
├── .js/               扩展（core 扩展独享 ctx.os 特权通道）
│   ├── js.list.json   扩展加载顺序
│   ├── @runx-desktop  桌面 UI
│   ├── @runx-rights-manager  账号 / 授权 / UAC
│   └── ...
├── packages/          应用开发包（不发 npm，从本仓库分发）
│   ├── runx-host      @runx/host
│   ├── runx-sdk       @runx/sdk
│   └── runx-ui        @runx/ui
├── apps/              已部署应用
└── var/runx/          运行时状态（gitignore）
```

## 挂载开发包

```bash
node packages/link.js --all
```

把 `@runx/host` / `@runx/sdk` 软链进应用目录。

> 装了围栏（`@runx-node-safety`）的应用跑在 Node 权限模型里，只能读自己目录。
> 围栏在生成 `--allow-fs-read` 时会**自动放行这两个包所在的目录** —— 所以不会把应用卡住。

## 停止

```bash
pkill -f "server.js --root"
```
