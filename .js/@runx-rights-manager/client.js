/**
 * @runx-rights-manager 前端 —— 审批框、登录/初始化、授权管理
 *
 * ── 职责边界 ────────────────────────────────────────────────────
 * 后端决定「能不能做」，前端只负责「问得清楚」。所以这里没有任何权限判断：
 * 风险等级、作用域、能不能选「始终允许」全部由服务端给，前端照着画。前端
 * 若能自己算风险，改一行 devtools 就能把高危操作伪装成低危。
 *
 * ── 三种界面 ────────────────────────────────────────────────────
 *   ask     应用请求权限（事件 sys.rights.ask 推来，或进页面时拉一次 pending）
 *   gate    没有账号 / 没登录（服务端对 HTML 已经会吐登录页，这里兜会话过期）
 *   panel   我批准过什么、谁在这台机器上（授权可撤销，用户可增删）
 *
 * 挂在 `window.RunX.rights`，与 RunX.browser / RunX.bus 同一命名空间。
 *
 * @version 0.1.0
 */
(function () {
  'use strict';

  var RunX = (window.RunX = window.RunX || {});
  if (RunX.rights) return;      // 扩展热重载会二次注入

  var API = '/runx';
  var state = { me: null, admin: null, queue: [], showing: false, seen: {} };

  var CAP_TEXT = {
    'fs.read': ['读取文件', '📄'],
    'fs.write': ['写入文件', '✏️'],
    'fs.list': ['列出目录', '📂'],
    'fs.stat': ['查看文件信息', 'ℹ️'],
    'fs.remove': ['删除文件', '🗑'],
    'fs.mkdir': ['创建目录', '📁'],
    'fs.copy': ['复制 / 移动', '📑'],
    'proc.spawn': ['启动程序', '⚙️'],
    'net.fetch': ['访问网络', '🌐'],
    'sys.info': ['读取系统信息', '🖥'],
  };
  var RISK_TEXT = { low: '低风险', medium: '中风险', high: '高风险' };

  /* ═══════════════════════════════════════════════════════════════
   * 基础设施
   * ═══════════════════════════════════════════════════════════════ */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** 内联 SVG 图标：emoji 在没装彩色字体的 Linux 上是空豆腐块，关键界面不能赌字体 */
  function svgIcon(d, size) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size || 20);
    s.setAttribute('height', size || 20);
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    s.appendChild(path);
    return s;
  }

  var ICON = {
    lock: 'M7 10V7a5 5 0 0 1 10 0v3M6 10h12v9H6z',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20c0-3.3 3.4-5 7.5-5s7.5 1.7 7.5 5',
    shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z',
  };

  function req(path, opts) {
    var o = Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, opts || {});
    return fetch(API + path, o).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { /* 非 JSON */ }
        if (!r.ok) {
          var e = new Error((j && j.error && j.error.message) || ('HTTP ' + r.status));
          e.code = r.status;
          e.name_ = (j && j.error && j.error.name) || '';
          throw e;
        }
        return j;
      });
    });
  }

  /** 挂在桌面根节点里：#runx-desktop 是层叠上下文，挂 body 会被整块桌面盖住 */
  function mount(node) {
    var desk = document.getElementById('runx-desktop');
    if (!desk) node.classList.add('rxrm-solo');
    (desk || document.body).appendChild(node);
    return node;
  }

  function veil(cls) {
    var v = el('div', 'rxrm-veil' + (cls ? ' ' + cls : ''));
    mount(v);
    requestAnimationFrame(function () { v.classList.add('in'); });
    return v;
  }

  function closeVeil(v) {
    v.classList.remove('in');
    setTimeout(function () { if (v.parentNode) v.parentNode.removeChild(v); }, 180);
  }

  function toast(text) {
    var box = document.getElementById('rxrm-toast');
    if (!box) {
      box = el('div', 'rxrm-toast');
      box.id = 'rxrm-toast';
      mount(box);
    }
    box.textContent = text;
    box.classList.add('in');
    clearTimeout(box._t);
    box._t = setTimeout(function () { box.classList.remove('in'); }, 2600);
  }

  function fmtTime(ms) {
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 路径太长时保留头尾：判断「是不是我以为的那个文件」靠的是尾部 */
  function shortPath(p) {
    var s = String(p || '');
    if (s.length <= 44) return s;
    return '…' + s.slice(-40);
  }

  /* ═══════════════════════════════════════════════════════════════
   * 1. 审批框
   * ═══════════════════════════════════════════════════════════════ */

  function decide(id, decision) {
    return req('/rights/decide', {
      method: 'POST',
      body: JSON.stringify({ id: id, decision: decision }),
    }).then(function () {
      delete state.seen[id];
    }, function (e) {
      toast(e.code === 404 ? '这条请求已经过期了' : ('操作失败：' + e.message));
    });
  }

  function askDialog(item) {
    var r = item.request || item;
    var capInfo = CAP_TEXT[r.cap] || [r.cap, '🔐'];
    var risk = (r.risk && r.risk.level) || 'medium';
    var v = veil();
    var box = el('div', 'rxrm-box');
    v.appendChild(box);

    /* 头部：谁在要什么 */
    var head = el('div', 'rxrm-head');
    // 头像用应用首字母而不是 emoji：Linux 上常常没装彩色 emoji 字体，缺字会
    // 直接变成一个空豆腐块；首字母一定画得出来，还顺带回答了「是谁在申请」。
    var letter = String(r.app_label || r.app || '?').trim().charAt(0).toUpperCase();
    var ico = el('div', 'rxrm-ico letter', letter);
    var htxt = el('div', 'rxrm-headtx');
    htxt.appendChild(el('div', 'rxrm-title', r.app_label + ' 请求' + capInfo[0]));
    var sub = el('div', 'rxrm-sub');
    sub.appendChild(el('span', 'rxrm-chip risk-' + risk, RISK_TEXT[risk] || risk));
    if (r.user) sub.appendChild(el('span', 'rxrm-who', '申请人：' + r.user));
    htxt.appendChild(sub);
    head.appendChild(ico);
    head.appendChild(htxt);
    box.appendChild(head);

    /* 目标 */
    var body = el('div', 'rxrm-body');
    var targetRow = el('div', 'rxrm-target');
    targetRow.appendChild(el('div', 'rxrm-target-cap', capInfo[0]));
    var code = el('div', 'rxrm-path', shortPath(r.target));
    code.title = r.target;
    targetRow.appendChild(code);
    body.appendChild(targetRow);

    if (r.risk && r.risk.why) {
      body.appendChild(el('p', 'rxrm-why risk-' + risk,
        '为什么标记为' + (RISK_TEXT[risk] || risk) + '：' + r.risk.why));
    }
    if (r.reason) body.appendChild(el('p', 'rxrm-reason', '应用说明：' + r.reason));

    /* 作用域解释：让「始终允许」不是一个盲盒 */
    var scopes = item.scopes || {};
    if (r.cap === 'proc.spawn') {
      body.appendChild(el('p', 'rxrm-tip', '批准后，这个应用可以随时启动该程序。启动子进程等于把整台机器交给它，请只在信任时有此操作。'));
    } else if (r.cap === 'net.fetch') {
      body.appendChild(el('p', 'rxrm-tip', '批准的范围是一个主机。网络能力不经过 Node 权限模型，这一层是唯一的记录。'));
    }

    if (risk === 'high' && !(state.admin && state.admin.on)) {
      body.appendChild(el('p', 'rxrm-warn',
        '这是高风险操作，需要先在「管理员模式」里授权。现在点「始终允许」也会被服务端拒绝。'));
    }
    box.appendChild(body);

    /* 底部按钮 */
    // 高危操作不给「始终允许」：私钥、系统目录这种东西，一次一议。
    // （服务端还会再拦一次，因为前端按钮可以被 devtools 造出来。）
    var canAlways = risk !== 'high';
    var foot = el('div', 'rxrm-foot');
    var btns = el('div', 'rxrm-btns');
    var count = state.queue.length;

    function done(decision, label) {
      closeVeil(v);
      decide(r.id, decision);
      state.seen[r.id] = 1;
      if (label) toast(label);
      state.showing = false;
      next();
    }

    btns.appendChild(btn('拒绝', 'danger', function () { done('deny', '已拒绝'); }));
    if (canAlways) btns.appendChild(btn('仅此一次', '', function () { done('once', '已允许（本次）'); }));

    if (!canAlways) {
      btns.appendChild(btn('仅本次允许', 'primary', function () { done('once', '已允许（本次）'); }));
    } else if (r.cap !== 'proc.spawn' && r.cap !== 'net.fetch' && r.scope_hint) {
      btns.appendChild(btn('始终允许此文件', 'soft', function () { done('always-file'); }));
      btns.appendChild(btn('始终允许此目录', 'primary', function () { done('always-dir'); }));
    } else {
      btns.appendChild(btn('始终允许', 'primary', function () { done('always-file'); }));
    }
    foot.appendChild(btns);

    var meta = el('div', 'rxrm-meta');
    meta.appendChild(el('span', null, count > 1 ? '还有 ' + (count - 1) + ' 个请求在排队' : '超时未处理将自动拒绝'));
    if (r.cap !== 'proc.spawn' && r.cap !== 'net.fetch' && r.scope_hint) {
      meta.appendChild(el('span', 'rxrm-scope', '目录范围：' + shortPath(r.scope_hint)));
    }
    foot.appendChild(meta);
    box.appendChild(foot);

    // Esc = 拒绝（保守选择），点遮罩无效：这是需要明确回答的问题
    function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); done('deny', '已拒绝'); }
    }
    document.addEventListener('keydown', onKey);
    return v;
  }

  function btn(label, kind, onClick) {
    var b = el('button', 'rxrm-btn' + (kind ? ' ' + kind : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  /** 一次只显示一个：多个请求排队时，用户不该面对三张叠在一起的模态 */
  function next() {
    if (state.showing) return;
    while (state.queue.length) {
      var item = state.queue.shift();
      var r = item.request || item;
      if (!r || !r.id || state.seen[r.id]) continue;
      state.showing = true;
      askDialog(item);
      return;
    }
  }

  function enqueue(item) {
    if (!item) return;
    var r = item.request || item;
    if (!r || !r.id) return;
    if (state.seen[r.id]) return;
    if (state.queue.some(function (x) { return (x.request || x).id === r.id; })) return;
    state.queue.push(item);
    next();
  }

  /* ═══════════════════════════════════════════════════════════════
   * 2. 登录 / 初始化
   * ═══════════════════════════════════════════════════════════════ */

  function gateDialog(mode) {
    var isSetup = mode === 'setup';
    var v = veil('gate');
    var box = el('div', 'rxrm-box small');
    v.appendChild(box);

    var head = el('div', 'rxrm-head');
    var gico = el('div', 'rxrm-ico');
    gico.appendChild(svgIcon(isSetup ? ICON.user : ICON.lock, 20));
    head.appendChild(gico);
    var htxt = el('div', 'rxrm-headtx');
    htxt.appendChild(el('div', 'rxrm-title', isSetup ? '创建第一个管理员' : '请登录'));
    htxt.appendChild(el('div', 'rxrm-sub',
      isSetup ? '账号只存在这台机器上，密码用 scrypt 哈希后保存' : '会话已过期，重新登录即可'));
    head.appendChild(htxt);
    box.appendChild(head);

    var body = el('div', 'rxrm-body');
    var form = el('form', 'rxrm-form');
    var name = el('input', 'rxrm-input');
    name.name = 'name'; name.placeholder = '用户名'; name.autocapitalize = 'none'; name.required = true;
    var pw = el('input', 'rxrm-input');
    pw.name = 'password'; pw.type = 'password'; pw.placeholder = isSetup ? '密码（至少 6 位）' : '密码'; pw.required = true;
    form.appendChild(name);
    form.appendChild(pw);
    if (isSetup) {
      var pw2 = el('input', 'rxrm-input');
      pw2.type = 'password'; pw2.placeholder = '再输一次';
      form.appendChild(pw2);
    }
    var msg = el('p', 'rxrm-err');
    msg.style.display = 'none';
    form.appendChild(msg);
    body.appendChild(form);
    box.appendChild(body);

    var foot = el('div', 'rxrm-foot');
    var go = btn(isSetup ? '创建并进入' : '登录', 'primary', function () {
      msg.style.display = 'none';
      var payload = { name: name.value.trim(), password: pw.value };
      if (isSetup && pw2.value !== pw.value) {
        msg.textContent = '两次密码不一致';
        msg.style.display = '';
        return;
      }
      go.disabled = true;
      go.textContent = '处理中…';
      req(isSetup ? '/auth/setup' : '/auth/login', { method: 'POST', body: JSON.stringify(payload) })
        .then(function () { location.reload(); })
        .catch(function (e) {
          go.disabled = false;
          go.textContent = isSetup ? '创建并进入' : '登录';
          msg.textContent = e.message;
          msg.style.display = '';
        });
    });
    foot.appendChild(go);
    box.appendChild(foot);
    setTimeout(function () { name.focus(); }, 60);
    return v;
  }

  /* ═══════════════════════════════════════════════════════════════
   * 3. 授权管理面板
   * ═══════════════════════════════════════════════════════════════ */

  function panel() {
    var v = veil('panel');
    var box = el('div', 'rxrm-box wide');
    v.appendChild(box);

    var head = el('div', 'rxrm-head');
    var pico = el('div', 'rxrm-ico');
    pico.appendChild(svgIcon(ICON.shield, 20));
    head.appendChild(pico);
    var htxt = el('div', 'rxrm-headtx');
    htxt.appendChild(el('div', 'rxrm-title', '权限与账号'));
    var me = state.me || {};
    htxt.appendChild(el('div', 'rxrm-sub',
      me.authenticated ? ('当前用户：' + me.user.name + (me.user.role === 'admin' ? ' · 管理员' : '')) : '未登录'));
    head.appendChild(htxt);
    var x = el('button', 'rxrm-x', '✕');
    x.type = 'button';
    x.addEventListener('click', function () { closeVeil(v); });
    head.appendChild(x);
    box.appendChild(head);

    var body = el('div', 'rxrm-body scroll');
    box.appendChild(body);

    var loading = el('p', 'rxrm-tip', '正在读取…');
    body.appendChild(loading);

    function load() {
      loading.style.display = '';
      Promise.all([
        req('/rights/grants'),
        me.user && me.user.role === 'admin' ? req('/auth/users') : Promise.resolve(null),
      ]).then(function (rs) {
        loading.style.display = 'none';
        body.innerHTML = '';

        /* 授权列表 */
        var gs = (rs[0] && rs[0].grants) || [];
        body.appendChild(section('已批准的应用权限', gs.length ? '' : '还没有任何授权。应用请求时会在这里出现。'));
        gs.forEach(function (g) {
          var row = el('div', 'rxrm-row');
          var main = el('div', 'rxrm-row-main');
          var t = el('div', 'rxrm-row-t');
          t.appendChild(el('span', 'rxrm-row-app', g.app === '*' ? '所有应用' : g.app));
          t.appendChild(el('span', 'rxrm-chip', (CAP_TEXT[g.cap] || [g.cap])[0]));
          main.appendChild(t);
          main.appendChild(el('div', 'rxrm-row-p', g.scope));
          row.appendChild(main);
          var del = btn('撤销', 'danger small', function () {
            del.disabled = true;
            req('/rights/grants/' + encodeURIComponent(g.id), { method: 'DELETE' })
              .then(function () { row.parentNode.removeChild(row); toast('已撤销'); }, function (e) { del.disabled = false; toast(e.message); });
          });
          row.appendChild(del);
          body.appendChild(row);
        });

        /* 账号管理（仅管理员） */
        if (rs[1]) {
          var users = rs[1].users || [];
          body.appendChild(section('账号', ''));
          users.forEach(function (u) {
            var row = el('div', 'rxrm-row');
            var main = el('div', 'rxrm-row-main');
            var t = el('div', 'rxrm-row-t');
            t.appendChild(el('span', 'rxrm-row-app', u.name));
            t.appendChild(el('span', 'rxrm-chip' + (u.role === 'admin' ? ' acc' : ''), u.role === 'admin' ? '管理员' : '普通用户'));
            if (u.id === (me.user && me.user.id)) t.appendChild(el('span', 'rxrm-chip', '我'));
            main.appendChild(t);
            main.appendChild(el('div', 'rxrm-row-p', '创建于 ' + fmtTime(u.created_at) + (u.last_login ? ' · 上次登录 ' + fmtTime(u.last_login) : '')));
            row.appendChild(main);
            if (u.id !== (me.user && me.user.id)) {
              var del = btn('删除', 'danger small', function () {
                if (!confirm('删除账号 ' + u.name + '？它的授权也会一起消失。')) return;
                req('/auth/users/' + encodeURIComponent(u.id), { method: 'DELETE' })
                  .then(function () { load(); }, function (e) { toast(e.message); });
              });
              row.appendChild(del);
            }
            body.appendChild(row);
          });

          var addRow = el('form', 'rxrm-add');
          var an = el('input', 'rxrm-input'); an.placeholder = '新用户名'; an.required = true;
          var ap = el('input', 'rxrm-input'); ap.type = 'password'; ap.placeholder = '密码'; ap.required = true;
          var go = btn('添加用户', 'soft', function (e) {
            e.preventDefault();
            req('/auth/users', {
              method: 'POST',
              body: JSON.stringify({ name: an.value.trim(), password: ap.value }),
            }).then(function () { an.value = ''; ap.value = ''; load(); toast('已添加'); }, function (er) { toast(er.message); });
          });
          addRow.appendChild(an); addRow.appendChild(ap); addRow.appendChild(go);
          body.appendChild(addRow);
        }
      }, function (e) {
        loading.textContent = '读取失败：' + e.message;
      });
    }

    function section(title, empty) {
      var s = el('div', 'rxrm-section');
      s.appendChild(el('div', 'rxrm-section-t', title));
      if (empty) s.appendChild(el('p', 'rxrm-empty', empty));
      return s;
    }

    var foot = el('div', 'rxrm-foot between');
    var left = el('div', 'rxrm-meta');
    left.appendChild(el('span', null, '管理员模式：' + (state.admin && state.admin.on ? '已开启' : '未开启')));
    foot.appendChild(left);
    var right = el('div', 'rxrm-btns');
    // 提权入口放在这里：用户是在「看授权」的时候才会想到「我要临时放开」
    if (RunX.admin) {
      right.appendChild(btn(state.admin && state.admin.on ? '关闭管理员模式' : '管理员模式', 'soft', function () {
        closeVeil(v);
        if (state.admin && state.admin.on) RunX.admin.disable();
        else RunX.admin.enable();
      }));
    }
    right.appendChild(btn('退出登录', 'danger', function () {
      req('/auth/logout', { method: 'POST' }).then(function () { location.reload(); }, function (e) { toast(e.message); });
    }));
    right.appendChild(btn('关闭', 'primary', function () { closeVeil(v); }));
    foot.appendChild(right);
    box.appendChild(foot);

    load();
    return v;
  }

  /* ═══════════════════════════════════════════════════════════════
   * 3.5 对话框（文件选择 / 保存 / 提问）
   *
   * 应用想让用户挑一个文件时，它只发一个请求，路径由这里的人来选。这条边界
   * 是整个设计里最值钱的部分：应用无法指定「读哪个文件」，只能等一个结果。
   *
   * 目录浏览走 /runx/rights/browse（服务端直接读盘）—— 这是**人**在看目录，
   * 与应用的能力授权无关，所以用户在这里能走到任何地方。
   * ═══════════════════════════════════════════════════════════════ */

  var dlgQueue = [];
  var dlgShowing = false;

  function answerDialog(id, payload) {
    var body = Object.assign({ id: id }, payload || {});
    return req('/rights/dialog/answer', { method: 'POST', body: JSON.stringify(body) });
  }

  function dirOf(p) {
    var s = String(p || '/');
    var i = s.lastIndexOf('/');
    if (i <= 0) return '/';
    return s.slice(0, i);
  }

  function joinPath(dir, name) {
    return (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + name;
  }

  function humanSize(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(1) + ' GB';
  }

  /** 目录里的一条：图标用几何形状画，不赌字体 */
  function entryIcon(type) {
    var s = svgIcon(type === 'dir'
      ? 'M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v9A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5z'
      : (type === 'link'
        ? 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1'
        : 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5'), 17);
    s.classList.add('rxrm-eico', type);
    return s;
  }

  function messageDialog(r) {
    var o = r.options || {};
    var v = veil('dialog');
    var box = el('div', 'rxrm-box small');
    v.appendChild(box);

    var head = el('div', 'rxrm-head');
    var letter = String(r.app_label || r.app || '?').trim().charAt(0).toUpperCase();
    head.appendChild(el('div', 'rxrm-ico letter', letter));
    var htxt = el('div', 'rxrm-headtx');
    htxt.appendChild(el('div', 'rxrm-title', r.title || '来自 ' + r.app_label));
    htxt.appendChild(el('div', 'rxrm-sub', r.app_label + ' 想问你一件事'));
    head.appendChild(htxt);
    box.appendChild(head);

    var body = el('div', 'rxrm-body');
    if (r.message) body.appendChild(el('p', 'rxrm-msg', r.message));
    box.appendChild(body);

    var foot = el('div', 'rxrm-foot');
    var btns = el('div', 'rxrm-btns');
    var buttons = (o.buttons && o.buttons.length) ? o.buttons
      : [{ id: 'ok', label: '确定', kind: 'primary' }, { id: 'cancel', label: '取消' }];

    function done(payload, note) {
      closeVeil(v);
      answerDialog(r.id, payload).catch(function (e) { toast(e.message); });
      if (note) toast(note);
      dlgShowing = false;
      nextDialog();
    }

    buttons.forEach(function (b) {
      btns.appendChild(btn(b.label, b.kind || '', function () { done({ value: b.id }); }));
    });
    foot.appendChild(btns);
    box.appendChild(foot);

    function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); done({ cancelled: true }); }
    }
    document.addEventListener('keydown', onKey);
    return v;
  }

  function fileDialog(r) {
    var o = r.options || {};
    var isSave = r.kind === 'save';
    var multi = !!o.multiple;
    var filters = (o.filters || []).map(function (f) {
      return String(f).toLowerCase().replace(/^\./, '');
    }).filter(Boolean);

    var cur = o.startIn || '/';
    var picked = [];             // 多选
    var cursor = null;           // 单选：当前高亮的文件
    var showAll = false;
    var showHidden = false;

    var v = veil('dialog');
    var box = el('div', 'rxrm-box picker');
    v.appendChild(box);

    /* 头部 */
    var head = el('div', 'rxrm-head');
    var letter = String(r.app_label || r.app || '?').trim().charAt(0).toUpperCase();
    head.appendChild(el('div', 'rxrm-ico letter', letter));
    var htxt = el('div', 'rxrm-headtx');
    htxt.appendChild(el('div', 'rxrm-title', r.title || (isSave ? '保存到…' : '打开文件')));
    var sub = el('div', 'rxrm-sub');
    sub.appendChild(el('span', null, r.app_label + ' 想让你'));
    sub.appendChild(el('span', null, isSave ? '选择保存位置' : '选择一个文件'));
    if (filters.length && !showAll) sub.appendChild(el('span', 'rxrm-fi', '仅 ' + filters.map(function (f) { return '.' + f; }).join(' / ')));
    htxt.appendChild(sub);
    head.appendChild(htxt);
    var x = el('button', 'rxrm-x', '✕');
    x.type = 'button';
    x.title = '取消';
    x.addEventListener('click', function () { done({ cancelled: true }); });
    head.appendChild(x);
    box.appendChild(head);

    /* 路径栏 */
    var bar = el('div', 'rxrm-pathbar');
    var up = el('button', 'rxrm-up', '↑');
    up.type = 'button';
    up.title = '上一级';
    up.addEventListener('click', function () { load(dirOf(cur)); });
    bar.appendChild(up);
    var pathText = el('div', 'rxrm-path-text');
    pathText.title = cur;
    bar.appendChild(pathText);
    var tools = el('div', 'rxrm-tools');
    if (filters.length) {
      tools.appendChild(toggleChip('全部文件', function (on) { showAll = on; load(cur); }));
    }
    tools.appendChild(toggleChip('隐藏项', function (on) { showHidden = on; load(cur); }));
    bar.appendChild(tools);
    box.appendChild(bar);

    /* 列表 */
    var list = el('div', 'rxrm-list');
    box.appendChild(list);

    /* 底部 */
    var foot = el('div', 'rxrm-foot picker-foot');
    var left = el('div', 'rxrm-meta');
    var nameInput = null;
    if (isSave) {
      nameInput = el('input', 'rxrm-input rxrm-name');
      nameInput.placeholder = '文件名';
      nameInput.value = o.defaultName || '';
      left.appendChild(nameInput);
    } else {
      left.appendChild(el('span', 'rxrm-pickinfo', multi ? '可多选' : '未选择'));
    }
    foot.appendChild(left);
    var btns = el('div', 'rxrm-btns');
    btns.appendChild(btn('取消', '', function () { done({ cancelled: true }); }));
    var okBtn = btn(isSave ? '保存' : (multi ? '选择' : '打开'), 'primary', function () { confirmPick(); });
    btns.appendChild(okBtn);
    foot.appendChild(btns);
    box.appendChild(foot);

    function toggleChip(label, onChange) {
      var b = el('button', 'rxrm-chipbtn', label);
      b.type = 'button';
      b.addEventListener('click', function () {
        var on = !b.classList.contains('on');
        b.classList.toggle('on', on);
        onChange(on);
      });
      return b;
    }

    function setInfo(text) {
      var info = left.querySelector('.rxrm-pickinfo');
      if (info) info.textContent = text;
    }

    function visible(e) {
      if (!showHidden && e.hidden) return false;
      if (e.type === 'dir') return true;
      if (!filters.length || showAll) return true;
      var lower = e.name.toLowerCase();
      return filters.some(function (f) { return lower.slice(-(f.length + 1)) === '.' + f; });
    }

    function load(path) {
      pathText.textContent = path;
      pathText.title = path;
      list.innerHTML = '';
      list.appendChild(el('div', 'rxrm-empty', '正在读取…'));
      req('/rights/browse?path=' + encodeURIComponent(path)).then(function (d) {
        cur = d.path;
        pathText.textContent = cur;
        pathText.title = cur;
        list.innerHTML = '';
        var entries = (d.entries || []).filter(visible);
        if (!entries.length) {
          list.appendChild(el('div', 'rxrm-empty', '这个目录是空的（或都被过滤掉了）'));
        }
        entries.forEach(function (e) { list.appendChild(row(e)); });
        // 保存框默认聚焦文件名，输入即输
        if (isSave && nameInput) setTimeout(function () { nameInput.focus(); nameInput.select(); }, 30);
      }, function (e) {
        list.innerHTML = '';
        list.appendChild(el('div', 'rxrm-empty', '打不开：' + e.message));
      });
    }

    function row(e) {
      var full = joinPath(cur, e.name);
      var n = el('div', 'rxrm-entry');
      n.appendChild(entryIcon(e.type));
      var txt = el('div', 'rxrm-etx');
      txt.appendChild(el('div', 'rxrm-ename', e.name));
      var meta = [];
      if (e.type === 'dir') meta.push('文件夹');
      else if (e.size) meta.push(humanSize(e.size));
      if (meta.length) txt.appendChild(el('div', 'rxrm-emeta', meta.join(' · ')));
      n.appendChild(txt);
      if (picked.indexOf(full) >= 0) n.classList.add('sel');

      n.addEventListener('click', function () {
        if (e.type === 'dir') { load(full); return; }
        if (multi) {
          var i = picked.indexOf(full);
          if (i >= 0) picked.splice(i, 1); else picked.push(full);
          n.classList.toggle('sel', i < 0);
          setInfo(picked.length ? '已选 ' + picked.length + ' 个' : '未选择');
        } else {
          cursor = full;
          Array.prototype.forEach.call(list.querySelectorAll('.rxrm-entry.sel'), function (m) { m.classList.remove('sel'); });
          n.classList.add('sel');
          if (isSave && nameInput) nameInput.value = e.name;
          setInfo(e.name);
        }
      });
      n.addEventListener('dblclick', function () {
        if (e.type === 'dir') return load(full);
        cursor = full;
        confirmPick();
      });
      return n;
    }

    function confirmPick() {
      if (isSave) {
        var name = nameInput ? nameInput.value.trim() : '';
        if (!name) { toast('给文件起个名字'); return; }
        done({ path: joinPath(cur, name) }, '已选择保存位置');
        return;
      }
      if (multi) {
        if (!picked.length) { toast('还没有选择任何文件'); return; }
        done({ paths: picked.slice() }, '已选择 ' + picked.length + ' 个');
        return;
      }
      if (!cursor) { toast('先点选一个文件'); return; }
      done({ paths: [cursor] }, '已选择');
    }

    function done(payload, note) {
      closeVeil(v);
      document.removeEventListener('keydown', onKey);
      answerDialog(r.id, payload).catch(function (e) { toast(e.message); });
      if (note) toast(note);
      dlgShowing = false;
      nextDialog();
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); done({ cancelled: true }); }
      else if (e.key === 'Enter' && !(e.target && e.target.tagName === 'BUTTON')) confirmPick();
    }
    document.addEventListener('keydown', onKey);

    load(cur);
    return v;
  }

  function nextDialog() {
    if (dlgShowing) return;
    while (dlgQueue.length) {
      var item = dlgQueue.shift();
      var r = item && (item.request || item);
      if (!r || !r.id) continue;
      dlgShowing = true;
      if (r.kind === 'message') messageDialog(r);
      else fileDialog(r);
      return;
    }
  }

  function enqueueDialog(item) {
    var r = item && (item.request || item);
    if (!r || !r.id) return;
    if (dlgQueue.some(function (x) { return (x.request || x).id === r.id; })) return;
    dlgQueue.push(item);
    nextDialog();
  }

  /* ═══════════════════════════════════════════════════════════════
   * 4. 菜单栏入口
   *
   * 不碰桌面的代码：桌面在渲染完成后会有 .rx-menubar-status 这个容器，
   * 把盾牌按钮插在时钟前面就行。桌面没装/还没渲染完就等一会儿，超时就算了 ——
   * 面板仍然可以从控制台 RunX.rights.panel() 打开。
   * ═══════════════════════════════════════════════════════════════ */

  function mountMenuButton() {
    var tries = 0;
    (function look() {
      var host = document.querySelector('.rx-menubar-status');
      if (host && !document.getElementById('rxrm-menu')) {
        var b = el('button', 'rxrm-menu-btn');
        b.id = 'rxrm-menu';
        b.type = 'button';
        b.title = '权限与账号';
        b.appendChild(el('span', 'rxrm-menu-ico', '🛡'));
        b.addEventListener('click', function () { panel(); });
        var clock = host.querySelector('.rx-status-clock');
        host.insertBefore(b, clock || null);
        return;
      }
      if (tries++ < 40) setTimeout(look, 250);
    })();
  }

  /* ═══════════════════════════════════════════════════════════════
   * 5. 启动
   * ═══════════════════════════════════════════════════════════════ */

  /**
   * 应用写剪贴板时，尽力把它送进系统剪贴板。
   *
   * 浏览器只在「页面有焦点 + 有权限」时才允许 writeText，所以这里一定会
   * 失败一部分情况（后台标签、手机、用户拒绝）。失败就不做，但**必须告诉
   * 用户**：否则「应用说复制好了、实际没进系统剪贴板」是最难查的一类问题。
   */
  function mirrorClipboard(payload) {
    var text = payload && payload.text ? String(payload.text) : '';
    if (!text) return;
    var who = (payload && (payload.app_label || payload.app)) || '应用';
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      toast(who + ' 写入了剪贴板（本浏览器不支持同步到系统）');
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      toast(who + ' 复制了 ' + text.length + ' 个字符');
    }, function () {
      toast(who + ' 写入了 RunX 剪贴板（未同步到系统：页面没有焦点或被拒绝）');
    });
  }

  function refreshStatus() {
    return req('/auth/status').then(function (s) {
      state.me = s;
      state.admin = s.admin_mode || null;
      return s;
    }, function () { return null; });
  }

  function boot() {
    refreshStatus().then(function (s) {
      if (!s) return;
      if (s.setup_required) { gateDialog('setup'); return; }
      if (!s.authenticated) { gateDialog('login'); return; }
      // 已经把事件通道接上，再补一次「进页面之前就已经在等」的请求
      return req('/rights/pending').then(function (d) {
        (d.requests || []).forEach(enqueue);
        return req('/rights/dialog/pending').then(function (dd) {
          (dd.requests || []).forEach(enqueueDialog);
        }, function () { /* 没有对话框服务就跳过 */ });
      }, function () { /* 未登录就等事件 */ });
    });

    // 事件总线可能还没就绪（本扩展比 event-bus 晚注入），poll 一次直到拿到 RunX.bus
    var tries = 0;
    (function subscribe() {
      if (RunX.bus && RunX.bus.subscribe) {
        RunX.bus.subscribe('sys.rights.ask', function (m) { enqueue(m.payload); });
        RunX.bus.subscribe('sys.dialog.open', function (m) { enqueueDialog(m.payload); });
        RunX.bus.subscribe('sys.clipboard.write', function (m) { mirrorClipboard(m.payload); });
        return;
      }
      if (tries++ < 40) setTimeout(subscribe, 250);
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); mountMenuButton(); });
  } else { boot(); mountMenuButton(); }

  RunX.rights = {
    version: '0.1.0',
    /** 当前登录状态（含管理员模式票据） */
    status: refreshStatus,
    /** 打开授权管理面板 */
    panel: panel,
    /** 手动拉一次待审批队列（事件丢了也能恢复） */
    pending: function () {
      return req('/rights/pending').then(function (d) {
        (d.requests || []).forEach(enqueue);
        return d.requests || [];
      });
    },
    /** 决定一条请求：once / always-file / always-dir / deny */
    decide: decide,
    grants: function () { return req('/rights/grants').then(function (d) { return d.grants; }); },
    revoke: function (id) {
      return req('/rights/grants/' + encodeURIComponent(id), { method: 'DELETE' });
    },
    logout: function () {
      return req('/auth/logout', { method: 'POST' }).then(function () { location.reload(); });
    },
    /** 退出时撤销所有挂起请求，避免把「谁来决定」留给下一个人 */
    cancel: function () { return req('/auth/logout', { method: 'POST' }); },

    /** 对话框：手动拉一次（事件丢了也能恢复）+ 直接回答 */
    dialog: {
      pending: function () {
        return req('/rights/dialog/pending').then(function (d) {
          (d.requests || []).forEach(enqueueDialog);
          return d.requests || [];
        });
      },
      answer: answerDialog,
    },

    /**
     * 桌面（人）这一侧的剪贴板读写。应用那一侧要走 SDK 的授权。
     * write 会同时在系统剪贴板与 RunX 剪贴板里各写一份 —— 能写进系统就写。
     */
    clipboard: {
      read: function () { return req('/rights/clipboard'); },
      write: function (text) {
        return req('/rights/clipboard', { method: 'POST', body: JSON.stringify({ text: String(text) }) })
          .then(function (r) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(String(text)).catch(function () { /* 尽力而为 */ });
            }
            return r;
          });
      },
    },
  };
})();
