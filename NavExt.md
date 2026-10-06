# NavExt

一个零依赖的 Node.js 静态服务器，自动扫描目录下的 HTML 文件并生成带搜索功能的导航页。支持配置外观、为文件添加描述、用扩展注入样式/脚本/自定义 API/改写 HTML、读写文件系统。所有配置和扩展支持热重载——改完刷新页面即生效。

**开发时**：两个文件 `server.js` + `.navext.client.js`
**分发时**：`node build.js --pack --sfx` 把客户端库内联进服务端，连同 HTML、扩展、配置一起打包成单文件 `app.sh`
**多站点**：`home.routes` 按 URL 路径 / Host / 环境变量切换不同主页，一个服务托管多个站

---

> ### 📚 本文档有两个形态
>
> | 形态 | 适合 | 位置 |
> | --- | --- | --- |
> | **单文件全文**（本文件） | 通读、全文搜索（Ctrl+F） | `NavExt.md` |
> | **按主题拆分** | 按需查阅、单篇分享 | [`MD/`](MD/README.md) |
>
> 两份内容同源同步，任选其一。**拆分版导航**：
>
> | # | 文档 | 内容 |
> | --- | --- | --- |
> | 01 | [快速开始](MD/01-快速开始.md) | 环境要求、开发态 / 分发态、目录结构 |
> | 02 | [配置文件](MD/02-配置文件.md) | `server.json`、`html.json` |
> | 03 | [扩展系统](MD/03-扩展系统.md) | 钩子、`ctx`、配置 schema、作用域、依赖、`stats` |
> | 04 | [客户端 API](MD/04-客户端API.md) | `window.NavExt`、路径归一化、生命周期 |
> | 05 | [服务端 API](MD/05-服务端API.md) | RESTful 接口、项目 FS、扩展 FS |
> | 06 | [主页与路由](MD/06-主页与路由.md) | `home.routes`、子页扩展策略 |
> | 07 | [打包与分发](MD/07-打包与分发.md) | `app.sh`、`server.dist.js`、`build.js` |
> | 08 | [运行机制](MD/08-运行机制.md) | 热重载、命令行、请求处理链、URL 路由 |
> | 09 | [安全边界](MD/09-安全边界.md) | 信任模型、路径防护、`vm.js` 审计 |
> | 10 | [常见问题](MD/10-常见问题.md) | FAQ、文件清单 |
> | 🎓 | [**教程：从零写第一个扩展**](MD/教程-从零写第一个扩展.md) | 手把手，每步可运行 |
>
> 另有 [`examples/`](examples/README.md) 下 5 个教学型扩展。

