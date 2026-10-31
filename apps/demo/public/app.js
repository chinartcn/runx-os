/**
 * 示例应用的页面脚本。
 *
 * ── 这一层只做两件事 ──────────────────────────────────────────────
 * 1. 把按钮点击变成 `POST /api/*`（转发给 @runx/sdk）；
 * 2. 把返回的 `{ok, result}` 或 `{ok:false, code, hint}` 画出来。
 *
 * 没有任何一处权限判断：能不能做由内核决定，页面只负责把「为什么不能」说清楚。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = { path: '', pid: null, streaming: false };

  /* ── 请求封装 ── */

  function api(method, path, body) {
    return fetch('/api' + path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json(); });
  }

  /** 成功就返回 result，失败就把错误画到指定的元素上，返回 null */
  function unwrap(res, errEl, outEl) {
    if (errEl) errEl.style.display = 'none';
    if (res.ok) return res.result;
    if (errEl) {
      errEl.innerHTML = '';
      var b = document.createElement('b');
      b.textContent = (res.code || '失败') + '：';
      errEl.appendChild(b);
      errEl.appendChild(document.createTextNode(res.message || ''));
      if (res.hint) {
        errEl.appendChild(document.createElement('br'));
        errEl.appendChild(document.createTextNode(res.hint));
      }
      errEl.style.display = '';
    }
    if (outEl) outEl.style.display = 'none';
    return null;
  }

  function show(el, text) {
    el.textContent = text;
    el.style.display = '';
  }

  function bytes(n) { return RX.bytes(n); }

  /* ── 主题 ── */

  function applyTheme(mode) {
    RX.theme(mode);
    Array.prototype.forEach.call(document.querySelectorAll('#theme button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-value') === mode);
    });
  }

  document.getElementById('theme').addEventListener('rx:change', function (e) {
    applyTheme(e.detail.value);
  });
  applyTheme(RX.theme());

  /* ── 状态 ── */

  function loadState() {
    api('GET', '/state').then(function (r) {
      var badge = $('badge-txt'), dot = $('dot');
      if (r.ok) {
        badge.textContent = 'SDK 已连接';
        dot.classList.add('on');
        $('app-name').textContent = r.app.name || 'demo';
        // 桌面的明暗跟着走：窗口内外两种颜色，比任何配色都刺眼
        if (r.theme) applyTheme(r.theme);
        if (r.sys) {
          // 顺便演示 sys.info：这些东西应用本来拿不到（要走 SDK），现在一行代码
          document.title = '示例 · ' + (r.app.name || 'demo') + ' · ' + r.sys.platform;
        }
      } else {
        badge.textContent = 'SDK 不可用';
        dot.classList.remove('on');
        if (r.hint) RX.toast(r.message + ' ' + r.hint, { kind: 'error', timeout: 6000 });
      }
    });
  }

  /* ── 文件 ── */

  $('btn-open').onclick = function () {
    api('POST', '/dialog', { kind: 'open', title: '选择一个文件', filters: ['md', 'txt', 'bin', 'json'] })
      .then(function (r) {
        if (!r.ok) return unwrap(r, $('file-err'));
        if (r.result.cancelled) { RX.toast('已取消'); return; }
        state.path = r.result.path;
        $('picked').textContent = state.path;
        $('picked').title = state.path;
        $('stream-path').textContent = state.path;
        $('watch-path').textContent = state.path;
        RX.toast('已选择：' + state.path.split('/').pop());
      });
  };

  $('btn-save').onclick = function () {
    api('POST', '/dialog', { kind: 'save', title: '保存到…', defaultName: 'note.md', filters: ['md', 'txt'] })
      .then(function (r) {
        if (!r.ok) return unwrap(r, $('file-err'));
        if (r.result.cancelled) { RX.toast('已取消'); return; }
        var target = r.result.path;
        api('POST', '/fs/write', { path: target, text: $('save-text').value })
          .then(function (w) {
            var res = unwrap(w, $('file-err'), $('file-out'));
            if (!res) return;
            show($('file-out'), '已写入 ' + res.path + '\n' + bytes(res.size));
            RX.toast('已保存');
          });
      });
  };

  $('btn-read').onclick = function () {
    if (!state.path) { RX.toast('先选一个文件'); return; }
    api('POST', '/fs/read', { path: state.path }).then(function (r) {
      var res = unwrap(r, $('file-err'), $('file-out'));
      if (!res) return;
      var head = res.path + '\n' + bytes(res.size) + ' · ' + res.encoding + ' · ' + RX.time(res.mtime) + '\n\n';
      show($('file-out'), head + res.content + (res.truncated ? '\n…（预览截断）' : ''));
    });
  };

  $('btn-list').onclick = function () {
    var p = state.path ? state.path.replace(/\/[^/]*$/, '') : '.';
    api('POST', '/fs/list', { path: p }).then(function (r) {
      var res = unwrap(r, $('file-err'), $('file-out'));
      if (!res) return;
      var lines = res.entries.map(function (e) {
        return (e.type === 'dir' ? '▸ ' : '  ') + e.name + (e.type === 'dir' ? '/' : '  ' + bytes(e.size));
      });
      show($('file-out'), res.path + '\n\n' + lines.join('\n'));
    });
  };

  $('btn-seed').onclick = function () {
    api('POST', '/seed').then(function (r) {
      if (!r.ok) return unwrap(r, $('file-err'));
      var ok = r.result.filter(function (x) { return !x.error; }).length;
      RX.toast(ok + ' 个文件已就绪');
      api('GET', '/state').then(loadState);
    });
  };

  /* ── 监听 ── */

  $('btn-watch').onclick = function () {
    var p = state.path;
    if (!p) { RX.toast('先选一个文件或目录'); return; }
    // 目录更好玩：目录里改任何文件都能看到；文件则只看它自己
    api('POST', '/watch', { path: p }).then(function (r) {
      var res = unwrap(r, $('file-err'));
      if (!res) return;
      $('watch-path').textContent = res.path + (res.is_dir ? '（目录）' : '');
      $('watch-log').innerHTML = '';
      RX.toast('开始监听');
    });
  };

  $('btn-watch-stop').onclick = function () {
    api('DELETE', '/watch').then(function () { RX.toast('已停止'); $('watch-path').textContent = '未开始'; });
  };

  /* ── 大文件 ── */

  $('btn-stream').onclick = function () {
    if (state.streaming) return;
    // 固定读 big.bin：这一页要演示的是「4MB 分成 16+ 块」，不是「读你刚选的那个」。
    // 想看别的文件，去「文件」页——那里是另一条路径（fs.read 的整块读，会 ETOOBIG）。
    var p = 'data/big.bin';
    state.streaming = true;
    $('stream-bar').style.width = '0%';
    $('stream-chunks').textContent = '0';
    $('stream-bytes').textContent = '0 B';
    $('stream-ms').textContent = '—';
    $('stream-speed').textContent = '—';
    api('POST', '/stream', { path: p }).then(function (r) {
      state.streaming = false;
      if (!r.ok) unwrap(r, $('file-err'), $('file-out'));
    });
  };

  /* ── 进程 ── */

  function setProcRunning(on) {
    $('btn-feed').disabled = !on;
    $('btn-eof').disabled = !on;
  }

  $('btn-spawn').onclick = function () {
    $('proc-err').style.display = 'none';
    api('POST', '/proc/start', { argv: ['tr', 'a-z', 'A-Z'] }).then(function (r) {
      if (!r.ok) {
        unwrap(r, $('proc-err'), $('proc-out'));
        $('proc-status').textContent = '未启动';
        return;
      }
      state.pid = r.result.pid;
      $('proc-status').textContent = '运行中 · pid ' + state.pid;
      $('proc-out').style.display = '';
      $('proc-out').textContent = '';
      setProcRunning(true);
      RX.toast('已启动');
    });
  };

  $('btn-feed').onclick = function () {
    if (!state.pid) return;
    api('POST', '/proc/input', { pid: state.pid, text: $('proc-in').value + '\n' }).then(function (r) {
      if (!r.ok) unwrap(r, $('proc-err'), $('proc-out'));
    });
  };

  $('btn-eof').onclick = function () {
    if (!state.pid) return;
    api('POST', '/proc/end', { pid: state.pid }).then(function () {
      setProcRunning(false);
      RX.toast('已发送 EOF');
    });
  };

  /* ── 剪贴板 ── */

  $('btn-clip-read').onclick = function () {
    api('GET', '/clipboard').then(function (r) {
      var res = unwrap(r, $('clip-err'), $('clip-out'));
      if (!res) return;
      show($('clip-out'), res.empty ? '(剪贴板是空的)' :
        res.text + '\n\n— ' + bytes(res.size) + ' · 来自 ' + (res.source || '未知') + ' · ' + RX.time(res.at));
    });
  };

  $('btn-clip-write').onclick = function () {
    api('POST', '/clipboard', { text: $('clip-in').value }).then(function (r) {
      var res = unwrap(r, $('clip-err'), $('clip-out'));
      if (!res) return;
      show($('clip-out'), '已写入 ' + bytes(res.size) + '（seq ' + res.seq + '）');
      RX.toast('已复制');
    });
  };

  $('btn-toast').onclick = function () { RX.toast('这就是 RunX 的 Toast'); };

  /* ── SSE：实时事件 ── */

  var es = new EventSource('/api/events');

  es.addEventListener('watch', function (e) {
    var d = JSON.parse(e.data);
    var row = document.createElement('div');
    var t = document.createElement('span');
    t.className = 't';
    t.textContent = RX.time(d.at);
    row.appendChild(t);
    row.appendChild(document.createTextNode(d.event + (d.name ? ' · ' + d.name : '')));
    var log = $('watch-log');
    log.insertBefore(row, log.firstChild);
    while (log.children.length > 60) log.removeChild(log.lastChild);
  });

  es.addEventListener('watch-end', function (e) {
    var d = JSON.parse(e.data);
    RX.toast('监听结束：' + (d.code || '') + ' ' + (d.message || ''), { kind: 'error' });
    $('watch-path').textContent = '已结束';
  });

  es.addEventListener('stream', function (e) {
    var d = JSON.parse(e.data);
    var pct = d.total ? Math.min(100, (d.bytes / d.total) * 100) : 0;
    $('stream-bar').style.width = pct.toFixed(1) + '%';
    $('stream-bytes').textContent = bytes(d.bytes) + (d.total ? ' / ' + bytes(d.total) : '');
    $('stream-chunks').textContent = String(d.chunks);
    $('stream-ms').textContent = (d.ms / 1000).toFixed(2) + ' s';
    if (d.ms > 0) $('stream-speed').textContent = bytes(d.bytes / (d.ms / 1000)) + '/s';
  });

  es.addEventListener('stream-end', function (e) {
    var d = JSON.parse(e.data);
    if (d.total) $('stream-bar').style.width = '100%';
    RX.toast(d.error ? ('读取失败：' + d.error) : ('读完 ' + bytes(d.bytes) + '，' + d.chunks + ' 块'),
      { kind: d.error ? 'error' : '' });
  });

  es.addEventListener('theme', function (e) {
    try { applyTheme(JSON.parse(e.data).mode); } catch (err) { /* 坏消息就忽略 */ }
  });

  es.addEventListener('proc', function (e) {
    var d = JSON.parse(e.data);
    var out = $('proc-out');
    out.style.display = '';
    out.textContent = d.stdout + (d.stderr ? '\n[stderr]\n' + d.stderr : '');
    out.scrollTop = out.scrollHeight;
    if (d.exit) {
      $('proc-status').textContent = '已退出 · code ' + d.exit.code;
      setProcRunning(false);
      state.pid = null;
    }
  });

  /* ── 启动 ── */

  loadState();
})();
