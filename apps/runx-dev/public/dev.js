/* RunX Dev —— 前端 */
(function () {
  'use strict';

  var API_BASE = '__API_BASE__';
  var ROOT = '__ROOT__';

  var state = { packs: [], selected: '', session: null };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(text, isErr) {
    var box = $('toast');
    box.textContent = text;
    box.classList.toggle('err', !!isErr);
    box.classList.add('in');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove('in'); }, 2800);
  }

  function api(path, body) {
    return fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { /* 非 JSON */ }
        if (!r.ok) {
          var err = new Error((j && j.message) || ('HTTP ' + r.status));
          err.code = r.status;
          err.payload = j;
          throw err;
        }
        return j;
      });
    });
  }

  /* ── 包管理器 ───────────────────────────────────────────────── */

  function loadPacks() {
    var box = $('packList');
    box.innerHTML = '<div class="rxd-hint">扫描本机应用目录…</div>';
    return api('/api/packages').then(function (r) {
      state.packs = r.packages || [];
      $('rootPath').textContent = r.root || ROOT;
      $('packCount').textContent = state.packs.length + ' 个应用目录';
      renderPacks();
      fillAppSelect();
    }).catch(function (e) {
      box.innerHTML = '<div class="rxd-hint">扫不到：' + esc(e.message) + '</div>';
    });
  }

  function renderPacks() {
    var box = $('packList');
    if (!state.packs.length) {
      box.innerHTML = '<div class="rxd-hint">apps/ 目录是空的。</div>';
      return;
    }
    box.innerHTML = state.packs.map(function (p) {
      var chips = [];
      if (p.installed) {
        chips.push('<span class="rxd-chip ' + (p.state === 'running' ? 'ok' : '') + '">'
          + (p.state === 'running' ? '运行中' : (p.state || '已安装')) + '</span>');
      } else {
        chips.push('<span class="rxd-chip">未登记</span>');
      }
      if (p.has_meta && p.validate) {
        if (p.validate.ok && !p.validate.warnings.length) chips.push('<span class="rxd-chip ok">清单就绪</span>');
        else if (p.validate.ok) chips.push('<span class="rxd-chip warn">清单有提醒</span>');
        else chips.push('<span class="rxd-chip err">清单有错</span>');
      } else if (!p.has_meta) {
        chips.push('<span class="rxd-chip warn">没有 meta.json</span>');
      }
      if (!p.has_appex) chips.push('<span class="rxd-chip err">没有 appex.json</span>');
      if (p.meta_sha256) {
        chips.push('<span class="rxd-chip">meta ' + p.meta_sha256.slice(0, 8) + '</span>');
      }
      var desc = (p.meta && (p.meta.description || p.meta.summary))
        || (p.appex && p.appex.description) || '';
      return '<div class="rxd-pkg">'
        + '<div class="rxd-pkg-head"><span class="rxd-pkg-name">' + esc(p.name) + '</span>'
        + '<span class="rxd-pkg-ver">v' + esc((p.appex && p.appex.version) || (p.meta && p.meta.version) || '?') + '</span>'
        + '</div>'
        + '<div class="rxd-pkg-desc">' + esc(desc || '（没有描述）') + '</div>'
        + '<div class="rxd-pkg-foot">' + chips.join('') + '</div>'
        + '</div>';
    }).join('');
  }

  function fillAppSelect() {
    var sel = $('pubApp');
    var cur = state.selected;
    sel.innerHTML = '<option value="">— 选一个 —</option>' + state.packs.map(function (p) {
      return '<option value="' + esc(p.name) + '">' + esc(p.name) + '</option>';
    }).join('');
    if (cur) sel.value = cur;
  }

  /* ── 上架助手 ───────────────────────────────────────────────── */

  function genMeta() {
    var app = $('pubApp').value;
    if (!app) { toast('先选一个应用', true); return; }
    state.selected = app;
    $('btnGen').disabled = true;
    api('/api/gen-meta', { app: app }).then(function (r) {
      $('pubMeta').value = JSON.stringify(r.meta, null, 2);
      showValidate(r.validate);
      toast('已从 appex.json 生成');
    }).catch(function (e) {
      toast(e.message || '生成失败', true);
    }).finally(function () { $('btnGen').disabled = false; });
  }

  function checkMeta() {
    var text = $('pubMeta').value;
    if (!text.trim()) { toast('先点「生成」，或者粘贴一份 meta.json', true); return; }
    api('/api/validate', { meta: text }).then(function (r) {
      showValidate(r.validate);
    }).catch(function (e) {
      toast(e.message || '校验失败', true);
    });
  }

  function showValidate(v) {
    var box = $('validateOut');
    if (!v) { box.innerHTML = ''; return; }
    var html = '';
    if (v.problems && v.problems.length) {
      html += '<div class="bad"><strong>有问题</strong><ul>'
        + v.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('')
        + '</ul></div>';
    }
    if (v.warnings && v.warnings.length) {
      html += '<div class="meh"><strong>提醒</strong><ul>'
        + v.warnings.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('')
        + '</ul></div>';
    }
    if (v.ok && !html) html = '<div class="good">清单没问题，可以上架。</div>';
    box.innerHTML = html;
  }

  function saveMeta() {
    var app = $('pubApp').value;
    if (!app) { toast('先选一个应用', true); return; }
    var text = $('pubMeta').value;
    api('/api/save-meta', { app: app, meta: text }).then(function (r) {
      toast('已写到 ' + r.path);
      loadPacks();
    }).catch(function (e) {
      var v = e.payload && e.payload.validate;
      if (v) { showValidate(v); toast('清单还有问题，没写', true); }
      else toast(e.message || '写不进去', true);
    });
  }

  function publish() {
    var app = $('pubApp').value;
    if (!app) { toast('先选一个应用', true); return; }
    var url = $('pubUrl').value.trim();
    if (!url) { toast('填一下 meta.json 的公网地址', true); return; }
    var btn = $('btnPublish');
    btn.disabled = true;
    btn.textContent = '上架中…';
    api('/api/dev/publish', { app: app, meta_url: url }).then(function (r) {
      $('publishOut').innerHTML = '<div class="good">已上架：'
        + esc((r.app && r.app.name) || app) + ' —— 商店里现在能搜到它了。</div>';
      toast('上架成功');
      loadMyApps();
    }).catch(function (e) {
      $('publishOut').innerHTML = '<div class="bad">' + esc(e.message) + '</div>';
      toast(e.message || '上架失败', true);
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = '一键上架';
    });
  }

  function loadMyApps() {
    var box = $('myApps');
    if (!box) return;
    api('/api/dev/my-apps').then(function (r) {
      var apps = r.apps || [];
      if (!apps.length) {
        box.innerHTML = '<div class="rxd-hint">你还没有上架任何应用。</div>';
        return;
      }
      box.innerHTML = apps.map(function (a) {
        return '<div class="rxd-mine-item"><b>' + esc(a.name) + '</b> '
          + '<span style="color:var(--rxd-text-3)">v' + esc(a.version || '') + '</span> · '
          + esc(a.slug || '') + '</div>';
      }).join('');
    }).catch(function () { /* 静默 */ });
  }

  /* ── 账号 ───────────────────────────────────────────────────── */

  function renderAccount() {
    var box = $('acctBody');
    var s = state.session;
    if (!s || !s.token) {
      // 登录 / 注册 切换：字段一样，只有提交时调的接口不同。
      box.innerHTML =
        '<div class="rxd-seg" id="accMode">'
        + '<button class="on" data-mode="login">登录</button>'
        + '<button data-mode="register">注册</button>'
        + '</div>'
        + '<div class="rxd-field" style="margin-top:14px"><label>开发者账号</label>'
        + '<input id="accName" class="rxd-input" placeholder="用户名（小写字母、数字、_ . -）" autocomplete="username"></div>'
        + '<div class="rxd-field"><label>密码</label>'
        + '<input id="accPass" class="rxd-input" type="password" placeholder="密码" autocomplete="current-password"></div>'
        + '<div class="rxd-field" id="accConfirmWrap" hidden><label>确认密码</label>'
        + '<input id="accPass2" class="rxd-input" type="password" placeholder="再输一遍" autocomplete="new-password"></div>'
        + '<button class="rxd-btn" id="accSubmit">登录</button>'
        + '<p class="rxd-hint" id="accTip">没有账号？切到「注册」开一个 —— 只要用户名和密码，商店不收邮箱。</p>';

      var mode = 'login';
      var seg = $('accMode');
      var confirmWrap = $('accConfirmWrap');
      var submit = $('accSubmit');
      var tip = $('accTip');

      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-mode]');
        if (!b) return;
        mode = b.getAttribute('data-mode');
        var kids = seg.querySelectorAll('button');
        for (var i = 0; i < kids.length; i++) {
          kids[i].classList.toggle('on', kids[i].getAttribute('data-mode') === mode);
        }
        confirmWrap.hidden = mode !== 'register';
        submit.textContent = mode === 'register' ? '注册并登录' : '登录';
        $('accPass').setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
        tip.textContent = mode === 'register'
          ? '注册即登录 —— 密码至少 8 位，注册后立刻就能上架。'
          : '没有账号？切到「注册」开一个 —— 只要用户名和密码，商店不收邮箱。';
      });

      submit.addEventListener('click', function () {
        var n = $('accName').value.trim();
        var p = $('accPass').value;
        if (!n || !p) { toast('用户名和密码都要填', true); return; }
        if (mode === 'register') {
          if (p.length < 8) { toast('密码至少 8 位', true); return; }
          if (p !== $('accPass2').value) { toast('两次密码不一致', true); return; }
        }
        submit.disabled = true;
        api('/api/dev/' + mode, { name: n, password: p }).then(function () {
          toast(mode === 'register' ? '注册成功，已登录' : '已登录');
          refreshSession();
          loadMyApps();
        }).catch(function (e) {
          toast(e.message || (mode === 'register' ? '注册失败' : '登录失败'), true);
          submit.disabled = false;
        });
      });
      return;
    }
    box.innerHTML =
      '<div class="rxd-field"><label>已登录</label><input class="rxd-input" value="' + esc(s.name || '?') + '" readonly></div>'
      + '<button class="rxd-btn ghost" id="accLogout">退出登录</button>'
      + '<p class="rxd-hint">会话保存在本应用的 data 目录，权限 0600。</p>';
    $('accLogout').addEventListener('click', function () {
      api('/api/dev/logout', {}).then(function () {
        toast('已退出');
        refreshSession();
      });
    });
  }

  function refreshSession() {
    return api('/api/dev/session').then(function (r) {
      state.session = r.session;
      renderAccount();
    });
  }

  /* ── 启动 ───────────────────────────────────────────────────── */

  function boot() {
    api('/api/config').then(function (c) {
      $('footApi').textContent = '商店 ' + c.api_base;
      $('rootPath').textContent = c.root || ROOT;
    }).catch(function () { $('footApi').textContent = '商店 ' + API_BASE; });

    loadPacks();
    refreshSession();
    loadMyApps();

    Array.prototype.forEach.call(document.querySelectorAll('.rxd-tab'), function (tab) {
      tab.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.rxd-tab'), function (x) {
          x.classList.remove('on');
        });
        tab.classList.add('on');
        var v = tab.getAttribute('data-v');
        $('vPacks').hidden = v !== 'packs';
        $('vPublish').hidden = v !== 'publish';
        $('vAccount').hidden = v !== 'account';
      });
    });

    $('btnScan').addEventListener('click', loadPacks);
    $('btnGen').addEventListener('click', genMeta);
    $('btnCheck').addEventListener('click', checkMeta);
    $('btnSave').addEventListener('click', saveMeta);
    $('btnPublish').addEventListener('click', publish);
    $('pubApp').addEventListener('change', function () {
      state.selected = $('pubApp').value;
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
