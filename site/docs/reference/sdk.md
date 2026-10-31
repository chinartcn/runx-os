---
title: "@runx/sdk"
---


RunX 应用侧的**操作系统接口**：文件、进程、网络、对话框、剪贴板。每一次调用都经过
用户授权。

```js
const rx = require('@runx/sdk');

const txt = await rx.fs.read('/sdcard/notes/today.md');
await rx.fs.write('/sdcard/notes/today.md', txt + '\n- 新的一条');
```

零依赖，一个文件，Node 18+。类型声明在 `index.d.ts`。

## 为什么不用 fs

| | `require('fs')` | `@runx/sdk` |
|---|---|---|
| 用户知道吗 | 不知道 | 第一次会弹框问 |
| 能被拒绝吗 | 不能 | 能（拒绝一次，本次失败） |
| 范围可控吗 | 整个文件系统 | 按能力 + 作用域授权 |
| 有审计吗 | 没有 | 有（`var/runx/logs/rights.log`） |

而且围栏（[@runx-node-safety](../../.js/@runx-node-safety/README.md)）会把应用进程本身
关进笼子：`require('fs')` 读笼子外的文件直接 `ERR_ACCESS_DENIED`。想让用户放行，就得
走 SDK。

## 安装

不发 npm，从仓库装（`private: true`，`npm publish` 会直接拒绝）：

```bash
node packages/link.js notes          # 软链进 apps/notes，仓库更新即生效
node packages/link.js --copy notes   # 应用要整个打包带走时用这个（快照）
```

或者用 npm 指本地路径（同样是软链）：`cd apps/notes && npm i ../../packages/runx-sdk`。
三种装法与「为什么不能 `npm i github:...`」见 [packages/README.md](../README.md)。

依赖要装在**应用自己的目录**里（`node_modules/`）。软链到 `packages/` 也没问题：
围栏（node-safety）会自动放行这两个包所在的目录 —— 否则「能走审批」的前提
（应用能 `require('@runx/sdk')`）就不成立。

## 不在 RunX 里跑会怎样

没有 `RUNX_APP_NAME` / `RUNX_APP_TOKEN` 时所有方法抛 `ENOTRUNX`。不做本地直通回退：
那会让「本地测试一切正常、装进 RunX 处处被拒」这种 bug 藏很久。

```js
const rx = require('@runx/sdk');

if (rx.enabled) {
  await rx.fs.write(path, data);
} else {
  fs.writeFileSync(path, data);   // 独立运行时的降级路径
}
```

## API

### `rx.app` / `rx.enabled`

```js
rx.app   // { name, port, dataDir, gateway, user }
rx.enabled  // 是否跑在 RunX 里
```

### `rx.fs`

| 方法 | 返回 |
|---|---|
| `read(path, {encoding})` | `{path, content, encoding, size, mtime}`，二进制自动 `base64`；**上限 2MB**，再大用流 |
| `write(path, content, {encoding, append})` | `{path, size, created}`，父目录自动建 |
| `list(path)` | `{path, entries:[{name, type, size, mtime}]}`，目录在前 |
| `stat(path)` | `{exists, type, size, mtime, mode}` |
| `mkdir(path, {parents})` | `{path}` |
| `remove(path, {recursive})` | `{path, removed}`，删目录必须显式 `recursive` |
| `copy(from, to, {recursive})` / `move(from, to)` | `{from, to}`，跨设备自动退化 |
| `readRange(path, {offset, length})` | `{offset, bytes, size, eof, data, mtime}`，`data` 是 base64 |
| `writeRange(path, data, {truncate, append, offset})` | `{path, offset, bytes, size}` |
| `createReadStream(path, {highWaterMark, start, end})` | Node `Readable`，另有 `stream.size()` |
| `createWriteStream(path, {append})` | Node `Writable`，内部串行按 offset 写 |
| `watch(path, onEvent)` | `{id, ready, close(), closed}` |
| `waitChange(path, timeoutMs)` | 一条变化事件 `{event, name, at, seq}` |

#### 大文件：流

`read` 是「一次拿到全部内容」，2MB 以上会直接 `ETOOBIG`。大文件走流，形状和本地
`fs.createReadStream` 一模一样：

```js
const rs = rx.fs.createReadStream('/sdcard/video/raw.mp4', { highWaterMark: 256 * 1024 });
const ws = rx.fs.createWriteStream('/sdcard/video/copy.mp4');

let done = 0;
rs.on('data', (chunk) => { done += chunk.length; ui.progress(done); });
rs.pipe(ws);
await new Promise((res, rej) => ws.on('finish', res).on('error', rej));
```

