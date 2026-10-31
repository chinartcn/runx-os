// @runx/sdk 类型声明
import type { Readable, Writable } from 'stream';

export type Code =
  | 'ENOTRUNX' | 'EPERM' | 'NEED_ADMIN' | 'ENOUI' | 'ETIMEDOUT'
  | 'ENOENT' | 'EINVAL' | 'ETOOBIG' | 'EISDIR' | 'ENETWORK' | 'ENOUSER'
  | 'ENOSYS' | 'ECLOSED';

export interface Risk { level: 'low' | 'medium' | 'high'; why: string }
export interface Detail { cap?: string; target?: string; app?: string; risk?: Risk; decision?: string }

export declare class RunXError extends Error {
  code: Code | string;
  status?: number;
  detail?: Detail | null;
}

export interface ReadResult { path: string; content: string; encoding: 'utf8' | 'base64'; size: number; mtime: number }
export interface ListEntry { name: string; type: 'file' | 'dir' | 'link'; size: number; mtime: number }
export interface StatResult { path: string; exists: boolean; type?: 'file' | 'dir' | 'link' | 'other'; size?: number; mtime?: number; mode?: string }

/** 一块数据。data 永远是 base64 —— 分块边界会切断多字节字符 */
export interface RangeReadResult {
  path: string;
  offset: number;      // 这一块从哪开始
  bytes: number;       // 这一块多少字节
  size: number;        // 文件总大小
  eof: boolean;
  data: string;        // base64
  mtime: number;
}

export interface RangeWriteResult { path: string; offset: number; bytes: number; size: number }

export interface WatchEvent { event: 'change' | 'rename'; name: string | null; at: number; seq: number }

export interface Watcher {
  /** 内核里的监听 id；`ready` 兑现前是 null */
  id: string | null;
  path: string;
  /** 兑现成 `{id, path, is_dir}`；失败时 reject（没权限、路径不存在） */
  ready: Promise<{ id: string; path: string; is_dir: boolean }>;
  /** 关掉监听。可以调用多次 */
  close(): Promise<{ closed: boolean }>;
  closed: boolean;
}

export interface ProcStatus {
  pid: number;
  known: boolean;
  running?: boolean;
  stdout?: string;
  stderr?: string;
  exit?: { code: number | null; signal: string | null } | null;
  /** stdin 管道还开着吗；spawn 时没要 stdin 就是 false */
  stdin?: boolean;
  stdin_error?: string | null;
}

export interface ProcRunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface FetchResult { status: number; headers: Record<string, string | string[]>; content: string; truncated: boolean; url: string }

/** 三种对话框共有的部分。`cancelled` 表示用户按了取消 / 关掉了框 */
export interface DialogBase { cancelled: boolean; via?: string; risk?: Risk }

export interface DialogFileResult extends DialogBase {
  /** 选中的第一个路径（多个时用它，全部在 paths 里） */
  path?: string;
  paths?: string[];
  /** 内核刚记下的授权 id（高危路径不会自动授权，此时为空） */
  granted?: string[];
}

export interface DialogMessageResult extends DialogBase {
  /** 用户点的那个按钮的 id */
  value?: string;
}

export interface DialogButton { id: string; label: string; kind?: 'primary' | 'destructive' | 'plain' }

export interface ClipboardReadResult {
  text: string;
  empty: boolean;
  at: number;
  size: number;
  source?: string;
}

