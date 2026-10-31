#!/usr/bin/env node
'use strict';
//
// bin/seed-apps.js
// ----------------------------------------------------------------------------
// 启动时把 apps/ 下所有「自带 + 已安装」应用登记进 var/runx/apps.json。
//
// 为什么需要它：
//   早期 start.sh 直接 `cat > apps.json` 写死 term，导致两个问题 ——
//   1) 内置的 store / runx-dev / demo 从不登记，新克隆的实例里商店应用形同虚设；
//   2) 用户从商店装的应用在重启后会被整份覆盖掉，等于「装了又消失」。
//
// 做法：以 apps/ 目录为唯一真相来源。每个含合法 appex.json 的子目录都对应一个
//   已安装应用（PaX 安装/卸载都直接操作 apps/ 下的目录），扫描它即可重建登记。
//   字段映射与 PaX 的 buildEntry 保持一致（文档 §5 AppEntry）。
//
// 合并策略：
//   · 已存在条目里的 installed_at 保留，重启后时间戳不跳变；
//   · apps/ 里没有目录的条目（被 PaX 卸载的应用）不再写入 —— 不会复活；
//   · 输出按名称排序，apps.json 稳定可 diff。
//
// 用法：node bin/seed-apps.js   （RUNX_ROOT 可覆盖根目录，默认脚本所在的上一级）
//
const fs = require('fs');
const path = require('path');

const ROOT = process.env.RUNX_ROOT || path.resolve(__dirname, '..');
const APPS_REL = 'apps';
const APPS_DIR = path.join(ROOT, APPS_REL);
const OUT_FILE = path.join(ROOT, 'var', 'runx', 'apps.json');

const RESTART_POLICIES = ['no', 'on-failure', 'always'];

const clampNum = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

function validateName(n) {
  return typeof n === 'string' && /^[a-z0-9._-]+$/i.test(n) && n.length <= 48;
}

function safeEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function safePerms(perms) {
  if (!Array.isArray(perms)) return undefined;
  const out = perms
    .filter((x) => typeof x === 'string' && /^[a-z]+\.[a-z]+(:.*)?$/.test(x.trim()))
    .map((x) => x.trim())
    .slice(0, 32);
  return out.length ? out : undefined;
}

function buildEntry(appex, name) {
  const isNode = appex.type === 'node';
  const restart = RESTART_POLICIES.includes(appex.restart)
    ? appex.restart
    : (isNode ? 'on-failure' : 'no');
  return {
    name,
    type: isNode ? 'node' : 'web',
    display_name: appex.display_name || appex.name,
    icon: appex.icon || null,
    cmd: isNode ? (appex.entry ? ('node ' + appex.entry) : 'node app.js') : undefined,
    cwd: path.join(ROOT, APPS_REL, name),
    port: isNode ? Number(appex.port) || 0 : 0,
    env: safeEnv(appex.env),
    autostart: appex.autostart === true,
    restart,
    restart_delay_ms: clampNum(appex.restart_delay_ms, 0, 600000, 1000),
    restart_max: clampNum(appex.restart_max, 0, 100, 5),
    restart_window_ms: clampNum(appex.restart_window_ms, 1000, 86400000, 60000),
    data_dir: appex.data_dir || null,
    version: appex.version || '0.0.0',
    description: appex.description || '',
    permissions: safePerms(appex.permissions),
    // installed_at 由合并阶段填充
  };
}

function scanApps() {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(APPS_DIR); } catch { return out; }
  for (const n of names) {
    if (!validateName(n)) continue;
    const dir = path.join(APPS_DIR, n);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const appexPath = path.join(dir, 'appex.json');
    if (!fs.existsSync(appexPath)) continue;
    let appex;
    try { appex = JSON.parse(fs.readFileSync(appexPath, 'utf8')); }
    catch { continue; }
    if (!appex || typeof appex !== 'object') continue;
    if (appex.name && appex.name !== n) continue; // 清单名需与目录名一致
    out[n] = buildEntry(appex, n);
  }
  return out;
}

function main() {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const scanned = scanApps();
  const scannedNames = new Set(Object.keys(scanned));

  // 读取已存在的 apps.json，仅用于保留 installed_at（时间戳稳定）
  let prevApps = [];
  try {
    const raw = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    if (raw && Array.isArray(raw.apps)) prevApps = raw.apps;
  } catch { /* 没有就用扫描结果 */ }

  const prevById = new Map(prevApps.map((a) => [a.name, a]));
  const now = Date.now();
  const apps = [];
  for (const name of Object.keys(scanned).sort()) {
    const entry = scanned[name];
    const old = prevById.get(name);
    entry.installed_at = (old && Number(old.installed_at)) || now;
    apps.push(entry);
  }
  // 不在 apps/ 目录里的旧条目（理论上 PaX 卸载时已删目录 + 条目）一律不写回，
  // 避免重启把已卸载的应用「复活」。

  const result = { schema: 1, apps };
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8');
  process.stdout.write('已登记 ' + apps.length + ' 个应用：' + apps.map((a) => a.name).join(', ') + '\n');
}

main();
