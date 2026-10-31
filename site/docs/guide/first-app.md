---
title: 写第一个应用
---

# 写第一个应用

一个 RunX 应用就是一个目录，里面有一个 `appex.json`。

## 最小示例

```text
my-app/
├── appex.json
├── app.js
└── public/
    └── index.html
```

**appex.json**

```json
{
  "schema": 1,
  "name": "hello",
  "version": "1.0.0",
  "type": "node",
  "entry": "app.js",
  "port": 3480,
  "display_name": "你好",
  "icon": "public/icon.svg",
  "description": "第一个 RunX 应用",
  "restart": "on-failure",
  "autostart": false,
  "data_dir": "data",
  "permissions": ["fs.read:./**", "fs.write:./data/**"]
}
```

**app.js**

```js
const http = require('http');

http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<h1>你好，RunX</h1>');
}).listen(3480, '0.0.0.0');
```

`type` 有三种：

| type | 说明 | 入口 |
|---|---|---|
| `node` | Node 应用，跑在围栏里 | `entry`（默认 `app.js`） |
| `web` | 静态站点 | `public/` |
| `hybrid` | Node + 静态 | 两者都有 |

## 装上去

```bash
# 方式一：放进 apps/ 目录
cp -r my-app apps/hello

# 方式二：tarball 走 PaX 安装（会安全解包 + 校验）
```

应用出现在桌面图标网格里，双击开窗口。

## 用 SDK

```js
const rx = require('@runx/sdk');

// 读自己的文件
const txt = await rx.fs.read('./data/note.md');

// 写自己的文件
await rx.fs.write('./data/note.md', '第一行\n');

// 弹一个真正的文件选择器（路径由用户在桌面点出来）
const picked = await rx.dialog.open({ filters: [{ name: '文本', ext: ['md', 'txt'] }] });
if (picked.cancelled) return;
const content = await rx.fs.read(picked.paths[0]);
```

> `rx.dialog.open()` 返回的路径**不在** `appex.json` 的权限里 ——
> 但用户亲手选过它，系统会为**那一个路径**自动记一条授权。

## 网页部分

Web 应用（`type: "web"`）就是普通网页。它能拿到：

- `@runx/ui` 组件库（`/runx/ui/runx-ui.css`）—— 与桌面同一套视觉语言
- `@runx/host`（通过事件总线）—— 主题、通知、Dock 角标

```html
<link rel="stylesheet" href="/runx/ui/runx-ui.css">
<script src="/runx/ui/runx-ui.js"></script>
```

## 权限怎么写

`permissions` 是能力字符串数组：

```json
"permissions": [
  "fs.read:./**",
  "fs.write:./data/**",
  "fs.watch:./**",
  "proc.spawn:/usr/bin/tr",
  "dialog.open",
  "clipboard.read",
  "clipboard.write",
  "sys.info"
]
```

- 路径范围用 glob。`./**` 是应用目录整体。
- `dialog.open` / `clipboard.*` 没有范围 —— 它们不是路径能力。
- `proc.spawn` 的范围是**可执行文件的路径**，不是命令行参数。
- 申请了不用的能力，用户第一次运行时会少弹一个框 —— 写窄一点。

细节见 [权限与围栏](/guide/security)。
