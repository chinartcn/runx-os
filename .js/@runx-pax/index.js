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

// 远程安装的下载上限。应用不该有 1GB —— 那是另一个问题。
const MAX_DOWNLOAD = 64 * 1024 * 1024;

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

/**
 * 在解包后的目录里找到「应用根目录」—— 也就是含 appex.json 的那一层。
 *
 * ── 为什么需要这一步 ────────────────────────────────────────────
 * 商店里绝大多数应用来自 GitHub 仓库，下载到的是**仓库归档**：
 *
 *     runx-os-main/
 *       apps/demo/appex.json     ← 应用在这
 *       packages/...
 *       README.md
 *
 * 顶层是仓库名，不是应用。所以只认「根目录有 appex.json」的话，
 * **每一个 GitHub 源的应用都装不上**，报错是「缺少 appex.json」——
 * 而开发者明明放了 appex.json，排查起来很费劲。
 *
 * ── 三种定位方式，按可靠度从高到低 ──────────────────────────────
 * 1. 显式 subdir（meta.json 里 source.subdir 声明，如 "apps/demo"）
 *    → 直接用，不猜。多个候选时也用它消歧。
 * 2. 自动探测：全树找 appex.json，**只有一个** → 就是它。
 * 3. 多个候选 → 报错，把候选列出来让人选。不猜。
 *
 * 为什么不在有多个候选时随便挑一个：挑错了装出来的就是个别的应用，
 * 而错误信息（名字不对）比「装不上」难查得多。
 */
