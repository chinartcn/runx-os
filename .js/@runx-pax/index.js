'use strict';

/**
 * @runx-pax —— RunX 包管理核心扩展（文档 §4）
 *
 * 消费 ctx.os.files（根目录受限写）/ ctx.os.exec（pnpm install）/ ctx.os.terminate，
 * 实现 tarball 安全解包 → 读 appex.json → pnpm install → 写 apps.json。
 * install / update / uninstall 后发 ipc 'apps:changed'，由 @runx-supervisor 对齐进程。
 *
 * REST 走 /runx 前缀（NavExt 内核自留 /api/*）。
 */

const API = '/runx';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const segBytes = (s) => Buffer.byteLength(s, 'utf8');

let S = null;

function json(status, obj) {
  return { status, type: 'application/json; charset=utf-8', body: JSON.stringify(obj) };
}
function err(code, message, data) {
  return { status: code, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: { code, message, data } }) };
}

function validateName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && name.length >= 2 && name.length <= 32;
}

/** 递归校验目录：拒绝 symlink / 字符设备 / 块设备 / fifo / socket，限制段长与总长 */
function validateDir(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of ents) {
      const abs = path.join(cur, e.name);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (e.isSymbolicLink() || st.isCharacterDevice() || st.isBlockDevice() || st.isFIFO() || st.isSocket()) {
        throw new Error('拒绝特殊文件：' + path.relative(dir, abs));
      }
      const rel = path.relative(dir, abs);
      for (const s of rel.split(path.sep)) {
        if (segBytes(s) > 255) throw new Error('路径段超长：' + rel);
      }
      if (segBytes(rel) > 4096) throw new Error('完整路径超长：' + rel);
      if (st.isDirectory()) stack.push(abs);
    }
  }
}

/**
 * 安全解包 tar（可含 .gz/.tgz）：在写入前解析每个条目并拒绝不安全类型/路径，
 * 因此不可能经软链写到 dest 之外（文档 §4.3）。
 */
