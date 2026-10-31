---
title: 应用商店
---

# RunX Store

> 核心理念：**极致白嫖，按需驱动**。
>
> · 零服务器成本：全靠 Cloudflare 免费全家桶（Worker + D1 + KV + R2）。
> · 去中心化存储：开发者自带干粮（GitHub / npm），官方只做指路明灯。
> · 被动式更新：没有任何后端的定时轮询，全靠用户请求和开发者手动触发。

## 四层技术架构

### 1. 边缘计算层（Cloudflare Worker）

- **智能网关**：接收前端请求，处理跨域，分发 API。
- **代理池**：外部包下载失败时，自动轮询各种 GitHub 镜像代理。
- **死链探针**：收到用户的 404 上报后，直接去问 GitHub/Gitee API。仓库没了就下架；API 抽风了就甩锅给大厂。

### 2. 数据存储层（D1 + KV）

- **D1 数据库（真理所在）**：只存最核心的元数据（详情、图标、截图、权限、SHA、下载量等）。支持快速搜索和分类。
- **KV 缓存（抗压先锋）**：存全局数据的哈希和临时计数，挡住 90% 的 D1 读取请求。
- **冷备份**：每天凌晨定时将 D1 数据打包成 index.json。

### 3. 物理存储层（源）

包在开发者自己的源上：GitHub Release、npm、R2 或任意静态托管。商店只存下载链接。

### 4. 安全与展示层（RunX OS 前端）

- **10 分钟本地缓存**：前端把元数据存在 localStorage / IndexedDB 里，10 分钟内疯狂秒开，不碰后端。
- **SHA 强校验**：下载前必须向后端请求一次最新 SHA，防止开发者在这 10 分钟内「偷梁换柱」提权。
- **UAC 拦截**：权限有任何变动，`@runx-rights-manager` 直接弹窗拦截，用户确认后才放行。

## 开发者上架 / 更新流

1. 开发者写好代码，发版到 GitHub / npm / 自己的静态托管。
2. 登录商店后台，填个表单，点「一键同步」。
3. Worker 收到请求，拉取最新的 `meta.json`，写入 D1，清空 KV 缓存。
4. 瞬间全网生效。

## 用户浏览 / 下载流

1. 用户打开商店，前端直接从本地读缓存展示（10 分钟过期）。
2. 点击「下载」，前端带上本地 SHA 请求 Worker 校验。
3. Worker 返回最新状态。如果版本变了，前端静默刷新详情页。
4. 如果权限没变，直接去源站或代理下载解压；如果权限变了，弹 UAC。

## 系统自净流（死链清理）

1. 用户下载失败（404）。
2. 前端上报给 Worker。
3. Worker 调 GitHub API 核实：如果真没了，直接 `UPDATE apps SET status = 0`；如果 API 也挂了，提示「GitHub 抽风，稍后再试」。

## meta.json 格式

沿用 RunX 的 `appex.json` 字段，再加几个商店专用字段 —— 开发者不用学第二套格式。

```json
{
  "name": "my-app",
  "slug": "my-app",
  "version": "1.2.0",
  "display_name": "我的应用",
  "summary": "一句话介绍",
  "description": "详细描述，支持换行",
  "icon": "https://example.com/icon.svg",
  "screenshots": ["https://example.com/1.png"],
  "category": "utility",
  "author": "yourname",
  "homepage": "https://example.com",
  "repo": "https://github.com/you/my-app",
  "license": "MIT",
  "permissions": ["fs.read:./**", "fs.write:./data/**"],
  "sha256": "…",
  "size": 1048576,
  "source": {
    "type": "github",
    "url": "https://github.com/you/my-app",
    "download": "https://github.com/you/my-app/releases/download/v1.2.0/my-app.tar.gz",
    "subdir": "apps/my-app"
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` / `slug` | ✓ | 应用标识。`slug` 缺省时从 `name` 生成 |
| `version` | ✓ | 版本号 |
| `permissions` | | RunX 能力字符串数组。**权限变了会重新弹 UAC** |
| `sha256` | | 下载前的强校验。开发者提供，商店不做二次哈希 |
| `source.download` | ✓ | 实际下载地址 |
| `source.subdir` | | 应用在包内的相对路径，见下 |
| `permissions` 也接受对象写法 | | `{cap, scope}` 会被归一化成 `"cap:scope"` |

