/**
 * meta.json 解析。
 *
 * 开发者发一个 meta.json 到自己的 GitHub Release / npm / 任意静态托管，
 * 商店后台填它的地址，点「一键同步」—— Worker 拉下来、归一化、写入 D1。
 *
 * meta.json 直接沿用 RunX 的 appex.json 字段（name / version / permissions / …），
 * 再加几个商店专用字段。这样开发者不用学第二套格式。
 */

export function parseMeta(text, metaUrl = '') {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const err = new Error('meta.json 不是合法 JSON');
    err.code = 'bad_meta';
    throw err;
  }
  if (!raw || typeof raw !== 'object') {
    const err = new Error('meta.json 必须是一个对象');
    err.code = 'bad_meta';
    throw err;
  }

  const name = raw.name || raw.slug || '';
  if (!name) {
    const err = new Error('meta.json 缺少 name');
    err.code = 'bad_meta';
    throw err;
  }

  const slug = String(raw.slug || name).toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // 权限：既是 RunX 的能力字符串数组，也允许对象形式 {cap, scope}
  const permissions = normalizePermissions(raw.permissions || raw.capabilities || []);

  const source = raw.source || {};
  const sourceType = source.type || raw.source_type || guessType(raw);

  return {
    slug,
    name: raw.display_name || raw.name || slug,
    summary: trim(raw.summary || raw.description || '', 200),
    description: String(raw.description || raw.summary || ''),
    icon_url: raw.icon || raw.icon_url || source.icon || '',
    screenshots: Array.isArray(raw.screenshots) ? raw.screenshots.slice(0, 12) : [],
    category: raw.category || 'other',
    version: String(raw.version || '0.0.0'),
    author: raw.author || raw.maintainer || '',
    homepage: raw.homepage || '',
    repo: raw.repo || raw.repository || '',
    license: raw.license || 'MIT',
    permissions,
    sha256: (raw.sha256 || source.sha256 || '').toLowerCase(),
    size: Number(raw.size || source.size || 0) || 0,
    source_type: sourceType,
    source_url: source.url || raw.source_url || raw.download || raw.url || '',
    download_url: source.download || raw.download_url || raw.tarball || '',
    // 应用在包内的相对路径（如 "apps/demo"）。GitHub 仓库归档的顶层是仓库名，
    // 解包后要靠它找到 appex.json。空 = 让内核自动探测。
    source_subdir: normalizeSubdir(source.subdir || source.path || raw.subdir || ''),
    meta_url: metaUrl,
    manifest: text,
  };
}

/**
 * subdir 归一化：相对路径，不允许越界。
 * 开发者写 "../../etc" 这种是想干什么？直接拒掉，别装出个跑飞的应用。
 */
function normalizeSubdir(v) {
  const s = String(v || '').trim().replace(/^\/+|\/+$/g, '');
  if (!s) return '';
  if (s.length > 512) return '';
  if (s.split('/').some((seg) => seg === '..' || seg === '.')) return '';
  if (/^[a-zA-Z]:/.test(s) || s.includes('\\')) return '';
  return s;
}

function trim(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function guessType(raw) {
  const u = String(raw.source_url || raw.download || raw.url || '');
  if (/github\.com/.test(u)) return 'github';
  if (/registry\.npmjs\.org|npmjs\.com/.test(u)) return 'npm';
  if (/\.r2\.cloudflarestorage\.com|r2\.dev/.test(u)) return 'r2';
  return 'url';
}

/**
 * 权限归一化。
 * 接受三种写法：
 *   "fs.read:/sdcard/**"
 *   ["fs.read:/sdcard/**", "dialog.open"]
 *   [{cap:"fs.read", scope:"/sdcard/**"}]
 * 归一化后一律是字符串数组 —— 前端拿它跟本地缓存的旧值逐条比对。
 */
export function normalizePermissions(list) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  if (typeof list === 'string') {
    // 可能是逗号分隔的一整串
    list.split(',').forEach(push);
  } else if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === 'string') push(item);
      else if (item && typeof item === 'object') {
        const cap = item.cap || item.capability || item.name || '';
        const scope = item.scope || item.path || item.target || '';
        push(scope ? `${cap}:${scope}` : cap);
      }
    }
  }
  return out;
}

/** 两个权限集合是否等价（顺序无关） */
export function samePermissions(a = [], b = []) {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
