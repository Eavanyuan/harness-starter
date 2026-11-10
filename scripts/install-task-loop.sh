#!/usr/bin/env bash
# task-loop 定时器安装器（T5）—— macOS launchd / Linux systemd user 单元，二选一自动识别。
#
# 用法：
#   bash scripts/install-task-loop.sh <目标仓库> [--interval 秒] [--print] [--uninstall] [--status]
#     --print      只渲染配置不安装（预览/自测）
#     --uninstall  卸载定时器（不动 .ai/task-loop 数据）
#     --status     显示定时器与 kill switch 状态
#
# 安全边界：凭据只从当前环境读并渲染进用户级配置（0600），绝不写进仓库；
# 安装前校验目标仓库 hook 接线（与 runner 同一道闸——不接 hook 的仓库不装）。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.harness.task-loop"
INTERVAL=180

usage_err() { echo "用法: bash scripts/install-task-loop.sh <目标仓库> [--interval 秒] [--print] [--uninstall] [--status]" >&2; exit 64; }

MODE="install"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) [ $# -ge 2 ] || usage_err; INTERVAL="$2"; shift 2 ;;
    --print) MODE="print"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --status) MODE="status"; shift ;;
    -*) usage_err ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[ "${#ARGS[@]}" -ge 1 ] || usage_err
ROOT="$(cd "${ARGS[0]}" && pwd)"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "未找到 node（硬前提，task-loop 全部 .mjs）" >&2; exit 69; }
SCRIPT="$HERE/task-loop.mjs"
[ -f "$SCRIPT" ] || { echo "未找到 $SCRIPT（应在 harness 仓库内运行）" >&2; exit 69; }

# 与 runner 相同的接线闸：目标仓库没有 hook 接线就不装——headless 会话会绕过全部写入门禁
if [ "$MODE" = "install" ] || [ "$MODE" = "print" ]; then
  if ! { [ -f "$ROOT/.zcode/config.json" ] || [ -f "$ROOT/.claude/settings.json" ]; }; then
    echo "目标仓库无 hook 接线（.zcode/config.json / .claude/settings.json）——先 build:hooks 再装" >&2
    exit 69
  fi
fi

LOGDIR="$HOME/.harness/task-loop"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="${LABEL/service/}.service"   # com.harness.task-loop.service
TIMER="${LABEL/service/}.timer"

render_plist() {
  sed -e "s|__LABEL__|${LABEL}|g" \
      -e "s|__NODE__|${NODE_BIN}|g" \
      -e "s|__SCRIPT__|${SCRIPT}|g" \
      -e "s|__ROOT__|${ROOT}|g" \
      -e "s|__INTERVAL__|${INTERVAL}|g" \
      -e "s|__LOGDIR__|${LOGDIR}|g" \
      -e "s|__GITLAB_URL__|${GITLAB_URL:-}|g" \
      -e "s|__GITLAB_TOKEN__|${GITLAB_TOKEN:-}|g" \
      -e "s|__FEISHU_MCP_URL__|${FEISHU_MCP_URL:-}|g" \
      "$HERE/../deploy/task-loop/launchd.plist.template"
}
render_service() {
  sed -e "s|__NODE__|${NODE_BIN}|g" -e "s|__SCRIPT__|${SCRIPT}|g" -e "s|__ROOT__|${ROOT}|g" \
      -e "s|__LOGDIR__|${LOGDIR}|g" \
      -e "s|__GITLAB_URL__|${GITLAB_URL:-}|g" -e "s|__GITLAB_TOKEN__|${GITLAB_TOKEN:-}|g" \
      -e "s|__FEISHU_MCP_URL__|${FEISHU_MCP_URL:-}|g" -e "s|__ENVFILE__|${LOGDIR}/task-loop.env|g" \
      "$HERE/../deploy/task-loop/systemd.service.template"
}
render_timer() {
  sed -e "s|__INTERVAL_SEC__|${INTERVAL}s|g" "$HERE/../deploy/task-loop/systemd.timer.template"
}

case "$MODE" in
  print)
    if [ "$(uname)" = "Darwin" ]; then render_plist; else { render_service; echo '---'; render_timer; }; fi
    exit 0 ;;
  status)
    if [ -e "$ROOT/.ai/task-loop/OFF" ]; then echo "kill switch: ON（OFF 哨兵存在，定时器空转）"; else echo "kill switch: off（运行中）"; fi
    if [ "$(uname)" = "Darwin" ]; then launchctl list 2>/dev/null | grep -q "$LABEL" && echo "launchd: loaded" || echo "launchd: not loaded"; \
      [ -f "$PLIST" ] && echo "plist: $PLIST"; \
    else systemctl --user is-active "$TIMER" 2>/dev/null || echo "systemd timer: not active"; fi
    exit 0 ;;
  uninstall)
    if [ "$(uname)" = "Darwin" ]; then launchctl unload "$PLIST" 2>/dev/null; rm -f "$PLIST"; echo "launchd 已卸载";
    else systemctl --user disable --now "$TIMER" 2>/dev/null; rm -f "$UNIT_DIR/$UNIT" "$UNIT_DIR/$TIMER"; systemctl --user daemon-reload 2>/dev/null; echo "systemd 已卸载"; fi
    exit 0 ;;
esac

mkdir -p "$LOGDIR"
if [ "$(uname)" = "Darwin" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  render_plist > "$PLIST" && chmod 600 "$PLIST"
  launchctl unload "$PLIST" 2>/dev/null; launchctl load "$PLIST"
  echo "已安装：$PLIST（每 ${INTERVAL}s 一轮，日志 $LOGDIR/task-loop.{out,err}）"
else
  mkdir -p "$UNIT_DIR"
  render_service > "$UNIT_DIR/$UNIT"; render_timer > "$UNIT_DIR/$TIMER"
  # 凭据建议走 EnvironmentFile（unit 文件全局可读）：有 env 就生成 0600 的 task-loop.env
  if [ -n "${GITLAB_TOKEN:-}" ]; then
    { [ -n "${GITLAB_URL:-}" ] && echo "GITLAB_URL=${GITLAB_URL}"; echo "GITLAB_TOKEN=${GITLAB_TOKEN}"; [ -n "${FEISHU_MCP_URL:-}" ] && echo "FEISHU_MCP_URL=${FEISHU_MCP_URL}"; } > "$LOGDIR/task-loop.env"
    chmod 600 "$LOGDIR/task-loop.env"
  fi
  systemctl --user daemon-reload && systemctl --user enable --now "$TIMER"
  echo "已安装：$UNIT_DIR/$TIMER（每 ${INTERVAL}s 一轮）"
fi
echo "停止：touch $ROOT/.ai/task-loop/OFF（kill switch）；彻底卸载：$0 <仓库> --uninstall"