declare const rx: {
  RunXError: typeof RunXError;
  enabled: boolean;
  app: Readonly<{ name: string; port: number; dataDir: string; gateway: string; user: string }>;
  call<T = any>(area: string, op: string, params?: object, opts?: { timeout?: number }): Promise<T>;

  fs: {
    read(path: string, opts?: { encoding?: 'utf8' | 'base64' }): Promise<ReadResult>;
    write(path: string, content: string, opts?: { encoding?: 'utf8' | 'base64'; append?: boolean }): Promise<{ path: string; size: number; created: boolean }>;
    list(path: string): Promise<{ path: string; entries: ListEntry[] }>;
    stat(path: string): Promise<StatResult>;
    mkdir(path: string, opts?: { parents?: boolean }): Promise<{ path: string }>;
    remove(path: string, opts?: { recursive?: boolean }): Promise<{ path: string; removed: true }>;
    copy(from: string, to: string, opts?: { recursive?: boolean }): Promise<{ from: string; to: string }>;
    move(from: string, to: string): Promise<{ from: string; to: string; moved: true }>;

    /** 单块读取。length 上限 1MB */
    readRange(path: string, opts?: { offset?: number; length?: number }): Promise<RangeReadResult>;
    /** 单块写入。`{truncate:true}` 覆盖、`{append:true}` 追加、`{offset:n}` 定位写 */
    writeRange(path: string, data: string, opts?: { encoding?: 'base64'; offset?: number; append?: boolean; truncate?: boolean }): Promise<RangeWriteResult>;

    /** 大文件读：Node Readable，可 pipe / for await / setEncoding('utf8') */
    createReadStream(path: string, opts?: { highWaterMark?: number; start?: number; end?: number }): Readable & { size(): Promise<number> };
    /** 大文件写：Node Writable，内部串行按 offset 写 */
    createWriteStream(path: string, opts?: { highWaterMark?: number; append?: boolean }): Writable;

    /** 监听文件/目录。事件靠长轮询取，不需要 WebSocket */
    watch(path: string, onEvent?: (e: WatchEvent) => void, opts?: { onError?: (e: Error) => void }): Watcher;
    /** 只等一次变化 */
    waitChange(path: string, timeoutMs?: number): Promise<WatchEvent>;
  };

  proc: {
    /** `stdin:true` 才建输入管道；否则子进程的 stdin 是 /dev/null */
    spawn(argv: string[], opts?: { cwd?: string; env?: Record<string, string>; stdin?: boolean }): Promise<{ pid: number; cwd: string }>;
    /** 喂一段输入（单次 ≤64KB）。默认按 utf8 发送 */
    write(pid: number, data: string | Buffer, opts?: { encoding?: 'utf8' | 'base64' }): Promise<{ pid: number; bytes: number }>;
    /** 关掉 stdin（发 EOF）。`cat` 这类命令靠这个结束 */
    end(pid: number): Promise<{ pid: number; closed: boolean }>;
    status(pid: number): Promise<ProcStatus>;
    kill(pid: number, signal?: string): Promise<{ pid: number; ok: boolean }>;
    /** 起 → 喂 → EOF → 等 → 收，一次做完 */
    run(argv: string[], opts?: { input?: string | Buffer; cwd?: string; timeoutMs?: number }): Promise<ProcRunResult>;
  };

  dialog: {
    /** 路径由用户在桌面上点出来 —— 应用不能指定 */
    open(opts?: { title?: string; filters?: string[]; multiple?: boolean; startIn?: string }): Promise<DialogFileResult>;
    save(opts?: { title?: string; defaultName?: string; filters?: string[]; startIn?: string }): Promise<DialogFileResult>;
    message(opts?: { title?: string; message?: string; buttons?: DialogButton[] }): Promise<DialogMessageResult>;
    /** 确认框：取消也算 false */
    confirm(title?: string, message?: string): Promise<boolean>;
    alert(title?: string, message?: string): Promise<DialogMessageResult>;
  };

  clipboard: {
    read(): Promise<ClipboardReadResult>;
    /** 上限 256KB */
    write(text: string): Promise<{ seq: number; size: number; at: number }>;
  };

  net: {
    fetch(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchResult>;
  };

  sys: {
    info(): Promise<{
      platform: string; arch: string; node: string; hostname: string; cpus: number;
      memory: { total: number; free: number }; uptime_s: number; homedir: string;
      app: { name: string; cwd: string; data?: string };
    }>;
  };
};

export = rx;
