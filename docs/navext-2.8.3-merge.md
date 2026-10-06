# RunX OS × NavExt v2.8.3 合并报告

> 合并日期：2026-10-06
> 远端提交：`11c32bf` / `https://github.com/chinartcn/runx-os`

---

## 一、结论速览

| 项目 | 结果 |
|---|---|
| 内核合并 | ✅ 以 v2.8.3 `server.js` 为基底，重放 5 处 RunX 改造 |
| 版本号 | `2.8.2` → **`2.8.3`** |
| 根路径策略 | ✅ **保留 `index.html`**，走三层回退第 ① 层 |
| 全量回归 | ✅ **247 / 247 通过** |
| 远端校验 | ✅ **20 个关键文件逐字节一致** |
| 开箱验证 | ✅ 从远端全新拉取 48 文件，实跑桌面正常挂载 |

---

## 二、v2.8.3 带来了什么

v2.8.3 是一次**结构性重构**（`server.js` 改动 4565 行），核心变化：

1. **导航页从内核剥离** → 降级为可选扩展 `.js/navext-ui/`
2. **新增 `onNavPage(ctx)` 钩子** → 扩展返回 `{html}` 作为 `<body>` 内容
3. **新增 `hasNavPageProvider()`** → 不硬编码扩展 id 判定展示页是否存在
4. **新增 `ctx.nav` 只读快照** → `{root, pathname, files, dirs, site, stats}`
5. **三层回退 `renderNavFallback()`**
6. **`/?format=json` 与 `/api/search` 降级 404**（它们是展示页的数据源）
7. **`BASE_STYLE()` 瘦身** → 只保留主题变量，展示页样式随扩展搬走

### 三层回退的实际行为（已实测）

| 层 | 条件 | 行为 | RunX 是否走这条 |
|:---:|---|---|:---:|
| ① | 根目录有 `index.html` | 服务该文件，**照常注入扩展** | ✅ **是** |
| ② | 没有 `index.html` | HTTP 200 + `Content-Length: 0` | ❌ 否 |
| ③ | — | 其他扩展在任何情况下都照常加载 | — |

---

## 三、关键判断：为什么必须保留 `index.html`

### 实测证据

在 v2.8.3 内核 + runx-os 扩展组合下，分别测两条路径：

**有 `index.html`（当前方案）**
```
GET /  →  HTTP 200, 274,098 字节
浏览器：#runx-desktop = True
        .rx-menubar   = True
        .rx-vscreen   = True
        宿主滚动锁    = True
        几何          = 1280×800 铺满 1280×800 视口
```

**删掉 `index.html`（落到第 ② 层）**
```
GET /  →  HTTP 200, Content-Length: 0
浏览器：#runx-desktop = False
        .rx-menubar   = False
        body.innerHTML 长度 = 0
        → 桌面完全不挂载
```

### 根因

RunX 桌面客户端 `.js/@runx-desktop/client.js` 需要内核把 `navext-client` 脚本与
`__NAV_DATA__` 数据注入页面。而 v2.8.3 的注入逻辑写在 HTML 装配层：

- 第 ① 层：`renderCustomHome()` → 把注入塞进 `</head>` 前 → **脚本能执行**
- 第 ② 层：直接 `res.end()` 零字节 → **没有 `<head>` 可注入 → 脚本永不执行**

`@runx-desktop` 自身**没有** `onHtml` / `onNavPage` 钩子（`onRequest` 只处理 `/runx/*`），
所以它无法在零字节路径下自救。

> **一句话**：NavExt 让"没设置主页就返回空页"这个设计对通用场景是优点，
> 但 RunX 的桌面是"依赖内核注入才能启动"的，空页会把桌面一起抽掉。

### 因此

`index.html` **不是**遗留垃圾，而是 RunX OS 的**必要启动入口**。
它只有 619 字节（一行"正在启动 RunX OS 桌面…"），真正的桌面由扩展在客户端动态挂载。

---

