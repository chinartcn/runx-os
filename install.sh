#!/usr/bin/env bash
#
# RunX OS 一键安装
# ----------------------------------------------------------------------------
# 用法：
#   bash install.sh                 # 装到 ~/runx-os 并启动
#   bash install.sh /opt/runx-os    # 指定目录
#   curl -fsSL https://raw.githubusercontent.com/chinartcn/runx-os/main/install.sh | bash
#
# 依赖：git、Node.js（>=14，ctx.fetch 需 >=18）、bash
#
set -euo pipefail

REPO="chinartcn/runx-os"
REPO_URL="https://github.com/$REPO.git"
TARGET="${1:-$HOME/runx-os}"

# 0) 依赖检查
need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ 缺少依赖：$1" >&2; exit 1; }; }
need git
need node
need curl

NODE_VER="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
NODE_MAJOR="$(printf '%s' "$NODE_VER" | cut -d. -f1)"
if [ "${NODE_MAJOR:-0}" -lt 14 ]; then
  echo "✗ Node.js 版本过低（$NODE_VER），RunX OS 需要 >= 14（ctx.fetch 需 >= 18）" >&2
  exit 1
fi

# 1) 获取源码（已存在则更新）
if [ -d "$TARGET/.git" ]; then
  echo "▶ 更新已有仓库：$TARGET"
  git -C "$TARGET" pull --ff-only || true
else
  echo "▶ 克隆 $REPO_URL → $TARGET"
  git clone --depth 1 "$REPO_URL" "$TARGET"
fi

# 2) 启动
cd "$TARGET"
exec bash "$TARGET/start.sh"
