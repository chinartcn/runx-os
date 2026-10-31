# site/

RunX OS 的**线上站点**：官网、文档、应用商店。

| 目录 | 部署到 | 域名 | 技术 |
|---|---|---|---|
| `www/` | Cloudflare Pages（`runx-www`） | www.rtcnnavext.de5.net | 静态 HTML + runx-ui |
| `docs/` | Cloudflare Pages（`runx-docs`） | docs.rtcnnavext.de5.net | VitePress |
| `store/` | Cloudflare Worker（`runx-store`） | store. / api. / api.user.rtcnnavext.de5.net | Worker + D1 + KV |

## 为什么要单独一个目录

RunX 内核的硬约束是**零运行时依赖**。站点是另一回事 —— 它需要构建工具、
需要 CDN、需要一个数据库。所以它不进 `server.js`，也不进 `.js/`。

但视觉语言必须一致：官网、文档站、桌面、组件库，四处是同一个蓝色、
同一个 Inter、同一组语义色。改任何一处之前，先看 `packages/runx-ui/runx-ui.css`
与 `.js/@runx-desktop/assets/tokens.css`。

## 凭证

```bash
cp .secrets/.env.example .secrets/.env   # 填入真实值
```

`.secrets/` 已在 `.gitignore` 里。**不要把 token 提交进仓库。**

## 本地预览

```bash
# 官网
cd site/www && python3 -m http.server 8099

# 文档站（热更新）
cd site/docs && npm install && npm run docs:dev

# 商店 Worker（本地 D1 + KV）
cd site/store && npm install && npm run db:local && npm run dev
```

## 部署

```bash
export CLOUDFLARE_API_TOKEN=...      # 见 .secrets/.env
export CLOUDFLARE_ACCOUNT_ID=...

# 文档站
cd site/docs && npm run docs:build && npx wrangler pages deploy .vitepress/dist --project-name=runx-docs --branch=main

# 官网
cd site/www && npx wrangler pages deploy . --project-name=runx-www --branch=main

# 商店
cd site/store && npm run db:init && npm run deploy
```

## DNS

| 记录 | 类型 | 指向 |
|---|---|---|
| `www` | CNAME | `runx-www.pages.dev` |
| `docs` | CNAME | `runx-docs.pages.dev` |
| `api` / `api.user` / `store` | AAAA `100::` | Cloudflare 自动创建（Worker 自定义域） |

> 根域 `rtcnnavext.de5.net` 指向一个 argotunnel（用户自己的隧道），
> **不要动它** —— 商店另起了 `store.` 子域。

## 目录

```text
site/
├── www/
│   ├── index.html          官网首页
│   └── assets/
│       ├── runx-ui.css     从 packages/runx-ui 拷贝
│       ├── runx-ui.js
│       └── fonts/          从 .js/@runx-desktop/assets/fonts 拷贝
├── docs/
│   ├── index.md            文档首页
│   ├── guide/              指南
│   ├── reference/          参考（SDK / host / ui / capabilities / store）
│   ├── .vitepress/
│   │   ├── config.mjs
│   │   └── theme/          配色 + 主题定制
│   └── public/fonts/
└── store/
    ├── wrangler.toml
    ├── migrations/
    ├── src/                Worker 源码
    └── README.md           商店的详细设计
```

## 内容从哪来

- `docs/reference/{sdk,host,ui}.md` 是从 `packages/*/README.md` **转换**过来的
  （去掉 h1、加 frontmatter、标题加引号 —— YAML 里 `@` 是保留字符）。
  改了 package 的 README，要重新同步一次。
- `docs/guide/design.md` 与 `design-ui.md` 来自 `docs/RunX.OS.Termux.md`
  与 `docs/RunX.UI.md`。这两份原文用中文编号当章节，不是 markdown 标题，
  转换脚本会把它们提升成 `##`。

## 已知取舍

- 商店前端内联在 `src/index.js` 里（一个 HTML 字符串），没有独立构建 ——
  与 RunX 内核「零构建」的脾气一致。改样式直接改那个字符串。
- 文档站的搜索用 VitePress 的 local provider（客户端索引）。
  包大了之后要换 Algolia。
- 官网的字体是本站自带的 woff2（`assets/fonts/`），不是 CDN ——
  少一个第三方依赖，也少一个 GDPR 问题。
