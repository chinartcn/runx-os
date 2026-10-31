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
 *   ENOSYS       内核没加载这个服务（例如剪贴板被裁掉了）
 * 另外 `err.detail` 里带 {cap, target, risk, app} —— 足够画一个「去授权」的
 * 提示，而不必让用户猜。
 *
 * ── 用户说「不」不是异常 ────────────────────────────────────────
 * `dialog.*` 取消、`clipboard.write` 被拒这类「用户主动放弃」的场景返回
 * `{cancelled:true}` 而不是抛错 —— 抛错会逼着每个调用点写 try/catch 去区分
 * 「出错了」和「用户不想」。`fs.*` / `proc.*` 仍然抛错，因为那确实是没做成。
 *
 * 零依赖：只用 node 内置的 http / https / stream。
 */

const http = require('http');
const https = require('https');
const { Readable, Writable } = require('stream');

const NAME = process.env.RUNX_APP_NAME || '';
const TOKEN = process.env.RUNX_APP_TOKEN || '';
const GATEWAY = process.env.RUNX_GATEWAY || 'http://127.0.0.1:3000';
const PORT = Number(process.env.RUNX_APP_PORT) || 0;
const DATA_DIR = process.env.RUNX_APP_DATA || '';
const USER = process.env.RUNX_APP_USER || '';

const ENABLED = !!(NAME && TOKEN);

/** 审批要等人点，默认给 100 秒（后端 UAC 默认 90 秒） */
const DEFAULT_TIMEOUT = 100000;
/** 挑文件比点「允许」慢，给 190 秒（后端默认 180 秒） */
const DIALOG_TIMEOUT = 190000;
/** 一圈流式读的块大小：一次 HTTP 往返，256KB 在局域网里约 2ms */
const CHUNK = 256 * 1024;

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

/**
 * 流式读：把 `fs.readRange` 包装成 Node 的 Readable。
 *
 * 为什么不是「读一块返回一块」的裸接口：调用方想要的是 `pipe()`、
 * `for await`、`.setEncoding('utf8')` 这些现成的东西。给一个 Readable，
 * 大文件处理就和本地 `fs.createReadStream` 一模一样，只是每一块都过一次
 * 权限网关（其实只有第一块会问人，之后命中授权）。
 *
 * 解码安全：分块边界会切断多字节字符，所以这里产出的是 Buffer。要字符串就
 * `setEncoding('utf8')` —— 它内部用 StringDecoder，能跨块拼接，不会把汉字
 * 切成两个 U+FFFD。
 */
function createReadStream(filePath, opts) {
  const o = opts || {};
  const chunk = Math.max(4096, Math.min(1024 * 1024, o.highWaterMark || CHUNK));
  let offset = Math.max(0, Number(o.start) || 0);
  const end = Number.isFinite(Number(o.end)) && o.end !== undefined ? Number(o.end) : Infinity;
  let total = null;

  const gen = (async function* () {
    for (;;) {
      const want = end === Infinity ? chunk : Math.min(chunk, end - offset + 1);
      if (want <= 0) return;
      const r = await call('fs', 'readRange', { path: filePath, offset, length: want }, { timeout: 60000 });
      total = r.size;
      if (r.bytes > 0) yield Buffer.from(r.data, 'base64');
      offset += r.bytes;
      if (r.eof || r.bytes === 0) return;
    }
  })();

  const stream = Readable.from(gen, { objectMode: false });
  // 调用方经常想知道「总共多大」，但那时 readRange 还没回来 —— 给它一个异步口子
  stream.size = () => (total === null ? call('fs', 'stat', { path: filePath }).then((s) => s.size) : Promise.resolve(total));
  return stream;
}

/**
 * 流式写：把 `fs.writeRange` 包装成 Writable。
 *
 * 第一块带 `truncate`（除非 append），之后按 offset 顺序写。串行是必须的 ——
 * 并发写同一个文件的多个 offset 会让内容交错。
 */
