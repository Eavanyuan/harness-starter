#!/usr/bin/env bash
# 初始化一个新任务的状态文件。
#
# 用法：bash scripts/init-harness.sh <slug> [flow-tier]
#   flow-tier: S | M | L | XL，默认 M
#
# 一个任务一个 state 文件，是并行协作不冲突的前提。
# 不要退回到"全仓库一个 pipeline-state.json"，两个人同时开工就会撞。
set -euo pipefail

SLUG="${1:?用法: bash scripts/init-harness.sh <slug> [S|M|L|XL]}"
TIER="${2:-M}"
DIR=".ai/tasks/${SLUG}"

case "$TIER" in
  S | M | L | XL) ;;
  *)
    echo "flow-tier 只能是 S/M/L/XL，收到：$TIER" >&2
    exit 64
    ;;
esac

if [ -f "${DIR}/state.json" ]; then
  echo "已存在：${DIR}/state.json（不覆盖，避免抹掉进度）" >&2
  exit 0
fi

mkdir -p "$DIR" .ai/verify .ai/locks

cat >"${DIR}/state.json" <<JSON
{
  "meta": {
    "task": "${SLUG}",
    "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "flow_tier": "${TIER}",
    "risk_tier": "MEDIUM",
    "ui_scope": "NONE",
    "trust_level": "L1"
  },
  "stage": "intake",
  "stage_history": [],
  "artifacts": {},
  "todos": [],
  "blockers": [],
  "gate_result": { "last_check": null, "checks": [] }
}
JSON

echo "OK  ${DIR}/state.json  (tier=${TIER})"
echo "下一步：让 orchestrator 定档并调度，或直接 /rs 产出需求规格。"
