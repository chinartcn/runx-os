# @runx-browser-api

浏览器能力层：把「有的地方有、有的地方没有、还有的地方有但一用就抛异常」的 API
收成一套，**逐级降级**，并且把「这次实际用了哪一级」报出来。

```js
// 不用再写 if (navigator.clipboard && window.isSecureContext && ...)
await RunX.browser.clipboard.write(text);

// 不用再判 IndexedDB / localStorage / 私密模式
const s = RunX.browser.store('my-app');
await s.set('draft', { title: '未命名' }, { ttl: 7 * 864e5 });
```

挂载点是 `window.RunX.browser`，与 `RunX.bus` / `RunX.files` 同一命名空间。

## 降级链

| 能力 | 一级 | 二级 | 三级 |
|---|---|---|---|
| 存储 | IndexedDB | localStorage | 内存（刷新即失） |
| 剪贴板写 | Clipboard API | `execCommand('copy')` | 抛 `CLIPBOARD_DENIED` |
| 剪贴板读 | Clipboard API | 抛 `NEED_GESTURE` | — |
| 通知 | 桌面 toast | Notification API | 自绘 toast |
| 全屏 | 标准 API | `webkit` 前缀 | 抛 `UNSUPPORTED` |
| 保存文件 | `showSaveFilePicker` | `<a download>` | — |
| 选择文件 | `showOpenFilePicker` | `<input type=file>` | — |
| 分享 | `navigator.share` | 复制链接 + toast | 抛 `UNSUPPORTED` |

「三级」是保底，不是失败：抛 `NEED_GESTURE` 表示**需要用户按 ⌘V**，调用方应该弹
一个提示，而不是显示「操作失败」。

## 能力表

```js
RunX.browser.caps.storage
// { ok: true, via: 'indexeddb', why: '' }
RunX.browser.caps
// { storage, clipboardWrite, clipboardRead, notify, fullscreen, share,
//   vibrate, filePicker, fileSave }  —— 每项 { ok, via, why }
```

`via` 是**实际**用的实现，`why` 是降级原因（空串表示一级）。存储的 `via` 要等
开库才确定，初始化完成前是 `'pending'`。

订阅变化：

```js
RunX.browser.on('ready', ({ storage }) => { /* 'indexeddb' | 'localstorage' | 'memory' */ });
RunX.browser.on('degrade', ({ what, why, detail }) => { /* 通知 UI：存储不可持久 等 */ });
RunX.browser.on('evict', ({ count, keys }) => { /* 配额满了，删了这些 */ });
```

## 存储

```js
const s = RunX.browser.store('namespace');   // 每个调用方一个命名空间
await s.set(key, value, { ttl });            // value 必须能结构化克隆（不能是函数）
await s.get(key, dflt);
await s.del(key);
await s.keys();       // 只有本命名空间的
await s.clear();      // 只清本命名空间
await s.size();       // 粗略字节数
await s.backend();    // { kind, durable }
```

三个设计取舍：

**读也是异步的。** 即使后端是 localStorage（同步），接口也返回 Promise —— 否则
换后端（IDB → 内存）时所有调用方都要改。

**过期在读取时清。** 没有后台定时器，省一个常驻任务；代价是「永不读取的过期项」
要等配额淘汰才会被清掉，这不影响正确性。

**配额满了按时间淘汰。** 写入抛 `QuotaExceededError` 时，删掉最久没更新的 25%
再重试一次。只重试一次 —— 再失败说明单个值本身就比剩余空间大，重试多少次都一样。
刚写入的项不会优先被删（按 `t` 升序淘汰），否则会出现「刚存进去就没了」。

### 私密模式

Safari 无痕下 `localStorage` 对象和 `setItem` 都存在，**一写就抛**。所以可用性
判断必须真写一次，不能只判断 `'localStorage' in window`。判定不可用时降级到内存，
并在 `caps.storage.why` 里写明「刷新后数据会丢」，`degrade` 事件也会发出来 ——
让 UI 有机会提示，而不是让用户存了一下午东西然后消失。

### 迁移

老版本写在 localStorage 里（`rx:` 前缀）的数据，在 IndexedDB 可用时会在启动时
搬到 IDB 并删掉旧键，用 `__migrated__` 标记只搬一次。

## 其他

```js
RunX.browser.env            // mobile/touch/standalone/secure/dark/reducedMotion/locale/tz/dpr/...
RunX.browser.notify({ title, body, system? })
RunX.browser.fullscreen.enter(el) / exit() / toggle() / isOn()
RunX.browser.share({ title, text, url })
RunX.browser.vibrate([80, 40, 80])
RunX.browser.file.pick({ accept, multiple })   // → File[]
RunX.browser.file.save(name, blobOrString)
RunX.browser.net.online() / onChange(cb)
RunX.browser.estimate()                        // 浏览器给的配额估算（可能为 null）
```

`notify` 默认走桌面 toast（在桌面里最自然）；传 `system: true` 才会尝试系统通知，
且**只在已经授权时**才用 —— 主动 `requestPermission()` 会弹一个大框打断用户，
那应该由用户在设置里显式开启。
