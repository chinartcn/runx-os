# @runx/sdk

RunX 应用侧的**操作系统接口**：文件、进程、网络。每一次调用都经过用户授权。

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
| `read(path, {encoding})` | `{path, content, encoding, size, mtime}`，二进制自动 `base64` |
| `write(path, content, {encoding, append})` | `{path, size, created}`，父目录自动建 |
| `list(path)` | `{path, entries:[{name, type, size, mtime}]}`，目录在前 |
| `stat(path)` | `{exists, type, size, mtime, mode}` |
| `mkdir(path, {parents})` | `{path}` |
| `remove(path, {recursive})` | `{path, removed}`，删目录必须显式 `recursive` |
| `copy(from, to, {recursive})` / `move(from, to)` | `{from, to}`，跨设备自动退化 |

### `rx.proc`

```js
const { pid } = await rx.proc.spawn(['ffmpeg', '-i', 'in.mp4', 'out.gif'], { cwd: '/tmp' });
const st = await rx.proc.status(pid);   // {running, exit, stdout, stderr}（各留 8KB）
await rx.proc.kill(pid, 'SIGTERM');
```

`argv` 是数组，没有 shell。要跑管道就自己起 `sh -c`，并把整条命令作为参数 —— 那样
申请的能力是 `sh`，用户在弹框里看得见。

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

## 错误

每个错误都有 `code`（字符串常量，不要解析文案）：

| code | 含义 |
|---|---|
| `ENOTRUNX` | 不在 RunX 里 |
| `EPERM` | 用户拒绝了，或没有授权且没人可问 |
| `NEED_ADMIN` | 高危操作，需要先开管理员模式 |
| `ENOUI` | 桌面没开，没人能批准 |
| `ETIMEDOUT` | 等待审批超时（默认 100 秒） |
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
