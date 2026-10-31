# 示例应用（`demo`）

RunX 的**活文档**：一个应用，五页，把 SDK 的五项能力逐个演示一遍。
它同时是 [`@runx/ui`](../../packages/runx-ui/) 组件库的使用样例。

```bash
# 仓库根目录
node packages/link.js --all      # 把 @runx/sdk / @runx/host 挂进应用
node server.js --root . --port 3000
```

然后在桌面双击「示例」图标，或直接开 `http://127.0.0.1:3470/`。

## 五个标签页

| 页 | 演示什么 | 关键点 |
|---|---|---|
| **文件** | `dialog.open` / `dialog.save` | 路径**由用户在桌面点出来**，应用不能指定 |
| **监听** | `fs.watch` | 文件一变就推过来（长轮询，不是 WebSocket） |
| **大文件** | `fs.readRange` 分块 | 4 MB 分 16 块；整块读会被 `ETOOBIG` 拒掉 |
| **进程** | `proc.spawn` + stdin | 喂 8 KB 给 `tr`，看它边读边吐大写 |
| **剪贴板** | `clipboard.read/write` | 写是低危；读要审批（剪贴板里可能有密码） |

## 三个刻意保留的设计

**1. 页面没有一行自己的按钮样式。**

所有控件都是 `@runx/ui` 的类：

```html
<button class="rx-btn primary" id="btn-open">选择文件…</button>
```

页面只引两个文件：

```html
<link rel="stylesheet" href="__GATEWAY__/runx/ui/runx-ui.css">
<script src="__GATEWAY__/runx/ui/runx-ui.js"></script>
```

`__GATEWAY__` 是占位符，服务端渲染时替换成真实网关地址（应用在自己的端口上，
运行时才知道内核在哪）。

**2. 错误分三层返回。**

`{ok:false, code, message, hint}` —— `code` 给程序看，`message` 给人看，
`hint` 说「下一步怎么办」：

```json
{
  "ok": false,
  "code": "NEED_ADMIN",
  "message": "启动子进程需要管理员模式",
  "hint": "在桌面「显示 → 管理员模式」里开启，或先读一次系统信息"
}
```

页面把 `hint` 画成红字，**不把内核原文直接甩给用户**。

**3. 主题跟着桌面走。**

服务端订阅 `host.theme`，变化时通过 SSE 推给页面；页面 `RX.theme(mode)`。
这样窗口内外是同一种颜色 —— 亮色桌面上挂一个深色窗口，比任何配色都刺眼。

## 代码结构

```
apps/demo/
├── app.js          服务端：路由、SSE、SDK 调用
├── appex.json      能力声明（permissions 里的 glob 就是授权范围）
├── public/
│   ├── index.html  页面结构（全是 .rx-* 类）
│   ├── app.js      页面逻辑：EventSource + 事件委托
│   └── icon.svg
└── data/           运行时数据（gitignore）
```

服务端零业务逻辑用本地 `fs` —— 唯一的例外是 `/api/seed`：它要造一个 4 MB 的
`big.bin`，用 SDK 写会触发授权流，演示时反而看不清楚。

## 端到端测试

```bash
node --experimental-websocket /tmp/rxt/e2e_demo.js
```

脚本扮演「桌面」：真连事件总线、真答审批框（`always-dir`）、真答文件选择器。
36 项断言，覆盖上面五项能力的每一条路径。
