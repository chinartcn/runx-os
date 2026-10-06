'use strict';

/**
 * @runx-files —— RunX 文件管理器核心扩展
 *
 * 服务端：站点的文件浏览 / 预览 /（可选）写入 REST，以及一条前端资源通道。
 * 客户端：双栏文件管理器（目录列表 + 预览/编辑），见 client.js。
 *
 * REST 走 /runx/files*（NavExt 内核自留 /api/*）。
 *
 * ── 为什么不用内核的 /api/fs/* ──
 * 内核的 /api/fs/* 是「通用文件服务」，载荷面窄（list 跳过隐藏项、无 stat 的编码
 * 判定、无 rename），而且写开关 api.fs.write 是**站点级**的（一开就是全站可写）。
 * 文件管理器需要更细的粒度：默认整站只读、写入可限定在一个子目录内、且内核自身
 * 的文件永远只读。所以这里自建一条 REST，把策略收在扩展这一层。
 *
 * ── 能力面 ──
 *   读：ctx.os.files（root 受限，不跳隐藏路径，能看 .js/）
 *       —— 比 ctx.project 更合适：ctx.project 会拒绝任何以 '.' 开头的路径段。
 *   写：同样走 ctx.os.files，但先过 assertWritable() 策略闸门。
 *
 * ── 写策略（默认全关）──
 *   1) 扩展配置 allow_write 必须为 true（默认 false）。
 *   2) 永远拒绝写这些：内核文件 server.js / os.js / .navext.client.js / build.js /
 *      cli.js / vm.js / server.json / package.json / start.sh / install.sh，
 *      以及整个 .git/ 与内核的 .js/ 扩展目录。
 *      —— 这些是「改了站点就起不来」的东西，不属于日常文件管理的范畴。
 *   3) 可选 write_root：若配置了，写入被限定在该子目录内（读不受限）。
 */

const API = '/runx';
const fs = require('fs');
const path = require('path');

const ASSETS_PREFIX = API + '/files-assets/';

const ASSET_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.json': 'application/json; charset=utf-8',
};

/** 单次读取上限（文本预览；超出只回尾部提示，不做流式） */
const MAX_READ = 2 * 1024 * 1024;
/** 单次写入上限 */
const MAX_WRITE = 4 * 1024 * 1024;
/** 列目录上限 */
const MAX_LIST = 2000;
/** 允许上传/写入的文本扩展名（二进制文件不通过 JSON 接口写） */
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg', '.yml', '.yaml', '.toml', '.ini',
  '.conf', '.env', '.sh', '.bash', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp',
  '.sql', '.log', '.csv', '.tsv', '.gitignore', '.npmrc', '.editorconfig',
]);

/**
 * 内核自保名单：这些路径永远不可写。
 * 判据是「写坏了站点就起不来」——不是权限问题，是可用性问题。
 */
const PROTECTED_FILES = new Set([
  'server.js', 'os.js', 'cli.js', 'build.js', 'vm.js', '.navext.client.js',
  'server.json', 'package.json', 'package-lock.json', 'pnpm-lock.yaml',
  'start.sh', 'install.sh', 'LICENSE',
]);
const PROTECTED_DIRS = ['.git', '.js', 'node_modules'];

let S = null;

