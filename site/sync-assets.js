#!/usr/bin/env node
/**
 * 把站点需要的资源从仓库各处拷到 site/www/ 与 site/docs/public/。
 *
 * 为什么要有这个脚本：官网与文档站要用**同一份**组件库与字体，
 * 但它们又是构建产物，不该入库。
 * 拷一次 → 部署 → 完事。改组件库后重跑一次。
 *
 * 用法：node site/sync-assets.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const COPIES = [
  // 官网：组件库 + 字体
  ['packages/runx-ui/runx-ui.css', 'site/www/assets/runx-ui.css'],
  ['packages/runx-ui/runx-ui.js', 'site/www/assets/runx-ui.js'],
  ['.js/@runx-desktop/assets/fonts/InterVariable.woff2', 'site/www/assets/fonts/InterVariable.woff2'],
  ['.js/@runx-desktop/assets/fonts/InterVariable-Italic.woff2', 'site/www/assets/fonts/InterVariable-Italic.woff2'],
  // 文档站：同一份字体
  ['.js/@runx-desktop/assets/fonts/InterVariable.woff2', 'site/docs/public/fonts/InterVariable.woff2'],
  ['.js/@runx-desktop/assets/fonts/InterVariable-Italic.woff2', 'site/docs/public/fonts/InterVariable-Italic.woff2'],
];

let n = 0;
let missing = 0;
for (const [from, to] of COPIES) {
  const src = path.join(ROOT, from);
  const dst = path.join(ROOT, to);
  if (!fs.existsSync(src)) {
    console.error('缺少源文件：' + from);
    missing++;
    continue;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  n++;
}

console.log(`已拷贝 ${n} 个文件` + (missing ? `，${missing} 个源缺失` : ''));

// 顺带校验一下：组件库 CSS 引用的字体路径与实际文件是否对得上
const css = path.join(ROOT, 'site/www/assets/runx-ui.css');
if (fs.existsSync(css)) {
  const text = fs.readFileSync(css, 'utf8');
  const refs = [...text.matchAll(/url\(["']?([^"')]+\.woff2)/g)].map(m => m[1]);
  const bad = refs.filter(r => {
    const p = path.resolve(path.dirname(css), r);
    return !fs.existsSync(p);
  });
  if (bad.length) {
    console.error('CSS 里引用了不存在的字体：' + bad.join(', '));
    process.exit(1);
  }
  if (refs.length) console.log(`字体引用校验通过（${refs.length} 处）`);
}
