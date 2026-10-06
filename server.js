#!/usr/bin/env node
'use strict';

/* ─── Node.js 版本检查 ─── */
(function checkNodeVersion() {
  var v = process.versions && process.versions.node;
  if (!v) return;
  var parts = String(v).split('.');
  var major = parseInt(parts[0], 10);
  var minor = parseInt(parts[1], 10) || 0;
  if (isNaN(major)) return;
  if (major > 14) return;
  if (major === 14 && minor >= 17) return;

  // Node 14.0–14.16 缺少全局 AbortController（14.17 起可用）
  if (major === 14 && minor < 17) {
    console.warn('');
    console.warn('  ⚠  Node ' + v + ' 缺少全局 AbortController（Node 14.17+ 起可用）');
    console.warn('     扩展的 ctx.fetch 在此版本不可用（ctx.timer 不受影响）');
    console.warn('     建议升级到 14.17+ 或 18+');
    console.warn('');
    return;
  }

  var lines = [
    '',
    '  ✖ Node.js 版本过低：v' + v,
    '    本服务需要 Node.js 14 或更高版本',
    '',
    '    升级方式：',
    '      Termux:          pkg upgrade nodejs',
    '      Ubuntu/Debian:   sudo apt update && sudo apt install -y nodejs',
    '      macOS:           brew upgrade node',
    '      官网:            https://nodejs.org/',
    '',
  ];
  console.error(lines.join('\n'));
  process.exit(1);
})();


/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  server.js — NavExt                                                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  全局地图 (Global Map)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  [00] 全局地图           ← 你正在读的这段
 *  [01] 不可变常量         DEFAULT_CONFIG / MIME / 版本 / 路径常量
 *  [02] 纯工具函数         escapeHtml / matchGlob / parseJson / formatSize
 *  [03] 文件系统安全       fsResolveUnder / fsGetType / resolveStaticPath
 *  [04] 配置 schema        归一化与校验 (v1.3)
 *  [05] App 状态容器       唯一可变状态入口
 *  [06] 配置文件层         server.json 加载与热重载
 *  [07] html.json          目录/文件元数据
 *  [08] 扩展系统           加载 / 热重载 / ctx.fs / 钩子
 *  [09] 扫描层             HTML 文件发现
 *  [10] 客户端脚本         从 .navext.client.js 加载
 *  [11] 渲染层             renderNav / buildHtml
 *  [12] 静态文件           响应构造与文件服务
 *  [13] API 路由           /api/* 分发
 *  [14] 请求入口           handleRequest
 *  [15] 启动与 CLI         main / printHelp / parseArgs
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  数据流 (Data Flow)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  请求 → handleRequest
 *         ├── /api/*      → handleApi → 配置 / 扩展 / FS
 *         ├── /           → getState → renderNav → HTML
 *         └── /<path>     → serveStatic
 *
 *  状态更新：
 *    server.json 变更 → getConfig       → cfgVersion++
 *    扩展目录变更     → getExtensions   → extVersion++
 *    HTML 目录变更    → getState        重新扫描
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  依赖原则 (Dependency Rules)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  · 全局作用域只保留：不可变常量、纯函数、App 对象
 *  · 一切可变状态挂载在 App 上，显式传递
 *  · 函数尽量纯，副作用集中在 I/O 边界
 *  · 禁止隐式全局：a = 1 这种写法一律不允许
 *  · 分区内不写大段业务逻辑，能提函数就提函数
 *  · 客户端库位于 .navext.client.js，本文件只负责读取和注入
 */

/* ═══════════════════════════════════════════════════════════════════════════
 *  [01] 不可变常量
 * ═══════════════════════════════════════════════════════════════════════════ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const OS = require('./os');

/** 服务端版本 —— 会通过 __NAV_DATA__ 传给客户端 */
const SERVER_VERSION = '2.8.3';

/** 客户端库路径 —— 与 server.js 同目录，文件名以 . 开头，静态路由自动拒绝 */
const NAVEXT_CLIENT_PATH = path.join(__dirname, '.navext.client.js');

/** 内置默认配置 —— 冻结，运行时绝不修改 */
const DEFAULT_CONFIG = Object.freeze({
  port: Number(process.env.PORT) || 3000,
  host: '0.0.0.0',
  depth: 8,

  site: Object.freeze({
    title: '',
    description: '',
    logo: '📄',
    footer: '',
    accent: '',
    showStats: true,
  }),

  extensions: Object.freeze({
    enabled: true,
    dir: '.js',
    configFile: 'config.json',
    timeout: 5000,   // 异步钩子（onHtml/onRequest）超时 ms，0 = 禁用
    fetchTimeout: 30000,   // ctx.fetch 默认超时 ms（网络请求通常更慢）
  }),

  api: Object.freeze({
    enabled: true,
    // v2.8.1：写文件接口（/api/extensions/:id/fs/*）默认关闭。
    //
    // 原因：这些端点无鉴权，且写入的内容位于扩展目录内——扩展文件会被热重载
    // 并作为 CommonJS 模块执行。也就是说「一个 HTTP POST → 写 index.js →
    // 热重载 → 执行任意代码」是一条完整链路，默认开启等于默认开放远程代码执行。
    //
    // 这里只关 fs.write、不关 writable，是为了让两个无代码执行风险的功能
    // 保持默认可用：浏览器里改扩展配置、运行时 toggle 扩展启停。
    // 这两者写的都是纯数据（受 schema 约束的 config.json、mod.json 的
    // enabled 布尔），无法注入可执行代码。
    //
    // 需要文件写入（如带状态的扩展要落盘）时，在 server.json 显式打开：
    //   { "api": { "fs": { "write": true } } }
    // 完全只读部署再把 writable 也关掉。
    writable: true,
    fs: Object.freeze({
      read: true,
      write: false,
      maxReadSize: 10 * 1024 * 1024,
      maxWriteSize: 1 * 1024 * 1024,
      maxListEntries: 2000,
    }),
  }),

  home: Object.freeze({
    enabled: false,
    file: '',
    applyExtensions: false,
    routes: Object.freeze([]),
  }),

  pageExt: Object.freeze({
    enabled: true,
    file: 'jsx.json',
  }),

  cache: Object.freeze({
    html: false,     // HTML 渲染缓存
    extTtl: 1000,    // 扩展目录指纹扫描间隔 (ms)，100 - 60000
    scanTtl: 400,    // HTML 目录扫描缓存 (ms)，100 - 60000
    cfgTtl: 1000,    // server.json stat 间隔 (ms)，0 - 60000
  }),

  ignoreDirs: Object.freeze(['node_modules', 'bower_components', '.git', '.svn', '.hg']),
  ignoreFiles: Object.freeze([]),
  htmlExtensions: Object.freeze(['.html', '.htm']),
});

/** MIME 表 */
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
});

/** 视为文本的扩展名 */
const TEXT_EXT = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.xml',
  '.txt', '.md', '.csv', '.svg', '.yaml', '.yml', '.ini', '.toml',
  '.env', '.log', '.map', '.ts', '.tsx', '.jsx', '.vue', '.sh',
]);

/** 缓存 TTL */
/** 默认 TTL（毫秒）——运行时可由 server.json 的 cache.* 覆盖 */
const TTL = Object.freeze({
  scan: 400,       // HTML 目录扫描缓存
  ext: 1000,       // 扩展目录指纹扫描间隔
  cfg: 1000,       // server.json stat 间隔
});

