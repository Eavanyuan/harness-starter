#!/usr/bin/env bash
# 写入边界自测。
#
# 只测"拦得住"是不够的——拦截全绿可能只是脚本崩溃。所以每个负向用例都要求
# 命中具体错误信息，正向用例必须确认放行。
#
# 用法：bash test/writes.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ALLOWLIST="$HERE/hooks/write-allowlist.txt"
BACKUP="$(mktemp)"
cp "$ALLOWLIST" "$BACKUP"
trap 'cp "$BACKUP" "$ALLOWLIST"; rm -f "$BACKUP"' EXIT

TMP="$(mktemp -d)"
trap 'cp "$BACKUP" "$ALLOWLIST"; rm -rf "$TMP"' EXIT

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

ERR="$TMP/stderr"

run_write() {
  local code=0
  node "$HERE/hooks/guard_write.mjs" < "$TMP/payload.json" >/dev/null 2>"$ERR" || code=$?
  echo "$code"
}

payload() {
  printf '{"tool_name":"%s","tool_input":{"file_path":"%s"}}' "$1" "$2" > "$TMP/payload.json"
}

echo "== 1. 写业务源码 → 应放行 =="
payload Write "backend/src/main/java/demo/Foo.java"
check "后端源码放行" 0 "$(run_write)"

echo "== 2. 写文档 → 应放行 =="
payload Edit "docs/02-features/demo/fs-x.md"
check "功能规格放行" 0 "$(run_write)"

echo "== 3. 手改生成物 → 应拦截，且提示改源重建 =="
payload Write ".claude/agents/coder.md"
check "生成物必拦" 2 "$(run_write)"
if grep -q "npm run build" "$ERR"; then
  printf "  \033[32m✓\033[0m %s\n" "拦截信息给出重建命令"
  pass=$((pass + 1))
else
  printf "  \033[31m✗\033[0m 拦截信息缺少修复指引\n"
  fail=$((fail + 1))
fi

echo "== 4. 改门禁代码 → 应拦截（考卷不能被考生改）=="
payload Edit "hooks/validate_todo.mjs"
check "hook 保护区必拦" 2 "$(run_write)"

echo "== 5. 改模板 → 应拦截 =="
payload Write "templates/FS-功能规格.md"
check "模板保护区必拦" 2 "$(run_write)"

echo "== 6. 改 agent 定义 → 应拦截 =="
payload Write "agents/coder.agent.md"
check "agent 源保护区必拦" 2 "$(run_write)"

echo "== 7. 写凭据文件 → 应拦截 =="
payload Write ".env.production"
check "凭据文件必拦" 2 "$(run_write)"

echo "== 8. 写仓库外 → 应拦截 =="
payload Write "../../etc/passwd"
check "仓库外必拦" 2 "$(run_write)"

echo "== 9. 受保护区带到期放行条 → 应放行 =="
echo "hooks/validate_todo.mjs | 自测临时放行 | $(date -v+1d +%Y-%m-%d 2>/dev/null || date -d '+1 day' +%Y-%m-%d)" >> "$ALLOWLIST"
payload Edit "hooks/validate_todo.mjs"
check "allowlist 生效" 0 "$(run_write)"

echo "== 10. 放行条过期 → 应恢复拦截 =="
cp "$BACKUP" "$ALLOWLIST"
echo "hooks/validate_todo.mjs | 已过期 | 2020-01-01" >> "$ALLOWLIST"
payload Edit "hooks/validate_todo.mjs"
check "过期放行条件失效" 2 "$(run_write)"

echo "== 11. 输入损坏 → 应 fail-closed =="
printf 'not-json' > "$TMP/payload.json"
check "坏输入按拦截处理" 2 "$(run_write)"

echo "== 12. 非写入类工具 → 不应干预 =="
payload Read "hooks/validate_todo.mjs"
check "Read 不看写入规则" 0 "$(run_write)"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
