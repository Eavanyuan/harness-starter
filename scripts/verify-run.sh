#!/usr/bin/env bash
# 定向验证包装器 —— 让 verify 证据链只可能由「真跑过一次」产生。
#
# 用法：
#   bash scripts/verify-run.sh T1 -- mvn -q test -Dtest=FooTest
#   bash scripts/verify-run.sh V1 -- pnpm run test:unit
#
# 日志写到 .ai/verify/<id>.log，头部固定 4 行（有测试计数时 5 行），
# 供 hooks/lib/verify.mjs 机器校验（只认前 5 行，别往里插别的）。
# 末尾保留输出尾部 200 行：足够定位失败原因，又不会把仓库撑大。
set -uo pipefail

if [ $# -lt 3 ] || [ "$2" != "--" ]; then
  echo "用法: bash scripts/verify-run.sh <todo-id> -- <command...>" >&2
  exit 64
fi

ID="$1"
shift 2

# 命令必须先存进数组再跑。
# 反面教材（实测）：下面统计计数时用 `set -- $parsed` 拆字段，会覆盖位置参数 $@，
# 于是后面 `echo "# cmd: $*"` 打出来的是 "7 0 0 0"——命令字段变成了测试计数。
# 越是**有** surefire 报告的 Maven 运行越必然踩中，正好是它被设计要解决的场景。
CMD=("$@")
printf -v CMDLINE '%q ' "${CMD[@]}"
CMDLINE="${CMDLINE% }"

mkdir -p .ai/verify
LOG=".ai/verify/${ID}.log"
OUT="$(mktemp)"
BENCH="$(mktemp)"   # 跑之前的基准时间点：只统计比它新的 surefire 报告
trap 'rm -f "$OUT" "$BENCH"' EXIT

START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"${CMD[@]}" >"$OUT" 2>&1
CODE=$?
END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 从 surefire-reports 聚合测试计数写进头部（#17）：mvn -q 会把 Tests run 从 stdout 吞掉，
# 成功日志里若没有数字，audit.tests 的 N/M 就永远无法对账（实测同一事实出过 27/6/16 三个版本）。
# 只统计本次运行新生成的报告（比 BENCH 新），跨次运行不重复计数。
TESTS_TOTAL=0; TESTS_FAIL=0; TESTS_ERR=0; TESTS_SKIP=0
while IFS= read -r txt; do
  line="$(grep -m1 '^Tests run:' "$txt" 2>/dev/null || true)"
  [ -z "$line" ] && continue
  parsed="$(printf '%s' "$line" | sed -n 's/^Tests run: \([0-9]*\), Failures: \([0-9]*\), Errors: \([0-9]*\), Skipped: \([0-9]*\).*/\1 \2 \3 \4/p')"
  [ -z "$parsed" ] && continue
  # 用 read 拆到具名变量，不动位置参数（见上面 CMD 的注释）
  read -r t f e s <<<"$parsed"
  TESTS_TOTAL=$((TESTS_TOTAL + t)); TESTS_FAIL=$((TESTS_FAIL + f))
  TESTS_ERR=$((TESTS_ERR + e)); TESTS_SKIP=$((TESTS_SKIP + s))
done < <(find . -path '*/target/surefire-reports/*.txt' -newer "$BENCH" 2>/dev/null)

{
  echo "# cmd: ${CMDLINE}"
  echo "# started: ${START}"
  echo "# finished: ${END}"
  echo "# exit_code: ${CODE}"
  # 没有报告就不写这一行：写个 total=0 等于伪造一条「跑了 0 个用例」的结论，
  # 而 checkAuditTestsMatch 会拿它去对账，把「没统计到」变成「对不上」。
  if [ "$TESTS_TOTAL" -gt 0 ]; then
    echo "# tests: total=${TESTS_TOTAL} failures=${TESTS_FAIL} errors=${TESTS_ERR} skipped=${TESTS_SKIP}（来源 surefire-reports，非 stdout）"
  fi
  echo "# ---- output tail (last 200 lines) ----"
  tail -n 200 "$OUT"
} >"$LOG"

if [ "$CODE" -eq 0 ]; then
  echo "[verify] PASS  ${LOG}"
else
  echo "[verify] FAIL(exit=${CODE})  ${LOG}" >&2
fi
exit "$CODE"
