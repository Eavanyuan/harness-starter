#!/usr/bin/env bash
# task-loop 定时器安装器（T5）—— macOS launchd / Linux systemd user 单元，二选一自动识别。
#
# 用法：
#   bash scripts/install-task-loop.sh <目标仓库> [--interval 秒] [--print] [--no-activate] [--uninstall] [--status]
#     --print        只渲染配置不安装（预览/自测）
#     --no-activate  写入单元与凭据文件，但不 launchctl load / systemctl enable（测试与 CI 用：
#                    测试要验证落盘与权限，不该顺手在跑测试的机器上注册一个真定时器）
#     --uninstall    卸载定时器（不动 .ai/task-loop 数据）
#     --status       显示定时器与 kill switch 状态
#
# 安全边界：凭据只从当前环境读，写进用户级 0600 文件；**plist / unit 里不含任何秘密**——
# 它们是明文配置，会被 `launchctl print` / `systemctl cat` 打印出来。安装前校验目标仓库
# hook 接线（与 runner 同一道闸——不接 hook 的仓库不装）。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.harness.task-loop"
INTERVAL=180

usage_err() { echo "用法: bash scripts/install-task-loop.sh <目标仓库> [--interval 秒] [--print] [--no-activate] [--uninstall] [--status]" >&2; exit 64; }

MODE="install"
ACTIVATE=1
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) [ $# -ge 2 ] || usage_err; INTERVAL="$2"; shift 2 ;;
    --print) MODE="print"; shift ;;
    --no-activate) ACTIVATE=0; shift ;;
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
[ -f "$SCRIPT" ] || { echo "未找到 ${SCRIPT}（应在 harness 仓库内运行）" >&2; exit 69; }

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

# 凭据落点：0600 的 env 文件 + 0700 的包装脚本。plist / unit 本身**不含任何秘密**。
CRED_FILE="$LOGDIR/task-loop.env"
WRAPPER="$LOGDIR/run-round.sh"

render_plist() {
  sed -e "s|__LABEL__|${LABEL}|g" \
      -e "s|__ROOT__|${ROOT}|g" \
      -e "s|__INTERVAL__|${INTERVAL}|g" \
      -e "s|__LOGDIR__|${LOGDIR}|g" \
      -e "s|__WRAPPER__|${WRAPPER}|g" \
      "$HERE/../deploy/task-loop/launchd.plist.template"
}
render_service() {
  sed -e "s|__ROOT__|${ROOT}|g" \
      -e "s|__LOGDIR__|${LOGDIR}|g" \
      -e "s|__WRAPPER__|${WRAPPER}|g" \
      "$HERE/../deploy/task-loop/systemd.service.template"
}
render_timer() {
  sed -e "s|__INTERVAL_SEC__|${INTERVAL}s|g" "$HERE/../deploy/task-loop/systemd.timer.template"
}

# 只更新给定的这一个键，其余行原样保留——用户可能在这个文件里手加了 HARNESS_* 之类，
# 整体重写会把它们抹掉。写临时文件再 mv，避免中途失败留下半个文件（半个文件 = token 截断，
# 症状是 401，而日志里只有"认证失败"，看不出是文件被写坏了）。
env_upsert() {
  local k="$1" v="$2" tmp
  tmp="$(mktemp "${CRED_FILE}.XXXXXX")" || return 1
  if [ -f "$CRED_FILE" ]; then grep -v "^${k}=" "$CRED_FILE" > "$tmp"; else : > "$tmp"; fi
  printf '%s=%s\n' "$k" "$v" >> "$tmp"
  mv "$tmp" "$CRED_FILE" && chmod 600 "$CRED_FILE"
}

# 统一凭据写入口（两个平台都走这里）。
# 没有提供的键不覆盖已有值：重装定时器不应该把上次配好的 token 清掉。
write_creds() {
  mkdir -p "$LOGDIR"; chmod 700 "$LOGDIR"
  local wrote=""
  [ -n "${GITLAB_URL:-}" ] && { env_upsert GITLAB_URL "$GITLAB_URL" && wrote="$wrote url"; }
  [ -n "${GITLAB_TOKEN:-}" ] && { env_upsert GITLAB_TOKEN "$GITLAB_TOKEN" && wrote="$wrote token"; }
  [ -n "${FEISHU_MCP_URL:-}" ] && { env_upsert FEISHU_MCP_URL "$FEISHU_MCP_URL" && wrote="$wrote mcpUrl"; }
  [ -n "$wrote" ] && echo "凭据已写入 ${CRED_FILE}（0600）：${wrote# }"
  return 0
}

# launchd 的 plist 与 systemd 的 unit 都是会被 `launchctl print` / `systemctl cat` 打印出来的
# 明文配置，把 token 渲染进去等于把口令落在一份"谁都能看"的文件里。所以真正的执行入口是这个
# 脚本：它把 0600 的 env 读进环境再 exec，plist/unit 只负责说"用 bash 跑它"。
# 换 token = 改 env 文件；不用重装定时器（重装会丢 launchctl 的已加载状态）。
write_wrapper() {
  local body
  body="$(cat <<EOF
#!/usr/bin/env bash
# 由 install-task-loop.sh 生成——请勿手改，改凭据改 ${CRED_FILE}。
# 为什么要有这一层：plist / unit 是明文配置，token 不能写在里面。
set -a
[ -f "${CRED_FILE}" ] && . "${CRED_FILE}"
set +a
export HARNESS_LEDGER_DIR="${LOGDIR}"
cd "${ROOT}" || exit 69
exec "${NODE_BIN}" "${SCRIPT}" --once --root "${ROOT}"
EOF
)"
  if [ "${1:-}" = "--preview" ]; then printf '%s\n' "$body"; return 0; fi
  printf '%s\n' "$body" > "$WRAPPER" && chmod 700 "$WRAPPER"
}

