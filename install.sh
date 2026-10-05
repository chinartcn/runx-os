#!/usr/bin/env bash
#
# RunX OS 一键安装
# ----------------------------------------------------------------------------
# 用法：
#   bash install.sh                 # 装到 ~/runx-os 并启动
#   bash install.sh /opt/runx-os    # 指定目录
#   curl -fsSL https://raw.githubusercontent.com/chinartcn/runx-os/main/install.sh | bash
#
# 国内网络友好：会依次尝试「直连 GitHub → 多个加速镜像」；克隆失败还会自动
# 回退到 tarball 下载（无需 git）。已存在仓库则原地更新。
#
# 环境变量：
#   RUNX_MIRROR=<url 前缀|off>   只用一个指定源（off = 仅直连），跳过自动探测
#   RUNX_BRANCH=<分支>           默认 main
#
# 依赖：Node.js（>=14，ctx.fetch 需 >=18）、bash；git 或 curl 二选一即可
#
set -euo pipefail

REPO="chinartcn/runx-os"
BRANCH="${RUNX_BRANCH:-main}"
TARGET="${1:-$HOME/runx-os}"

# 克隆用的镜像前缀（会拼成 <前缀>https://github.com/...）
MIRRORS=(
  "https://gh-proxy.org/"
  "https://ghproxy.net/"
  "https://ghfast.top/"
)
# tarball 直连源（无 git 时兜底）
CODELOAD="https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"

# ── 0) 依赖检查 ──────────────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1; }
has_git=false; has_curl=false
need git && has_git=true
need curl && has_curl=true

if [ "$has_git" = false ] && [ "$has_curl" = false ]; then
  echo "✗ 需要 git 或 curl 其中之一" >&2
  exit 1
fi
if ! need node; then
  echo "✗ 缺少依赖：node" >&2
  exit 1
fi

NODE_VER="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
NODE_MAJOR="$(printf '%s' "$NODE_VER" | cut -d. -f1)"
if [ "${NODE_MAJOR:-0}" -lt 14 ]; then
  echo "✗ Node.js 版本过低（$NODE_VER），RunX OS 需要 >= 14（ctx.fetch 需 >= 18）" >&2
  exit 1
fi

# 若用户显式指定了单一镜像，则只用它（跳过直连与其它镜像）
DIRECT=true
if [ -n "${RUNX_MIRROR:-}" ]; then
  if [ "$RUNX_MIRROR" = "off" ]; then
    MIRRORS=()                       # 仅直连
  else
    MIRRORS=("$RUNX_MIRROR")         # 仅指定源
    DIRECT=false                     # 不再先试直连
  fi
fi

# ── 1) 已存在则原地更新 ──────────────────────────────────────────────────
if [ -d "$TARGET/.git" ]; then
  echo "▶ 更新已有仓库：$TARGET"
  ( cd "$TARGET" && git -c http.version=HTTP/1.1 pull --ff-only ) || true
  exec bash "$TARGET/start.sh"
fi

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t runx)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ── 2) 依次尝试各源 ──────────────────────────────────────────────────────
clone_ok=false

try_git_clone() {
  local name="$1" url="$2"
  local dest="$TMP/repo"
  rm -rf "$dest"
  printf '  · 尝试 %s …' "$name"
  if timeout 90 git -c http.version=HTTP/1.1 clone --depth 1 "$url" "$dest" >/dev/null 2>&1; then
    printf ' OK\n'
    mv "$dest" "$TARGET"
    clone_ok=true
    return 0
  fi
  printf ' 失败\n'
  return 1
}

if [ "$has_git" = true ]; then
  echo "▶ 获取源码（依次尝试直连与镜像）"
  if [ "$DIRECT" = true ]; then
    try_git_clone "直连 github.com" "https://github.com/$REPO.git" || true
  fi
  if [ "$clone_ok" = false ]; then
    for m in "${MIRRORS[@]}"; do
      try_git_clone "$m" "${m}https://github.com/$REPO.git" && break
    done
  fi
fi

# git 全部失败（或没有 git）→ 回退 tarball
if [ "$clone_ok" = false ] && [ "$has_curl" = true ]; then
  echo "▶ git 克隆失败，回退 tarball 下载（无需 git）"
  TAR_URLS=("$CODELOAD")
  for m in "${MIRRORS[@]}"; do
    TAR_URLS+=("${m}https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz")
  done
  for u in "${TAR_URLS[@]}"; do
    printf '  · 下载 %s …' "${u%%/archive*}"
    if curl -fsSL --retry 2 --connect-timeout 15 -m 180 "$u" -o "$TMP/src.tar.gz" 2>/dev/null \
       && tar -xzf "$TMP/src.tar.gz" -C "$TMP" 2>/dev/null; then
      # 解压后目录名为 runx-os-<branch>
      src="$(find "$TMP" -maxdepth 1 -mindepth 1 -type d ! -name repo | head -1)"
      if [ -n "$src" ] && [ -f "$src/start.sh" ]; then
        printf ' OK\n'
        mv "$src" "$TARGET"
        clone_ok=true
        break
      fi
    fi
    printf ' 失败\n'
  done
fi

if [ "$clone_ok" = false ]; then
  echo "" >&2
  echo "✗ 所有源均失败。可尝试：" >&2
  echo "    · 指定镜像：  RUNX_MIRROR=https://gh-proxy.org/ bash install.sh" >&2
  echo "    · 或手动克隆后运行： git clone <镜像URL> $TARGET && $TARGET/start.sh" >&2
  exit 1
fi

echo "✓ 源码已就绪：$TARGET"

# ── 3) 启动 ──────────────────────────────────────────────────────────────
cd "$TARGET"
exec bash "$TARGET/start.sh"