/** 正则与字符串常量 */
const PATTERN = Object.freeze({
  metaFile: 'html.json',
  dirMetaKeys: new Set(['@dir', '_dir', '__dir__']),
  configKey: /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/,
  // 扩展 id：以 @ 开头表示「内置 / 核心扩展」，其余与 configKey 同规则。
  // loadExtensions() 与 validateExtId() 共用此模式，避免出现
  // 「能加载却不能启停 / 改配置」的不一致。
  extId: /^@?[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/,
  htmlTag: /[&<>"']/g,
});

const HTML_ESCAPE_MAP = Object.freeze({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  [02] 纯工具函数 —— 无状态、无副作用、可独立测试
 * ═══════════════════════════════════════════════════════════════════════════ */

/** HTML 转义 */
function escapeHtml(str) {
  return String(str ?? '').replace(PATTERN.htmlTag, (c) => HTML_ESCAPE_MAP[c]);
}

/** URL 路径编码（保留 /） */
function encodePath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}

/** 人类可读的大小 */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 人类可读的时间 */
function formatTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 日志时间戳 [HH:MM:SS] */
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 安全转整数 */
function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

/** 去 BOM 后解析 JSON */
function parseJson(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

/** 安全读 JSON —— 失败返回 null */
function readJsonSafe(p) {
  try { return parseJson(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

/** 写 JSON（带缩进和尾换行） */
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** 生成文件指纹（mtime + size），不存在返回 'missing' */
function fileStamp(p) {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

/** 简易 glob 匹配 */
function matchGlob(str, pattern) {
  if (!pattern) return false;
  let re = '^';
  for (const ch of String(pattern)) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re += '$';
  try { return new RegExp(re, 'i').test(str); }
  catch { return false; }
}

/** 校验 CSS 颜色，非法返回空串 */
function sanitizeCssColor(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || s.length > 64) return '';
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s;
  if (/^rgba?\(\s*[\d.\s,%]+\)$/i.test(s)) return s;
  if (/^hsla?\(\s*[\d.\s,%a-z]+\)$/i.test(s)) return s;
  if (/^[a-z]{3,20}$/i.test(s)) return s;
  return '';
}

/** 避免 </script> 提前闭合 */
function safeScript(code) {
  return String(code).replace(/<\/script/gi, '<\\/script');
}

/** 规范化扩展配置的 key */
function normalizeExtKey(key) {
  return String(key).trim().replace(/^\.\//, '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/** 规范化 html.json 里的文件 key */
function normalizeHtmlKey(key) {
  return normalizeExtKey(key);
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  [03] 文件系统安全 —— 路径解析与类型判定
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 软链接逃逸防护：把 target 解析成真实路径，确认仍在 baseDir 真实路径之内。
 *
 * 词法判断（path.resolve + path.relative）挡不住符号链接 —— 项目内一个
 * 指向 /etc 的软链就能让 /etc-link/passwd 正常返回。这里用 realpathSync
 * 拿到链路的最终目的地再比一次。
 *
 * 目标不存在时（如 write 新建文件），逐级向上找到最近的已存在祖先再校验，
 * 避免「父目录是软链、子文件尚不存在」的绕过。
 *
 * @returns {true} 安全 | {error:string} 不安全
 */
function assertRealPathUnder(baseDir, target) {
  let realBase;
  try {
    realBase = fs.realpathSync(baseDir);
  } catch {
    // baseDir 本身不可解析（不存在等），交给后续正常流程报错
    return true;
  }

  // 从 target 起向上找最近的「已存在」路径
  let probe = target;
  let realTarget = null;
  for (;;) {
    try {
      realTarget = fs.realpathSync(probe);
      break;
    } catch (err) {
      if (err && err.code !== 'ENOENT') return { error: 'path 无法解析' };
      const parent = path.dirname(probe);
      if (parent === probe) return true;   // 到根都没找到，放弃（不该发生）
      probe = parent;
    }
  }

  // 已存在部分若是软链，其真实位置必须仍在 baseDir 内
  const r = path.relative(realBase, realTarget);
  if (r && (r.startsWith('..') || path.isAbsolute(r))) {
    return { error: 'path 越界（符号链接指向外部）' };
  }

  return true;
}

/**
 * 把 relPath 解析到 baseDir 下，越界返回 { error }
 * @returns {{full:string, rel:string} | {error:string}}
 */
function fsResolveUnder(baseDir, relPath, opts) {
  if (relPath === undefined || relPath === null) relPath = '';
  if (typeof relPath !== 'string') return { error: 'path 必须是字符串' };
  if (relPath.includes('\0')) return { error: 'path 含非法字符' };

  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^[a-zA-Z]:/.test(rel)) return { error: '不允许绝对路径' };

  const target = path.resolve(baseDir, rel);
  const r = path.relative(baseDir, target);

  if (r === '' || r === '.') return { full: baseDir, rel: '' };
  if (r.startsWith('..') || path.isAbsolute(r)) return { error: 'path 越界' };

  // 词法通过后，再做一次真实路径校验（软链接防护）
  if (!(opts && opts.skipRealPath)) {
    const safe = assertRealPathUnder(baseDir, target);
    if (safe !== true) return safe;
  }

  return { full: target, rel: r.replace(/\\/g, '/') };
}

/** 判定 stat 的类型 */
function fsGetType(st) {
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  if (st.isSymbolicLink()) return 'link';
  return 'other';
}

/** 静态资源路径解析（拒绝任何以 . 开头的路径段；并做软链接逃逸校验） */
function resolveStaticPath(pathname, root) {
  if (pathname.includes('\0')) return null;

  const rel = pathname.replace(/^\/+/, '');
  const target = path.resolve(root, rel);
  const r = path.relative(root, target);

  if (r === '') return root;
  if (r.startsWith('..') || path.isAbsolute(r)) return null;

  const segments = r.split(path.sep);
  if (segments.some((seg) => seg.startsWith('.'))) return null;

  // 符号链接可能把路径带出 root，必须按真实路径再验一次
  if (assertRealPathUnder(root, target) !== true) return null;

  return target;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  [04] 配置 schema 归一化 —— v1.3 扩展配置系统
 * ═══════════════════════════════════════════════════════════════════════════ */

const CONFIG_TYPES = new Set(['string', 'number', 'boolean', 'color', 'select', 'textarea', 'url']);

function defaultForType(type) {
  switch (type) {
    case 'number': return 0;
    case 'boolean': return false;
    case 'color': return '#000000';
    case 'select': return '';
    default: return '';
  }
}

/** 归一化一个 config 字段 */
function normalizeConfigField(raw, key) {
  if (raw == null) return null;

  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    const t = typeof raw;
    const field = {
      key,
      type: t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : 'string',
      label: key,
      description: '',
      default: undefined,
    };
    field.default = normalizeConfigValue(field, raw);
    return field;
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) return null;

  let type = String(raw.type || 'string').toLowerCase();
  if (!CONFIG_TYPES.has(type)) type = 'string';

  const field = {
    key,
    type,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 100) : key,
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 500) : '',
    placeholder: typeof raw.placeholder === 'string' ? raw.placeholder.trim().slice(0, 200) : '',
    default: undefined,
  };

  if (type === 'number') {
    if (Number.isFinite(raw.min)) field.min = raw.min;
    if (Number.isFinite(raw.max)) field.max = raw.max;
    if (Number.isFinite(raw.step) && raw.step > 0) field.step = raw.step;
  }

  if (type === 'select') {
    const opts = Array.isArray(raw.options) ? raw.options : [];
    const normalized = [];
    for (const o of opts) {
      if (typeof o === 'string') normalized.push({ value: o, label: o });
      else if (o && typeof o === 'object' && o.value !== undefined) {
        normalized.push({
          value: String(o.value),
          label: typeof o.label === 'string' ? o.label : String(o.value),
        });
      }
    }
    if (!normalized.length) return null;
    field.options = normalized;
  }

  if (type === 'string' || type === 'url' || type === 'textarea') {
    if (Number.isFinite(raw.maxLength) && raw.maxLength > 0) {
      field.maxLength = Math.min(Math.floor(raw.maxLength), 10000);
    }
  }

  field.default = normalizeConfigValue(field, raw.default);
  return field;
}

/** 按字段类型归一化值 */
function normalizeConfigValue(field, value) {
  const fallback = field.default !== undefined ? field.default : defaultForType(field.type);

  if (value === undefined || value === null) return fallback;

  switch (field.type) {
    case 'number': {
      let n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      if (Number.isFinite(field.min)) n = Math.max(field.min, n);
      if (Number.isFinite(field.max)) n = Math.min(field.max, n);
      return n;
    }
    case 'boolean':
      return Boolean(value);

    case 'color': {
      const c = sanitizeCssColor(value);
      return c || fallback;
    }

    case 'select': {
      const s = String(value);
      if (Array.isArray(field.options) && field.options.some((o) => o.value === s)) return s;
      if (Array.isArray(field.options) && field.options.length) return field.options[0].value;
      return fallback;
    }

    default: {
      let s = String(value);
      if (Number.isFinite(field.maxLength) && field.maxLength > 0) s = s.slice(0, field.maxLength);
      return s;
    }
  }
}

/**
 * 从 js.json + index.js + 用户配置构建完整 config
 * 优先级：index.js.config > js.json.config > 用户配置覆盖
 */
function buildExtConfig(jsCfg, server, userCfg) {
  const raw = {};

  if (jsCfg?.config && typeof jsCfg.config === 'object' && !Array.isArray(jsCfg.config)) {
    Object.assign(raw, jsCfg.config);
  }
  if (server?.config && typeof server.config === 'object' && !Array.isArray(server.config)) {
    Object.assign(raw, server.config);
  }

  const fields = [];
  const byKey = {};

  for (const [key, val] of Object.entries(raw)) {
    if (!PATTERN.configKey.test(key)) continue;
    const field = normalizeConfigField(val, key);
    if (!field) continue;
    fields.push(field);
    byKey[key] = field;
  }

  const values = {};
  const userValues = {};
  const user = (userCfg && typeof userCfg === 'object' && !Array.isArray(userCfg)) ? userCfg : {};

  let hasUserValues = false;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(user, field.key)) {
      hasUserValues = true;
      const v = normalizeConfigValue(field, user[field.key]);
      values[field.key] = v;
      userValues[field.key] = v;
    } else {
      values[field.key] = field.default;
    }
  }

  return { fields, byKey, values, userValues, hasUserValues };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  [05] App 状态容器 —— 唯一可变状态入口
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 所有可变状态集中在这里。
 * 任何函数想读写状态，必须显式接收 App 作为第一个参数。
 */
const App = {
  /* ── CLI 与路径 ── */
  cli: null,
  cwd: '',
  configPath: '',

  /* ── server.json ── */
  cfg: null,
  cfgStamp: null,
  cfgFound: false,
  cfgVersion: 0,

  /* ── 扩展系统 ── */
  ext: {
    list: [],
    stamp: null,
    version: 0,
    lastCheck: 0,
  },

  /* ── 扫描缓存 ── */
  scan: {
    at: 0,
    cfgVersion: -1,
    extVersion: -1,
    files: null,
    dirMeta: null,
  },

  /* ── 警告去重 ── */
  warnedMeta: new Set(),

  /* ── HTML 渲染缓存 ── */
  /* ── 子页扩展策略缓存 ── */
  pageExtCache: {
    version: '',
    policies: null,
  },

  htmlCache: {
    version: '',
    map: new Map(),
  },

  /* ── HTTP server 引用 ── */
  server: null,
};

/* ═══════════════════════════════════════════════════════════════════════════
 *  [06] 配置文件层 —— server.json 加载与热重载
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 读取并解析配置文件 */
function loadConfigFile(configPath, explicit) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (explicit) console.warn(`  ⚠  找不到配置文件 ${configPath}，使用默认配置`);
    } else {
      console.warn(`  ⚠  无法读取配置文件 ${configPath}：${err.message}`);
    }
    return { data: null, found: false };
  }

  let data;
  try {
    data = parseJson(text);
  } catch (err) {
    console.warn(`  ⚠  配置文件 ${configPath} 解析失败：${err.message}`);
    return { data: null, found: true };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.warn(`  ⚠  配置文件 ${configPath} 必须是一个 JSON 对象，已忽略`);
    return { data: null, found: true };
  }

  return { data, found: true };
}

/** 把用户配置合并到默认配置上 */
/** 规范化 home 路由里的路径：加前导斜杠、去尾部斜杠 */
function normalizeRoutePath(p) {
  let s = String(p || '').trim();
  if (!s) return '';
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** 归一化一条 home 路由；无效返回 null */
function normalizeHomeRoute(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const file = typeof raw.file === 'string' ? raw.file.trim() : '';
  if (!file) return null;

  const route = {
    file,
    applyExtensions: typeof raw.applyExtensions === 'boolean' ? raw.applyExtensions : null,
    match: null,
  };

  if (raw.match && typeof raw.match === 'object' && !Array.isArray(raw.match)) {
    const m = raw.match;
    const cond = {};

    if (typeof m.path === 'string' && m.path.trim()) {
      cond.path = normalizeRoutePath(m.path);
    }

    if (typeof m.host === 'string' && m.host.trim()) {
      cond.host = [m.host.trim().toLowerCase()];
    } else if (Array.isArray(m.host)) {
      const list = m.host
        .filter((x) => typeof x === 'string' && x.trim())
        .map((x) => x.trim().toLowerCase());
      if (list.length) cond.host = list;
    }

    if (typeof m.env === 'string' && m.env.trim()) {
      cond.env = m.env.trim();
      const v = m.value;
      cond.value = v === undefined || v === null ? '' : String(v);
    }

    if (Object.keys(cond).length) route.match = cond;
  }

  return route;
}

/** 检查一条路由是否匹配当前请求 */
function routeMatches(route, req, pathname) {
  if (!route.match) return true;   // 无 match 条件 → 总是匹配

  const m = route.match;

  if (m.path && pathname !== m.path) return false;

  if (m.host && m.host.length) {
    const hostHeader = String(req.headers.host || '').split(':')[0].toLowerCase();
    if (!m.host.includes(hostHeader)) return false;
  }

  if (m.env) {
    const val = process.env[m.env];
    if (val === undefined || String(val) !== m.value) return false;
  }

  return true;
}

/**
 * 匹配当前请求应该用哪个 home 路由。
 * 命中返回 { file, applyExtensions, match }，否则 null。
 */
function matchHomeRoute(req, pathname, cfg) {
  let p = pathname;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

  const routes = (cfg.home && cfg.home.routes) || [];

  for (const route of routes) {
    if (!route.file) continue;
    if (routeMatches(route, req, p)) return route;
  }

  // 兜底：v1.7 的顶层 home 配置，只对根路径 / 生效
  // 非 / 路径若未被 routes 显式匹配，交还静态文件处理
  if (p === '/' && cfg.home && cfg.home.enabled && cfg.home.file) {
    return {
      file: cfg.home.file,
      applyExtensions: cfg.home.applyExtensions,
      match: null,
    };
  }

  return null;
}

function buildConfig(cli, configPath) {
  const cwd = process.cwd();
  const { data: fileCfg, found: configFound } = loadConfigFile(configPath, Boolean(cli.config));

  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // 收集被静默修正/丢弃的配置项，启动时统一提示，避免「改了配置没生效」的无从排查
  const cfgWarnings = [];
  const warnCfg = (key, val, why) => {
    const shown = typeof val === 'object' ? JSON.stringify(val) : String(val);
    cfgWarnings.push(`${key} = ${shown}  ${why}`);
  };
  const clampPort = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    const i = Math.floor(n);
    return i > 65535 ? 65535 : i;
  };

  /* ── 数值与字符串 ── */
  if (fileCfg) {
    if (fileCfg.port !== undefined) {
      const p = clampPort(fileCfg.port);
      if (p === null) warnCfg('port', fileCfg.port, `不是合法数字，已回落 ${cfg.port}`);
      else if (p !== Number(fileCfg.port)) { cfg.port = p; warnCfg('port', fileCfg.port, `超出范围，已修正为 ${p}`); }
      else cfg.port = p;
    }
    if (fileCfg.depth !== undefined) {
      const d = toInt(fileCfg.depth, null);
      if (d === null) warnCfg('depth', fileCfg.depth, `不是合法数字，已回落 ${cfg.depth}`);
      else cfg.depth = d;
    }
    if (fileCfg.host !== undefined && !(typeof fileCfg.host === 'string' && fileCfg.host.trim())) {
      warnCfg('host', fileCfg.host, '不是非空字符串，已忽略');
    } else if (typeof fileCfg.host === 'string' && fileCfg.host.trim()) {
      cfg.host = fileCfg.host.trim();
    }
  }
  if (cli.port !== undefined) {
    const p = clampPort(cli.port);
    if (p !== null) cfg.port = p;
  }
  if (cli.depth !== undefined) cfg.depth = toInt(cli.depth, cfg.depth);
  if (cli.host !== undefined) {
    const h = String(cli.host).trim();
    if (h) cfg.host = h;
  }

  /* ── root ── */
  if (cli.root !== undefined) {
    cfg.root = path.resolve(cwd, String(cli.root));
  } else if (fileCfg && typeof fileCfg.root === 'string' && fileCfg.root.trim()) {
    cfg.root = path.resolve(path.dirname(configPath), fileCfg.root.trim());
  } else {
    cfg.root = cwd;
  }

  /* ── site ── */
  if (fileCfg?.site !== undefined && !(typeof fileCfg.site === 'object' && !Array.isArray(fileCfg.site) && fileCfg.site !== null)) {
    warnCfg('site', fileCfg.site, '不是 JSON 对象，已忽略');
  }
  if (fileCfg?.site && typeof fileCfg.site === 'object' && !Array.isArray(fileCfg.site)) {
    const s = fileCfg.site;
    if (s.accent !== undefined && !sanitizeCssColor(s.accent)) {
      warnCfg('site.accent', s.accent, '不是合法颜色值，已忽略');
    }
    if (typeof s.title === 'string') cfg.site.title = s.title.trim().slice(0, 200);
    if (typeof s.description === 'string') cfg.site.description = s.description.trim().slice(0, 1000);
    if (typeof s.logo === 'string') cfg.site.logo = s.logo.trim().slice(0, 16);
    if (typeof s.footer === 'string') cfg.site.footer = s.footer.trim().slice(0, 500);
    const accent = sanitizeCssColor(s.accent);
    if (accent) cfg.site.accent = accent;
    if (typeof s.showStats === 'boolean') cfg.site.showStats = s.showStats;
  }

  /* ── extensions ── */
  if (fileCfg?.extensions && typeof fileCfg.extensions === 'object' && !Array.isArray(fileCfg.extensions)) {
    const e = fileCfg.extensions;
    if (typeof e.enabled === 'boolean') cfg.extensions.enabled = e.enabled;
    if (typeof e.dir === 'string' && e.dir.trim()) {
      const dir = e.dir.trim();
      if (!dir.includes('/') && !dir.includes('\\') && dir !== '.' && dir !== '..') {
        cfg.extensions.dir = dir;
      }
    }
    if (Number.isFinite(e.timeout) && e.timeout >= 0) {
      cfg.extensions.timeout = Math.min(Math.floor(e.timeout), 60000);
    }

    if (Number.isFinite(e.fetchTimeout) && e.fetchTimeout >= 0) {
      cfg.extensions.fetchTimeout = Math.min(Math.floor(e.fetchTimeout), 300000);
    }
    if (typeof e.configFile === 'string' && e.configFile.trim()) {
      const cf = e.configFile.trim();
      if (!cf.includes('/') && !cf.includes('\\') && cf !== '.' && cf !== '..') {
        cfg.extensions.configFile = cf;
      }
    }
  }


  /* ── home ── */
  if (fileCfg?.home && typeof fileCfg.home === 'object' && !Array.isArray(fileCfg.home)) {
    const h = fileCfg.home;
    if (typeof h.enabled === 'boolean') cfg.home.enabled = h.enabled;
    if (typeof h.file === 'string') cfg.home.file = h.file.trim();
    if (typeof h.applyExtensions === 'boolean') cfg.home.applyExtensions = h.applyExtensions;

    /* v1.8: 多主页路由 */
    if (Array.isArray(h.routes)) {
      cfg.home.routes = h.routes.map(normalizeHomeRoute).filter(Boolean);
    }
  }

  /* v2.8.2: home.routes 的 match.env 必须配 value —— 否则永远不命中且无提示 */
  if (Array.isArray(cfg.home.routes)) {
    cfg.home.routes.forEach((route, i) => {
      const m = route && route.match;
      if (!m || !m.env) return;
      if (m.value === undefined || m.value === null || String(m.value) === '') {
        warnCfg(
          `home.routes[${i}].match.env`,
          m.env,
          `—— 配了 env 却没有 value，该路由永远不会命中（env 需与 value 成对使用）`
        );
      }
    });
  }

  /* ── api ── */
  if (fileCfg?.api && typeof fileCfg.api === 'object' && !Array.isArray(fileCfg.api)) {
    const a = fileCfg.api;
    if (typeof a.enabled === 'boolean') cfg.api.enabled = a.enabled;
    if (typeof a.writable === 'boolean') cfg.api.writable = a.writable;

    if (a.fs && typeof a.fs === 'object' && !Array.isArray(a.fs)) {
      const f = a.fs;
      if (typeof f.read === 'boolean') cfg.api.fs.read = f.read;
      if (typeof f.write === 'boolean') cfg.api.fs.write = f.write;
      if (Number.isFinite(f.maxReadSize) && f.maxReadSize > 0) {
        cfg.api.fs.maxReadSize = Math.min(Math.floor(f.maxReadSize), 100 * 1024 * 1024);
      }
      if (Number.isFinite(f.maxWriteSize) && f.maxWriteSize > 0) {
        cfg.api.fs.maxWriteSize = Math.min(Math.floor(f.maxWriteSize), 50 * 1024 * 1024);
      }
      if (Number.isFinite(f.maxListEntries) && f.maxListEntries > 0) {
        cfg.api.fs.maxListEntries = Math.min(Math.floor(f.maxListEntries), 50000);
      }
    }
  }

  /* ── cache ── */
  if (fileCfg?.cache && typeof fileCfg.cache === 'object' && !Array.isArray(fileCfg.cache)) {
    if (typeof fileCfg.cache.html === 'boolean') cfg.cache.html = fileCfg.cache.html;

    function clampTtl(v, min, max) {
      const x = Number(v);
      if (!Number.isFinite(x)) return null;
      return Math.max(min, Math.min(max, Math.floor(x)));
    }

    const extTtl = clampTtl(fileCfg.cache.extTtl, 100, 60000);
    if (extTtl !== null) cfg.cache.extTtl = extTtl;

    const scanTtl = clampTtl(fileCfg.cache.scanTtl, 100, 60000);
    if (scanTtl !== null) cfg.cache.scanTtl = scanTtl;

    const cfgTtl = clampTtl(fileCfg.cache.cfgTtl, 0, 60000);
    if (cfgTtl !== null) cfg.cache.cfgTtl = cfgTtl;
  }

  /* ── pageExt ── */
  if (fileCfg?.pageExt && typeof fileCfg.pageExt === 'object' && !Array.isArray(fileCfg.pageExt)) {
    const p = fileCfg.pageExt;
    if (typeof p.enabled === 'boolean') cfg.pageExt.enabled = p.enabled;
    if (typeof p.file === 'string' && p.file.trim()) {
      const f = p.file.trim();
      if (!f.includes('/') && !f.includes('\\') && f !== '.' && f !== '..') {
        cfg.pageExt.file = f;
      }
    }
  }

  /* ── 忽略规则与扩展名（兼容旧的 extensions_ 字段） ── */
  if (fileCfg) {
    if (Array.isArray(fileCfg.ignoreDirs)) {
      cfg.ignoreDirs = fileCfg.ignoreDirs
        .filter((x) => typeof x === 'string' && x.trim())
        .map((x) => x.trim());
    }
    if (Array.isArray(fileCfg.ignoreFiles)) {
      cfg.ignoreFiles = fileCfg.ignoreFiles
        .filter((x) => typeof x === 'string' && x.trim())
        .map((x) => x.trim());
    }
    const htmlExtSrc = fileCfg.htmlExtensions || fileCfg.extensions_;
    if (Array.isArray(htmlExtSrc)) {
      const exts = htmlExtSrc
        .filter((x) => typeof x === 'string' && x.trim())
        .map((x) => {
          let v = x.trim().toLowerCase();
          if (v && !v.startsWith('.')) v = '.' + v;
          return v;
        });
      if (exts.length) cfg.htmlExtensions = exts;
    }
  }

  return { cfg, configFound, warnings: cfgWarnings };
}

/** 打印配置热重载日志 */
function logConfigReload(prev, next) {
  const changes = [];

  if (prev.root !== next.root) changes.push(`root: ${prev.root} → ${next.root}`);
  if (prev.port !== next.port) changes.push(`port: ${prev.port} → ${next.port}  (需重启)`);
  if (prev.host !== next.host) changes.push(`host: ${prev.host} → ${next.host}  (需重启)`);
  if (prev.depth !== next.depth) changes.push(`depth: ${prev.depth} → ${next.depth}`);
  if (prev.site.title !== next.site.title) changes.push(`site.title: "${prev.site.title}" → "${next.site.title}"`);
  if (prev.site.description !== next.site.description) changes.push('site.description 已更新');
  if (prev.site.logo !== next.site.logo) changes.push(`site.logo: "${prev.site.logo}" → "${next.site.logo}"`);
  if (prev.site.footer !== next.site.footer) changes.push('site.footer 已更新');
  if (prev.site.accent !== next.site.accent) changes.push(`site.accent: "${prev.site.accent || '(默认)'}" → "${next.site.accent || '(默认)'}"`);
  if (prev.site.showStats !== next.site.showStats) changes.push(`site.showStats: ${prev.site.showStats} → ${next.site.showStats}`);
  if (prev.extensions.enabled !== next.extensions.enabled) changes.push(`extensions.enabled: ${prev.extensions.enabled} → ${next.extensions.enabled}`);
  if (prev.extensions.dir !== next.extensions.dir) changes.push(`extensions.dir: "${prev.extensions.dir}" → "${next.extensions.dir}"`);
  if (prev.extensions.configFile !== next.extensions.configFile) changes.push(`extensions.configFile: "${prev.extensions.configFile}" → "${next.extensions.configFile}"`);
  if (prev.api.enabled !== next.api.enabled) changes.push(`api.enabled: ${prev.api.enabled} → ${next.api.enabled}`);
  if (prev.api.writable !== next.api.writable) changes.push(`api.writable: ${prev.api.writable} → ${next.api.writable}`);
  if (prev.api.fs.read !== next.api.fs.read) changes.push(`api.fs.read: ${prev.api.fs.read} → ${next.api.fs.read}`);
  if (prev.api.fs.write !== next.api.fs.write) changes.push(`api.fs.write: ${prev.api.fs.write} → ${next.api.fs.write}`);
  if (prev.ignoreDirs.join('\u0000') !== next.ignoreDirs.join('\u0000')) changes.push(`ignoreDirs: [${next.ignoreDirs.join(', ')}]`);
  if (prev.ignoreFiles.join('\u0000') !== next.ignoreFiles.join('\u0000')) changes.push(`ignoreFiles: [${next.ignoreFiles.join(', ')}]`);
  if (prev.htmlExtensions.join('\u0000') !== next.htmlExtensions.join('\u0000')) changes.push(`HTML 扩展名: [${next.htmlExtensions.join(', ')}]`);

  const detail = changes.length ? '\n       ' + changes.join('\n       ') : '';
  console.log(`  ♻  [${ts()}] server.json 已重新加载${detail}`);
  if (changes.length) console.log('       → 刷新浏览器即可看到最新效果');
}

/** 获取当前生效配置（带热重载） */
function getConfig(app) {
  const now = Date.now();

  // 节流 stat server.json —— 间隔由 cfg.cache.cfgTtl 控制
  // 副作用：改 server.json 后最多延迟 cfgTtl 毫秒生效
  const cfgTtl = (app.cfg && app.cfg.cache && app.cfg.cache.cfgTtl) || TTL.cfg;
  if (app.cfg && now - (app.cfgLastCheck || 0) < cfgTtl) {
    return app.cfg;
  }
  app.cfgLastCheck = now;

  const stamp = fileStamp(app.configPath);

  if (app.cfg && stamp === app.cfgStamp) return app.cfg;

  const prev = app.cfg;
  const { cfg, configFound, warnings } = buildConfig(app.cli, app.configPath);

  app.cfg = cfg;
  app.cfgFound = configFound;
  app.cfgStamp = stamp;
  app.cfgVersion++;

  if (warnings && warnings.length) {
    for (const w of warnings) {
      console.warn(`  ⚠  [${ts()}] server.json 配置被修正：${w}`);
    }
  }

  if (prev) logConfigReload(prev, cfg);

  return cfg;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  [07] html.json —— 目录/文件元数据
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 从对象里取第一个非空字符串字段 */
function pickString(src, keys) {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 归一化一条元数据 */
function normalizeMetaEntry(v) {
  if (v == null) return null;

  if (typeof v === 'string') {
    const s = v.trim();
    return s ? { title: s, description: '' } : null;
  }
  if (typeof v !== 'object' || Array.isArray(v)) return null;

  const title = pickString(v, ['title', 'name', 'label', 'displayName']);
  const description = pickString(v, ['description', 'desc', 'intro', 'summary', 'note']);

  // 隐藏标记：hidden / hide / hiddenFromNav，任意真值即隐藏
  let hidden = false;
  for (const k of ['hidden', 'hide', 'hiddenFromNav', 'hideFromNav', 'unlisted']) {
    const hv = v[k];
    if (hv === true || hv === 1 || hv === 'true' || hv === 'yes') { hidden = true; break; }
  }

  // 只带 hidden 的条目也必须保留（否则无法「仅隐藏」）
  if (!title && !description && !hidden) return null;
  return { title, description, hidden };
}

/** 读取一个目录下的 html.json */
function loadDirMeta(dir, root, warnedSet) {
  const metaPath = path.join(dir, PATTERN.metaFile);

  let text;
  try { text = fs.readFileSync(metaPath, 'utf8'); } catch { return null; }

  let data;
  try {
    data = parseJson(text);
  } catch (err) {
    if (!warnedSet.has(metaPath)) {
      warnedSet.add(metaPath);
      const shown = root ? (path.relative(root, metaPath) || PATTERN.metaFile) : metaPath;
      console.warn(`  ⚠  [${ts()}] 忽略无法解析的 ${shown} — ${err.message}`);
    }
    return null;
  }

  const byFile = new Map();
  /** glob 键（含 * 或 ?）→ { glob, entry }，需在扫描时逐文件匹配 */
  const patterns = [];
  let dirTitle = '';
  let dirDescription = '';
  let dirHidden = false;

  const put = (rawKey, entry) => {
    if (!entry) return;
    const key = normalizeHtmlKey(rawKey);

    if (PATTERN.dirMetaKeys.has(key)) {
      if (entry.title) dirTitle = entry.title;
      if (entry.description) dirDescription = entry.description;
      if (entry.hidden) dirHidden = true;
      return;
    }
    if (!key) return;

    // 含通配符的键不进精确表，单独存 glob 列表
    if (key.includes('*') || key.includes('?')) {
      patterns.push({ glob: key.toLowerCase(), entry });
      return;
    }

    byFile.set(key, entry);
    const base = key.split('/').pop();
    if (base && base !== key && !byFile.has(base)) byFile.set(base, entry);
  };

  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const key = item.file || item.path || item.href || item.html || item.url || '';
      if (!normalizeHtmlKey(key)) continue;
      put(key, normalizeMetaEntry(item));
    }
  } else if (data && typeof data === 'object') {
    for (const [key, val] of Object.entries(data)) put(key, normalizeMetaEntry(val));
  }

  return { byFile, patterns, dirTitle, dirDescription, dirHidden };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  [08] 扩展系统 —— 加载 / 热重载 / ctx.fs / 钩子
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 取扩展目录的绝对路径 */
function getExtDir(cfg) {
  return path.join(cfg.root, cfg.extensions.dir);
}

/** 递归收集扩展目录的文件指纹 */
function walkExtFiles(dir, root, out, depth) {
  if (depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkExtFiles(full, root, out, depth + 1);
    } else if (ent.isFile()) {
      try {
        const st = fs.statSync(full);
        const rel = path.relative(root, full).replace(/\\/g, '/');
        out.push(`${rel}:${st.mtimeMs}:${st.size}`);
      } catch {}
    }
  }
}

/** 计算扩展目录的指纹 */
function computeExtStamp(cfg) {
  if (!cfg.extensions.enabled) return 'disabled';

  const dir = getExtDir(cfg);
  let st;
  try { st = fs.statSync(dir); } catch { return 'missing'; }
  if (!st.isDirectory()) return 'not-dir';

  const parts = [dir];
  walkExtFiles(dir, dir, parts, 0);
  parts.sort();
  return parts.join('|');
}

/**
 * 无缓存的 CommonJS 加载器，支持相对路径 require。
 * 传入 cache 使同一加载会话内共享模块实例。
 *
 * @param {string} filePath 绝对路径
 * @param {Map<string, any>} cache  模块缓存
 */
function loadModuleFromDisk(filePath, cache) {
  const abs = path.resolve(filePath);

  if (cache.has(abs)) return cache.get(abs);

  const code = fs.readFileSync(abs, 'utf8');
  const dirname = path.dirname(abs);
  const mod = { exports: {} };

  const localRequire = (spec) => {
    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      const resolved = path.resolve(dirname, spec);
      const candidates = [
        resolved,
        resolved + '.js',
        resolved + '.json',
        path.join(resolved, 'index.js'),
      ];
      for (const c of candidates) {
        try {
          const st = fs.statSync(c);
          if (!st.isFile()) continue;
          if (c.endsWith('.json')) return parseJson(fs.readFileSync(c, 'utf8'));
          return loadModuleFromDisk(c, cache);
        } catch {}
      }
      throw new Error(`Cannot find module '${spec}'`);
    }
    return require(spec);
  };

  // 提前占位：循环依赖时能拿到这个（可能还没填完的）exports 对象。
  // 不提前占位的话 A → B → A 会无限递归 —— 第一次进 A 时缓存里还没有它，
  // B 里 require('./A') 会重新编译 A。
  cache.set(abs, mod.exports);

  const wrapper = vm.compileFunction(
    code,
    ['exports', 'require', 'module', '__filename', '__dirname'],
    { filename: abs }
  );

  wrapper(mod.exports, localRequire, mod, abs, dirname);

  // 若模块用 module.exports = ... 替换了整个对象，二次覆盖缓存
  if (cache.get(abs) !== mod.exports) {
    cache.set(abs, mod.exports);
  }

  return mod.exports;
}

/** 从扩展目录安全读文件 */
function readExtFile(dir, rel) {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const resolved = fsResolveUnder(dir, rel.trim());
  if (resolved.error) return null;
  try {
    const st = fs.statSync(resolved.full);
    if (!st.isFile()) return null;
    return fs.readFileSync(resolved.full, 'utf8');
  } catch { return null; }
}

/**
 * 解析注入内容：
 *   "file.css"           → 作为文件读取
 *   "@file: path.css"    → 强制文件
 *   "inline: ..."        → 强制内联
 *   含 {} 或换行的字符串  → 内联
 */
function resolveExtContent(dir, src) {
  if (typeof src !== 'string') return '';
  if (!src.trim()) return '';

  if (src.startsWith('inline:')) return src.slice(7);
  if (src.startsWith('@file:')) return readExtFile(dir, src.slice(6).trim()) ?? '';

  const t = src.trim();
  if (t.length < 200 && !t.includes('\n') && !/[<>{}]/.test(t) && !/^[.#*@]/.test(t)) {
    const content = readExtFile(dir, t);
    if (content != null) return content;
  }

  return src;
}

/** 加载单个扩展 */
/** 归一化扩展 scope。null = 无限制（全部允许） */
function normalizeScope(raw) {
  if (!raw) return null;

  if (Array.isArray(raw)) {
    const paths = raw.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    return paths.length ? { paths, exclude: [] } : null;
  }
  if (typeof raw !== 'object') return null;

  const paths = Array.isArray(raw.paths)
    ? raw.paths.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    : [];
  const exclude = Array.isArray(raw.exclude)
    ? raw.exclude.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    : [];

  if (!paths.length && !exclude.length) return null;
  return { paths, exclude };
}

/** 解析 js.list.json，返回 [{ id, scope }] */
function parseListEntries(listData) {
  const out = [];
  const push = (id, rawScope) => {
    if (typeof id !== 'string') return;
    const name = id.trim();
    if (!name) return;
    out.push({ id: name, scope: normalizeScope(rawScope) });
  };

  if (Array.isArray(listData)) {
    for (const item of listData) {
      if (typeof item === 'string') {
        push(item, null);
      } else if (item && typeof item === 'object') {
        const id = item.id || item.name;
        if (item.scope !== undefined) push(id, item.scope);
        else if (item.paths !== undefined || item.exclude !== undefined) push(id, item);
        else push(id, null);
      }
    }
    return out;
  }

  if (!listData || typeof listData !== 'object') return out;

  if (listData.extensions !== undefined) return parseListEntries(listData.extensions);
  if (listData.list !== undefined) return parseListEntries(listData.list);

  for (const [id, val] of Object.entries(listData)) push(id, val);
  return out;
}

/* ── 路径归一化工具（v2.7）──────────────────────────────────────────────
 * NavExt 内部存在两套路径体系，扩展作者极易踩坑：
 *   · URL 体系（请求侧）  ：'/docs/a.html'，首页为 '/'
 *   · 相对体系（文件侧）  ：'docs/a.html'，首页为 'index.html'
 * 下面两个函数做双向无损归一化，服务端与客户端行为保持一致。
 * 客户端同名 API：NavExt.urlToRel() / NavExt.relToUrl() / NavExt.normalizePath()
 * ────────────────────────────────────────────────────────────────────── */

/** 是否有 .html/.htm 后缀（视为"文件路径"而非目录路径） */
function hasHtmlExt(p) {
  return /\.html?$/i.test(String(p));
}

/**
 * 末段是否带文件扩展名（用于区分「文件」与「目录」）
 *   'a.md'        → true
 *   'a/b.json'    → true
 *   '.hidden'     → false   （纯隐藏文件，不算扩展名）
 *   'a.b/c'       → false   （扩展名必须在最后一段）
 *   'docs'        → false
 */
function hasFileExt(p) {
  const s = String(p == null ? '' : p);
  const last = s.slice(s.lastIndexOf('/') + 1);
  if (!last || last.startsWith('.')) return false;
  return /\.[a-zA-Z0-9]+$/.test(last);
}

/**
 * 去查询串/哈希，decode，压缩重复斜杠，去掉所有 './' 段。
 * 不做大小写转换（大小写敏感文件系统上不能丢信息）。
 */
function cleanPathInput(p) {
  let s = String(p == null ? '' : p);
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  try { s = decodeURIComponent(s); } catch { /* 非法转义：保留原样 */ }
  s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  // 去掉所有 './' 段（开头与中间）
  s = s.replace(/(^|\/)\.\//g, '$1');
  while (s.startsWith('../')) s = s.slice(3);
  return s;
}

/**
 * URL 路径 → 相对路径（供与 getFiles()[].path 对齐）
 *   '/docs/a.html' → 'docs/a.html'
 *   '/docs/'       → 'docs/index.html'
 *   '/'            → 'index.html'
 *   'docs/a.html'  → 'docs/a.html'   （已是相对路径则原样规范）
 *   '/docs/a.md'   → 'docs/a.md'     （任意扩展名的文件都原样保留）
 *   'index.html'   → 'index.html'
 *
 * @param {string} p
 * @param {string} [indexName='index.html'] 目录默认文件名
 */
function urlToRel(p, indexName) {
  const idx = indexName || 'index.html';
  let s = cleanPathInput(p);
  const isUrl = String(p == null ? '' : p).charAt(0) === '/' || s === '' || s.charAt(0) === '/';
  s = s.replace(/^\/+/, '');

  if (s === '') return isUrl ? idx : '';
  if (s.endsWith('/')) return s + idx;
  // 只要末段带扩展名，就是文件（.html / .md / .json / .css … 一视同仁）
  if (hasFileExt(s)) return s;
  // 无扩展名：请求侧是"目录/站点别名"，文件侧补默认文档名
  if (isUrl) return s + '/' + idx;
  return s;
}

/**
 * 相对路径 → URL 路径
 *   'docs/a.html' → '/docs/a.html'
 *   'index.html'  → '/'
 *   ''            → '/'
 *   '/docs/a.html'→ '/docs/a.html'（已是 URL 则原样规范）
 *   'docs'        → '/docs'
 *
 * @param {string} p
 * @param {string} [indexName='index.html']
 */
function relToUrl(p, indexName) {
  const idx = indexName || 'index.html';
  let s = cleanPathInput(p);
  const alreadyUrl = String(p == null ? '' : p).charAt(0) === '/';
  s = s.replace(/^\/+/, '');

  if (s === '') return '/';
  if (s === idx) return '/';
  if (s.endsWith('/' + idx)) return '/' + s.slice(0, -idx.length);
  return '/' + s;
}

/** 归一化成"可比较的 key"（仅用于相等/包含判断，不产生新路径） */
function normalizePathKey(p, indexName) {
  return urlToRel(p, indexName).toLowerCase();
}

/**
 * 把任意一侧的路径统一到 URL 体系。已是 URL 则原样（首页保持 '/'）。
 * 供扩展 ctx.pathOf() 使用。
 */
function toUrlPath(p, indexName) {
  const raw = String(p == null ? '' : p);
  if (raw.charAt(0) === '/') return relToUrl(urlToRel(raw, indexName), indexName);
  return relToUrl(raw, indexName);
}

/** 判断扩展是否匹配当前请求路径。无 scope = 全部允许 */
function extMatchesScope(ext, pathname) {
  if (!ext || !ext.scope) return true;

  const { paths, exclude } = ext.scope;
  let p = String(pathname || '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

  if (exclude && exclude.length) {
    for (const pat of exclude) {
      if (matchGlob(p, pat) || matchGlob(p + '/', pat)) return false;
    }
  }
  if (!paths || !paths.length) return true;

  for (const pat of paths) {
    if (matchGlob(p, pat) || matchGlob(p + '/', pat)) return true;
  }
  return false;
}

/** 把请求 pathname 映射成"从 root 到最深目录"的绝对路径链 */
function pathnameToDirChain(root, pathname) {
  const dirs = [root];
  const segs = String(pathname || '/').replace(/^\/+/, '').split('/').filter(Boolean);
  let acc = root;
  for (const seg of segs) {
    if (/\.[a-z0-9]+$/i.test(seg)) break;
    acc = path.join(acc, seg);
    dirs.push(acc);
  }
  return dirs;
}

/** 读取单个 jsx.json，返回 { enable, disable } 或 null */
function readPageExtFile(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }

  let data;
  try { data = parseJson(text); }
  catch (err) {
    console.warn(`  ⚠  [${ts()}] 忽略无法解析的 ${path.basename(filePath)} — ${err.message}`);
    return null;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const toSet = (v) => {
    if (!Array.isArray(v)) return null;
    const s = new Set();
    for (const x of v) {
      if (typeof x === 'string' && x.trim()) s.add(x.trim());
    }
    return s.size ? s : null;
  };

  const enable = toSet(data.enable);
  const disable = toSet(data.disable);
  if (!enable && !disable) return null;
  return { enable, disable };
}

/** 获取当前 pathname 累积的 jsx.json 策略（带缓存） */
function getPageExtPolicies(app, pathname) {
  const cfg = app.cfg || getConfig(app);
  if (!cfg || !cfg.pageExt || !cfg.pageExt.enabled) return null;

  const dirChain = pathnameToDirChain(cfg.root, pathname);
  const fileName = cfg.pageExt.file || 'jsx.json';

  const stamps = [];
  const files = [];
  for (const dir of dirChain) {
    const p = path.join(dir, fileName);
    const st = fileStamp(p);
    if (st === 'missing') continue;
    stamps.push(p + ':' + st);
    files.push(p);
  }

  const versionKey = app.cfgVersion + '|' + stamps.join('|');
  if (app.pageExtCache.version === versionKey) {
    return app.pageExtCache.policies;
  }

  const policies = [];
  for (const f of files) {
    const p = readPageExtFile(f);
    if (p) policies.push(p);
  }

  app.pageExtCache.version = versionKey;
  app.pageExtCache.policies = policies.length ? policies : null;
  return app.pageExtCache.policies;
}

/** 扩展是否被当前页面的 jsx.json 策略允许 */
function extAllowedByPage(ext, policies) {
  if (!policies || !policies.length) return true;
  for (const p of policies) {
    if (p.enable && !p.enable.has(ext.id)) return false;
    if (p.disable && p.disable.has(ext.id)) return false;
  }
  return true;
}

function loadExtension(id, jsDir, userCfgAll, moduleCache, scope) {
  const dir = path.join(jsDir, id);

  let st;
  try { st = fs.statSync(dir); }
  catch {
    console.warn(`  ⚠  [${ts()}] 扩展目录不存在：${id}`);
    return null;
  }
  if (!st.isDirectory()) {
    console.warn(`  ⚠  [${ts()}] 扩展不是目录：${id}`);
    return null;
  }

  const mod = readJsonSafe(path.join(dir, 'mod.json')) || {};
  if (mod.enabled === false) return null;

  const jsCfg = readJsonSafe(path.join(dir, 'js.json')) || {};

  let server = null;
  const serverPath = path.join(dir, 'index.js');
  if (fs.existsSync(serverPath)) {
    try { server = loadModuleFromDisk(serverPath, moduleCache); }
    catch (err) {
      console.warn(`  ⚠  [${ts()}] 扩展 ${id} 的 index.js 加载失败：${err.message}`);
      return null;
    }
  }

  const inject = { styles: [], scripts: [], head: [], header: [], footer: [] };

  const push = (key, src) => {
    if (!src) return;
    const items = Array.isArray(src) ? src : [src];
    for (const item of items) {
      const content = resolveExtContent(dir, item);
      if (content) inject[key].push(content);
    }
  };

  if (jsCfg && typeof jsCfg === 'object') {
    for (const key of Object.keys(inject)) push(key, jsCfg[key]);
  }
  if (server && typeof server === 'object') {
    for (const key of Object.keys(inject)) push(key, server[key]);
  }

  const userCfg = (userCfgAll && userCfgAll[id]) || null;
  const config = buildExtConfig(jsCfg, server, userCfg);

  const requires = Array.isArray(mod.requires)
    ? mod.requires.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    : [];

  const statsFn = (server && typeof server.stats === 'function') ? server.stats : null;

  return {
    id,
    requires,
    stats: statsFn,
    name: typeof mod.name === 'string' && mod.name.trim() ? mod.name.trim() : id,
    description: typeof mod.description === 'string' ? mod.description.trim() : '',
    version: typeof mod.version === 'string' ? mod.version.trim() : '',
    author: typeof mod.author === 'string' ? mod.author.trim() : '',
    order: Number.isFinite(Number(mod.order)) ? Number(mod.order) : 100,
    // v2.8.2：CSS 覆盖顺序独立于加载顺序。
    //   未声明 cssOrder → 回退到 order（与旧行为完全一致）
    //   显式声明       → 完全按 cssOrder，不受 order / requires 影响
    cssOrder: Number.isFinite(Number(mod.cssOrder))
      ? Number(mod.cssOrder)
      : (Number.isFinite(Number(mod.order)) ? Number(mod.order) : 100),
    dir,
    inject,
    server,
    config,
    scope: scope || null,
    core: mod.core === true,   // 仅 core 扩展可经 ctx.os 拿到特权通道
  };
}

/** 从 js.list.json 加载全部扩展 */
/** 拓扑排序：按 order 为主序，把依赖提前；缺依赖/成环的扩展跳过 */
function topoSortExtensions(candidates) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const allIds = new Set(candidates.map((c) => c.id));

  const ordered = candidates.slice().sort((a, b) =>
    (a.order - b.order) || a.id.localeCompare(b.id)
  );

  const result = [];
  const visited = new Set();
  const visiting = new Set();
  const skipped = new Set();

  function visit(id, path) {
    if (visited.has(id)) return true;
    if (skipped.has(id)) return false;

    if (visiting.has(id)) {
      console.warn(`  ⚠  [${ts()}] 扩展依赖成环：${path.concat(id).join(' → ')}，跳过 ${id}`);
      skipped.add(id);
      return false;
    }

    const c = byId.get(id);
    if (!c) return false;

    visiting.add(id);

    for (const dep of c.requires) {
      if (!allIds.has(dep)) {
        console.warn(`  ⚠  [${ts()}] 扩展 ${id} 缺少依赖 ${dep}，跳过`);
        skipped.add(id);
        visiting.delete(id);
        return false;
      }
      if (!visit(dep, path.concat(id))) {
        skipped.add(id);
        visiting.delete(id);
        return false;
      }
    }

    visiting.delete(id);
    visited.add(id);
    result.push(id);
    return true;
  }

  for (const c of ordered) visit(c.id, []);
  return result;
}

function loadExtensions(cfg) {
  if (!cfg.extensions.enabled) return [];

  const jsDir = getExtDir(cfg);
  const listPath = path.join(jsDir, 'js.list.json');
  const listData = readJsonSafe(listPath);

  if (!listData) {
    if (fs.existsSync(listPath)) {
      console.warn(`  ⚠  [${ts()}] ${path.relative(cfg.root, listPath)} 解析失败`);
    }
    return [];
  }

  const entries = parseListEntries(listData);

  // 阶段 1：读每个 mod.json，收集候选（含 requires / order）
  const candidates = [];
  for (const entry of entries) {
    const name = entry.id;
    if (name.includes('/') || name.includes('\\') || name.startsWith('.') || !PATTERN.extId.test(name)) {
      console.warn(`  ⚠  [${ts()}] 扩展名不合法：${name}`);
      continue;
    }

    const dir = path.join(jsDir, name);
    let st;
    try { st = fs.statSync(dir); }
    catch {
      console.warn(`  ⚠  [${ts()}] js.list.json 引用的扩展不存在：${name}`);
      continue;
    }
    if (!st.isDirectory()) continue;

    const mod = readJsonSafe(path.join(dir, 'mod.json')) || {};
    if (mod.enabled === false) continue;

    const requires = Array.isArray(mod.requires)
      ? mod.requires.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      : [];
    const order = Number.isFinite(Number(mod.order)) ? Number(mod.order) : 100;

    candidates.push({ id: name, scope: entry.scope, requires, order });
  }

  // 阶段 2：拓扑排序（缺依赖 / 成环的会被跳过）
  const sortedIds = topoSortExtensions(candidates);

  // 阶段 3：加载
  const userCfgAll = loadUserConfig(cfg);
  const moduleCache = new Map();
  const result = [];
  const byId = new Map(candidates.map((c) => [c.id, c]));

  for (const id of sortedIds) {
    const c = byId.get(id);
    if (!c) continue;
    const ext = loadExtension(id, jsDir, userCfgAll, moduleCache, c.scope);
    if (ext) result.push(ext);
  }

  return result;
}
function getUserConfigPath(cfg) {
  return path.join(cfg.root, cfg.extensions.dir, cfg.extensions.configFile);
}

/** 读取用户配置（按扩展 ID 分组） */
function loadUserConfig(cfg) {
  const data = readJsonSafe(getUserConfigPath(cfg));
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return data;
}

/** 保存用户配置 */
function saveUserConfig(cfg, data) {
  const p = getUserConfigPath(cfg);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeJson(p, data);
}

/**
 * 为扩展构造 ctx.project（只读、限定在站点根目录内）
 *
 * 与 ctx.fs 的分工：
 *   ctx.fs      —— 扩展自己的目录，可读可写
 *   ctx.project —— 站点项目目录，只读
 *
 * 校验规则与静态资源服务（resolveStaticPath）保持一致：
 *   1. 不得越出 root；
 *   2. 路径中任一段以 '.' 开头即拒绝（.js/ / .git/ / .navext.client.js 等）；
 *   3. 软链接不得逃逸 root（由 fsResolveUnder 的真实路径校验兜底）。
 *
 * 这样"扩展能读到的文件"恰好等于"静态服务器愿意暴露的文件"，
 * 不会因为多了个 API 而扩大攻击面。
 */
function makeProjectFs(root, defaultMaxBytes) {
  const MAX = defaultMaxBytes || 4 * 1024 * 1024;

  /** 解析并校验；失败返回 { error }，成功返回 { full, rel } */
  function resolve(rel) {
    const r = fsResolveUnder(root, rel || '');
    if (r.error) return r;
    // 与静态资源同一套规则：任何以 '.' 开头的路径段都不可见
    if (r.rel) {
      const segs = r.rel.split('/');
      for (const seg of segs) {
        if (seg.startsWith('.')) return { error: 'path 不可见（隐藏路径）' };
      }
    }
    return r;
  }

  return {
    root,

    /** 解析为绝对路径（主要给需要传给第三方库的场景） */
    path(rel) {
      const r = resolve(rel);
      if (r.error) throw new Error(r.error);
      return r.full;
    },

    exists(rel) {
      const r = resolve(rel);
      if (r.error) return false;
      try { fs.accessSync(r.full); return true; }
      catch { return false; }
    },

    /**
     * 读文件。默认 utf8，可传 'buffer' 拿 Buffer。
     * @param {string} rel
     * @param {string|{encoding?:string, maxBytes?:number}} [opts]
     */
    read(rel, opts) {
      let encoding = 'utf8';
      let maxBytes = MAX;
      if (typeof opts === 'string') encoding = opts;
      else if (opts && typeof opts === 'object') {
        if (opts.encoding) encoding = opts.encoding;
        if (Number.isFinite(opts.maxBytes)) maxBytes = opts.maxBytes;
      }

      const r = resolve(rel);
      if (r.error) throw new Error(r.error);

      let st;
      try { st = fs.statSync(r.full); }
      catch (e) { throw new Error(`读不到 ${r.rel || '.'}：${e.code || e.message}`); }
      if (st.isDirectory()) throw new Error(`${r.rel || '.'} 是目录，不是文件`);
      if (st.size > maxBytes) {
        throw Object.assign(
          new Error(`文件 ${r.rel} 有 ${st.size} 字节，超过上限 ${maxBytes}`),
          { code: 'PROJECT_FS_TOO_LARGE' }
        );
      }

      // 'buffer' 是给 Buffer 的快捷写法，不是真实编码名
      if (encoding === 'buffer') return fs.readFileSync(r.full);
      return fs.readFileSync(r.full, encoding);
    },

    /** 列目录（默认不递归，depth=1） */
    list(rel, opts) {
      const depth = (opts && Number.isFinite(opts.depth)) ? opts.depth : 1;
      const r = resolve(rel);
      if (r.error) throw new Error(r.error);

      try {
        const st = fs.statSync(r.full);
        if (!st.isDirectory()) throw new Error(`${r.rel || '.'} 不是目录`);
      } catch (e) {
        if (e.code === 'ENOENT') throw new Error(`目录不存在：${r.rel || '.'}`);
        throw e;
      }

      const out = [];
      const walk = (dirFull, dirRel, level) => {
        let entries;
        try { entries = fs.readdirSync(dirFull, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;          // 隐藏项一律不列
          const childRel = dirRel ? `${dirRel}/${e.name}` : e.name;
          const isDir = e.isDirectory();
          out.push({ name: e.name, path: childRel, type: isDir ? 'dir' : 'file' });
          if (isDir && level < depth) walk(path.join(dirFull, e.name), childRel, level + 1);
        }
      };
      walk(r.full, r.rel, 1);
      return out;
    },

    /** 文件信息；不存在返回 null（不抛错，方便用作探测） */
    stat(rel) {
      const r = resolve(rel);
      if (r.error) throw new Error(r.error);
      let st;
      try { st = fs.statSync(r.full); }
      catch { return null; }
      return {
        path: r.rel,
        type: fsGetType(st),
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    },
  };
}

/** 为扩展构造 ctx.fs（同步、限定在扩展目录内） */
/** 扩展生命周期资源注册表：扩展重载时统一清理 */
function ensureExtDisposables(ext) {
  if (!ext._disposables) ext._disposables = new Set();
  return ext._disposables;
}

/** 注册一个待清理资源（返回一个 disposal 函数） */
function registerDisposable(ext, disposeFn) {
  const set = ensureExtDisposables(ext);
  set.add(disposeFn);
  return disposeFn;
}

/** 清理扩展的所有资源：定时器、挂起请求等 */
function disposeExt(ext) {
  // v2.7：先调用扩展自己的 onDispose（让扩展有机会收尾），再清理内核托管的资源
  if (ext.server && typeof ext.server.onDispose === 'function') {
    try {
      const c = ext._lastCtx || {};
      ext.server.onDispose(c);
    } catch (err) {
      console.warn(`  ⚠  [${ts()}] 扩展 ${ext.id} onDispose 出错：${err.message}`);
    }
  }

  if (!ext._disposables || !ext._disposables.size) return;

  for (const fn of ext._disposables) {
    try { fn(); }
    catch (err) {
      console.warn(`  ⚠  [${ts()}] 扩展 ${ext.id} 清理资源出错：${err.message}`);
    }
  }
  ext._disposables.clear();
}

function makeExtFs(extDir, opts) {
  const MAX = (opts && Number.isFinite(opts.maxReadBytes)) ? opts.maxReadBytes : 0;

  return {
    dir: extDir,
    path(rel) {
      const r = fsResolveUnder(extDir, rel || '');
      if (r.error) throw new Error(r.error);
      return r.full;
    },
    exists(rel) {
      const r = fsResolveUnder(extDir, rel || '');
      if (r.error) return false;
      try { fs.accessSync(r.full); return true; }
      catch { return false; }
    },
    /**
     * 读文件。
     * v2.8.2：与 ctx.project.read 对齐——支持 { encoding, maxBytes }，
     * 超限抛 code: 'FS_TOO_LARGE'（ctx.project 抛 PROJECT_FS_TOO_LARGE）。
     * 旧的 read(rel, encoding) 字符串写法仍然兼容。
     */
    read(rel, opts2) {
      let encoding = 'utf8';
      let maxBytes = MAX;
      if (typeof opts2 === 'string') encoding = opts2;
      else if (opts2 && typeof opts2 === 'object') {
        if (opts2.encoding) encoding = opts2.encoding;
        if (Number.isFinite(opts2.maxBytes)) maxBytes = opts2.maxBytes;
      }

      const r = fsResolveUnder(extDir, rel || '');
      if (r.error) throw new Error(r.error);

      if (maxBytes > 0) {
        let st;
        try { st = fs.statSync(r.full); }
        catch (e) { throw new Error(`读不到 ${r.rel || '.'}：${e.code || e.message}`); }
        if (st.isDirectory()) throw new Error(`${r.rel || '.'} 是目录，不是文件`);
        if (st.size > maxBytes) {
          throw Object.assign(
            new Error(`文件 ${r.rel} 有 ${st.size} 字节，超过上限 ${maxBytes}`),
            { code: 'FS_TOO_LARGE' }
          );
        }
      }

      if (encoding === 'buffer') return fs.readFileSync(r.full);
      return fs.readFileSync(r.full, encoding);
    },
    write(rel, content, encoding) {
      const r = fsResolveUnder(extDir, rel || '');
      if (r.error) throw new Error(r.error);
      if (!r.rel) throw new Error('不能写入扩展根目录');
      fs.mkdirSync(path.dirname(r.full), { recursive: true });
      fs.writeFileSync(r.full, content, encoding || 'utf8');
      return r.rel;
    },
    delete(rel) {
      const r = fsResolveUnder(extDir, rel || '');
      if (r.error) throw new Error(r.error);
      if (!r.rel) throw new Error('不能删除扩展根目录');
      fs.rmSync(r.full, { recursive: true, force: true });
      return r.rel;
    },
    /**
     * 列目录。
     * v2.8.2：与 ctx.project.list 对齐——补 path 字段、支持 opts.depth 递归。
     * 旧写法 list(rel) 仍返回同样的条目（多了 path 字段，不影响解构）。
     */
    list(rel, opts2) {
      const depth = (opts2 && Number.isFinite(opts2.depth)) ? opts2.depth : 1;
      const r = fsResolveUnder(extDir, rel || '');
      if (r.error) throw new Error(r.error);

      // 入口先校验是目录，与 ctx.project.list 行为对齐
      let rootSt;
      try { rootSt = fs.statSync(r.full); }
      catch (e) {
        if (e.code === 'ENOENT') throw new Error(`目录不存在：${r.rel || '.'}`);
        throw e;
      }
      if (!rootSt.isDirectory()) throw new Error(`${r.rel || '.'} 不是目录`);

      const out = [];
      const walk = (dirFull, dirRel, level) => {
        let entries;
        try { entries = fs.readdirSync(dirFull, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
          const childRel = dirRel ? `${dirRel}/${e.name}` : e.name;
          const isDir = e.isDirectory();
          out.push({
            name: e.name,
            path: childRel,
            type: isDir ? 'dir' : e.isFile() ? 'file' : 'other',
          });
          if (isDir && level < depth) walk(path.join(dirFull, e.name), childRel, level + 1);
        }
      };
      walk(r.full, r.rel, 1);
      return out;
    },
  };
}

/** 单个扩展级 fetch：带超时、可 abort、扩展重载时自动清理 */
function _ctxFetch(app, ext, url, opts) {
  opts = opts || {};
  const cfg = app.cfg || {};
  const defaultTimeout = (cfg.extensions && cfg.extensions.fetchTimeout) || 30000;
  const timeout = Number.isFinite(opts.timeout) ? opts.timeout : defaultTimeout;

  const controller = new AbortController();
  let timer = null;
  let cleanupSignal = null;   // 摘掉 fallback 路径挂的 listener

  const dispose = registerDisposable(ext, () => {
    try { controller.abort(); } catch {}
    if (timer) clearTimeout(timer);
    if (cleanupSignal) cleanupSignal();
  });

  // 合并用户传的 signal：优先 AbortSignal.any（Node 20.3+），否则监听 userSignal
  let mergedSignal = controller.signal;
  if (opts.signal && opts.signal !== controller.signal) {
    const userSignal = opts.signal;
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
      mergedSignal = AbortSignal.any([controller.signal, userSignal]);
    } else {
      if (userSignal.aborted) {
        try { controller.abort(userSignal.reason); } catch {}
      } else {
        const onUserAbort = () => {
          try { controller.abort(userSignal.reason); } catch {}
        };
        userSignal.addEventListener('abort', onUserAbort, { once: true });
        cleanupSignal = () => {
          try { userSignal.removeEventListener('abort', onUserAbort); } catch {}
        };
      }
    }
  }

  const fetchOpts = Object.assign({}, opts, { signal: mergedSignal });
  delete fetchOpts.timeout;

  if (timeout > 0) {
    timer = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, timeout);
  }

  // 三条出口（成功、失败、dispose）共用这段清理
  const finishCleanup = () => {
    if (timer) clearTimeout(timer);
    if (cleanupSignal) cleanupSignal();
    ext._disposables.delete(dispose);
  };

  const p = (typeof globalThis.fetch === 'function')
    ? globalThis.fetch(url, fetchOpts)
    : Promise.reject(Object.assign(new Error('当前 Node 没有 globalThis.fetch，请升级到 Node 18+'), { code: 'NO_FETCH' }));

  return p.then(
    (res) => { finishCleanup(); return res; },
    (err) => {
      finishCleanup();
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        const e = new Error(`ctx.fetch 超时或已取消 (${timeout}ms)`);
        e.code = 'EXT_FETCH_ABORT';
        throw e;
      }
      throw err;
    }
  );
}

/** 单个扩展级定时器：扩展重载时自动清理 */
function _ctxTimer(app, ext, fn, ms, isInterval, extraArgs) {
  let id;
  const dispose = registerDisposable(ext, () => {
    if (isInterval) clearInterval(id); else clearTimeout(id);
  });

  const run = () => {
    try { fn.apply(null, extraArgs || []); }
    catch (err) {
      console.warn(`  ⚠  [${ts()}] 扩展 ${ext.id} 定时器回调出错：${err.message}`);
      notifyExtError(app, ext, err, isInterval ? 'interval' : 'timer', {});
    }
  };

  if (isInterval) id = setInterval(run, ms);
  else id = setTimeout(() => { run(); ext._disposables.delete(dispose); }, ms);

  return { id, kind: isInterval ? 'interval' : 'timeout', dispose };
}

/** 构造扩展钩子的 ctx */
function makeExtCtx(app, ext, base, req) {
  // 请求体缓存（只在 onRequest 里有 req）
  let _bodyPromise = null;
  const _limit = (app.cfg && app.cfg.api && app.cfg.api.fs && app.cfg.api.fs.maxWriteSize * 2) || (1024 * 1024);
  const _readRaw = () => {
    if (!req) return Promise.reject(Object.assign(new Error(
      'readBody 只在 onRequest 钩子中可用'), { code: 400 }));
    if (_bodyPromise) return _bodyPromise;
    _bodyPromise = readRawBody(req, _limit);
    return _bodyPromise;
  };

  const ctx = Object.assign({}, base, {
    extId: ext.id,
    extDir: ext.dir,
    root: app.cfg ? app.cfg.root : '',
    configPath: app.configPath,
    config: Object.assign({}, ext.config.values),
    configSchema: ext.config.fields.slice(),
    userConfig: Object.assign({}, ext.config.userValues),
    hasUserConfig: ext.config.hasUserValues,
    scope: ext.scope,
    // v2.8.2：与 ctx.project 对齐 —— read 加上限守卫、list 补 path/depth
    fs: makeExtFs(ext.dir, {
      maxReadBytes: (app.cfg && app.cfg.api && app.cfg.api.fs && app.cfg.api.fs.maxReadSize) || 0,
    }),
    // ── 站点项目只读（v2.8）：读站点文件不必再 require('fs') ──
    project: makeProjectFs(
      app.cfg ? app.cfg.root : '',
      (app.cfg && app.cfg.extensions && app.cfg.extensions.projectMaxBytes) || undefined
    ),
    // ── 网络请求（带超时 + 扩展重载时自动 abort） ──
    fetch: (url, opts) => _ctxFetch(app, ext, url, opts),

    // ── 定时器（扩展重载时自动清理） ──
    timer: (fn, ms, ...args) => _ctxTimer(app, ext, fn, ms, false, args),
    interval: (fn, ms, ...args) => _ctxTimer(app, ext, fn, ms, true, args),
    clearTimer: (handle) => {
      if (!handle) return;
      if (handle.kind === 'interval') clearInterval(handle.id);
      else clearTimeout(handle.id);
      const set = ext._disposables;
      if (set) set.delete(handle.dispose);
    },
    readBody: _readRaw,
    readJson: () => _readRaw().then(parseJsonBody),
    log: (...args) => console.log(`  [ext:${ext.id}]`, ...args),
    warn: (...args) => console.warn(`  [ext:${ext.id}]`, ...args),

    // ── 路径归一化（v2.7）：统一 URL 体系与相对体系的割裂 ──
    pathOf: (p) => toUrlPath(p),
    urlToRel: (p) => urlToRel(p),
    relToUrl: (p) => relToUrl(p),
  });

  // 仅 core 扩展获得特权通道；普通扩展永远只有只读 project + 限目录 fs
  if (ext.core && app.os) ctx.os = app.os.forExt(app, ext);

  // 保留最近一次 ctx：扩展重载/禁用时 onDispose 需要它
  ext._lastCtx = ctx;
  return ctx;
}

/** 给 Promise 加超时（ms <= 0 表示禁用） */
function withTimeout(promise, ms, msg) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(msg || '扩展超时'), { code: 'EXT_TIMEOUT' }));
    }, ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/** 通知扩展自身的 onError 钩子 */
function notifyExtError(app, ext, err, hook, baseCtx) {
  const fn = ext.server && ext.server.onError;
  if (typeof fn !== 'function') return;
  try {
    const c = makeExtCtx(app, ext, baseCtx || {});
    c.hook = hook;
    // onError 返回 Promise 时不等待 —— 卡住的 onError 不该拖死请求
    const r = fn(err, c);
    if (r && typeof r.catch === 'function') {
      r.catch((e2) => {
        console.warn(`  ⚠  [${ts()}] 扩展 ${ext.id} onError 出错：${e2.message}`);
      });
    }
  } catch (e2) {
    console.warn(`  ⚠  [${ts()}] 扩展 ${ext.id} onError 出错：${e2.message}`);
  }
  // onError 是最后一道防线，它自己出错时不能再往上抛
}

/** 应用 onFiles 钩子 */
function applyOnFiles(app, files, ctx) {
  let result = files;
  for (const ext of app.ext.list) {
    const fn = ext.server?.onFiles;
    if (typeof fn !== 'function') continue;
    try {
      const r = fn(result, makeExtCtx(app, ext, ctx));
      if (Array.isArray(r)) result = r;
      else if (r && typeof r.then === 'function') {
        // 钩子返回 Promise：吞掉异常，避免变成 unhandledRejection
        r.catch((err) => {
          console.warn(`  ⚠  [${ts()}] 扩展 ${ext.id} onFiles 异步出错：${err.message}`);
          notifyExtError(app, ext, err, 'onFiles', ctx);
        });
      }
    } catch (err) {
      console.warn(`  ⚠  [${ts()}] 扩展 ${ext.id} onFiles 出错：${err.message}`);
      notifyExtError(app, ext, err, 'onFiles', ctx);
    }
  }
  return result;
}

/** 应用 onHtml 钩子 */
async function applyOnHtml(app, html, ctx) {
  let result = html;
  const cfg = app.cfg || getConfig(app);
  const timeout = cfg && cfg.extensions ? cfg.extensions.timeout : 0;
  const policies = getPageExtPolicies(app, ctx && ctx.pathname);
  for (const ext of app.ext.list) {
    if (!extMatchesScope(ext, ctx && ctx.pathname)) continue;
    if (!extAllowedByPage(ext, policies)) continue;
    const fn = ext.server?.onHtml;
    if (typeof fn !== 'function') continue;
    try {
      // 用 Promise.resolve 统一包裹：同步抛出与异步 reject 走同一条 catch，
      // 扩展内浮空 Promise 的异常也不会漏到进程级
      let r = await Promise.resolve(fn(result, makeExtCtx(app, ext, ctx)));
      if (r && typeof r.then === 'function') {
        r = await withTimeout(r, timeout, `扩展 ${ext.id} onHtml 超时`);
      }
      if (typeof r === 'string') result = r;
    } catch (err) {
      console.warn(`  ⚠  [${ts()}] 扩展 ${ext.id} onHtml 出错：${err.message}`);
      notifyExtError(app, ext, err, 'onHtml', ctx);
    }
  }
  return result;
}

/** 应用 onRequest 钩子（返回对象则拦截） */
async function applyOnRequest(app, req, url, ctx) {
  const cfg = app.cfg || getConfig(app);
  const timeout = cfg && cfg.extensions ? cfg.extensions.timeout : 0;
  const policies = getPageExtPolicies(app, ctx && ctx.pathname);
  for (const ext of app.ext.list) {
    if (!extMatchesScope(ext, ctx && ctx.pathname)) continue;
    if (!extAllowedByPage(ext, policies)) continue;
    const fn = ext.server?.onRequest;
    if (typeof fn !== 'function') continue;
    try {
      // 同上：同步抛出与异步 reject 统一走这条 catch
      let r = await Promise.resolve(fn(req, url, makeExtCtx(app, ext, ctx, req)));
      if (r && typeof r.then === 'function') {
        r = await withTimeout(r, timeout, `扩展 ${ext.id} onRequest 超时`);
      }
      if (r && typeof r === 'object') return r;
    } catch (err) {
      console.warn(`  ⚠  [${ts()}] 扩展 ${ext.id} onRequest 出错：${err.message}`);
      notifyExtError(app, ext, err, 'onRequest', ctx);

      // 超时是扩展的 bug，不该静默降级到后续处理 —— 返回 504 让客户端知道
      if (err && err.code === 'EXT_TIMEOUT') {
        return {
          status: 504,
          type: 'text/plain; charset=utf-8',
          body: `504 ${err.message}`,
        };
      }
    }
  }
  return null;
}

/**
 * 应用 onResponse 钩子（v2.5）—— 请求已完成后的观察者，不可改写响应。
 *
 * 与 onRequest 的区别：onRequest 在处理前、可拦截；onResponse 在响应写出后，
 * 只用于埋点/统计/日志等副作用，返回值被忽略。这样扩展能做访问统计、
 * 慢请求告警、访问日志，而不必把整个响应抢下来自己实现。
 *
 * 注意：此钩子在响应已发送后触发，绝不能尝试写 res —— 统一传一个只读快照。
 */
function applyOnResponse(app, info, baseCtx) {
  const exts = app.ext.list;
  if (!exts.length) return;

  for (const ext of exts) {
    const fn = ext.server?.onResponse;
    if (typeof fn !== 'function') continue;
    if (!extMatchesScope(ext, info.pathname)) continue;

    try {
      const ctx = makeExtCtx(app, ext, baseCtx || {});
      ctx.pathname = info.pathname;
      ctx.hook = 'onResponse';
      // 同步钩子：返回值不参与后续处理
      const r = fn(info, ctx);
      if (r && typeof r.then === 'function') {
        // 异步 onResponse 不阻塞请求收尾，异常就地吞掉
        r.then(undefined, (err) => {
          console.warn(`  ⚠  [${ts()}] 扩展 ${ext.id} onResponse 异步出错：${err.message}`);
          notifyExtError(app, ext, err, 'onResponse', baseCtx);
        });
      }
    } catch (err) {
      console.warn(`  ⚠  [${ts()}] 扩展 ${ext.id} onResponse 出错：${err.message}`);
      notifyExtError(app, ext, err, 'onResponse', baseCtx);
    }
  }
}

/**
 * 收集所有扩展的注入内容。
 *
 * v2.8.2：注入顺序与加载顺序解耦。
 *   - app.ext.list 是「加载顺序」（由 order + requires 拓扑排序决定）；
 *   - 这里按「CSS 覆盖顺序」（cssOrder，越大越晚注入 = 覆盖优先级越高）重排后
 *     再累积 styles；
 *   - scripts / head / 等其他注入仍按加载顺序（它们与覆盖语义无关，
 *     scripts 按加载顺序可预期性更好）。
 *
 * 这样 order 只影响「谁先加载」，cssOrder 只影响「谁的样式赢」，
 * 不再互相绑架。未声明 cssOrder 的扩展回退到 order，旧行为不变。
 */
function collectInjections(app, pathname) {
  const inj = { styles: [], scripts: [], head: [], header: [], footer: [] };
  const policies = getPageExtPolicies(app, pathname);

  const active = [];
  for (const ext of app.ext.list) {
    if (!extMatchesScope(ext, pathname)) continue;
    if (!extAllowedByPage(ext, policies)) continue;
    active.push(ext);
  }

  // styles 按 cssOrder 升序（值小先注入 → 值大后注入 → 后者覆盖前者）
  const byCss = active.slice().sort((a, b) => {
    const d = (a.cssOrder || 0) - (b.cssOrder || 0);
    return d || String(a.id).localeCompare(String(b.id));
  });
  for (const ext of byCss) inj.styles.push(...ext.inject.styles);

  // 其余注入按加载顺序，保持可预期
  for (const ext of active) {
    for (const key of ['scripts', 'head', 'header', 'footer']) {
      inj[key].push(...ext.inject[key]);
    }
  }
  return inj;
}

/** 获取扩展列表（带指纹缓存与热重载） */
function getExtensions(app) {
  const cfg = getConfig(app);
  const ext = app.ext;

  if (!cfg.extensions.enabled) {
    // 扩展系统被关掉时，清理所有旧扩展资源
    for (const oldExt of ext.list) {
      try { disposeExt(oldExt); } catch {}
    }
    if (ext.list.length) ext.list = [];
    return ext;
  }

  const now = Date.now();
  const extTtl = (cfg.cache && cfg.cache.extTtl) || TTL.ext;
  if (ext.list && now - ext.lastCheck < extTtl) return ext;
  ext.lastCheck = now;

  const stamp = computeExtStamp(cfg);
  if (ext.stamp === stamp) return ext;

  const prev = ext.list;
  const list = loadExtensions(cfg);

  // 旧扩展的资源全部清理（定时器、挂起请求）
  for (const oldExt of prev) {
    try { disposeExt(oldExt); }
    catch (err) { console.warn(`  ⚠  [${ts()}] 清理扩展 ${oldExt.id} 出错：${err.message}`); }
  }

  ext.list = list;
  ext.stamp = stamp;
  ext.version++;

  if (prev.length || list.length) {
    const names = list.map((e) => e.id).join(', ') || '(无)';
    console.log(`  ♻  [${ts()}] 扩展已重新加载：${list.length} 个 → ${names}`);
  }

  // 触发 onInit
  for (const e of list) {
    const fn = e.server?.onInit;
    if (typeof fn !== 'function') continue;
    try { fn(makeExtCtx(app, e, {})); }
    catch (err) {
      console.warn(`  ⚠  [${ts()}] 扩展 ${e.id} onInit 出错：${err.message}`);
      notifyExtError(app, e, err, 'onInit', {});
    }
  }

  return ext;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  [09] 扫描层 —— HTML 文件发现
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 目录是否被忽略 */
function isIgnoredDir(cfg, name) {
  const lower = name.toLowerCase();
  for (const pat of cfg.ignoreDirs) {
    const p = pat.toLowerCase();
    if (p === lower) return true;
    if ((p.includes('*') || p.includes('?')) && matchGlob(lower, p)) return true;
  }
  return false;
}

/** 文件是否被忽略 */
function isIgnoredFile(cfg, name, rel) {
  if (!cfg.ignoreFiles.length) return false;
  for (const pat of cfg.ignoreFiles) {
    if (matchGlob(name, pat) || matchGlob(rel, pat)) return true;
  }
  return false;
}

/**
 * 递归扫描 HTML。
 * 结果写入 out 数组，目录元数据写入 dirMeta。
 */
function scanHtml(app, cfg, extSet, extDirName, dir, base, depth, out, dirMeta, rootMeta) {
  if (depth > cfg.depth) return;

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  const localMeta = loadDirMeta(dir, cfg.root, app.warnedMeta);
  if (localMeta && (localMeta.dirTitle || localMeta.dirDescription)) {
    dirMeta.set(base, { title: localMeta.dirTitle, description: localMeta.dirDescription });
  }

  // 目录级隐藏：@dir 带 hidden:true → 本目录下所有文件标记隐藏（级联到子目录由递归自然继承）
  const dirHidden = !!(localMeta && localMeta.dirHidden);

  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith('.')) continue;
    if (ent.isSymbolicLink()) continue;

    // 跳过扩展目录本身
    if (ent.isDirectory() && name === extDirName && !base) continue;

    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;

    if (ent.isDirectory()) {
      if (isIgnoredDir(cfg, name)) continue;
      scanHtml(app, cfg, extSet, extDirName, full, rel, depth + 1, out, dirMeta, rootMeta);
      continue;
    }

    if (!ent.isFile()) continue;
    if (!extSet.has(path.extname(name).toLowerCase())) continue;
    if (isIgnoredFile(cfg, name, rel)) continue;

    let st;
    try { st = fs.statSync(full); } catch { continue; }

    const lname = name.toLowerCase();
    const lrel = rel.toLowerCase();

    let entry = null;
    if (localMeta) entry = localMeta.byFile.get(lname) || localMeta.byFile.get(lrel) || null;
    if (!entry && rootMeta) entry = rootMeta.byFile.get(lrel) || rootMeta.byFile.get(lname) || null;

    // glob 匹配（本地元数据优先，其次根元数据）
    if (!entry && localMeta && localMeta.patterns.length) {
      entry = matchMetaPatterns(localMeta.patterns, lname, lrel);
    }
    if (!entry && rootMeta && rootMeta.patterns.length) {
      entry = matchMetaPatterns(rootMeta.patterns, lname, lrel);
    }

    // hidden 来源：文件级（精确/glob）或目录级级联
    const hidden = dirHidden || !!(entry && entry.hidden);

    out.push({
      rel,
      name,
      dir: base,
      size: st.size,
      mtime: st.mtimeMs,
      title: entry ? entry.title : '',
      description: entry ? entry.description : '',
      hidden,
    });
  }
}

