---
title: 扩展模型
---

# 扩展模型

扩展就是一个放进 `.js/` 的目录。**没有插件系统、没有 manifest 校验器、没有版本协商** —— 就是一个文件夹。

## 目录结构

```text
.js/@runx-example/
├── mod.json       元信息：名字、版本、是否 core、加载顺序
├── js.json        注入到客户端页面的配置（可以是空对象）
├── index.js       服务端逻辑（可选）
├── client.js      浏览器端逻辑（可选）
└── styles.css     样式（可选）
```

## mod.json

```json
{
  "name": "界面组件库（RunX 扩展）",
  "version": "1.0.0",
  "core": true,
  "order": 4,
  "requires": []
}
```

| 字段 | 说明 |
|---|---|
| `core` | `true` 表示独享 `ctx.os` 特权通道（内核级能力，不受应用沙箱约束） |
| `order` | 加载顺序。小的先加载 |
| `requires` | 依赖的其他扩展名 |

## js.list.json

扩展的**加载顺序由这个清单决定**，不是按目录名字母序：

```json
[
  "@runx-browser-api",
  "@runx-ui",
  "@runx-rights-manager",
  "@runx-administrator-mode",
  "@runx-supervisor",
  "@runx-node-safety",
  "@runx-pax",
  "@runx-mounts",
  "@runx-event-bus",
  "@runx-desktop",
  "@runx-monitor",
  "@runx-files",
  "@runx-settings",
  "@runx-x11"
]
```

顺序有讲究的地方：

- `@runx-event-bus` 要在别的扩展之前 —— 它们要订阅总线。
- `@runx-rights-manager` 要在 `@runx-administrator-mode` 之前 —— 提权票据由它签发。
- `@runx-desktop` 靠后 —— 它要在权限层就位之后才挂窗口。

## core 与非 core

**core 扩展**（`"core": true`）走 `ctx.os` 特权通道，能直接调用内核能力，不受应用围栏约束。内核自带的这些都是 core。

**非 core 扩展**只拿到受限的 `ctx` —— 它的能力要通过 `@runx-rights-manager` 申请。

唯一不是 core 的是 `@runx-browser-api`：它是给应用用的能力层，自己不需要特权。

## 客户端注入

`js.json` 里放要注入页面的东西：

```json
{
  "settings": { "theme": "auto" }
}
```

注入到页面的是 `__NAV_DATA__`（内核数据）与 `navext-client`（内核脚本）。

`client.js` 会被打包成一段脚本注入每个页面。它拿到 `window.RunX` 这个全局对象：

```js
RunX.rights.dialog.pending();   // 待处理的对话框
RunX.rights.clipboard.write('...');
```

## 静态资源

扩展可以带静态文件，通过 `ctx.os.serveStatic` 或自己起路由发出去。

`@runx-ui` 就是这么做的：它把 `packages/runx-ui/` 里的 CSS/JS 发到 `/runx/ui/*`。

> 应用页面在**自己的源**里（`http://localhost:3480/`），
> 所以 `@font-face` 必须带 `Access-Control-Allow-Origin` ——
> 否则字体被 CORS 挡掉，界面「偶尔」加载失败。
> 这就是 `/runx/ui/fonts/*` 单独一条路由的原因。
