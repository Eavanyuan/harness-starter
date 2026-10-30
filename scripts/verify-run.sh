#!/usr/bin/env bash
# 定向验证包装器 —— 让 verify 证据链只可能由「真跑过一次」产生。
#
# 用法：
#   bash scripts/verify-run.sh T1 -- mvn -q test -Dtest=FooTest
#   bash scripts/verify-run.sh V1 -- pnpm run test:unit
#
# 日志写到 .ai/verify/<id>.log，头部固定四行，供 hooks/lib/verify.mjs 机器校验。
# 末尾保留输出尾部 200 行：足够定位失败原因，又不会把仓库撑大。
set -uo pipefail

if [ $# -lt 3 ] || [ "$2" != "--" ]; then
  echo "用法: bash scripts/verify-run.sh <todo-id> -- <command...>" >&2
  exit 64
fi

ID="$1"
shift 2

mkdir -p .ai/verify
LOG=".ai/verify/${ID}.log"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"$@" >"$OUT" 2>&1
CODE=$?
END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

{
  echo "# cmd: $*"
  echo "# started: ${START}"
  echo "# finished: ${END}"
  echo "# exit_code: ${CODE}"
  echo "# ---- output tail (last 200 lines) ----"
  tail -n 200 "$OUT"
} >"$LOG"

if [ "$CODE" -eq 0 ]; then
  echo "[verify] PASS  ${LOG}"
else
  echo "[verify] FAIL(exit=${CODE})  ${LOG}" >&2
fi
exit "$CODE"
