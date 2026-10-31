'use strict';

/**
 * tarpack.js —— 纯 Node 的 tar.gz 打包器
 *
 * ── 为什么要自己写，不用 tar 命令 ────────────────────────────────
 * runx-dev 跑在围栏里。Node 的权限模型里，起子进程需要 --allow-child-process，
 * 那等于把「能 exec 任意程序」整个交出去 —— 为了打个包不值当。
 *
 * 纯 JS 实现只需要 fs 和 zlib（都是内置模块，权限模型不管），
 * 换来的是 runx-dev 的权限声明里不必出现 proc.spawn。
 *
 * ── 格式 ────────────────────────────────────────────────────────
 * ustar，每条 512 字节头 + 数据按 512 对齐，末尾两��� 512 零字节。
 * 路径超过 100 字符用 GNU longname（typeflag 'L'）续接，
 * 硬链接/符号链接不打包（应用包里不该有这些）。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK = 512;

function pad(buf, size) {
  const rem = buf.length % size;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(size - rem)]);
}

/** 把八进制字符串塞进固定长度的字段里（返回 Buffer） */
function octal(value, len) {
  // tar 的八进制字段末尾要留一个 NUL 或空格
  const s = value.toString(8);
  return Buffer.from(s.padStart(len - 1, '0') + '\0', 'ascii');
}

function writeStr(buf, str, offset, len) {
  buf.write(String(str).slice(0, len - 1), offset, len - 1, 'ascii');
}

/**
 * 生成一条 tar 条目头。
 * @param {string} name 归档内的路径
 * @param {number} size 文件字节数
 * @param {number} mode 文件模式
 * @param {string} typeflag '0'=文件 '5'=目录
 * @param {number} mtime
 */
function header(name, size, mode, typeflag, mtime) {
  const buf = Buffer.alloc(BLOCK);
  const prefix = Buffer.alloc(0);

  // 路径太长：拆成 prefix/name（ustar 允许 prefix 155 + name 100）
  let base = name;
  let pre = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', name.length - 100);
    if (cut > 0 && Buffer.byteLength(name.slice(cut + 1)) <= 100) {
      pre = name.slice(0, cut);
      base = name.slice(cut + 1);
    } else {
      // 还是太长 → 交给 longname 机制（调用方负责）
      return null;
    }
  }
  void prefix;

  writeStr(buf, base, 0, 100);
  octal(mode & 0o7777, 8).copy(buf, 100);
  octal(0, 8).copy(buf, 108);        // uid
  octal(0, 8).copy(buf, 116);        // gid
  octal(size, 12).copy(buf, 124);
  octal(Math.floor(mtime / 1000), 12).copy(buf, 136);
  buf.write('        ', 148, 8, 'ascii');    // checksum 占位
  buf.write(typeflag, 156, 1, 'ascii');
  buf.write('ustar', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  if (pre) writeStr(buf, pre, 345, 155);

  // checksum：所有字节之和，存成六位八进制 + NUL + 空格
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  const cs = sum.toString(8).padStart(6, '0');
  buf.write(cs + '\0 ', 148, 8, 'ascii');
  return buf;
}

/** GNU longname：把超长路径单独存成一条 'L' 条目 */
function longnameHeader(name) {
  const data = Buffer.concat([Buffer.from(name, 'utf8'), Buffer.alloc(1)]);
  const h = header('././@LongLink', data.length, 0o644, 'L', 0);
  if (!h) return null;
  return Buffer.concat([h, pad(data, BLOCK)]);
}

/**
 * 把一个目录打成 tar.gz。
 *
 * @param {string} srcDir 要打包的目录
 * @param {string} outFile 输出文件（.tar.gz）
 * @param {{base?:string, skip?:string[]}} opts
 *        base  —— 归档内的顶层目录名（默认目录名本身）
 *        skip  —— 要跳过的顶层条目名（node_modules、data 等）
 * @returns {{bytes:number, files:number, dirs:number}}
 */
function pack(srcDir, outFile, opts) {
  const o = opts || {};
  const base = o.base || path.basename(srcDir);
  const skip = new Set(o.skip || ['node_modules', 'data', '.git']);

  const chunks = [];
  let files = 0;
  let dirs = 0;

  function add(relPath, absPath, stat) {
    const name = base + '/' + relPath;
    const mtime = stat.mtimeMs || Date.now();

    // 目录：typeflag '5'，size 0
    if (stat.isDirectory()) {
      const h = header(name, 0, stat.mode, '5', mtime);
      if (!h) { chunks.push(longnameHeader(name)); }
      else chunks.push(h);
      dirs++;
      // 目录条目本身不占数据块
      let kids = [];
      try { kids = fs.readdirSync(absPath); } catch { kids = []; }
      kids.sort();
      for (const k of kids) {
        if (skip.has(k)) continue;
        const childAbs = path.join(absPath, k);
        let st;
        try { st = fs.lstatSync(childAbs); } catch { continue; }
        if (st.isSymbolicLink()) continue;   // 软链不打包
        if (!st.isDirectory() && !st.isFile()) continue;
        add(path.posix.join(relPath, k), childAbs, st);
      }
      return;
    }

    if (!stat.isFile()) return;
    let data;
    try { data = fs.readFileSync(absPath); } catch { return; }
    const h = header(name, data.length, stat.mode, '0', mtime);
    if (!h) {
      // 路径超长：先写 longname 条目，再写正常头（路径改成短的占位）
      chunks.push(longnameHeader(name));
      const short = header(base + '/./@LongLink', data.length, stat.mode, '0', mtime);
      chunks.push(short, pad(data, BLOCK));
    } else {
      chunks.push(h, pad(data, BLOCK));
    }
    files++;
  }

  const rootStat = fs.statSync(srcDir);
  // 顶层目录条目
  const rootH = header(base, 0, rootStat.mode, '5', rootStat.mtimeMs || Date.now());
  if (rootH) chunks.push(rootH);
  dirs++;

  let names = [];
  try { names = fs.readdirSync(srcDir); } catch { names = []; }
  names.sort();
  for (const n of names) {
    if (skip.has(n)) continue;
    const abs = path.join(srcDir, n);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (!st.isDirectory() && !st.isFile()) continue;
    add(n, abs, st);
  }

  // 末尾：两�� 512 零字节
  chunks.push(Buffer.alloc(BLOCK * 2));
  const tar = Buffer.concat(chunks);
  const gz = zlib.gzipSync(tar, { level: 6 });
  fs.writeFileSync(outFile, gz);
  return { bytes: gz.length, files, dirs };
}

module.exports = { pack };