## 四、RunX 特权的 5 处改造（全部保留）

| # | 改造 | 位置（v2.8.3 行号） |
|:---:|---|---|
| 1 | `const OS = require('./os')` | 102 |
| 2 | `core: mod.core === true` | 1674 |
| 3 | `ctx.os = app.os.forExt(app, ext)` | 2237 |
| 4 | `App.os = OS.init(App)` | 4514 |
| 5 | `App.server.on('upgrade', ...)` | 4538 |

合并方式：以 v2.8.3 `server.js` 为基底，用 `/tmp/merge-283.py` 逐处精确字符串替换，
**每处断言唯一命中**，任一未命中即中止且不落盘（避免生成半个文件）。

---

## 五、测试结果

| 测试套件 | 通过 | 说明 |
|---|:---:|---|
| **v2.8.3 专项**（本轮新增） | **33 / 33** | 版本同步、5 处改造、9 项新结构、运行时行为 |
| e2e | 43 / 43 | 端到端桌面交互 |
| shell 专项 | 92 / 92 | 开始菜单 / 长按菜单 / 主题 / 分辨率 |
| 窗口持久化 | 27 / 27 | 移动缩放后刷新回位 |
| 移动端 | 22 / 22 | 手机视口交互 |
| 铺满缩放 | 30 / 30 | 无留白侧露 |
| **合计** | **247 / 247** | **零回归** |

### v2.8.3 专项覆盖要点

- 版本号三处同步（`package.json` / `SERVER_VERSION` / `NavExt.md`）
- 5 处 RunX 改造齐全 + `onDispose` 清理保留
- 9 项 v2.8.3 新结构（`onNavPage` / `hasNavPageProvider` / `buildNavCtx` / `renderNavFallback` / 回退①② / `BASE_STYLE` 瘦身 / `renderCard` 与 `CORE_SEARCH_SCRIPT` 已移除 / 启动横幅）
- 运行时：根路径 200 且非空、注入 `navext-client` 与 `__NAV_DATA__`、无展示页骨架、`?format=json` 与 `/api/search` 降级 404、`/runx/apps` 与 `/runx/desktop` 可达

---

## 六、已知无害现象

有 `index.html` 时控制台会出现一条 warning：

```
[NavExt] 内置 UI 挂载失败: TypeError: Cannot read properties of null (reading 'appendChild')
    at mountUI (.../:1022:22)
```

**来源**：`.navext.client.js` 的 `mountUI()` 是 NavExt 的**遗留内置 UI**（"按目录/按时间"切换 + 外观面板），
它要找展示页独有骨架 `[data-ext-target="header-top"]`；该骨架随展示页一起搬到了 `.js/navext-ui/`，
runx-os 未安装该扩展，所以取到 `null`。

**影响**：已被 `try/catch` 兜住，**不影响 RunX 桌面任何功能**（桌面挂载、滚动锁、几何、交互全部正常）。

**处置**：按约定**暂不处理** —— 它属于 NavExt 客户端库行为，RunX 侧不应越界修改。

---

## 七、变更文件清单

推送至 `chinartcn/runx-os`，共 **3 次提交**：

| 文件 | 本地大小 | 远端校验 |
|---|---:|:---:|
| `server.js` | 167,208 B | ✅ |
| `package.json` | 368 B | ✅ |
| `NavExt.md` | 103,986 B | ✅ |
| `.navext.client.js` | 40,042 B | ✅ |
| `README.md` | 26,151 B | ✅ |
| `index.html` | 619 B | ✅（未改，保留） |
| `.js/@runx-desktop/*` | — | ✅ |
| 其余 12 个文件 | — | ✅ |

> **20 / 20 逐字节一致，0 不一致，0 缺失。**

---

## 八、移动端显示三连修复（合并后回归发现）

合并上线后，实测中发现三个**同源**的显示缺陷，全部修于
`.js/@runx-desktop/client.js`。它们共同的特征是：**用自己写出去的值当下一轮的输入**，
形成自我引用，导致状态一旦被污染就再也回不去。

