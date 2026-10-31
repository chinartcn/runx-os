# @runx/ui

与 RunX 桌面**同一套视觉语言**的组件库：一套 CSS + 一个小脚本。应用页面引两个文件，
按钮、输入框、卡片、菜单、Toast 就和窗口外面的桌面长得一样。

```html
<link rel="stylesheet" href="http://127.0.0.1:3000/runx/ui/runx-ui.css">
<script src="http://127.0.0.1:3000/runx/ui/runx-ui.js"></script>

<body class="rx" data-theme="auto">
  <h1 class="rx-title">笔记</h1>
  <button class="rx-btn primary">保存</button>
</body>
```

令牌值逐字搬自 [`.js/@runx-desktop/assets/tokens.css`](../../.js/@runx-desktop/assets/tokens.css)：
同一个 Inter、同一组语义红黄绿、同一条 `blur(12px)`。**改这里之前先看桌面那份** ——
两处不一致时，用户在窗口内外会看到两种蓝。

---

## 为什么全都挂在 `.rx` 下面

应用页面有它自己的样式和变量命名。把 `--label-primary` 写到 `:root`，迟早撞上某个
应用的变量，而且排查时会以为是浏览器的问题。所以：

- 所有选择器都以 `.rx` 开头（`<body class="rx">` 一行搞定）；
- 所有变量都带 `--rx-` 前缀。

代价是类名写起来多一点，换来的是「装进来不改变应用原有的任何东西」。

## 主题

`data-theme` 三个值：`light` / `dark` / `auto`（跟随系统）。`auto` 用
`prefers-color-scheme`，不需要 JS。

```js
RX.theme('dark');            // 记进 localStorage 的 rx-ui-theme
RX.theme('auto');
RX.onThemeChange((mode) => console.log('现在是', mode));
```

### 跟着桌面走（推荐）

桌面在「显示 → 外观」里换主题时，**窗口内外应该是同一种颜色** —— 亮色桌面上挂一个
深色窗口，比任何配色都刺眼。做法是让应用订阅桌面的主题事件：

```js
// 服务端（@runx/host）
const host = require('@runx/host');
host.theme.onChange((t) => send('theme', { mode: t.mode }));   // 推给自己的页面

// 页面
es.addEventListener('theme', (e) => RX.theme(JSON.parse(e.data).mode));
```

`apps/demo` 就是这么做的（`app.js` 订阅 → SSE 推给页面 → 页面 `RX.theme()`）。
应用启动时先 `await host.theme.get()` 拿一次当前值，避免首帧闪一下。

### 画布底色（`--rx-canvas`）

`.rx` 的 `background` 是 `var(--rx-canvas)`，**不是 transparent**。这个值与桌面窗口
内容区（`--canvas`）刻意保持一致：

- 应用在桌面窗口里：窗口内容区是 `--canvas`，应用 body 是 `--rx-canvas`，两者同值，
  所以窗口内外是一块连续的画布；
- 应用单独打开（不在窗口里）：这一层就是它自己的底色。

写 transparent 会出事：iframe 的 canvas 默认是白的，暗色主题下应用的白字就落在
白底上，整页看不见东西。这个坑踩过一次。

同理，`<html>` 的底色由 `RX.theme()` 同步（`paintCanvas()`）—— 自定义属性只往下传，
`html` 是 `body` 的祖先，拿不到 body 上定义的 `--rx-canvas`，不补这一层，页面滚到
body 之外时会闪出浏览器的默认白边。

## 排版

| 类 | 用途 |
|---|---|
| `.rx-title` | 窗口内的页面标题（22px / 600） |
| `.rx-subtitle` | 分节标题（15px / 600） |
| `.rx-body` | 正文（13px / 400 / 20px 行高） |
| `.rx-caption` | 说明文字（次要色，12px） |
| `.rx-status` | 状态文字（等宽数字，`tabular-nums`） |
| `.rx-section-label` | 小区块标签（11px / 600 / 唯一允许全大写的场合） |

## 材质

| 类 | 用途 |
|---|---|
| `.rx-glass` | 标准玻璃（`blur(12px)` + 78% 底） |
| `.rx-glass-thin` | 薄玻璃，贴在内容上（工具栏） |
| `.rx-glass-thick` | 厚玻璃，浮在内容上（窗口、面板） |

> 材质**不叠加**：玻璃里再套玻璃，颜色会糊成一片。要「面板里的一块」，用
> `.rx-card`（实色）而不是再来一层玻璃。

## 控件

