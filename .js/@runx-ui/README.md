# @runx-ui

把 [`packages/runx-ui`](../../packages/runx-ui/) 的静态资源发给应用页面。

```bash
curl -sI http://127.0.0.1:3000/runx/ui/runx-ui.css | head -3
# HTTP/1.1 200 OK
# Access-Control-Allow-Origin: *
```

## 它做什么

一条路由 `GET /runx/ui/*`：

| 路径 | 内容 |
|---|---|
| `/runx/ui/runx-ui.css` | 组件库样式（含 `@font-face`） |
| `/runx/ui/runx-ui.js` | `window.RX` 交互 |
| `/runx/ui/gallery.html` | 组件画廊（`/runx/ui/` 就是它） |
| `/runx/ui/fonts/*.woff2` | Inter 可变字体 |

文件是**白名单**（`ALLOW` 集合），不是把目录整个吐出去。字体走单独的分支：从桌面
的 `assets/fonts` 取（同一份文件，不复制一份进仓库），并且只允许
`^[\w.-]+\.woff2?$` 的文件名。

## 为什么单开一个扩展

- **字体受 CORS 限制。** 应用页面在自己的源里（`http://127.0.0.1:3470`），字体文件
  在网关（`:3000`）。浏览器会拒绝没有 `Access-Control-Allow-Origin` 的字体请求 ——
  而用 `file://` 或直连桌面目录都拿不到头。所以这条路必须带 `Access-Control-Allow-Origin: *`。
- **这些文件的生命周期与桌面无关。** 桌面没装，应用也应该能用 RunX 的样式。
- **免登录。** 它们只有 CSS/JS/字体，没有任何数据。要求登录反而会坏掉正事：iframe
  里的子资源请求不带 Cookie（`SameSite=Lax`），一律 401 的结果就是「样式偶尔加载失败」。
  所以 `/runx/ui/` 在 [`@runx-rights-manager`](../@runx-rights-manager/) 的 `OPEN_PREFIX` 里。

## 缓存

`ETag`（文件内容的 sha1 前 16 位）+ `Cache-Control: no-cache`。

`no-cache` 不是「不缓存」，是「缓存但每次要问一遍」：改了组件库，刷新页面就生效；
ETag 没变就回 304，不重传。静态资源用 `no-cache` 比长 max-age 更合适 —— 组件库
跟着仓库走，改动频率比「一个月」高得多。

## 不注入任何东西

`js.json` 是 `{}`：这个扩展只提供路由，**不往页面里插脚本**。页面的 `<link>` 与
`<script>` 由应用自己写（这样应用能决定引不引、什么时候引）。
