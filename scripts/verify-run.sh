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
# 把 pipefail 传给被跑的命令（P2-2）。
#
# 本脚本自己的 `set -o pipefail` 只管自己：命令是子进程，默认不带这个选项。
# 于是证据链上最常见的写法 `npm test 2>&1 | tail -1` 会让退出码变成 tail 的 0——
# 套件红了链条照走，日志照样写 exit_code: 0。实测 RV2.log 就是这么绿过来的。
#
# 传导方式选 BASH_ENV 而不是 export SHELLOPTS：
# SHELLOPTS 会把**全部** shell 选项一起传下去，包括本脚本开的 `nounset`——
# 实测这样子跑 gate，harness-cli 那套立刻多出 1~8 条红（子 bash 里一个空变量
# 从"展开成空串"变成"unbound variable"，连带 `node -e <空路径>` 报 MODULE_NOT_FOUND），
# 而这跟证据真假毫无关系。BASH_ENV 指到的文件只做一件事：打开 pipefail。
PIPEFAIL_ENV="$(mktemp)"
printf 'set -o pipefail\n' > "$PIPEFAIL_ENV"
export BASH_ENV="$PIPEFAIL_ENV"
# sh/zsh 不读 BASH_ENV，那两个 shell 里这条传导无效——所以判据只看日志头的退出码，
# 不猜命令是怎么写的。

# 可选 `--task <名字>`（或环境变量 HARNESS_TASK）：声明"这条证据属于哪个任务"。
#
# 为什么需要它：`.ai/verify/<id>.log` 是**全局**命名空间，两个任务都用 `T1` 就会
# 互相覆盖，而覆盖是静默的——门禁只看"有日志且 exit_code=0"，串台看不出来。
# 实测踩过一次：给新任务生成第一条证据时，把另一个任务的 T1.log 冲掉了，事后才
# 发现那份证据已经不是我原来跑的东西。判据不报错，才是这类事故最贵的地方。
TASK="${HARNESS_TASK:-}"
if [ "${1:-}" = "--task" ]; then
  TASK="${2:-}"
  if [ -z "$TASK" ]; then
    echo "用法: bash scripts/verify-run.sh [--task <任务名>] <todo-id> -- <command...>" >&2
    exit 64
  fi
  shift 2
fi

if [ $# -lt 3 ] || [ "$2" != "--" ]; then
  echo "用法: bash scripts/verify-run.sh [--task <任务名>] <todo-id> -- <command...>" >&2
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

# 归属检查：不悄悄覆盖别人已经当作证据引用的日志。
# 只有 id 被某个 state.json 的 verify.log_path 指到时才算"别人的"；没被引用的
# 同名文件（比如你自己上一次的临时产物）照旧直接覆盖。
claimers=()
for f in .ai/tasks/*/state.json; do
  [ -f "$f" ] || continue
  if grep -qF ".ai/verify/${ID}.log" "$f" 2>/dev/null; then
    claimers+=("$(basename "$(dirname "$f")")")
  fi
done

if [ -f "$LOG" ] && [ ${#claimers[@]} -gt 0 ]; then
  owned=0
  for c in "${claimers[@]}"; do
    [ "$c" = "$TASK" ] && owned=1
  done
  if [ "$owned" -eq 0 ]; then
    if [ -n "$TASK" ] || [ ${#claimers[@]} -gt 1 ]; then
      echo "[verify] 拒绝覆盖：$LOG 已被任务 ${claimers[*]} 引用，不是 ${TASK:-（未声明 --task）} 的。" >&2
      echo "[verify] 换个 id（例如在你的任务名下加前缀），或确认确实要改写别人的证据时加 --task ${claimers[0]}" >&2
      exit 2
    fi
    # 只被一个任务引用、又没声明任务名：最可能是自己重跑，提醒一句即可。
    echo "[verify] 注意：$LOG 已属于任务 ${claimers[0]}；若是同一任务重跑，加 --task ${claimers[0]} 显式确认" >&2
  fi
fi
OUT="$(mktemp)"
BENCH="$(mktemp)"   # 跑之前的基准时间点：只统计比它新的 surefire 报告
trap 'rm -f "$OUT" "$BENCH" "$PIPEFAIL_ENV"' EXIT

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
