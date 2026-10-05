RunX OS (Termux 版) — v1.4 定稿

跑在 Termux 上的用户空间桌面环境，浏览器渲染。
不依赖 cgroup / user ns / 多 UID / systemd。
全部是"Node 进程 + 文件 + socket"。

---

0. 定位

是：一个 Node 主进程 + 浏览器桌面的应用管理器。
不是：操作系统、安全沙箱、多用户系统。

单用户。单 UID。所有应用都是你自己装的。
应用之间不隔离——它们本来就该协作。

---

1. 模块总览

```text
RunX OS / (Termux)
├── R.init                      # 启动编排：读配置、起模块
├── R.supervisor                # 进程生命周期 + 回收所有者 + 重启
├── PaX                         # 包管理：解包 + pnpm install
├── R.htmlserver                # Web App 静态服务
├── R.node.process              # Node App 运行时
├── R.port                      # 端口分配（应用属性，不动态抢）
├── R.gc                        # 资源回收（临时文件、死进程记录）
├── R.kill                      # 触发器：只调 supervisor.terminate
└── R.windowManager             # 桌面（浏览器 DOM 渲染）
    ├── src/
    │   ├── wm.core.ts          # 窗口树、层级、状态（平台无关）
    │   ├── wm.events.ts        # 语义事件
    │   └── wm.dom.ts           # DOM 渲染后端
    ├── dist/
    ├── assets/
    ├── wm.conf
    └── apps/
```

源码 / 产物：

```text
<module>/
├── src/          # 只放 .ts
├── dist/         # 只放 .js（构建产物）
└── *.conf
```

