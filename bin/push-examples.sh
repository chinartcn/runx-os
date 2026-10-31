#!/usr/bin/env bash
#
# bin/push-examples.sh
# ----------------------------------------------------------------------------
# 把 apps/ 下的示例应用（默认 demo）推送到一个独立的 GitHub 仓库，
# 作为应用商店的安装源。GitHub 不提供「单目录 tarball」，主仓库又太大，
# 所以示例单独开一个轻量仓库最干净。
#
# 前置：
#   · git 凭证里已存有 github.com 的 token（chinartcn，权限够建仓库），
#     或环境变量 GH_TOKEN 直接给。
#   · 需要 git / curl（本机命令，不走沙箱）。
#
# 用法：
#   EXAMPLE_REPO=runx-examples ./bin/push-examples.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE_REPO="${EXAMPLE_REPO:-runx-examples}"
GITHUB_USER="chinartcn"
WORKDIR="${EXAMPLE_WORKDIR:-apps}"   # 示例在仓库里的顶层目录名（与 runx-os 对齐，便于扩展）

# ── 取 token ────────────────────────────────────────────────────────────────
TOKEN="${GH_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | grep '^password=' | cut -d= -f2- || true)"
fi
[ -n "$TOKEN" ] || { echo "✗ 拿不到 GitHub token（设 GH_TOKEN 或配置 git credential）" >&2; exit 1; }

api() { curl -sS -H "Authorization: Bearer $TOKEN" -H 'accept: application/vnd.github+json' "$@"; }

# ── 1) 建仓库（已存在则用现成的） ───────────────────────────────────────────
echo "▶ 确保仓库 $GITHUB_USER/$EXAMPLE_REPO 存在"
if api -o /dev/null -w '%{http_code}' "https://api.github.com/repos/$GITHUB_USER/$EXAMPLE_REPO" | grep -q 200; then
  echo "  已存在，跳过创建"
else
  api -X POST -H 'content-type: application/json' \
    -d "{\"name\":\"$EXAMPLE_REPO\",\"description\":\"RunX OS 应用商店示例应用（独立轻量源）\",\"homepage\":\"https://store.rtcnnavext.de5.net\",\"private\":false,\"auto_init\":false,\"has_issues\":false,\"has_projects\":false}" \
    "https://api.github.com/user/repos" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  创建结果:", d.get("full_name") or d.get("message"))'
  # 等新仓库在 GitHub 那边就绪
  sleep 3
fi

# ── 2) 组装一个临时仓库并推送 ───────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/$WORKDIR"

# 复制示例应用（保持结构：appex.json / meta.json / app.js / public/ ...）
for app in demo pax-manager; do
  src="$ROOT/apps/$app"
  [ -d "$src" ] || { echo "✗ 找不到 $src" >&2; exit 1; }
  cp -R "$src" "$TMP/$WORKDIR/$app"
  # data/ 是运行时产物，不入库
  rm -rf "$TMP/$WORKDIR/$app/data"
done

# 顶层说明
cat > "$TMP/README.md" <<EOF
# RunX OS 示例应用

本仓库是 [RunX OS](https://www.rtcnnavext.de5.net) 应用商店的**独立安装源**，
每个子目录是一个可直接安装的应用：

- \`$WORKDIR/demo\` —— 文件授权 / 监听 / 流式读取 / 进程 / 剪贴板 / @runx-ui 组件库
- \`$WORKDIR/pax-manager\` —— PaX 包管理器：装 / 卸 / 更新本机应用

商店安装时按 \`subdir: $WORKDIR/<应用名>\` 定位包内应用。
EOF

cd "$TMP"
git init -q
git checkout -q -b main
git add -A
git -c user.email="dev@runx.local" -c user.name="RunX" commit -q -m "chore: 初始化示例应用仓库"
git remote add origin "https://$GITHUB_USER:$TOKEN@github.com/$GITHUB_USER/$EXAMPLE_REPO.git"
git push -u -f origin main

echo "✓ 已推送到 https://github.com/$GITHUB_USER/$EXAMPLE_REPO"
echo "  商店里 demo 的 source 应指向："
echo "    url:      https://github.com/$GITHUB_USER/$EXAMPLE_REPO"
echo "    download: https://github.com/$GITHUB_USER/$EXAMPLE_REPO/archive/refs/heads/main.tar.gz"
echo "    subdir:   $WORKDIR/demo"
