'use strict';

/**
 * @runx/sdk —— 应用侧的操作系统接口
 *
 * 一个 Node 应用想在 RunX 里读写文件、起进程、访问网络，正确姿势不是
 * `require('fs')`，而是走这里：
 *
 *     const rx = require('@runx/sdk');
 *     const txt = await rx.fs.read('/sdcard/notes/today.md');
 *
 * 区别在于 **谁会知道这件事**。直接 require('fs') 的读写无人知晓、也无法被
 * 拒绝；走 SDK 的每一次调用都会经过内核的权限检查：要么已有授权，要么桌面
 * 上弹一个框问用户 —— 用户点了「始终允许」，下一次就不再问。
 *
 * ── 不在 RunX 里跑会怎样 ─────────────────────────────────────────
 * 没有 RUNX_APP_NAME / RUNX_APP_TOKEN 时所有方法抛 `ENOTRUNX`。不做本地
 * 直通回退：那会让「本地测试一切正常、装进 RunX 处处被拒」这种 bug 藏很久。
 * 要写可移植的应用，判断 `rx.enabled`，拿不到就用自己的降级实现。
 *
 * ── 错误长什么样 ────────────────────────────────────────────────
 * 每个错误都带 `code`（字符串常量，不解析文案）：
 *   ENOTRUNX     不在 RunX 里
 *   EPERM        用户拒绝了 / 没有授权且没人可问
 *   NEED_ADMIN   高危操作，需要先开管理员模式
 *   ENOUI        桌面没开，没人能批准
 *   ETIMEDOUT    等待审批超时
 *   ENOENT       路径不存在      EINVAL      参数不对
 *   ETOOBIG      超过单次读写上限 EISDIR      目录当文件读
 * 另外 `err.detail` 里带 {cap, target, risk, app} —— 足够画一个「去授权」的
 * 提示，而不必让用户猜。
 *
 * 零依赖：只用 node 内置的 http / https。
 */

const http = require('http');
const https = require('https');

const NAME = process.env.RUNX_APP_NAME || '';
const TOKEN = process.env.RUNX_APP_TOKEN || '';
const GATEWAY = process.env.RUNX_GATEWAY || 'http://127.0.0.1:3000';
const PORT = Number(process.env.RUNX_APP_PORT) || 0;
const DATA_DIR = process.env.RUNX_APP_DATA || '';
const USER = process.env.RUNX_APP_USER || '';

const ENABLED = !!(NAME && TOKEN);

/** 审批要等人点，默认给 100 秒（后端 UAC 默认 90 秒） */
const DEFAULT_TIMEOUT = 100000;

class RunXError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.name = 'RunXError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

function notRunning(what) {
  return new RunXError('ENOTRUNX',
    '不在 RunX 中运行，无法' + what + '（缺 RUNX_APP_NAME / RUNX_APP_TOKEN）');
}

/**
 * 调一个 SDK 接口。
 *
 * 不用 fetch：这个包会被装进各种 Node（Termux 上的 18、用户容器的 20+），
 * 而 AbortSignal.timeout 在 16/17 上不存在。30 行 http 代码更可控。
 */
function call(area, op, params, opts) {
  if (!ENABLED) return Promise.reject(notRunning(area + '.' + op));
  const o = opts || {};
  const body = Buffer.from(JSON.stringify(params || {}), 'utf8');
  const u = new URL('/runx/sdk/' + area + '/' + op, GATEWAY);
  const mod = u.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: u.hostname,
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'X-Runx-Token': TOKEN,
      },
      timeout: o.timeout || DEFAULT_TIMEOUT,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try { j = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return resolve(j && Object.prototype.hasOwnProperty.call(j, 'result') ? j.result : j);
        }
        const e = (j && j.error) || {};
        const err = new RunXError(e.name || ('HTTP' + res.statusCode), e.message || ('HTTP ' + res.statusCode), e.data || null);
        err.status = res.statusCode;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new RunXError('ETIMEDOUT', '请求超时（' + (o.timeout || DEFAULT_TIMEOUT) + 'ms）')));
    req.on('error', (e) => reject(e instanceof RunXError ? e : new RunXError('ENETWORK', e.message)));
    req.write(body);
    req.end();
  });
}

const api = {
  RunXError,

  /** 应用身份。不在 RunX 里时 name 是空串。 */
  app: Object.freeze({ name: NAME, port: PORT, dataDir: DATA_DIR, gateway: GATEWAY, user: USER }),

  /** 是否跑在 RunX 里。写「可选集成」的应用先判断这个。 */
  enabled: ENABLED,

  /** 逃生口：调未被封装的新接口 */
  call,

  fs: {
    /**
     * 读文件。默认按 UTF-8；二进制自动转 base64（看返回的 encoding）。
     * @param {string} path
     * @param {{encoding?:'utf8'|'base64'}} [opts]
     * @returns {Promise<{path:string, content:string, encoding:string, size:number, mtime:number}>}
     */
    read(path, opts) {
      return call('fs', 'read', { path, encoding: opts && opts.encoding });
    },

    /**
     * 写文件。父目录不存在会自动建。
     * @param {string} path
     * @param {string} content
     * @param {{encoding?:'utf8'|'base64', append?:boolean}} [opts]
     */
    write(path, content, opts) {
      const o = opts || {};
      return call('fs', 'write', { path, content, encoding: o.encoding, append: !!o.append });
    },

    /** 列目录：{entries:[{name,type,size,mtime}]}，目录在前 */
    list(path) { return call('fs', 'list', { path }); },

    /** 元信息：{exists, type, size, mtime, mode} */
    stat(path) { return call('fs', 'stat', { path }); },

    mkdir(path, opts) { return call('fs', 'mkdir', { path, parents: !(opts && opts.parents === false) }); },

    /** 删除。recursive 对目录必填 —— 不给默认值，避免手滑删一整个目录 */
    remove(path, opts) { return call('fs', 'remove', { path, recursive: !!(opts && opts.recursive) }); },

    copy(from, to, opts) { return call('fs', 'copy', { from, to, recursive: !!(opts && opts.recursive) }); },

    /** 移动（跨设备自动退化成「复制 + 删除」） */
    move(from, to) { return call('fs', 'copy', { from, to, move: true }); },
  },

  proc: {
    /**
     * 起一个进程。argv 是数组，没有 shell —— 想跑管道请自己起 sh 并把
     * 整条命令作为参数传进去（那样申请的能力也是 sh，用户看得见）。
     * @param {string[]} argv
     * @param {{cwd?:string, env?:object}} [opts]
     */
    spawn(argv, opts) {
      const o = opts || {};
      return call('proc', 'spawn', { argv, cwd: o.cwd, env: o.env });
    },

    /** 查进程：{running, exit:{code,signal}, stdout, stderr}（stdout 最多留 8KB） */
    status(pid) { return call('proc', 'status', { pid }); },

    kill(pid, signal) { return call('proc', 'kill', { pid, signal }); },
  },

  net: {
    /**
     * 代发 HTTP 请求。走这里而不是自己 https.request 的理由：目标主机在
     * 授权表里，用户能看到「这个应用要访问哪」。
     * @param {string} url
     * @param {{method?:string, headers?:object, body?:string}} [opts]
     */
    fetch(url, opts) {
      const o = opts || {};
      return call('net', 'fetch', { url, method: o.method, headers: o.headers, body: o.body });
    },
  },

  sys: {
    /** 平台、内存、CPU 数、自己的 cwd/data 路径 */
    info() { return call('sys', 'info', {}); },
  },
};

module.exports = api;
module.exports.default = api;
