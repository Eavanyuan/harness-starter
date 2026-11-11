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

echo "== 4b. 同一路径被**重写**也要计数 =="
# mvn 重跑不会新建文件，它把 target/surefire-reports/TEST-Foo.txt 原地重写。
# 用"运行前后文件清单差集"判新旧时，路径没变 → 被判成没动过 → 计数整条丢失。
# fixture 必须走"同一路径改内容"这条路径，才算测到这个坑（前一组每次都是新文件，抓不住）。
rm -rf d
bash scripts/verify-run.sh T4b -- bash -c 'mkdir -p d/target/surefire-reports; printf "Tests run: 4, Failures: 0, Errors: 0, Skipped: 0\n" > d/target/surefire-reports/r.txt' >/dev/null 2>&1
r1="$(grep -m1 '^# tests:' .ai/verify/T4b.log | sed -n 's/.*total=\([0-9]*\).*/\1/p')"
bash scripts/verify-run.sh T4b -- bash -c 'printf "Tests run: 6, Failures: 0, Errors: 0, Skipped: 0\n" > d/target/surefire-reports/r.txt' >/dev/null 2>&1
r2="$(grep -m1 '^# tests:' .ai/verify/T4b.log | sed -n 's/.*total=\([0-9]*\).*/\1/p')"
check "首次 4" 4 "$r1"
check "同路径重写后按新内容计数 6（不是空）" 6 "$r2"

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

echo "== 7b. todo-id 不许把日志写出 .ai/verify =="
# id 直接拼进路径：`../escape` 会让"证据"落在 .ai/ 甚至仓库别处，
# 而门禁只看 .ai/verify/<id>.log 在不在——写到别处的日志等于没写，还不报错。
code=0; bash scripts/verify-run.sh ../escape -- bash -c 'true' >/dev/null 2>"$TMP/e7b" || code=$?
check "含 ../ 的 id → 64" 64 "$code"
if [ -f .ai/escape.log ] || [ -f scripts/escape.log ]; then r=yes; else r=no; fi
check "没有在 .ai/verify 之外落文件" no "$r"
code=0; bash scripts/verify-run.sh "a b" -- bash -c 'true' >/dev/null 2>&1 || code=$?
check "含空格的 id → 64" 64 "$code"

echo "== 8. 日志 id 撞名 → 不静默覆盖别人的证据 =="
# .ai/verify/<id>.log 是全局命名空间。两个任务都用 T1 时，后来者会静默冲掉前者，
# 而门禁只看"有日志且 exit 0"，串台看不出来——证据被换成另一件事的输出，账还是绿的。
mkdir -p .ai/tasks/other
cat > .ai/tasks/other/state.json <<'EOF'
{ "meta": { "task": "other" },
  "todos": [ { "id": "T1", "verify": { "log_path": ".ai/verify/T1.log" } } ] }
EOF

code=0; bash scripts/verify-run.sh T1 -- bash -c 'true' >/dev/null 2>"$TMP/e8" || code=$?
check "只被一个任务引用且未声明 --task → 放行（自己重跑）" 0 "$code"
check "但把占用者点名说出来" 1 "$(grep -c 'other' "$TMP/e8")"

code=0; bash scripts/verify-run.sh --task mine T1 -- bash -c 'true' >/dev/null 2>"$TMP/e9" || code=$?
check "声明了别的任务名 → 拒绝覆盖（exit 2）" 2 "$code"
check "拒绝时说明是谁的、怎么改" 1 "$(grep -c '拒绝覆盖' "$TMP/e9")"

code=0; bash scripts/verify-run.sh --task other T1 -- bash -c 'true' >/dev/null 2>&1 || code=$?
check "声明占用者自己的名字 → 允许重跑" 0 "$code"

echo "== 9. 管道不许把红的洗成绿的（| tail -1 的退出码）=="
# `false | tail -1` 的退出码是 tail 的 0。以前这条链会一路绿到底，日志写 exit_code: 0，
# 而真正的套件已经红了——证据链最贵的错误是"它说自己跑过了"。
code=0
bash scripts/verify-run.sh T6 -- bash -c 'false | tail -1' >/dev/null 2>&1 || code=$?
check "管道末段成功 ≠ 命令成功（pipefail 传到子 bash）" 1 "$code"
grep -q '^# exit_code: 1$' .ai/verify/T6.log && r=0 || r=1
check "日志头如实记 exit_code: 1" 0 "$r"
code=0
bash scripts/verify-run.sh T7 -- bash -c 'exit 0 | tail -1' >/dev/null 2>&1 || code=$?
check "真的成功仍然记 0（不是一律判死）" 0 "$code"

echo "== 10. 证据绑提交（P1-③后半）：日志头写产证时的 HEAD =="
# fixture 不是 git 仓库时 wrapper 写 unknown；这里建一个最小仓，验证真绑定路径。
git init -q . && git add -A && git -c user.email=t@t -c user.name=t commit -qm init
code=0
bash scripts/verify-run.sh T8 -- bash -c 'true' >/dev/null 2>&1 || code=$?
check "包装器正常跑完" 0 "$code"
grep -q "^# commit: $(git rev-parse --short=7 HEAD)" .ai/verify/T8.log && r=0 || r=1
check "日志头含当前 HEAD 的短 hash" 0 "$r"
grep -q '^# commit: [0-9a-f]\{7,40\}$' .ai/verify/T8.log && r=0 || r=1
check "commit 行格式合法（窗口内第 5 行）" 0 "$r"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
