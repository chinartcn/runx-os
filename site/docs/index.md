---
title: RunX OS
---

# RunX OS

一个跑在浏览器里的**网页桌面操作系统**：基于 [NavExt](https://github.com/chinartcn/NavExt)（零依赖 Node.js 静态导航服务器）改造的内核，叠加一组核心扩展，构成可安装、可托管 Web/Node 应用的桌面环境。

> 零运行时依赖。不需要 `npm install`、不需要编译原生模块。只要一台装了 Node.js 的机器（手机 / 平板 / 树莓派 / 服务器均可），`node server.js` 就能起来。

## 它是什么

| | |
|---|---|
| **不是** | 操作系统、内核级沙箱、多租户云桌面 |
| **是** | 一个 Node 主进程 + 浏览器里的桌面 + 一套权限与扩展模型 |

应用是你自己装的 Web 应用或 Node 应用；系统负责把它们跑起来、管起来、并在越权时拦住。

## 五个组成部分

### 内核（server.js）

零依赖的 Node HTTP 服务器。负责静态托管、扩展注入、Web 应用代理、Node 应用生命周期。

### 桌面（@runx-desktop）

浏览器渲染的桌面：可拖拽窗口、Dock、图标网格、菜单栏、全局快捷键。应用窗口是 iframe。

### 权限（@runx-rights-manager）

多用户账号、授权表、UAC 审批、风险判定。能力即字符串。

### 围栏（@runx-node-safety）

把 Node 应用关进 Node 权限模型（`--experimental-permission`）里，越权访问由内核直接拦。

### 商店（RunX Store）

应用分发。开发者自带干粮（GitHub / npm），商店只存元数据与校验值。

## 设计取向

- **能力即字符串。** `fs.read:/sdcard/**` 同时说明「能做什么」和「能碰哪些路径」。授权永远是「应用 + 能力 + 范围」三元组。
- **读能力是一个家族。** 一条 `fs.read:/data/**` 同时覆盖 `fs.list` / `fs.stat` / `fs.watch` —— 同一个决定不会问三遍。
- **对话框不是 UAC。** UAC 的答案是枚举（允许/拒绝）；对话框的答案是数据（用户亲自点出来的路径、文件名、按钮 id）。应用永远不能指定自己想去哪。
- **零依赖是硬约束。** 内核与所有扩展都不装第三方包。省下来的不只是体积，还有「升级时会不会炸」这个问题的答案。

## 上手

- [安装与启动](/guide/install) —— 一条命令
- [写第一个应用](/guide/first-app) —— 十行代码
- [权限与围栏](/guide/security) —— 这套系统最要紧的部分

## 在线站点

| | |
|---|---|
| [www.rtcnnavext.de5.net](https://www.rtcnnavext.de5.net/) | 官网 |
| [docs.rtcnnavext.de5.net](https://docs.rtcnnavext.de5.net/) | 本文档 |
| [store.rtcnnavext.de5.net](https://store.rtcnnavext.de5.net/) | 应用商店 |
| [api.rtcnnavext.de5.net](https://api.rtcnnavext.de5.net/) | 公共 API |
| [api.user.rtcnnavext.de5.net](https://api.user.rtcnnavext.de5.net/) | 开发者 API |
