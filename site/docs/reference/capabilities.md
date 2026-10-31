---
title: 能力清单
---

# 能力清单

能力是一段字符串，格式 `能力` 或 `能力:范围`。

## 全部 14 个

| 能力 | 范围 | 风险 | 说明 |
|---|---|---|---|
| `fs.read` | glob | 低 | 读文件内容 |
| `fs.list` | glob | 低 | 列目录 |
| `fs.stat` | glob | 低 | 取元数据 |
| `fs.watch` | glob | 低 | 监听文件变化 |
| `fs.write` | glob | 中 | 写文件 |
| `fs.mkdir` | glob | 中 | 建目录 |
| `fs.remove` | glob | 中 | 删除 |
| `fs.copy` | glob | 中 | 复制 / 移动 |
| `proc.spawn` | 可执行文件路径 | 高 | 起子进程 |
| `net.fetch` | 主机名 | 中 | 联网 |
| `sys.info` | — | 低 | 读系统信息 |
| `dialog.open` | — | 低 | 文件选择器 / 保存框 / 消息框 |
| `clipboard.read` | — | 中 | 读剪贴板 |
| `clipboard.write` | — | 低 | 写剪贴板 |

## 读能力家族

```text
fs.read  ─┐
fs.list  ─┼─→ 一条 fs.read:/data/** 全部覆盖
fs.stat  ─┤
fs.watch ─┘
```

`fs.write` / `fs.mkdir` / `fs.remove` / `fs.copy` **不在**家族里 ——
写是写，读是读，审批粒度不该混。

## 范围语法

| 写法 | 含义 |
|---|---|
| `fs.read:/sdcard/**` | `/sdcard` 之下全部 |
| `fs.read:/sdcard/Documents/*.md` | 只这一层 |
| `fs.read:/sdcard/Documents/**` | 递归 |
| `fs.read:./**` | 应用目录整体 |
| `proc.spawn:/usr/bin/tr` | 只有这个可执行文件 |
| `net.fetch:api.example.com` | 只有这个主机 |

## 错误码

| code | 含义 |
|---|---|
| `ENOTRUNX` | 不在 RunX 里 |
| `EPERM` | 用户拒绝了，或没有授权且没人可问 |
| `NEED_ADMIN` | 高危操作，需要先开管理员模式 |
| `ENOUI` | 桌面没开，没人能批准 |
| `ETIMEDOUT` | 等待审批超时（默认 100 秒） |
| `ENOENT` `EINVAL` `ETOOBIG` `EISDIR` | 常规错误 |

`err.detail` 里带 `{cap, target, risk, app}` —— 足够画一个「去授权」的提示。

## 风险判定在哪看

`.js/@runx-rights-manager/grants.js` 里的 `assess()`。
每一档的理由都写在代码里 —— 改风险等级时先读那段注释。
