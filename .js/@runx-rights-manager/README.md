# @runx-rights-manager

RunX 里的应用默认和内核一样大：能读 `~/.ssh`、能写 `/etc`、能起子进程。这个扩展在
「应用想干点什么」和「机器真的照做」之间插一层审批：

```
应用 → POST /runx/sdk/*（带 X-Runx-Token）
        ↓ 认人（令牌 → 应用；Cookie / 回环 → 用户）
        ↓ 查权（这个用户批准过这条能力吗）
        ├─ 有 → 直接执行
        └─ 没有 → 挂起请求 → 桌面弹框 → 用户点一下 → 执行或拒绝
```

它同时是**账号体系**：多用户、每用户一份授权表与桌面布局。

---

## 四件事

| 职责 | 实现 | 文件 |
|---|---|---|
| 账号 | scrypt 哈希 + HMAC 签名 Cookie（30 天） | `accounts.js` |
| 授权 | 能力 + 作用域（glob），按用户存 | `grants.js` |
| 审批 | 请求队列、去重、超时、决策回传 | `uac.js` |
| 执行 | 真正的 fs / proc / net 操作，路径先解析再授权 | `broker.js` |

## 能力模型

一条授权永远是 **应用 + 能力 + 作用域** 三元组：

```
fs.read:/sdcard/notes/**      # 能读这个目录（含子目录）
fs.write:/opt/app/data/**     # 能写这里
proc.spawn:npm                # 能启动 npm 这个程序
net.fetch:https://api.example.com/**
```

只记应用会变成「装过一次文件管理器，所有应用都能写 /etc」；只记能力会变成
「一个应用被批准，全家搭便车」。

| 能力 | 作用域 | 说明 |
|---|---|---|
| `fs.read` `fs.list` `fs.stat` | 路径 | 读类；写授权自动覆盖同作用域的读 |
| `fs.write` `fs.mkdir` `fs.remove` `fs.copy` | 路径 | 写类 |
| `proc.spawn` | 程序名 | 起子进程 —— 等价于拿到任意能力 |
| `net.fetch` | 主机 origin | 代发 HTTP 请求 |
| `sys.info` | `/sys` | 平台、内存、CPU 数 |

作用域支持 `**`（任意层）、`*`（一层内任意字符）、`?`。路径一律先 `resolve` 成绝对
路径再匹配 —— 否则 `../../etc/shadow` 会以「相对路径」的身份绕过 `fs.read:./**`。

## 风险等级

由**服务端**算（前端传的不作数），命中即定级，取最高：

| 等级 | 例子 |
|---|---|
| 高 | 读 `~/.ssh/**`、`**/*.pem`、`**/.env`；写 `/etc` `/usr` `/bin`；写应用自己的代码（等于改下次启动跑什么）；`proc.spawn` |
| 中 | 沙箱外的普通文件、访问网络、删除 |
| 低 | 应用自己的 `data/` 目录 |

**高风险操作不给「始终允许」**：只能「拒绝 / 仅本次允许」。而且没开管理员模式时，
根本没机会点 —— 服务端直接回 `NEED_ADMIN`，连弹窗都不弹。

## UAC 的三个「不」

1. **不重复弹窗**：同一 `(应用, 能力, 目标)` 的并发请求合并成一个 Promise。
2. **不无限等**：默认 90 秒超时；桌面根本没开（没有 WS 连接）时立刻返回 `ENOUI`，
   而不是让应用卡 90 秒。
3. **不越权决策**：决定必须由当前登录用户做出，且只能决定自己那条请求。

---

## 账号

- 密码用 `scrypt(N=16384, r=8, p=1, 64B)` 哈希，异步计算（同步版在 Termux 上会卡
  事件循环 200ms+）；校验用 `timingSafeEqual`。
- 会话是**签名 Cookie** `uid.exp.hmac`，密钥在 `var/runx/.session-secret`（0600）。
  服务端热重载不会让人掉线；代价是没法单独踢掉某个会话 —— 换密钥就是全员下线。
- **第一个创建的账号自动是管理员**；删到只剩一个管理员时会被拒绝。
- **本机回环默认免登录**，视为机器主人（`RUNX_AUTH_NO_LOOPBACK=1` 可关，测试多用户
  时用得上）。

### 没有账号时（首次运行）

