'use strict';

/**
 * os.js — NavExt 的特权能力层（RunX 内核）
 *
 * 设计原则：
 *   1) 所有“危险的 / 内核没有的” Node 内置能力都收在这里，server.js 自己永不 require 它们；
 *   2) 只通过 ctx.os 暴露给 mod.json 里 "core": true 的扩展；
 *   3) 普通扩展仍然只有 ctx.fs（限自身目录）和 ctx.project（站点只读）。
 *   → “打开限制”＝给受信核心代码开特权通道，不是撤掉全站围栏。
 *
 * 能力分两类：
 *   A. 进程 / 状态 / 实时    spawn terminate writeState readState logAppend bus
 *   B. 内核没有的特权原语    exec watch ipc schedule listen secret
 */

const cp = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const net = require('net');
const { EventEmitter } = require('events');

function init(App) {
  const stateDir = () => path.join(App.cfg.root, 'var', 'runx');

  // 根目录内的安全解析（os.js 自带的越界护栏，不依赖内核的 fsResolveUnder）
  function resolveUnderRoot(rel) {
    const root = App.cfg.root;
    const full = path.resolve(root, rel || '');
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error('路径越出 root：' + rel);
    }
    return full;
  }

  /* ── A. 状态写：原子写 tmp → fsync → rename → fsync dir ── */
  function writeState(rel, obj) {
    const dir = stateDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, rel);
    const tmp = full + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    const fd = fs.openSync(tmp, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, full);
    try { fs.fsyncSync(fs.openSync(path.dirname(full), 'r')); } catch { /* 忽略 */ }
    return full;
  }

  function readState(rel, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(stateDir(), rel), 'utf8'));
    } catch {
      return fallback;
    }
  }

  function logAppend(appName, line) {
    const dir = path.join(stateDir(), 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, appName + '.log');
    fs.appendFileSync(full, line.replace(/\n*$/, '\n'));
    const st = fs.statSync(full);
    if (st.size > 1 * 1024 * 1024) {
      const tail = fs.readFileSync(full).slice(-(1 * 1024 * 1024));
      fs.writeFileSync(full, tail);
    }
  }

  /* ── A. 进程监管 ── */
  const procs = new Map(); // name -> child

  function spawn(app) {
    const child = cp.spawn(
      app.cmd.split(' ')[0],
      app.cmd.split(' ').slice(1),
      {
        cwd: app.cwd,
        // app.env 允许 appex.json 声明额外环境变量（如 TERM_SHELL_ARGS），
        // 后写覆盖先写：PORT 由框架注入，应用不可覆盖。
        env: Object.assign({}, process.env, app.env || {}, { PORT: String(app.port) }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const tag = `[${app.name}] `;
    child.stdout.on('data', (d) => logAppend(app.name, tag + d.toString().trim()));
    child.stderr.on('data', (d) => logAppend(app.name, tag + d.toString().trim()));
    child.on('exit', (code, signal) => {
      procs.delete(app.name);
      logAppend(app.name, `${tag}exit code=${code} signal=${signal}`);
      // 退出回调（监管策略挂在这里）；异常就地吞掉，不影响主流程
      if (typeof app.onExit === 'function') {
        try { app.onExit(code, signal); }
        catch (e) { logAppend('os', 'spawn onExit 回调出错：' + e.message); }
      }
    });
    procs.set(app.name, child);
    return { pid: child.pid, port: app.port };
  }

  function terminate(name, force) {
    const child = procs.get(name);
    if (!child) return false;
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
    return true;
  }

  /* ── A. WebSocket —— 内核只负责“握手 + 帧编解码 + 按路径路由”；
   *        具体的连接语义（欢迎 / 订阅 / 命名空间校验 / ring buffer / 落盘）
   *        由核心扩展（@runx/event-bus）经 ws.register(path, handler) 注册。
   *        这样内核零依赖、零业务逻辑，扩展方拿到纯净的 conn 对象。 ── */
  const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const wsHandlers = new Map(); // pathname -> { onConnect, onMessage, onClose }
  const allSockets = new Set(); // 全部已握手 socket（broadcast 广播用）

  function wsRegister(pathname, handler) {
    wsHandlers.set(pathname, handler || {});
    return () => wsHandlers.delete(pathname);
  }

  function sendFrame(socket, text, opcode) {
    const payload = Buffer.from(text);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | (opcode || 0x1), len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | (opcode || 0x1); header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | (opcode || 0x1); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    try { socket.write(Buffer.concat([header, payload])); } catch { /* 断开 */ }
  }

  function newId() {
    return (crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(16).slice(2)).slice(0, 26);
  }

  function makeConn(socket, ip) {
    const conn = {
      id: newId(),
      ip,
      subs: new Set(),
      lastMsg: Date.now(),
      alive: true,
      send(obj) { sendFrame(socket, typeof obj === 'string' ? obj : JSON.stringify(obj)); },
      close() { try { socket.end(); } catch { /* 已断 */ } },
      _socket: socket,
    };
    return conn;
  }

  function onUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    // 只接受已注册路径的 WS 升级，避免把无关的 Upgrade 请求吃掉
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* 忽略 */ }
    const handler = wsHandlers.get(pathname);
    if (!handler) { socket.destroy(); return; }

    const accept = crypto
      .createHash('sha1')
      .update(key + HANDSHAKE_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    allSockets.add(socket);
    const conn = makeConn(socket, req.socket && req.socket.remoteAddress);
    if (handler.onConnect) {
      try { handler.onConnect(conn); }
      catch (e) { logAppend('os', 'ws onConnect 出错：' + e.message); }
    }

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const b0 = buf[0];
        const opcode = b0 & 0x0f;
        const masked = (buf[1] & 0x80) === 0x80;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + len) break;
        let payload = buf.slice(offset + maskLen, offset + maskLen + len);
        if (masked) {
          const mask = buf.slice(offset, offset + 4);
          const out = Buffer.alloc(len);
          for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
          payload = out;
        }
        buf = buf.slice(offset + maskLen + len);
        if (opcode === 0x8) {           // close
          socket.end();
          allSockets.delete(socket);
          if (handler.onClose) { try { handler.onClose(conn); } catch { /* 忽略 */ } }
        } else if (opcode === 0x1) {    // text
          conn.lastMsg = Date.now();
          conn.alive = true;
          if (handler.onMessage) {
            try { handler.onMessage(conn, payload.toString()); }
            catch (e) { logAppend('os', 'ws onMessage 出错：' + e.message); }
          }
        } else if (opcode === 0x9) {    // ping → 回 pong（0xA）
          sendFrame(socket, '', 0xA);
        }
      }
    });
    socket.on('close', () => {
      allSockets.delete(socket);
      if (handler.onClose) { try { handler.onClose(conn); } catch { /* 忽略 */ } }
    });
    socket.on('error', () => allSockets.delete(socket));
  }

  // 系统级广播（不经订阅过滤；event-bus 扩展自己实现带过滤的发布）
  function broadcast(event, from, payload) {
    const msg = JSON.stringify({
      type: 'event', event, from, payload,
      ts: Date.now(),
      id: newId(),
    });
    for (const s of allSockets) sendFrame(s, msg);
  }

  /* ── B. 内核没有的特权原语 ── */

  // B1. exec：供 PaX 跑 pnpm install / tar 解包，带超时与输出捕获
  function exec(file, args, opts) {
    return new Promise((resolve, reject) => {
      const child = cp.execFile(
        file, args || [],
        Object.assign({ timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, opts),
        (err, stdout, stderr) => {
          if (err) reject(Object.assign(err, { stdout: stdout || '', stderr: stderr || '' }));
          else resolve({ stdout: stdout || '', stderr: stderr || '' });
        }
      );
    });
  }

  // B2. watch：监听根目录内某路径（如 $PREFIX/apps）
  //     ⚠ fs.watch 在 Android/Termux（Linux inotify）上极不稳定：
  //        - 同一改动常触发两次事件；
  //        - recursive 在 Linux 上直接抛 ERR_FEATURE_UNAVAILABLE_ON_PLATFORM；
  //        - 某些写法则干脆不触发。
  //     故：watch 内置防抖，且支持 opts.poll 强制降级到基于 fs.stat 的轮询。
  //     回调统一签名：cb(eventType, changedFiles: string[])
  function startPolling(rel, cb, interval) {
    const full = resolveUnderRoot(rel);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });

    // 快照：相对路径 -> "mtimeMs:size"
    function snap(dir, base, out) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name.charAt(0) === '.') continue; // 跳过大树/隐藏项
        const abs = path.join(dir, e.name);
        const rel2 = base ? base + '/' + e.name : e.name;
        if (e.isDirectory()) snap(abs, rel2, out);
        else if (e.isFile()) {
          try {
            const st = fs.statSync(abs);
            out[rel2] = st.mtimeMs + ':' + st.size;
          } catch { /* 读写竞态，忽略 */ }
        }
      }
    }

    let snapshot = {};
    snap(full, '', snapshot);

    const timer = setInterval(() => {
      const next = {};
      snap(full, '', next);
      const changed = [];
      for (const k of Object.keys(next)) if (snapshot[k] !== next[k]) changed.push(k);
      for (const k of Object.keys(snapshot)) if (!(k in next)) changed.push(k); // 删除
      if (changed.length) {
        snapshot = next;
        try { cb('change', changed); }
        catch (e) { logAppend('os', 'poll cb error: ' + e.message); }
      }
    }, interval);
    if (timer.unref) timer.unref();

    return { close() { clearInterval(timer); }, mode: 'poll' };
  }

  function watch(rel, cb, opts) {
    opts = opts || {};
    const debounceMs = Number.isFinite(opts.debounce) ? opts.debounce : 120;
    const interval = Number.isFinite(opts.interval) ? opts.interval : 1000;

    if (opts.poll) return startPolling(rel, cb, interval);

    const full = resolveUnderRoot(rel);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });

    // 防抖：把静默窗口内的多次事件（Termux 上的“双触发”）合并成一次
    let timer = null;
    const seen = new Set();
    const flush = () => {
      timer = null;
      const files = Array.from(seen);
      seen.clear();
      try { cb('change', files); }
      catch (e) { logAppend('os', 'watch cb error: ' + e.message); }
    };
    const scheduleFlush = (file) => {
      if (file) seen.add(file);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    };

    const recursive = (process.platform === 'darwin' || process.platform === 'win32');
    let watcher;
    try {
      watcher = fs.watch(full, recursive ? { recursive: true } : {}, (eventType, filename) => {
        scheduleFlush(filename || '');
      });
    } catch (e) {
      logAppend('os', 'fs.watch 不可用，降级轮询: ' + e.message);
      return startPolling(rel, cb, interval);
    }
    // Termux 上 watcher 可能 emit error 后彻底静默 —— 兜底转轮询
    watcher.on('error', (e) => {
      logAppend('os', 'fs.watch error，降级轮询: ' + e.message);
      try { watcher.close(); } catch {}
      if (timer) { clearTimeout(timer); timer = null; }
      startPolling(rel, cb, interval);
    });
    return watcher;
  }

  // 显式轮询入口（基于 fs.stat 的降级方案）
  function poll(rel, cb, opts) {
    opts = opts || {};
    const interval = Number.isFinite(opts.interval) ? opts.interval : 1000;
    return startPolling(rel, cb, interval);
  }

  // B3. ipc：核心扩展之间的服务端事件总线（不经 WS，直接进程内）
  const ipc = new EventEmitter();
  ipc.setMaxListeners(0);

  // B4. schedule：系统级周期任务，不受扩展重载影响（R.gc / 日志轮转）
  function schedule(fn, ms) {
    const id = setInterval(() => {
      try { fn(); }
      catch (e) { logAppend('os', 'schedule error: ' + e.message); }
    }, ms);
    if (id.unref) id.unref();
    return id;
  }

  // B5. listen：在额外端口/Unix socket 起 net 服务（代理应用端口 / 原始 TCP）
  function listen(opts, onConn) {
    const srv = net.createServer(onConn);
    srv.on('error', (e) => logAppend('os', 'net listen error: ' + e.message));
    srv.listen(opts, () => {
      const where = typeof opts === 'number' ? ':' + opts : (opts.path || JSON.stringify(opts));
      logAppend('os', 'net server listening ' + where);
    });
    return srv;
  }

  // B6. secret：读受保护环境变量（token 等不该进 config.json 的东西）
  function secret(name) {
    return process.env[name];
  }

  // B7. files：根目录内受限的通用文件系统操作（供 PaX 解包 / 复制 / 卸载）
  //     ⚠ 所有路径都过 resolveUnderRoot，越出 root 直接抛错；remove 额外禁止删根本身。
  function fsWrite(rel, data) {
    const full = resolveUnderRoot(rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
    return full;
  }
  function fsMkdir(rel) {
    const full = resolveUnderRoot(rel);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }
  function fsRead(rel) {
    return fs.readFileSync(resolveUnderRoot(rel), 'utf8');
  }
  function fsExists(rel) {
    try { fs.accessSync(resolveUnderRoot(rel)); return true; } catch { return false; }
  }
  function fsList(rel) {
    return fs.readdirSync(resolveUnderRoot(rel));
  }
  function fsRemove(rel) {
    const full = resolveUnderRoot(rel);
    if (full === App.cfg.root) throw new Error('禁止删除根目录');
    fs.rmSync(full, { recursive: true, force: true });
    return true;
  }
  function fsCopy(srcRel, dstRel, opts) {
    const src = resolveUnderRoot(srcRel);
    const dst = resolveUnderRoot(dstRel);
    fs.cpSync(src, dst, Object.assign({ recursive: true }, opts));
    return dst;
  }
  const files = { write: fsWrite, mkdir: fsMkdir, read: fsRead, exists: fsExists, list: fsList, remove: fsRemove, copy: fsCopy };

  // B8. gc：资源回收（文档 §2 R.gc / §5.3 "通知 gc 清临时资源"）
  //     · 临时文件：var/runx/.install-*（PaX 安装残留）、var/runx/tmp/*
  //     · 死记录：应用退出后遗留的临时资源登记（按 TTL 清理）
  //     归属原则（§5.1）：谁是回收所有者，谁在进程死后清账 —— gc 只提供机制，
  //     由 supervisor（唯一回收所有者）在 onExit 里调用 sweepFor(name)。
  const deadRecords = new Map(); // appName -> [{ kind, path, released_at }]
  const _rmrf = (abs) => { try { fs.rmSync(abs, { recursive: true, force: true }); return true; } catch { return false; } };
  const _ageMs = (abs) => { try { return Date.now() - fs.statSync(abs).mtimeMs; } catch { return Infinity; } };

  function gcSweep(opts) {
    const o = opts || {};
    const tmpRoot = path.join(stateDir(), 'tmp');
    const maxAge = Number.isFinite(o.maxAgeMs) ? o.maxAgeMs : 3600000; // 默认只清 1 小时前的临时物
    const stat = { scanned: 0, removed: 0, skipped: 0, bytes: 0, deadRecords: 0 };

    // 1) var/runx/.install-* 与 var/runx/tmp/* 的过期残留
    for (const dir of [stateDir(), tmpRoot]) {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (dir === stateDir() && !e.name.startsWith('.install-')) continue;
        const abs = path.join(dir, e.name);
        stat.scanned++;
        if (_ageMs(abs) < maxAge) { stat.skipped++; continue; }
        const sz = _duSize(abs);
        if (_rmrf(abs)) { stat.removed++; stat.bytes += sz; }
      }
    }

    // 2) 死记录（应用退出后遗留、超过 TTL 未释放的登记）
    const deadTtl = Number.isFinite(o.deadTtlMs) ? o.deadTtlMs : maxAge;
    const now = Date.now();
    for (const [name, recs] of Array.from(deadRecords)) {
      const keep = [];
      for (const r of recs) {
        if (now - r.released_at >= deadTtl) { stat.deadRecords++; }
        else keep.push(r);
      }
      if (keep.length) deadRecords.set(name, keep);
      else deadRecords.delete(name);
    }
    return stat;
  }

  /** 精确回收某个应用退出的遗留资源（supervisor 在 onExit 里调用） */
  function gcSweepFor(name, opts) {
    const o = opts || {};
    const stat = { app: name, removed: 0, deadRecords: 0 };
    const recs = deadRecords.get(name);
    if (recs) {
      for (const r of recs) {
        if (r.path) { _rmrf(path.isAbsolute(r.path) ? r.path : path.join(App.cfg.root, r.path)); stat.removed++; }
      }
      deadRecords.delete(name);
    }
    // 该应用的安装残留（罕见：安装中途崩了）
    const installGlob = path.join(stateDir(), '.install-' + name);
    if (fs.existsSync(installGlob) && _rmrf(installGlob)) stat.removed++;
    return stat;
  }

  /** 登记一个"待回收"资源（谁登记谁负责在退出时释放，或交 sweep 兜底） */
  function gcTrack(name, entry) {
    const recs = deadRecords.get(name) || [];
    recs.push(Object.assign({ kind: 'tmp', path: null, released_at: Date.now() }, entry || {}));
    deadRecords.set(name, recs);
    return recs.length;
  }
  function gcRelease(name) { deadRecords.delete(name); return true; }
  function gcStats() {
    let n = 0;
    for (const recs of deadRecords.values()) n += recs.length;
    return { apps: deadRecords.size, pending: n };
  }
  function _duSize(abs) {
    let total = 0;
    try {
      const st = fs.lstatSync(abs);
      if (st.isFile()) return st.size;
      const stack = [abs];
      while (stack.length) {
        const cur = stack.pop();
        let ents = [];
        try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
          const p = path.join(cur, e.name);
          try { const s = fs.lstatSync(p); if (s.isFile()) total += s.size; else if (s.isDirectory()) stack.push(p); }
          catch { /* 忽略 */ }
        }
      }
    } catch { /* 忽略 */ }
    return total;
  }
  const gc = { sweep: gcSweep, sweepFor: gcSweepFor, track: gcTrack, release: gcRelease, stats: gcStats };

  /* ── 给核心扩展的 ctx.os ── */
  function forExt(app, ext) {
    return {
      // A 组
      spawn, terminate,
      writeState, readState, logAppend,
      bus: { publish: broadcast, broadcast, clients: () => allSockets.size, register: wsRegister },
      ws: { register: wsRegister, clients: () => allSockets.size, broadcast },
      // B 组
      exec, watch, poll, schedule, listen, secret, files, gc,
      ipc: {
        on: (e, h) => ipc.on(e, h),
        off: (e, h) => ipc.off(e, h),
        emit: (e, ...a) => ipc.emit(e, ...a),
      },
    };
  }

  return {
    onUpgrade, forExt, wsRegister, broadcast,
    spawn, terminate, writeState, readState,
    exec, watch, poll, schedule, listen, secret, files, gc, ipc,
  };
}

module.exports = { init };
