#!/usr/bin/env bash
#
# RunX OS 启动脚本
# ----------------------------------------------------------------------------
# 作用：预置运行时状态（应用登记 / 桌面图标），启动 NavExt 内核（已改造的 RunX OS），
#       并拉起内置的「终端」应用。零运行时依赖，只需 Node.js（>=14，ctx.fetch 需 >=18）。
#
# 用法：
#   ./start.sh              # 前台运行 + 守护重启，Ctrl+C 停止
#   PORT=8080 ./start.sh    # 指定端口
#   NO_GUARD=1 ./start.sh   # 关掉守护重启（内核挂了就退出，便于调试/看崩溃栈）
#
# 守护重启（RUNX_GUARD，默认开）：
#   内核进程非正常退出时自动拉起，并做**指数退避**：连续崩溃越快，重启间隔越长
#   （1s → 2s → 4s → … 封顶 30s），避免「一启动就崩」时把 CPU 打满、日志刷爆。
#   只要内核稳定运行超过 STABLE_SECS（30s），退避计数就归零 —— 也就是偶发崩溃
#   不会累积惩罚，只有**连续快速崩溃**才升级退避。
#   连续崩溃超过 MAX_CRASH（6 次）且从没稳定过 → 判定为配置/环境问题，
#   停止重启并给出排查提示，而不是无意义地空转。
#   Ctrl+C（SIGINT）视为「用户主动停止」，不触发重启。
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3000}"
APP_PORT=3460
APP_CWD="$(cd "$ROOT/apps/term" && pwd)"

# 守护重启参数（可用环境变量覆盖）
NO_GUARD="${NO_GUARD:-0}"
STABLE_SECS="${STABLE_SECS:-30}"
MAX_CRASH="${MAX_CRASH:-6}"
BACKOFF_BASE="${BACKOFF_BASE:-1}"
BACKOFF_MAX="${BACKOFF_MAX:-30}"

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }

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
#    注意：不要覆盖已存在的 desktop.json —— 客户端会把图标位置、主题、壁纸
#    以及**窗口几何**写回这里，每次启动都重写等于把用户的桌面布局清空。
if [ ! -f "$ROOT/var/runx/desktop.json" ]; then
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
  "taskbar": { "position": "bottom", "pinned": [], "show_clock": true },
  "windows": []
}
EOF
fi

# 端口占用检查
if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
    echo "✗ 端口 $PORT 已被占用，请换一个（PORT=xxxx ./start.sh）" >&2
    echo "  查看占用者：ss -ltnp | grep :$PORT" >&2
    exit 1
  fi
fi

# ── 单次启动内核 + 就绪等待 ────────────────────────────────────────────────
# 返回：内核退出码（0 = 正常退出）
boot_kernel() {
  node "$ROOT/server.js" --root "$ROOT" --port "$PORT" --host 0.0.0.0 &
  SRV=$!

  # 等待内核就绪（/runx/apps/term 返回 200 表示应用已登记）
  local ok=0
  for _ in $(seq 1 40); do
    # 内核已经死了就不用再等了
    if ! kill -0 "$SRV" 2>/dev/null; then return 1; fi
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/runx/apps/term"; then ok=1; break; fi
    sleep 0.5
  done

  if [ "$ok" = 1 ]; then
    # 拉起终端应用（autostart 通常已在启动时拉起，这里做一次幂等兜底）
    curl -s -X POST "http://127.0.0.1:$PORT/runx/apps/term/start" >/dev/null 2>&1 || true
    echo ""
    echo "✓ RunX OS 已就绪：  http://localhost:$PORT/"
    echo "  终端应用：        http://localhost:$APP_PORT/"
    echo "  按 Ctrl+C 停止。"
    echo ""
  else
    log "⚠ 内核启动后未在 20s 内就绪（可能仍在初始化，也可能是端口/权限问题）"
    # 不直接判死：内核可能只是慢。继续守着它，由下面的 wait 决定后续。
  fi

  # ⚠ 这里**不能**直接 `wait "$SRV"`。
  #   bash 的 trap 要等当前前台命令返回才执行，而 `wait` 会一直阻塞到子进程退出 ——
  #   Ctrl+C 发出 SIGINT 后 trap 不跑，看起来像「按了没反应」，得再按一次。
  #   也不能用 `wait "$SRV" &`：放到后台就等于在**子 shell** 里 wait，而 $SRV 不是
  #   那个子 shell 的孩子，会报 "is not a child of this shell"。
  #   正确做法：主 shell 自己用 `sleep` 短轮询探活 —— sleep 是前台命令、能立刻被
  #   信号打断，trap 于是实时生效；探到子进程没了再用 `wait` 收尸拿退出码。
  while kill -0 "$SRV" 2>/dev/null; do
    sleep 0.3
  done
  wait "$SRV" 2>/dev/null
  return $?
}

