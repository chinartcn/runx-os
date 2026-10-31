'use strict';

/**
 * cli.js —— 账号维护（不经过网页，服务器没起也能用）
 *
 *   node .js/@runx-rights-manager/cli.js list
 *   node .js/@runx-rights-manager/cli.js add alice            # 交互输入密码
 *   node .js/@runx-rights-manager/cli.js add bob --admin
 *   node .js/@runx-rights-manager/cli.js passwd alice
 *   node .js/@runx-rights-manager/cli.js rm bob
 *   node .js/@runx-rights-manager/cli.js grants alice
 *   node .js/@runx-rights-manager/cli.js revoke alice <grant-id>
 *
 * ── 为什么不是 `node server.js --reset-password` ────────────────
 * server.js 是 NavExt 内核，改它的启动参数等于把 RunX 的账号逻辑塞进上游代码，
 * 以后合并内核版本就冲突。这里直接读写 var/runx/users.json，和网页端改的是
 * 同一份文件（写入是原子的，不用停服务器）。
 *
 * 密码输入默认不回显；在没有 tty 的环境（CI、管道）自动退回逐行读取。
 */

const path = require('path');
const readline = require('readline');
const { createAccounts } = require('./accounts');
const { createGrants } = require('./grants');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'var', 'runx');

const accounts = createAccounts({ dir: DIR, log: (m) => console.log(m) });
const grants = createGrants({ dir: DIR, log: (m) => console.log(m) });

/* 非 TTY（管道、CI）时用同一个 readline 实例按行读。
   每次 question 都新建一个 interface 会把 stdin 里剩下的行一起吞掉，
   第二个问题永远读到 EOF —— 表现就是「输入两次密码不一致」或者干脆没反应。 */
let lineRl = null;
const lineBuf = [];
const lineWaiters = [];
function nextLine() {
  if (!lineRl) {
    lineRl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    lineRl.on('line', (l) => {
      const w = lineWaiters.shift();
      if (w) w(l); else lineBuf.push(l);
    });
    lineRl.on('close', () => {
      while (lineWaiters.length) lineWaiters.shift()('');
    });
  }
  if (lineBuf.length) return Promise.resolve(lineBuf.shift());
  return new Promise((res) => lineWaiters.push(res));
}

/** 不回显地读一行密码 */
function askHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // 管道输入无法隐藏，也不该假装能隐藏：把提示写到 stderr，不污染 stdout
      process.stderr.write(question + '\n');
      nextLine().then((a) => resolve(String(a || '').trim()));
      return;
    }
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (ch) => {
      const s = ch.toString('utf8');
      for (const c of s) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') { buf = buf.slice(0, -1); continue; }
        buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

function usage() {
  console.log(`用法：node .js/@runx-rights-manager/cli.js <命令>

  list                      列出账号
  add <名字> [--admin]      新建账号（密码交互输入）
  passwd <名字>             重设密码
  rm <名字>                 删除账号
  grants <名字>             查看该用户的授权
  grant <名字> <应用|*> <能力> <作用域>
  revoke <名字> <授权 id>

能力：fs.read fs.write fs.list fs.stat fs.remove fs.mkdir fs.copy proc.spawn net.fetch sys.info
作用域：绝对路径 + glob，如 /sdcard/notes/**（** 吃任意层）`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') return usage();

  if (cmd === 'list') {
    const users = accounts.list();
    if (!users.length) return console.log('（还没有账号。先 add 一个，第一个自动成为管理员）');
    for (const u of users) {
      console.log(`${u.id}  ${u.name.padEnd(16)} ${u.role.padEnd(6)} ${u.disabled ? '停用' : ''} 创建于 ${new Date(u.created_at).toLocaleString()}`);
    }
    return;
  }

  if (cmd === 'add') {
    const name = rest[0];
    if (!name) return usage();
    const isAdmin = rest.includes('--admin');
    const pw = await askHidden(`为 ${name} 设置密码（至少 6 位，输入不回显）：`);
    if (pw.length < 6) { console.error('密码太短'); process.exit(1); }
    const again = await askHidden('再输一次：');
    if (pw !== again) { console.error('两次输入不一致'); process.exit(1); }
    const u = await accounts.create({ name, password: pw, role: isAdmin ? 'admin' : 'user' });
    console.log(`已创建：${u.name}（${u.role}）`);
    return;
  }

  if (cmd === 'passwd') {
    const name = rest[0];
    const u = name && accounts.getByName(name);
    if (!u) { console.error('账号不存在'); process.exit(1); }
    const pw = await askHidden(`为 ${u.name} 设置新密码：`);
    if (pw.length < 6) { console.error('密码太短'); process.exit(1); }
    await accounts.setPassword(u.id, pw);
    console.log('密码已更新');
    return;
  }

  if (cmd === 'rm') {
    const u = rest[0] && accounts.getByName(rest[0]);
    if (!u) { console.error('账号不存在'); process.exit(1); }
    accounts.remove(u.id);
    console.log(`已删除：${u.name}`);
    return;
  }

  if (cmd === 'grants') {
    const u = rest[0] && accounts.getByName(rest[0]);
    if (!u) { console.error('账号不存在'); process.exit(1); }
    const list = grants.list(u.id);
    if (!list.length) return console.log('（没有授权）');
    for (const g of list) {
      console.log(`${g.id}  ${g.app.padEnd(12)} ${g.cap.padEnd(10)} ${g.scope}  ${g.by ? '（' + g.by + ' 批准）' : ''}`);
    }
    return;
  }

  if (cmd === 'grant') {
    const [name, app, cap, scope] = rest;
    const u = name && accounts.getByName(name);
    if (!u || !app || !cap || !scope) return usage();
    const g = grants.grant(u.id, { app, cap, scope, by: 'cli', note: '命令行授权' });
    console.log(`已授权：${g.app} ${g.cap}:${g.scope}（${g.id}）`);
    return;
  }

  if (cmd === 'revoke') {
    const [name, id] = rest;
    const u = name && accounts.getByName(name);
    if (!u || !id) return usage();
    console.log(grants.revoke(u.id, id) ? '已撤销' : '授权 id 不存在');
    return;
  }

  usage();
}

main().catch((e) => { console.error('出错：' + e.message); process.exit(1); });
