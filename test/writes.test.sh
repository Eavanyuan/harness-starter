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
# -p 两个方向都要：测试会往放行条里增删行，恢复时若只还原内容，mtime 会跳到"刚刚"。
# 而证据链的新鲜度正是按 mtime 判的——于是每跑一次本测试，就把声明了
# hooks/write-allowlist.txt 的那份 verify 证据作废一次（实测 DOCGATE-V1 反复变"过时"，
# 根因是测试动了被取证对象的时间戳，不是证据本身有问题）。
cp -p "$ALLOWLIST" "$BACKUP"
trap 'cp -p "$BACKUP" "$ALLOWLIST"; rm -f "$BACKUP"; rm -rf "$TMP"' EXIT

# 自授权行的计数必须在覆盖 allowlist 之前取：`hooks/write-allowlist.txt | …` 这一行
# 让放行条给自己发通行证——加一行就能改任何受保护区，之后所有 writeGuards 都不设防。
# 2026-11-02 删掉了这样一条（评审三次点名），这里钉住"不许再长回来"。
SELF_AUTH="$(grep -c '^hooks/write-allowlist\.txt[[:space:]]*|' "$ALLOWLIST" || true)"

# 基线必须是"只有注释的干净 allowlist"：本测试断言的是 guard_write 的**默认拒绝**语义，
# 不能被仓库里当期有效的放行条影响——那些条目有自己的生命周期（到期自动失效），
# 快照活文件会让"保护区必拦"用例在有人合法登记放行条时随机变红。
cat > "$ALLOWLIST" <<'EOF'
# 写入受保护区的临时放行条 —— guard_write.mjs 读取。
#
# 格式：<路径 glob> | <为什么必须改> | <YYYY-MM-DD>
EOF

TMP="$(mktemp -d)"
# ledger 隔离：guard_write 每次拒绝都会落账，而 ledger 默认落 REPO_ROOT/.ai/ledger
# （HARNESS_ROOT 不影响它）。不隔离的话，跑一次自测就往真实账本灌几十条探测，
# 账本作为"误拦率基线"就废了（TDC 项目装完第一天的现场）。
export HARNESS_LEDGER_DIR="$TMP/ledger"
export HARNESS_LEDGER_SOURCE=selftest

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

echo "== 0. 放行条不许给自己发通行证 =="
check "仓库里的放行条没有自授权行" 0 "$SELF_AUTH"

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
payload Edit "hooks/guard_state.mjs"
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

echo "== 7b. 写凭据示例文件 → 应放行（拦截提示就让人写这个）=="
payload Write ".env.example"
check "示例 env 放行" 0 "$(run_write)"

echo "== 7c. 写 ZCode 接线文件 → 应拦截（生成物）=="
payload Write ".zcode/config.json"
check "ZCode 接线属生成物必拦" 2 "$(run_write)"

echo "== 8. 写仓库外 → 应拦截 =="
payload Write "../../etc/passwd"
check "仓库外必拦" 2 "$(run_write)"

echo "== 9. 受保护区带到期放行条 → 应放行 =="
# 日期用 node 算，不用 date：`date -v+1d` 是 BSD，`date -d` 是 GNU，busybox 两个都不支持，
# 而失败不会让脚本停下 —— 日期落成空串，放行条静默失效，这条用例变成红（实测 alpine）。
FUTURE_DATE="$(node -e 'console.log(new Date(Date.now() + 864e5).toISOString().slice(0, 10))')"
echo "hooks/guard_state.mjs | 自测临时放行 | $FUTURE_DATE" >> "$ALLOWLIST"
payload Edit "hooks/guard_state.mjs"
check "allowlist 生效" 0 "$(run_write)"

echo "== 10. 放行条过期 → 应恢复拦截 =="
# 回到干净基线（不是 $BACKUP——那是当期真实文件，可能带着其他合法放行条），
# 只留一条过期的：断言"过期 = 失效"这一条语义本身。
cat > "$ALLOWLIST" <<'EOF'
# 写入受保护区的临时放行条 —— guard_write.mjs 读取。
EOF
echo "hooks/guard_state.mjs | 已过期 | 2020-01-01" >> "$ALLOWLIST"
payload Edit "hooks/guard_state.mjs"
check "过期放行条件失效" 2 "$(run_write)"

echo "== 11. 输入损坏 → 应 fail-closed =="
printf 'not-json' > "$TMP/payload.json"
check "坏输入按拦截处理" 2 "$(run_write)"

echo "== 12. 非写入类工具 → 不应干预 =="
payload Read "hooks/guard_state.mjs"
check "Read 不看写入规则" 0 "$(run_write)"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
