// @runx/sdk 类型声明
export type Code =
  | 'ENOTRUNX' | 'EPERM' | 'NEED_ADMIN' | 'ENOUI' | 'ETIMEDOUT'
  | 'ENOENT' | 'EINVAL' | 'ETOOBIG' | 'EISDIR' | 'ENETWORK' | 'ENOUSER';

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
export interface ProcStatus { pid: number; known: boolean; running?: boolean; stdout?: string; stderr?: string; exit?: { code: number | null; signal: string | null } | null }
export interface FetchResult { status: number; headers: Record<string, string | string[]>; content: string; truncated: boolean; url: string }

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
  };
  proc: {
    spawn(argv: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<{ pid: number; cwd: string }>;
    status(pid: number): Promise<ProcStatus>;
    kill(pid: number, signal?: string): Promise<{ pid: number; ok: boolean }>;
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