---

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [目录结构](#目录结构)
- [配置文件](#配置文件)
  - [server.json — 全局配置](#serverjson--全局配置)
  - [html.json — 文件元数据](#htmljson--文件元数据)
- [扩展系统](#扩展系统)
  - [扩展依赖（requires）](#扩展依赖requires)
  - [扩展统计（stats）](#扩展统计stats)
  - [ctx.fetch / ctx.timer](#ctxfetch--ctxtimer)
  - [扩展作用域](#扩展作用域)
  - [扩展安全审计 — vm.js](#扩展安全审计--vmjs)
- [客户端 API — window.NavExt](#客户端-api--windownavext)
- [内置 UI 功能（v2.6）](#内置-ui-功能v26)
- [服务端 API](#服务端-api)
- [自定义主页](#自定义主页)
- [子页扩展策略](#子页扩展策略)
- [打包与分发](#打包与分发)
- [单文件分发（server.dist.js）](#单文件分发serverdistjs)
- [热重载机制](#热重载机制)
- [命令行参数](#命令行参数)
- [请求处理链](#请求处理链)
- [URL 路由](#url-路由)
- [安全边界](#安全边界)
- [常见问题](#常见问题)
- [文件清单](#文件清单)
- [版本历史](#版本历史)
- [License](#license)

## 特性

| 特性 | 说明 |
| --- | --- |
| 🗂 **自动扫描** | 递归扫描目录，按目录分组展示所有 HTML |
| 🔍 **实时搜索** | 按名称/介绍/路径搜索，`/` 聚焦、`Esc` 清空 |
| 🎨 **外观定制** | 标题、描述、logo、页脚、主题色全部可配 |
| 📝 **文件描述** | `html.json` 为任意 HTML 添加标题和介绍，支持 glob 通配与隐藏标记 |
| 🕒 **视图切换** | 导航页一键在「按目录 / 按时间」之间切换，时间视图带相对时间徽标 |
| 🌗 **主题切换** | 跟随系统 / 亮色 / 暗色三档 + 自定义主题色，首屏无闪烁 |
| 🧩 **JS 扩展** | 插件系统，可注入样式/脚本、拦截请求、读写文件、声明配置项 |
| 🎛 **扩展配置** | 扩展声明配置 schema，用户在浏览器里改，无需动代码 |
| 💾 **文件 API** | 项目目录只读，扩展目录读写 |
| ♻️ **全量热重载** | 配置、元数据、扩展、HTML、客户端库，改完全部即时生效 |
| 🕶 **隐藏条目** | `html.json` 的 `hidden: true` 让页面不进列表但 URL 仍可访问 |
| 📦 **零依赖** | 仅用 Node.js 内置模块 |
| 📡 **API 齐全** | RESTful 服务端 API + `window.NavExt` 客户端 API |
| 🛡 **路径安全** | 防目录穿越、防 CSS 注入、无软链死循环 |
| 📦 **单文件分发** | 打包成 `app.sh`，客户端库、HTML、扩展全内联，对方 `./app.sh` 即运行 |
| 🌐 **多主页路由** | `home.routes` 按路径 / Host / 环境变量切换不同主页 |
| 🎯 **扩展作用域** | `js.list.json` 按路径精细控制扩展生效范围 |
| ♻️ **扩展生命周期** | `onDispose`（服务端）+ `NavExt.disposer`（客户端），禁用/卸载自动清理 |
| 🧭 **路径归一化** | `urlToRel` / `relToUrl` / `pathOf`，统一 URL 与相对两套路径体系 |
| 📁 **站点只读 API** | `ctx.project.read/list/stat/exists`，扩展读站点文件不必再用原生 `fs` |

## 快速开始

环境要求：Node.js 14 或更高版本（`ctx.fetch` 需要 Node 18+）。

### 开发态

```text
my-project/
├── server.js
└── .navext.client.js      ← 客户端库，必须与 server.js 同目录
```

```bash
node server.js

# 常用启动方式
node server.js ./public              # 指定扫描目录
node server.js ./public 8080         # 指定目录 + 端口
node server.js -c ./config/nav.json  # 使用自定义配置
node server.js --help                # 查看全部参数
```

改 .navext.client.js 后刷新页面即生效（mtime 缓存，无需重启）。

### 分发态

```bash
node build.js
# ✓ 已完成
#   输出：server.dist.js
#   大小：约 130 KB（其中客户端库 12.3 KB）
```

server.dist.js 就是 server.js 加上内联的客户端库，逻辑完全一样。对方只需 node server.dist.js，不需要 .navext.client.js。

---

## 目录结构

### 开发时

```text
my-project/
├── server.js                     ← 服务器脚本
├── .navext.client.js             ← 客户端库（与 server.js 同目录）
├── build.js                      ← 合并脚本
├── server.json                   ← 全局配置（可选）
├── html.json                     ← 根目录元数据（可选）
├── index.html
├── demo.html
├── docs/
│   ├── html.json                 ← 子目录元数据（可选）
│   ├── guide.html
│   └── api.html
└── .js/                          ← 扩展目录（可选）
    ├── js.list.json
    ├── config.json               ← 用户配置（运行时生成）
    └── hello/
        ├── mod.json
        ├── js.json
        ├── index.js
        ├── client.js
        └── styles.css
```

### 分发时

```text
dist/
└── server.dist.js                ← 一个文件，客户端库已内联
```

---

## 配置文件

### server.json — 全局配置

放在根目录（或用 -c 指定）。所有字段可选。

```json
{
  "port": 3000,
  "host": "0.0.0.0",
  "root": ".",
  "depth": 8,

  "site": {
    "title": "项目文档中心",
    "description": "所有页面的统一入口，支持关键词搜索",
    "logo": "📚",
    "footer": "© 2024 My Company · 内部资料",
    "accent": "#4f6ef7",
    "showStats": true
  },

  "extensions": {
    "enabled": true,
    "dir": ".js",
    "configFile": "config.json"
  },

  "api": {
    "enabled": true,
    "writable": true,
    "fs": {
      "read": true,
      "write": true,
      "maxReadSize": 10485760,
      "maxWriteSize": 1048576,
      "maxListEntries": 2000
    }
  },

  "ignoreDirs": ["node_modules", ".git", "dist"],
  "ignoreFiles": ["*.tmp.html", "draft-*.html"],
  "htmlExtensions": [".html", ".htm"]
}
```

#### 基础字段

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `port` | number | `3000` | 监听端口 |
| `host` | string | `"0.0.0.0"` | 监听地址，`0.0.0.0` 允许外部访问 |
| `root` | string | `"."` | 扫描根目录，相对配置文件所在目录 |
| `depth` | number | `8` | 最大递归深度 |

#### site 外观

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title` | string | 浏览器标题 + 页头大标题 |
| `description` | string | 页头下方的说明文字 |
| `logo` | string | 标题左侧图标，emoji 或短文本 |
| `footer` | string | 页脚自定义文字 |
| `accent` | string | 主题色，作用于 hover 边框、搜索框聚焦光晕 |
| `showStats` | boolean | 是否显示文件/目录统计 |

主题色格式：#hex / #f6f / rgb() / hsl() / CSS 颜色名。非法值自动丢弃并回退默认。

#### extensions 扩展系统

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否启用扩展系统 |
| `dir` | string | `".js"` | 扩展目录名（相对 `root`） |
| `configFile` | string | `"config.json"` | 用户配置文件，存在 `.js/` 下 |
| `timeout` | number | `5000` | 异步钩子（`onHtml`/`onRequest`）超时 ms，`0` 禁用 |
| `fetchTimeout` | number | `30000` | `ctx.fetch` 默认超时 ms |
| `projectMaxBytes` | number | `4194304` | `ctx.project.read` 单文件上限（字节），v2.8 |

#### api 服务端 API

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否开放 `/api/*` |
| `writable` | boolean | `true` | 是否允许 `POST` / `DELETE` 修改 |
| `fs.read` | boolean | `true` | 是否允许任何 FS 读取 |
| `fs.write` | boolean | `true` | 是否允许扩展 FS 写入 |
| `fs.maxReadSize` | number | `10485760` | 单次读取上限（字节），最大 100 MB |
| `fs.maxWriteSize` | number | `1048576` | 单次写入上限（字节），最大 50 MB |
| `fs.maxListEntries` | number | `2000` | 单次列目录上限，最大 50000 |

**开关组合**：

| 配置 | 效果 |
| --- | --- |
| 全部开启 | 读写都可以 |
| `writable: false` | 只读（配置和 FS 都不允许写） |
| `fs.read: false` | 完全关闭 FS 访问 |
| `fs.write: false` | 项目 FS 可读，扩展 FS 只读 |
| `enabled: false` | 关闭所有 API |

#### 扫描规则

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ignoreDirs` | string[] | 跳过的目录名，支持 `*` 和 `?` |
| `ignoreFiles` | string[] | 跳过的文件名，匹配名称或相对路径 |
| `htmlExtensions` | string[] | 识别为 HTML 的扩展名。旧字段 `extensions_` 仍兼容 |

字段命名：extensions 是扩展系统配置，htmlExtensions 是识别 HTML 的扩展名列表。二者名字接近但用途不同。

---


#### home 自定义主页

用自定义 HTML 替代自动生成的导航页。

```json
{
  "home": {
    "enabled": true,
    "file": "home.html",
    "applyExtensions": true
  }
}
```

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 是否用自定义 HTML 替代导航页 |
| `file` | string | `""` | 主页文件路径（相对 `root`），越界会被拒绝 |
| `applyExtensions` | boolean | `false` | 是否把扩展注入和 `__NAV_DATA__` 注入到自定义主页 |
| `routes` | array | `[]` | 多主页路由（v1.8），按顺序匹配 |

**三种模式**：

| enabled | applyExtensions | 结果 |
| --- | --- | --- |
| `false` | — | 自动生成导航页（默认） |
| `true` | `false` | 原样输出自定义 HTML，无扩展注入 |
| `true` | `true` | 输出 HTML + 扩展的 styles / scripts / header / footer + `__NAV_DATA__` |

**回退**：`enabled = true` 但文件读不到时，回退到自动生成导航页，终端打印警告。

**热重载**：`home.*` 和 `home.html` 内容改动后刷新即生效，无需重启。

### html.json — 文件元数据

放在任意目录下，为其中 HTML 指定显示名称和介绍。

对象形式（推荐）：

```json
{
  "@dir": {
    "title": "项目文档",
    "description": "全部页面的入口，建议从这里开始阅读"
  },
  "index.html": {
    "title": "首页",
    "description": "项目总览与快速上手"
  },
  "demo.html": "演示页面",
  "api.html": {
    "title": "API 参考",
    "desc": "所有接口的详细说明"
  }
}
```

数组形式：

```json
[
  { "file": "index.html", "title": "首页", "description": "项目总览" },
  { "path": "sub/page.html", "title": "子页面" }
]
```

key 说明：

| key | 含义 |
|---|---|
| `"@dir"` | 该目录分组本身的标题和介绍，大小写不敏感（`@DIR` / `@Dir` 均可） |
| 文件名 | 如 `"index.html"`，不区分大小写 |
| 相对路径 | 如 `"sub/page.html"`，可跨目录匹配 |
| **glob 通配** | 如 `"draft-*.html"`、`"*.tmp.html"`、`"api-?.html"`，支持 `*` 与 `?` |

value 写法：

- 字符串 → 等价于 `{ "title": 该字符串 }`
- 对象 → `{ "title": "...", "description": "...", "hidden": true }`

字段别名：

| 主字段 | 别名 |
|---|---|
| title | name、label、displayName |
| description | desc、intro、summary、note |
| hidden | hide、hiddenFromNav、hideFromNav、unlisted |

匹配优先级：文件所在目录的 `html.json` > 根目录的 `html.json`。未配置的 HTML 仍会列出，显示原始文件名。

#### 隐藏条目（v2.6）

给条目加 `hidden: true`，它会**从导航页与 JSON 列表中移除，但 URL 仍可正常访问（HTTP 200）**。
适合"想分享链接、但不想让它出现在公开列表里"的页面。

```json
{
  "secret.html": { "hidden": true },
  "draft-*.html": { "hidden": true },
  "@dir": { "hidden": true }
}
```

- **文件级**：精确名 / 相对路径 / glob 命中且带 `hidden` → 该文件隐藏。
- **目录级**：该目录的 `@dir` 带 `hidden: true` → 目录下**所有**文件隐藏（并级联到子目录）。
- 隐藏项仍会出现在 `window.__NAV_DATA__.files` 里并带 `"hidden": true`，方便扩展按需处理。

**与 `ignoreFiles` 的语义区别**（重要）：

| 机制 | 导航页 | URL 访问 | 适用场景 |
|---|---|---|---|
| `server.json` 的 `ignoreFiles` | 不显示 | **404** | 彻底排除（构建产物、模板等） |
| `html.json` 的 `hidden: true` | 不显示 | **200 可访问** | 有链接但不进列表 |

**API 行为**：`/?format=json` 与 `/api/search` 默认**排除**隐藏项；
加 `?hidden=1` 可包含（`/?format=json` 另返回 `hiddenCount` 便于统计）。

---

## 扩展系统

### 目录结构

```text
<root>/.js/
├── js.list.json              # 必填：声明启用哪些扩展
├── config.json               # 运行时生成：用户配置覆盖值
├── hello/                    # 一个扩展一个目录
│   ├── mod.json              # 元数据
│   ├── js.json               # 注入配置 + 配置 schema
│   ├── index.js              # 服务端钩子（可选）
│   ├── client.js             # 客户端脚本（可选）
│   └── styles.css            # 样式文件（可选）
└── world/
    └── ...
```

### js.list.json — 扩展清单

```json
{ "extensions": ["hello", "world"] }
```

也支持数组简写：

```json
["hello", "world"]
```

数组顺序不决定加载顺序。实际顺序由每个扩展的 mod.json.order 决定。

### mod.json — 元数据

全部字段可选：

```json
{
  "name": "Hello Extension",
  "description": "演示扩展",
  "version": "1.0.0",
  "author": "Your Name",
  "enabled": true,
  "order": 100,
  "cssOrder": 100
}
```

字段 说明
name 显示名称，默认用目录名
description 扩展说明
version / author 版本与作者
enabled false 时跳过此扩展
order **加载顺序**，数字越小越先加载，默认 100
cssOrder **CSS 覆盖顺序**，数字越小越先注入（越大越后注入、越晚胜出），默认回退到 order（v2.8.2）
requires 依赖的扩展 ID 列表，缺依赖时跳过该扩展（v2.3）

> **`order` 与 `cssOrder` 是两件独立的事（v2.8.2 起）**
>
> - `order` 只决定**扩展脚本/钩子的加载顺序**（以及 `requires` 拓扑排序后的相对位置）；
> - `cssOrder` 只决定**谁的 `styles` 在页面里后注入**，也就是**CSS 覆盖优先级**——后注入的赢；
> - 两者互不影响。想让某个扩展「加载得早、但样式优先级最高」，就把它 `order` 设小、`cssOrder` 设大；
> - 不写 `cssOrder` 时回退到 `order`，与 v2.8.1 及更早版本行为完全一致。
>
> 在 v2.8.2 之前，CSS 覆盖顺序只能靠 `order` 间接控制，而 `order` 又受 `requires` 拓扑排序影响，导致「想调样式优先级就得连加载顺序一起改」的耦合。现在解开了。
>
> ```json
> // A：加载晚，但样式最先被覆盖（优先级最低）
> { "order": 500, "cssOrder": 1 }
>
> // B：加载早，但样式最后注入（优先级最高）
> { "order": 10, "cssOrder": 999 }
> ```
>
> 上例加载顺序是 `B, A`，CSS 注入顺序是 `A, B`，最终 B 的样式生效。

### js.json — 注入配置 + 配置 schema

支持 5 个注入字段，值可以是字符串或数组：

```json
{
  "styles":  "styles.css",
  "scripts": "client.js",
  "head":    "meta.html",
  "header":  "banner.html",
  "footer":  "foot.html"
}
```

字段 注入位置
styles <head> 中的 <style> 块
scripts </body> 前的 <script> 块
head <head> 中原样注入
header <body> 开头原样注入
footer </body> 前原样注入

值的三条解析规则：

写法 处理方式
"styles.css" 简短、无 <>{} 与换行、文件存在 → 作为文件读取
"@file: path.css" 强制作为文件读取
"inline: .card{}" 强制作为内联内容

含 <>{}、换行、或者 @/# 开头的长字符串会被直接当作内联内容。

> **`.css` / `./x.css` 这类写法会被当成内联内容**（因为以 `.` 开头，或长度虽短但被判定为「不像文件路径」）。
> 想稳定引用扩展目录里的文件，请一律用 `"@file:client.css"` 这种显式前缀。

**注入顺序（v2.8.2）**

| 注入字段 | 排序依据 |
|---|---|
| `styles` | 按各扩展的 **`cssOrder`** 升序（回退到 `order`），与加载顺序无关 |
| `scripts` / `head` / `header` / `footer` | 按扩展**加载顺序**（`order` + `requires` 拓扑排序） |

也就是说，**只有 `styles` 受 `cssOrder` 控制**——这正是 CSS 覆盖语义需要的东西；其余注入保持「谁先加载谁先注入」的可预期行为。详见 [mod.json — 元数据](#modjson--元数据)。

### index.js — 服务端钩子

所有钩子都支持 async：

```js
module.exports = {
  // 扩展加载后（每次热重载都会调用）
  onInit(ctx) {
    ctx.log('扩展已加载');
  },

  // 扫描完成后调用，返回值替换文件列表
  onFiles(files, ctx) {
    return files;
  },

  // 生成 HTML 后调用，返回值替换 HTML
  onHtml(html, ctx) {
    return html;
  },

  // 每个请求开始时调用（在路由前）
  // 返回对象则拦截并直接作为响应
  onRequest(req, url, ctx) {
    if (url.pathname === '/hello') {
      return {
        status: 200,
        type: 'text/plain; charset=utf-8',
        body: 'Hello!'
      };
    }
    return null;
  },

  // 也可以在这里写注入内容，会与 js.json 合并
  styles: `.card { border-radius: 16px }`,
  scripts: `console.log('hello loaded')`
};
```

| 钩子 | 触发时机 | 返回值 |
| --- | --- | --- |
| `onInit(ctx)` | 扩展加载后 | 无 |
| `onFiles(files, ctx)` | 扫描完成后 | 数组则替换文件列表（**必须同步**） |
| `onHtml(html, ctx)` | 页面 HTML 生成后 | 字符串则替换 HTML |
| `onRequest(req, url, ctx)` | 路由分发前 | 对象则拦截响应（任意 HTTP 方法） |
| `onResponse(info, ctx)` | 响应已发出后 | 无（只读观察者） |
| `onError(err, ctx)` | 扩展钩子出错后 | 无 |
| `onDispose(ctx)` | 扩展重载 / 禁用 / 关停 | 无（收尾清理，`v2.7.0` 新增） |
| `stats()` | — | 返回统计数据，由 GET /api/extensions/:id/stats 读取 |

onRequest 返回对象的结构：

```js
{
  status: 200,                       // HTTP 状态码，默认 200
  type: 'application/json',          // Content-Type
  headers: { 'X-Custom': 'value' },  // 其他响应头
  body: '...'                        // 字符串或 Buffer
}
```

ctx 上下文对象：

```js
{
  extId: 'hello',                    // 扩展 ID
  extDir: '/path/to/.js/hello',      // 扩展目录绝对路径
  root: '/path/to/root',             // 扫描根目录
  configPath: '/path/to/server.json',
  files,                             // onFiles / onHtml 时有
  config: { ... },                   // 合并后的配置值（默认值 + 用户覆盖）
  configSchema: [ ... ],             // schema 数组
  userConfig: { ... },               // 用户显式覆盖的部分
  hasUserConfig: false,              // 是否有用户覆盖
  dirMeta,
  pathname,                          // onRequest 时有
  fs: { ... },                       // 见下文 ctx.fs
  log(...args),                      // 带 [ext:hello] 前缀
  warn(...args),

  // ── 路径归一化（v2.7.0）──
  pathOf(p),                         // 任意一侧 → 统一 URL 体系
  urlToRel(p),                       // URL → 相对路径（'/' → 'index.html'）
  relToUrl(p),                       // 相对 → URL（'index.html' → '/'）
}
```

**路径归一化（v2.7.0）**：NavExt 内部有两套路径体系，扩展做「按文件关联」时极易踩坑：

| 体系 | 来源 | 首页 | 示例 |
| --- | --- | --- | --- |
| URL 体系 | `onRequest` / `onResponse` 的 `pathname` | `/` | `/docs/a.html` |
| 相对体系 | `getFiles()[].path` | `index.html` | `docs/a.html` |

服务端经 `ctx`、客户端经 `NavExt` 暴露同一组函数，**两实现行为严格一致**：

```js
ctx.urlToRel('/docs/a.html')   // → 'docs/a.html'
ctx.urlToRel('/')              // → 'index.html'
ctx.urlToRel('/docs/')         // → 'docs/index.html'
ctx.relToUrl('index.html')     // → '/'
ctx.relToUrl('a/index.html')   // → '/a/'
ctx.pathOf('docs/a.html')      // → '/docs/a.html'（统一到 URL 体系）
```

服务端读文件用**相对**路径、记录请求用**URL**路径时，用 `ctx.pathOf()` 对齐两者即可。

ctx.config 是合并后的配置值，服务端直接读即可；ctx.userConfig 是用户显式覆盖的部分，ctx.configSchema 是 schema。客户端对应的是 NavExt.getExtConfig(id) / getExtConfigSchema(id)。


**模块加载器**：`index.js` 及其 `require` 的本地文件，由服务端内置的 CommonJS 加载器处理，**不走 Node 原生 `require` 的缓存**。

这意味着：

- 改 `.js/<name>/` 下任意文件（含被 `index.js` 引用的 `lib/` 子模块），下次请求重新加载时整体生效
- 同一次加载内，`require` 同一路径返回同一实例
- 支持循环依赖，与 Node 原生行为一致
- 绝对模块名（`fs` / `path` 等）落到 Node 原生 `require`，走 Node 自己的缓存

#### 请求体读取

在 `onRequest` 钩子里读请求体，用这两个方法之一：

| 方法 | 返回 |
| --- | --- |
| `await ctx.readBody()` | 请求体字符串（原始文本） |
| `await ctx.readJson()` | 请求体对象（JSON 解析后） |

```js
module.exports = {
  async onRequest(req, url, ctx) {
    if (url.pathname !== '/api/submit' || req.method !== 'POST') return null;

    const { name } = await ctx.readJson();
    return {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({ hello: name }),
    };
  },
};
```

**只在 `onRequest` 里可用**——其他钩子没有请求对象。在别的钩子里调会 reject。

**可以多次调用**：内部缓存 req 数据，第二次 `ctx.readJson()` 返回同一结果，不会消费两次流。

**错误处理**：请求体超过限制 → reject 413；JSON 解析失败 → reject 400。


### 扩展配置（js.json 的 config 字段）

在 js.json 或 index.js 里声明 config，用户就能通过浏览器或 API 修改，不用动代码。

```json
{
  "config": {
    "iconUrl": {
      "type": "url",
      "label": "图标 URL",
      "description": "显示在卡片标题旁",
      "default": "https://www.deepseek.com/favicon.ico"
    },
    "size": {
      "type": "number",
      "label": "图标大小",
      "default": 18,
      "min": 8,
      "max": 64,
      "step": 1
    },
    "color": { "type": "color", "label": "主题色", "default": "#4f6ef7" },
    "showBadge": { "type": "boolean", "label": "显示徽标", "default": true }
  },
  "styles": "styles.css",
  "scripts": "client.js"
}
```

也支持在 index.js 里声明，与 js.json 合并（index.js 优先）：

```js
module.exports = {
  config: {
    size: { type: 'number', default: 18, min: 8, max: 64 },
  },
  onInit(ctx) {
    ctx.log('扩展已加载');
  },
};
```

简写：直接给默认值，类型自动推断：

```json
{ "config": { "iconUrl": "https://...", "size": 18, "showBadge": true } }
```

#### 类型系统

| type | 值域 | 校验规则 | UI 建议 |
| --- | --- | --- | --- |
| `string` | 任意字符串 | 按 `maxLength` 截断（≤10000） | 单行输入框 |
| `number` | 有限数字 | 自动 clamp 到 `[min, max]`，可设 `step` | 数字输入框 |
| `boolean` | `true` / `false` | 强制布尔转换 | 复选框 |
| `color` | CSS 颜色 | `sanitizeCssColor` 校验，非法回退默认 | 颜色选择器 |
| `select` | 枚举值 | 校验是否在 `options` 中，否则取第一项 | 下拉框 |
| `textarea` | 多行字符串 | 按 `maxLength` 截断 | 多行文本域 |
| `url` | URL 字符串 | 与 `string` 相同 | 带校验的输入框 |

**字段选项**：

| 字段 | 适用类型 | 说明 |
| --- | --- | --- |
| `label` / `description` | 所有 | 显示名称 / 字段说明 |
| `placeholder` | 所有 | 输入占位符 |
| `default` | 所有 | 默认值 |
| `min` / `max` / `step` | `number` | 数值范围与步长 |
| `maxLength` | `string` / `url` / `textarea` | 最大长度 |
| `options` | `select` | 选项数组 |

select 的 options 写法：

```json
{
  "options": ["light", "dark", "auto"]
}
```

或带标签：

```json
{
  "options": [
    { "value": "light", "label": "浅色" },
    { "value": "dark", "label": "深色" }
  ]
}
```

### 扩展端 ctx.fs

在 index.js 的钩子里，ctx.fs 提供同步的文件读写，自动限定在扩展目录内：

```js
module.exports = {
  onInit(ctx) {
    if (!ctx.fs.exists('cache.json')) {
      ctx.fs.write('cache.json', JSON.stringify({ created: Date.now() }));
    }
    ctx.log('缓存内容:', ctx.fs.read('cache.json'));
  },

  onFiles(files, ctx) {
    var rules = JSON.parse(ctx.fs.read('rules.json'));
    return files.filter(function (f) {
      return !rules.exclude.some(function (pat) {
        return f.rel.indexOf(pat) !== -1;
      });
    });
  },
};
```

方法 说明
path(rel) 解析相对路径为绝对路径
exists(rel) 存在性
read(rel, opts?) 读文件。`opts` 可为编码字符串（`'utf8'` / `'buffer'`），或 `{ encoding, maxBytes }`；默认 utf8
write(rel, content, encoding) 写文件（自动创建父目录）
delete(rel) 递归删除
list(rel, opts?) 列目录，返回 [{ name, path, type }]；`opts.depth` 控制递归层数（默认 1）
dir 扩展根目录绝对路径

所有方法都经过路径校验，越界时抛异常。

**与 `ctx.project` 对齐（v2.8.2）** —— 两者除了「根目录不同、`ctx.project` 只读」之外，行为完全一致：

| 行为 | `ctx.fs` | `ctx.project` |
| --- | --- | --- |
| `read` 支持 `{ encoding, maxBytes }` | ✅ | ✅ |
| 超限时的错误码 | `FS_TOO_LARGE` | `PROJECT_FS_TOO_LARGE` |
| `list` 返回项含 `name` / `path` / `type` | ✅ | ✅ |
| `list` 支持 `{ depth }` 递归 | ✅ | ✅ |
| `list` 目标不存在 | 抛「目录不存在」 | 抛「目录不存在」 |
| `list` 目标是文件 | 抛「不是目录」 | 抛「不是目录」 |
| `stat` | ❌ 无 | ✅ 有 |
| `write` / `delete` | ✅ 有 | ❌ 只读 |

`ctx.fs` 的 `maxBytes` 默认取 `server.json` 的 `api.fs.maxReadSize`（未设则不限），可在单次调用里用 `{ maxBytes }` 收紧。

```js
// 大文件保护：超过 64KB 就抛 FS_TOO_LARGE，别把内存读爆
var big = ctx.fs.read('dump.json', { maxBytes: 64 * 1024 });

// 递归列两层
var tree = ctx.fs.list('assets', { depth: 2 });
// → [{ name, path: 'assets/img/logo.png', type: 'file' }, ...]

// 读二进制
var buf = ctx.fs.read('icon.png', 'buffer');          // 旧写法
var buf2 = ctx.fs.read('icon.png', { encoding: 'buffer' });  // 新写法
```

> ⚠️ **`ctx.fs` 是便利封装，不是安全边界。**
> 它只防止"手滑写错路径"，**不能**阻止扩展直接用原生 `fs` 读写任意文件。
> 扩展装入 `.js/` 后即以服务器进程权限运行 —— **安装第三方扩展 = 完全信任其作者**，
> 与安装 npm 包同级。装前请务必用 `vm.js` 审计（见下节）。

### 扩展端 ctx.project（v2.8）

`ctx.fs` 锁在扩展自己的目录里，读不到站点文件。要在扩展里读站点的 `.md` / `.html` / 配置，
以前只能 `require('fs')` —— 绕开了所有校验。`ctx.project` 提供一个**受限的只读**入口：

```js
module.exports = {
  onRequest(req, url, ctx) {
    if (!/\.md$/i.test(url.pathname)) return undefined;

    // URL 路径 → 站点相对路径（v2.7 归一化工具）
    var rel = ctx.urlToRel(url.pathname);

    // 不存在就交回内核（会 404），不必自己判断
    var st = ctx.project.stat(rel);
    if (!st || st.type !== 'file') return undefined;

    var md = ctx.project.read(rel, { maxBytes: 256 * 1024 });
    return { status: 200, type: 'text/html; charset=utf-8', body: render(md) };
  },
};
```

| 方法 | 说明 |
| --- | --- |
| `read(rel, opts?)` | 读文件。`opts` 可为编码字符串，或 `{ encoding, maxBytes }`；`encoding: 'buffer'` 返回 Buffer |
| `exists(rel)` | 存在性（被拒绝的路径一律返回 `false`） |
| `stat(rel)` | 返回 `{ path, type, size, mtimeMs }`；**不存在返回 `null`**（不抛错，方便探测） |
| `list(rel, opts?)` | 列目录，返回 `[{ name, path, type }]`；`opts.depth` 控制递归层数（默认 1） |
| `path(rel)` | 解析为绝对路径（给需要传路径的第三方库） |
| `root` | 站点根目录绝对路径 |

**三重校验，与静态资源服务同源**：

1. **越界**：`../`、绝对路径、Windows 盘符、`\0` 一律拒绝；
2. **隐藏路径**：路径中任一段以 `.` 开头即拒绝 —— `.js/`（其他扩展的代码）、`.git/`、`.navext.client.js` 都读不到；
3. **软链接**：指向 root 之外的符号链接被拦下（`path 越界（符号链接指向外部）`）。

> 因此**"扩展能读到的文件" = "静态服务器愿意暴露的文件"**，多了这个 API 不扩大攻击面。
> 只读：没有 `write` / `delete`。

默认单文件上限 4 MB，可用 `server.json` 的 `extensions.projectMaxBytes` 调整。
超限抛出的错误带 `code: 'PROJECT_FS_TOO_LARGE'`。
`list` 的目标不存在时抛「目录不存在」、目标是文件时抛「不是目录」（与 `ctx.fs.list` 一致，v2.8.2 起）。

### 扩展安全审计 — vm.js

`vm.js` 是一个**零依赖、可独立运行**的扩展安全沙箱检测器：把扩展放进隔离的 `vm` 上下文里**真实执行**，
但其中的 `require` / `fs` / `child_process` / `fetch` / `net` / `process.env` 全部换成**只记录、不执行的仿真实现**——
扩展以为自己在攻击，实际只是在向审计器"交代意图"。**全程无任何真实副作用。**

它能对抗**字符串拼接混淆**：静态扫描看不见 `require('child_process')` 时，运行时照样拦得住。

```bash
node vm.js .js/copy-link          # 审计单个扩展
node vm.js --all                  # 审计 .js/ 下全部扩展
node vm.js .js/x --json           # 输出机器可读 JSON
node vm.js --all --strict         # 可疑(Suspicious)也视为失败，用于 CI 门禁
node vm.js .js/x --timeout 5000   # 自定义单次运行超时（默认 3000ms）
```

评级采用三档（对齐腾讯云鼎实验室标准）：

| 等级 | 分值 | 含义 |
| --- | --- | --- |
| 🔴 Malicious | 0–30 | 存在明确恶意特征，**严禁使用** |
| ⚠️ Suspicious | 31–75 | 存在风险行为，需人工复核 |
| ✅ Benign | 76–100 | 未发现风险行为 |

退出码：`0` 全部可信 / `1` 存在可疑（仅 `--strict`）/ `2` 存在恶意。

也可作为模块被内核或工具调用：

```js
const { auditExtension, auditDirectory } = require('./vm.js');
const r = auditExtension('.js/copy-link');   // → { level, score, maliciousFindings, ... }
```

**局限（诚实声明）**：异步钩子里（`Promise`/`setTimeout` 回调）的危险动作同步超时窗口覆盖不到，
此时依赖静态扫兜底；`vm` 模块本身并非强安全边界，无法保证 100% 阻隔**主动逃逸**。
本工具用于**判定"这个扩展是否可信"**，而非**"在不可信代码旁边安全运行"**。

### 扩展作用域

默认情况下扩展在所有页面生效。如果某个扩展只应该在特定路径下工作——比如"只在 /docs 下显示"、"除了 /admin 外都生效"——用 `js.list.json` 的 `scope` 声明。

#### 写法

三种写法都支持：

**数组形式**（无 scope，兼容旧版）：

```json
{ "extensions": ["a", "b"] }
```

**混合形式**（部分扩展带 scope）：

```json
{
  "extensions": [
    "a",
    { "id": "b", "paths": ["/docs/*"] },
    { "id": "c", "paths": ["/blog/*"], "exclude": ["/blog/private/*"] }
  ]
}
```

**对象映射形式**：

```json
{
  "extensions": {
    "a": {},
    "b": { "paths": ["/docs/*"] },
    "c": { "paths": ["/blog/*"], "exclude": ["/blog/private/*"] }
  }
}
```

#### scope 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `paths` | string[] | 允许生效的路径 glob。省略 = 全部允许 |
| `exclude` | string[] | 排除的路径 glob，优先于 `paths` |

`*` 匹配任意字符（含 `/`），`?` 匹配单字符，不区分大小写。

**示例**：

| 声明 | 匹配 | 不匹配 |
| --- | --- | --- |
| `"/docs/*"` | `/docs`、`/docs/`、`/docs/guide.html`、`/docs/a/b.html` | `/blog` |
| `"/docs"` | `/docs`、`/docs/` | `/docs/guide.html` |
| `"/*"` | 所有路径 | — |

`/docs/*` 会一并匹配 `/docs` 本身——因为服务端判断时会把 `pathname` 加上尾部 `/` 再匹配一次（`/docs` 会拿 `/docs/` 去撞 `/docs/*`）。想只匹配子路径、不匹配 `/docs`，需显式排除：

```json
{ "paths": ["/docs/*"], "exclude": ["/docs"] }
```

#### 作用范围

| 钩子 / 注入 | 受 scope 影响 |
| --- | --- |
| `onInit` | ❌ 始终执行 |
| `onFiles` | ❌ 始终执行 |
| `onHtml` | ✅ 只匹配路径执行 |
| `onRequest` | ✅ 只匹配路径执行 |
| `styles` / `scripts` / `head` / `header` / `footer` | ✅ 只匹配路径注入 |

`onInit` 和 `onFiles` 与具体页面无关——前者是初始化副作用（建文件、建目录），后者是全局文件列表处理——所以始终执行。

#### 客户端判断

页面里的 `NavExt` 提供三个 API 判断扩展是否在当前页面生效：

```js
// 单个扩展：布尔判断
NavExt.isExtActive("arch-diagram")             // 当前页面
NavExt.isExtActive("arch-diagram", "/docs")    // 指定路径

// 列出当前页面所有生效的扩展
NavExt.getActiveExtIds()                       // ["id1", "id2", ...]
NavExt.getActiveExtensions()                   // 完整元数据数组
NavExt.getActiveExtIds("/blog")                // 指定路径
```

和 `getExtensions()` 的区别：

| 方法 | 返回 |
| --- | --- |
| `getExtensions()` | 所有已启用的扩展（不看当前页面） |
| `getActiveExtensions()` | 只在当前页面生效的扩展 |

#### 元数据里的 scope

`__NAV_DATA__.extensions[]` 每一项都带 `scope` 字段：

```json
{
  "id": "arch-diagram",
  "name": "架构图",
  "scope": { "paths": ["/docs/*"], "exclude": [] }
}
```

无 scope 的扩展该项为 `null`——表示全局生效。

#### 客户端判断与服务端过滤的关系

服务端按 scope **过滤注入**——不在作用域内的扩展，其 styles / scripts / header / footer **不会**进页面。

但 `__NAV_DATA__.extensions` 里**始终列出所有已启用扩展**，不按 scope 过滤。理由：

1. 客户端可以跨 scope 通信——`/docs` 上的脚本可以知道 `/blog` 有一个扩展，用 `NavExt.emit` 发消息
2. 调试方便——控制台里 `NavExt.getExtensions()` 能看到全部启用扩展
3. 职责单一——scope 只影响"服务端什么时候注入"，不影响"客户端知不知道"

#### 向后兼容

不写 scope 的扩展行为完全不变——`ext.scope` 为 `null`，`extMatchesScope` 直接返回 `true`。现有 `js.list.json` 不用改。

#### 完整示例

```json
{
  "extensions": [
    "ext-manager",
    { "id": "arch-diagram", "paths": ["/docs", "/docs/*"] },
    "deepseek-logo",
    { "id": "stardust-icon", "paths": ["/blog/*"] },
    "copy-link"
  ]
}
```

含义：

- `ext-manager` / `deepseek-logo` / `copy-link` —— 全局生效
- `arch-diagram` —— 只在 `/docs` 和 `/docs/` 下生效
- `stardust-icon` —— 只在 `/blog/` 下生效

启动日志会标注：

```text
  扩展     5 个 (ext-manager, arch-diagram*, deepseek-logo, stardust-icon*, copy-link)
  作用域   2 个有路径限制（* 标记）
```

---
### 完整扩展示例

> 💡 **更多可运行的示例**：仓库 `examples/` 目录下有 5 个教学型扩展，
> 覆盖服务端钩子、客户端卡片 API、Markdown 渲染、访问统计、键盘快捷键。
> 见 [`examples/README.md`](examples/README.md)。
>
> 📋 **能力缺口清单**：想知道扩展 API "做不到什么"，
> 见 [`NavExt-扩展能力缺口清单.md`](../../NavExt-扩展能力缺口清单.md)。

一个「收藏夹」扩展，声明配置项、读写自己的 starred.json：

.js/js.list.json

```json
{ "extensions": ["starred"] }
```

.js/starred/mod.json

```json
{
  "name": "收藏夹",
  "description": "给卡片加星标",
  "version": "1.0.0",
  "order": 10
}
```

.js/starred/js.json

```json
{
  "config": {
    "color": { "type": "color", "label": "星标颜色", "default": "#f59e0b" },
    "icon": { "type": "string", "label": "星标字符", "default": "★" }
  },
  "styles": "styles.css",
  "scripts": "client.js"
}
```

.js/starred/index.js

```js
module.exports = {
  onInit(ctx) {
    if (!ctx.fs.exists('starred.json')) {
      ctx.fs.write('starred.json', '[]');
    }
  },

  onFiles(files, ctx) {
    try {
      var starred = JSON.parse(ctx.fs.read('starred.json'));
      return files.slice().sort(function (a, b) {
        var aS = starred.indexOf(a.rel) >= 0;
        var bS = starred.indexOf(b.rel) >= 0;
        if (aS !== bS) return aS ? -1 : 1;
        return a.rel.localeCompare(b.rel);
      });
    } catch (err) {
      ctx.warn('读 starred.json 失败:', err.message);
      return files;
    }
  },
};
```

.js/starred/client.js

```js
(function () {
  var ID = 'starred';
  var fs = NavExt.extFs(ID);
  var STORE = 'starred.json';

  async function load() {
    if (!(await fs.exists(STORE))) return [];
    var r = await fs.read(STORE);
    try { return JSON.parse(r.content) || []; } catch { return []; }
  }

  async function save(list) {
    await fs.write(STORE, JSON.stringify(list, null, 2));
  }

  async function apply() {
    var cfg = NavExt.getExtConfig(ID);
    var list = await load();
    list.forEach(function (path) {
      NavExt.addCardBadge(path, cfg.icon, cfg.color, { key: 'star' });
    });
  }

  document.addEventListener('click', async function (e) {
    var badge = e.target.closest('[data-ext-badge="star"]');
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation();

    var card = badge.closest('[data-ext-target="card"]');
    var path = card.dataset.extPath;
    var list = await load();
    var i = list.indexOf(path);
    if (i >= 0) list.splice(i, 1);
    else list.push(path);
    await save(list);
    location.reload();
  });

  NavExt.on('cards-updated', apply);
  NavExt.on('ext-config-changed', function (p) {
    if (p.id === ID) apply();
  });
})();
```

.js/starred/styles.css

```css
[data-ext-badge="star"] {
  cursor: pointer;
  user-select: none;
}
[data-ext-badge="star"]:hover {
  transform: scale(1.15);
}
```

用户改配置（浏览器控制台）：

```js
await NavExt.setExtConfig('starred', { color: '#10b981', icon: '⭐' });
await NavExt.resetExtConfig('starred');
```

用户配置写入 .js/config.json，按扩展 ID 分组，只保存被显式覆盖的字段：

```json
{
  "starred": { "color": "#10b981", "icon": "⭐" }
}
```

### 扩展超时

单个扩展的异步钩子如果卡住——比如 `onRequest` 里 `await` 一个永不 resolve 的 Promise——会拖住整个服务。加超时保护：

```json
{
  "extensions": {
    "timeout": 5000
  }
}
```

| 字段 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `extensions.timeout` | `5000` | 0 – 60000 | 异步钩子超时（毫秒），`0` = 禁用 |

**保护范围**：只保护**异步钩子**——`onHtml` / `onRequest` 返回 Promise 时。

**超时粒度**：**每个扩展的每个钩子独立计时**。

也就是说，一个请求命中 5 个扩展的 `onRequest`，每个都卡 5 秒的话，最坏总响应时间是 25 秒。

选这个语义的理由：

- 行为可预测——每个扩展的预算独立，不被其他扩展挤占
- 实现简单——不需要在钩子间传递"剩余预算"

**扩展作者需要意识到**：总响应时间 ≈ 各扩展钩子耗时之和。单个扩展慢会直接拉长整体。如果有多个扩展，可以考虑把 `extensions.timeout` 设小（比如 2000ms）。

**不保护同步钩子**：`onInit` / `onFiles` 是同步的，`while(true)` 会真锁死进程。想让某个钩子受保护，写成 `async`。

**超时后的行为**：

- `onRequest` 超时 → 返回 **504 Gateway Timeout**，不降级到静态文件
- `onHtml` 超时 → 使用该扩展之前的结果，继续渲染
- 同时触发扩展自己的 `onError(err, ctx)` 钩子，`ctx.hook` 标明来自哪个钩子

**注意**：超时后扩展内部的 Promise **仍在跑**，Node 无法强制取消。

具体后果：

- 扩展内部的写文件、发请求、改全局状态**照常发生**
- `onHtml` 超时后用该扩展之前的结果渲染——但 3 秒后那个慢操作完成时，副作用（比如写缓存）还是落下了
- 下次请求可能拿到"上次的下一版"状态，难以追踪

**扩展作者应在可能超时的路径上避免写操作**。只读操作（读取配置、计算）超时无害；写操作（保存状态、上报）超时后状态会不一致。

### onError 钩子

扩展可以监听自己的错误——任何钩子（`onInit` / `onFiles` / `onHtml` / `onRequest`）抛异常时触发：

```js
module.exports = {
  onError(err, ctx) {
    console.log('[' + ctx.hook + '] 出错：', err.message);
    // 上报、降级、写日志
  },
};
```

| 参数 | 说明 |
| --- | --- |
| `err` | 错误对象。超时的 `err.code` 是 `'EXT_TIMEOUT'` |
| `ctx.hook` | 出错的钩子名 |

**同步与异步**：`onError` 支持两种写法——

- **同步**（最常见）：直接执行，返回值忽略。适合本地记录
- **异步**：返回 Promise 时会被调用，但**不等待**——promise 在后台跑，卡住也不影响请求

```js
module.exports = {
  async onError(err, ctx) {
    // 上报到远端 —— 不阻塞请求，失败也不影响主流程
    await fetch('https://monitor.example.com/log', {
      method: 'POST',
      body: JSON.stringify({ hook: ctx.hook, msg: err.message }),
    }).catch(() => {});
  },
};
```

**为什么不等待**：如果等待，一个卡住的远程上报会拖死整个请求。onError 是"通知"不是"控制流"。

**onError 自身出错**：只打日志，不再递归通知。


---

## 客户端 API — window.NavExt

服务端把 __NAV_DATA__ 和 NavExt 客户端库注入到页面。所有 API 挂在 window.NavExt 上。

### 数据

| 方法 | 返回 |
| --- | --- |
| `getFiles()` | 所有文件的数组 |
| `getFile(path)` | 按路径查单个文件，找不到返回 `null` |
| `getConfig()` | 站点配置 |
| `getExtensions()` | 已启用的扩展列表 |

```js
var files = NavExt.getFiles();
// [{ path, url, dir, name, title, description, size, mtime }, ...]

var f = NavExt.getFile('docs/index.html');
var f2 = NavExt.getFile('/DOCS/INDEX.HTML');   // 路径不区分大小写
```

### 路径归一化（v2.7.0）

服务端与客户端各一份、**行为严格一致**的实现：

| 方法 | 说明 | 示例 |
| --- | --- | --- |
| `urlToRel(p)` | URL → 相对路径 | `'/docs/a.html'` → `'docs/a.html'`；`'/'` → `'index.html'` |
| `relToUrl(p)` | 相对 → URL | `'docs/a.html'` → `'/docs/a.html'`；`'index.html'` → `'/'` |
| `pathOf(p)` | 任意一侧 → 统一 URL 体系 | `'docs/a.html'` → `'/docs/a.html'` |
| `normalizePath(p)` | → 可比较的 key（小写） | `'/DOCS/A.HTML'` 与 `'docs/a.html'` 归一后相等 |

```js
// 典型场景：服务端 stats() 的键是相对路径，客户端拿它是 URL 路径
var key = NavExt.normalizePath('/docs/a.html');       // 'docs/a.html'
var n = stats.counts[key];                            // 正确命中
```

### 生命周期（v2.7.0）

扩展被禁用或页面卸载时，`setInterval` / `addEventListener` / `fetch` 轮询**不会自动停止**。
用 `disposer` 把清理函数托管给内核，即可避免泄漏：

| 方法 | 说明 |
| --- | --- |
| `disposer(extId, fn)` | 注册清理函数，返回取消注册的函数；省略 `extId` 时为全局 `'*'` |
| `dispose(extId)` | 手动执行清理（幂等，不二次执行），并移除该扩展注入的 CSS |
| `isDisposed(extId)` | 是否已清理 |

**自动清理时机**：`pagehide` / `beforeunload` 触发时，内核执行所有扩展的清理函数，
并派发 `ext-disposed`（单个扩展）与 `navext-unload`（全局）事件。bfcache 恢复（`pageshow`）时
重派 `init`，扩展可重建。

```js
var EXT_ID = 'my-ext';

var timer = setInterval(refresh, 30000);
var offCards = NavExt.on('cards-rendered', refresh);

NavExt.disposer(EXT_ID, function () {
  clearInterval(timer);
  offCards();
});

// 需要提前清理时（例如扩展自己判断已失效）：
// NavExt.dispose(EXT_ID);
```

> 服务端对称能力：`onDispose(ctx)` 钩子 + `ctx.timer` / `ctx.interval`（重载时内核自动清理）。
> 客户端此前缺的正是这个对称能力，v2.7.0 已补齐。

### 扩展配置

| 方法 | 说明 |
| --- | --- |
| `getExtMeta(id)` | 扩展完整元信息（含 config 和 schema） |
| `getExtConfig(id)` | 合并后的配置值 |
| `getExtConfigSchema(id)` | schema（用于渲染表单） |
| `getExtConfigField(id, key)` | 单个字段的值 |
| `getExtStats(id)` | 读取扩展统计（对应 stats()） |
| `setExtConfig(id, values)` | 异步写入（返回 Promise） |
| `resetExtConfig(id)` | 异步重置（返回 Promise） |

```js
var cfg = NavExt.getExtConfig('starred');
// { color: "#f59e0b", icon: "★" }

await NavExt.setExtConfig('starred', { color: '#10b981' });
await NavExt.resetExtConfig('starred');
```

### DOM 操作

所有 DOM 操作幂等——重复调用不会产生重复节点，查找不到卡片时返回 null 或 false，不抛异常。

| 方法 | 返回 |
| --- | --- |
| `getCardEl(path)` | 卡片 DOM 引用 |
| `getVisibleCards()` | 当前未被过滤掉的卡片数组 |
| `addCardIcon(path, url, opts)` | `HTMLImageElement` 或 `null` |
| `addCardBadge(path, text, color, opts)` | `HTMLSpanElement` 或 `null` |
| `addCardClass(path, cls)` | `true` / `false` |
| `removeCardClass(path, cls)` | `true` / `false` |
| `setCardAttribute(path, name, val)` | `true` / `false` |

**`addCardIcon` 的 opts**：

| 字段 | 说明 |
| --- | --- |
| `key` | 去重键，默认 `iconUrl` |
| `alt` / `title` | img 属性 |
| `size` | 边长（px） |

addCardBadge 的 opts：key 为去重键，默认 text。文字颜色按背景亮度自动选黑或白。

```js
NavExt.addCardIcon('docs/index.html', 'https://example.com/logo.png', {
  key: 'my-brand',
  size: 18,
});

NavExt.addCardBadge('docs/new.html', 'NEW', '#10b981');
```

### 事件总线

```js
// 订阅，返回取消订阅函数
var off = NavExt.on('cards-updated', function (cards) { ... });
off();

// 只触发一次
NavExt.once('init', function (payload) { ... });

// 自定义事件通信
NavExt.emit('my-ext:ready', { count: 42 });
```

**内置事件**：

| 事件 | 触发时机 | payload |
| --- | --- | --- |
| `init` | `DOMContentLoaded` 后 | `{ files, config }` |
| `cards-updated` | **推荐使用**。卡片索引变化时（初始化、搜索过滤后）| 可见卡片的 `HTMLElement[]` |
| `cards-rendered` | **已废弃**。与 `cards-updated` 同时触发，payload 相同，保留兼容 | 可见卡片的 `HTMLElement[]` |
| `ext-config-changed` | `setExtConfig` / `resetExtConfig` 成功后 | `{ id, values }` |

### 样式

```js
NavExt.injectCSS('my-ext', `
  .is-featured { border: 2px solid #4f6ef7; }
`);

NavExt.removeCSS('my-ext');
```

### 文件系统

**`NavExt.fs`** —— 项目目录，只读：

| 方法 | 返回 |
| --- | --- |
| `list(path, opts)` | `{ path, count, entries, truncated }`，`opts.all` 显示隐藏项 |
| `stat(path)` | `{ path, type, size, mtime, mime, isText, ... }` |
| `read(path, opts)` | `{ content, encoding, size, truncated, ... }`，`opts.encoding` 强制编码 |
| `exists(path)` | `boolean` |

NavExt.extFs(id) — 扩展目录，可读写：

```js
var fs = NavExt.extFs('starred');

await fs.read('starred.json');
await fs.write('starred.json', JSON.stringify(list), { mkdirp: true });
await fs.list('');
await fs.exists('cache.json');
await fs.mkdir('cache', { recursive: true });
await fs.delete('old.json');
await fs.delete('cache', { recursive: true });
await fs.rename('a.json', 'b.json');
```

所有方法返回 Promise，失败时抛出 Error，err.status 是 HTTP 状态码。

### data-ext-target 标记

页面结构元素都带 data-ext-target 属性，扩展用属性选择器精准定位，不受 DOM 结构变化影响。

| 标记 | 元素 | 附加 `data-ext-*` |
| --- | --- | --- |
| `body` | `<body>` | — |
| `header` / `header-top` | 头部 | — |
| `site-title` / `site-logo` / `site-desc` / `stats` | 头部元素 | — |
| `search` / `search-input` | 搜索框 | — |
| `main` | `<main>` | — |
| `section` | 目录分组 | `data-ext-dir` |
| `section-heading` / `section-title` / `section-path` / `section-count` / `section-desc` | 分组元素 | — |
| `grid` | 卡片容器 | — |
| `card` | 卡片 | 见下表 |
| `card-title` / `card-desc` / `card-path` / `card-meta` / `card-time` / `card-extras` | 卡片内部元素 | — |
| `noresult` / `empty` | 空态提示 | — |
| `footer` / `footer-text` / `footer-root` | 页脚 | — |
| `nav-data` / `core-script` | 脚本标签 | — |

卡片的 data-ext-* 字段：

```html
<a data-ext-target="card"
   data-ext-file="index.html"
   data-ext-path="docs/index.html"
   data-ext-dir="docs"
   data-ext-title="首页"
   data-ext-desc="项目总览与快速上手"
   data-ext-size="12345"
   data-ext-mtime="1716220800000"
   data-key="docs/index.html index.html 首页 项目总览与快速上手">
```

用法：

```js
// ✅ 精准命中
document.querySelectorAll('[data-ext-target="card"]')

// ✅ 直接读元数据，不用解析 DOM
document.querySelectorAll('[data-ext-target="card"]').forEach(function (card) {
  console.log(card.dataset.extFile, card.dataset.extPath, card.dataset.extTitle);
});
```

---

## 内置 UI 功能（v2.6）

导航页自带两个开箱即用的交互增强，**纯客户端、零依赖**，由内置客户端库提供，
无需任何扩展或配置。它们的状态都存在 `localStorage`，刷新后保持。

### 视图切换：按目录 / 按时间

搜索框下方有一组 `[按目录] [按时间]` 分段控件。

- **按目录**（默认）：保持服务端渲染的目录分组结构。
- **按时间**：把所有卡片按 `data-ext-mtime` **降序**平铺到一个网格容器中，
  并给每张卡片追加相对时间徽标（"3 天前"）。原目录分组外壳**保留在 DOM 中（仅隐藏）**，
  所以依赖 `[data-ext-target="section"]` 的扩展不会失效。

状态键：`localStorage.navext.view`（`dir` | `time`）。

```js
NavExt.ui.setView('time');   // 切到时间视图
NavExt.ui.getView();         // → 'dir' | 'time'
NavExt.on('view-changed', function (e) { console.log(e.view); });
```

实现要点：切换时通过移动 DOM 节点（而非重建）改变归属，随后调用
`NavExt.notifyCardsChanged()` 让扩展重新索引；同时会重放当前搜索词。

### 主题切换 + 自定义主题色

头部右侧「外观」按钮打开一个弹出面板：

| 项 | 说明 |
|---|---|
| 主题三档 | **跟随系统** / **亮色** / **暗色**，状态键 `localStorage.navext.theme` |
| 预设色板 | 8 个精选主题色，点击即应用 |
| 取色器 | `<input type="color">` 自定义任意颜色 |
| 恢复默认 | 清除自定义色，回落到 `server.json` 的 `site.accent`（未配置则用默认 `#4f6ef7`） |

主题色优先级：**`localStorage.navext.accent` > `server.json` 的 `site.accent` > 内置默认 `#4f6ef7`**。

实现要点：

- 「跟随系统」= 移除 `<html data-theme>`，由 `@media (prefers-color-scheme: dark)` 接管；
  显式亮/暗 = 设 `data-theme="light"` / `data-theme="dark"`，同时声明 `color-scheme`
  让滚动条与原生控件跟随。
- **无闪烁（FOUC）**：`<head>` 最前面有一段极短的同步脚本（`data-ext-target="theme-boot"`），
  在样式表之前读取 `localStorage` 并设好 `data-theme` 与 `--brand`，因此首帧即为正确主题。

```js
NavExt.ui.setTheme('dark');      // 'system' | 'light' | 'dark'
NavExt.ui.setAccent('#10a37f');  // 传 null 恢复默认
NavExt.ui.getTheme();            // → 'system'
NavExt.ui.getAccent();           // → '#4f6ef7'
NavExt.ui.presets;               // 预设色板 [{name, color}, ...]
NavExt.on('theme-changed', function (e) { console.log(e.theme); });
NavExt.on('accent-changed', function (e) { console.log(e.accent); });
```

> **扩展如何配合**：内置 UI 会随着 `cards-rendered` 幂等挂载。
> 扩展的自定义样式请使用 `var(--brand)` / `var(--brand-ring)` 等 CSS 变量，
> 这样在用户切换主题色时会自动跟随。查看 `[data-nx-view]`（`main` 上）可判断当前视图。

---

## 服务端 API

所有 API 在 /api/* 下，返回 JSON。受 server.json 的 api.* 控制。

GET /api/config

返回当前配置和扫描到的目录元数据。

```bash
curl http://localhost:3000/api/config
```

GET /api/extensions

返回所有扩展的列表和状态。

```json
{
  "count": 2,
  "enabled": true,
  "dir": ".js",
  "extensions": [
    {
      "id": "darkmode",
      "name": "暗色切换",
      "version": "1.0.0",
      "order": 10,
      "enabled": true,
      "hasConfig": true,
      "hasUserConfig": false
    }
  ]
}
```

GET /api/extensions/:id

返回单个扩展的详情，含 config 和 configSchema。

GET /api/extensions/:id/stats

返回扩展的运行统计。要求扩展实现 stats() 方法。

```bash
curl http://localhost:3000/api/extensions/my-ext/stats
```

响应：

```json
{
  "id": "my-ext",
  "stats": { "processed": 1234, "errors": 3, "uptime": 60000 }
}
```

未实现 stats() 的扩展返回 404。

POST /api/extensions/toggle

切换扩展的启用状态。修改 mod.json 的 enabled 字段并立即热重载。

```bash
# 显式设置
curl -X POST http://localhost:3000/api/extensions/toggle \
  -H 'Content-Type: application/json' \
  -d '{"id":"darkmode","enabled":false}'

# 翻转当前状态
curl -X POST http://localhost:3000/api/extensions/toggle \
  -H 'Content-Type: application/json' \
  -d '{"id":"darkmode","toggle":true}'
```

enabled 和 toggle 必须提供一个。

GET / POST / DELETE /api/extensions/:id/config

读取、更新、重置扩展配置。

```bash
# 读取（含 schema）
curl http://localhost:3000/api/extensions/starred/config

# 更新（合并写入，只更新请求体里出现的字段）
curl -X POST http://localhost:3000/api/extensions/starred/config \
  -H 'Content-Type: application/json' \
  -d '{"values":{"color":"#10b981","icon":"⭐"}}'

# 重置
curl -X DELETE http://localhost:3000/api/extensions/starred/config
```

响应字段：

字段 说明
schema 声明的字段列表，用于渲染表单
values 默认值 + 用户覆盖合并后的实际值
userValues 只包含用户显式覆盖的部分
hasUserValues 是否有任何用户覆盖

### 项目 FS（只读）

```bash
# 列目录（all=1 显示隐藏项）
curl 'http://localhost:3000/api/fs/list?path='
curl 'http://localhost:3000/api/fs/list?path=docs&all=1'

# 文件信息
curl 'http://localhost:3000/api/fs/stat?path=index.html'

# 读文件（自动判断编码，或强制指定）
curl 'http://localhost:3000/api/fs/read?path=README.md'
curl 'http://localhost:3000/api/fs/read?path=logo.png&encoding=base64'
```

read 行为：

· 文本扩展名（.html / .js / .md / .json / .css / .svg 等）默认 utf8
· 二进制默认 base64
· 超过 maxReadSize 时截断并设 truncated: true
· utf8 解码遇到非法字节时自动回退 base64

### 扩展 FS（读写）

/api/extensions/:id/fs/* 语义与项目 FS 一致，但：

· 根目录是 .js/<id>/
· 允许列出隐藏文件
· 有写操作

```bash
# 列出
curl 'http://localhost:3000/api/extensions/starred/fs/list?path='

# 读取
curl 'http://localhost:3000/api/extensions/starred/fs/read?path=starred.json'

# 写入（自动创建父目录，除非 mkdirp: false）
curl -X POST http://localhost:3000/api/extensions/starred/fs/write \
  -H 'Content-Type: application/json' \
  -d '{"path":"starred.json","content":"[\"index.html\"]","encoding":"utf8"}'

# 创建目录
curl -X POST http://localhost:3000/api/extensions/starred/fs/mkdir \
  -H 'Content-Type: application/json' \
  -d '{"path":"cache/2024","recursive":true}'

# 重命名（目标必须不存在，否则 409）
curl -X POST http://localhost:3000/api/extensions/starred/fs/rename \
  -H 'Content-Type: application/json' \
  -d '{"from":"old.json","to":"archive/old.json"}'

# 删除（非空目录加 recursive=1）
curl -X DELETE 'http://localhost:3000/api/extensions/starred/fs/delete?path=old.json'
curl -X DELETE 'http://localhost:3000/api/extensions/starred/fs/delete?path=cache&recursive=1'
```

### 错误响应

| 状态码 | 场景 |
| --- | --- |
| `400` | 参数错误、路径越界、目标冲突 |
| `403` | 对应的开关关闭，或路径越界 |
| `404` | 资源不存在 |
| `405` | 方法不支持 |
| `409` | 重命名目标已存在 |
| `413` | 请求体或写入内容超过限制 |

/api/* 路由在扩展的 onRequest 钩子之前处理。扩展拿不到 /api/ 开头的请求，避免误拦截。

---

## 自定义主页

默认情况下，`/` 返回自动生成的导航页。如果项目里已经有一个现成的 HTML 想当主页，用 `server.json` 的 `home` 字段把它顶上去。

### 最小配置

```json
{
  "home": {
    "enabled": true,
    "file": "home.html",
    "applyExtensions": true
  }
}
```

- `file` 相对 `root` 解析，路径越界会被拒绝
- 文件不存在或不可读时，自动回退到导航页，终端打印警告
- 支持热重载：改 `server.json` 或 `home.html` 后刷新页面即生效

### 扩展注入的三种模式

| enabled | applyExtensions | 行为 |
| --- | --- | --- |
| `false` | — | 走默认逻辑，自动生成导航页 |
| `true` | `false` | 原样返回 `home.html`，不注入任何东西 |
| `true` | `true` | 注入客户端数据 + 扩展的 styles / scripts / head / header / footer |

`applyExtensions = true` 时的注入位置：

- **`</head>` 之前** — `__NAV_DATA__` 数据脚本、`NavExt` 客户端库、扩展 styles、扩展 head
- **`<body>` 标签之后** — 扩展 header
- **`</body>` 之前** — 扩展 footer、扩展 scripts

如果自定义主页缺少标准标签，会降级处理：

- 没有 `</head>` 但有 `<body>` → 在 `<body>` 前插一个 `<head>`
- 完全没有 `<body>` → 全部注入内容拼接到 HTML 前面

### 让扩展作用于自定义主页

扩展通过 `data-ext-target` 标记定位元素。自定义主页里加上对应标记，扩展就能找到它：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>我的主页</title>
</head>
<body data-ext-target="body">
  <header data-ext-target="header">
    <div class="top" data-ext-target="header-top">
      <h1 data-ext-target="site-title">你好</h1>
    </div>
  </header>

  <main class="wrap" data-ext-target="main">
    <div class="grid" data-ext-target="grid"></div>
  </main>

  <footer data-ext-target="footer"></footer>
</body>
</html>
```

**重要**：如果没有 `data-ext-target="card"`，扩展里调用 `addCardIcon` / `addCardBadge` 会静默返回 `null`，不会报错——这是预期行为。

### 面板类扩展的注意事项

如果扩展的客户端脚本订阅了卡片事件（`cards-updated` / `cards-rendered`），在自定义主页里可能不会触发——首页没有卡片列表。**改用 `init` 事件更稳**：

```js
// 推荐
NavExt.on('init', bindPanel);

// 只在有卡片列表的场景才需要
NavExt.on('cards-updated', bindPanel);
```

### 多主页路由（v1.8）

一个项目里想同时托管多个"站"——`/docs` 一个主页、`/blog` 另一个、生产环境和开发环境各自一份——用 `home.routes` 数组声明：

```json
{
  "home": {
    "enabled": true,
    "applyExtensions": true,
    "file": "home.html",
    "routes": [
      { "match": { "path": "/docs" }, "file": "docs.html" },
      { "match": { "path": "/blog" }, "file": "blog.html", "applyExtensions": false },
      { "match": { "host": "docs.local" }, "file": "docs.html" },
      { "match": { "env": "NODE_ENV", "value": "dev" }, "file": "dev.html" }
    ]
  }
}
```

匹配逻辑：

1. 按 `routes` 数组**顺序**遍历，第一个命中的生效
2. 都不命中 → 用顶层 `home.file` 兜底
3. 其他未匹配路径 → 交还静态文件处理（不兜底）
3. 顶层也没设 → 自动生成导航页

### 匹配条件

每条路由的 `match` 支持三种条件，可以组合：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | **精确匹配**请求路径。`/docs` 匹配 `/docs` 和 `/docs/`，不匹配 `/docs/guide.html` |
| `host` | string \| string[] | 匹配 `Host` 头（去掉端口号），如 `docs.local` |
| `env` + `value` | string | 匹配环境变量。`value` 是期望值（字符串比较） |

多个条件同时存在时取 **AND**。省略 `match` 则总是命中（放在最后相当于兜底路由）。

### `path` 为什么精确匹配

如果是前缀匹配，`/docs` 会把 `/docs/guide.html` 也吞掉——静态文件就访问不到了。精确匹配让"自定义主页接管这个路径，子路径照常走静态文件"成为可能。

兜底 `home.file` 也只对 `/` 生效——`/docs.html` 这类未显式声明的路径不会被重写，仍走静态文件。

### 环境变量的边界

`env` / `value` 在**进程启动时**读取一次。改了环境变量要**重启服务**才生效——这一项不热重载。

```bash
NODE_ENV=production node server.js
NODE_ENV=development node server.js
```

其他字段（`path` / `host` / `file` / `applyExtensions`）都支持热重载，改完刷新页面即生效。

### `applyExtensions` 的继承

- route 里显式写了 → 用 route 的
- route 里没写 → 继承顶层 `home.applyExtensions`

这样你可以让大多数路由共用同一个策略，个别例外单独声明。

### 匹配优先级

整个请求分发链（详见 [请求处理链](#请求处理链)）：

```text
/api/*                    → API 路由（最高优先级）
扩展 onRequest 钩子        → 编程式拦截（任意 HTTP 方法）
home routes               → 用户显式声明的多主页
/ 和 /<path>             → 首页导航页 / 静态文件
```

**扩展 onRequest 先于 home 路由**：扩展能拦截 `/docs`、`/blog` 这类被 home 路由接管的路径。想放行时返回 `null` 即可，请求会继续走 home 路由。

如果你不希望某个扩展盖掉多主页，用 `js.list.json` 的 scope 把它限制在非主页路径下：

```json
{ "id": "my-ext", "exclude": ["/docs", "/blog"] }
```
### 启动日志

服务启动时会打印所有路由：

```
  自定义主页 3 个路由
    path=/docs                     → docs.html  [扩展:继承]
    path=/blog                     → blog.html  [扩展:关]
    兜底                            → home.html
```

### 完整示例

```bash
# 建两个主页文件
cat > docs.html << 'EOF'
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>文档站</title></head>
<body data-ext-target="body">
  <h1>文档首页</h1>
</body></html>
EOF

cat > blog.html << 'EOF'
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>博客</title></head>
<body><h1>博客首页</h1></body></html>
EOF
```

`server.json`：

```json
{
  "home": {
    "enabled": true,
    "applyExtensions": true,
    "file": "home.html",
    "routes": [
      { "match": { "path": "/docs" }, "file": "docs.html" },
      { "match": { "path": "/blog" }, "file": "blog.html", "applyExtensions": false }
    ]
  }
}
```

验证：

```bash
curl -s http://localhost:3000/       | grep -o '<h1>[^<]*</h1>'
# <h1>你好，这是我的自定义主页</h1>

curl -s http://localhost:3000/docs   | grep -o '<h1>[^<]*</h1>'
# <h1>文档首页</h1>

curl -s http://localhost:3000/blog   | grep -o '<h1>[^<]*</h1>'
# <h1>博客首页</h1>

# 子路径走静态文件，不被 home 路由吃掉
curl -s http://localhost:3000/docs/guide.html | head -3
```

### 兼容性

v1.7 的 `home.enabled` / `home.file` / `home.applyExtensions` **不变**，作为兜底路由。不写 `routes` 时行为完全等同 v1.7。`file` 路径仍受 `fsResolveUnder` 校验，越界直接拒绝。

### 快速切换

```bash
# 切到自定义主页
node -e 'const fs=require("fs");const p="server.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.home.enabled=true;fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")'

# 切回导航页
node -e 'const f=require("fs");const p="server.json";const c=JSON.parse(f.readFileSync(p,"utf8"));c.home.enabled=false;f.writeFileSync(p,JSON.stringify(c,null,2)+"\n")'
```

保存后刷新浏览器即可，**不需要重启服务**。

---

## 子页扩展策略

扩展可以用 `scope` 声明自己只在某些路径生效（见 [扩展作用域](#扩展作用域)）。子页扩展策略是从**页面侧**做的另一层控制——页面可以声明"我不加载哪些扩展"，和扩展的 scope 独立生效。

两层机制的正交关系：

| 机制 | 由谁声明 | 表达 |
| --- | --- | --- |
| `scope` | 扩展自己（`js.list.json`） | "我只在这些路径生效" |
| `jsx.json` | 页面自己（目录下） | "我不加载这些扩展" |

一个扩展要生效，**必须同时满足两者**。

### 配置文件

在每个目录下可放一个 `jsx.json`：

```json
{
  "disable": ["arch-diagram", "copy-link"]
}
```

字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enable` | string[] | **白名单**。存在时只加载列表内的扩展 |
| `disable` | string[] | **黑名单**。列表内的扩展不加载 |

两个都可以有。未在 `enable` 中列出，**或**在 `disable` 中列出 → 不加载。

### 约束叠加

从 `root` 到请求路径的每一层目录，逐层应用。**子层不能"解锁"父层的禁用**。

**`enable` 也是逐层收窄**：父层的白名单会先约束一次，子层再加一层约束。举例，父层 `enable: ["A", "B", "C"]`，子层 `enable: ["A", "B"]`，则：

- `A` / `B`：两层都通过 → 加载
- `C`：子层白名单没有它 → 不加载
- 其他扩展：父层白名单没有它 → 不加载

子层只能进一步缩小范围，不能把父层禁掉的扩展重新启用。

举例：

```text
root/
├── jsx.json                    { "disable": ["ext-manager"] }
└── docs/
    └── jsx.json                { "disable": ["arch-diagram", "copy-link"] }
```

访问 `/docs` 时的累积结果：

- `ext-manager` 被根 `jsx.json` 禁
- `arch-diagram` / `copy-link` 被 `docs/jsx.json` 禁
- 其余扩展正常加载

访问 `/` 时只应用根 `jsx.json`——只有 `ext-manager` 被禁。

### 路径映射

请求 `/docs/api` → 依次检查：

1. `root/jsx.json`
2. `root/docs/jsx.json`
3. `root/docs/api/jsx.json`

遇到文件名（如 `/docs/guide.html`）时停止——不检查文件同名的"目录"。

### 影响范围

和扩展 scope 一样，影响 `onHtml` / `onRequest` / 注入（styles / scripts / head / header / footer）。

`onInit` 和 `onFiles` **始终**执行——它们负责全局初始化和文件列表处理，与具体页面无关。

### 禁用配置

不想用这个机制时，`server.json` 里：

```json
{
  "pageExt": {
    "enabled": false
  }
}
```

也可以改文件名（默认 `jsx.json`）：

```json
{
  "pageExt": {
    "file": "page-ext.json"
  }
}
```

### 热重载

`jsx.json` 改动后刷新页面即生效——策略指纹参与 HTML 缓存失效判断，缓存里的旧版本会被自动丢弃。

---
### 扩展依赖（requires）

扩展之间可以有依赖。在 `mod.json` 里声明：

```json
{
  "name": "Theme",
  "order": 100,
  "requires": ["ui-base", "icon-set"]
}
```

**加载规则**：

- **被依赖者先加载**——服务端做拓扑排序，`requires` 列表里的扩展一定在依赖者之前
- **缺依赖 → 跳过该扩展**——`requires` 里写了不存在的扩展 ID，只警告并跳过，不影响其他扩展
- **循环依赖 → 跳过环上所有扩展**——A 依赖 B、B 依赖 A，会警告并跳过整个环——因为单独跳一个的话，另一个的依赖仍然没满足

**与 `order` 的关系**：

- `order` 只决定**没有依赖关系**的扩展之间的相对顺序
- `requires` 优先级更高——无论 order 多少，被依赖者总在前面
- 多个同级依赖按各自 `order` 排

**与 `jsx.json` 的关系**：

依赖检查在**加载期**（启动时、扩展目录变化时），`jsx.json` 在**请求期**。两者独立：

- 加载期：看 `js.list.json` 和 `mod.json.enabled`，不看 `jsx.json`
- 请求期：看 `jsx.json` 的策略，`enable` 白名单可能导致依赖者与依赖都不出现在当前页面

也就是说：`jsx.json` 禁用 `ui-base` 时，依赖它的 `theme` 在**加载期不会报错**（两者都存在于列表），但在**请求期**页面里可能只看到 `theme` 的注入而没有 `ui-base`。这种场景由扩展作者自己处理——比如 `theme` 检测不到 `ui-base` 时降级。

### 扩展统计（stats）

扩展可以暴露统计数据，供运维/排障查看：

```js
let processed = 0;
let errors = 0;

module.exports = {
  async onRequest(req, url, ctx) {
    processed++;
    try { /* ... */ }
    catch (e) { errors++; throw e; }
  },

  // 必须同步 —— 不支持 async
  stats(ctx) {
    return { processed, errors, uptime: Date.now() - START_AT };
  },
};
```

客户端请求：

```bash
curl http://localhost:3000/api/extensions/my-ext/stats
```

响应：

```json
{
  "id": "my-ext",
  "stats": { "processed": 1234, "errors": 3, "uptime": 60000 }
}
```

**未实现 `stats()`** 的扩展访问此接口 → 404。

**`stats()` 抛异常** → 返回 500，响应体是 `{"error":"stats() 出错: ..."}`。统计失败不影响主服务。

**`stats()` 必须是同步函数**——不支持 `async`。

返回 Promise 会被拒绝并返回 500（`"stats() 必须是同步函数（不支持 async）"`）。

理由：`stats()` 不在请求钩子链里，没有超时保护。异步的 `stats()` 如果内部卡住（await 一个永不 resolve 的 Promise），请求会永久挂起。强制同步能保证它总是快速返回。

需要统计异步数据？在扩展内部维护计数器/缓存，让 `stats()` 从内存里同步读取。

### ctx.fetch / ctx.timer

扩展内常用的两类副作用——网络请求和定时任务——用 `ctx` 的方法比裸 `fetch` / `setInterval` 更安全：**扩展热重载时自动清理**，不会泄漏。

#### ctx.fetch(url, opts)

```js
module.exports = {
  async onRequest(req, url, ctx) {
    const res = await ctx.fetch("https://api.example.com/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: 1 }),
      timeout: 5000,   // 覆盖默认（extensions.fetchTimeout）
    });
    const data = await res.json();
    return { status: 200, type: "application/json", body: JSON.stringify(data) };
  },
};
```

| 行为 | 说明 |
| --- | --- |
| 默认超时 | `extensions.fetchTimeout`（默认 30000ms） |
| 覆盖超时 | `opts.timeout` |
| 超时错误 | `err.code === 'EXT_FETCH_ABORT'` |
| 扩展重载 | **挂起的请求自动 abort** |
| 运行时依赖 | Node 18+ 的 `globalThis.fetch`；更低版本返回 `NO_FETCH` 错误 |
| `opts.signal` | Node 20.3+ 用 `AbortSignal.any`；更低版本走 fallback（手动监听 userSignal，随请求结束或扩展重载释放） |

**环境要求**：`ctx.fetch` 依赖 Node 18+ 的 `globalThis.fetch`。

Node 14–17 上，服务本身能跑（其他功能不受影响），但扩展调 `ctx.fetch` 会 **reject**：

```js
// Node 14-17 下：
try {
  await ctx.fetch(url);
} catch (err) {
  if (err.code === 'NO_FETCH') {
    // 当前环境不支持 —— 降级或跳过
  }
}
```

需要用 `ctx.fetch` 时升级到 Node 18+。

#### ctx.timer / ctx.interval / ctx.clearTimer

```js
module.exports = {
  onInit(ctx) {
    // 5 秒后跑一次
    ctx.timer(() => ctx.log("5s passed"), 5000);

    // 每 10 秒跑一次
    const h = ctx.interval(() => ctx.log("tick"), 10000);

    // 也可以手动停掉
    // ctx.clearTimer(h);
  },
};
```

| 方法 | 说明 |
| --- | --- |
| `ctx.timer(fn, ms, ...args)` | 单次定时器 |
| `ctx.interval(fn, ms, ...args)` | 循环定时器 |
| `ctx.clearTimer(handle)` | 手动清理 |

**返回值**：`ctx.timer` 和 `ctx.interval` 返回一个自定义对象 `{ id, kind, dispose }`——**不是** Node 的 `Timeout` 对象，也不是数字。

要清理时把这个对象整个传回：

```js
const h = ctx.interval(() => { /* ... */ }, 5000);
ctx.clearTimer(h);   // 传入整个对象
```

**扩展重载时全部自动清理**——不需要手动 `clearInterval`。

**回调抛异常**：打日志 + 触发扩展自己的 `onError(err, ctx)`，`ctx.hook` 是 `'timer'` 或 `'interval'`。

---

## 打包与分发

开发时两个文件：server.js 负责服务端逻辑，.navext.client.js 是浏览器端库。build.js 负责把项目打包成可分发的单文件。

### 三种打包形态

  node build.js                产物 server.dist.js
    只合并服务端和客户端库，其他文件（HTML / 扩展 / 资源）保持独立

  node build.js --pack         产物 app.tar.gz
    包含 server.dist.js + 所有 HTML / 资源 / 扩展 + start.sh

  node build.js --pack --sfx   产物 app.sh
    把 tar.gz 塞进一个自解压 shell 脚本，单个文件即可分发

### 打包内容

默认递归收集项目里所有能用于渲染页面的文件：

  · 网页        .html / .htm
  · 样式脚本    .css / .js / .mjs / .cjs
  · 数据        .json / .xml / .txt / .csv
  · 文档        .md / .markdown
  · 图片        .svg / .png / .jpg / .jpeg / .gif / .webp / .avif / .ico / .bmp
  · 字体        .woff / .woff2 / .ttf / .otf / .eot
  · 媒体        .mp3 / .wav / .ogg / .mp4 / .webm
  · 其他        .pdf / .wasm / .yaml / .yml
  · 扩展目录    .js/（连同所有文件，除非加 --no-extensions）
  · 配置文件    server.json / html.json / README.md

自动排除：

  · 开发脚本    server.js / .navext.client.js / build.js / cli.js
  · 依赖目录    node_modules / .git / .svn / .hg
  · 临时目录    .tmp / .cache / __pycache__ / .idea / .vscode
  · 备份文件    *.bak / *.orig / *.swp / *~
  · 打包产物    app.sh / app.tar.gz / server.dist.js

查看实际内容：

  node build.js --pack --list

按类型打印所有文件，确认打包范围符合预期后再真正执行。

### 生成的 start.sh

app.tar.gz 和 app.sh 里都带一个 start.sh：

  #!/bin/sh
  # 一键启动脚本
  # 用法: ./start.sh [--port 8080] [其他 node server.dist.js 参数]
  cd "$(dirname "$0")"
  exec node server.dist.js "$@"

解压后 ./start.sh 即可运行，参数直接转给 server.dist.js。

### 自解压 app.sh 的用法

单文件，内含 base64 编码的 tar.gz。用法：

  chmod +x app.sh

  ./app.sh                            # 解压到临时目录并启动
  ./app.sh --keep ./myapp             # 解压到 ./myapp，保留文件
  ./app.sh --extract ./myapp          # 只解压，不启动
  ./app.sh --port 8080                # 传给 server 的参数

原理：脚本尾部是 base64 归档，前面有个标记行 __SFX_ARCHIVE_BELOW__。运行时会：

  1. 用 grep 定位标记行
  2. 从标记后一行开始，tail 读取剩余内容
  3. base64 -d → gunzip → tar -xf 解压
  4. 进入解压后的 app/ 目录，exec node server.dist.js

依赖：任何 POSIX shell + base64 + gzip + tar。macOS / Linux / Termux 默认都有。

### 用户侧拿到的目录结构

解压后：

  app/
  ├── server.dist.js      ← 服务端 + 客户端合一
  ├── start.sh            ← 一键启动
  ├── README.md
  ├── server.json         ← 如果有
  ├── html.json           ← 如果有
  ├── index.html          ← 示例 HTML
  ├── docs/               ← 子目录 HTML 和资源
  │   ├── guide.html
  │   └── logo.png
  └── .js/                ← 扩展
      ├── js.list.json
      └── darkmode/

### cli.js 的构建命令

cli.js 提供同样的能力，加上一键启动：

  node cli.js build        等价于 node build.js
  node cli.js pack         等价于 node build.js --pack
  node cli.js sfx          等价于 node build.js --pack --sfx
  node cli.js start        先 build 再启动 server.dist.js
  node cli.js dev          直接 node server.js（开发态）

start 和 dev 都转发 SIGINT / SIGTERM，Ctrl+C 能正常停止子进程。

用 -- 分隔符传参给 server：

  node cli.js start -- --port 8080
  node cli.js dev -- --port 8080

### 工作流

  编辑 server.js / .navext.client.js / 任意 HTML / .js 扩展
          │
          ▼
    node server.js ──► 刷新浏览器 ──► 验证
                                          │
                                          ▼
                                node build.js --pack --sfx
                                          │
                                          ▼
                                       app.sh ──► 分发

关键点：改了源文件后 app.sh 不会自动更新。要重跑 node build.js --pack --sfx。

### 验证打包产物

  sh -n app.sh                        # shell 语法自检

  node build.js --pack --list         # 列出内容

  mkdir -p ~/sfx-test
  cp app.sh ~/sfx-test/
  cd ~/sfx-test
  chmod +x app.sh
  ./app.sh --extract ./unpacked
  find unpacked/app -type f | sort    # 看解压出的文件

  ./app.sh --port 3999                # 启动

另开会话验证：

  curl -s http://localhost:3999 | grep -c 'window.NavExt'    # >= 1
  curl -s http://localhost:3999 | grep -c 'data-ext-target'  # >= 20

### 打包相关的选项

  --pack              打包成 tar.gz
  --sfx               打包成自解压 .sh（隐含 --pack）
  --no-extensions     不带 .js/ 扩展目录
  --list              打包前打印文件清单
  -o, --output <file> 自定义输出路径

### 关于 build.js 内部

server.js 里有一段标记块：

  /* __NAVEXT_LOADER_START__ */
  function loadNavExtClient() {
    // 读取 .navext.client.js
  }
  /* __NAVEXT_LOADER_END__ */

build.js 找到这段标记，把它替换成内联的字符串常量：

  /* 已内联 .navext.client.js */
  const NAVEXT_CLIENT_INLINE = "(function () { ... })();";

  function loadNavExtClient() {
    return NAVEXT_CLIENT_INLINE;
  }

除了这段标记内的代码，server.dist.js 和 server.js 完全一样——逻辑、行为、外部依赖（server.json / html.json / .js/ 扩展目录）都不变。改动的只是客户端库的来源。

tar 格式由 build.js 手写（不用系统 tar 命令），只依赖 Node 内置的 zlib 做 gzip。tar 支持普通文件和目录，不支持符号链接、硬链接、稀疏文件——打包这个场景不需要。

---

## 单文件分发（server.dist.js）

本节只讲 node build.js 不带参数时的行为——把客户端库内联进 server.js，其他文件保持独立。需要完整打包见上一节。

开发时两个文件：server.js 负责服务端逻辑，.navext.client.js 是浏览器端库。

server.js 里有一段标记块，用 loadNavExtClient() 从外部文件读客户端库：

```js
/* __NAVEXT_LOADER_START__ */
function loadNavExtClient() {
  // 读取 .navext.client.js
}
/* __NAVEXT_LOADER_END__ */
```

build.js 找到这段标记，把它替换成内联的字符串常量，写出 server.dist.js：

```js
/* 已内联 .navext.client.js */
const NAVEXT_CLIENT_INLINE = "(function () { ... })();";

function loadNavExtClient() {
  return NAVEXT_CLIENT_INLINE;
}
```

除了这段标记内的代码，server.dist.js 和 server.js 完全一样——逻辑、行为、外部依赖（server.json / html.json / .js/ 扩展目录）都不变。改动的只是客户端库的来源：从"读外部文件"变成"内联常量"。

### build.js 的实现

完整的源码见项目里的 `build.js`。核心逻辑就三步：

1. 读取 `server.js`，定位 `/* __NAVEXT_LOADER_START__ */` 到 `/* __NAVEXT_LOADER_END__ */` 之间的标记块
2. 读取 `.navext.client.js`，用 `JSON.stringify` 转义成字符串，构造 `const NAVEXT_CLIENT_INLINE = "..."`
3. 把标记块整段替换成内联常量 + 一个返回常量的 `loadNavExtClient()` 函数，写出 `server.dist.js`

打包模式（`--pack` / `--sfx`）在此之上继续：递归收集 HTML / 资源 / 扩展，打成 tar.gz，可选再包装成自解压 `.sh`。

---
### 用法

```bash
# 开发
node server.js                 # 改 .navext.client.js 刷新即生效

# 合并成单文件
node build.js                  # 生成 server.dist.js

# 或指定输出路径
node build.js -o ./dist/server.js
```

### 工作流

```text
编辑 server.js / .navext.client.js
        │
        ▼
  node server.js ──► 刷新浏览器 ──► 验证
                                        │
                                        ▼
                                 node build.js
                                        │
                                        ▼
                                  server.dist.js ──► 分发
```

关键点：改了源文件后，server.dist.js 不会自动更新。要重跑 node build.js。

### 验证单文件版本

模拟"没有 .navext.client.js"的环境：

```bash
mkdir -p ~/dist-test
cp server.dist.js ~/dist-test/
cd ~/dist-test
ls -la                         # 应该只有 server.dist.js 一个文件

node server.dist.js --port 3999
```

另开一个会话：

```bash
curl -s http://localhost:3999 | grep -c 'window.NavExt'
# 应该 >= 1
```

### 为什么用 JSON.stringify

客户端库里有反引号、${}、反斜杠、换行等特殊字符。手工拼接几乎必然踩坑。JSON.stringify 一次性处理所有转义。

</script> 不会被 JSON.stringify 转义。当前客户端库是我们自己维护的，不会写这个字符串；如果将来需要在库中包含 </script> 字面量，得自己在 buildHtml 里对客户端库的注入套一层 safeScript()。

源文件改动后 dist 不同步？

正常，dist 是快照。想让它自己提示：

```js
if (path.basename(process.argv[1]) === 'server.dist.js') {
  console.log('  ℹ  这是单文件版本，源文件改动不会同步进来');
}
```

### 回滚

删掉 dist 即可，源文件还在：

```bash
rm server.dist.js
node server.js
```

---

## 热重载机制

服务端自动检测变更，无需重启。

### 立即生效（刷新页面即可）

· ✅ server.json 的所有 site.* 字段
· ✅ server.json 的 root、depth、ignoreDirs、ignoreFiles、htmlExtensions
· ✅ server.json 的 extensions.* 和 api.*
· ✅ 所有 html.json 文件
· ✅ .js/ 扩展目录下的任意文件（含 index.js 依赖的本地模块）
· ✅ .navext.client.js 客户端库（开发态）
· ✅ 新增 / 删除 HTML 文件
· ✅ 通过 API 修改的扩展配置

### 需要重启

· ⚠️ port —— 已绑定到监听 socket
· ⚠️ host —— 同上
· ⚠️ home.routes[].match.env —— 启动时读取一次

变更这两项时，终端会明确标注 (需重启)。

### 工作原理

| 对象 | 检测方式 | 缓存 |
| --- | --- | --- |
| `server.json` | 每次请求 `stat`，`mtime + size` 指纹 | 指纹未变直接用旧值 |
| 扩展目录 | 每 300ms 递归扫描全部文件指纹 | 指纹未变直接返回旧列表 |
| HTML 目录 | 绑定配置版本 + 扩展版本 | 400ms TTL + 版本校验 |
| `.navext.client.js` | `mtime + size` 指纹 | 指纹未变复用缓存 |

模块缓存：扩展目录的 index.js 及其 require 的本地模块，在一次加载会话内共享实例；扩展指纹变化时整体重建缓存，热重载生效。

### 终端日志示例

```text
♻  [14:32:07] server.json 已重新加载
       site.title: "旧标题" → "项目文档中心"
       site.accent: "(默认)" → "#4f6ef7"
       → 刷新浏览器即可看到最新效果

♻  [14:32:15] 扩展已重新加载：2 个 → darkmode, toc
```

### 强制刷新

想立即看到效果而不等缓存：

```text
http://localhost:3000/?fresh=1
```

---

### HTML 渲染缓存

默认关闭。导航页每次请求都会重新渲染——页面不多时无所谓；页面固定且访问频繁时，可以开启缓存把响应压到纯内存读取。

在 `server.json` 开启：

```json
{
  "cache": {
    "html": true
  }
}
```

**缓存键**：`Host` 头 + 请求路径。

不同 Host 的同名路径会各存一份——`home.routes` 的 host 匹配（如 `docs.local` / `blog.local` 都请求 `/`）不会串缓存。
**完整字段**：

| 字段 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `html` | `false` | — | 是否开启 HTML 渲染缓存 |
| `extTtl` | `1000` | 100 – 60000 | 扩展目录指纹扫描间隔（毫秒）|
| `scanTtl` | `400` | 100 – 60000 | HTML 目录扫描缓存（毫秒）|
| `cfgTtl` | `1000` | 0 – 60000 | `server.json` 检测间隔（毫秒）|

**TTL 的取舍**：数值越大，RPS 越高，但热重载生效越慢——

- `extTtl`：改扩展文件后最多延迟这么久才重载
- `scanTtl`：新增/删除 HTML 后最多延迟这么久才刷新
- `cfgTtl`：改 `server.json` 后最多延迟这么久才生效

本地开发用默认值即可；高 QPS 场景可以把 `extTtl` / `cfgTtl` 提到 5000–10000。

**失效**：`server.json` 或扩展目录一变，缓存整体清空、下次请求重算。

**代价**：每个路径在内存里存一份 HTML 字符串。20 个页面大约几 MB——比起每次渲染的开销，可以忽略。

**绕过**：URL 加 `?fresh=1` 强制重新渲染，绕过缓存（用于调试）。

**不影响**：静态文件、API 接口、JSON 列表（`/?format=json`）都走原路径，不经过这个缓存。

---
## 命令行参数

```text
用法: node server.js [根目录] [端口] [选项]

选项:
  -r, --root <dir>     扫描的根目录 (默认: 当前工作目录)
  -p, --port <num>     监听端口 (默认: server.json 中的 port 或 3000)
      --host <addr>    监听地址 (默认: 0.0.0.0)
      --depth <num>    最大递归深度 (默认: 8)
  -c, --config <file>  指定配置文件 (默认: ./server.json)
  -h, --help           显示帮助
```

也支持 --root=./docs 这种等号写法。

配置优先级：

```text
命令行参数  >  server.json  >  内置默认值
```

根目录的解析顺序：

```text
命令行 --root  >  server.json 中的 root  >  当前工作目录
```

例如 server.json 中 port 是 3000，执行 node server.js --port 8080 会以 8080 启动。

---

## 请求处理链

一个请求进来后的处理顺序：

```text
请求
  │
  ├─ 解析 URL / pathname
  │
  ├─ 路径是 /api/* ?
  │     └─ 是 → 方法白名单（GET / HEAD / POST / DELETE）
  │           ├─ 通过 → handleApi
  │           └─ 拒绝 → 405
  │
  ├─ 扩展 onRequest 钩子（任意 HTTP 方法都能进）
  │     └─ 命中 → 直接返回扩展的响应
  │
  ├─ 方法不是 GET / HEAD ?
  │     └─ 是 → 405（静态文件和导航页只接受 GET / HEAD）
  │
  ├─ home.routes 匹配 ?
  │     └─ 是 → 自定义主页 / JSON
  │
  ├─ 路径是 / 或空 ?
  │     └─ 是 → 导航页 / JSON
  │
  └─ 静态文件
```

**方法检查的位置**：不在入口一刀切，而是下沉到各分支——

- **API 边界**：只接受 `GET` / `HEAD` / `POST` / `DELETE`。`PUT` / `PATCH` / `OPTIONS` 返回 405
- **静态文件边界**：扩展都没接之后，只接受 `GET` / `HEAD`
- **扩展 onRequest**：位置在这两处之间，因此能收到任意 HTTP 方法

这意味着扩展可以用 `onRequest` 处理 `POST` / `PUT` / `PATCH` / `OPTIONS`——比如自建表单接口、Webhook 接收器、CORS 预检处理。

**示例**：一个接收 POST 的扩展

```js
// .js/my-api/index.js
module.exports = {
  onRequest(req, url) {
    if (url.pathname !== '/biz/submit') return null;
    if (req.method !== 'POST') {
      return { status: 405, body: "Use POST" };
    }

    // 收集请求体
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: 200,
          type: "application/json",
          body: JSON.stringify({ received: body, bytes: body.length }),
        });
      });
    });
  },
};
```

**注意**：如果扩展返回 `null` 或什么都不返回，请求会继续往下走——方法不是 GET/HEAD 时最终会被 405 拦住。也就是说，对于 **非 `/api/` 开头的路径**，`onRequest` 是唯一能接住写方法的地方。

---
## URL 路由

| 路径 | 说明 |
| --- | --- |
| `/` | 导航页，或 `home` 配置的自定义主页 |
| `/?format=json` | JSON 格式的文件列表 + 配置 + 扩展信息（默认不含 `hidden` 项，附 `hiddenCount`） |
| `/?format=json&hidden=1` | 同上，但包含 `html.json` 中标记为隐藏的条目 |
| `/?fresh=1` | 强制重新扫描，绕过缓存 |
| `/<path>/<file>.html` | 直接访问静态文件（隐藏页同样可访问，返回 200） |
| `/<path>/` | 目录访问，自动尝试 `index.html` |

---

## 安全边界

| 层 | 机制 |
| --- | --- |
| **路径** | `fsResolveUnder` 拒绝 `..`、绝对路径、Windows 盘符、`\0` |
| **范围** | 项目 FS 限于 `root`；扩展 FS 限于该扩展目录 |
| **扩展 ID** | 只能含字母数字下划线中划线，不能含 `/` `\`，不能以 `.` 开头 |
| **大小（读）** | 超过 `maxReadSize`（默认 10 MB）截断并标记 |
| **大小（写）** | 超过 `maxWriteSize`（默认 1 MB）返回 413 |
| **数量** | 单次列目录上限 `maxListEntries`（默认 2000） |
| **类型** | 不能写扩展根目录，不能覆盖已有目录 |
| **开关** | `api.enabled` + `api.fs.read` + `api.fs.write` + `api.writable` 四重闸门 |
| **静态路由** | 任何以 `.` 开头的路径段都会被拒绝，`.js` 目录无法直接通过 HTTP 访问 |
| **HTML 转义** | 所有用户输入经过 `escapeHtml`；CSS 颜色经过 `sanitizeCssColor` |
| **JSON 注入** | `serializeNavData` 转义 `<` `>` `\u2028` `\u2029` |
| **脚本注入** | `safeScript` 转义 `</script>` |

### 扩展 = 完全信任

扩展的 `index.js` 运行在 **服务端进程里，与 `server.js` 权限完全相同**。
`ctx.fs` 只是便利封装 —— 扩展依然可以直接 `require('fs')` 访问任意路径、`require('child_process')` 执行命令。

实测（沙箱探针）证明，运行中的扩展可以：

| 行为 | 实际运行时 |
| --- | --- |
| `require('child_process')` | ✅ 可加载 |
| `child_process.execSync('id')` | ✅ 返回 `uid=0(root)` |
| 原生 `fs.readFileSync('/etc/passwd')` | ✅ 可读取 |
| `process.env` | ✅ 全部环境变量可见 |
| `ctx.fs.read('../../../etc/passwd')` | 🚫 抛出"路径越界" |

> **安装第三方扩展 = 完全信任其作者**，与安装 npm 包同级。
> 这不是缺陷（任何插件系统都如此），但必须知情。

**装前请用 `vm.js` 审计**（见 [扩展安全审计 — vm.js](#扩展安全审计--vmjs)）：

```bash
node vm.js --all .js --strict && echo "全部通过"   # CI 门禁，有恶意/可疑即失败
```

---

## 常见问题

### Q：修改了 server.json，页面没变化？

1. 确认终端是否打印了 ♻ server.json 已重新加载
2. 若无日志，检查文件是否保存成功、JSON 格式是否正确
3. JSON 解析失败时终端会输出 ⚠ 配置文件 ... 解析失败
4. 尝试硬刷新（Ctrl/Cmd + Shift + R）或访问 /?fresh=1

### Q：改了 port 或 host 没生效？

这两项绑定在监听 socket 上，无法运行时切换。Ctrl+C 停止后重启。

### Q：为什么有些 HTML 没出现在导航页？

按顺序检查：

1. 文件是否在 ignoreDirs 列出的目录中
2. 文件名是否匹配 ignoreFiles 的通配规则
3. 扩展名是否在 htmlExtensions 列表中
4. 文件/目录是否以 . 开头（默认跳过隐藏项）
5. 是否超过 depth 层级

### Q：我的扩展改了没生效？

1. 确认 js.list.json 里包含这个扩展的目录名
2. 确认 mod.json 里 enabled 不是 false
3. 查看终端是否打印 ♻ 扩展已重新加载
4. 用 /?format=json 检查 extensions 字段
5. 如果是浏览器端代码改了，硬刷新页面

### Q：扩展的 index.js 里能用 require 吗？

可以，但有区别：

· 相对路径（./、../）用无缓存加载器递归处理，支持 .js / .json / 目录下的 index.js。同一次加载内共享模块实例（缓存），扩展指纹变化时整体重建。
· 绝对模块名（如 fs、path）落到 Node 原生 require。

**循环依赖已支持**：`A → B → A` 场景下 B 拿到的是 A 的（可能还没填完的）`exports` 对象，不会栈溢出——与 Node 原生 `require` 行为一致。

index.js 处于 CommonJS 语境，module、exports、require、__filename、__dirname 都可用。

### Q：扩展怎么在服务端读自己的配置值？

`ctx.config` 就是合并后的配置值（默认值 + 用户覆盖），直接读：

```js
module.exports = {
  onInit(ctx) {
    ctx.log('配置:', ctx.config);                           // { greeting: "hello", count: 3 }
    ctx.log('用户覆盖:', ctx.userConfig);                   // { greeting: "你好" }
    ctx.log('字段列表:', ctx.configSchema.map(f => f.key));  // ["greeting", "count"]
    ctx.log('用户改过吗:', ctx.hasUserConfig);              // true / false
  },
};
```

客户端读到的是同一份数据（`NavExt.getExtConfig(id)`）。

### Q：主题色设置后没效果？

服务端会校验颜色格式，非法值被丢弃并回退默认色。支持：

```text
#4f6ef7           十六进制
#f6f              三位简写
rgb(79,110,247)
hsl(220,90%,64%)
tomato            CSS 颜色名
```

### Q：能显示中文文件名吗？

可以。URL 会自动百分号编码，页面上的名称保持原样。

### Q：文件很多，扫描会不会慢？

默认扫描缓存 400ms，扩展指纹检查 300ms。文件量大时可调大 server.js 顶部的 TTL.scan 常量。也可用 ?fresh=1 按需强制刷新。

### Q：改了 server.js 或 .navext.client.js，server.dist.js 没变？

正常。server.dist.js 是生成时的快照，改了源文件要重跑 node build.js。

### Q：server.dist.js 能在没有 .navext.client.js 的机器上跑吗？

能。客户端库已经内联在里面了。它跟 server.js 一样，读取 server.json / html.json / .js/ 扩展目录。

### Q：能部署到服务器吗？

可以，但这是开发/预览用途的服务器，没有鉴权、限流、HTTPS 等生产级防护。对外暴露前建议加一层 Nginx 反向代理，或仅在内网使用。

---

## 文件清单

文件 必需 说明
server.js ✅ 服务端脚本
.navext.client.js ✅ 客户端库，与 server.js 同目录
build.js ❌ 合并脚本，用于生成单文件版本
cli.js ❌ 扩展管理 + 构建命令封装
vm.js ❌ 扩展安全沙箱检测器（零依赖，可独立运行）
server.dist.js ❌ 生成产物，可分发的单文件
app.tar.gz ❌ 打包产物（pack 生成）
app.sh ❌ 单文件自解压（sfx 生成）
server.json ❌ 全局配置
html.json ❌ 目录/文件元数据
.js/js.list.json ❌ 扩展清单
.js/config.json ❌ 用户扩展配置（运行时生成）
.js/<name>/mod.json ❌ 扩展元数据
.js/<name>/js.json ❌ 扩展注入配置 + 配置 schema
.js/<name>/index.js ❌ 扩展服务端逻辑
.js/<name>/client.js ❌ 扩展客户端脚本
.js/<name>/styles.css ❌ 扩展样式
examples/ ❌ 教学型示例扩展（5 个，可复制到 .js/ 运行）

---

## 版本历史

版本 主题 关键新增
v1.0 基础 扫描 + 导航页 + 搜索 + 配置 + html.json
v1.1 扩展系统 .js/ 扩展目录 + js.list.json + mod.json + js.json + index.js
v1.2 扩展能力 data-ext-target 稳定标记 + window.NavExt + 服务端 RESTful API
v1.3 配置系统 config schema + NavExt.getExtConfig() + /api/extensions/:id/config
v1.4 文件系统 项目只读 FS + 扩展读写 FS + NavExt.fs / NavExt.extFs(id) + ctx.fs
v1.5 工程化 客户端库外置 + 模块缓存 + build.js 合并为单文件
v1.6 打包 打包成 tar.gz / 自解压 app.sh + cli.js 构建命令
v1.7 自定义主页 home 字段：用自定义 HTML 替代导航页，可选是否注入扩展
v1.8 多主页 home.routes：按 path / host / env 匹配不同主页，支持多站点
v1.9 扩展作用域 js.list.json 支持 paths/exclude，扩展可按路径生效；NavExt.isExtActive 客户端 API
v2.0 扩展 onRequest 支持任意 HTTP 方法；API 分支和静态文件分支各自拦截
v2.0.1 修复扩展模块加载器的循环依赖（A → B → A 不再栈溢出）
v2.1 子页扩展策略 + HTML 渲染缓存：jsx.json 声明 enable / disable；cache.html 开启内存缓存，TTL 分层可调
v2.1.1 修复 HTML 缓存键：加入 Host 头，避免多主页路由串缓存
v2.1.2 home 兜底只对 / 生效：未显式匹配的路径交还静态文件
v2.2 扩展 API：ctx.readBody / readJson、异步钩子超时保护、onError 钩子、cards-updated 事件
v2.2.1 文档澄清：cards-updated 为正式事件、超时粒度与副作用、onError 同步/异步
v2.3.0 扩展依赖 requires（拓扑排序）+ 扩展统计 stats() + GET /api/extensions/:id/stats
v2.4.0 ctx.fetch / ctx.timer / ctx.interval / ctx.clearTimer —— 扩展重载时自动清理资源
v2.4.1 修复：ctx.fetch 合并用户 signal；stats() 改回仅同步；抽 parseJsonBody；客户端加 getExtStats
v2.4.2 ctx.fetch 成功/失败路径也释放 signal listener；文档措辞精确化
v2.5 第一档能力 onResponse 响应钩子（可改状态/头/体）+ GET /api/search 服务端搜索 + access-stats 统计扩展
v2.6 内置 UI + 安全审计 视图切换（按目录/按时间）+ 主题切换与自定义主题色 + html.json 隐藏条目（含 glob）+ vm.js 扩展安全沙箱检测器
v2.7.0 扩展生命周期 + 路径归一化 服务端 onDispose 钩子；客户端 NavExt.disposer / dispose / isDisposed + pagehide/beforeunload 自动清理 + pageshow(bfcache) 重派 init；urlToRel / relToUrl / pathOf / normalizePath 双端一致（统一 URL 与相对两套路径体系）；5 个教学示例
v2.7.1 文档拆分 NavExt.md 保留全文并加索引；新增 MD/ 目录：10 篇主题文档 + 导航首页 +《从零写第一个扩展》手把手教程
v2.8.0 ctx.project 扩展可只读访问站点文件（read/list/stat/exists，三重校验：越界 + 隐藏路径 + 软链接）；修复 urlToRel / relToUrl 只认 .html 扩展名导致 .md/.json/.css 等被误当目录（双实现同步修复）
v2.8.1 文档同步 补齐 ctx.project 章节与特性表；MD/ 主题文档跟进 v2.8 API；TODO 缺口清单
v2.8.2 注入顺序解耦 + ctx.fs 对齐 + 配置告警

- **`cssOrder`**：CSS 覆盖顺序与扩展加载顺序解耦 —— `order` 只管加载，`cssOrder` 只管 `styles` 注入先后（越大越晚、越晚胜出）；未声明时回退 `order`，旧行为不变
- **`ctx.fs` 与 `ctx.project` 对齐**：`read(rel, { encoding, maxBytes })` 超限抛 `FS_TOO_LARGE`；`list` 返回 `path` 字段、支持 `{ depth }` 递归；`list` 目标不存在/非目录时抛错（此前静默返回 `[]`）
- **`home.routes[].match.env` 启动告警**：配了 `env` 却没配 `value` 的路由永远不会命中，启动时提示

---

## License

MIT
