#!/usr/bin/env bash
# hook 接线自测 —— 门禁写了但没接线，等于没写。
#
# 上一版的真实故障：hooks 只注册在 .claude/settings.json，.zcode/ 下什么都没有，
# 而 ZCode 不读 Claude 的 settings。ZCode 会话里 force push、读 .env、改考卷区
# 三道门全部不存在，而 AGENTS.md 写着"hook 硬拦"，doctor 还显示"✓ hook 已注册 4 个"。
# 这类失败最危险：不是门禁坏了，是门禁没接上，还报绿灯。
#
# 用法：bash test/wiring.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

TMP="$(mktemp -d)"
cp .claude/settings.json "$TMP/claude.bak"
cp .zcode/config.json "$TMP/zcode.bak" 2>/dev/null || true
cp harness.config.json "$TMP/harness.config.bak"

# 复原时连 mtime 一起复原。
#
# 这套用例要先把真配置改坏、再还原；`cp` 还原会把 mtime 刷成"现在"，
# 而证据新鲜度判据（hooks/lib/verify.mjs）看的正是 mtime 与日志的先后。
# 结果：每跑一次 gate（里面就有本套件），所有把 harness.config.json 写进 files 的
# 任务（如 GF1）立刻被判"日志早于源码修改，请真的重跑一次"——测出来的红是套件自己造成的，
# 与代码是否真改了毫无关系。`touch -r` 是这里唯一能保住"编辑时间"语义的做法。
restore_mtime() { touch -r "$2" "$1"; }
touch -r harness.config.json "$TMP/config.stamp"
touch -r .claude/settings.json "$TMP/claude.stamp"
[ -f .zcode/config.json ] && touch -r .zcode/config.json "$TMP/zcode.stamp"
restore_config() { cp "$TMP/harness.config.bak" harness.config.json; restore_mtime harness.config.json "$TMP/config.stamp"; }
restore() {
  cp "$TMP/claude.bak" .claude/settings.json; restore_mtime .claude/settings.json "$TMP/claude.stamp"
  if [ -f "$TMP/zcode.bak" ]; then
    cp "$TMP/zcode.bak" .zcode/config.json; restore_mtime .zcode/config.json "$TMP/zcode.stamp"
  fi
  restore_config
  rm -rf "$TMP"
}
trap restore EXIT

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
verify() {
  if eval "$1"; then
    printf "  \033[32m✓\033[0m %s\n" "$2"
    pass=$((pass + 1))
  else
    printf "  \033[31m✗\033[0m %s\n" "$2"
    fail=$((fail + 1))
  fi
}

echo "== 1. 接线与 manifest 一致 =="
node scripts/build-hooks.mjs --check >/dev/null 2>&1
check "无漂移" 0 "$?"

echo "== 2. 两个 CLI 都有接线文件 =="
verify "[ -f .claude/settings.json ]" "Claude 接线存在"
verify "[ -f .zcode/config.json ]" "ZCode 接线存在"

echo "== 3. ZCode 必须显式开启 hook（默认关闭，写了不执行）=="
verify "node -e 'process.exit(require(\"./.zcode/config.json\").hooks.enabled===true?0:1)'" "hooks.enabled = true"

echo "== 4. manifest 里每个 hook 都出现在两个 CLI 的接线里 =="
scripts=$(node -e 'const m=require("./hooks/hooks.manifest.json");const s=new Set();for(const g of Object.values(m.events))for(const x of g)for(const h of x.hooks)s.add(h.script);console.log([...s].join(" "))')
missing=0
for s in $scripts; do
  grep -q "$s" .claude/settings.json || missing=$((missing + 1))
  grep -q "$s" .zcode/config.json || missing=$((missing + 1))
done
check "全部 hook 已接线（缺 $missing 处）" 0 "$missing"

echo "== 5. 形态差异：Claude 用命令串，ZCode 用 argv =="
verify "grep -q '\"command\": \"node hooks/' .claude/settings.json" "Claude 为 command 字符串"
verify "node -e 'const c=require(\"./.zcode/config.json\");const h=c.hooks.events.PreToolUse[0].hooks[0];process.exit(h.type===\"process\"&&h.command===\"node\"&&Array.isArray(h.args)?0:1)'" "ZCode 为 process + args"

echo "== 6. matcher 锚定：ZCode 侧不能是裸 Bash|Read =="
verify "node -e 'const c=require(\"./.zcode/config.json\");const all=Object.values(c.hooks.events).flat().every(g=>!g.matcher||(g.matcher.startsWith(\"^(\")&&g.matcher.endsWith(\")$\")));process.exit(all?0:1)'" "ZCode 全部 matcher 已锚定"

echo "== 7. 手改接线 → --check 必须发现漂移 =="
printf ' ' >> .zcode/config.json
node scripts/build-hooks.mjs --check >/dev/null 2>&1
check "漂移被检出" 1 "$?"
cp "$TMP/zcode.bak" .zcode/config.json

echo "== 8. 缺接线文件 → doctor 必须报阻塞（不是绿灯）=="
mv .zcode/config.json "$TMP/moved.json"
node scripts/doctor.mjs >"$TMP/doctor.out" 2>&1
code=$?
cp "$TMP/moved.json" .zcode/config.json
check "doctor 对缺失接线报红" 1 "$code"
verify "grep -q 'zcode' \"$TMP/doctor.out\"" "体检输出点名了 zcode"

echo "== 9. hooks.enabled=false → doctor 必须报阻塞 =="
node -e 'const fs=require("fs");const c=require("./.zcode/config.json");c.hooks.enabled=false;fs.writeFileSync(".zcode/config.json",JSON.stringify(c,null,2))'
node scripts/doctor.mjs >/dev/null 2>&1
code=$?
cp "$TMP/zcode.bak" .zcode/config.json
check "关闭 hook 被体检拦住" 1 "$code"

echo "== 10. 配置的验证命令命中禁用 flag → doctor 必须报阻塞 =="
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync("harness.config.json","utf8"));c.stacks.backend.lint="mvn -q -DskipTests compile";fs.writeFileSync("harness.config.json",JSON.stringify(c,null,2))'
node scripts/doctor.mjs >"$TMP/doctor-flag.out" 2>&1
code=$?
restore_config
check "配置命令违反纪律被体检拦住" 1 "$code"
verify "grep -q 'skipTests' \"$TMP/doctor-flag.out\"" "体检输出点名了违规 flag"

# 复原必须连 mtime 一起复原，否则这套用例每跑一次就把相关任务的证据判成过期。
# 断言写成"文件不比原始时间戳更新"（find -newer 是 POSIX，BSD/GNU 都有），
# 比"记得用 touch -r"更可靠。
verify "test -z \"\$(find harness.config.json -newer \"$TMP/config.stamp\")\"" "还原后 harness.config.json 没被这套用例改成\"刚写过\""

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