package.json 的 main 一律指向 dist/。运行时加载 src/*.ts 算 bug。

---

2. 架构图

```text
┌─────────────────────── RunX (单 Node 主进程) ──────────────────────┐
│                                                                    │
│  R.init ──► R.supervisor ──► R.htmlserver / R.node.process        │
│              │                │                                    │
│              │                ├── web 应用（HTML/JS 静态）         │
│              │                └── node 应用（子进程）              │
│              │                                                     │
│              ├── R.port     （apps.json 里的端口属性）             │
│              ├── R.gc       （tmp 文件、死记录）                   │
│              └── R.kill     （只调 supervisor.terminate）          │
│                                                                    │
│  PaX ──► 解包 / pnpm install / 记录版本                            │
│                                                                    │
│  HTTP 服务 (localhost:8080)                                        │
│    ├── /              → 桌面（windowManager，浏览器 DOM）          │
│    ├── /apps/<name>/  → Web 应用静态文件                           │
│    └── /api/...       → 应用管理 API                               │
└────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
                    浏览器 (Android / 桌面)
```

关键：windowManager 不在 Node 里画东西。它给浏览器一个 SPA，浏览器负责渲染。Node 只提供数据和 API。

---

3. R.init

启动编排。读配置，按顺序起模块。

启动顺序：

```text
systemd / init / 手动脚本
  → R.init
    → 起 HTTP 服务（localhost:8080）
    → 起 supervisor
    → 起 PaX（校验 apps.json）
    → 起 R.htmlserver / R.node.process
    → 起 windowManager
    → 桌面就绪
```

Termux 上由用户手动跑 runx start，或 ~/.bashrc 里自动拉。不依赖 systemd。

---

4. PaX — 包管理

PaX = pnpm 的壳。它不管依赖解析——pnpm 管。它只管解包、调 pnpm、记录版本。

4.1 应用 = 一个目录

```
$PREFIX/apps/<name>/
├── appex.json          # RunX 元数据（必需）
├── package.json        # pnpm 依赖声明（可选）
├── pnpm-lock.yaml      # 锁文件（可选）
├── data/               # 用户数据（可选，更新时保留）
├── node_modules/       # pnpm install 生成
└── ... 应用代码
```

应用之间不共享代码——各自 node_modules/ 就行。

4.2 安装流程

```
1. 拿 tarball 或本地目录
2. 若 tarball：安全校验 + 解包（拒 ../、绝对路径、symlink）
3. 拷到 $PREFIX/apps/<name>/
4. 读 appex.json
5. 若有 package.json → cd 进去跑 pnpm install（默认跑 postinstall）
6. 更新 apps.json（记录 name、version、installed_at、source）
```

4.3 tarball 安全校验

必须做——这是处理不可信输入：

· 拒 ../ 路径段
· 拒绝对路径（首字符 /）
· 拒 symlink / hardlink / device / fifo / socket
· 单个路径段按 UTF-8 字节数 ≤ 255
· 完整路径按 UTF-8 字节数 ≤ 4096

其余不做——不搞 CAS store、不搞 profile、不搞签名。

4.4 更新

```
1. 停应用
2. 保留 appex.json 声明的 data_dir（若有）
3. 覆盖其余文件
4. pnpm install（幂等，没变就秒退）
5. 更新 apps.json
```

没有"重装 node_modules"这个动作——pnpm install 本身幂等。

4.5 卸载

```
1. 停应用
2. rm -rf $PREFIX/apps/<name>/
3. 从 apps.json 移除
```

4.6 pax.conf

```conf
pnpm_path          = "pnpm"       # 默认 PATH 里的
install_timeout_ms = 300000       # 5 分钟
```

没有 registry、offline、签名配置——这些不需要。

---

5. 进程管理

5.1 归属原则

supervisor 是唯一回收所有者。 kill 只是触发器。

为什么：kill 自己崩了，回收永远不会发生。谁拉起进程，谁负责在进程死后清账。

5.2 apps.json

```json
{
  "schema": 1,
  "apps": [
    {
      "name": "notes",
      "type": "node",
      "cmd": "node app.js",
      "cwd": "$PREFIX/apps/notes",
      "port": 3001,
      "autostart": true,
      "restart": "on-failure",
      "restart_delay_ms": 1000,
      "restart_max": 5,
      "restart_window_ms": 60000
    }
  ]
}
```

端口是应用的属性，不动态分配。重启复用同一端口，iframe 不废。

5.3 生命周期

```text
启动:
  supervisor.spawn(app)
    ├── 检查端口可用
    ├── 检查 cwd 存在
    ├── child_process.spawn(cmd, { cwd, env })
    └── 记 pid → app 映射

退出:
  supervisor 收 child.on('exit')
    ├── 从 pid → app 映射查应用
    ├── 按 restart policy 决定是否重启
    ├── 通知 gc 清临时资源
    └── 通知 windowManager 更新 UI 状态

停止:
  supervisor.terminate(pid)
    ├── SIGTERM → 宽限 5s → SIGKILL
    └── 走应用退出流程
```

5.4 restart policy

值 含义
no 崩了不重启
on-failure 非零退出才重启（默认）
always 无论如何都重启

重启预算：restart_max + restart_window_ms = 窗口内最多重启几次。超过标记 failed，UI 标红，用户手动点"重启"才清空计数。防无限重启循环打满 CPU。

5.5 日志

```
$PREFIX/var/runx/logs/<app>.log
```

stdout / stderr 重定向到这里。超过 1 MB 截断（保留尾部）。

没有这个，重启就是黑盒——用户只会觉得"又崩了又崩了"。

---

6. windowManager

6.1 用 DOM 不用 Canvas

· 插件是你自己写的，不需要防
· Canvas 要重造浏览器已有的合成、事件、文本渲染、输入法
· 脏矩形在 transform / animation 下几乎必被击穿
· 低端 Android 机上 Canvas 合成比 DOM 慢

直接 DOM + CSS：窗口是 <div>，层级是 z-index，拖拽是 mousedown/mousemove/mouseup。

6.2 核心 / 渲染分离

```text
wm.core.ts     # 窗口树、坐标、层级、归属 — 纯数据，平台无关
wm.events.ts   # 语义事件：window.focus / window.move / window.close
wm.dom.ts      # DOM 渲染后端
```

将来要换 X11 / Wayland 后端，核心不动。

6.3 窗口模型

```ts
interface Window {
  id: string;
  app: string;
  title: string;
  x: number; y: number;
  w: number; h: number;
  z: number;
  state: 'normal' | 'minimized' | 'maximized';
  content: WindowContent;
}

type WindowContent =
  | { type: 'iframe', url: string }
  | { type: 'html', html: string };
```

应用内容用 <iframe> 加载——天然进程隔离、样式隔离、崩溃不互相影响。

6.4 桌面持久化

布局在主进程的 desktop.json，不在 localStorage。

· 换浏览器不丢
· 将来换 X11 后端也能读
· 它是系统状态，不是浏览器偏好

写入时机：拖拽结束才 POST，不是拖拽中。多图标连续拖 → 500ms 防抖合并。

localStorage 只放会话态（上次打开的应用、临时滚动位置）。

---

7. 挂载点

让应用"长"在桌面上。

7.1 两级注册

清单声明（appex.json）——装上就有：

```json
{
  "mounts": [
    { "point": "desktop.widget", "id": "todo", "size": "2x1", "onAppStop": "keep-last" }
  ]
}
```

运行时注册——跑起来才出现的：

```
POST /api/mounts/register
{ "point": "desktop.widget", "id": "todo", "title": "今日待办" }
```

7.2 挂载点类型

挂载点 位置 内容
desktop.widget 桌面网格 iframe 或声明式
taskbar.button 任务栏 图标 + 点击事件
app.background 后台扩展点 主进程加载的 JS 模块

7.3 Widget 内容模型

iframe 型（默认推荐）：

```json
{ "point": "desktop.widget", "id": "todo", "url": "/apps/notes/widget.html" }
```

样式隔离、崩溃隔离、好调试。

声明型：

```json
{
  "point": "desktop.widget",
  "id": "todo",
  "render": { "title": "今日待办", "items": ["写文档"] }
}
```

适合超简单的 Widget。

7.4 生命周期

onAppStop：

值 行为
remove 应用停止即移除
keep-last 保留最后状态，标"应用未运行"（默认）
keep-empty 保留占位

---

8. 事件总线

让应用"说"得上话。iframe 之间绝不直接对话——CORS 和同源策略会让人哭。全部经主进程中转。

8.1 传输

WebSocket 为主（/api/event-bus），HTTP POST 兜底。

8.2 订阅模型

支持通配符：

模式 匹配
calc.result 精确
calc.* calc 发的所有事件
*.done 所有以 .done 结尾的
* 所有（调试用）

8.3 事件结构

```json
{
  "event": "calc.result",
  "from": "calc",
  "payload": "114514",
  "ts": 1700000000000,
  "id": "01J..."
}
```

命名空间规则（不商量）：<app>.<event>。主进程强制校验，不符合 → 422。

from 由主进程填，不接受客户端自报。

8.4 ring buffer + 磁盘日志

· 内存：最近 1000 条，UI 实时展示
· 磁盘：events.log，按 10 MB 轮转，保留 4 个文件（最多 40 MB）

写入策略（Termux 上关键）：

```
事件进内存队列
   ├── 队列 ≥ 100 条 → 立即 flush
   ├── 距上次 flush ≥ 1000ms → 立即 flush
   └── supervisor 收 SIGTERM → 最后 flush

flush = write + fsync（一批一次）
```

不逐条 fsync——f2fs 上会拖死系统。

8.5 可选 ack

```json
{ "event": "build.done", "payload": {...}, "wantAck": true }
```

主进程等 100ms，回 { "ack": true, "listeners": 2 }。不阻塞。

---

9. 持久化全景

按性质分四类：

类别 定义 丢了怎样 写入策略
真相源 不可从别处重建 用户数据断 原子写 + fsync
派生 可从真相源重建 自动重建 随便写
日志 记录历史 丢历史，当前仍可用 批量 + 定时 flush
偏好 用户偏好 重设一次 简单写

9.1 目录树

```text
$PREFIX/
├── apps/<name>/                      # 应用目录 [真相源]
│   ├── appex.json
│   ├── package.json
│   ├── pnpm-lock.yaml
│   ├── data/                         # 用户数据（更新时保留）
│   └── ...
│
└── var/runx/
    ├── apps.json                     # 应用清单 [真相源]
    ├── desktop.json                  # 桌面布局 [真相源]
    ├── pax.conf                      # PaX 配置 [真相源]
    └── logs/
        ├── <app>.log                 # 应用日志 [日志]
        └── events/
            ├── events.log            # 事件日志（当前）[日志]
            ├── events.log.1
            ├── events.log.2
            └── events.log.3

浏览器 localStorage                  # 会话态 [偏好]
```

9.2 真相源

· apps.json：应用清单。写入：安装/卸载/改配置。原子写。.prev 兜底。
· desktop.json：桌面布局（壁纸/图标/Widget/任务栏/主题）。写入：拖拽结束、换壁纸。原子写。不备份——坏了回默认网格。
· appex.json：应用自带清单。写入：应用作者手写。
· pax.conf：PaX 配置。写入：用户改配置。原子写。

9.3 日志

<app>.log：纯文本，1 MB 截断。

events.log*：

· 格式：JSON Lines（ndjson），每行一个事件
· 为什么 JSONL：追加写只 append 一行，崩溃最多丢最后一行，tail -f / jq / grep 直接用
· 按大小轮转（10 MB），保留 4 个
· 启动时读尾部，坏行 truncate

过滤：

事件类型 记录
应用生命周期 ✅
pub ✅
系统事件 ✅
心跳 / ack ❌

9.4 偏好

localStorage 只放会话态：

· 上次打开的应用
· 临时滚动位置
· UI 折叠状态

不存窗口位置、图标坐标、壁纸、主题——这些全在 desktop.json。

9.5 原子写统一模式

```
file.tmp.<pid>  →  write  →  fsync  →  rename  →  fsync dir
```

不做两次 rename——应用清单和桌面布局坏了回默认值就行，不需要 .prev 备份。

9.6 崩溃恢复矩阵

文件 崩溃后 恢复
apps.json 可能不完整 原子写保证要么旧要么新
desktop.json 可能不完整 坏了回默认网格
events.log 最后一行断 truncate 坏行
<app>.log 尾部断 无所谓
localStorage 浏览器保证 无

---

10. 明确不做的

不做 为什么
cgroup 资源限制 Termux 无权写 /sys/fs/cgroup
user ns / net ns Android 内核默认不允许
多 UID / SO_PEERCRED 授权 Termux 只有一个 UID
pax-worker 降权 同一个 UID，setuid 假
flock + fence CAS 单用户，端口不用抢
签名验签 包是你自己装的
CAS store / profile 隔离 pnpm 免费给了硬链接共享
DFS 拓扑排序 pnpm 自己解决
registry 没服务器
IPC + JSON-RPC 主进程内部函数调用；应用间走 localhost HTTP
supervisor.state + 会话恢复 崩了重启就行，不恢复
tmpfs 锁文件 /data/data/com.termux 是 f2fs
Canvas 插件沙箱 DOM + iframe 够用

这些不是"以后做"，是这个平台上不存在。

---

11. 一句话

```text
RunX OS (Termux) =
  一个 Node 主进程
  + PaX（解包 + pnpm install + 记录版本）
  + supervisor（进程生命周期 + 重启 + 日志）
  + R.htmlserver / R.node.process
  + R.port / R.gc / R.kill
  + windowManager（浏览器 DOM 桌面）
  + 挂载点（应用"长"在桌面上）
  + 事件总线（应用"说"得上话）
  = 浏览器里看到的一个"OS"
```

核心是能装应用、能开窗口、崩了能重启、应用能协作。 别的都不要。

---

附录 A：数据模型 / Schema

所有 JSON 结构集中一处。src/types.ts 直接抄。

A.0 通用约定

```ts
interface PersistedFile {
  schema: number;
}

type ID = string;        // ULID，26 字符
type Timestamp = number; // Unix 毫秒
type RelPath = string;   // 相对 $PREFIX，无前导 /，无 ..
```

A.1 apps.json

路径：$PREFIX/var/runx/apps.json
性质：真相源

```ts
interface AppsFile extends PersistedFile {
  schema: 1;
  apps: AppEntry[];
}

interface AppEntry {
  name: string;
  type: 'node' | 'web';
  display_name?: string;
  icon?: string;

  cmd?: string;
  cwd?: string;
  path?: string;

  port: number;
  autostart: boolean;

  restart: 'no' | 'on-failure' | 'always';
  restart_delay_ms: number;
  restart_max: number;
  restart_window_ms: number;

  data_dir?: string;     // 更新时保留的目录（相对应用根）
  version?: string;
  description?: string;
  installed_at?: Timestamp;
}
```

约束：name 匹配 ^[a-z][a-z0-9-]*$，2~32 字符；port 1024~65535。

A.2 desktop.json

路径：$PREFIX/var/runx/desktop.json
性质：真相源

```ts
interface DesktopFile extends PersistedFile {
  schema: 1;
  updated_at: Timestamp;
  wallpaper: Wallpaper;
  theme: ThemeName;
  grid: GridConfig;
  icons: IconEntry[];
  widgets: WidgetEntry[];
  taskbar: TaskbarConfig;
}

interface Wallpaper {
  type: 'builtin' | 'file' | 'url';
  id?: string;
  path?: RelPath;
  url?: string;
}

type ThemeName = 'light' | 'dark' | 'auto';

interface GridConfig {
  cell: number;   // 默认 96
  gap: number;    // 默认 8
}

interface IconEntry {
  id: ID;
  app: string;
  x: number;
  y: number;
  label?: string;
}

interface WidgetEntry {
  id: ID;
  app: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: Record<string, unknown>;
}

interface TaskbarConfig {
  position: 'top' | 'bottom' | 'left' | 'right';
  pinned: string[];
  show_clock: boolean;
}
```

A.3 appex.json

路径：$PREFIX/apps/<name>/appex.json
性质：真相源（应用的一部分）

```ts
interface AppExFile extends PersistedFile {
  schema: 1;
  name: string;
  version: string;
  display_name?: string;
  icon?: string;
  description?: string;
  author?: string;
  type: 'node' | 'web';
  entry?: string;

  data_dir?: string;    // 更新时保留的目录

  mounts?: MountDeclaration[];
  publishes?: EventDeclaration[];
  subscribes?: EventDeclaration[];
}

interface MountDeclaration {
  point: MountPoint;
  id: string;
  title?: string;
  size?: string;
  url?: string;
  render?: WidgetRender;
  onAppStop?: 'remove' | 'keep-last' | 'keep-empty';
  icon?: string;
  action?: string;
}

type MountPoint = 'desktop.widget' | 'taskbar.button' | 'app.background';

interface WidgetRender {
  title?: string;
  items?: string[];
  buttons?: { label: string; action: string }[];
}

interface EventDeclaration {
  event: string;
  description?: string;
  payload_schema?: Record<string, unknown>;
}
```

注意：appex.json 里没有 dependencies——依赖写在 package.json，pnpm 读它。

A.4 事件结构

```ts
interface Event {
  event: string;
  from: string;
  payload: unknown;
  ts: Timestamp;
  id: ID;
  wantAck?: boolean;
}

type WSMessage =
  | { type: 'welcome'; client_id: ID; server_ts: Timestamp }
  | { type: 'pub'; event: string; payload: unknown; wantAck?: boolean }
  | { type: 'sub'; pattern: string }
  | { type: 'unsub'; pattern: string }
  | { type: 'event'; event: string; from: string; payload: unknown; ts: Timestamp; id: ID }
  | { type: 'ack'; id: ID; listeners: number }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'error'; code: number; message: string };
```

A.5 挂载点运行时结构（内存，不持久化）

```ts
interface Mount {
  id: ID;
  app: string;
  point: MountPoint;
  declared: MountDeclaration;
  runtime: MountRuntime;
}

interface MountRuntime {
  status: 'active' | 'app-stopped';
  registered_at: Timestamp;
  last_update?: Timestamp;
  data?: unknown;
}
```

A.6 错误响应

```ts
interface ErrorResponse {
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}
```

错误码：

code 语义
400 请求格式错误
403 无权限
404 资源不存在
409 冲突
422 参数校验失败
500 内部错误
503 服务未就绪

A.7 文件对应表

文件 类型 路径 性质
apps.json AppsFile $PREFIX/var/runx/ 真相源
desktop.json DesktopFile $PREFIX/var/runx/ 真相源
appex.json AppExFile $PREFIX/apps/<name>/ 真相源
pax.conf conf $PREFIX/var/runx/ 真相源
events.log Event 每行 $PREFIX/var/runx/logs/events/ 日志
<app>.log 纯文本 $PREFIX/var/runx/logs/ 日志

---

附录 B：API 完整参考

B.0 通用约定

· Base URL：http://localhost:8080
· Content-Type：application/json; charset=utf-8
· 认证：无。单用户，本地 localhost。
· 应用标识：X-App-Name header。主进程用它确定归属。
· 错误格式：{ error: { code, message, data? } }

X-App-Name 的信任问题：单用户，任何应用都能冒充别的应用。不防。这是协作环境，不是安全边界。

B.1 应用管理

GET /api/apps — 列出所有应用

```json
{
  "apps": [
    {
      "name": "notes",
      "type": "node",
      "display_name": "备忘录",
      "port": 3001,
      "autostart": true,
      "restart": "on-failure",
      "version": "1.0.0",
      "status": {
        "state": "running",
        "pid": 12345,
        "started_at": 1700000000000,
        "restart_count": 0,
        "last_exit": null
      }
    }
  ]
}
```

status.state：running | stopped | restarting | failed

GET /api/apps/:name — 单个应用详情

返回 1.1 中的单个对象。

POST /api/apps/:name/start — 启动应用

```json
{ "pid": 12345, "port": 3001, "started_at": 1700000000000 }
```

错误：404 / 409（已运行 / 端口被占）/ 422（cwd 不存在）/ 500

POST /api/apps/:name/stop — 停止应用

```json
{ "force": false }
```

响应：{ "ok": true, "exit": { "code": 0, "signal": null } }

等待进程真正退出才返回。最长 5s + 1s。

POST /api/apps/:name/restart — 重启应用

清空 restart_count——用户主动重启，重置预算。

GET /api/apps/:name/logs — 应用日志

查询参数：lines（默认 100，最大 1000）、since（Unix 毫秒）

```json
{ "lines": ["..."], "total": 2, "truncated": false }
```

POST /api/apps/install — 安装应用

```json
{
  "source": "local",
  "path": "/sdcard/Download/notes-1.0.0.tar.gz"
}
```

或：

```json
{
  "source": "local",
  "path": "$PREFIX/apps/todo"
}
```

响应：

```json
{ "name": "notes", "version": "1.0.0", "installed_at": 1700000000000 }
```

行为：解包 → 读 appex.json → pnpm install（若有 package.json）→ 更新 apps.json

大包会慢，HTTP 超时默认 120 秒。客户端断开 → 主进程取消。

POST /api/apps/:name/update — 更新应用

```json
{ "source": "local", "path": "..." }
```

行为：停应用 → 保留 data_dir → 覆盖代码 → pnpm install（幂等）→ 更新 apps.json

DELETE /api/apps/:name — 卸载应用

行为：停应用 → rm -rf apps/<name>/ → 从 apps.json 移除

B.2 桌面

GET /api/desktop — 拿完整布局

返回完整 DesktopFile。

POST /api/desktop/icons — 添加快捷方式

```json
{ "app": "notes", "x": 0, "y": 0, "label": "备忘录" }
```

x/y 缺省 → 主进程找第一个空格。

PATCH /api/desktop/icons/:id — 更新图标

```json
{ "x": 2, "y": 1 }
```

只给变化的字段。主进程读 → 合并 → 原子写。

DELETE /api/desktop/icons/:id — 删快捷方式

只删快捷方式，不卸载应用。

POST /api/desktop/widgets — 添加 Widget

```json
{ "app": "notes", "x": 3, "y": 0, "w": 2, "h": 1 }
```

PATCH /api/desktop/widgets/:id — 更新 Widget

```json
{ "x": 4, "y": 2, "w": 3, "h": 2 }
```

DELETE /api/desktop/widgets/:id — 删除 Widget

若该 Widget 是应用声明的挂载点 → 同时调 /api/mounts/:id 注销。

PUT /api/desktop/wallpaper — 换壁纸

```json
{ "type": "builtin", "id": "aurora" }
```

或：

```json
{ "type": "file", "path": "wallpapers/my-bg.jpg" }
```

或：

```json
{ "type": "url", "url": "https://..." }
```

PUT /api/desktop/theme — 换主题

```json
{ "theme": "dark" }
```

PUT /api/desktop/taskbar — 更新任务栏

```json
{ "position": "bottom", "pinned": ["notes", "calc"], "show_clock": true }
```

全量替换。pinned 里不存在的 app 静默忽略。

B.3 挂载点

GET /api/mounts — 列出所有挂载

```json
{
  "mounts": [
    {
      "id": "01J...",
      "app": "notes",
      "point": "desktop.widget",
      "declared": { "point": "desktop.widget", "id": "todo", "title": "今日待办", "size": "2x1", "url": "/apps/notes/widget.html", "onAppStop": "keep-last" },
      "runtime": { "status": "active", "registered_at": 1700000000000, "last_update": null }
    }
  ]
}
```

POST /api/mounts/register — 运行时注册

```json
{
  "point": "desktop.widget",
  "id": "todo",
  "title": "今日待办",
  "size": "2x1",
  "url": "/apps/notes/widget.html",
  "onAppStop": "keep-last"
}
```

响应：{ "mount_id": "01J..." }

同一 app 同一 id 重复注册 → 覆盖旧声明。

DELETE /api/mounts/:id — 注销

403 出现在"应用 A 试图注销应用 B 的挂载点"。

POST /api/mounts/:id/update — 更新声明型 Widget

```json
{ "data": { "title": "今日待办", "items": ["写文档"] } }
```

只对声明型有效。iframe 型返回 422。

B.4 事件总线

POST /api/event-bus — HTTP 发布

```json
{ "event": "calc.result", "payload": "114514", "wantAck": false }
```

响应：{ "id": "01J...", "listeners": 2 }（listeners 仅 wantAck=true 时返回）

主进程填 from，忽略请求体里的 from。命名空间 <app>.<event> 强制校验。

GET /api/event-bus/history — ring buffer 快照

查询参数：limit（默认 100，最大 1000）

从内存读，不走磁盘。

GET /api/event-bus/log — 磁盘日志查询

查询参数：from、to、event（支持通配符）、app、limit（默认 500，最大 5000）

```json
{ "events": [ /* 按时间升序 */ ], "truncated": false }
```

从最新轮转文件往前读。大范围查询会慢，不建索引。

WS /api/event-bus — WebSocket 主通道

连接后主进程发欢迎：

```json
{ "type": "welcome", "client_id": "01J...", "server_ts": 1700000000000 }
```

客户端 → 服务端：

```json
{ "type": "pub", "event": "calc.result", "payload": "114514", "wantAck": false }
{ "type": "sub", "pattern": "calc.*" }
{ "type": "unsub", "pattern": "calc.*" }
{ "type": "ping" }
```

服务端 → 客户端：

```json
{ "type": "event", "event": "calc.result", "from": "calc", "payload": "114514", "ts": 1700000000000, "id": "01J..." }
{ "type": "ack", "id": "01J...", "listeners": 2 }
{ "type": "pong" }
{ "type": "error", "code": 422, "message": "invalid event namespace" }
```

错误消息不关闭连接。除非是协议级错误（JSON 解析失败）。

生命周期：无 sub 的客户端只收自己的 ack；连接断开自动清订阅；60 秒无消息发 ping，再 60 秒无响应断开。

---

附录 C：应用开发指南

C.0 应用是什么

Web 应用：HTML 文件夹，浏览器 iframe 加载。
Node 应用：Node 进程，监听固定端口，浏览器 iframe 指向 localhost:<port>。

 Web Node
入口 index.html app.js
进程 无 Node 子进程
数据 localStorage / 主进程 API 任意
崩溃 iframe 白屏 进程死，supervisor 重启
适合 纯前端工具 需要文件/网络/长任务

先用 Web 应用起步——不用管进程、端口，调试就是 DevTools。

C.1 目录结构

```
$PREFIX/apps/todo/
├── appex.json          # 必需：RunX 元数据
├── package.json        # 可选：pnpm 依赖
├── pnpm-lock.yaml      # 可选：锁文件
├── index.html          # Web 入口
├── app.js
├── style.css
├── icon.png
├── widget.html         # 可选：Widget
└── data/               # 可选：用户数据（更新时保留）
```

C.2 appex.json

```json
{
  "schema": 1,
  "name": "todo",
  "version": "1.0.0",
  "display_name": "待办",
  "icon": "icon.png",
  "type": "web",
  "entry": "index.html",

  "mounts": [
    {
      "point": "desktop.widget",
      "id": "todo-widget",
      "title": "今日待办",
      "size": "2x1",
      "url": "widget.html",
      "onAppStop": "keep-last"
    }
  ],

  "publishes": [
    { "event": "todo.added", "description": "新待办被添加" }
  ],

  "subscribes": [
    { "event": "calc.result", "description": "计算器结果" }
  ]
}
```

publishes / subscribes 只是文档，主进程不强制。

C.3 package.json（可选）

如果应用需要 npm 依赖，写 package.json：

```json
{
  "name": "todo",
  "version": "1.0.0",
  "dependencies": {
    "lodash": "^4.17.21"
  }
}
```

PaX 装应用时会跑 pnpm install。默认跑 postinstall——原生模块能正常构建。

C.4 最小 Web 应用

index.html

```html
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>待办</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <h1>待办</h1>
    <input id="new-todo" placeholder="添加待办..." autofocus>
  </header>
  <ul id="list"></ul>
  <script src="app.js"></script>
