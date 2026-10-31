# RunX Store

> 核心理念：**极致白嫖，按需驱动**。
>
> · 零服务器成本：全靠 Cloudflare 免费全家桶（Worker + D1 + KV + R2）。
> · 去中心化存储：开发者自带干粮（GitHub / npm），官方只做指路明灯。
> · 被动式更新：没有任何后端的定时轮询，全靠用户请求和开发者手动触发。

商店源码 MIT 开源，**绝对透明可信** —— 你可以直接拿去自己美化。
前端就一个 HTML 文件，后端就七个 JS 文件。

## 目录

```text
site/store/
├── wrangler.toml       Worker 配置（三个域名 + D1 + KV + 定时任务）
├── migrations/
│   └── 0001_init.sql   D1 表结构
└── src/
    ├── index.js        路由 + 商店前端（HTML 内联）
    ├── http.js         HTTP 助手（json / html / CORS / SHA-256）
    ├── db.js           D1 访问层 + KV 缓存
    ├── meta.js         meta.json 解析与权限归一化
    ├── public.js       公共 API
    ├── user.js         开发者 API
    └── cron.js         定时任务（冷备份）
```

## 域名

| 域名 | 用途 |
|---|---|
| `store.rtcnnavext.de5.net` | 商店前端 |
| `api.rtcnnavext.de5.net` | 公共 API |
| `api.user.rtcnnavext.de5.net` | 开发者 API |

三个域名是**同一个 Worker**，按 hostname 分流。

## 部署

```bash
cd site/store
npm install

export CLOUDFLARE_API_TOKEN=...      # 见 ../../.secrets/.env
export CLOUDFLARE_ACCOUNT_ID=...

npm run db:init      # 建 D1 表
npm run deploy       # 部署 Worker
```

> R2 目前还没在 Cloudflare Dashboard 里启用（API 改不了这个开关）。
> 不影响主流程 —— 商店本来就不存包。等启用了，在 `wrangler.toml` 里加
> `[[r2_buckets]]` 绑定，然后在 `cron.js` 里多写一份即可（代码里留好了位置）。

## 凭证

`../../.secrets/.env`（不入库）：

```bash
CF_TOKEN=...
CF_ACCOUNT_ID=...
D1_DATABASE_ID=...
KV_NAMESPACE_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_ENDPOINT=...
```

## 数据流

```text
开发者                        商店 Worker                     用户
   │                             │                             │
   ├─ 发布到 GitHub/npm ─────────┤                             │
   │                             │                             │
   ├─ POST /api/user/sync ──────►│ 拉 meta.json                 │
   │  (meta_url)                 │ 归一化 → 写 D1                │
   │                             │ 清 KV 缓存                    │
   │                             │                             │
   │                             │◄── GET /api/apps ────────────┤
   │                             │    （KV 缓存 10 分钟）        │
   │                             │                             │
   │                             │◄── POST /api/verify ────────┤  拿本地 SHA 比对
   │                             │    返回 changed / permissions│
   │                             │                             │
   │                             │◄── POST /api/download ──────┤  记下载量
   │                             │                             │
   │                             │◄── GET /api/proxy ──────────┤  源站失败 → 镜像池
   │                             │                             │
   │                             │◄── POST /api/report ────────┤  404 → 死链探针
   │                             │    连续 2 次才问上游          │
```

## 关键设计

### 商店不存包

D1 只放元数据（详情、图标、权限、SHA、下载量）。包在开发者自己的源上。
这既是「零服务器成本」的前提，也是「允许自行配置软件包源」的前提 ——
开发者可以只用自己的 GitHub Release，商店只做索引。

### 权限变了要重新弹 UAC

`meta.json` 里的 `permissions` 就是 RunX 的能力字符串数组。
同步时 Worker 会比对旧值，通过 `permissions_changed` 告诉前端。
前端据此决定要不要在安装时重新走一遍审批。

### SHA 校验有两条

- **包哈希**（`sha256`）：开发者提供，校验下载到的文件。
- **meta 哈希**（`meta_sha256`）：商店自己算，用来判断「我看到的详情是不是最新的」。

开发者常常不提供包哈希 —— 这时 `/api/verify` 自动退回比对 meta 哈希，
并在响应里用 `verified_against` 说明当前比的是哪一个。

### 代理池的顺序

直连 GitHub → `gh-proxy.org` → `ghproxy.net` → `ghfast.top`。

全部失败时，响应里列出**每一次尝试**与状态，并区分两种情况：

- 全是 404 → 「源仓库不存在或已删除」
- 其他 → 「网络或上游服务异常（GitHub 抽风），稍后再试」

### 死链自净

用户下载 404 → 前端上报 → Worker 记一笔失败。
**连续 2 次**才去问上游（一次 404 可能只是代理抖了一下）。

- GitHub 源：先问 API（能区分「删除」与「转私有」），API 限流则退回 HEAD。
- 其他源：直接 HEAD。
- 判定为死 → `status = 0` 下架（历史记录留着）。
- 上游 API 抽风 → 只记一笔，不下架。锅甩给大厂。

## meta.json

沿用 RunX 的 `appex.json` 字段，再加几个商店专用字段 —— 开发者不用学第二套格式。
完整说明见 [文档站的商店章节](../../site/docs/reference/store.md)。

### `source.subdir` —— 应用在包内的哪一层

大多数应用的包是**整个 GitHub 仓库**，下载下来长这样：

```
runx-os-main/            ← 仓库名（还是「仓库名-分支名」，每次都不一样）
  apps/demo/appex.json   ← 应用在这
  packages/...
```

内核解包后要找到 `appex.json`。只认根目录的话，**每个 GitHub 源的应用都装不上**。

所以开发者声明一下：

```json
{
  "name": "demo",
  "source": {
    "type": "github",
    "url": "https://github.com/chinartcn/runx-os",
    "download": "https://github.com/chinartcn/runx-os/archive/refs/heads/main.tar.gz",
    "subdir": "apps/demo"
  }
}
```

内核按**路径后缀**匹配，所以 `"apps/demo"` 在任何一层仓库目录名下都命中 ——
开发者不需要知道那层目录叫什么。

**不写也能装**：包里只有一个 `appex.json` 时自动命中它。
有两个以上就报错，并把候选列出来让人选 —— 不替人猜着装。

## 定时任务

每天凌晨 3 点（`crons = ["0 3 * * *"]`）：

1. 把 D1 打包成 `index.json` 存进 KV（R2 启用后多写一份）。
2. 清掉 30 天前的死链探测记录。
3. 清掉过期会话。

## 不做的事

- 不做用户账号体系 —— 商店是公开索引，开发者账号只管上架。
- 不做推荐算法 —— 排序就是下载量倒序。
- 不做评论评分 —— 那是另一个项目的事。
- 不代理、不转存、不托管任何包。