底层是 `readRange` / `writeRange`：**单块 ≤1MB，总量不限**。每块都过一次权限网关，
但只有第一块会问人（之后命中授权表）。

一块的边界可能正好切在一个汉字中间，所以流产出的是 **Buffer**。要字符串就
`rs.setEncoding('utf8')` —— 它内部用 `StringDecoder` 跨块拼接，不会给你 U+FFFD。

#### 监听文件变化

```js
const w = rx.fs.watch('/sdcard/notes', (e) => {
  console.log(e.event, e.name, e.seq);   // 'change' | 'rename'
}, { onError: (e) => console.warn(e.code, e.message) });

await w.ready;        // {id, path, is_dir}，失败时 reject（没权限 / 路径不存在）
// ...
await w.close();
```

是内核 `fs.watch` + 应用侧**长轮询**，不是 WebSocket —— 所以 Node 18 也能用，也不需要
应用自己起服务。代价是「事件到达」最多晚一个轮询周期（有变化立刻返回，没变化挂 25 秒）。

上限：一个应用同时 8 个监听，闲置 5 分钟自动回收，应用停止时全部关掉。

只想等一次：

```js
const e = await rx.fs.waitChange('/sdcard/notes/today.md', 60000);   // 超时抛 ETIMEDOUT
```

### `rx.proc`

```js
const { pid } = await rx.proc.spawn(['ffmpeg', '-i', 'in.mp4', 'out.gif'], { cwd: '/tmp' });
const st = await rx.proc.status(pid);   // {running, exit, stdout, stderr}（各留 8KB）
await rx.proc.kill(pid, 'SIGTERM');
```

`argv` 是数组，没有 shell。要跑管道就自己起 `sh -c`，并把整条命令作为参数 —— 那样
申请的能力是 `sh`，用户在弹框里看得见。

#### 喂 stdin

默认子进程的 stdin 是 `/dev/null`（不是管道）：`cat`、`grep`、任何等输入的命令
在有管道时会一直等，而多数应用根本没打算喂数据 —— 那就成了永远不退出的僵尸进程。
需要喂的时候显式打开：

```js
const { pid } = await rx.proc.spawn(['tr', 'a-z', 'A-Z'], { stdin: true });

await rx.proc.write(pid, 'hello runx\n');   // 单次 ≤64KB
console.log((await rx.proc.status(pid)).stdout);

await rx.proc.end(pid);    // 发 EOF —— 这一步是 tr / cat 结束的条件
```

> 一个和 SDK 无关但一定会踩到的坑：`tr`、`sed` 这类命令的 stdout 是 **4KB 全缓冲**。
> 只喂几十字节，它们不会吐任何东西，要等 EOF 才 flush。想立刻看到回显，用 `cat`。

一次做完（起 → 喂 → EOF → 等 → 收）：

```js
const r = await rx.proc.run(['sha256sum'], { input: fileBuffer });
// {code, signal, stdout, stderr, timedOut}
```

### `rx.dialog`

让用户在**桌面上**选东西。关键点：路径是用户选的，不是应用给的 —— 所以这里没有
`defaultPath`，`startIn` 也只能落在自己家（沙箱 data 目录 → 应用 cwd → 家目录）。

```js
const r = await rx.dialog.open({ title: '选一个 Markdown', filters: ['md', 'txt'] });
if (r.cancelled) return;              // 用户点了取消
console.log(r.path);                  // 用户在桌面上亲手点的那一个
const txt = await rx.fs.read(r.path); // 不会再弹框
```

| 方法 | 返回 |
|---|---|
| `open({title, filters, multiple, startIn})` | `{cancelled, path, paths, granted, risk}` |
| `save({title, defaultName, filters, startIn})` | 同上；文件可以先不存在 |
| `message({title, message, buttons})` | `{cancelled, value}`，`value` 是按钮 id |
| `confirm(title, message)` | `true` / `false`（取消也算 false） |
| `alert(title, message)` | `{cancelled, value}`，只有「知道了」 |

选中即授权：用户点中的路径会被记成一条**仅该路径**的授权，所以紧接着读它不再问第二遍。
高危路径（`~/.ssh`、`/etc/shadow` 之类）**不**自动授权 —— 「挑了个文件」不等于「知道
应用要拿它做什么」，那种情况还是要走一次审批。