module.exports = {
  onInit(ctx) {
    const os = ctx.os;
    const ROOT = ctx.root;            // 站点根（ctx.os 的白名单里没有 root）
    const cfg = () => ctx.config || {};

    const allowWrite = () => cfg().allow_write === true;
    const writeRoot = () => {
      const r = String(cfg().write_root || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      return r;
    };
    const intOf = (v, dflt, min, max) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return dflt;
      return Math.max(min, Math.min(max, Math.trunc(n)));
    };

    /* ── 路径归一化 ──
     * 统一成「相对 root 的 posix 路径，无前导 /，无尾随 /」，'.' 表示根。
     * 拒绝 NUL 与 .. 段；越界由 os.files 的 resolveUnderRoot 再兜一层。 */
    function normPath(p) {
      let s = String(p === undefined || p === null ? '' : p);
      if (s.includes('\u0000')) return { error: '路径含非法字符' };
      s = s.replace(/\\/g, '/').trim();
      s = s.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!s || s === '.') return { rel: '' };
      const segs = s.split('/');
      for (const seg of segs) {
        if (!seg || seg === '.') return { error: '路径含空段' };
        if (seg === '..') return { error: '不允许使用 .. 上溯' };
      }
      return { rel: segs.join('/') };
    }

    /** 写保护判定：返回 null 表示可写，否则返回拒绝原因 */
    function writeBlocked(rel) {
      if (!allowWrite()) return '写入未开启（请在扩展配置中启用 allow_write）';
      if (!rel) return '不能写入站点根目录';
      const segs = rel.split('/');
      const base = segs[segs.length - 1];
      for (const d of PROTECTED_DIRS) {
        if (segs[0] === d || segs.includes(d)) return `禁止修改内核目录 ${d}/`;
      }
      if (segs.length === 1 && PROTECTED_FILES.has(base)) return `禁止修改内核文件 ${base}`;
      const wr = writeRoot();
      if (wr) {
        if (rel !== wr && !rel.startsWith(wr + '/')) return `写入被限定在 ${wr}/ 内`;
      }
      return null;
    }

    /* ── 读：列目录 ── */
    function listDir(rel, opts) {
      const showHidden = !!(opts && opts.all);
      const depth = intOf(opts && opts.depth, 1, 1, 3);
      const full = os.files.list(rel || '');

      let names = full;
      if (!showHidden) names = names.filter((n) => !n.startsWith('.'));

      const entries = [];
      for (const name of names) {
        if (entries.length >= MAX_LIST) break;
        const childRel = rel ? rel + '/' + name : name;
        let st;
        try { st = fs.lstatSync(path.join(ROOT, childRel)); }
        catch { continue; }
        const isDir = st.isDirectory();
        const isLink = st.isSymbolicLink();
        entries.push({
          name,
          path: childRel,
          type: isDir ? 'dir' : (st.isFile() ? 'file' : 'other'),
          size: isDir ? null : st.size,
          mtime: Math.round(st.mtimeMs),
          isDir,
          isFile: st.isFile(),
          isLink,
          ext: isDir ? '' : path.extname(name).toLowerCase(),
          text: !isDir && TEXT_EXT.has(path.extname(name).toLowerCase()),
          protected: isProtected(childRel),
        });
        if (isDir && depth > 1) {
          // 仅在请求深度 > 1 时递归，避免一次把整站扫光
          const sub = listDir(childRel, { all: showHidden, depth: depth - 1 });
          if (sub.entries) {
            sub.entries.forEach((e) => { if (entries.length < MAX_LIST) entries.push(e); });
          }
        }
      }

      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
      });

      return {
        path: rel || '',
        entries,
        count: entries.length,
        truncated: entries.length >= MAX_LIST,
      };
    }

    /** 是否属于内核自保范围（前端用来把「删除/重命名」按钮置灰） */
    function isProtected(rel) {
      if (!rel) return true;
      const segs = rel.split('/');
      for (const d of PROTECTED_DIRS) if (segs.includes(d)) return true;
      if (segs.length === 1 && PROTECTED_FILES.has(segs[0])) return true;
      return false;
    }

    /* ── 读：单文件 ── */
    function statOf(rel) {
      const full = os.files.exists(rel) ? path.join(ROOT, rel) : null;
      if (!full) return { error: '不存在' };
      let st;
      try { st = fs.statSync(full); } catch { return { error: '不存在' }; }
      const ext = path.extname(rel).toLowerCase();
      return {
        path: rel,
        type: st.isDirectory() ? 'dir' : (st.isFile() ? 'file' : 'other'),
        size: st.size,
        mtime: Math.round(st.mtimeMs),
        ctime: Math.round(st.ctimeMs),
        ext,
        isDir: st.isDirectory(),
        isFile: st.isFile(),
        text: st.isFile() && TEXT_EXT.has(ext),
        protected: isProtected(rel),
      };
    }

    function readFile(rel, opts) {
      const st = statOf(rel);
      if (st.error) return st;
      if (st.isDir) return { error: '这是一个目录' };
      if (st.size > MAX_READ) {
        return { error: `文件过大（${st.size} 字节），超过 ${MAX_READ} 上限`, size: st.size, tooLarge: true };
      }
      const isBuffer = (opts && opts.encoding) === 'base64';
      let content;
      try { content = os.files.read(rel); } catch (e) { return { error: e.message }; }
      if (isBuffer) {
        let buf;
        try { buf = fs.readFileSync(path.join(ROOT, rel)); } catch (e) { return { error: e.message }; }
        return {
          path: rel, content: buf.toString('base64'), encoding: 'base64',
          size: st.size, returnedBytes: st.size, truncated: false,
          mime: ASSET_MIME[st.ext] || 'application/octet-stream', isText: false, mtime: st.mtime,
        };
      }
      return {
        path: rel, content, encoding: 'utf8',
        size: st.size, returnedBytes: Buffer.byteLength(content, 'utf8'), truncated: false,
        mime: ASSET_MIME[st.ext] || 'text/plain; charset=utf-8', isText: st.text, mtime: st.mtime,
      };
    }

    /* ── 写：全部过 writeBlocked ── */
    function writeFile(rel, content) {
      const block = writeBlocked(rel);
      if (block) return { error: block, blocked: true };
      const text = String(content === undefined || content === null ? '' : content);
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_WRITE) return { error: `内容过大（${bytes} 字节）` };
      try {
        // 确保父目录存在：文件管理器里「另存为新路径」很常见
        const dir = path.dirname(rel);
        if (dir && dir !== '.') os.files.mkdir(dir);
        os.files.write(rel, text);
      } catch (e) { return { error: e.message }; }
      return { path: rel, bytes };
    }

    function mkdir(rel) {
      const block = writeBlocked(rel);
      if (block) return { error: block, blocked: true };
      if (os.files.exists(rel)) return { error: '同名条目已存在' };
      try { os.files.mkdir(rel); } catch (e) { return { error: e.message }; }
      return { path: rel };
    }

    function removeEntry(rel) {
      const block = writeBlocked(rel);
      if (block) return { error: block, blocked: true };
      if (!rel) return { error: '不能删除站点根目录' };
      if (!os.files.exists(rel)) return { error: '不存在' };
      try { os.files.remove(rel); } catch (e) { return { error: e.message }; }
      return { path: rel, removed: true };
    }

    function renameEntry(fromRel, toRel) {
      const b1 = writeBlocked(fromRel);
      if (b1) return { error: b1, blocked: true };
      const b2 = writeBlocked(toRel);
      if (b2) return { error: b2, blocked: true };
      if (!os.files.exists(fromRel)) return { error: '源不存在' };
      if (os.files.exists(toRel)) return { error: '目标已存在' };
      try {
        const dir = path.dirname(toRel);
        if (dir && dir !== '.') os.files.mkdir(dir);
        os.files.copy(fromRel, toRel);
        os.files.remove(fromRel);
      } catch (e) { return { error: e.message }; }
      return { from: fromRel, to: toRel, moved: true };
    }

    /* ── 前端资源 ── */
    function rewriteCssUrls(css, cssRel) {
      const dir = path.posix.dirname(cssRel.split(path.sep).join('/'));
      return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
        if (/^(data:|https?:|\/\/|#)/i.test(u)) return m;
        const joined = dir === '.' ? u : dir + '/' + u;
        return 'url(' + q + ASSETS_PREFIX + path.posix.normalize(joined.replace(/^\.\//, '')) + q + ')';
      });
    }

    function serveAsset(rel, reqEth) {
      const safe = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
      if (!safe || safe.includes('\u0000')) return assetText(400, '非法路径');
      const ext = path.extname(safe).toLowerCase();
      const type = ASSET_MIME[ext];
      if (!type) return assetText(404, '找不到该资源');
      let full;
      try { full = ctx.fs.path(safe); } catch { return assetText(403, '禁止访问'); }
      let st;
      try { st = fs.statSync(full); } catch { return assetText(404, '找不到该资源'); }
      if (!st.isFile()) return assetText(404, '不是文件');
      const etag = '"' + st.mtimeMs.toString(36) + '-' + st.size.toString(36) + '"';
      const headers = {
        'Content-Type': type, 'ETag': etag,
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      };
      if (reqEth && reqEth === etag) return { status: 304, headers, body: '' };
      return { status: 200, headers, body: fs.readFileSync(full) };
    }

    function assetText(status, text) {
      return { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text };
    }

    S = {
      json: (status, obj) => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(obj) }),
      err: (code, message, data) => ({ status: code, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: { code, message, data } }) }),
      normPath, listDir, statOf, readFile, writeFile, mkdir, removeEntry, renameEntry,
      serveAsset, rewriteCssUrls, writeBlocked, isProtected,
      meta: () => ({
        id: '@runx-files',
        assets_prefix: ASSETS_PREFIX,
        root: '',
        allow_write: allowWrite(),
        write_root: writeRoot() || null,
        // 这两个必须吐出来：客户端的「隐藏项」开关与新建按钮的禁用态
        // 都以 meta 为准，漏了就会出现「配置改了但界面没变」
        show_hidden: cfg().show_hidden === true,
        max_read: MAX_READ,
        max_write: MAX_WRITE,
        protected_files: Array.from(PROTECTED_FILES),
        protected_dirs: PROTECTED_DIRS.slice(),
      }),
    };

    ctx.log('files ready, allow_write=' + allowWrite() + (writeRoot() ? ', write_root=' + writeRoot() : ''));
  },

  /** 内核统计端点用：必须同步返回 */
  stats() {
    if (!S) return { ready: false };
    return {
      ready: true,
      allow_write: S.meta().allow_write,
      write_root: S.meta().write_root,
    };
  },

  onRequest(req, url, ctx) {
    const p = url.pathname;
    if (!p.startsWith(API + '/files')) return undefined;   // 其它 /runx/* 交给兄弟扩展
    if (!S) return undefined;
    const q = (k) => url.searchParams.get(k);

    /* 前端资源 */
    if (p.startsWith(ASSETS_PREFIX)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return { status: 405, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' }, body: '405' };
      }
      const rel = decodeURIComponent(p.slice(ASSETS_PREFIX.length));
      const r = S.serveAsset(rel, req.headers['if-none-match']);
      if (r.status === 200 && typeof r.body === 'string' && /\.css$/i.test(rel)) {
        return Object.assign({}, r, { body: S.rewriteCssUrls(r.body, rel) });
      }
      return r;
    }

    if (req.method === 'GET' && p === API + '/files') {
      return S.json(200, { meta: S.meta(), tree: S.listDir('', { all: q('all') === '1' }) });
    }
    if (req.method === 'GET' && p === API + '/files/meta') return S.json(200, S.meta());

    /* 列目录 */
    if (req.method === 'GET' && p === API + '/files/list') {
      const np = S.normPath(q('path'));
      if (np.error) return S.err(400, np.error);
      try {
        return S.json(200, S.listDir(np.rel, { all: q('all') === '1', depth: q('depth') }));
      } catch (e) { return S.err(404, e.message, { path: np.rel }); }
    }

    /* 单文件元信息 */
    if (req.method === 'GET' && p === API + '/files/stat') {
      const np = S.normPath(q('path'));
      if (np.error) return S.err(400, np.error);
      const st = S.statOf(np.rel);
      if (st.error) return S.err(404, st.error, { path: np.rel });
      return S.json(200, st);
    }

    /* 读文件 */
    if (req.method === 'GET' && p === API + '/files/read') {
      const np = S.normPath(q('path'));
      if (np.error) return S.err(400, np.error);
      const r = S.readFile(np.rel, { encoding: q('encoding') });
      if (r.error) return S.err(r.tooLarge ? 413 : 404, r.error, { path: np.rel, size: r.size });
      return S.json(200, r);
    }

    /* 下载（原样字节，供二进制文件） */
    if (req.method === 'GET' && p === API + '/files/download') {
      const np = S.normPath(q('path'));
      if (np.error) return S.err(400, np.error);
      const st = S.statOf(np.rel);
      if (st.error || st.isDir) return S.err(404, '不是可下载的文件', { path: np.rel });
      // ctx.fs 只限扩展自身目录，站点文件要走绝对路径
      let buf;
      try { buf = fs.readFileSync(path.join(ctx.root, np.rel)); }
      catch (e) { return S.err(404, e.message, { path: np.rel }); }
      const name = np.rel.split('/').pop();
      return {
        status: 200,
        headers: {
          'Content-Type': ASSET_MIME[st.ext] || 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="' + encodeURIComponent(name) + '"',
          'Content-Length': String(buf.length),
          'X-Content-Type-Options': 'nosniff',
        },
        body: buf,
      };
    }

    /* ── 写操作：统一先读 JSON body 再执行 ── */
    if (req.method === 'POST' && p === API + '/files/write') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        const np = S.normPath(b.path);
        if (np.error) return S.err(400, np.error);
        const r = S.writeFile(np.rel, b.content);
        if (r.error) return S.err(r.blocked ? 403 : 422, r.error, { path: np.rel });
        return S.json(200, r);
      });
    }
    if (req.method === 'POST' && p === API + '/files/mkdir') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        const np = S.normPath(b.path);
        if (np.error) return S.err(400, np.error);
        const r = S.mkdir(np.rel);
        if (r.error) return S.err(r.blocked ? 403 : 422, r.error, { path: np.rel });
        return S.json(200, r);
      });
    }
    if (req.method === 'POST' && p === API + '/files/rename') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        const nf = S.normPath(b.from); const nt = S.normPath(b.to);
        if (nf.error || nt.error) return S.err(400, nf.error || nt.error);
        const r = S.renameEntry(nf.rel, nt.rel);
        if (r.error) return S.err(r.blocked ? 403 : 422, r.error);
        return S.json(200, r);
      });
    }
    if (req.method === 'POST' && p === API + '/files/delete') {
      return Promise.resolve(ctx.readJson().catch(() => ({}))).then((b) => {
        const np = S.normPath(b.path);
        if (np.error) return S.err(400, np.error);
        const r = S.removeEntry(np.rel);
        if (r.error) return S.err(r.blocked ? 403 : 422, r.error, { path: np.rel });
        return S.json(200, r);
      });
    }

    return S.err(404, '未知的文件接口', { path: p });
  },
};
