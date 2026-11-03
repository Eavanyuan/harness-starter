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
# 期望值按 agents.enabled 派生（子集模式下源文件仍是全量 11 份，产物数=启用数，不是源数）
EXPECTED=$(node -e '
  const c = require("./harness.config.json");
  const enabled = c.agents && c.agents.enabled;
  if (Array.isArray(enabled)) { console.log(enabled.length); process.exit(0); }
  const fs = require("fs");
  console.log(fs.readdirSync("agents").filter((f) => f.endsWith(".agent.md")).length);')
check "claude=zcode" "$C" "$Z"
check "claude=deepseek" "$C" "$P"
check "产物数=启用数（无 agents.enabled 时=源数）" "$C" "$EXPECTED"

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
check "writes.json 的 agent 数=启用数" "$EXPECTED" "$(node -e 'console.log(Object.keys(require("./.ai/writes.json").agents).length)')"

echo "== 6. writes 无占位符残留、无空值 =="
check "占位符已替换" 0 "$(node -e '
const s=require("fs").readFileSync(".ai/writes.json","utf8");
console.log(/<[a-z-]+-dir>|<test-cmd>|<lint-cmd>/.test(s)?1:0);')"
check "空 writes 的 agent 数" 0 "$(node -e '
const m=require("./.ai/writes.json").agents;
console.log(Object.values(m).filter(v=>!v.writes.length).length);')"

echo "== 7. 漂移检测真能拦住手改 =="
# 用 orchestrator（agents.enabled 保证恒在）——用 coder 会在只读子集下不存在，
# 追加会"创建"一个产物清单之外的文件，check 反而发现不了（那正是 --prune 的职责）
echo "<!-- 手工塞一行 -->" >> .claude/agents/orchestrator.md
node scripts/build-agents.mjs --check >/dev/null 2>&1
check "手改后 check 失败" 1 "$?"
node scripts/build-agents.mjs >/dev/null 2>&1
check "重建后恢复一致" 0 "$(node scripts/build-agents.mjs --check >/dev/null 2>&1; echo $?)"

echo "== 8. CR 模板包含 §0 硬规则逐条核（防模板被改丢关键节）=="
check "CR 模板包含硬规则逐条核表" 0 "$(grep -q "§0 硬规则逐条核\|## 0 硬规则" templates/CR-代码审查记录.md && echo 0 || echo 1)"
check "CR 模板声明两种路径都适用" 0 "$(grep -q "所有审查路径\|正式 CR.*本地.*手动审查\|本地.*手动.*正式 CR" templates/CR-代码审查记录.md && echo 0 || echo 1)"
check "CR 模板要求先跑 resolve-skills" 0 "$(grep -q "resolve-skills" templates/CR-代码审查记录.md && echo 0 || echo 1)"

echo "== 9. AGENTS.md 包含审查规则和 verify-run 工具引用 =="
check "AGENTS.md 含审查前必加载 skill 规则" 0 "$(grep -q "审查代码.*resolve-skills\|resolve-skills.*审查" AGENTS.md && echo 0 || echo 1)"
check "AGENTS.md 含 verify-run.sh 引用" 0 "$(grep -q "verify-run" AGENTS.md && echo 0 || echo 1)"
check "AGENTS.md 含 --type change/bugfix 引用" 0 "$(grep -q "\-\-type.*change\|\-\-type.*bugfix" AGENTS.md && echo 0 || echo 1)"

echo "== 10. AGENTS.md 含意图路由表（先分类再动手）=="
check "意图路由表存在" 0 "$(grep -q '## 意图路由' AGENTS.md && echo 0 || echo 1)"
check "路由表覆盖 feature/change/bugfix/审查/测试" 0 "$(grep -c 'feature.*change.*bugfix\|change.*bugfix' AGENTS.md)"
check "路由表含'禁止跳过分类直接改代码'" 0 "$(grep -q '禁止跳过分类直接改代码' AGENTS.md && echo 0 || echo 1)"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