# ── 主流程：带守护重启的运行循环 ──────────────────────────────────────────
STOPPING=0
CRASHES=0
BACKOFF="$BACKOFF_BASE"

on_signal() {
  STOPPING=1
  log "▶ 收到停止信号，正在关闭内核…"
  if [ -n "${SRV:-}" ] && kill -0 "$SRV" 2>/dev/null; then
    kill "$SRV" 2>/dev/null
    # 给它 5s 优雅退出，超时再强杀
    for _ in $(seq 1 10); do
      kill -0 "$SRV" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$SRV" 2>/dev/null && kill -9 "$SRV" 2>/dev/null
  fi
  exit 0
}
trap on_signal INT TERM

log "▶ 启动 RunX OS 内核（端口 $PORT）…"

while :; do
  STARTED_AT=$(date +%s)
  boot_kernel
  CODE=$?
  ELAPSED=$(( $(date +%s) - STARTED_AT ))

  # 用户主动停止（trap 里已置位并关停内核）
  [ "$STOPPING" = 1 ] && exit 0

  # 正常退出（退出码 0）：视为「内核自己决定结束」，不重启
  if [ "$CODE" = 0 ]; then
    log "✓ 内核已正常退出（运行 ${ELAPSED}s），不再重启。"
    exit 0
  fi

  log "✗ 内核异常退出（退出码 $CODE，运行 ${ELAPSED}s）"

  if [ "$NO_GUARD" = 1 ]; then
    log "  NO_GUARD=1，不重启。"
    exit "$CODE"
  fi

  # 稳定运行够久 → 退避归零，这次崩溃算偶发
  if [ "$ELAPSED" -ge "$STABLE_SECS" ]; then
    CRASHES=0
    BACKOFF="$BACKOFF_BASE"
  else
    CRASHES=$((CRASHES + 1))
  fi

  # 连续快速崩溃且从没稳定过 → 停手，别空转
  if [ "$CRASHES" -gt "$MAX_CRASH" ]; then
    log "✗ 连续崩溃 $CRASHES 次（每次都在 ${STABLE_SECS}s 内），已停止重启。"
    log "  排查建议："
    log "    · 直接看崩溃栈：NO_GUARD=1 ./start.sh"
    log "    · 端口是否被占：ss -ltnp | grep :$PORT"
    log "    · 运行时状态是否损坏：rm -rf var/runx && ./start.sh"
    exit "$CODE"
  fi

  log "  ${BACKOFF}s 后重启（第 $CRASHES/$MAX_CRASH 次）…"
  # 退避期间也要能被 Ctrl+C 打断
  for _ in $(seq 1 "$((BACKOFF * 2))"); do
    [ "$STOPPING" = 1 ] && exit 0
    sleep 0.5
  done

  # 指数退避，封顶 BACKOFF_MAX
  NEXT=$((BACKOFF * 2))
  [ "$NEXT" -gt "$BACKOFF_MAX" ] && NEXT="$BACKOFF_MAX"
  BACKOFF="$NEXT"

  # 重启前确认端口已释放（上一实例可能还在 TIME_WAIT/僵死）
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PORT "; then
    log "  端口 $PORT 仍被占用，等待释放…"
    for _ in $(seq 1 20); do
      ss -ltn 2>/dev/null | grep -q ":$PORT " || break
      sleep 0.5
    done
  fi

  log "▶ 重新启动内核…"
done