### `source.subdir` —— 包里哪个目录是应用

包的来源通常是**整个 GitHub 仓库**，下载下来是这样：

```
your-repo-main/          ← 仓库名（还是「仓库名-分支名」，每次都不一样）
  apps/my-app/appex.json ← 应用在这
  packages/...
```

内核解包后要找到 `appex.json`。只认根目录的话，**每个 GitHub 源的应用都装不上**。

`subdir` 就是告诉内核去哪找：

```json
"subdir": "apps/my-app"
```

内核按**路径后缀**匹配，所以 `"apps/my-app"` 在任何一层仓库目录名下都命中 ——
你不需要知道那层目录叫什么（它每次 pull 还不一样）。

::: tip 不写会怎样
包里**只有一个** `appex.json` 时内核自动命中，不用写。
有**两个以上**时内核不猜 —— 装不上，并列出候选让你确认该填哪个。

:::

::: warning 发布到 Release 就不用写
`my-app.tar.gz` 这种「应用打包成独立 tarball」的形式，解包后根目录直接就是
`appex.json`，不需要 `subdir`。`subdir` 是给「直接把仓库当包发」的情况用的。

:::

## 开发者 API

基址：`https://api.user.rtcnnavext.de5.net`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/user/register` | 注册（用户名 + 密码，密码 PBKDF2 派生后存 D1） |
| POST | `/api/user/login` | 登录，返回会话 token（30 天） |
| POST | `/api/user/logout` | 吊销当前会话 |
| GET | `/api/user/me` | 当前身份 |
| POST | `/api/user/sync` | **一键同步**：拉 `meta.json` → 写 D1 → 清缓存 |
| GET | `/api/user/apps` | 我的应用列表 |
| POST | `/api/user/remove` | 下架我的应用 |

鉴权：`Authorization: Bearer &lt;token&gt;`，或 `X-RunX-Token: &lt;token&gt;`，或 JSON body 里的 `token` 字段。

```bash
# 注册并同步
curl -X POST https://api.user.rtcnnavext.de5.net/api/user/register \
  -H 'content-type: application/json' \
  -d '{"name":"you","password":"至少8位"}'

curl -X POST https://api.user.rtcnnavext.de5.net/api/user/sync \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <token>' \
  -d '{"meta_url":"https://raw.githubusercontent.com/you/my-app/main/meta.json"}'
```

## 公共 API

基址：`https://api.rtcnnavext.de5.net`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/apps?q=&category=&limit=&offset=` | 应用列表（KV 缓存 10 分钟） |
| GET | `/api/apps/:slug` | 应用详情 |
| POST | `/api/verify` | **SHA 强校验**。返回 `match` / `changed` / 最新权限 |
| POST | `/api/download` | 记下载量并取下载链接 |
| GET | `/api/proxy?url=…` | 代理下载：源站失败时自动轮询镜像 |
| POST | `/api/report` | **死链上报**：连续 2 次失败才去问上游 |
| GET | `/api/meta?url=…` | 试拉并归一化一个 `meta.json`（不写入） |
| GET | `/api/stats` | 总数 / 在架数 / 下载量 |

## 允许自行配置软件包源

商店**不垄断**分发。RunX OS 端可以自行配置包源：

- 开发者可以只用自己的 GitHub Release，商店只做索引。
- 用户可以在 RunX OS 里填自己的镜像前缀，商店的代理池会优先用。
- **如果有问题自负** —— 商店只做「指路明灯」，不替源站背书。

代理池顺序：`直连 → gh-proxy.org → ghproxy.net → ghfast.top`。
全部失败时，响应里会列出**每一次尝试**与状态，并说明是「源仓库不存在」还是「网络或上游服务异常」。

## 开源

商店源码 **MIT**，绝对透明可信。你可以直接拿去自己美化 —— 前端就一个 HTML 文件，后端就七个 JS 文件。
