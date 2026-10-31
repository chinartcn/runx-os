# @runx-administrator-mode

有限期的提权票据。默认 30 分钟，到点自动作废，生效期间桌面顶上一直挂着倒计时红条。

## 为什么是「票据」而不是「开关」

高风险操作（写 `/etc`、读私钥、起子进程）有时候确实必须做。问题从来不是「开」，
而是**忘了它还开着** —— 点过一次「允许」，三个月后那台机器上所有应用都还在高危授权下
跑。所以这里给的是会过期的东西，而且过期之前一直看得见：

```
┌──────────────────────────────────────┐
│  ⚠ 管理员模式   剩余 27:31    关闭   │   ← 顶部悬浮红条（不占布局）
└──────────────────────────────────────┘
 视口四周一圈红色内发光（pointer-events: none）
```

## 谁在读这张票据

| 读的人 | 用途 |
|---|---|
| [@runx-rights-manager](../@runx-rights-manager/README.md) | 高危操作没票据 → 直接 `NEED_ADMIN`，连弹窗都不弹 |
| 桌面红条 | `GET /runx/admin/state` + `sys.admin.on/off` 事件 |
| 审计 | `var/runx/admin-audit.json` + `var/runx/logs/admin.log` |

票据是 `var/runx/admin.json`，**只由本扩展写**。删掉这个扩展，`rights-manager` 读不到
票据就等于「永远没开管理员模式」，高危操作一律拒绝 —— 失败方向是安全的那一侧。

## 双重确认（防手滑，不防攻击者）

1. 只有管理员账号能开（普通用户 403）；
2. 必须填理由（≥2 字）+ 勾选「我知道风险」+ 一字不差地打出确认词；
3. 确认词由 `GET /runx/admin/challenge` 一次性下发（5 分钟有效，用过即废），
   **服务端校验**，不是前端装样子。

拿到管理员会话的人本来就赢了；这三步拦的是「点快了」。

## REST

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/runx/admin/state` | `{on, until, remaining_ms, by_name, reason, expired}` |
| GET | `/runx/admin/challenge` | `{token, phrase, expires_in}`（管理员） |
| POST | `/runx/admin/enable` | `{token, phrase, confirm, reason, minutes}`，minutes 上限 480 |
| POST | `/runx/admin/disable` | 立刻作废 |
| GET | `/runx/admin/audit` | 最近 50 条（管理员） |

## 前端

`window.RunX.admin`：

```js
await RunX.admin.enable();    // 打开确认框
await RunX.admin.disable();
await RunX.admin.state();     // {on, until, ...}
```

授权面板（菜单栏盾牌）里有入口，不必记 API。

## 到期是怎么保证的

- 开启时挂一个 `setTimeout`（`unref`，不阻止进程退出）到点关闭；
- 每次读状态都按 `until` 再算一遍，定时器丢了也不会误判为「还开着」；
- 进程重启时若票据未到期，继续生效并重新计时。

## 一个已知取舍

票据只校验「谁开的」，不校验「谁在用」。开启期间，任何应用的高危请求都会走弹窗而不是
直接拒绝 —— 这正是它的用途，但也意味着**别在无人值守时开着它**。红条就是为这个存在
的。