`/runx/auth/status` 返回 `setup_required: true`，桌面会自动弹「创建第一个管理员」。
**这段窗口期谁都能抢先创建**，所以把机器暴露到局域网之前，先在终端建好：

```bash
node .js/@runx-rights-manager/cli.js add alice      # 交互输入密码，第一个自动是管理员
node .js/@runx-rights-manager/cli.js list
node .js/@runx-rights-manager/cli.js passwd alice   # 忘记密码
node .js/@runx-rights-manager/cli.js grants alice
node .js/@runx-rights-manager/cli.js grant alice files fs.read /sdcard/notes/**
node .js/@runx-rights-manager/cli.js revoke alice <授权 id>
node .js/@runx-rights-manager/cli.js rm bob
```

CLI 直接读写 `var/runx/users.json`（原子写），不用停服务器。

### 多用户隔离到什么程度

| 隔离 | 位置 |
|---|---|
| 授权表 | `var/runx/users/<uid>/grants.json` |
| 桌面布局 / 壁纸 / 图标 | `var/runx/users/<uid>/desktop.json`（新用户继承安装时的全局模板） |
| 应用归属 | `var/runx/app-owners.json`：谁点的启动，应用就用谁的授权 |
| 进程 UID | **不隔离**。所有应用仍以内核同一个 UID 运行 |

最后一条是设计选择：容器里通常只有 root，把子进程降权需要 setuid / 重挂 home，
代价远大于收益。真正的强制力来自 [@runx-node-safety](../@runx-node-safety/README.md)
的进程围栏。

---

## REST

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/runx/auth/status` | 登录状态、账号数、管理员模式票据 |
| POST | `/runx/auth/setup` | 创建第一个管理员（仅在无账号时） |
| POST | `/runx/auth/login` | JSON 或表单（无 JS 也能用），返回 `Set-Cookie` |
| POST | `/runx/auth/logout` | 清 Cookie 并撤销所有挂起请求 |
| GET/POST | `/runx/auth/users` | 账号列表 / 新建（管理员） |
| PATCH/DELETE | `/runx/auth/users/:id` | 改密码或角色 / 删除（管理员） |
| GET/POST | `/runx/rights/grants` | 我的授权 / 手动加一条 |
| DELETE | `/runx/rights/grants/:id` | 撤销 |
| GET | `/runx/rights/pending` | 待审批队列（桌面进页面时补拉一次） |
| POST | `/runx/rights/decide` | `{id, decision:'once'|'always-file'|'always-dir'|'deny'}` |
| GET | `/runx/rights/audit` | 最近 100 条审计 |
| POST | `/runx/sdk/<area>/<op>` | 应用侧网关（见 [@runx/sdk](../../packages/runx-sdk/README.md)） |

### 登录闸门

未登录时**所有路径**都要求登录：HTML 请求返回一张自包含的登录页（不依赖前端脚本，
JS 挂了也能登），其余请求返回 401 JSON。只放行登录接口、桌面 CSS/字体与
`/runx/rights/rules`。

为什么不只挡 API：NavExt 的静态路由会把项目文件直接吐出去，只挡接口等于门锁了但墙
是纸糊的。

---

## 前端

`client.js` 挂三样东西：

- **审批框**：应用名、能力、目标路径、风险等级与理由、作用域预览；按钮按风险增减。
- **登录 / 初始化**：服务端已给登录页，这里兜「会话过期」与首次初始化。
- **授权面板**：`RunX.rights.panel()`，菜单栏右侧的盾牌图标也是它。可撤销授权、增删
  用户、一键进管理员模式。

所有界面挂在 `#runx-desktop` 内部而非 `body`：桌面是 `position:fixed` 的层叠上下文，
挂 body 上的 fixed 元素无论 z-index 多高都会被整块桌面盖住（点不到按钮）。

---

## 它做不到什么

- **绕过 SDK 的调用它看不见**。应用直接 `require('fs')` 读文件，这一层没有介入点；
  真正的强制力是 `--permission` 围栏。两者是「围栏 + 审批」：围栏决定物理边界，
  审批决定边界之内的每一次取舍。
- **不隔离内核 UID**。见上表。
- **回环即主人**。任何能在本机发 HTTP 的进程都能以管理员身份调 API —— 对单机桌面
  是便利，对多租户服务器是漏洞，别把这台机器当服务器用。
