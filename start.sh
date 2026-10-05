#!/usr/bin/env bash
#
# RunX OS 启动脚本
# ----------------------------------------------------------------------------
# 作用：预置运行时状态（应用登记 / 桌面图标），启动 NavExt 内核（已改造的 RunX OS），
#       并拉起内置的「终端」应用。零运行时依赖，只需 Node.js（>=14，ctx.fetch 需 >=18）。
#
# 用法：
#   ./start.sh              # 前台运行，Ctrl+C 停止
#   PORT=8080 ./start.sh    # 指定端口
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3000}"
APP_PORT=3460
APP_CWD="$(cd "$ROOT/apps/term" && pwd)"

# 生成运行时状态目录
mkdir -p "$ROOT/var/runx"

# 1) 应用登记（绝对 cwd，避免 supervisor 找不到工作目录）
#    与 term/appex.json 保持一致；env 经 appex.json → os.spawn 透传。
cat > "$ROOT/var/runx/apps.json" <<EOF
{
  "schema": 1,
  "apps": [
    {
      "name": "term",
      "type": "node",
      "display_name": "终端",
      "icon": "icon.svg",
      "cmd": "node app.js",
      "cwd": "$APP_CWD",
      "port": $APP_PORT,
      "autostart": true,
      "restart": "on-failure",
      "restart_delay_ms": 1000,
      "restart_max": 5,
      "restart_window_ms": 60000,
      "data_dir": "data",
      "version": "1.0.0",
      "description": "RunX 真实交互式终端（script 伪 PTY + xterm.js，零原生依赖）",
      "installed_at": $(date +%s)000,
      "env": { "TERM_SHELL_ARGS": "--norc --noprofile" }
    }
  ]
}
EOF

# 2) 桌面布局（图标 / 壁纸 / 任务栏）
cat > "$ROOT/var/runx/desktop.json" <<'EOF'
{
  "schema": 1,
  "updated_at": 0,
  "wallpaper": { "type": "builtin", "id": "aurora" },
  "theme": "auto",
  "grid": { "cell": 96, "gap": 8 },
  "icons": [
    { "id": "term", "app": "term", "x": 1, "y": 1, "label": "终端" }
  ],
  "widgets": [],
  "taskbar": { "position": "bottom", "pinned": [], "show_clock": true }
}
EOF

# 端口占用检查
if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
    echo "✗ 端口 $PORT 已被占用，请换一个（PORT=xxxx ./start.sh）" >&2
    exit 1
  fi
fi

echo "▶ 启动 RunX OS 内核（端口 $PORT）…"

# 前台运行；Ctrl+C 一并停止内核
node "$ROOT/server.js" --root "$ROOT" --port "$PORT" --host 0.0.0.0 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null; exit 0' INT TERM

# 等待内核就绪（/runx/apps/term 返回 200 表示应用已登记）
for i in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/runx/apps/term"; then break; fi
  sleep 0.5
done

# 拉起终端应用（autostart 通常已在启动时拉起，这里做一次幂等兜底）
curl -s -X POST "http://127.0.0.1:$PORT/runx/apps/term/start" >/dev/null 2>&1 || true
sleep 1

echo ""
echo "✓ RunX OS 已就绪：  http://localhost:$PORT/"
echo "  终端应用：        http://localhost:$APP_PORT/"
echo "  按 Ctrl+C 停止。"
echo ""

wait "$SRV"
