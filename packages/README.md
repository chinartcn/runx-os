# packages/

RunX 提供给**应用开发者**的四个包。都零依赖、MIT；三个是 Node 包，最后一个是
给页面用的静态资源（一套 CSS + 一个小脚本）。

| 包 | 作用 | 什么时候用 |
|---|---|---|
| [`@runx/host`](runx-host/) | 桌面 API：通知、子窗口、标题、Dock 角标、事件总线 | 想让应用「像个桌面应用」而不只是个网页 |
| [`@runx/sdk`](runx-sdk/) | 系统接口：文件、进程、网络、对话框、剪贴板，每次调用走审批 | 想读写自己的目录之外的东西 |
| [`@runx/pty`](runx-pty/) | 伪 PTY 会话：真终端（行编辑/颜色/信号/窗口尺寸），零原生依赖 | 应用要跑交互式 shell 或 TUI 程序 |
| [`@runx/ui`](runx-ui/) | 界面组件库：`.rx-*` 类 + `RX.*` 交互，令牌与桌面逐字一致 | 想让页面和窗口外面的桌面长得一样 |

```js
const rx = require('@runx/host');   // 我是谁、我该怎么表现
const os = require('@runx/sdk');    // 我要动这台机器上的东西
const pty = require('@runx/pty');   // 我要一个真终端
```

```html
<!-- 最后一个不用 require：它是 <link> + <script> -->
<link rel="stylesheet" href="http://127.0.0.1:3000/runx/ui/runx-ui.css">
```

> `runx-ui` **不进** `link.js` 的软链名单：它没有 `index.js`，也不是 `require` 的目标。
> 页面直接引 `/runx/ui/*`（由 `@runx-ui` 扩展托管），或把目录复制进应用自包含。

---

## 分发方式：git，不是 npm

这三个 Node 包**不发 npm**（`package.json` 里 `private: true`，`npm publish` 会直接拒绝）。源码就是发行版，装法有三种。

### 1. 一键挂载（推荐）

仓库里带一个脚本，把三个 Node 包软链进应用：

```bash
node packages/link.js              # 看谁挂了、谁没挂
node packages/link.js notes        # 挂进 apps/notes
node packages/link.js --all        # 挂进所有 node 应用
```

软链的好处是**更新即生效**：`git pull` 之后应用下次 `require` 拿到的就是新版本，不用重装，也不会出现「某个应用里躺着一份两年前的 SDK」。

> 想让应用完全自包含（要打包带走、或者目标文件系统不支持符号链接），用 `--copy`。代价是仓库更新后要重跑一次。

### 2. 从源码树安装

```bash
cd apps/notes
npm i ../../packages/runx-sdk ../../packages/runx-host ../../packages/runx-pty
```

npm 也会建软链（`file:` 目录依赖的默认行为），效果和 `link.js` 一样，只是每个应用要敲一次。

### 3. 换个地方装：clone 之后指过来

```bash
git clone https://github.com/chinartcn/runx-os.git ~/runx-os
cd ~/my-app && npm i ~/runx-os/packages/runx-sdk
```

### 为什么不 `npm i github:chinartcn/runx-os`

因为 npm 装不了 monorepo 里的子包。三条路都试过，装出来的都是**仓库根包**（`navext`），`require('@runx/sdk')` 直接 `MODULE_NOT_FOUND`：

```bash
npm i github:chinartcn/runx-os                        # → 装成 navext
npm i github:chinartcn/runx-os#path:packages/runx-sdk # → #path: 被忽略
# 根 package.json 加 workspaces 再 npm i "@runx/sdk@git+..." → 目录名对了，内容还是根的
```

`#path:` 是 pnpm / yarn 的语法，npm 不认。所以要么 clone，要么用上面的 `link.js` —— 后者本质上也是「先有代码，再挂上去」，只是把路径算好了。

---

## 围栏与这三个包的关系

装了 [`@runx-node-safety`](../.js/@runx-node-safety/README.md) 的应用跑在 Node 权限模型里，只能读自己目录。而这三个 Node 包在 `packages/` 下 —— 应用目录之外。

这不会把应用卡住：围栏在生成 `--allow-fs-read` 时会**自动放行这三个包所在的目录**（毕竟「能走审批」的前提是能 `require('@runx/sdk')`）。围栏仍然挡住其余一切：

```console
$ node --permission --allow-fs-read=/app --allow-fs-read=.../packages/runx-sdk app.js
sdk loaded, enabled = false
blocked /etc: ERR_ACCESS_DENIED
```