</body>
</html>
```

style.css

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font: 14px -apple-system, "PingFang SC", sans-serif;
  background: #1e1e1e;
  color: #e0e0e0;
  padding: 16px;
}
header { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
h1 { font-size: 18px; }
input {
  flex: 1;
  padding: 8px 12px;
  background: #2a2a2a;
  color: inherit;
  border: 1px solid #333;
  border-radius: 6px;
  outline: none;
}
input:focus { border-color: #4a9eff; }
ul { list-style: none; }
li {
  padding: 10px 12px;
  background: #2a2a2a;
  border-radius: 6px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
}
li.done { opacity: 0.5; text-decoration: line-through; }
```

app.js

```js
const STORAGE_KEY = 'todo.items';
let items = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function render() {
  const list = document.getElementById('list');
  list.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    if (item.done) li.classList.add('done');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.done;
    cb.addEventListener('change', () => {
      item.done = cb.checked;
      save();
      render();
      if (item.done) publish('todo.completed', { text: item.text });
    });

    const span = document.createElement('span');
    span.textContent = item.text;

    li.appendChild(cb);
    li.appendChild(span);
    list.appendChild(li);
  }
}

document.getElementById('new-todo').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const text = e.target.value.trim();
  if (!text) return;
  items.push({ text, done: false, ts: Date.now() });
  e.target.value = '';
  save();
  render();
  publish('todo.added', { text });
});

const APP = 'todo';
const BASE = 'http://localhost:8080';

async function publish(event, payload) {
  await fetch(`${BASE}/api/event-bus`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-App-Name': APP
    },
    body: JSON.stringify({ event: `${APP}.${event}`, payload })
  });
}

render();
```

