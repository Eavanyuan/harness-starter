#!/usr/bin/env bash
# verify-run.sh 自测 —— 它是 #16（日志头）/#17（计数对账）全部判据的**输入源**。
#
# 这个脚本出错的后果不是"少一条提示"，而是让整个证据链判在错误的数据上：
# 头部写错 → exit_code 读不到 → 合规任务被判无证据；
# 计数写错 → audit.tests 对账永远对不上 → 人对这条规则失去信任后直接关掉它。
#
# 所以这里测的都是**输入本身**对不对，不是"脚本没崩"。
#
# 用法：bash test/verify-run.test.sh     全部通过退出 0
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/scripts"
cp "$HERE/scripts/verify-run.sh" "$TMP/scripts/"
cd "$TMP"

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

head_of() { head -5 ".ai/verify/$1.log" 2>/dev/null; }

echo "== 1. # cmd 必须是真实命令，不能被测试计数覆盖（实测过的 bug）=="
# 旧实现：统计计数时 `set -- $parsed` 覆盖了位置参数，后面 echo "# cmd: $*"
# 打出来的是 "7 0 0 0"——越是有 surefire 报告的运行越必然踩中。
bash scripts/verify-run.sh T1 -- bash -c 'mkdir -p m/target/surefire-reports; printf "Tests run: 7, Failures: 0, Errors: 0, Skipped: 0\n" > m/target/surefire-reports/r.txt' >/dev/null 2>&1
cmd_line="$(grep -m1 '^# cmd:' .ai/verify/T1.log)"
# 头部用 printf %q 存命令：参数边界不会被空格抹平（可直接粘回 shell 复现），
# 所以这里断言的是"命令主体在、且不是计数"。
case "$cmd_line" in
  *"mkdir"*"surefire-reports"*"printf"*) r=ok ;;
  *) r="BAD: $cmd_line" ;;
esac
check "cmd 行保留完整命令（参数边界未被空格抹平）" ok "$r"
case "$cmd_line" in
  *"0 0 0"*|*"7 0"*) r=bad ;;
  *) r=ok ;;
esac
check "cmd 行没有变成测试计数" ok "$r"

echo "== 2. 多模块 surefire 报告要相加，不是取一份 =="
# 报告必须由**本次运行**生成：脚本只统计比基准点新的报告（跨次运行不重复计数），
# 事先摆好的报告会被正确忽略——所以这里让命令自己产出。
bash scripts/verify-run.sh T2 -- bash -c '
  for spec in a:7 b:5; do
    d="${spec%%:*}/target/surefire-reports"; mkdir -p "$d"
    printf "Tests run: %s, Failures: 0, Errors: 0, Skipped: 0\n" "${spec##*:}" > "$d/r.txt"
  done' >/dev/null 2>&1
t="$(grep -m1 '^# tests:' .ai/verify/T2.log | sed -n 's/.*total=\([0-9]*\).*/\1/p')"
check "两份报告 7+5 聚合为 12" 12 "$t"
grep -q '^# exit_code: 0$' .ai/verify/T2.log && r=0 || r=1
check "exit_code 头存在且为 0" 0 "$r"

echo "== 3. 没有报告时**不写** # tests 行（不伪造 total=0）=="
# 写 total=0 等于替这次运行编一条"跑了 0 个用例"的结论，
# 而 checkAuditTestsMatch 会拿它去对账，把"没统计到"变成"对不上"，制造假红灯。
rm -rf a b
bash scripts/verify-run.sh T3 -- bash -c 'true' >/dev/null 2>&1
grep -q '^# tests:' .ai/verify/T3.log && r=1 || r=0
check "无报告 → 没有 # tests 行" 0 "$r"

echo "== 4. 跨次运行不重复计数 =="
# 第一次跑出的报告不该被第二次算进去，否则 total 会随运行次数膨胀。
rm -rf c
bash scripts/verify-run.sh T4 -- bash -c 'mkdir -p c/target/surefire-reports; printf "Tests run: 3, Failures: 0, Errors: 0, Skipped: 0\n" > c/target/surefire-reports/r.txt' >/dev/null 2>&1
t1="$(grep -m1 '^# tests:' .ai/verify/T4.log | sed -n 's/.*total=\([0-9]*\).*/\1/p')"
bash scripts/verify-run.sh T4 -- bash -c 'true' >/dev/null 2>&1
t2="$(grep -m1 '^# tests:' .ai/verify/T4.log | sed -n 's/.*total=\([0-9]*\).*/\1/p')"
check "首次计入本次新报告" 3 "$t1"
check "同一批报告不重复计入（第二次没有新报告 → 无计数行）" "" "$t2"

echo "== 5. 失败运行的 exit_code 要如实写，脚本退出码同步 =="
code=0
bash scripts/verify-run.sh T5 -- bash -c 'echo boom; exit 7' >/dev/null 2>&1 || code=$?
check "脚本退出码 = 被跑命令的退出码" 7 "$code"
grep -q '^# exit_code: 7$' .ai/verify/T5.log && r=0 || r=1
check "日志头 exit_code = 7" 0 "$r"

echo "== 6. verify.mjs 能从头部读到结论（两边口径一致）=="
node -e '
import("'"$HERE"'/hooks/lib/verify.mjs").then((v) => {
  const ok = v.parseExitCode(v.readHead(".ai/verify/T2.log"));
  const bad = v.parseExitCode(v.readHead(".ai/verify/T5.log"));
  process.stdout.write(`${ok}|${bad}`);
});' > "$TMP/parsed.txt" 2>&1
check "校验器读到的 exit_code 与脚本写的一致" "0|7" "$(cat "$TMP/parsed.txt")"

echo "== 7. 用法错误 → 64（不静默跑空）=="
code=0
bash scripts/verify-run.sh T9 bash -c true >/dev/null 2>&1 || code=$?
check "缺少 -- 分隔符 → 64" 64 "$code"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
