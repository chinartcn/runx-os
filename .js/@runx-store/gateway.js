'use strict';

/**
 * 内核端口解析 —— 给需要「回调内核自己」的扩展用。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 商店装应用要转发给 @runx-pax（内核里的另一个扩展），桌面要推事件总线给前端。
 * 这两件事都是**内核向自己发 HTTP**，端口必须是对的。
 *
 * 写死 3000 或只认 process.env.PORT 都会出事：
 * 同一台机器上跑着第二个 RunX 实例（换个端口做测试、或者用户开了两个）时，
 * 转发会打到**别人家**去。症状是「装不上，报的错跟安装八竿子打不着」——
 * 比如装应用报 "source is not defined"，因为对面那个实例的 PaX 是旧版本。
 * 这种错查起来能磨掉半天。
 *
 * 正确做法：**从这次请求的 Host 头取端口** —— 那是内核实际监听的端口，
 * 3000、8080、3100 都对。取不到（比如内部调用没有 req）再退回环境变量。
 */

/**
 * @param {object} ctx  扩展 ctx（可选）—— 内核在 ctx.port 里给了真实端口
 * @param {object} req  扩展 onRequest 收到的请求对象（可选）
 * @returns {number}    端口号
 */
function gwPortOf(ctx, req) {
  // 1) 内核给的 ctx.port —— 那是内核实际监听的端口，最准
  const cp = Number(ctx && ctx.port);
  if (cp >= 1 && cp <= 65535) return cp;

  // 2) 请求头里的 host —— 同一次请求打进来的端口
  try {
    const host = String((req && req.headers && req.headers.host) || '');
    const m = host.match(/:(\d{1,5})$/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 65535) return n;
    }
  } catch { /* 走下面的兜底 */ }

  // 3) 监听地址里带端口的场合
  try {
    const lp = req && req.socket && Number(req.socket.localPort);
    if (lp >= 1 && lp <= 65535) return lp;
  } catch { /* 走下面的兜底 */ }

  // 4) 环境变量 —— 内核自己启动时知道自己的端口
  const p = Number(process.env.PORT);
  return (p >= 1 && p <= 65535) ? p : 3000;
}

module.exports = { gwPortOf };
