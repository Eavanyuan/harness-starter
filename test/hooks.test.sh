#!/usr/bin/env bash
# 门禁自测 —— 装完不验证，等于不知道自己有没有装。
#
# 覆盖 6 个关键行为：3 个必须放行、4 个必须拦住。
# 用法：bash test/hooks.test.sh     全部通过退出 0
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
mkdir -p .ai/verify src

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

run_validate() {
  local code=0
  node "$HERE/hooks/validate_todo.mjs" < payload.json >/dev/null 2>&1 || code=$?
  echo "$code"
}

run_guard() {
  local code=0
  node "$HERE/hooks/guard_command.mjs" < payload.json >/dev/null 2>&1 || code=$?
  echo "$code"
}

write_log() {
  mkdir -p .ai/verify
  cat > ".ai/verify/$1.log" <<EOF
# cmd: echo smoke
# started: 2026-01-01T00:00:00Z
# finished: 2026-01-01T00:00:01Z
# exit_code: $2
# ---- output tail (last 200 lines) ----
ok
EOF
}

echo "== 1. 证据齐全、日志晚于源码 → 应放行 =="
touch -t 202001010000 src/Foo.java
write_log T1 0
touch -t 202101010000 .ai/verify/T1.log
cat > payload.json <<'EOF'
{"tool_name":"TodoWrite","tool_input":{"todos":[{
  "id":"T1","status":"completed","ooda_stage":"audit","files":["src/Foo.java"],
  "audit":{"compile":true,"tests":"pass","feature_complete":true,"quality_clean":true},
  "verify":{"log_path":".ai/verify/T1.log"}}]}}
EOF
check "完整证据链放行" 0 "$(run_validate)"

echo "== 2. 缺审计项 → 应阻断 =="
cat > payload.json <<'EOF'
{"tool_name":"TodoWrite","tool_input":{"todos":[{
  "id":"T1","status":"completed","ooda_stage":"audit","files":["src/Foo.java"],
  "audit":{"compile":true},
  "verify":{"log_path":".ai/verify/T1.log"}}]}}
EOF
check "缺 3 项审计必拦" 2 "$(run_validate)"

echo "== 3. 日志早于源码修改 → 应阻断（防复述历史输出）=="
touch -t 202201010000 src/Foo.java
check "证据不新鲜必拦" 2 "$(run_validate)"

echo "== 4. 日志 exit_code 非 0 → 应阻断 =="
touch -t 202001010000 src/Foo.java
write_log T1 3
touch -t 202101010000 .ai/verify/T1.log
cat > payload.json <<'EOF'
{"tool_name":"TodoWrite","tool_input":{"todos":[{
  "id":"T1","status":"completed","ooda_stage":"audit","files":["src/Foo.java"],
  "audit":{"compile":true,"tests":"pass","feature_complete":true,"quality_clean":true},
  "verify":{"log_path":".ai/verify/T1.log"}}]}}
EOF
check "失败命令不能标完成" 2 "$(run_validate)"

echo "== 5. 普通 todo（非工程 id）→ 不干预 =="
cat > payload.json <<'EOF'
{"tool_name":"TodoWrite","tool_input":{"todos":[
  {"content":"顺手记个待办","status":"completed"}]}}
EOF
check "普通清单不被误拦" 0 "$(run_validate)"

echo "== 6. OODA 跳阶段 → 应阻断 =="
write_log T2 0
touch -t 202101010000 .ai/verify/T2.log
cat > payload.json <<'EOF'
{"tool_name":"TodoWrite","tool_input":{"todos":[{
  "id":"T2","status":"completed","ooda_stage":"act","files":["src/Foo.java"],
  "audit":{"compile":true,"tests":"pass","feature_complete":true,"quality_clean":true},
  "verify":{"log_path":".ai/verify/T2.log"}}]}}
EOF
check "跳过 observe 必拦" 2 "$(run_validate)"

echo "== 7. 高危命令 → 应拦截 =="
cat > payload.json <<'EOF'
{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}
EOF
check "force push 必拦" 2 "$(run_guard)"

echo "== 8. 常规命令 → 应放行 =="
cat > payload.json <<'EOF'
{"tool_name":"Bash","tool_input":{"command":"ls -la src"}}
EOF
check "普通命令放行" 0 "$(run_guard)"

echo "== 9. 读敏感文件 → 应拦截 =="
cat > payload.json <<'EOF'
{"tool_name":"Read","tool_input":{"file_path":"/repo/.env.production"}}
EOF
check "禁读 .env 必拦" 2 "$(run_guard)"

echo "== 10. 读普通文件 → 应放行 =="
cat > payload.json <<'EOF'
{"tool_name":"Read","tool_input":{"file_path":"/repo/src/Foo.java"}}
EOF
check "普通文件放行" 0 "$(run_guard)"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
