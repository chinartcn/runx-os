#!/usr/bin/env node
'use strict';

/**
 * 把 @runx/* 挂进应用 —— git 是唯一分发源，这里负责「挂载」
 *
 * ── 为什么需要这个脚本 ──────────────────────────────────────────
 * 这些包不发 npm，从 git 装。但 npm **不支持**从 monorepo 里直接装子包：
 *
 *   npm i github:chinartcn/runx-os               → 装的是仓库根包（navext）
 *   npm i github:chinartcn/runx-os#path:packages/runx-host
 *                                                → `#path:` 被忽略，还是根包
 *   workspaces + npm i "@runx/host@git+..."      → 目录名对了，内容仍是根包
 *
 * 三条我都试过，装出来的东西 require 不进去。所以改成软链：
 *
 *   apps/notes/node_modules/@runx/sdk -> ../../..//packages/runx-sdk
 *
 * 软链比复制好在「更新即生效」：仓库拉到新版本，应用下次 require 就是新
 * 的，不用重装，也不会出现「某个应用里躺着一份两年前的 SDK」这种事故。
 *
 * ── 用法 ────────────────────────────────────────────────────────
 *   node packages/link.js                  看两个包挂在哪
 *   node packages/link.js term             挂进 apps/term
 *   node packages/link.js term files       挂进多个
 *   node packages/link.js --all            挂进 apps/ 下所有 node 应用
 *   node packages/link.js --copy term      复制（无符号链接权限时，如某些 SMB 盘）
 *   node packages/link.js --force term     覆盖应用里已有的真实目录
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APPS = path.join(ROOT, 'apps');

const PKGS = ['runx-host', 'runx-sdk', 'runx-pty'].map((dir) => {
  const full = path.join(__dirname, dir);
  let name = dir;
  let version = '?';
  try {
    const p = JSON.parse(fs.readFileSync(path.join(full, 'package.json'), 'utf8'));
    name = p.name;
    version = p.version;
  } catch (e) { /* 目录缺失，下面会报 */ }
  return { dir, name, version, full };
});

const argv = process.argv.slice(2);
const FLAGS = { all: false, copy: false, force: false };
const targets = [];
for (const a of argv) {
  if (a === '--all') FLAGS.all = true;
  else if (a === '--copy') FLAGS.copy = true;
  else if (a === '--force' || a === '-f') FLAGS.force = true;
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else targets.push(a);
}

function usage() {
  console.log(`
把 @runx/* 挂进应用（git 分发，不发 npm）

  node packages/link.js                  看状态
  node packages/link.js <应用...>        挂进去（应用名或目录）
  node packages/link.js --all            挂进所有 node 应用
  node packages/link.js --copy <应用>    复制而不是软链
  node packages/link.js --force <应用>   覆盖已有的真实目录
`);
}

/* ── 应用清单 ─────────────────────────────────────────────────── */

/** {name, dir, type} —— 以内核的 apps.json 为准，读不到就扫目录 */
function listApps() {
  const out = [];
  const seen = new Set();
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(ROOT, 'var/runx/apps.json'), 'utf8')); } catch (e) { /* 还没装过应用 */ }

  for (const a of (state && state.apps) || []) {
    const dir = a.cwd || path.join(APPS, a.name);
    out.push({ name: a.name, dir, type: a.type || 'node' });
    seen.add(path.resolve(dir));
  }
  let entries = [];
  try { entries = fs.readdirSync(APPS, { withFileTypes: true }); } catch (e) { /* 无 apps 目录 */ }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(APPS, e.name);
    if (seen.has(path.resolve(dir))) continue;
    const hasAppex = fs.existsSync(path.join(dir, 'appex.json'));
    if (!hasAppex) continue;
    out.push({ name: e.name, dir, type: 'node' });
  }
  return out;
}

function resolveTargets() {
  const apps = listApps();
  if (FLAGS.all) return apps.filter((a) => a.type !== 'web');

  const picked = [];
  for (const t of targets) {
    const abs = path.resolve(t);
    const byDir = apps.find((a) => path.resolve(a.dir) === abs);
    if (byDir) { picked.push(byDir); continue; }
    const byName = apps.find((a) => a.name === t);
    if (byName) { picked.push(byName); continue; }
    // 传了个目录但也还没装进 apps.json：只要有 package.json 就当应用
    if (fs.existsSync(path.join(abs, 'package.json'))) {
      picked.push({ name: path.basename(abs), dir: abs, type: 'node' });
      continue;
    }
    console.error(`找不到应用：${t}（不在 apps.json，也不是带 package.json 的目录）`);
  }
  return picked;
}