C.5 Widget

widget.html + widget.js，跟主应用共享同一个 origin（localhost:8080/apps/todo/）。

```js
// widget.js
const STORAGE_KEY = 'todo.items';

function render() {
  const items = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  const list = document.getElementById('list');
  list.innerHTML = '';
  const pending = items.filter(i => !i.done).slice(0, 5);
  if (pending.length === 0) {
    list.innerHTML = '<li class="empty">暂无待办</li>';
    return;
  }
  for (const item of pending) {
    const li = document.createElement('li');
    li.textContent = '· ' + item.text;
    list.appendChild(li);
  }
}

window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) render();
});

// 监听事件
const ws = new WebSocket('ws://localhost:8080/api/event-bus');
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'sub', pattern: 'calc.*' }));
});
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'event') {
    const items = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    items.push({ text: String(msg.payload), done: false, ts: Date.now() });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    render();
  }
});

render();
```

C.6 Node 应用

appex.json：

```json
{
  "schema": 1,
  "name": "todo-server",
  "version": "1.0.0",
  "type": "node",
  "entry": "app.js",
  "port": 3001
}
```

app.js：

```js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'data.json');

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}
function save(items) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items));
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/items' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(load()));
  }
  if (req.url === '/api/items' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { text } = JSON.parse(body);
      const items = load();
      items.push({ text, done: false, ts: Date.now() });
      save(items);
      res.end('{}');
    });
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`todo-server listening on ${PORT}`);
});
```

