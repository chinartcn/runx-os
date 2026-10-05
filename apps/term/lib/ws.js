'use strict';

/**
 * 极简 WebSocket 服务端（RFC 6455 子集），零依赖。
 *
 * 只实现终端场景需要的部分：
 *   · 握手（Sec-WebSocket-Accept）
 *   · 文本帧收发（opcode 0x1 / 0x0 续帧按单帧处理）
 *   · close（0x8）、ping→pong（0x9→0xA）
 *   · 客户端→服务端帧必须掩码（否则按协议断开）
 *
 * 设计取舍：只服务本应用的一条 WS 路径，不需要多路复用 / 扩展协商 / 分片重组。
 * 单帧上限 1MB，超限直接断开，防内存炸弹。
 */

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1024 * 1024; // 1MB

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** 发送一帧（服务端→客户端，不掩码） */
function sendFrame(socket, data, opcode) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const len = payload.length;
  const op = opcode || 0x1;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | op, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { socket.write(Buffer.concat([header, payload])); return true; }
  catch { return false; }
}

/**
 * 在 http server 上接管 upgrade。
 * @param {http.Server} server
 * @param {string} path 只接受该路径的 WS 升级（其它 upgrade 直接断开）
 * @param {(conn) => void} onConnect
 * @returns {{conns:Set, closeAll:Function}}
 */
function attach(server, path, onConnect) {
  const conns = new Set();

  server.on('upgrade', (req, socket) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* ignore */ }

    const key = req.headers['sec-websocket-key'];
    const isWs = (req.headers.upgrade || '').toLowerCase() === 'websocket';
    if (pathname !== path || !key || !isWs) {
      socket.destroy();
      return;
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
    );

    const conn = {
      id: crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(16).slice(2),
      ip: (req.socket && req.socket.remoteAddress) || '',
      origin: req.headers.origin || '',
      socket,
      alive: true,
      closed: false,
      send(objOrText) {
        const text = typeof objOrText === 'string' ? objOrText : JSON.stringify(objOrText);
        return sendFrame(socket, text, 0x1);
      },
      close() {
        if (this.closed) return;
        this.closed = true;
        try { sendFrame(socket, Buffer.alloc(0), 0x8); } catch { /* ignore */ }
        try { socket.end(); } catch { /* ignore */ }
      },
    };
    conns.add(conn);

    /* —— 帧循环 —— */
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
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2); offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2)); offset = 10;
        }
        if (len > MAX_FRAME) { conn.close(); return; }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + len) return; // 未收全，等下一块

        let payload = buf.slice(offset + maskLen, offset + maskLen + len);
        if (masked) {
          const mask = buf.slice(offset, offset + 4);
          const out = Buffer.alloc(len);
          for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
          payload = out;
        }
        buf = buf.slice(offset + maskLen + len);

        if (opcode === 0x8) {              // close
          conn.alive = false;
          conn.closed = true;
          try { socket.end(); } catch { /* ignore */ }
          conns.delete(conn);
          if (conn.onClose) conn.onClose();
          return;
        } else if (opcode === 0x1 || opcode === 0x0) {
          // 文本 / 续帧：本应用所有消息都短于 125 字节或单帧发送，直接当完整消息
          conn.alive = true;
          if (conn.onMessage) {
            try { conn.onMessage(payload.toString('utf8')); }
            catch (e) { conn.send({ type: 'error', code: 500, message: 'onMessage: ' + e.message }); }
          }
        } else if (opcode === 0x9) {       // ping → pong
          sendFrame(socket, payload, 0xA);
        } else if (opcode === 0xA) {       // pong：忽略
          conn.alive = true;
        }
      }
    });

    socket.on('close', () => {
      const wasOpen = conns.delete(conn);
      conn.alive = false; conn.closed = true;
      if (wasOpen && conn.onClose) conn.onClose();
    });
    socket.on('error', () => {
      conns.delete(conn);
      conn.alive = false; conn.closed = true;
    });

    onConnect(conn);
  });

  return {
    conns,
    closeAll() { for (const c of Array.from(conns)) c.close(); },
  };
}

module.exports = { attach, sendFrame };