/* ── 链接 ─────────────────────────────────────────────────────── */

function isLinked(link, dest) {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return false;
    return path.resolve(path.dirname(link), fs.readlinkSync(link)) === path.resolve(dest);
  } catch (e) { return false; }
}

function linkInto(app, pkg) {
  const scope = path.join(app.dir, 'node_modules', '@runx');
  const link = path.join(scope, pkg.name.split('/')[1] || pkg.name);
  fs.mkdirSync(scope, { recursive: true });

  if (isLinked(link, pkg.full)) return 'already';

  let existed = null;
  try { existed = fs.lstatSync(link); } catch (e) { existed = null; }
  if (existed && !existed.isSymbolicLink() && !FLAGS.force) {
    // 应用自己 npm i 过一份（真实目录）。不硬覆盖 —— 用户可能是有意的
    return 'occupied';
  }
  if (existed) fs.rmSync(link, { recursive: true, force: true });

  if (FLAGS.copy) {
    cpDir(pkg.full, link);
    return 'copied';
  }
  // 相对软链：仓库整体挪走也不会断
  fs.symlinkSync(path.relative(scope, pkg.full), link, 'dir');
  return 'linked';
}

function cpDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) cpDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 挂完真的 require 一次 —— 软链对不对，只有解析一次才知道 */
function verify(app, pkg) {
  try {
    const m = require.resolve(pkg.name, { paths: [app.dir] });
    return { ok: true, resolved: path.relative(ROOT, m) };
  } catch (e) {
    return { ok: false, error: e.message.split('\n')[0] };
  }
}

/* ── 主流程 ───────────────────────────────────────────────────── */

const apps = listApps();
if (!targets.length && !FLAGS.all) {
  // 只打印状态：避免「敲个命令就改了所有应用」
  console.log('\n包（git 分发，不发 npm）：');
  for (const p of PKGS) {
    console.log(`  ${p.name.padEnd(12)} v${p.version}  packages/${p.dir}`);
  }
  console.log('\n应用与挂载情况：');
  if (!apps.length) console.log('  （还没有应用）');
  for (const app of apps) {
    const marks = PKGS.map((p) => {
      const link = path.join(app.dir, 'node_modules', '@runx', p.name.split('/')[1]);
      if (isLinked(link, p.full)) return p.name.split('/')[1] + '✓';
      if (fs.existsSync(link)) return p.name.split('/')[1] + '·';   // 有，但不是我们挂的
      return p.name.split('/')[1] + '✗';
    });
    console.log(`  ${app.name.padEnd(12)} ${marks.join('  ')}`);
  }
  console.log('\n挂载：node packages/link.js <应用>   全部：--all\n');
  process.exit(0);
}

const picked = resolveTargets();
if (!picked.length) {
  console.error('\n没有可挂的应用。');
  process.exit(1);
}

let bad = 0;
for (const app of picked) {
  console.log(`\n${app.name}  (${path.relative(ROOT, app.dir)})`);
  for (const pkg of PKGS) {
    let how;
    try { how = linkInto(app, pkg); } catch (e) {
      console.log(`  ✗ ${pkg.name} 挂载失败：${e.message}`);
      bad++;
      continue;
    }
    if (how === 'occupied') {
      console.log(`  ! ${pkg.name} 已有真实目录，未覆盖（要换成本仓库的用 --force）`);
      bad++;
      continue;
    }
    const v = verify(app, pkg);
    const label = how === 'linked' ? '已挂载' : how === 'copied' ? '已复制' : how === 'already' ? '已就绪' : how;
    if (v.ok) console.log(`  ✓ ${pkg.name.padEnd(12)} ${label}`);
    else { console.log(`  ✗ ${pkg.name.padEnd(12)} ${label}但解析失败：${v.error}`); bad++; }
  }
}

if (FLAGS.copy) console.log('\n注意：--copy 是快照，仓库更新后要重跑；软链（默认）不用。');
process.exit(bad ? 1 : 0);