/** 在 glob 规则列表中找出第一条命中的元数据 */
function matchMetaPatterns(patterns, lname, lrel) {
  for (const p of patterns) {
    if (matchGlob(lname, p.glob) || matchGlob(lrel, p.glob)) return p.entry;
  }
  return null;
}

/** 获取当前扫描结果（带缓存与热重载） */
function getState(app, force = false) {
  const cfg = getConfig(app);
  const ext = getExtensions(app);
  const scan = app.scan;
  const now = Date.now();

  if (!force &&
      scan.files &&
      scan.cfgVersion === app.cfgVersion &&
      scan.extVersion === ext.version &&
      now - scan.at < ((cfg.cache && cfg.cache.scanTtl) || TTL.scan)) {
    return {
      cfg,
      files: scan.files,
      dirMeta: scan.dirMeta,
      configPath: app.configPath,
      configFound: app.cfgFound,
    };
  }

  const extSet = new Set(cfg.htmlExtensions);
  const files = [];
  const dirMeta = new Map();
  const rootMeta = loadDirMeta(cfg.root, cfg.root, app.warnedMeta);

  if (rootMeta && (rootMeta.dirTitle || rootMeta.dirDescription)) {
    dirMeta.set('', { title: rootMeta.dirTitle, description: rootMeta.dirDescription });
  }

  scanHtml(app, cfg, extSet, cfg.extensions.dir, cfg.root, '', 0, files, dirMeta, rootMeta);
  files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-Hans-CN', { numeric: true }));

  const finalFiles = applyOnFiles(app, files, { root: cfg.root, configPath: app.configPath, files });

  app.scan = {
    at: now,
    cfgVersion: app.cfgVersion,
    extVersion: ext.version,
    files: finalFiles,
    dirMeta,
  };

  return { cfg, files: finalFiles, dirMeta, configPath: app.configPath, configFound: app.cfgFound };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  [10] 客户端脚本 —— 开发态读外部文件，发布态由 build.js 内联
 * ═══════════════════════════════════════════════════════════════════════════ */

/* __NAVEXT_LOADER_START__ */
// 开发态：从 .navext.client.js 读取，带 mtime 缓存，改完刷新即生效
const NAVEXT_CLIENT_FILE = path.join(__dirname, '.navext.client.js');

let _navextClientCache = null;
let _navextClientStamp = null;

function loadNavExtClient() {
  const stamp = fileStamp(NAVEXT_CLIENT_FILE);
  if (_navextClientCache !== null && stamp === _navextClientStamp) {
    return _navextClientCache;
  }
  try {
    _navextClientCache = fs.readFileSync(NAVEXT_CLIENT_FILE, 'utf8');
  } catch (err) {
    console.error(`  ✖  [${ts()}] 无法读取客户端库：${NAVEXT_CLIENT_FILE}`);
    console.error('     请确认 .navext.client.js 与 server.js 同目录');
    console.error('     或运行 node build.js 生成自包含的 server.dist.js');
    console.error(`     错误：${err.message}`);
    process.exit(1);
  }
  _navextClientStamp = stamp;
  return _navextClientCache;
}
/* __NAVEXT_LOADER_END__ */

/* ═══════════════════════════════════════════════════════════════════════════
 *  [11] 渲染层 —— renderNav / buildHtml
 * ═══════════════════════════════════════════════════════════════════════════ */


/** 构造注入 __NAV_DATA__ 的数据对象 */
function buildNavData(app, files, cfg, pathname) {
  return {
    version: SERVER_VERSION,
    files: files.map((f) => ({
      path: f.rel,
      url: '/' + encodePath(f.rel),
      dir: f.dir || '',
      name: f.name,
      title: f.title || '',
      description: f.description || '',
      size: f.size,
      mtime: f.mtime,
      // hidden 项仍下发（带标记），供扩展按需识别；核心渲染与搜索默认忽略
      hidden: !!f.hidden,
    })),
    config: {
      site: cfg.site,
      htmlExtensions: cfg.htmlExtensions,
      ignoreDirs: cfg.ignoreDirs,
      ignoreFiles: cfg.ignoreFiles,
      extensionsDir: cfg.extensions.dir,
      api: {
        fsRead: cfg.api.enabled && cfg.api.fs.read,
        fsWrite: cfg.api.enabled && cfg.api.writable && cfg.api.fs.write,
      },
    },
    extensions: app.ext.list
      .filter((e) => extAllowedByPage(e, getPageExtPolicies(app, pathname)))
      .map((e) => ({
      id: e.id,
      name: e.name,
      version: e.version,
      author: e.author,
      description: e.description,
      order: e.order,
      config: e.config.values,
      configSchema: e.config.fields,
      hasUserConfig: e.config.hasUserValues,
      scope: e.scope,
    })),
  };
}

/** 序列化为安全的 <script> 内容 */
function serializeNavData(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 构造传给 onNavPage 钩子的只读数据快照（v2.8.3）。
 *
 * 展示页扩展拿不到内核的扫描结果，需要通过这里把数据喂进去。
 * 全部字段做深拷贝 / 只读化，扩展改不动内核状态。
 */
function buildNavCtx(app, files, dirMeta, cfg, pathname) {
  const visible = files.filter((f) => !f.hidden);
  const dirKeys = new Set(visible.map((f) => f.dir || ''));

  let bytes = 0;
  for (const f of visible) bytes += f.size || 0;

  return {
    root: cfg.root,
    pathname,
    // 文件名统一用 path（与 ?format=json 输出一致），避免扩展要理解 rel 的内部命名
    files: files.map((f) => ({
      path: f.rel,
      url: '/' + encodePath(f.rel),
      dir: f.dir || '',
      name: f.name,
      title: f.title || '',
      description: f.description || '',
      size: f.size,
      mtime: f.mtime,
      hidden: !!f.hidden,
    })),
    dirs: [...dirMeta.entries()].map(([dir, info]) => ({
      dir,
      title: info.title || '',
      description: info.description || '',
    })),
    site: {
      title: cfg.site.title || '',
      description: cfg.site.description || '',
      logo: cfg.site.logo || '',
      footer: cfg.site.footer || '',
      accent: cfg.site.accent || '',
      showStats: !!cfg.site.showStats,
    },
    stats: { files: visible.length, dirs: dirKeys.size, bytes },
  };
}

/**
 * 应用 onNavPage 钩子（v2.8.3）。
 *
 * 遍历扩展，第一个返回 { html } 的胜出。全部返回 null/undefined 时
 * 内核走回退逻辑（找 index.html → 空页面）。
 *
 * 返回：{ html, extId } 或 null
 */
async function applyOnNavPage(app, navCtx, baseCtx) {
  const cfg = app.cfg || getConfig(app);
  const timeout = cfg && cfg.extensions ? cfg.extensions.timeout : 0;
  const policies = getPageExtPolicies(app, navCtx.pathname);

  for (const ext of app.ext.list) {
    if (!extMatchesScope(ext, navCtx.pathname)) continue;
    if (!extAllowedByPage(ext, policies)) continue;
    const fn = ext.server?.onNavPage;
    if (typeof fn !== 'function') continue;

    try {
      let r = await Promise.resolve(fn(makeExtCtx(app, ext, { nav: navCtx }, null)));
      if (r && typeof r.then === 'function') {
        r = await withTimeout(r, timeout, `扩展 ${ext.id} onNavPage 超时`);
      }
      if (r && typeof r === 'object' && typeof r.html === 'string') {
        return { html: r.html, extId: ext.id };
      }
      // 返回了对象但没有 html：视为「这个扩展不参与」，继续找下一个
    } catch (err) {
      console.warn(`  ⚠  [${ts()}] 扩展 ${ext.id} onNavPage 出错：${err.message}`);
      notifyExtError(app, ext, err, 'onNavPage', baseCtx);
    }
  }
  return null;
}

/**
 * 检查本次请求是否有扩展会提供展示页（v2.8.3）。
 *
 * 判定依据是「有没有扩展实现了 onNavPage」——不硬编码扩展 id，
 * 这样用户可以换成自己的展示页扩展，内核代码无需改动。
 */
function hasNavPageProvider(app, pathname) {
  const policies = getPageExtPolicies(app, pathname);
  for (const ext of app.ext.list) {
    if (!extMatchesScope(ext, pathname)) continue;
    if (!extAllowedByPage(ext, policies)) continue;
    if (typeof ext.server?.onNavPage === 'function') return true;
  }
  return false;
}

/**
 * 渲染导航页 HTML（v2.8.3 起：内容由扩展提供）。
 *
 * 流程：
 *   1. 装配 <head>（__NAV_DATA__ + 客户端库 + head 注入 + styles）
 *   2. 调 onNavPage 拿 <body> 内容
 *      ├─ 有扩展提供 → 用它的内容
 *      └─ 无扩展提供 → 返回 null（由调用方走回退：index.html / 空页面）
 *   3. 装配 header / footer 注入（扩展仍可往页面注入）
 *   4. 拼成完整 HTML → 过 onHtml 钩子
 */
async function renderNav(app, files, dirMeta, cfg, pathname) {
  const navCtx = buildNavCtx(app, files, dirMeta, cfg, pathname);
  const navPage = await applyOnNavPage(app, navCtx, {
    root: cfg.root, files, dirMeta, configPath: app.configPath, pathname,
  });

  if (!navPage) return null;   // 无展示页扩展 → 调用方走回退

  const SITE = cfg.site;
  const pageTitle = SITE.title || `NavExt · ${path.basename(cfg.root) || cfg.root}`;
  const accentCss = SITE.accent
    ? `--brand:${SITE.accent};--brand-ring:color-mix(in srgb,${SITE.accent} 18%,transparent);` : '';

  const inj = collectInjections(app, pathname);
  const navData = buildNavData(app, files, cfg, pathname);
  const dataJson = serializeNavData(navData);

  const headInject = [
    ...inj.head,
    inj.styles.length ? `<style>\n${inj.styles.join('\n')}\n</style>` : '',
  ].filter(Boolean).join('\n');

  const headerInject = inj.header.join('\n');

  const footerInject = [
    ...inj.footer,
    inj.scripts.length ? `<script>\n${safeScript(inj.scripts.join('\n'))}\n</script>` : '',
  ].filter(Boolean).join('\n');

  const html = buildHtml({
    pageTitle, accentCss, headInject, headerInject, footerInject,
    body: navPage.html,
    dataJson,
  });

  return applyOnHtml(app, html, { root: cfg.root, files, dirMeta, configPath: app.configPath, pathname });
}

/**
 * 未装展示页扩展时的回退（v2.8.3）。
 *
 *  ① 站点 root 下有 index.html → 按自定义主页方式服务（注入扩展）
 *  ② 没有                      → HTTP 200 + Content-Length: 0（0 字节空页面）
 *
 * 「扩展仍加载」是刻意的：other extensions 的 onInit / onFiles / onRequest
 * 照常工作，只是没有内置展示页可看。
 */
async function renderNavFallback(app, req, res, cfg, pathname) {
  // ① 站点 root 下有 index.html → 按自定义主页方式服务（注入扩展、过 onHtml）
  const { files, dirMeta } = getState(app, false);
  const html = await renderCustomHome(app, files, dirMeta, cfg,
    { file: 'index.html', applyExtensions: true, match: null }, pathname);

  if (html != null) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(html);
  }

  // ② 没有 index.html → 0 字节空页面
  //    注意：其他扩展照常加载（onInit/onFiles/onRequest 都工作），只是没内置展示页可看。
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': 0,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  return res.end();
}

/** 组装最终 HTML —— 将静态结构抽出，renderNav 只负责填数据 */
/** 渲染自定义主页（home.enabled 时走此路径） */
/** 渲染自定义主页（route 决定用哪个文件 + 是否注入扩展） */
async function renderCustomHome(app, files, dirMeta, cfg, route, pathname) {
  const file = route && route.file ? route.file : cfg.home.file;
  if (!file) return null;

  const applyExtensions = route && route.applyExtensions !== null
    ? route.applyExtensions
    : cfg.home.applyExtensions;

  const resolved = fsResolveUnder(cfg.root, file);
  if (resolved.error) {
    console.warn(`  ⚠  [${ts()}] home 文件无效：${resolved.error}`);
    return null;
  }

  let raw;
  try {
    const st = fs.statSync(resolved.full);
    if (!st.isFile()) {
      console.warn(`  ⚠  [${ts()}] home 不是文件：${resolved.rel}`);
      return null;
    }
    raw = fs.readFileSync(resolved.full, 'utf8');
  } catch (err) {
    console.warn(`  ⚠  [${ts()}] 无法读取 home 文件：${err.message}`);
    return null;
  }

  if (!applyExtensions) {
    return raw;
  }

  const inj = collectInjections(app, pathname);
  const navData = buildNavData(app, files, cfg, pathname);
  const dataJson = serializeNavData(navData);

  const headInject = [
    `<script data-ext-target="nav-data">window.__NAV_DATA__ = ${dataJson};</script>`,
    `<script data-ext-target="navext-client">\n${safeScript(loadNavExtClient())}\n</script>`,
    ...inj.head,
    inj.styles.length ? `<style>\n${inj.styles.join('\n')}\n</style>` : '',
  ].filter(Boolean).join('\n');

  const headerInject = inj.header.join('\n');

  const footerInject = [
    ...inj.footer,
    inj.scripts.length ? `<script>\n${safeScript(inj.scripts.join('\n'))}\n</script>` : '',
  ].filter(Boolean).join('\n');

  let html = raw;

  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${headInject}\n</head>`);
  } else if (/<body/i.test(html)) {
    html = html.replace(/<body/i, `<head>${headInject}</head>\n<body`);
  } else {
    html = headInject + '\n' + html;
  }

  if (headerInject) {
    if (/<body[^>]*>/i.test(html)) {
      html = html.replace(/(<body[^>]*>)/i, `$1\n${headerInject}`);
    } else {
      html = headerInject + '\n' + html;
    }
  }

  if (footerInject) {
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, `${footerInject}\n</body>`);
    } else {
      html += '\n' + footerInject;
    }
  }

  return html;
}
/**
 * 组装导航页最终 HTML（v2.8.3：body 内容由展示页扩展提供）。
 *
 * 内核只负责「装配」：<head> 里的 __NAV_DATA__、客户端库、扩展 head 注入、
 * 主题变量；以及 body 顶/底的 header/footer 注入位。
 * `<body>` 内的展示区（header/main/footer 骨架）由 onNavPage 返回的 p.body 提供。
 */
function buildHtml(p) {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-ext-page="nav">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(p.pageTitle)}</title>
<script data-ext-target="theme-boot">${THEME_BOOT_SCRIPT}</script>
${BASE_STYLE(p.accentCss)}
${p.headInject}
</head>
<body data-ext-target="body">

${p.headerInject}
${p.body}
<script data-ext-target="nav-data">window.__NAV_DATA__ = ${p.dataJson};</script>
<script data-ext-target="navext-client">
${safeScript(loadNavExtClient())}
</script>
${p.footerInject}
</body>
</html>`;
}

/**
 * 主题防闪脚本 —— 必须在 <head> 内、BASE_STYLE 之前同步执行。
 * 只做两件事：读 localStorage 设 data-theme、设 --brand。
 * 保持极短小，避免阻塞首屏渲染。
 */
const THEME_BOOT_SCRIPT = `(function(){try{
var d=document.documentElement,s=localStorage;
var t=s.getItem('navext.theme');
if(t==='dark'||t==='light')d.setAttribute('data-theme',t);
var a=s.getItem('navext.accent');
if(a&&/^#[0-9a-f]{6}$/i.test(a))d.style.setProperty('--brand',a);
}catch(e){}})();`;

/** 基础样式（常量） */
/**
 * 主题变量契约（v2.8.3 瘦身）。
 *
 * 只保留「主题变量」—— --brand / --brand-ring 与亮/暗两套基础色。
 * 展示页自己的样式（布局、卡片、搜索框等）已搬到 .js/navext-ui/styles.css。
 *
 * 为什么变量必须留在内核：其他扩展（ext-manager 的面板、各种卡片徽章）
 * 都依赖这套变量做配色。若随展示页一起搬走，没装展示页时它们会全部失效。
 */
function BASE_STYLE(accentCss) {
  // 亮/暗两套变量抽成可复用的字面量，供三档主题（跟随/亮/暗）共用。
  // 注意：--brand / --brand-ring 不写死在这里 —— 它们由 accentCss（站点配置）
  // 或防闪脚本（用户自定义）提供，末尾用 var() 兜底到默认色。
  const LIGHT_VARS = `
    --bg:#f5f6fa; --card:#ffffff; --text:#1e2430; --muted:#7a8496;
    --line:#e6e9f0; --header-bg:rgba(245,246,250,.86);
    --chip:rgba(127,127,127,.11);
    --shadow:0 1px 2px rgba(16,24,40,.04), 0 8px 20px -12px rgba(16,24,40,.25);`;

  const DARK_VARS = `
    --bg:#0f1218; --card:#171b23; --text:#e6e9ef; --muted:#8b94a6;
    --line:#252b36; --header-bg:rgba(15,18,24,.86);
    --chip:rgba(255,255,255,.08);
    --shadow:0 1px 2px rgba(0,0,0,.35), 0 8px 24px -12px rgba(0,0,0,.8);`;

  // 站点配置的主题色（若未配置则为空）
  const brandVars = accentCss || '';

  // 兜底色：仅当既无站点配置、也无用户自定义时生效。
  // 放在 :root 末尾，用 !important 之外的方式无法让"后声明的 accentCss"生效，
  // 所以这里改为「accentCss 覆盖兜底」——兜底先写，站点色后写。
  const BRAND_FALLBACK = `--brand:#4f6ef7;--brand-ring:rgba(79,110,247,.16);`;

  return `<style>
  /* 默认（跟随系统）：先铺亮色，再由媒体查询覆盖 */
  :root{
    color-scheme:light dark;
    ${BRAND_FALLBACK}
    ${brandVars}
    ${LIGHT_VARS}
  }
  /* 显式亮色：强制亮色，屏蔽媒体查询 */
  :root[data-theme="light"]{
    color-scheme:light;
    ${LIGHT_VARS}
  }
  /* 显式暗色：强制暗色 */
  :root[data-theme="dark"]{
    color-scheme:dark;
    ${DARK_VARS}
  }
  /* 跟随系统：仅在未显式指定主题时生效 */
  @media (prefers-color-scheme: dark){
    :root:not([data-theme]){
      ${DARK_VARS}
    }
  }
</style>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  [12] 静态文件 —— 响应构造与文件服务
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 发送 JSON */
function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/** 发送错误页 */
function sendError(res, code, message, tip) {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${code}</title></head>
<body style="font:15px/1.6 system-ui,-apple-system,'PingFang SC',sans-serif;
             padding:80px 24px;text-align:center;color:#333">
<h1 style="font-size:56px;margin:0 0 8px;font-weight:700">${code}</h1>
<p style="color:#888;margin:0 0 24px">${escapeHtml(message)}</p>
<p><a href="/" style="color:#4f6ef7;text-decoration:none">← 返回导航页</a></p>
${tip ? `<p style="color:#aaa;font-size:13px;margin-top:24px">${escapeHtml(tip)}</p>` : ''}
</body></html>`;
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

/**
 * 读取并解析请求体 JSON。
 * 超限时用 req.pause() 而非 destroy，让上层能把 413 响应完整发出。
 */
function readRawBody(req, limit) {
  limit = limit || 1024 * 512;
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];

    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > limit) {
        aborted = true;
        req.pause();
        reject(Object.assign(new Error('请求体过大'), { code: 413 }));
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

/** 读取并解析请求体为 JSON 对象（保留原 API） */
/** 解析 JSON 请求体文本 —— 供 readJsonBody 和 ctx.readJson 复用 */
function parseJsonBody(text) {
  const t = String(text).trim();
  if (!t) return {};
  try {
    const data = JSON.parse(t);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw Object.assign(new Error('请求体必须是 JSON 对象'), { code: 400 });
    }
    return data;
  } catch (err) {
    if (err && err.code) throw err;
    throw Object.assign(new Error('JSON 解析失败'), { code: 400 });
  }
}

function readJsonBody(req, limit) {
  return readRawBody(req, limit).then(parseJsonBody);
}

/**
 * 发送自定义响应（扩展 onRequest 用）。
 * Content-Length 强制按实际 body 长度设置，先移除用户设的再重设。
 */
function sendCustomResponse(res, r) {
  const status = Number.isFinite(r.status) ? r.status : 200;
  const headers = Object.assign({}, r.headers || {});

  let body = r.body;
  if (body === undefined || body === null) body = '';
  if (!Buffer.isBuffer(body)) body = Buffer.from(String(body));

  const hasCT = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (!hasCT) headers['Content-Type'] = r.type || 'text/plain; charset=utf-8';

  // 显式移除用户可能设置的 Content-Length（大小写不敏感），再按实际长度重设
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'content-length') delete headers[k];
  }
  headers['Content-Length'] = body.length;

  if (!headers['Cache-Control']) headers['Cache-Control'] = 'no-store';

  res.writeHead(status, headers);
  res.end(body);
}

