-- RunX Store · D1 schema
-- 真理所在：只存核心元数据。大文件一律在开发者自己的源（GitHub / npm / R2）。

CREATE TABLE IF NOT EXISTS apps (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  icon_url      TEXT NOT NULL DEFAULT '',
  screenshots   TEXT NOT NULL DEFAULT '[]',      -- JSON array of URL
  category      TEXT NOT NULL DEFAULT 'other',
  version       TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL DEFAULT '',
  homepage      TEXT NOT NULL DEFAULT '',
  repo          TEXT NOT NULL DEFAULT '',
  license       TEXT NOT NULL DEFAULT 'MIT',
  -- 权限声明：RunX 的能力字符串数组，如 ["fs.read:./**","dialog.open"]
  permissions   TEXT NOT NULL DEFAULT '[]',
  sha256        TEXT NOT NULL DEFAULT '',        -- 包文件的哈希（开发者提供）
  meta_sha256   TEXT NOT NULL DEFAULT '',        -- meta.json 自身的哈希（商店算）
  size          INTEGER NOT NULL DEFAULT 0,
  -- source_type: github | npm | r2 | url
  source_type   TEXT NOT NULL DEFAULT 'url',
  source_url    TEXT NOT NULL DEFAULT '',
  download_url  TEXT NOT NULL DEFAULT '',
  -- meta_url: 「一键同步」时拉取 meta.json 的地址
  meta_url      TEXT NOT NULL DEFAULT '',
  manifest      TEXT NOT NULL DEFAULT '',        -- 原始 meta.json 文本
  downloads     INTEGER NOT NULL DEFAULT 0,
  -- status: 1 = 活着，0 = 已下架（死链探测判定）
  status        INTEGER NOT NULL DEFAULT 1,
  dead_reason   TEXT NOT NULL DEFAULT '',
  last_checked  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_apps_category ON apps(category);
CREATE INDEX IF NOT EXISTS idx_apps_status   ON apps(status);
CREATE INDEX IF NOT EXISTS idx_apps_author   ON apps(author);

-- 开发者账号（api.user.* 用）。密码只存 PBKDF2 派生值。
CREATE TABLE IF NOT EXISTS developers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- pbkdf2$sha256$<iters>$<salt_b64>$<dk_b64>
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 登录会话（KV 也行，但放 D1 便于审计与吊销）
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  developer   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,          -- unix 秒
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

-- 下载流水：只记哈希，不记 IP
CREATE TABLE IF NOT EXISTS downloads_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app        TEXT NOT NULL,
  version    TEXT NOT NULL DEFAULT '',
  ua         TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dl_app ON downloads_log(app);

-- 死链探测记录：同一个源被反复 404 时才去问 GitHub API
CREATE TABLE IF NOT EXISTS probes (
  url         TEXT PRIMARY KEY,
  fails       INTEGER NOT NULL DEFAULT 0,
  last_status TEXT NOT NULL DEFAULT '',
  checked_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
