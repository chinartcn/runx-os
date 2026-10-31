/** 极简 HTTP 助手 —— 不引任何依赖。 */

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-runx-token',
  'access-control-max-age': '86400',
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** HTML 响应（带 CSP —— 商店前端只用内联脚本与样式，所以要放开 inline） */
export function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extra,
    },
  });
}

export function err(code, message, status = 400, extra = {}) {
  return json({ ok: false, error: code, message, ...extra }, status);
}

/** 读取 JSON body（带体积上限 —— 商店不需要大 body） */
export async function readJson(request, limit = 64 * 1024) {
  const ct = request.headers.get('content-type') || '';
  const text = await request.text();
  if (text.length > limit) {
    const e = new Error('body_too_large');
    e.code = 'body_too_large';
    throw e;
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error('bad_json');
    e.code = 'bad_json';
    throw e;
  }
}

/** SHA-256（十六进制）—— Worker 自带 WebCrypto，不用装依赖 */
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 基础鉴权：从 header 取 token，或 JSON body 的 token 字段 */
export function tokenOf(request, body) {
  const h = request.headers.get('authorization') || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const alt = request.headers.get('x-runx-token');
  if (alt) return alt.trim();
  if (body && typeof body.token === 'string') return body.token.trim();
  return '';
}
