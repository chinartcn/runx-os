# @runx-node-safety

用 Node 自己的权限模型（`--permission` / `--experimental-permission`）给每个应用划边界。

```
appex.json:  "permissions": ["fs.read:/sdcard/notes/**", "proc.spawn"]
    ↓ 安装时原样进 apps.json
    ↓ @runx-node-safety 翻译
node --permission --allow-fs-read=/opt/app --allow-fs-read=/sdcard/notes \
     --allow-fs-write=/opt/app/data --allow-child-process app.js
    ↓ supervisor 用它启动
应用读 ~/.ssh → ERR_ACCESS_DENIED（不是权限层拒绝，是 Node 运行时拒绝）
```

## 为什么需要它

[@runx-rights-manager](../@runx-rights-manager/README.md) 的审批只拦得住「走 SDK 的
调用」。应用直接 `require('fs')` 时，那一层完全看不见 —— 而一个 Node 进程默认拥有和
内核一样的权限。真正有强制力的只有进程级围栏。

## 它是怎么接进来的

进程只能由 supervisor 起，所以这里**不自己 spawn**，只提供 `policy.plan()`：把清单里
的 `permissions` 翻译成 argv。supervisor 在 spawn 时 `try { require(...) }`，拿得到
就用，拿不到就用原命令。

删掉这个扩展 → 没有围栏，其余一切照常。这是刻意的：能力在运行时发现，不是编译期依赖。

## 三种状态

| state | 含义 |
|---|---|
| `applied` | argv 里带了 `--permission`，围栏生效 |
| `skipped` | Node <18、命令不是 `node`（如 `npm start`）、或应用没声明 permissions |
| `off` | 应用被显式豁免（`no_fence` 或 `safety.json` 的 `exempt`） |

把 `skipped` 混进 `applied` 会让人误以为安全，所以 API 分开报，并给出原因。

## 为什么默认只围「声明过」的应用

Node 的权限模型是**启动时全有全无**：少声明一条，应用一启动就 `ERR_ACCESS_DENIED`
死掉；多声明一条，围栏形同虚设。没声明的应用我们无从猜测它要什么，硬套基线会把存量
应用全打挂 —— 所以默认 `mode: "declared"`。想要「一律围栏」的机器设 `strict`，并自己
补齐 permissions。

## permissions 语法

与 [@runx-rights-manager](../@runx-rights-manager/README.md) 同一套 `能力:作用域`：

| 声明 | 生成的开关 |
|---|---|
| `fs.read:/sdcard/notes/**` | `--allow-fs-read=/sdcard/notes` |
| `fs.write:/opt/app/data/**` | `--allow-fs-write=/opt/app/data`（同时允许读） |
| `proc.spawn` | `--allow-child-process` |
| `proc.worker` | `--allow-worker` |
| `sys.addons` | `--allow-addons` |
| `net.fetch:...` | **无开关** —— Node 权限模型没有网络这一项 |

末尾 `/**` 会收窄成目录前缀（Node 认目录不认 glob）。`/sdcard/*.jpg` 这种按扩展名的
声明会被收窄成 `/sdcard/*`；再细做不到，需要靠审批层。

没声明 `permissions` 的应用拿到的是基线：**只读自身目录、只写 `data/`**（仅在
`strict` 模式下生效）。

## 配置 `var/runx/safety.json`

```json
{
  "mode": "declared",            // declared | strict | off
  "exempt": ["legacy-app"],      // 单个应用豁免围栏
  "extra": ["/etc/ssl/certs"],   // 全局附加只读目录（证书、字体…）
  "extra_write": []              // 全局附加可写目录
}
```

## REST

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/runx/safety/status` | Node 版本、支持的开关、每个应用的围栏计划（含完整 argv） |
| POST | `/runx/safety/refresh` | 重新探测（刚换了 Node 版本时用） |
| POST | `/runx/safety/mode` | `{mode}` 切全局策略 |
| POST | `/runx/safety/apps/:name` | `{exempt:true|false}` 单应用豁免（下次启动生效） |

`status` 会给出 `skipped` 的具体原因，例如：

> 启动命令不是 node（npm），无法注入权限开关；请把应用改成 `node app.js`

## 限制（都是 Node 模型的边界，不是这里的实现问题）

1. **不覆盖网络**。没有 `--allow-net` 这种东西。
2. **不覆盖环境变量、时钟、信号**。
3. **argv 注入**。`npm start`、`sh -c`、`bun` 都注入不了 —— 命令不是 `node` 就跳过。
4. **启动时固定**。批准了新能力要重启应用才生效。
5. **读不到自己的依赖会挂**。依赖必须装在应用目录里（`node_modules/`），指向目录外的
   符号链接会被 `ERR_ACCESS_DENIED` 挡住。