function safeExtractTar(tarball, dest) {
  let buf = fs.readFileSync(tarball);
  if (/\.(gz|tgz)$/i.test(tarball)) buf = zlib.gunzipSync(buf);

  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const header = buf.slice(off, off + 512);
    off += 512;
    if (header.every((b) => b === 0)) break; // 结束块

    let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const sizeStr = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim();
    const size = sizeStr ? (parseInt(sizeStr, 8) || 0) : 0;
    const typeflag = String.fromCharCode(header[156]);

    if (typeflag === 'L') { // GNU 长名
      const data = buf.slice(off, off + size); off += Math.ceil(size / 512) * 512;
      longName = data.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (longName) { name = longName; longName = null; }
    if (typeflag === 'x' || typeflag === 'g') { off += Math.ceil(size / 512) * 512; continue; } // pax 扩展头

    // 只接受普通文件(0/空)与目录(5)；硬链/软链/设备/fifo/socket 一律拒绝
    if (typeflag !== '0' && typeflag !== '\u0000' && typeflag !== '5') {
      throw new Error('拒绝的 tar 条目类型 ' + JSON.stringify(typeflag) + '：' + name);
    }

    const norm = path.normalize(name);
    if (path.isAbsolute(norm) || norm.split('/').some((s) => s === '..')) {
      throw new Error('非法路径段：' + name);
    }
    for (const s of norm.split('/')) {
      if (s === '..') throw new Error('非法路径段：' + name);
      if (segBytes(s) > 255) throw new Error('路径段超长：' + name);
    }
    if (segBytes(norm) > 4096) throw new Error('完整路径超长：' + name);

    const target = path.join(dest, norm);
    if (typeflag === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else {
      const data = buf.slice(off, off + size); off += Math.ceil(size / 512) * 512;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  }
  validateDir(dest); // 二次校验：不得残留任何特殊文件
}

module.exports = {

  onInit(ctx) {
    const os = ctx.os;
    const root = ctx.root;
    const cfg = Object.assign({ pnpm_path: 'pnpm', install_timeout_ms: 300000 }, ctx.config || {});
    os.writeState('pax.conf', { pnpm_path: cfg.pnpm_path, install_timeout_ms: cfg.install_timeout_ms });

    const appsRel = 'apps';

    function loadApps() {
      const f = os.readState('apps.json', { schema: 1, apps: [] });
      return (f && Array.isArray(f.apps)) ? f.apps : [];
    }
    function saveApps(apps) { os.writeState('apps.json', { schema: 1, apps }); }

    function upsertApp(entry) {
      const apps = loadApps();
      const i = apps.findIndex((a) => a.name === entry.name);
      if (i >= 0) apps[i] = Object.assign({}, apps[i], entry);
      else apps.push(entry);
      saveApps(apps);
      os.ipc.emit('apps:changed');
    }
    function removeApp(name) {
      const apps = loadApps().filter((a) => a.name !== name);
      saveApps(apps);
      os.ipc.emit('apps:changed');
    }

    async function runPnpm(name) {
      const cwd = path.join(root, appsRel, name);
      if (!fs.existsSync(path.join(cwd, 'package.json'))) return null;
      return os.exec(cfg.pnpm_path, ['install'], { cwd, timeout: cfg.install_timeout_ms });
    }

    function buildEntry(appex, name) {
      const isNode = appex.type === 'node';
      // 以 appex 清单为准，带边界校验与兜底（文档 §5 AppEntry）
      const RESTART_POLICIES = ['no', 'on-failure', 'always'];
      const restart = RESTART_POLICIES.includes(appex.restart) ? appex.restart : (isNode ? 'on-failure' : 'no');
      const clampNum = (v, min, max, dflt) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
      };
      // env：仅接受字符串值，防止注入非字符串；供 os.spawn 透传给应用进程
      let env;
      if (appex.env && typeof appex.env === 'object' && !Array.isArray(appex.env)) {
        env = {};
        for (const [k, v] of Object.entries(appex.env)) {
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string') env[k] = v;
        }
        if (!Object.keys(env).length) env = undefined;
      }
      return {
        name,
        type: isNode ? 'node' : 'web',
        display_name: appex.display_name || appex.name,
        icon: appex.icon || null,
        cmd: isNode ? (appex.entry ? ('node ' + appex.entry) : 'node app.js') : undefined,
        cwd: path.join(root, appsRel, name),
        port: isNode ? Number(appex.port) || 0 : 0,
        env,
        autostart: appex.autostart === true,
        restart,
        restart_delay_ms: clampNum(appex.restart_delay_ms, 0, 600000, 1000),
        restart_max: clampNum(appex.restart_max, 0, 100, 5),
        restart_window_ms: clampNum(appex.restart_window_ms, 1000, 86400000, 60000),
        data_dir: appex.data_dir || null,
        version: appex.version || '0.0.0',
        description: appex.description || '',
        installed_at: Date.now(),
      };
    }

    async function finalizeInstall(tmp) {
      validateDir(tmp);
      const appexPath = path.join(tmp, 'appex.json');
      if (!fs.existsSync(appexPath)) throw new Error('缺少 appex.json');
      const appex = JSON.parse(fs.readFileSync(appexPath, 'utf8'));
      const name = appex.name;
      if (!validateName(name)) throw new Error('应用名非法：' + name);
      if (appex.type === 'node' && !(Number(appex.port) >= 1024 && Number(appex.port) <= 65535)) {
        throw new Error('node 应用端口必须在 1024~65535');
      }
      const dest = path.join(root, appsRel, name);
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(tmp, dest, { recursive: true });
      validateDir(dest);
      await runPnpm(name);
      const entry = buildEntry(appex, name);
      upsertApp(entry);
      return entry;
    }

    async function installFromArchive(tarball) {
      const tmp = path.join(root, 'var', 'runx', '.install-' + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
      try {
        safeExtractTar(tarball, tmp);
        const entry = await finalizeInstall(tmp);
        return { name: entry.name, version: entry.version, installed_at: entry.installed_at };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    async function installFromDir(srcDir) {
      const tmp = path.join(root, 'var', 'runx', '.install-' + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
      try {
        fs.cpSync(srcDir, tmp, { recursive: true });
        const entry = await finalizeInstall(tmp);
        return { name: entry.name, version: entry.version, installed_at: entry.installed_at };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    function copyPreserving(src, dest, exclude) {
      fs.mkdirSync(dest, { recursive: true });
      for (const item of fs.readdirSync(src)) {
        if (exclude.includes(item)) continue; // 保留目标里已存在的 data_dir
        fs.cpSync(path.join(src, item), path.join(dest, item), { recursive: true });
      }
    }

    async function updateApp(name, source) {
      const entry = loadApps().find((a) => a.name === name);
      if (!entry) throw Object.assign(new Error('应用不存在'), { code: 404 });
      os.terminate(name); // 停进程；supervisor 会在 apps:changed 后决定是否重拉
      const dataDir = entry.data_dir;
      const tmp = path.join(root, 'var', 'runx', '.update-' + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
      try {
        if (source.tarball) safeExtractTar(source.tarball, tmp);
        else fs.cpSync(source.dir, tmp, { recursive: true });
        validateDir(tmp);
        const dest = path.join(root, appsRel, name);
        copyPreserving(tmp, dest, dataDir ? [dataDir] : []);
        validateDir(dest);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      await runPnpm(name);
      const appex = JSON.parse(fs.readFileSync(path.join(root, appsRel, name, 'appex.json'), 'utf8'));
      entry.version = appex.version || entry.version;
      entry.installed_at = Date.now();
      saveApps(loadApps().map((a) => (a.name === name ? entry : a)));
      os.ipc.emit('apps:changed');
      return { name, version: entry.version, installed_at: entry.installed_at };
    }

    function uninstallApp(name) {
      const exists = loadApps().some((a) => a.name === name);
      if (!exists) throw Object.assign(new Error('应用不存在'), { code:404 });
      os.terminate(name);
      const dest = path.join(root, appsRel, name);
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      removeApp(name);
      return { ok: true };
    }

    function resolveSource(body) {
      if (!body || typeof body !== 'object') throw new Error('请求体格式错误');
      if (body.source !== 'local') throw new Error('仅支持 source=local');
      const p = body.path;
      if (typeof p !== 'string' || !p.trim()) throw new Error('缺少 path');
      return p.trim();
    }

    S = {
      json, err, loadApps, installFromArchive, installFromDir,
      updateApp, uninstallApp, resolveSource,
      pnpm_path: cfg.pnpm_path, install_timeout_ms: cfg.install_timeout_ms,
    };
  },

  onRequest(req, url, ctx) {
    const p = url.pathname;
    if (!S) return undefined;

    // POST /runx/apps/install
    if (req.method === 'POST' && p === API + '/apps/install') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((body) => {
        try {
          const src = S.resolveSource(body);
          const isTar = /\.(tar|gz|tgz)$/i.test(src);
          const work = isTar ? S.installFromArchive(src) : S.installFromDir(src);
          return Promise.resolve(work).then((r) => S.json(200, r))
            .catch((e) => S.err(422, e.message));
        } catch (e) { return S.err(422, e.message); }
      });
    }

    const m = p.match(new RegExp('^' + API + '/apps/([^/]+)$'));
    if (!m) return undefined;
    const name = decodeURIComponent(m[1]);

    // POST /runx/apps/:name/update
    if (req.method === 'POST' && p.endsWith('/update')) {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((body) => {
        try {
          const src = S.resolveSource(body);
          const isTar = /\.(tar|gz|tgz)$/i.test(src);
          return Promise.resolve(S.updateApp(name, isTar ? { tarball: src } : { dir: src }))
            .then((r) => S.json(200, r))
            .catch((e) => S.err(e.code === 404 ? 404 : 422, e.message));
        } catch (e) { return S.err(422, e.message); }
      });
    }

    // DELETE /runx/apps/:name
    if (req.method === 'DELETE') {
      try { return S.json(200, S.uninstallApp(name)); }
      catch (e) { return S.err(e.code === 404 ? 404 : 500, e.message); }
    }

    return undefined;
  },
};