拖动框、按 Esc、关掉桌面窗口都算 `cancelled`，不抛错。

### `rx.clipboard`

```js
await rx.clipboard.write('要粘到别处的一段字');     // 低危：写进去不会泄漏什么
const c = await rx.clipboard.read();               // 中危：可能刚复制过密码
// {text, empty, at, size}
```

是**内核里的共享文本缓冲区**，不是系统剪贴板。桌面会尽力把它镜像到系统剪贴板
（`navigator.clipboard`），但浏览器权限、焦点、手机 WebView 都可能让同步失败 ——
所以「应用之间可靠，跨出浏览器不确定」，别拿它当「一定能粘到别的程序里」的保证。

上限 256KB，保留最近 20 条历史（每条截到 8KB）。

### `rx.net`

```js
const r = await rx.net.fetch('https://api.example.com/items', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ q: 1 }),
});
// {status, headers, content, truncated, url}
```

走这里而不是自己 `https.request` 的理由：目标主机在授权表里，用户能看到「这个应用要连
哪儿」。云元数据地址（`169.254.*`、`100.100.100.200`）被内核硬编码屏蔽。

### `rx.sys`

```js
await rx.sys.info();   // {platform, arch, node, hostname, cpus, memory, uptime_s, homedir, app}
```

### `rx.call(area, op, params, {timeout})`

逃生口：调没有封装的新接口。

## 能力表

授权永远是「应用 + 能力 + 作用域」三元组。目前一共 14 个：

| 能力 | 风险 | 说明 |
|---|---|---|
| `fs.read` | 中 | 读文件内容 |
| `fs.list` `fs.stat` | 低 | 看目录、看元信息 |
| `fs.watch` | 中 | 监听变化 |
| `fs.write` | 高 | 写、追加、覆盖 |
| `fs.remove` `fs.mkdir` `fs.copy` | 高 | 改结构 |
| `proc.spawn` | 高 | 起进程（可以绕过其余所有限制） |
| `net.fetch` | 中 | 代发 HTTP，目标是某个 origin |
| `sys.info` | 低 | 平台、内存、主机名 |
| `dialog.open` | 低 | 让用户在桌面上选路径（应用无法指定） |
| `clipboard.write` | 低 | 写共享缓冲区 |
| `clipboard.read` | 中 | 读共享缓冲区 |

`fs.read` / `fs.list` / `fs.stat` / `fs.watch` 是**一个家族**：一条
`fs.read:/sdcard/**` 同时覆盖另外三个。同一个目录不会问你四遍。

## 错误

每个错误都有 `code`（字符串常量，不要解析文案）：

| code | 含义 |
|---|---|
| `ENOTRUNX` | 不在 RunX 里 |
| `EPERM` | 用户拒绝了，或没有授权且没人可问 |
| `NEED_ADMIN` | 高危操作，需要先开管理员模式 |
| `ENOUI` | 桌面没开，没人能批准 |
| `ETIMEDOUT` | 等待审批超时（默认 100 秒） |
| `ENOSYS` | 内核没加载这个服务（例如剪贴板扩展被裁掉了） |
| `ECLOSED` | 监听已被关闭（应用停止 / 闲置回收 / 内核重启） |
| `EPIPE` | 往已经退出的进程写 stdin |
| `ENOENT` `EINVAL` `ETOOBIG` `EISDIR` | 常规错误 |

`err.detail` 里带 `{cap, target, risk, app}` —— 足够画一个「去授权」的提示。

```js
try {
  await rx.fs.read('/root/.ssh/id_rsa');
} catch (e) {
  if (e.code === 'NEED_ADMIN') return ui.say('这项操作需要先开启管理员模式');
  if (e.code === 'EPERM') return ui.say('已拒绝：' + e.detail.cap + ' ' + e.detail.target);
  throw e;
}
```

## 一次调用的完整旅程

```
rx.fs.read('/sdcard/notes/a.md')
  → POST /runx/sdk/fs/read  (X-Runx-Token)
    → 令牌反查应用名（应用不能自报）
    → 解析成绝对路径（先解析，再授权）
    → 查该用户的授权表
       ├─ 命中 → 读文件 → 200
       └─ 未命中 → 算风险 → 挂起请求 → 桌面弹框
                              ├─ 拒绝 / 超时 / 无人可问 → 403 + code
                              └─ 允许 → 执行 → 200（选「始终」还会写进授权表）
```
