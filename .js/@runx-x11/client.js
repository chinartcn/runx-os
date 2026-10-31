/**
 * @runx-x11 前端 —— 图形应用的入口与「装不上怎么办」的决策界面。
 *
 * ── 为什么这些东西不在桌面的 client.js 里 ────────────────────────
 * 桌面只管「画窗口」。X11 是不是装了、装了一半缺什么、这台设备压根不支持 ——
 * 这些都是 X11 自己的业务。放回桌面，等于让每个用不到 X11 的页面都带一份
 * 关于 xpra 的文案。
 *
 * 两边的接缝只有一个：桌面在打开 x11 图标时调 `window.RunXX11.open(icon)`。
 * 没装这个扩展时它就不存在，桌面走自己的「没装」分支 —— 没有编译期依赖。
 *
 * ── 决策流程 ────────────────────────────────────────────────────
 *   status()  探测（后端缓存 60 秒）
 *     ├─ ok                    直接建会话
 *     ├─ Termux / 非 Linux     解释为什么不行，给出 API 口子（场景 A）
 *     └─ Linux 但缺后端        给两条路让用户选（场景 B）
 *                              装完点「重试」→ 清缓存重新探测
 */
(function () {
  'use strict';

  var API = '/runx/x11';
  var cache = null;            // { at, data }
  var CACHE_MS = 15000;        // 比后端的 60 秒短：用户装完东西回来要能立刻看到

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function req(path, opts) {
    var o = Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {});
    return fetch(API + path, o).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { /* 非 JSON */ }
        if (!r.ok) {
          var e = new Error((j && j.error && j.error.message) || t || ('HTTP ' + r.status));
          e.code = (j && j.error && j.error.code) || r.status;
          e.name_ = (j && j.error && j.error.name) || '';
          e.data = (j && j.error && j.error.data) || null;
          throw e;
        }
        return j;
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════
   * 探测
   * ═══════════════════════════════════════════════════════════════ */

  /** @param {boolean} force 跳过前端缓存（用户点了「重试」） */
  function status(force) {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.data);
    return req('/status').then(function (d) {
      cache = { at: Date.now(), data: d };
      return d;
    });
  }

  /* ═══════════════════════════════════════════════════════════════
   * 决策弹窗
   * ═══════════════════════════════════════════════════════════════ */

  /**
   * 一个极简模态：不依赖桌面的 sheet（那是桌面内部函数），但共用同一套设计变量
   * 和视觉语言。遮罩点击 = 取消，Esc = 取消 —— 决策弹窗不该困住用户。
   */
  function modal(title, icon) {
    var host = document.getElementById('rx-x11-modal');
    if (host) host.parentNode.removeChild(host);

    var veil = el('div', 'rx11-veil');
    veil.id = 'rx-x11-modal';

    var box = el('div', 'rx11-box');
    veil.appendChild(box);

    var head = el('div', 'rx11-head');
    var ico = el('div', 'rx11-ico', icon || '🖥');
    var ttl = el('div', 'rx11-title', title);
    head.appendChild(ico);
    head.appendChild(ttl);
    box.appendChild(head);

    var body = el('div', 'rx11-body');
    box.appendChild(body);

    var foot = el('div', 'rx11-foot');
    box.appendChild(foot);

    /* 挂在桌面根节点里，不是 body 上。
       #runx-desktop 有 position:fixed + z-index:99999，它自己是一个层叠上下文：
       挂在 body 上的 fixed 元素即使 z-index 更高也只是「body 层的最高」，
       整个桌面会一起盖在它上面（点不到按钮）。挂进去就变成同一层里的最高。 */
    var desk = document.getElementById('runx-desktop');
    if (!desk) veil.classList.add('rx11-solo');   // 没有桌面 = 没有主题变量，走自带的深色兜底
    (desk || document.body).appendChild(veil);

    // 下一帧加 .in，让 transition 真的跑起来（同步添加会被合并掉）
    requestAnimationFrame(function () { veil.classList.add('in'); });

    var api = {
      body: body,
      foot: foot,
      // 默认「关掉就是不做」；需要区分「取消」与「已就绪」的调用方会覆盖它
      dismiss: function () { api.close(); },
      close: function () {
        veil.classList.remove('in');
        setTimeout(function () {
          if (veil.parentNode) veil.parentNode.removeChild(veil);
        }, 180);
      },
      button: function (label, primary, onClick) {
        var b = el('button', 'rx11-btn' + (primary ? ' primary' : ''), label);
        b.type = 'button';
        b.addEventListener('click', onClick);
        foot.appendChild(b);
        return b;
      },
    };

    veil.addEventListener('click', function (e) { if (e.target === veil) api.dismiss(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { api.dismiss(); document.removeEventListener('keydown', onKey); }
    });
    return api;
  }

  /** 复制命令：navigator.clipboard 在 http 下不可用，退回 textarea + execCommand */
  function copyText(text, done) {
    function fallback() {
      var ta = el('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } else {
      fallback();
    }
  }

  /** 场景 A：平台不支持 */
  function dialogUnsupported(st) {
    return new Promise(function (resolve) {
      // 标题固定短句，正文才放后端给的解释：后端那句是完整陈述，当标题会换行
      var m = modal('这台设备暂不支持图形应用', '📱');
      m.dismiss = function () { m.close(); resolve(false); };

      var p = el('p', 'rx11-p', st.message || '图形应用需要本机能运行 X 服务器。');
      m.body.appendChild(p);
      if (st.detail) m.body.appendChild(el('p', 'rx11-p', st.detail));

      var box = el('div', 'rx11-note');
      box.appendChild(el('div', 'rx11-note-t', '但 API 是开着的'));
      var t = el('div', 'rx11-note-b');
      t.innerHTML = '扩展本身照常加载，会话接口一直在：<code>POST ' + (st.api || (API + '/sessions')) +
        '</code>。带 <code>force: true</code> 与 <code>provider</code> 可以绕过平台判断 —— ' +
        '自己搭了 X 服务（termux-x11、proot 发行版、远程 X）的话，直接调它就行。';
      box.appendChild(t);
      m.body.appendChild(box);

      m.button('知道了', true, function () { m.close(); resolve(false); });
    });
  }

  /**
   * 场景 B：Linux 但后端不可用 —— 让用户在两条路里选。
   *
   * 「选」这件事本身有意义：方案一要用户本来就跑着桌面环境，方案二要下载 100MB。
   * 自动替用户决定哪个都不对，所以把现状（可用/不可用 + 原因）摊开，让用户点。
   */
  function dialogSetup(st) {
    return new Promise(function (resolve) {
      var m = modal('需要配置 X11 运行环境', '🖥');
      m.dismiss = function () { m.close(); resolve(false); };

      m.body.appendChild(el('p', 'rx11-p', '检测到 Linux 环境。选一种方式继续。'));

      var chosen = null;
      var cards = el('div', 'rx11-cards');

      /* 方案一：原生直通 —— 对应 native provider（要求宿主已有 X 服务器） */
      var nat = (st.backends || []).filter(function (b) { return b.id === 'native'; })[0];
      var c1 = el('button', 'rx11-card' + (nat && nat.ok ? '' : ' off'));
      c1.type = 'button';
      var h1 = el('div', 'rx11-card-h');
      h1.appendChild(el('span', 'rx11-card-t', '方案一 · 系统原生 X11 直通'));
      h1.appendChild(el('span', 'rx11-chip' + (nat && nat.ok ? ' ok' : ''), nat && nat.ok ? '可用' : '不可用'));
      c1.appendChild(h1);
      c1.appendChild(el('div', 'rx11-card-b',
        '使用当前系统的 X11 环境（如已安装桌面环境），整屏镜像进窗口。不额外占内存，但不是窗口级转发。'));
      if (!(nat && nat.ok)) {
        c1.appendChild(el('div', 'rx11-card-why', (nat && nat.hint) || '没有检测到正在运行的 X 服务器'));
      }

      /* 方案二：xpra —— 对应 xpra provider，推荐 */
      var xp = (st.backends || []).filter(function (b) { return b.id === 'xpra'; })[0];
      var c2 = el('button', 'rx11-card' + (xp && xp.ok ? '' : ' off'));
      c2.type = 'button';
      var h2 = el('div', 'rx11-card-h');
      h2.appendChild(el('span', 'rx11-card-t', '方案二 · 安装 Xpra 无缝窗口服务'));
      h2.appendChild(el('span', 'rx11-chip' + (xp && xp.ok ? ' ok' : ' rec'), xp && xp.ok ? '可用' : '推荐'));
      c2.appendChild(h2);
      var b2 = el('div', 'rx11-card-b',
        '窗口级转发：一个窗口里能同时开多个 X 程序，文本可选中、剪贴板直通、断线重连。每个会话自带一个 Xvfb，关窗口即回收。');
      c2.appendChild(b2);

      var inst = (st.install || []).filter(function (i) { return i.id === 'xpra'; })[0];
      if (inst && inst.cmd && !(xp && xp.ok)) {
        var cmdRow = el('div', 'rx11-cmd');
        cmdRow.appendChild(el('code', null, inst.cmd));
        var cp = el('button', 'rx11-copy', '复制');
        cp.type = 'button';
        cp.addEventListener('click', function (e) {
          e.stopPropagation();
          copyText(inst.cmd, function (ok) {
            cp.textContent = ok ? '已复制' : '复制失败';
            setTimeout(function () { cp.textContent = '复制'; }, 1600);
          });
        });
        cmdRow.appendChild(cp);
        c2.appendChild(cmdRow);
        if (inst.size) c2.appendChild(el('div', 'rx11-card-why', '下载' + inst.size + '，装完回来点「重试」'));
      }

      function pick(card, ok, provider) {
        if (!ok) return;
        chosen = provider;
        c1.classList.toggle('sel', card === c1);
        c2.classList.toggle('sel', card === c2);
      }
      c1.addEventListener('click', function () { pick(c1, nat && nat.ok, 'native'); });
      c2.addEventListener('click', function () { pick(c2, xp && xp.ok, 'xpra'); });

      cards.appendChild(c1);
      cards.appendChild(c2);
      m.body.appendChild(cards);

      // 只有一个可用时自动选中，省一次点击；两个都不可用就都不选
      if (xp && xp.ok) pick(c2, true, 'xpra');
      else if (nat && nat.ok) pick(c1, true, 'native');

      m.button('取消', false, function () { m.close(); resolve(false); });

      var retry = m.button('我已装好，重试', true, function () {
        retry.disabled = true;
        retry.textContent = '正在重新探测…';
        // 后端缓存 60 秒，先让它失效，否则用户刚装完还是读到「没装」
        req('/status/refresh', { method: 'POST' }).then(function (fresh) {
          cache = { at: Date.now(), data: fresh };
          if (fresh.ok) {
            m.close();
            resolve(true);
          } else {
            retry.disabled = false;
            retry.textContent = '我已装好，重试';
            m.close();
            dialogSetup(fresh).then(resolve);
          }
        }).catch(function (e) {
          retry.disabled = false;
          retry.textContent = '我已装好，重试';
          var w = el('div', 'rx11-err', '重新探测失败：' + e.message);
          m.body.appendChild(w);
        });
      });

      if (chosen) retry.textContent = '继续';
    });
  }

  /* ═══════════════════════════════════════════════════════════════
   * 对外接口
   * ═══════════════════════════════════════════════════════════════ */

  /**
   * 确认「现在能开图形会话」。
   * @returns {Promise<boolean>} true = 继续，false = 用户取消 / 环境不支持
   */
  function ensure() {
    return status().then(function (st) {
      if (st.ok) return true;
      if (!st.supported) return dialogUnsupported(st);
      return dialogSetup(st);
    });
  }

  /**
   * 建一个会话。
   * @param {{id:string, command:string, label?:string}} icon
   * @returns {Promise<{id,port,display,path,provider,reused?}>}
   */
  function create(icon) {
    return req('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        command: icon.command,
        label: icon.label,
        winId: 'x11-' + icon.id,
      }),
    }).then(function (r) {
      cache = null;   // 会话变了，下次探测重新拉
      return r;
    });
  }

  function stop(sessionId) {
    if (!sessionId) return Promise.resolve(null);
    return req('/sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' })
      .catch(function () { return null; });   // 关窗时失败不值得打扰用户
  }

  window.RunXX11 = {
    status: status,
    ensure: ensure,
    create: create,
    stop: stop,
  };
})();