/** 发送一个文件 */
function serveFile(req, res, filePath, st) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  const lastModified = st.mtime.toUTCString();
  const ims = req.headers['if-modified-since'];
  if (ims) {
    const imsTime = new Date(ims).getTime();
    const mtimeSec = Math.floor(st.mtimeMs / 1000) * 1000;
    if (!Number.isNaN(imsTime) && imsTime >= mtimeSec) {
      res.writeHead(304, { 'Last-Modified': lastModified });
      return res.end();
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Last-Modified': lastModified,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });

  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) sendError(res, 500, '读取文件失败');
    else res.destroy();
  });
  stream.pipe(res);
}

/** 静态文件路由 */
function serveStatic(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err) return sendError(res, 404, '找不到该文件', filePath);

    if (st.isDirectory()) {
      const idx = path.join(filePath, 'index.html');
      return fs.stat(idx, (e2, st2) => {
        if (!e2 && st2.isFile()) return serveFile(req, res, idx, st2);
        sendError(res, 404, '该目录下没有 index.html');
      });
    }

    if (!st.isFile()) return sendError(res, 404, '不是可访问的文件');
    serveFile(req, res, filePath, st);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  [13] API 路由 —— /api/* 分发
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ---- 扩展管理 ---- */

/**
 * 服务端搜索（v2.5）—— GET /api/search?q=&limit=&dir=
 *
 * 在内核里只提供"按字段匹配已扫描文件"这一最小能力。更复杂的检索
 * （全文索引、相关性排序、外部数据源）应由扩展用 onRequest 覆盖此路径实现。
 *
 * 匹配字段：name / rel / title / description / dir，全部大小写不敏感。
 * 打分：标题命中 > 文件名命中 > 路径命中 > 描述命中，命中位置越靠前分越高。
 */