case "$MODE" in
  print)
    if [ "$(uname)" = "Darwin" ]; then render_plist; else { render_service; echo '---'; render_timer; }; fi
    # 凭据不进渲染结果，只印落点与真实执行体——--print 的输出经常被贴进 issue/日志
    echo "---"
    echo "# 凭据文件（安装时写入，0600）：$CRED_FILE"
    echo "# 定时器实际执行：/bin/bash $WRAPPER"
    write_wrapper --preview
    exit 0 ;;
  status)
    if [ -e "$ROOT/.ai/task-loop/OFF" ]; then echo "kill switch: ON（OFF 哨兵存在，定时器空转）"; else echo "kill switch: off（运行中）"; fi
    if [ "$(uname)" = "Darwin" ]; then launchctl list 2>/dev/null | grep -q "$LABEL" && echo "launchd: loaded" || echo "launchd: not loaded"; \
      [ -f "$PLIST" ] && echo "plist: $PLIST"; \
    else systemctl --user is-active "$TIMER" 2>/dev/null || echo "systemd timer: not active"; fi
    # 凭据文件被手改成全局可读是很容易发生的（cp/rsync 都保留不了权限），顺手查一下。
    # 用 stat 而不是 `ls -l | cut`：macOS 的 ls 在带 ACL/xattr 时会在权限位后追加 +/@，
    # 按列截断会错位，把 0600 读成"过宽"或者反过来。
    if [ -f "$CRED_FILE" ]; then
      if [ "$(uname)" = "Darwin" ]; then mode="$(stat -f %Lp "$CRED_FILE")"; else mode="$(stat -c %a "$CRED_FILE")"; fi
      case "$mode" in
        600) echo "凭据文件: ${CRED_FILE}（0600）" ;;
        *) echo "凭据文件权限过宽: ${CRED_FILE}（${mode}）——同机其他用户可读，执行 chmod 600 修" ;;
      esac
    else echo "凭据文件不存在（未接入任何源，或尚未配置）：$CRED_FILE"; fi
    exit 0 ;;
  uninstall)
    if [ "$(uname)" = "Darwin" ]; then launchctl unload "$PLIST" 2>/dev/null; rm -f "$PLIST"; echo "launchd 已卸载";
    else systemctl --user disable --now "$TIMER" 2>/dev/null; rm -f "$UNIT_DIR/$UNIT" "$UNIT_DIR/$TIMER"; systemctl --user daemon-reload 2>/dev/null; echo "systemd 已卸载"; fi
    rm -f "$WRAPPER"
    echo "已移除包装脚本；凭据保留在 ${CRED_FILE}（不想留就 rm 它）"
    exit 0 ;;
esac

# 旧版（≤5a6fa41 之前的安装器）把 GITLAB_TOKEN 直接渲染进 plist / unit。这两个文件虽然是
# 0600，但会被 `launchctl print`、`systemctl cat`、以及各种"贴配置求助"的动作带出去。
# 本次安装会重建成不含凭据的版本，但**已经泄露过的那份 token 不会因为重写而失效**。
warn_legacy_secret() {
  local old="$1"
  [ -f "$old" ] || return 0
  if grep -qE "GITLAB_TOKEN|FEISHU_MCP_URL" "$old" 2>/dev/null; then
    {
      echo "注意：$old 里含有明文凭据（旧版安装器写进去的），本次已重建为不含凭据的版本。"
      echo "      token 本身不会因此失效——若该文件曾被备份/同步/贴出，去 GitLab 撤销并重建该 token。"
    } >&2
  fi
  return 0
}

mkdir -p "$LOGDIR"; chmod 700 "$LOGDIR"
if [ "$(uname)" = "Darwin" ]; then warn_legacy_secret "$PLIST"; else warn_legacy_secret "$UNIT_DIR/$UNIT"; fi
write_creds
write_wrapper
if [ "$(uname)" = "Darwin" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  render_plist > "$PLIST" && chmod 600 "$PLIST"
  if [ "$ACTIVATE" = "1" ]; then launchctl unload "$PLIST" 2>/dev/null; launchctl load "$PLIST"; else echo "（--no-activate：未加载 launchd）"; fi
  echo "已安装：${PLIST}（每 ${INTERVAL}s 一轮，日志 $LOGDIR/task-loop.{out,err}）"
else
  mkdir -p "$UNIT_DIR"
  render_service > "$UNIT_DIR/$UNIT"; render_timer > "$UNIT_DIR/$TIMER"
  if [ "$ACTIVATE" = "1" ]; then systemctl --user daemon-reload && systemctl --user enable --now "$TIMER"; else echo "（--no-activate：未启用 systemd timer）"; fi
  echo "已安装：$UNIT_DIR/${TIMER}（每 ${INTERVAL}s 一轮）"
fi
# 剖面 B 的**空间身份**（projectKey / 任务类型 / 字段 key / 词表）不在这里：它们在目标仓库
# 的 harness.rules.json runtime.feishu 里，跟着代码走。所以本脚本只经手真正的秘密
# （GitLab token、插件身份 URL）——以前靠 env 传 projectKey 时，渲染函数漏一个变量就是
# 一次"定时任务每轮都静默失败"，而失败原因隔着 cron 日志两层才看得见。
echo "换凭据：改 ${CRED_FILE}（0600）即可，不用重装"
echo "停止：touch $ROOT/.ai/task-loop/OFF（kill switch）；彻底卸载：$0 <仓库> --uninstall"
