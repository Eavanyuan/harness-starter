#!/usr/bin/env bash
# 产物契约自测 —— 生成器改坏了不会报错，只会产出一批"看起来对"的文件。
#
# 用法：bash test/agents.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

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

echo "== 1. 生成物与源一致 =="
node scripts/build-agents.mjs --check >/dev/null 2>&1
check "无漂移" 0 "$?"

echo "== 2. 三套产物数量一致 =="
C=$(ls .claude/agents/*.md 2>/dev/null | wc -l | tr -d ' ')
Z=$(ls .zcode/agents/*.md 2>/dev/null | wc -l | tr -d ' ')
P=$(ls prompts/agents/*.md 2>/dev/null | wc -l | tr -d ' ')
check "claude=zcode" "$C" "$Z"
check "claude=deepseek" "$C" "$P"
check "产物数=源数" "$C" "$(ls agents/*.agent.md | wc -l | tr -d ' ')"

echo "== 3. name 与文件名一致、tools 非空 =="
check "frontmatter 不合规数" 0 "$(node -e '
const fs=require("fs"),path=require("path");let bad=0;
for(const f of fs.readdirSync(".claude/agents")){
  const t=fs.readFileSync(path.join(".claude/agents",f),"utf8");
  const name=(t.match(/^name:\s*(.+)$/m)||[])[1];
  const tools=(t.match(/^tools:\s*(.+)$/m)||[])[1];
  if(name!==path.basename(f,".md")||!tools) bad++;
}
console.log(bad);')"

echo "== 4. 工具集不得超出能力声明，文档类不得带 Edit/Bash =="
check "越权工具数" 0 "$(node -e '
const fs=require("fs");
const cap=JSON.parse(fs.readFileSync("harness.config.json","utf8")).capabilityMap;
const allowed=new Set(Object.values(cap).flatMap(v=>v.claude));
const m=JSON.parse(fs.readFileSync(".ai/writes.json","utf8")).agents;let bad=0;
for(const [n,v] of Object.entries(m)){
  const tools=((fs.readFileSync(".claude/agents/"+n+".md","utf8").match(/^tools:\s*(.+)$/m)||[])[1]||"")
    .split(",").map(s=>s.trim()).filter(Boolean);
  for(const t of tools) if(!allowed.has(t)) bad++;
}
console.log(bad);')"
check "文档类带写码工具数" 0 "$(node -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync(".ai/writes.json","utf8")).agents;let bad=0;
for(const [n,v] of Object.entries(m)){
  const c=v.capabilities;
  const docOnly=c.includes("fs.write")&&!c.includes("fs.edit")&&!c.includes("shell.exec");
  const tools=(fs.readFileSync(".claude/agents/"+n+".md","utf8").match(/^tools:\s*(.+)$/m)||[])[1]||"";
  if(docOnly && /\b(Edit|Bash)\b/.test(tools)) bad++;
}
console.log(bad);')"

echo "== 5. 写入范围进入产物（writes 不再只是源文件里的注释）=="
check "缺写入范围的产物数" 0 "$(grep -L "> 写入范围：" .claude/agents/*.md 2>/dev/null | wc -l | tr -d ' ')"
check "writes.json 存在" 0 "$([ -f .ai/writes.json ] && echo 0 || echo 1)"
check "writes.json 的 agent 数" 11 "$(node -e 'console.log(Object.keys(require("./.ai/writes.json").agents).length)')"

echo "== 6. writes 无占位符残留、无空值 =="
check "占位符已替换" 0 "$(node -e '
const s=require("fs").readFileSync(".ai/writes.json","utf8");
console.log(/<[a-z-]+-dir>|<test-cmd>|<lint-cmd>/.test(s)?1:0);')"
check "空 writes 的 agent 数" 0 "$(node -e '
const m=require("./.ai/writes.json").agents;
console.log(Object.values(m).filter(v=>!v.writes.length).length);')"

echo "== 7. 漂移检测真能拦住手改 =="
echo "<!-- 手工塞一行 -->" >> .claude/agents/coder.md
node scripts/build-agents.mjs --check >/dev/null 2>&1
check "手改后 check 失败" 1 "$?"
node scripts/build-agents.mjs >/dev/null 2>&1
check "重建后恢复一致" 0 "$(node scripts/build-agents.mjs --check >/dev/null 2>&1; echo $?)"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