function createWriteStream(filePath, opts) {
  const o = opts || {};
  let offset = 0;
  let first = true;
  return new Writable({
    highWaterMark: Math.max(4096, Math.min(1024 * 1024, o.highWaterMark || CHUNK)),
    write(chunk, enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc === 'buffer' ? 'utf8' : enc);
      const params = { path: filePath, data: buf.toString('base64'), encoding: 'base64' };
      if (o.append) params.append = true;
      else {
        params.offset = offset;
        if (first) params.truncate = true;
      }
      call('fs', 'writeRange', params, { timeout: 120000 }).then((r) => {
        first = false;
        if (!o.append) offset += buf.length;
        cb(null, r);
      }, (e) => cb(e));
    },
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
     * 超过 2MB 请用 createReadStream —— 整块读的意义是「一次拿到全部内容」，
     * 不是「传大文件」。
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

    /**
     * 读一段（分块接口的裸调用）。多数时候用 createReadStream。
     * @param {string} path
     * @param {{offset?:number, length?:number}} [opts] length 上限 1MB
     */
    readRange(path, opts) {
      const o = opts || {};
      return call('fs', 'readRange', { path, offset: o.offset, length: o.length }, { timeout: 60000 });
    },

    /**
     * 写一段。`{truncate:true}` 覆盖、`{append:true}` 追加、`{offset:n}` 定位写。
     * @param {string} path
     * @param {string} data base64
     */
    writeRange(path, data, opts) {
      const o = opts || {};
      return call('fs', 'writeRange', {
        path, data, encoding: o.encoding || 'base64',
        offset: o.offset, append: !!o.append, truncate: !!o.truncate,
      }, { timeout: 120000 });
    },

    /** 大文件读：Node Readable，可 pipe / for await / setEncoding */
    createReadStream,

    /** 大文件写：Node Writable */
    createWriteStream,

    /**
     * 监听文件或目录的变化。
     *
     * 事件由内核 watch，应用这边靠长轮询取 —— 所以它**不需要** WebSocket，
     * Node 18 也能用。回调收到 `{event:'change'|'rename', name, at, seq}`。
     *
     * @param {string} path
     * @param {(e:object)=>void} [onEvent]
     * @param {{onError?:(e:Error)=>void}} [opts]
     * @returns {{id:string|null, path:string, ready:Promise<object>, close:()=>void, closed:boolean}}
     */
    watch(path, onEvent, opts) {
      const o = opts || {};
      const h = {
        id: null, path, closed: false, seq: 0,
        _timer: null,
      };
      let stopped = false;

      const loop = async () => {
        while (!stopped && h.id) {
          let r;
          try {
            r = await call('fs', 'poll', { id: h.id, after: h.seq, timeout: 25000 }, { timeout: 35000 });
          } catch (e) {
            if (stopped) return;
            // 监听被回收（内核重启、idle 超时）不是致命的：告诉调用方，然后停
            if (typeof o.onError === 'function') o.onError(e);
            return;
          }
          h.seq = r.seq;
          for (const ev of (r.events || [])) {
            if (typeof onEvent === 'function') {
              try { onEvent(ev); } catch (e) { /* 回调自己炸了不该拖垮循环 */ }
            }
          }
          if (r.closed) {
            if (r.closed !== 'app' && typeof o.onError === 'function') {
              o.onError(new RunXError('ECLOSED', '监听已被关闭：' + r.closed));
            }
            return;
          }
        }
      };

      h.ready = call('fs', 'watch', { path }).then((r) => {
        h.id = r.id;
        h.seq = 0;
        loop();
        return r;
      });

      h.close = () => {
        if (stopped) return Promise.resolve({ closed: false });
        stopped = true;
        h.closed = true;
        const id = h.id;
        h.id = null;
        if (!id) return h.ready.then(() => ({ closed: false }), () => ({ closed: false }));
        return call('fs', 'unwatch', { id }).catch(() => ({ closed: false }));
      };

      return h;
    },

    /**
     * 只等一次变化：`await rx.fs.waitChange(path, 30000)`。
     * 一次长轮询最多 25 秒（中间层会掐空闲连接），所以要按 deadline 轮着等。
     */
    async waitChange(path, timeoutMs) {
      const total = Math.max(500, timeoutMs || 30000);
      const deadline = Date.now() + total;
      const r = await call('fs', 'watch', { path });
      try {
        let after = 0;
        for (;;) {
          const left = deadline - Date.now();
          if (left <= 0) throw new RunXError('ETIMEDOUT', '等待文件变化超时');
          const p = await call('fs', 'poll',
            { id: r.id, after, timeout: Math.min(25000, left) },
            { timeout: Math.min(25000, left) + 5000 });
          if (p.events && p.events.length) return p.events[0];
          after = p.seq;
          if (p.closed) throw new RunXError('ECLOSED', '监听已被关闭：' + p.closed);
        }
      } finally {
        call('fs', 'unwatch', { id: r.id }).catch(() => {});
      }
    },
  },

  proc: {
    /**
     * 起一个进程。argv 是数组，没有 shell —— 想跑管道请自己起 sh 并把
     * 整条命令作为参数传进去（那样申请的能力也是 sh，用户看得见）。
     * @param {string[]} argv
     * @param {{cwd?:string, env?:object, stdin?:boolean}} [opts]
     *   stdin:true 才建输入管道，否则子进程的 stdin 是 /dev/null（等输入的命令会立刻退出）
     */
    spawn(argv, opts) {
      const o = opts || {};
      return call('proc', 'spawn', { argv, cwd: o.cwd, env: o.env, stdin: !!o.stdin });
    },

    /**
     * 喂一段输入。需要 spawn 时 `{stdin:true}`。
     * @param {number} pid
     * @param {string|Buffer} data
     * @param {{encoding?:'utf8'|'base64'}} [opts] 默认按 utf8 发送
     */
    write(pid, data, opts) {
      const o = opts || {};
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      return call('proc', 'write', {
        pid,
        data: o.encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8'),
        encoding: o.encoding === 'base64' ? 'base64' : 'utf8',
      });
    },

    /** 关掉 stdin（发 EOF）。`cat` 这类命令靠这个结束 */
    end(pid) { return call('proc', 'end', { pid }); },

    /** 查进程：{running, exit:{code,signal}, stdout, stderr, stdin}（stdout 最多留 8KB） */
    status(pid) { return call('proc', 'status', { pid }); },

    kill(pid, signal) { return call('proc', 'kill', { pid, signal }); },

    /**
     * 起进程 → 喂输入 → 等结束 → 收输出，一次做完。
     * 典型用途：「拿这个文件的 sha256」「把这段文本过一遍 jq」。
     *
     * @param {string[]} argv
     * @param {{input?:string|Buffer, cwd?:string, timeoutMs?:number}} [opts]
     * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean}>}
     */
    async run(argv, opts) {
      const o = opts || {};
      const p = await api.proc.spawn(argv, { cwd: o.cwd, stdin: o.input != null });
      if (o.input != null) {
        try { await api.proc.write(p.pid, o.input); } catch (e) { /* 进程可能已经退出 */ }
      }
      try { await api.proc.end(p.pid); } catch (e) { /* 本来就没 stdin */ }

      const deadline = Date.now() + (o.timeoutMs || 60000);
      const tick = o.timeoutMs && o.timeoutMs < 2000 ? 40 : 120;
      let st = null;
      for (;;) {
        st = await api.proc.status(p.pid);
        if (st.exit) break;
        if (Date.now() > deadline) {
          try { await api.proc.kill(p.pid, 'SIGKILL'); } catch (e) { /* 已退出 */ }
          st = await api.proc.status(p.pid);
          return {
            code: st.exit ? st.exit.code : null, signal: st.exit ? st.exit.signal : 'SIGKILL',
            stdout: st.stdout || '', stderr: st.stderr || '', timedOut: true,
          };
        }
        await new Promise((r) => setTimeout(r, tick));
      }
      return {
        code: st.exit.code, signal: st.exit.signal,
        stdout: st.stdout || '', stderr: st.stderr || '', timedOut: false,
      };
    },
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

  /**
   * 让用户在桌面上选东西。
   *
   * 关键点：**路径是用户选的，不是应用给的**。所以这里没有 `defaultPath`
   * 之于 open 模式，`startIn` 也只能是自己家。选中的文件会被记成一条授权
   * （仅限该路径），所以紧接着 `fs.read` 不会再弹一次框。
   */
  dialog: {
    /**
     * 打开文件。
     * @param {{title?:string, filters?:string[], multiple?:boolean, startIn?:string}} [opts]
     *   filters 是扩展名列表（`['md','txt']`），只影响显示，不是安全边界
     * @returns {Promise<{cancelled:boolean, path?:string, paths?:string[], via?:string}>}
     */
    open(opts) { return call('dialog', 'open', Object.assign({ kind: 'open' }, opts || {}), { timeout: DIALOG_TIMEOUT }); },

    /**
     * 保存到……（可以让用户输入一个还不存在的文件名）
     * @param {{title?:string, defaultName?:string, filters?:string[], startIn?:string}} [opts]
     * @returns {Promise<{cancelled:boolean, path?:string, paths?:string[]}>}
     */
    save(opts) { return call('dialog', 'save', Object.assign({ kind: 'save' }, opts || {}), { timeout: DIALOG_TIMEOUT }); },

    /**
     * 普通提问框。
     * @param {{title?:string, message?:string, buttons?:Array<{id:string,label:string,kind?:string}>}} [opts]
     * @returns {Promise<{cancelled:boolean, value?:string}>} value 是按钮 id
     */
    message(opts) { return call('dialog', 'message', Object.assign({ kind: 'message' }, opts || {}), { timeout: DIALOG_TIMEOUT }); },

    /** 确认框：true / false。取消也算 false —— 这是这个函数的语义 */
    async confirm(title, message) {
      const r = await call('dialog', 'message', {
        kind: 'message', title, message,
        buttons: [{ id: 'ok', label: '确定', kind: 'primary' }, { id: 'cancel', label: '取消' }],
      }, { timeout: DIALOG_TIMEOUT });
      return !r.cancelled && r.value === 'ok';
    },

    /** 提示框：只有「知道了」 */
    alert(title, message) {
      return call('dialog', 'message', {
        kind: 'message', title, message,
        buttons: [{ id: 'ok', label: '知道了', kind: 'primary' }],
      }, { timeout: DIALOG_TIMEOUT });
    },
  },

  /**
   * 剪贴板。
   *
   * 是**内核里的共享文本缓冲区**，桌面会尽力与系统剪贴板双向同步，但浏览器
   * 权限、焦点、手机 WebView 都可能让同步失败。所以：应用之间可靠，跨出
   * 浏览器不确定。别拿它当「一定能粘到别的程序里」的保证。
   */
  clipboard: {
    /** @returns {Promise<{text:string, empty:boolean, at:number, size:number, source?:string}>} */
    read() { return call('clipboard', 'read', {}); },

    /** @param {string} text 上限 256KB */
    write(text) { return call('clipboard', 'write', { text: String(text == null ? '' : text) }); },
  },

  sys: {
    /** 平台、内存、CPU 数、自己的 cwd/data 路径 */
    info() { return call('sys', 'info', {}); },
  },
};

module.exports = api;
module.exports.default = api;