端口由主进程通过 PORT 环境变量传。不要硬编码。

C.7 事件命名规则

合法 非法
todo.added added（没有命名空间）
todo.item.added todo-added（用 . 分隔）
calc.result Todo.added（大写）

主进程拒绝不符合格式的，返回 422。

C.8 常见坑

坑 原因 解决
事件发出去没人收 命名空间缺 <app>. 前缀 检查格式
Widget 不显示 appex.json 里 mounts 写错 GET /api/mounts 查
Node 应用起不来 端口被占 / cwd 不存在 /api/apps/<name>/logs
iframe 白屏 URL 路径错 / 应用没启动 DevTools Network
localStorage 跨应用串 同一 origin key 加前缀，如 todo.items
改了 appex.json 不生效 主进程缓存了 重启应用
事件总线连不上 用了 http:// 不是 ws:// WebSocket 要 ws://
pnpm install 慢 网络问题 pnpm config set registry ...

C.9 打包

```bash
tar czf todo-1.0.0.tar.gz -C todo .
```

安装：

```
POST /api/apps/install
{ "source": "local", "path": "/sdcard/Download/todo-1.0.0.tar.gz" }
```

tarball 里不要含 node_modules/——PaX 会跑 pnpm install 自己装。

---

定稿说明

这份文档整合了四份原始文档：

· RunX.OS.Termux.md（v1.1 + v1.2 + v1.3）
· RunX.api.reference.DataModel.Schema.md
· RunX.api.reference.md
· RunX.ApplicationDevelopmentGuide.md

主要修订（相对本地版本）：

1. PaX 整节重写——从"CAS + profile + DFS + 签名"改为"解包 + pnpm install + 记录版本"
2. 桌面持久化改主进程——desktop.json 取代 localStorage
3. 持久化全景精简——去掉 store / profiles / node.json，四分类保留
4. 数据模型去掉 node.json——appex.json 去掉 dependencies 字段（依赖在 package.json）
5. API 的 install/uninstall 改流程——不再提 profile / store / node.json
6. 应用开发指南加 package.json 一节——讲 pnpm 依赖怎么用
7. 明确不做列表补全——加"CAS store / profile 隔离 / DFS 拓扑 / 签名 / registry"