### bug A — 键盘收起后桌面缩水

**现象**：打开终端 → 触发软键盘 → 从下往上拖 → 关闭键盘 → 桌面下端露出一大块宿主背景。

**根因**：`physViewport()` 用 `root.clientHeight` 当布局视口基准，
而 `applyViewportFrame()` 又把算出的高度写回 `root.style.height`。键盘弹起时
`vv.height` 变小 → 写进 `root.style.height` → 键盘收起后 `Math.min(vv.height, root.clientHeight)`
仍被那个旧的小值钳住。

| 时刻 | `vv.height` | `root.clientHeight` | `Math.min` | 写入样式 |
|---|---:|---:|---:|---|
| 键盘弹起 | 535 | 915 | **535** | `535px` ← 污染 |
| 键盘收起 | 915 | **535**（自己写的） | **535** | `535px` ← 卡死 |

**修复**：基准改用 `window.innerWidth / innerHeight` —— 它才是真正的布局视口，
不受我们设置的元素样式影响。

### bug B — 「点个终端，桌面放大又缩小」

**现象**：开启"桌面版网站"后点终端，桌面缩放会突然跳变，且跳完回不去。

**根因**：两处。
1. `narrow()` 第 ④ 条直接读实时 `visualViewport.scale > 1.05`。键盘弹起、地址栏
   收展、双击缩放都会瞬时改这个值 → `narrow()` 在 true/false 间横跳 →
   `mobileAutoOverride()` 时真时假 → 缩放反复切换。
2. `root.clientWidth` 同样被 `applyViewportFrame()` 写过，缓存键跟着抖动。

**修复**：
- 第 ④ 条加**滞回**：进入阈值 `1.05`，退出阈值 `1.02`。一旦成立就保持，
  直到 scale 明确回落才释放。
- `narrow()` 结果按 `可视区宽|设备屏宽` 缓存，`vv.scale` 不进缓存键。
- `reloadDesktop()` 里显式 `invalidateNarrow()`，切预设后强制重算。

### bug C — 100% / 75% / 125% 按钮点了等于没按

**现象**：手机上点缩放档位毫无反应，页面纹丝不动。

**根因**：`mobileAutoOverride()` 对 `d.w > 680` 无条件 `return true`，
`displayScale()` 随即 `return 1` —— 把**用户显式选的固定缩放倍数**一起吃掉了。
而默认预设 `1280×800` 的 `w = 1280 > 680` 必然命中，所以手机上这些按钮**永远无效**。
（"等比铺满"和"100%"碰巧都算出 100%，所以看着像生效。）

**修复**：新增 `fixedZoom()` —— 只要 `d.scale` 是数字（非 `'fit'`/空），
就认定为"用户显式锁定缩放倍数"，`mobileAutoOverride()` 直接让路，
`displayScale()` 优先返回该倍数。**自动回退只决定逻辑尺寸用不用预设，
不再干涉缩放倍数。**

### 验证

新增 `test-display-bugs.py`（9 项），覆盖：
- 键盘开合后恢复满屏 + 顶部归零
- vv.scale 在 1.0 / 1.3 间反复抖动时，缩放层宽度与缩放比全程稳定
- 默认桌面预设下 100% / 75% / 125% 三档实际生效

全量回归 **256 / 256 通过**（原 247 + 显示 bug 9）。

---

## 九、后续可选方向

如果将来想走"真零字节主页"路线，需要**先**让 RunX 桌面能自给自足：

1. 给 `@runx-desktop/index.js` 加 `onNavPage(ctx)` 钩子，由扩展自己吐出完整页面骨架
   （`<html><head>` + 注入 + `<body>`），而不是依赖内核装配；
2. 或者在 `index.html` 里内置最小引导脚本 —— 但那就等于又回到需要 HTML 文件。

在方案 ① 落地之前，**保留 `index.html` 是唯一能保证桌面可用的选择**。
