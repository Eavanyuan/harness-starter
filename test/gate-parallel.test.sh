#!/usr/bin/env bash
# gate-parallel 自测 —— 并发执行器可以慢，但不能吞失败。
#
# 为什么这条测试必须存在：串行的 `a && b && c` 只在**末段**失败时给非零退出码；
# 中间段红了，bash 会停在那一句、退出码也是非零，看似没问题——但换成并发后，
# "谁失败了"全靠执行器自己聚合。聚合写错就是：34 段里第 7 段红，整体照样 exit 0。
# 这正是 gate-regressions 踩过的坑（判定写在中段，被后续命令覆盖）。执行器层面
# 必须独立验一遍，不能只靠"跑完是绿的"。
#
# 用法：bash test/gate-parallel.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
G="$HERE/scripts/gate-parallel.mjs"

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then
    printf "  \033[32m✓\033[0m %s\n" "$1"
    pass=$((pass + 1))
  else
    printf "  \033[31m✗\033[0m %s  (期望 %s，实际 %s)\n" "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

echo "== 1. 全成功 → exit 0 =="
GATE_PARALLEL_CMDS=$'true\ntrue\ntrue' node "$G" --jobs=2 >/dev/null 2>&1
check "三段全过 exit 0" "0" "$?"

echo "== 2. 中间段失败 → exit 1（并发聚合的核心判据）=="
GATE_PARALLEL_CMDS=$'true\nexit 1\ntrue' node "$G" --jobs=2 >/dev/null 2>&1
check "中间段失败 exit 1（末段是成功的）" "1" "$?"

echo "== 3. 首段失败、末段成功 → exit 1 =="
GATE_PARALLEL_CMDS=$'exit 7\ntrue' node "$G" --jobs=2 >/dev/null 2>&1
check "首段失败 exit 1" "1" "$?"

echo "== 4. 多段失败 → 每个都报出来（不只报第一个）=="
OUT=$(GATE_PARALLEL_CMDS=$'exit 3\ntrue\nexit 5' node "$G" --jobs=3 2>&1)
# 报错块以 ──── 开头（✗ 前有 ANSI 转义，不能连写成 "^──── ✗"）。
N=$(printf '%s\n' "$OUT" | grep -c "^──── ")
check "两段失败各有一条报错块" "2" "$N"

echo "== 5. 失败可归因：该段输出留在尾部日志里 =="
OUT=$(GATE_PARALLEL_CMDS=$'echo NEEDLE_MARKER_42; exit 1' node "$G" --jobs=2 2>&1)
# marker 会出现三次（状态行的命令、报错块标题、日志尾部）；只数单独成行的那次 = 日志内容。
HIT=$(printf '%s\n' "$OUT" | grep -c "^NEEDLE_MARKER_42$")
check "失败段的自有输出被打印出来" "1" "$HIT"

echo "== 6. 时间敏感段（perf-checks）不被塞进并发池 =="
OUT=$(GATE_PARALLEL_CMDS=$'true\nnpm run -s test:perf-checks-probe\ntrue' node "$G" --jobs=3 2>&1)
LINE=$(printf '%s\n' "$OUT" | head -1)
case "$LINE" in
  *"并发 2"*"串行 1"*) R="ok" ;;
  *) R="$LINE" ;;
esac
check "perf-checks 归入串行队列（2 并发 + 1 串行）" "ok" "$R"

echo "== 7. 空清单 → exit 2（配置缺失不能当绿）=="
GATE_PARALLEL_CMDS='' node "$G" >/dev/null 2>&1
check "段清单为空 exit 2" "2" "$?"

echo
echo "结果：$pass 通过，$fail 失败"
[ "$fail" -eq 0 ]