function findAppRoots(dir, maxDepth = 4) {
  const found = [];
  // 解包根目录本身就是应用根（appex.json 直接躺在根上）—— 这是最常见的形状：
  // 本地装一个应用目录、或开发者打包时把应用内容放在根上。
  // 漏掉这一条，「包里没有 appex.json」就成了本地安装必踩的坑。
  try {
    if (fs.existsSync(path.join(dir, 'appex.json'))) found.push(dir);
  } catch { /* 忽略 */ }
  const walk = (cur, depth) => {
    if (depth > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { return; }
    for (const e of ents) {
      // node_modules 里也可能躺着 appex.json（应用自己 npm 装的依赖），
      // 但那不是「这个包的应用」—— 跳过，免得选错。
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const abs = path.join(cur, e.name);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (fs.existsSync(path.join(abs, 'appex.json'))) found.push(abs);
      walk(abs, depth + 1);
    }
  };
  walk(dir, 0);
  return found;
}

/**
 * 定位应用根目录。返回绝对路径；定位不到就抛错（错误信息要说清怎么办）。
 *
 * @param {string} tmp    解包后的临时目录
 * @param {string} subdir 开发者声明的应用在包内的相对路径（可空）
 */
function resolveAppRoot(tmp, subdir) {
  const want = String(subdir || '').trim().replace(/^\/+|\/+$/g, '');

  // 显式 subdir：按「路径后缀」匹配，而不是猜绝对路径。
  // 为什么要后缀匹配：仓库归档的顶层目录名是「仓库名-分支名」
  // （runx-os-main / runx-os-abc1234），开发者写 meta.json 时并不知道
  // （也不该知道）那层叫什么。写 "apps/demo" 就该在任何顶层下都能命中。
  if (want) {
    const roots = findAppRoots(tmp);
    const hit = roots.find((r) => {
      const rel = path.relative(tmp, r).split(path.sep).join('/');
      return rel === want || rel.endsWith('/' + want);
    });
    if (hit) return hit;
    // 直接按路径试一次（应用就在解包根的下一层，且包不是仓库归档）
    const direct = path.join(tmp, want);
    if (fs.existsSync(path.join(direct, 'appex.json'))) return direct;
    const rel = roots.map((r) => path.relative(tmp, r).split(path.sep).join('/')).sort();
    throw new Error(
      'subdir "' + want + '" 下没有应用。' +
      (rel.length ? '包里的候选：' + rel.join('、') : '包里没有 appex.json')
    );
  }

  const roots = findAppRoots(tmp);
  if (roots.length === 1) return roots[0];
  if (roots.length === 0) {
    throw new Error(
      '包里没有 appex.json。确认这个包是应用包，而不是整个仓库'
    );
  }
  // 多个候选 —— 把它们列出来，让人选，而不是替人猜
  const rel = roots.map((r) => path.relative(tmp, r) || '.').sort();
  throw new Error(
    '包里有多个应用，请指定 source.subdir。候选：' + rel.join('、') +
    '（在 meta.json 里加 "source": {"subdir": "..."}）'
  );
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

/**
 * 把内核自带的系统包挂到 <root>/node_modules/@runx/ 下。
 *
 * ── 为什么需要这一步 ────────────────────────────────────────────
 * @runx/sdk、@runx/host 是**内核的一部分**，不发 npm（packages/ 下就是源码）。
 * 应用 require 它们，靠的是 Node 的模块解析链：
 *
 *     apps/<name>/app.js  →  apps/<name>/node_modules
 *                        →  apps/node_modules
 *                        →  <root>/node_modules      ← 挂在这里
 *
 * 开发时 packages/link.js 会在每个应用目录里建软链，但**商店装的应用**没有
 * 那一步：tarball 里没有 node_modules（.gitignore 掉了），装完直接
 * require('@runx/sdk') 就是 MODULE_NOT_FOUND —— 表现为「一启动就死」。
 *
 * 挂在 <root> 而不是应用目录里，还有个好处：应用目录要过 validateDir，
 * 那里软链是被拒绝的（防解包时越界）。放在根上，validateDir 碰不到它。
 *
 * 软链而不是复制：包更新了应用下次 require 就是新的，不会出现
 * 「某个应用里躺着一份两年前的 SDK」。
 */
function ensureSystemPackages(root) {
  const pkgsRoot = path.join(root, 'packages');
  const scope = path.join(root, 'node_modules', '@runx');
  const names = ['runx-sdk', 'runx-host'];
  const made = [];
  for (const dir of names) {
    const src = path.join(pkgsRoot, dir);
    try { if (!fs.statSync(src).isDirectory()) continue; } catch { continue; }
    // 包目录名是 runx-sdk，对外的包名是 @runx/sdk
    const pkgName = dir.replace(/^runx-/, '');
    const dest = path.join(scope, pkgName);
    fs.mkdirSync(scope, { recursive: true });
    // 已经是软链且指向对的地方 → 不动（幂等）
    try {
      const st = fs.lstatSync(dest);
      if (st.isSymbolicLink()) {
        const cur = path.resolve(path.dirname(dest), fs.readlinkSync(dest));
        if (cur === path.resolve(src)) continue;
      } else {
        continue; // 真实目录：有人自己装了一份，不覆盖
      }
    } catch { /* 不存在 → 下面建 */ }
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 忽略 */ }
    try {
      fs.symlinkSync(path.relative(scope, src), dest, 'dir');
      made.push('@runx/' + pkgName);
    } catch (e) {
      // 软链不让建（某些文件系统）→ 退回复制，功能不打折
      try {
        fs.cpSync(src, dest, { recursive: true });
        made.push('@runx/' + pkgName + '(复制)');
      } catch { /* 实在不行就算了，应用自己也能带依赖 */ }
    }
  }
  return made;
}

module.exports = {

  onInit(ctx) {
    const os = ctx.os;
    const root = ctx.root;
    const cfg = Object.assign({ pnpm_path: 'pnpm', install_timeout_ms: 300000 }, ctx.config || {});
    os.writeState('pax.conf', { pnpm_path: cfg.pnpm_path, install_timeout_ms: cfg.install_timeout_ms });

    // 系统包先挂上：装应用之前就得能用，否则应用起来就 MODULE_NOT_FOUND
    try {
      const made = ensureSystemPackages(root);
      if (made.length && typeof os.logAppend === 'function') {
        os.logAppend('pax', '系统包已挂载：' + made.join('、'));
      }
    } catch { /* 挂不上不该拦住内核启动 */ }

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
      // permissions：应用声明的能力（`fs.read:/sdcard/**` 这种）。安装时原样
      // 搬进 apps.json，由 @runx-node-safety 翻译成 Node 的 --allow-* 开关。
      // 格式非法就整条丢掉，不猜 —— 围栏宁可少开，也不能开成错的。
      let permissions;
      if (Array.isArray(appex.permissions)) {
        permissions = appex.permissions
          .filter((x) => typeof x === 'string' && /^[a-z]+\.[a-z]+(:.*)?$/.test(x.trim()))
          .map((x) => x.trim())
          .slice(0, 32);
        if (!permissions.length) permissions = undefined;
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
        permissions,
        installed_at: Date.now(),
      };
    }

    async function finalizeInstall(tmp, subdir) {
      validateDir(tmp);
      // 先定位应用根 —— 仓库归档的顶层是仓库名，应用在子目录里
      const appRoot = resolveAppRoot(tmp, subdir);
      const appexPath = path.join(appRoot, 'appex.json');
      if (!fs.existsSync(appexPath)) throw new Error('缺少 appex.json');
      const appex = JSON.parse(fs.readFileSync(appexPath, 'utf8'));
      const name = appex.name;
      if (!validateName(name)) throw new Error('应用名非法：' + name);
      if (appex.type === 'node' && !(Number(appex.port) >= 1024 && Number(appex.port) <= 65535)) {
        throw new Error('node 应用端口必须在 1024~65535');
      }
      const dest = path.join(root, appsRel, name);
      // 源目录就是目标目录的情况（「把这个应用目录装回自己」）：
      // 流程是 复制到 tmp → 删 dest → 从 tmp 复制回来。数据能回来，
      // 但中间那一瞬源目录是消失的 —— 万一中途失败，应用就没了。
      // 这种情况直接拒绝：它没有意义（装到自己身上的都是自己）。
      const appRootReal = (() => { try { return fs.realpathSync(appRoot); } catch { return appRoot; } })();
      const destReal = (() => { try { return fs.realpathSync(dest); } catch { return dest; } })();
      if (appRootReal === destReal) {
        throw new Error('这个应用已经在它的位置上了，不需要安装');
      }
      // 应用的数据目录在更新时必须保住 —— 它不属于代码，属于用户。
      // 直接 rmSync 整目录会把 data/ 一起抹掉，用户攒的东西就没了。
      // 做法：先把 data/ 挪到临时位置，装完再放回去。
      const dataRel = (appex && appex.data_dir) || 'data';
      const destData = path.join(dest, dataRel);
      let savedData = null;
      if (fs.existsSync(destData)) {
        savedData = path.join(root, 'var', 'runx', '.keep-data-' + name + '-' + Date.now());
        try {
          fs.mkdirSync(path.dirname(savedData), { recursive: true });
          fs.renameSync(destData, savedData);
        } catch (e) {
          savedData = null;   // 挪不动就认了：数据没了也不能让安装失败
        }
      }
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      // 只搬应用自己那一层：仓库归档里的 packages/、README 之类不该进应用目录
      fs.cpSync(appRoot, dest, { recursive: true });
      validateDir(dest);
      // 数据放回去
      if (savedData) {
        try {
          fs.mkdirSync(path.dirname(destData), { recursive: true });
          fs.renameSync(savedData, destData);
        } catch { /* 放不回去就算了，不能让安装失败 */ }
      }
      await runPnpm(name);
      const entry = buildEntry(appex, name);
      upsertApp(entry);
      return entry;
    }

    async function installFromArchive(tarball, subdir) {
      const tmp = path.join(root, 'var', 'runx', '.install-' + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
      try {
        safeExtractTar(tarball, tmp);
        const entry = await finalizeInstall(tmp, subdir);
        return { name: entry.name, version: entry.version, installed_at: entry.installed_at };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    async function installFromDir(srcDir, subdir) {
      const tmp = path.join(root, 'var', 'runx', '.install-' + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
      try {
        fs.cpSync(srcDir, tmp, { recursive: true });
        const entry = await finalizeInstall(tmp, subdir);
        return { name: entry.name, version: entry.version, installed_at: entry.installed_at };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    /**
     * 远程安装：下载 tarball → 安全解包 → 装。
     *
     * 与本地安装走的是**同一套** safeExtractTar —— 远程来的包不会因为
     * 「是网上的」就少一道校验。软链、绝对路径、../ 一样被拒。
     *
     * 下载有上限（MAX_DOWNLOAD），免得一个「1GB 的包」把用户磁盘吃满。
     * 走商店代理时由 Worker 负责在源站失败后轮询镜像。
     */
    async function installFromRemote(url, subdir) {
      const tmp = path.join(root, 'var', 'runx', '.install-' + Date.now());
      const tarPath = path.join(root, 'var', 'runx', '.download-' + Date.now() + '.tar.gz');
      fs.mkdirSync(tmp, { recursive: true });
      try {
        const r = await fetch(url, { redirect: 'follow' });
        if (!r.ok) {
          throw Object.assign(new Error('下载失败：HTTP ' + r.status), { code: 502 });
        }
        // 先看 Content-Length，超了直接拒 —— 不下载完再判断
        const len = Number(r.headers.get('content-length') || 0);
        if (len && len > MAX_DOWNLOAD) {
          throw Object.assign(new Error('包太大：' + len + ' 字节，上限 ' + MAX_DOWNLOAD), { code: 413 });
        }
        const chunks = [];
        let got = 0;
        for await (const chunk of r.body) {
          got += chunk.length;
          if (got > MAX_DOWNLOAD) {
            throw Object.assign(new Error('包太大，超过上限 ' + MAX_DOWNLOAD + ' 字节'), { code: 413 });
          }
          chunks.push(chunk);
        }
        fs.writeFileSync(tarPath, Buffer.concat(chunks));
        safeExtractTar(tarPath, tmp);
        const entry = await finalizeInstall(tmp, subdir);
        return {
          name: entry.name, version: entry.version,
          installed_at: entry.installed_at, bytes: got,
        };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(tarPath, { force: true });
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
      const tarPath = path.join(root, 'var', 'runx', '.update-dl-' + Date.now() + '.tar.gz');
      fs.mkdirSync(tmp, { recursive: true });
      try {
        if (source.kind === 'remote') {
          // 与远程安装同一套下载 + 解包 —— 更新路径也不比安装路径宽松
          const r = await fetch(source.url, { redirect: 'follow' });
          if (!r.ok) throw Object.assign(new Error('下载失败：HTTP ' + r.status), { code: 502 });
          const len = Number(r.headers.get('content-length') || 0);
          if (len && len > MAX_DOWNLOAD) {
            throw Object.assign(new Error('包太大，超过上限 ' + MAX_DOWNLOAD + ' 字节'), { code: 413 });
          }
          const chunks = [];
          let got = 0;
          for await (const chunk of r.body) {
            got += chunk.length;
            if (got > MAX_DOWNLOAD) {
              throw Object.assign(new Error('包太大，超过上限 ' + MAX_DOWNLOAD + ' 字节'), { code: 413 });
            }
            chunks.push(chunk);
          }
          fs.writeFileSync(tarPath, Buffer.concat(chunks));
          safeExtractTar(tarPath, tmp);
        } else if (source.kind === 'local' && /\.(tar|gz|tgz)$/i.test(source.path)) {
          safeExtractTar(source.path, tmp);
        } else {
          fs.cpSync(source.path, tmp, { recursive: true });
        }
        validateDir(tmp);
        // 更新同样要定位应用根：仓库归档顶层不是应用目录
        const appRoot = resolveAppRoot(tmp, source.subdir);
        const dest = path.join(root, appsRel, name);
        copyPreserving(appRoot, dest, dataDir ? [dataDir] : []);
        validateDir(dest);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(tarPath, { force: true });
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

    /**
     * 安装源。
     *   source=local  + path   → 本地目录或 tarball 文件
     *   source=remote + url    → 远程 tarball（商店代理或开发者的源）
     *
     * 远程只接受 http/https，且解包器只认 tar 格式 ——
     * 别的格式会在解包时报「条目类型不对」，不会静默装错东西。
     *
     * subdir：应用在包内的相对路径（如 "apps/demo"）。仓库归档的顶层是仓库名，
     * 没有它就只能靠自动探测；包里有多个应用时必须由开发者指明。
     */
    function resolveSource(body) {
      if (!body || typeof body !== 'object') throw new Error('请求体格式错误');
      const subdir = String(body.subdir || '').trim();
      if (subdir.length > 512) throw new Error('subdir 太长');
      if (subdir && /(^|\/)\.\.(\/|$)/.test(subdir)) throw new Error('subdir 不允许含 ..');
      if (body.source === 'remote') {
        const u = String(body.url || '').trim();
        if (!u) throw new Error('缺少 url');
        if (!/^https?:\/\//i.test(u)) throw new Error('只接受 http/https 地址');
        return { kind: 'remote', url: u, subdir };
      }
      if (body.source !== 'local') throw new Error('source 只支持 local 或 remote');
      const p = body.path;
      if (typeof p !== 'string' || !p.trim()) throw new Error('缺少 path');
      return { kind: 'local', path: p.trim() };
    }

    S = {
      json, err, loadApps, installFromArchive, installFromDir, installFromRemote,
      updateApp, uninstallApp, resolveSource, resolveAppRoot, findAppRoots,
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
          const work = src.kind === 'remote'
            ? S.installFromRemote(src.url, src.subdir)
            : (/\.(tar|gz|tgz)$/i.test(src.path)
              ? S.installFromArchive(src.path, src.subdir)
              : S.installFromDir(src.path, src.subdir));
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
          return Promise.resolve(S.updateApp(name, src))
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