- 按钮：`.rx-btn` + `.primary` / `.destructive` / `.soft` / `.plain`，尺寸 `.sm` / `.lg` / `.block`
- 图标按钮：`.rx-icon-btn`
- 按钮组：`.rx-btn-group`（JS 自动处理选中态）
- 表单：`.rx-field` `.rx-input` `.rx-textarea` `.rx-select` `.rx-search` `.rx-switch`
  `.rx-check` `.rx-radio` `.rx-slider` `.rx-seg` `.rx-stepper`
- 容器：`.rx-card` `.rx-panel` `.rx-list` `.rx-row` `.rx-toolbar` `.rx-sidebar`
  `.rx-split` `.rx-table` `.rx-badge` `.rx-dot`
- 导航：`.rx-tabs` + `.rx-tab[data-target]`
- 反馈：`.rx-progress` `.rx-spinner` `.rx-skeleton` `.rx-empty` `.rx-kbd` `.rx-code`
- 覆盖层：`.rx-scrim` `.rx-dialog`，`.rx-menu` `.rx-menu-item`，`.rx-toasts` `.rx-toast`

完整效果看画廊：`http://<kernel>/runx/ui/`（登录后打开）。

## 脚本（`window.RX`）

只做「必须用 JS 才能做的事」，其余交给 CSS：

```js
RX.toast('已保存', { kind: 'ok', ms: 2400 });

const id = await RX.dialog({
  title: '删除这个文件？',
  message: '删除后不能恢复。',
  actions: [
    { id: 'ok', label: '删除', kind: 'destructive' },
    { id: 'cancel', label: '取消' },
  ],
});                                     // 用户点的按钮 id，关掉框是 null

if (await RX.confirm('退出吗？', '未保存的内容会丢失。')) close();
if (await RX.confirm('删除？', null, { danger: true, okLabel: '删除' })) remove();

const name = await RX.prompt('重命名', { value: 'note.md' });

RX.menu(document.querySelector('#more'), [
  { id: 'rename', label: '重命名' },
  { id: 'dup', label: '创建副本' },
  { sep: true },
  { id: 'trash', label: '移到废纸篓', danger: true },
]);

RX.bytes(4 * 1024 * 1024);   // '4.0 MB'
RX.duration(93000);          // '1 分 33 秒'
RX.time(Date.now());         // '19:26:04'
RX.token('--rx-label-primary');
```

事件委托自动处理：`.rx-seg`、`.rx-tab[data-target]`、`.rx-btn-group`、`.rx-stepper`、
`[data-rx-menu]`、`[data-rx-close]`。状态变化抛 `rx:change`（控件）和 `rx:tab`（标签页），
都是冒泡的 `CustomEvent`，在容器上监听一次就行。

分段控件支持左右键切换（`role="tablist"` 那套键盘约定）。

## 字体为什么要走 `/runx/ui/fonts/`

`@font-face` 受 CORS 限制：应用页面在自己的源里（`http://127.0.0.1:3470`），字体文件
在网关（`:3000`）。浏览器会拒绝没有 `Access-Control-Allow-Origin` 的字体请求 ——
而用 `file://` 或直连桌面目录都拿不到头。所以字体由 `@runx-ui` 扩展单独提供，
带 `Access-Control-Allow-Origin: *`。

`/runx/ui/*` 同时是**免登录**的静态资源：iframe 里的子资源请求不带 Cookie
（`SameSite=Lax`），要求登录的结果就是「样式偶尔加载失败」。

## 怎么装进应用

不发 npm，和 `@runx/sdk` 一样从仓库分发。但它是**静态文件**，所以两种用法：

1. **直接引网关地址**（推荐）：`http://127.0.0.1:3000/runx/ui/runx-ui.css`。
   零安装、跟着仓库更新。应用要自己拼网关地址时用 `process.env.RUNX_GATEWAY`。
2. **复制进应用**：`cp -r packages/runx-ui apps/myapp/public/ui`。
   要完全自包含、离线打包时用，代价是仓库更新后要重新复制（字体目录也要一起）。

## 已知的取舍

- 只有一套尺寸（13px 正文 / 32px 控件高度）。要更密或更松，改 `--rx-*` 令牌，
  别在页面里到处写 `padding`。
- 没有 CSS-in-JS、没有构建步骤、没有主题生成器。它就是两个文件。
- 不接管 `<html>` 的样式，只作用于 `.rx` 之内 —— 所以应用自己的全局样式不会被改。
  （`<html>` 的**背景色**会被 `paintCanvas()` 改一次，那是刻意的，见上文。）

## 一个容易踩的坑

`RX.toast()` / `RX.menu()` / `RX.dialog()` 的挂载点是一个 `div.rx.rx-overlay-root`
（`position:fixed; inset:0`）。它**必须透明**：`.rx` 的背景是画布色，而这个壳是整屏
容器 —— 有底色就会把整个页面盖住（表现是「点了按钮之后整页空白」）。