function handleSearch(app, res, url) {
  // v2.8.3：搜索是展示页的配套能力 —— 没装展示页扩展时一并降级
  if (!hasNavPageProvider(app, url.pathname || '/')) {
    return sendJson(res, 404, { error: '展示页扩展未安装，搜索不可用' });
  }

  const q = (url.searchParams.get('q') || '').trim();
  const limitRaw = toInt(url.searchParams.get('limit'), 50);
  const limit = Math.min(Math.max(limitRaw || 50, 1), 500);
  // v2.8.1：新增 offset 分页。此前 limit 硬钳在 500 且无分页参数，
  // 宽泛查询命中上千条时只能拿到前 500 条，剩下的是静默丢失。
  const offsetRaw = toInt(url.searchParams.get('offset'), 0);
  const offset = Math.max(offsetRaw || 0, 0);
  const dirFilter = (url.searchParams.get('dir') || '').trim().replace(/^\/+|\/+$/g, '');

  if (!q) {
    return sendJson(res, 400, { error: '缺少查询参数 q' });
  }

  const { files } = getState(app);
  const needle = q.toLowerCase();
  const terms = needle.split(/\s+/).filter(Boolean);
  // 默认排除 hidden 项；?hidden=1 可包含
  const includeHidden = url.searchParams.has('hidden') && url.searchParams.get('hidden') !== '0';

  // 打分：越关键的字段权重越高；命中越靠前加权越大
  const scoreField = (val, weight) => {
    if (!val) return 0;
    const v = String(val).toLowerCase();
    const idx = v.indexOf(needle);
    if (idx === -1) {
      // 多词查询：所有词都出现在该字段才算命中
      if (terms.length > 1 && terms.every((t) => v.includes(t))) return weight * 0.5;
      return 0;
    }
    const posBonus = 1 / (1 + idx / 8);   // 越靠前越接近 1
    return weight * posBonus;
  };

  const scored = [];
  for (const f of files) {
    if (f.hidden && !includeHidden) continue;
    if (dirFilter && f.dir !== dirFilter) continue;

    let score = 0;
    score += scoreField(f.title, 10);
    score += scoreField(f.name, 6);
    score += scoreField(f.rel, 4);
    score += scoreField(f.description, 2);

    // 多词查询要求全部词都命中（跨字段），避免召回噪声
    if (score > 0 && terms.length > 1) {
      const hay = `${f.title}\n${f.name}\n${f.rel}\n${f.description}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
    }

    if (score > 0) scored.push({ f, score });
  }

  scored.sort((a, b) => (b.score - a.score) || a.f.rel.localeCompare(b.f.rel, 'zh-Hans-CN', { numeric: true }));

  const total = scored.length;
  const items = scored.slice(offset, offset + limit).map(({ f, score }) => ({
    rel: f.rel,
    name: f.name,
    dir: f.dir,
    title: f.title,
    description: f.description,
    size: f.size,
    mtime: f.mtime,
    score: Math.round(score * 100) / 100,
  }));

  return sendJson(res, 200, {
    query: q,
    total,
    count: items.length,
    limit,
    offset,
    // 还有下一页可取（v2.8.1 新增：offset + count < total）
    hasMore: offset + items.length < total,
    truncated: total > items.length,
    items,
  });
}

function apiExtensionsList(app, cfg) {
  const jsDir = getExtDir(cfg);
  return app.ext.list.map((e) => {
    const mod = readJsonSafe(path.join(jsDir, e.id, 'mod.json')) || {};
    return {
      id: e.id,
      name: e.name,
      description: e.description,
      version: e.version,
      author: e.author,
      order: e.order,
      enabled: mod.enabled !== false,
      hasConfig: e.config.fields.length > 0,
      hasUserConfig: e.config.hasUserValues,
      // v2.8.1：补上 scope，与 buildNavData（页面内 __NAV_DATA__）保持一致。
      // 此前只有页面内 payload 有，外部脚本 / CI 无法从本端点得知扩展作用域，
      // 排查「某扩展为什么没在这个页面生效」时看不到依据。
      scope: e.scope || null,
    };
  });
}

function apiConfigPayload(app, cfg) {
  // v2.8.1：去掉 force。原先传 true 会绕过扫描缓存，导致每个请求都全量重扫
  // 目录（2000 文件时单次 ~330ms，20 并发直接堆到 8.5s）。
  // 这里只需要 fileCount 和目录元数据，用缓存态即可；
  // 确实需要强制重扫的调用方走 ?fresh=1 / ?refresh=1（getState 已有该通路）。
  const { files, dirMeta } = getState(app);
  return {
    root: cfg.root,
    configPath: app.cfgFound ? app.configPath : null,
    site: cfg.site,
    extensions: {
      enabled: cfg.extensions.enabled,
      dir: cfg.extensions.dir,
      htmlExtensions: cfg.htmlExtensions,
      configFile: cfg.extensions.configFile,
    },
    api: cfg.api,
    ignoreDirs: cfg.ignoreDirs,
    ignoreFiles: cfg.ignoreFiles,
    dirs: [...dirMeta.entries()].map(([dir, info]) => ({
      dir,
      title: info.title || '',
      description: info.description || '',
    })),
    fileCount: files.length,
  };
}

function findExtension(app, id) {
  return app.ext.list.find((e) => e.id === id) || null;
}

function validateExtId(id) {
  if (!id) return '缺少 id';
  if (id.includes('/') || id.includes('\\') || id.startsWith('.')) return 'id 不合法';
  if (!PATTERN.extId.test(id)) return 'id 不合法';
  return null;
}

async function handleToggleExtension(app, req, res) {
  const cfg = getConfig(app);
  if (!cfg.api.writable) {
    return sendJson(res, 403, { error: '写操作已禁用' });
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, err.code || 400, { error: err.message }); }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const err = validateExtId(id);
  if (err) return sendJson(res, 400, { error: err });

  const jsDir = getExtDir(cfg);
  const extDir = path.resolve(jsDir, id);
  const r = path.relative(jsDir, extDir);
  if (r.startsWith('..') || path.isAbsolute(r)) {
    return sendJson(res, 400, { error: 'id 越界' });
  }

  const modPath = path.join(extDir, 'mod.json');
  if (!fs.existsSync(extDir) || !fs.existsSync(modPath)) {
    return sendJson(res, 404, { error: `扩展不存在或缺少 mod.json: ${id}` });
  }

  const mod = readJsonSafe(modPath) || {};

  let next;
  if (typeof body.enabled === 'boolean') next = body.enabled;
  else if (body.toggle === true) next = mod.enabled === false;
  else return sendJson(res, 400, { error: '需要 enabled: boolean 或 toggle: true' });

  mod.enabled = next;
  writeJson(modPath, mod);

  app.ext.stamp = null;
  app.ext.lastCheck = 0;
  getExtensions(app);

  return sendJson(res, 200, { ok: true, id, enabled: next });
}

/* ---- 扩展配置 ---- */

function buildExtConfigPayload(ext, cfg) {
  const userCfgAll = loadUserConfig(cfg);
  const rawUser = (userCfgAll[ext.id] && typeof userCfgAll[ext.id] === 'object' && !Array.isArray(userCfgAll[ext.id]))
    ? userCfgAll[ext.id]
    : {};

  const userValues = {};
  for (const field of ext.config.fields) {
    if (Object.prototype.hasOwnProperty.call(rawUser, field.key)) {
      userValues[field.key] = rawUser[field.key];
    }
  }

  return {
    id: ext.id,
    schema: ext.config.fields,
    values: ext.config.values,
    userValues,
    hasUserValues: ext.config.hasUserValues,
    configPath: path.relative(cfg.root, getUserConfigPath(cfg)).replace(/\\/g, '/'),
  };
}

function handleExtConfigGet(app, req, res, id) {
  const err = validateExtId(id);
  if (err) return sendJson(res, 400, { error: err });

  const ext = findExtension(app, id);
  if (!ext) return sendJson(res, 404, { error: `扩展不存在或未启用: ${id}` });

  const cfg = getConfig(app);
  return sendJson(res, 200, buildExtConfigPayload(ext, cfg));
}

async function handleExtConfigPost(app, req, res, id) {
  const cfg = getConfig(app);
  if (!cfg.api.writable) return sendJson(res, 403, { error: '写操作已禁用' });

  const err = validateExtId(id);
  if (err) return sendJson(res, 400, { error: err });

  const ext = findExtension(app, id);
  if (!ext) return sendJson(res, 404, { error: `扩展不存在或未启用: ${id}` });
  if (!ext.config.fields.length) return sendJson(res, 400, { error: '该扩展没有声明任何配置项' });

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, e.code || 400, { error: e.message }); }

  const incoming = (body.values && typeof body.values === 'object' && !Array.isArray(body.values))
    ? body.values
    : body;

  const userCfgAll = loadUserConfig(cfg);
  const prevUser = (userCfgAll[id] && typeof userCfgAll[id] === 'object' && !Array.isArray(userCfgAll[id]))
    ? userCfgAll[id]
    : {};

  const nextUser = Object.assign({}, prevUser);
  const applied = {};
  let changed = 0;

  for (const field of ext.config.fields) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field.key)) continue;
    const normalized = normalizeConfigValue(field, incoming[field.key]);
    if (nextUser[field.key] !== normalized) changed++;
    nextUser[field.key] = normalized;
    applied[field.key] = normalized;
  }

  if (!Object.keys(applied).length) {
    return sendJson(res, 400, { error: '没有可应用的字段' });
  }

  userCfgAll[id] = nextUser;
  saveUserConfig(cfg, userCfgAll);

  app.ext.stamp = null;
  app.ext.lastCheck = 0;
  getExtensions(app);

  const updated = findExtension(app, id) || ext;

  return sendJson(res, 200, Object.assign(
    { ok: true, changed, applied },
    buildExtConfigPayload(updated, cfg)
  ));
}

function handleExtConfigDelete(app, req, res, id) {
  const cfg = getConfig(app);
  if (!cfg.api.writable) return sendJson(res, 403, { error: '写操作已禁用' });

  const err = validateExtId(id);
  if (err) return sendJson(res, 400, { error: err });

  const ext = findExtension(app, id);
  if (!ext) return sendJson(res, 404, { error: `扩展不存在或未启用: ${id}` });

  const userCfgAll = loadUserConfig(cfg);
  if (userCfgAll[id]) {
    delete userCfgAll[id];
    saveUserConfig(cfg, userCfgAll);
  }

  app.ext.stamp = null;
  app.ext.lastCheck = 0;
  getExtensions(app);

  const updated = findExtension(app, id) || ext;

  return sendJson(res, 200, Object.assign(
    { ok: true, reset: true },
    buildExtConfigPayload(updated, cfg)
  ));
}

/* ---- 文件系统 ---- */

function fsHandleList(res, baseDir, relPath, url, cfg, opts = {}) {
  const resolved = fsResolveUnder(baseDir, relPath);
  if (resolved.error) return sendJson(res, 400, { error: resolved.error });

  let st;
  try { st = fs.statSync(resolved.full); }
  catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: '路径不存在', path: resolved.rel });
    if (err.code === 'EACCES') return sendJson(res, 403, { error: '无权访问', path: resolved.rel });
    return sendJson(res, 500, { error: err.message });
  }

  if (!st.isDirectory()) return sendJson(res, 400, { error: '不是目录', path: resolved.rel });

  const all = url.searchParams.get('all') === '1';
  const showHidden = all || opts.allowHiddenDefault;

  let entries;
  try { entries = fs.readdirSync(resolved.full, { withFileTypes: true }); }
  catch (err) { return sendJson(res, 500, { error: err.message }); }

  const max = cfg.api.fs.maxListEntries;
  const out = [];
  let truncated = false;

  for (const ent of entries) {
    if (!showHidden && ent.name.startsWith('.')) continue;
    const sub = path.join(resolved.full, ent.name);
    let subSt;
    try { subSt = fs.statSync(sub); } catch { continue; }

    out.push({
      name: ent.name,
      type: fsGetType(subSt),
      size: subSt.size,
      mtime: subSt.mtimeMs,
      isDir: subSt.isDirectory(),
      isFile: subSt.isFile(),
    });

    if (out.length >= max) { truncated = true; break; }
  }

  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
  });

  return sendJson(res, 200, {
    path: resolved.rel,
    entries: out,
    count: out.length,
    truncated,
  });
}

function fsHandleStat(res, baseDir, relPath, opts = {}) {
  const resolved = fsResolveUnder(baseDir, relPath);
  if (resolved.error) return sendJson(res, 400, { error: resolved.error });

  let st;
  try { st = fs.statSync(resolved.full); }
  catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: '路径不存在', path: resolved.rel });
    if (err.code === 'EACCES') return sendJson(res, 403, { error: '无权访问', path: resolved.rel });
    return sendJson(res, 500, { error: err.message });
  }

  const ext = path.extname(resolved.full).toLowerCase();
  const info = {
    path: resolved.rel,
    type: fsGetType(st),
    size: st.size,
    mtime: st.mtimeMs,
    ctime: st.ctimeMs,
    mode: st.mode & 0o777,
    ext,
    mime: MIME[ext] || 'application/octet-stream',
    isText: st.isFile() && (TEXT_EXT.has(ext) || !ext),
  };

  if (opts.base) info.base = opts.base;

  return sendJson(res, 200, info);
}

function fsHandleRead(res, baseDir, relPath, url, cfg) {
  const resolved = fsResolveUnder(baseDir, relPath);
  if (resolved.error) return sendJson(res, 400, { error: resolved.error });

  let st;
  try { st = fs.statSync(resolved.full); }
  catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: '文件不存在', path: resolved.rel });
    if (err.code === 'EACCES') return sendJson(res, 403, { error: '无权访问', path: resolved.rel });
    return sendJson(res, 500, { error: err.message });
  }

  if (st.isDirectory()) return sendJson(res, 400, { error: '路径是目录，请使用 /list' });
  if (!st.isFile()) return sendJson(res, 400, { error: '不是普通文件' });

  const max = cfg.api.fs.maxReadSize;
  const encoding = url.searchParams.get('encoding') || '';
  const ext = path.extname(resolved.full).toLowerCase();
  const isTextHint = TEXT_EXT.has(ext) || !ext;

  let truncated = false;
  let bytes;
  try {
    if (st.size > max) {
      const fd = fs.openSync(resolved.full, 'r');
      try {
        bytes = Buffer.allocUnsafe(max);
        const read = fs.readSync(fd, bytes, 0, max, 0);
        bytes = bytes.slice(0, read);
        truncated = true;
      } finally {
        fs.closeSync(fd);
      }
    } else {
      bytes = fs.readFileSync(resolved.full);
    }
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }

  let useEncoding = encoding;
  if (!useEncoding) useEncoding = isTextHint ? 'utf8' : 'base64';

  let content;
  if (useEncoding === 'base64') {
    content = bytes.toString('base64');
  } else {
    content = bytes.toString('utf8');
    if (content.includes('\uFFFD') && !isTextHint) {
      useEncoding = 'base64';
      content = bytes.toString('base64');
    }
  }

  return sendJson(res, 200, {
    path: resolved.rel,
    content,
    encoding: useEncoding,
    size: st.size,
    returnedBytes: bytes.length,
    truncated,
    mime: MIME[ext] || 'application/octet-stream',
    isText: useEncoding === 'utf8',
    mtime: st.mtimeMs,
  });
}

async function fsHandleWrite(req, res, extDir, cfg) {
  if (!cfg.api.writable || !cfg.api.fs.write) {
    return sendJson(res, 403, { error: '写操作已禁用' });
  }

  let body;
  try { body = await readJsonBody(req, cfg.api.fs.maxWriteSize * 2); }
  catch (err) { return sendJson(res, err.code || 400, { error: err.message }); }

  const relPath = typeof body.path === 'string' ? body.path : '';
  if (!relPath) return sendJson(res, 400, { error: '缺少 path 字段' });

  const resolved = fsResolveUnder(extDir, relPath);
  if (resolved.error) return sendJson(res, 400, { error: resolved.error });
  if (!resolved.rel) return sendJson(res, 400, { error: '不能写入扩展根目录' });

  const encoding = body.encoding === 'base64' ? 'base64' : 'utf8';
  let content = body.content;
  if (content === undefined || content === null) return sendJson(res, 400, { error: '缺少 content 字段' });
  if (typeof content !== 'string') content = String(content);

  let buf;
  try {
    buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
  } catch {
    return sendJson(res, 400, { error: '内容解码失败' });
  }

  if (buf.length > cfg.api.fs.maxWriteSize) {
    return sendJson(res, 413, { error: `写入超过限制（${cfg.api.fs.maxWriteSize} 字节）`, size: buf.length });
  }

  if (body.mkdirp !== false) {
    try { fs.mkdirSync(path.dirname(resolved.full), { recursive: true }); }
    catch (err) { return sendJson(res, 500, { error: '创建父目录失败: ' + err.message }); }
  }

  try {
    const st = fs.statSync(resolved.full);
    if (st.isDirectory()) return sendJson(res, 400, { error: '目标是目录' });
  } catch {}

  try { fs.writeFileSync(resolved.full, buf); }
  catch (err) { return sendJson(res, 500, { error: err.message }); }

  let st;
  try { st = fs.statSync(resolved.full); } catch { st = { size: buf.length, mtimeMs: Date.now() }; }

  return sendJson(res, 200, {
    ok: true,
    path: resolved.rel,
    size: st.size,
    encoding,
    mtime: st.mtimeMs,
  });
}

async function fsHandleMkdir(req, res, extDir, cfg) {
  if (!cfg.api.writable || !cfg.api.fs.write) return sendJson(res, 403, { error: '写操作已禁用' });

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, err.code || 400, { error: err.message }); }

  const relPath = typeof body.path === 'string' ? body.path : '';
  if (!relPath) return sendJson(res, 400, { error: '缺少 path 字段' });

  const resolved = fsResolveUnder(extDir, relPath);
  if (resolved.error) return sendJson(res, 400, { error: resolved.error });
  if (!resolved.rel) return sendJson(res, 400, { error: '不能创建扩展根目录' });

  const recursive = body.recursive !== false;
  const existed = fs.existsSync(resolved.full);

  try { fs.mkdirSync(resolved.full, { recursive }); }
  catch (err) { return sendJson(res, 500, { error: err.message }); }

  return sendJson(res, 200, { ok: true, path: resolved.rel, created: !existed });
}

function fsHandleDelete(res, extDir, relPath, url, cfg) {
  if (!cfg.api.writable || !cfg.api.fs.write) return sendJson(res, 403, { error: '写操作已禁用' });

  const resolved = fsResolveUnder(extDir, relPath);
  if (resolved.error) return sendJson(res, 400, { error: resolved.error });
  if (!resolved.rel) return sendJson(res, 400, { error: '不能删除扩展根目录' });

  let st;
  try { st = fs.statSync(resolved.full); }
  catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: '路径不存在', path: resolved.rel });
    return sendJson(res, 500, { error: err.message });
  }

  const recursive = url.searchParams.get('recursive') === '1';

  if (st.isDirectory()) {
    let entries = [];
    try { entries = fs.readdirSync(resolved.full); } catch {}
    if (entries.length && !recursive) {
      return sendJson(res, 400, { error: '目录非空，需加 ?recursive=1', entries: entries.length });
    }
  }

  try { fs.rmSync(resolved.full, { recursive: true, force: true }); }
  catch (err) { return sendJson(res, 500, { error: err.message }); }

  return sendJson(res, 200, {
    ok: true,
    path: resolved.rel,
    deleted: true,
    type: st.isDirectory() ? 'dir' : 'file',
  });
}

async function fsHandleRename(req, res, extDir, cfg) {
  if (!cfg.api.writable || !cfg.api.fs.write) return sendJson(res, 403, { error: '写操作已禁用' });

  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, err.code || 400, { error: err.message }); }

  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';
  if (!from || !to) return sendJson(res, 400, { error: '需要 from 和 to' });

  const rFrom = fsResolveUnder(extDir, from);
  const rTo = fsResolveUnder(extDir, to);
  if (rFrom.error) return sendJson(res, 400, { error: 'from: ' + rFrom.error });
  if (rTo.error) return sendJson(res, 400, { error: 'to: ' + rTo.error });
  if (!rFrom.rel || !rTo.rel) return sendJson(res, 400, { error: '不能操作扩展根目录' });

  if (!fs.existsSync(rFrom.full)) return sendJson(res, 404, { error: '源不存在', path: rFrom.rel });
  if (fs.existsSync(rTo.full)) return sendJson(res, 409, { error: '目标已存在', path: rTo.rel });

  try { fs.mkdirSync(path.dirname(rTo.full), { recursive: true }); }
  catch (err) { return sendJson(res, 500, { error: err.message }); }

  try { fs.renameSync(rFrom.full, rTo.full); }
  catch (err) { return sendJson(res, 500, { error: err.message }); }

  return sendJson(res, 200, { ok: true, from: rFrom.rel, to: rTo.rel });
}

/* ---- API 主分发 ---- */

async function handleApi(app, req, res, url, pathname) {
  const cfg = getConfig(app);

  if (!cfg.api.enabled) {
    return sendJson(res, 403, { error: 'API 已禁用' });
  }

  /* GET /api/config */
  if (pathname === '/api/config') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '只支持 GET' });
    return sendJson(res, 200, apiConfigPayload(app, cfg));
  }

  /* GET /api/extensions */
  if (pathname === '/api/extensions') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '只支持 GET' });
    return sendJson(res, 200, {
      count: app.ext.list.length,
      enabled: cfg.extensions.enabled,
      dir: cfg.extensions.dir,
      configFile: cfg.extensions.configFile,
      extensions: apiExtensionsList(app, cfg),
    });
  }

  /* POST /api/extensions/toggle */
  if (pathname === '/api/extensions/toggle') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
    return handleToggleExtension(app, req, res);
  }

  /* GET /api/search?q=&limit= —— 服务端搜索（v2.5） */
  if (pathname === '/api/search') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '只支持 GET' });
    return handleSearch(app, res, url);
  }

  /* /api/fs/* */
  if (pathname === '/api/fs/list' || pathname === '/api/fs/stat' || pathname === '/api/fs/read') {
    if (!cfg.api.fs.read) return sendJson(res, 403, { error: '文件系统读取已禁用' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '只支持 GET' });

    const relPath = url.searchParams.get('path') || '';
    if (pathname === '/api/fs/list') return fsHandleList(res, cfg.root, relPath, url, cfg);
    if (pathname === '/api/fs/stat') return fsHandleStat(res, cfg.root, relPath);
    if (pathname === '/api/fs/read') return fsHandleRead(res, cfg.root, relPath, url, cfg);
  }

  /* /api/extensions/:id/fs/* */
  const mFs = /^\/api\/extensions\/([^/]+)\/fs\/(list|stat|read|write|mkdir|delete|rename)$/.exec(pathname);
  if (mFs) {
    const id = decodeURIComponent(mFs[1]);
    const action = mFs[2];

    const err = validateExtId(id);
    if (err) return sendJson(res, 400, { error: err });

    const ext = findExtension(app, id);
    if (!ext) return sendJson(res, 404, { error: `扩展不存在或未启用: ${id}` });
    if (!cfg.api.fs.read) return sendJson(res, 403, { error: '文件系统访问已禁用' });

    const extDir = ext.dir;
    const relPath = url.searchParams.get('path') || '';

    if (action === 'list') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '只支持 GET' });
      return fsHandleList(res, extDir, relPath, url, cfg, { allowHiddenDefault: true });
    }
    if (action === 'stat') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '只支持 GET' });
      return fsHandleStat(res, extDir, relPath, { base: id });
    }
    if (action === 'read') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '只支持 GET' });
      return fsHandleRead(res, extDir, relPath, url, cfg);
    }
    if (action === 'write') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      return fsHandleWrite(req, res, extDir, cfg);
    }
    if (action === 'mkdir') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      return fsHandleMkdir(req, res, extDir, cfg);
    }
    if (action === 'delete') {
      if (req.method !== 'DELETE') return sendJson(res, 405, { error: '只支持 DELETE' });
      return fsHandleDelete(res, extDir, relPath, url, cfg);
    }
    if (action === 'rename') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
      return fsHandleRename(req, res, extDir, cfg);
    }
  }

  /* /api/extensions/:id/config */
  const mCfg = /^\/api\/extensions\/([^/]+)\/config$/.exec(pathname);
  if (mCfg) {
    const id = decodeURIComponent(mCfg[1]);
    if (req.method === 'GET' || req.method === 'HEAD') return handleExtConfigGet(app, req, res, id);
    if (req.method === 'POST') return handleExtConfigPost(app, req, res, id);
    if (req.method === 'DELETE') return handleExtConfigDelete(app, req, res, id);
    return sendJson(res, 405, { error: '只支持 GET / POST / DELETE' });
  }

  /* GET /api/extensions/:id/stats */
  const mStats = /^\/api\/extensions\/([^/]+)\/stats$/.exec(pathname);
  if (mStats) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '只支持 GET' });
    const id = decodeURIComponent(mStats[1]);
    const ext = findExtension(app, id);
    if (!ext) return sendJson(res, 404, { error: `扩展不存在: ${id}` });
    if (!ext.stats) return sendJson(res, 404, { error: `扩展 ${id} 未实现 stats()` });
    try {
      const r = ext.stats(makeExtCtx(app, ext, {}));

      // stats() 必须同步 —— 异步路径无超时保护，容易挂死请求
      if (r && typeof r.then === 'function') {
        return sendJson(res, 500, { error: 'stats() 必须是同步函数（不支持 async）' });
      }

      return sendJson(res, 200, { id, stats: r });
    } catch (err) {
      return sendJson(res, 500, { error: 'stats() 出错: ' + err.message });
    }
  }

  /* GET /api/extensions/:id */
  const m = /^\/api\/extensions\/([^/]+)$/.exec(pathname);
  if (m) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '只支持 GET' });
    const id = decodeURIComponent(m[1]);
    const ext = findExtension(app, id);
    if (!ext) return sendJson(res, 404, { error: `扩展不存在: ${id}` });
    return sendJson(res, 200, {
      id: ext.id,
      name: ext.name,
      description: ext.description,
      version: ext.version,
      author: ext.author,
      order: ext.order,
      dir: ext.dir,
      config: ext.config.values,
      configSchema: ext.config.fields,
      hasUserConfig: ext.config.hasUserValues,
      // v2.8.1：补上 scope，与列表端点和页面内 __NAV_DATA__ 保持一致
      scope: ext.scope || null,
    });
  }

  return sendJson(res, 404, { error: '未知的 API 端点', pathname });
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  [14] 请求入口 —— handleRequest
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 导航页 JSON 接口 */
function handleNavJson(app, res, url) {
  // v2.8.3：?format=json 输出的是展示页的数据源 —— 没装展示页扩展时一并降级
  if (!hasNavPageProvider(app, url.pathname || '/')) {
    return sendJson(res, 404, { error: '展示页扩展未安装，?format=json 不可用' });
  }

  const force = url.searchParams.has('fresh') || url.searchParams.has('refresh');
  const { cfg, files, dirMeta, configPath, configFound } = getState(app, force);
  // 默认排除 hidden；?hidden=1 可包含
  const includeHidden = url.searchParams.has('hidden') && url.searchParams.get('hidden') !== '0';
  const shown = includeHidden ? files : files.filter((f) => !f.hidden);

  return sendJson(res, 200, {
    root: cfg.root,
    count: shown.length,
    hiddenCount: files.length - shown.length,
    generatedAt: new Date().toISOString(),
    config: {
      source: configFound ? configPath : null,
      site: cfg.site,
      htmlExtensions: cfg.htmlExtensions,
      ignoreDirs: cfg.ignoreDirs,
      ignoreFiles: cfg.ignoreFiles,
    },
    extensions: app.ext.list.map((e) => ({
      id: e.id, name: e.name, version: e.version,
      author: e.author, description: e.description, order: e.order,
      config: e.config.values,
      configSchema: e.config.fields,
      hasUserConfig: e.config.hasUserValues,
      // v2.8.1：补上 scope，与 buildNavData（页面内 __NAV_DATA__）保持一致
      scope: e.scope || null,
    })),
    dirs: [...dirMeta.entries()].map(([dir, info]) => ({
      dir, title: info.title || '', description: info.description || '',
    })),
    files: shown.map((f) => ({
      path: f.rel,
      url: '/' + encodePath(f.rel),
      dir: f.dir,
      name: f.name,
      title: f.title || '',
      description: f.description || '',
      size: f.size,
      mtime: new Date(f.mtime).toISOString(),
      hidden: !!f.hidden,
    })),
  });
}

/** 导航页 HTML */
/** 自定义主页响应 */
/** 自定义主页响应 */
async function handleCustomHome(app, req, res, url, route) {
  const force = url.searchParams.has('fresh') || url.searchParams.has('refresh');
  const { cfg, files, dirMeta } = getState(app, force);

  const pathname = url.pathname === '' ? '/' : url.pathname;
  const host = String(req.headers.host || '').toLowerCase();

  // HTML 渲染缓存（cfg.cache.html 开启时生效）
  let html = null;
  const cacheEnabled = cfg.cache.html && !force;
  const versionKey = app.cfgVersion + '|' + app.ext.version + '|' + (app.pageExtCache.version || '');

  if (cacheEnabled) {
    if (app.htmlCache.version !== versionKey) {
      app.htmlCache.map.clear();
      app.htmlCache.version = versionKey;
    }
    html = app.htmlCache.map.get(host + "|" + pathname);
  }

  if (html == null) {
    html = await renderNav(app, files, dirMeta, cfg, pathname);

    if (html === null) {
      // v2.8.3：没有扩展提供展示页 → 走回退（index.html / 0 字节空页面）。
      // 注意不走 htmlCache —— 回退分支自己直接写响应。
      if (cfg.home && cfg.home.enabled) {
        console.warn(`  ⚠  [${ts()}] 自定义主页不可用，且未安装展示页扩展，回退到 index.html / 空页面`);
      }
      return renderNavFallback(app, req, res, cfg, pathname);
    }

    if (cacheEnabled && html != null) {
      app.htmlCache.map.set(host + "|" + pathname, html);
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}
async function handleNavHtml(app, req, res, url) {
  const force = url.searchParams.has('fresh') || url.searchParams.has('refresh');
  const { cfg, files, dirMeta } = getState(app, force);

  const pathname = url.pathname === '' ? '/' : url.pathname;
  const host = String(req.headers.host || '').toLowerCase();

  // HTML 渲染缓存（cfg.cache.html 开启时生效）
  let html = null;
  const cacheEnabled = cfg.cache.html && !force;
  const versionKey = app.cfgVersion + '|' + app.ext.version + '|' + (app.pageExtCache.version || '');

  if (cacheEnabled) {
    if (app.htmlCache.version !== versionKey) {
      app.htmlCache.map.clear();
      app.htmlCache.version = versionKey;
    }
    html = app.htmlCache.map.get(host + "|" + pathname);
  }

  if (html == null) {
    html = await renderNav(app, files, dirMeta, cfg, pathname);

    if (html === null) {
      // v2.8.3：没有扩展提供展示页 → 找 root/index.html，找不到返回 0 字节
      return renderNavFallback(app, req, res, cfg, pathname);
    }

    if (cacheEnabled) {
      app.htmlCache.map.set(host + "|" + pathname, html);
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

/** 顶层请求处理 */
async function handleRequest(app, req, res) {
  /* v2.5: 统一的响应观察点 —— 挂 res.end，覆盖所有出口（含错误页、静态文件流） */
  const t0 = process.hrtime.bigint();
  let sentStatus = 0;
  let sentBytes = 0;
  let recorded = false;

  const _writeHead = res.writeHead;
  res.writeHead = function (statusCode, ...args) {
    sentStatus = statusCode;
    return _writeHead.call(this, statusCode, ...args);
  };

  const _end = res.end;
  res.end = function (chunk, ...args) {
    if (!recorded) {
      recorded = true;
      if (chunk) sentBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (!sentStatus) sentStatus = res.statusCode || 200;
      const durMs = Number(process.hrtime.bigint() - t0) / 1e6;
      // 快照：扩展绝不能碰 res，只给只读信息
      applyOnResponse(app, {
        method: req.method,
        pathname: res.__navextPathname || '/',
        url: req.url,
        status: sentStatus,
        bytes: sentBytes,
        durationMs: Math.round(durMs * 100) / 100,
        headers: req.headers,
        start: Date.now(),
      }, { root: app.cfg ? app.cfg.root : '', configPath: app.configPath });
    }
    return _end.call(this, chunk, ...args);
  };

  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }

  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request: 非法的 URL 编码');
  }

  // 供 onResponse 使用（放在解码成功后）
  res.__navextPathname = pathname;

  const ext = getExtensions(app);
  const cfg = getConfig(app);

  /* API 优先 */
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const m = req.method;
    if (m !== 'GET' && m !== 'HEAD' && m !== 'POST' && m !== 'DELETE') {
      res.writeHead(405, {
        Allow: 'GET, HEAD, POST, DELETE',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      return res.end('405 Method Not Allowed');
    }
    return handleApi(app, req, res, url, pathname);
  }

  /* 扩展 onRequest 钩子 */
  if (ext.list.length) {
    const result = await applyOnRequest(app, req, url, {
      root: cfg.root, configPath: app.configPath, pathname,
    });
    if (result) return sendCustomResponse(res, result);
  }

  /* 扩展都没接 —— 剩下只有 GET/HEAD 合法 */
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return res.end('405 Method Not Allowed');
  }

  /* v1.8: 多主页路由 */
  const homeRoute = matchHomeRoute(req, pathname, cfg);
  if (homeRoute) {
    if ((pathname === '/' || pathname === '') &&
        (url.searchParams.get('format') === 'json' || url.searchParams.has('json'))) {
      return handleNavJson(app, res, url);
    }
    return handleCustomHome(app, req, res, url, homeRoute);
  }

  /* 首页 → 导航页 */
  if (pathname === '/' || pathname === '') {
    if (url.searchParams.get('format') === 'json' || url.searchParams.has('json')) {
      return handleNavJson(app, res, url);
    }
    return handleNavHtml(app, req, res, url);
  }

  /* 静态文件 */
  const filePath = resolveStaticPath(pathname, cfg.root);
  if (!filePath) return sendError(res, 403, '禁止访问该路径');

  serveStatic(req, res, filePath);
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  [15] 启动与 CLI
 * ═══════════════════════════════════════════════════════════════════════════ */

function printHelp() {
  console.log(`
用法: node server.js [根目录] [端口] [选项]

选项:
  -r, --root <dir>     扫描的根目录 (默认: 当前工作目录)
  -p, --port <num>     监听端口
      --host <addr>    监听地址 (默认: 0.0.0.0)
      --depth <num>    最大递归深度 (默认: 8)
  -c, --config <file>  指定配置文件
  -h, --help           显示帮助

服务端 API:
  GET    /api/config                            当前配置 + 目录元数据
  GET    /api/search?q=<kw>                     服务端搜索文件（支持 limit / dir）
  GET    /api/extensions                        所有扩展
  GET    /api/extensions/:id                    单个扩展详情
  POST   /api/extensions/toggle                 切换启用状态
  GET    /api/extensions/:id/config             读取扩展配置
  POST   /api/extensions/:id/config             更新扩展配置
  DELETE /api/extensions/:id/config             重置配置
  GET    /api/fs/list?path=<rel>                列出项目目录
  GET    /api/fs/stat?path=<rel>                项目文件信息
  GET    /api/fs/read?path=<rel>                读取项目文件
  GET    /api/extensions/:id/fs/list?path=<rel> 列出扩展目录
  POST   /api/extensions/:id/fs/write           写入扩展文件
  POST   /api/extensions/:id/fs/mkdir           创建扩展目录
  POST   /api/extensions/:id/fs/rename          重命名
  DELETE /api/extensions/:id/fs/delete?path=    删除

客户端 API (window.NavExt):
  数据    getFiles / getFile / getConfig / getExtensions
  搜索    search(q, {limit, dir})
  配置    getExtConfig / getExtConfigSchema / setExtConfig / resetExtConfig
  FS      fs.list / fs.read / fs.stat / fs.exists
  Net     fetch(url, opts)  — 带超时 + 扩展重载自动 abort
  Timer   timer / interval / clearTimer  — 重载时自动清理
  ExtFS   extFs(id).read / .write / .list / .delete ...
  DOM     getCardEl / addCardIcon / addCardBadge / addCardClass
  事件    on / once / emit
  样式    injectCSS / removeCSS

说明:
  · html.json 的 "@dir" 键大小写不敏感（@DIR / @Dir 均可）
  · .navext.client.js 必须与 server.js 同目录，客户端库从它加载
  · 修改 .navext.client.js 后刷新页面即生效（mtime 缓存）
`);
}

function parseArgs(argv) {
  const cli = { _explicit: new Set() };
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else if (a === '-r' || a === '--root') { cli.root = argv[++i]; cli._explicit.add('root'); }
    else if (a === '-p' || a === '--port') { cli.port = argv[++i]; cli._explicit.add('port'); }
    else if (a === '--host') { cli.host = argv[++i]; cli._explicit.add('host'); }
    else if (a === '--depth') { cli.depth = argv[++i]; cli._explicit.add('depth'); }
    else if (a === '-c' || a === '--config') { cli.config = argv[++i]; }
    else if (a.startsWith('--root=')) { cli.root = a.slice(7); cli._explicit.add('root'); }
    else if (a.startsWith('--port=')) { cli.port = a.slice(7); cli._explicit.add('port'); }
    else if (a.startsWith('--host=')) { cli.host = a.slice(7); cli._explicit.add('host'); }
    else if (a.startsWith('--depth=')) { cli.depth = a.slice(8); cli._explicit.add('depth'); }
    else if (a.startsWith('--config=')) { cli.config = a.slice(9); }
    else if (!a.startsWith('-')) rest.push(a);
  }

  if (rest[0] !== undefined && !cli._explicit.has('root')) { cli.root = rest[0]; cli._explicit.add('root'); }
  if (rest[1] !== undefined && !cli._explicit.has('port')) { cli.port = rest[1]; cli._explicit.add('port'); }

  return cli;
}

/** 启动日志 */
function printBanner(app, cfg) {
  const { files } = getState(app);
  const exts = app.ext.list;
  const shown = cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;

  console.log('');
  console.log(`  🚀  NavExt v${SERVER_VERSION} 已启动`);
  console.log('  ────────────────────────────────────────');
  console.log(`  站点名称 ${cfg.site.title || '(默认) NavExt'}`);
  console.log(`  根目录   ${cfg.root}`);
  console.log(`  配置文件 ${app.cfgFound ? app.configPath : app.configPath + '  (未找到，使用默认配置)'}`);
  const clientMode = (typeof NAVEXT_CLIENT_INLINE !== "undefined")
    ? "（内联）"
    : path.basename(NAVEXT_CLIENT_PATH);
  console.log(`  客户端库 ${clientMode}`);
  console.log(`  扫描到   ${files.length} 个 HTML 文件`);

  if (cfg.extensions.enabled) {
    const dir = getExtDir(cfg);
    if (exts.length) {
      const withCfg = exts.filter((e) => e.config.fields.length > 0).length;
      const withScope = exts.filter((e) => e.scope).length;
      console.log(`  扩展     ${exts.length} 个 (${exts.map((e) => e.scope ? e.id + '*' : e.id).join(', ')})`);
      if (withScope) console.log(`  作用域   ${withScope} 个有路径限制（* 标记）`);
      if (withCfg) console.log(`  可配置   ${withCfg} 个`);
      if (cfg.extensions.timeout) console.log(`  钩子超时 ${cfg.extensions.timeout}ms`);
      if (cfg.extensions.fetchTimeout) console.log(`  fetch 超时 ${cfg.extensions.fetchTimeout}ms`);
    } else {
      console.log(`  扩展     无 (${dir})`);
    }
  } else {
    console.log('  扩展     已禁用');
  }

  console.log(`  API      ${cfg.api.enabled ? (cfg.api.writable ? '只读+写' : '只读') : '已禁用'}`);
  console.log(`  文件系统 ${cfg.api.enabled
    ? `读:${cfg.api.fs.read ? '开' : '关'} 写:${cfg.api.fs.write ? '开' : '关'}`
    : '已禁用'}`);
  // v2.8.1：写文件默认关闭时明确提示原因与开启方式，避免用户以为接口坏了
  if (cfg.api.enabled && cfg.api.writable && !cfg.api.fs.write) {
    console.log('           ↑ 扩展文件写入已关闭（写入内容会被热重载执行，默认不开放）');
    console.log('             需要时在 server.json 打开：{ "api": { "fs": { "write": true } } }');
  }
  const cacheLine = cfg.cache.html
    ? `开 (扩展 TTL ${cfg.cache.extTtl || TTL.ext}ms)`
    : "关";
  console.log(`  缓存     ${cacheLine}`);
  const pageExtLine = cfg.pageExt.enabled ? `开 (${cfg.pageExt.file})` : "关";
  console.log(`  子页策略 ${pageExtLine}`);

  // v2.8.3：展示页由扩展提供 —— 没装时必须明确告知，否则会被当成「坏了」
  const uiExts = (app.ext.list || []).filter((e) => typeof e.server?.onNavPage === 'function');
  if (uiExts.length) {
    console.log(`  展示页   ${uiExts.map((e) => e.id).join(', ')}`);
  } else {
    const hasIdx = fs.existsSync(path.join(cfg.root, 'index.html'));
    console.log(`  展示页   ✖ 未安装（无扩展实现 onNavPage）`);
    console.log(`           根路径 / 将${hasIdx ? '服务 index.html' : '返回空页面（0 字节）'}`);
    console.log(`           安装内置展示页：node install.js`);
  }

  const homeRoutes = (cfg.home && cfg.home.routes) || [];
  const hasFallback = cfg.home && cfg.home.enabled && cfg.home.file;
  if (homeRoutes.length || hasFallback) {
    const total = homeRoutes.length + (hasFallback ? 1 : 0);
    console.log(`  自定义主页 ${total} 个路由`);
    for (const r of homeRoutes) {
      const m = r.match || {};
      const conds = [];
      if (m.path) conds.push(`path=${m.path}`);
      if (m.host) conds.push(`host=${m.host.join('|')}`);
      if (m.env)  conds.push(`env=${m.env}=${m.value}`);
      const condStr = conds.length ? conds.join(' & ') : '(无条件)';
      const extStr = r.applyExtensions === null ? '继承' : (r.applyExtensions ? '开' : '关');
      console.log(`    ${condStr.padEnd(30)} → ${r.file}  [扩展:${extStr}]`);
    }
    if (hasFallback) {
      console.log(`    兜底${' '.repeat(26)} → ${cfg.home.file}`);
    }
  }

  console.log(`  导航页   http://${shown}:${cfg.port}/`);
  console.log(`  JSON     http://${shown}:${cfg.port}/?format=json`);
  console.log('  ────────────────────────────────────────');
  console.log('  ♻  热重载：server.json / html.json / .js 改完刷新即生效');
  console.log('     （.navext.client.js 也会热重载，但页面有渲染缓存，需加 ?fresh=1 或关掉 cache.html 才看得到）');
  console.log('  ⏹  按 Ctrl+C 停止服务（SIGTERM 同样支持，扩展会收到 onDispose）');
  console.log('');
}

/** 启动入口 —— 唯一的顶层逻辑 */
function main() {
  // ── 进程级兜底：扩展在钩子里漏 catch 的异步异常，不该拖垮整个服务 ──
  // 同步 try/catch 挡不住微任务里抛出的异常（如 onRequest 内浮空 Promise），
  // Node 15+ 默认直接终止进程。这里兜住并保持服务可用。
  process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.message ? reason.message : String(reason);
    console.error(`  ⚠  [${ts()}] 未处理的 Promise 拒绝（已忽略，服务继续运行）：${msg}`);
    if (process.env.NAVEXT_DEBUG && reason && reason.stack) {
      console.error(reason.stack.replace(/^/gm, '       '));
    }
  });

  process.on('uncaughtException', (err) => {
    console.error(`  ⚠  [${ts()}] 未捕获异常（已忽略，服务继续运行）：${err && err.message}`);
    if (process.env.NAVEXT_DEBUG && err && err.stack) {
      console.error(err.stack.replace(/^/gm, '       '));
    }
    // 监听器自身出错导致 ERR_SERVER_ALREADY_LISTEN 等致命配置错误时，
    // 静默续跑没有意义，交给原有错误路径
  });

  // 检查客户端库（不存在直接失败，避免启动后才报错）
  if (typeof NAVEXT_CLIENT_INLINE === "undefined" && !fs.existsSync(NAVEXT_CLIENT_PATH)) {
    console.error('');
    console.error(`  ✖  找不到客户端库：${NAVEXT_CLIENT_PATH}`);
    console.error('     请把 .navext.client.js 与 server.js 放在同一目录。');
    console.error('');
    process.exit(1);
  }

  // 初始化 App
  App.cli = parseArgs(process.argv.slice(2));
  App.cwd = process.cwd();
  App.configPath = App.cli.config
    ? path.resolve(App.cwd, App.cli.config)
    : path.join(App.cwd, 'server.json');

  // 首次加载
  const cfg = getConfig(App);
  App.os = OS.init(App);          // 特权能力层（RunX 内核）
  getExtensions(App);
  getState(App);

  // 启动 HTTP 服务
  App.server = http.createServer((req, res) => {
    handleRequest(App, req, res).catch((err) => {
      console.error(`  ✖  [${ts()}] 请求处理失败：`, err);
      if (!res.headersSent) sendError(res, 500, '服务器内部错误');
      else res.destroy();
    });
  });

  App.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ✖ 端口 ${cfg.port} 已被占用，请换一个端口：`);
      console.error(`     node server.js --port ${cfg.port + 1}\n`);
    } else {
      console.error('\n  ✖ 服务启动失败：', err.message, '\n');
    }
    process.exit(1);
  });

  // WebSocket 升级（事件总线）；非 ws 升级直接断开
  App.server.on('upgrade', (req, socket, head) => {
    if (App.os) App.os.onUpgrade(req, socket, head);
    else socket.destroy();
  });

  App.server.listen(cfg.port, cfg.host, () => printBanner(App, cfg));

  // 优雅退出
  // v2.8.1：两条退出路径统一处理，且都调用扩展的 onDispose。
  // 之前只挂了 SIGINT 且不清理扩展，导致：
  //   1) Ctrl+C 时扩展收不到 onDispose，定时器/挂起请求/本地状态文件不会被收尾
  //   2) SIGTERM（docker stop / systemd / k8s 驱逐 / 裸 kill）完全没有处理
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n  收到 ${signal}，正在停止服务…`);

    // 逆序清理（后加载的先走），与热重载时保持一致
    const list = (App.ext && App.ext.list) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      try { disposeExt(list[i]); }
      catch (err) { console.warn(`  ⚠  [${ts()}] 清理扩展 ${list[i].id} 出错：${err.message}`); }
    }

    console.log('  已停止服务。\n');
    App.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  入口
 * ═══════════════════════════════════════════════════════════════════════════ */

main();