# @runx/host

RunX 桌面 API（应用侧）。让一个跑在 RunX 里的 Node 应用知道自己**是个窗口**，而不只是一个端口：发通知、开子窗口、改标题、读主题、在事件总线上和其他应用说话。

零依赖，一个文件。**Node 18+ 可用**；`bus` 的订阅依赖内置 `WebSocket`，需要 **Node 21+**（发通知、开窗口不受影响）。

```js
const rx = require('@runx/host');

await rx.notify({ title: '导出完成', body: '3 个文件已保存到 /sdcard/out' });
await rx.dock.badge(7);
```

---

## 安装

不发 npm，从仓库装（`private: true`，`npm publish` 会直接拒绝）：

```bash
node packages/link.js notes            # 推荐：把两个包软链进 apps/notes，仓库更新即生效
```

```bash
cd apps/notes && npm i ../../packages/runx-host    # 或者用 npm 装（也是软链）
```

为什么不能 `npm i github:chinartcn/runx-os` —— npm 装不了 monorepo 子包，只能 clone 之后指路径。三种装法的对比见 [packages/README.md](../README.md)。

## 为什么是服务端调用

应用的页面在**另一个源**的 iframe 里（终端在 `:3460`，桌面在 `:3000`）。桌面壳没法给页面注入任何变量，页面也没法凭自己证明「我是哪个应用」。进程侧可以：supervisor 启动应用时注入 `RUNX_APP_TOKEN`，桌面后端按令牌反查应用名。

所以调用从**服务端**发起，前端只负责表现。这也意味着本包不能在前端 bundle 里用。

## 不在 RunX 里跑会怎样

没有 `RUNX_APP_NAME` / `RUNX_APP_TOKEN` 时，所有方法都抛 `ENOTRUNX`。这是刻意的显式失败：静默降级会让「本地调试没问题、装进 RunX 就不通知」这种 bug 藏很久。

要写「有就用、没有就跳过」的应用，判断 `rx.enabled` 即可：

```js
if (rx.enabled) await rx.notify({ title: 'hi' });
```

---

## API

### `rx.app`

只读身份对象，`{ name, port, dataDir, gateway }`。不在 RunX 里时 `name` 是空串。

### `rx.enabled`

布尔。是否跑在 RunX 里。

### `rx.ready()`

握手，返回桌面认定的应用名。适合在启动时打一行日志确认身份接对了。

### `rx.theme`

| 方法 | 说明 |
|---|---|
| `get()` | `{ mode: 'light'\|'dark'\|'auto', accent, accentId, wallpaper }` |
| `onChange(fn)` | 主题变化回调，返回取消订阅函数 |

别轮询 `get()` —— 那只是每秒一次 HTTP 的浪费。`onChange` 走的是事件总线，桌面主题真的变了才触发。

```js
rx.theme.onChange((t) => document.documentElement.dataset.theme = t.mode);
```

### `rx.notify({ title, body })`

桌面右上角的浮层通知。最多同时显示 4 条，5.2 秒自动淡出。

### `rx.window`

| 方法 | 说明 |
|---|---|
| `open({ url, title, w, h })` | 开一个新窗口 |
| `setTitle(title, subtitle)` | 改自己所有窗口的标题 |

`url` 必须落在**本应用自己的端口**上，相对路径（`/detail`）也行，后端按应用端口补全。指到别人的端口会拿到 `403` —— 否则任何应用都能把任意网页伪装成自己的窗口。

### `rx.dock.badge(count)`

Dock 上的角标数字（未读数 / 待办数）。传 `0` 清除。

### `rx.bus`

| 方法 | 说明 |
|---|---|
| `publish(topic, payload)` | 发事件 |
| `subscribe(topic, fn)` | 订阅，返回取消订阅函数 |
| `request(topic, payload, {timeout})` | 请求 / 响应，默认 15 秒超时 |

**命名空间**：裸 topic 会自动挂到 `app.<自己>.` 前缀下 —— 否则两个应用都 `subscribe('download.done')` 会互相串台。以 `app.` / `sys.` / `host.` 开头的原样发送。

```js
rx.bus.subscribe('download.done', fn);      // → app.<自己>.download.done
rx.bus.subscribe('app.files.*', fn);        // 订阅别的应用（支持 * / **）
rx.bus.subscribe('sys.*', fn);              // 系统事件
rx.bus.publish('sys.hello', { at: Date.now() });
```

总线连接是**懒建**的：只发通知不订阅的应用不会开 WebSocket。建立后常驻，断线按 1s → 8s 退避重连，重连后自动把订阅重放一遍（内核重启不需要应用感知）。

订阅依赖 Node 内置的 `WebSocket`（**21+**）。在 18/20 上 `subscribe()` 会同步抛
`ENOWEBSOCKET` —— 而不是默默收不到事件。要写兼容代码：

```js
if (rx.bus.available) rx.bus.subscribe('app.*.done', fn);
```

`request()` 的约定是请求方在 payload 里带 `__replyTo`，应答方按它回一条。需要对方配合，不适合作通用 RPC 用，但两个应用之间握手足够了。

### `rx.call(method, params, opts)`

逃生口。调一个还没被封装的方法，直接拿后端的 `result`。

### `rx.close()`

断开总线。进程退出前调用；不调也会随进程结束。

---

## 环境变量

由 supervisor 注入，一般不用手动设置。

| 变量 | 说明 |
|---|---|
| `RUNX_APP_NAME` | 应用名 |
| `RUNX_APP_TOKEN` | 应用令牌，桌面后端凭它认人 |
| `RUNX_GATEWAY` | 桌面地址，默认 `http://127.0.0.1:3000` |
| `RUNX_APP_PORT` | 本应用端口 |
| `RUNX_APP_DATA` | 应用数据目录 |

身份变量**不可被应用清单覆盖**：`appex.json` 里的 `env` 是先合并、身份后覆盖，免得一个应用把自己伪装成另一个。
