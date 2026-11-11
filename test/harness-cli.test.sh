#!/usr/bin/env bash
# harness-cli 自测 —— 方案 §11：每条探测/安装/退出规则都要在夹具上断言。
#
# 覆盖面（正负向都有，失效点 3 的教训：拦截全绿可能是崩溃，必须有放行用例）：
#   detect：java/vue 夹具命中、多构建根告警
#   analyze：产物落项目外、目标目录只读保证（前后内容 hash 一致）
#   init：dry-run 零落盘、安装+build 收口、冲突不覆盖、agents.enabled 子集
#   remove：dry-run 不删、--yes 只删 manifest 所列、外来文件与 .ai/tasks 保留
#   ledger：拦截落账、ledger 故障不影响判定（fail-open）
#   schema：未知版本显式报错（guard_state 与 ci-verify 两侧）
#
# 用法：bash test/harness-cli.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

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
# expect_out <名称> <期望片段> <输出> ：断言输出里命中具体信息（防"崩溃也算拦截"）
# grep 必须带 -- ：片段可能以 -- 开头（如 --resolve），否则被当成 grep 自己的选项。
expect_out() {
  if printf '%s' "$3" | grep -qF -- "$2"; then
    printf "  \033[32m✓\033[0m %s\n" "$1"
    pass=$((pass + 1))
  else
    printf "  \033[31m✗\033[0m %s（输出未含：%s）\n" "$1" "$2"
    fail=$((fail + 1))
  fi
}
CLI() { node "$HERE/scripts/harness-cli.mjs" "$@"; }
tree_hash() { (cd "$1" && find . -type f | sort | xargs shasum 2>/dev/null | shasum); }

# 夹具先拷出模板仓库：safeTarget 会拒绝探测模板自身内部的目录（安全内核的正确行为）
FIX="$TMP/fixtures"
cp -R "$HERE/test/fixtures" "$FIX"

echo "== 1. detect：夹具命中 =="
out="$(CLI detect "$FIX/java-small" 2>&1)"
expect_out "java-small 命中 Java/Maven" "Java/Maven" "$out"
out="$(CLI detect "$FIX/vue-small" --json 2>&1)"
expect_out "vue-small JSON 含 frontend" '"id": "frontend"' "$out"

echo "== 2. detect：多构建根 → 显式告警，不静默猜测 =="
mkdir -p "$TMP/multi/svc-a" "$TMP/multi/svc-b"
echo '<project/>' > "$TMP/multi/svc-a/pom.xml"
echo '<project/>' > "$TMP/multi/svc-b/pom.xml"
out="$(CLI detect "$TMP/multi" 2>&1)"
expect_out "多构建根告警" "只支持单主栈" "$out"

echo "== 3. analyze：报告在项目外 + 目标只读 =="
before="$(tree_hash "$FIX/java-small")"
CLI analyze "$FIX/java-small" --out "$TMP/report" >/dev/null 2>&1
check "analysis.json 生成" 0 "$([ -f "$TMP/report/analysis.json" ] && echo 0 || echo 1)"
check "PROJECT-MAP.md 生成" 0 "$([ -f "$TMP/report/PROJECT-MAP.md" ] && echo 0 || echo 1)"
check "只读保证（前后 hash 一致）" "$before" "$(tree_hash "$FIX/java-small")"
out="$(CLI analyze "$FIX/vue-small" --out "$FIX/vue-small/r" 2>&1)"
code=$?
expect_out "--out 落在项目内被拒" "落在目标项目内" "$out"
check "拒绝退出码非 0" 1 "$([ $code -ne 0 ] && echo 1 || echo 0)"
CLI analyze "$FIX/vue-small" --out "$TMP/vrep" >/dev/null 2>&1
expect_out "vue-small 检出循环依赖" "循环依赖" "$(cat "$TMP/vrep/analysis.json")"

echo "== 4. init --dry-run：一个字节都不落 =="
mkdir -p "$TMP/dry"
CLI init "$TMP/dry" --dry-run >/dev/null 2>&1
check "dry-run 零落盘" 0 "$(ls -A "$TMP/dry" | wc -l | tr -d ' ')"

echo "== 5. init：安装 + build 收口（带起始代码 → 探测回填 stacks → doctor 绿） =="
mkdir -p "$TMP/proj"
cp -R "$FIX/java-small/." "$TMP/proj/"
out="$(CLI init "$TMP/proj" 2>&1)"
check "init exit 0" 0 "$?"
missing=""
for f in agents/orchestrator.agent.md hooks/guard_write.mjs hooks/lib/ledger.mjs \
         scripts/harness-cli.mjs scripts/lib/analyzer.mjs .skills/harness/SKILL.md \
         templates/FS-功能规格.md test/hooks.test.sh AGENTS.md harness.config.json \
         .harness-manifest.json .claude/agents/orchestrator.md .zcode/config.json package.json; do
  [ -e "$TMP/proj/$f" ] || missing="$missing $f"
done
# 计数 bug 修复：缺文件时只记失败，不再无条件 pass++
if [ -z "$missing" ]; then
  printf "  \033[32m✓\033[0m %s\n" "安装产物齐全（14 项）"
  pass=$((pass + 1))
else
  printf "  \033[31m✗\033[0m 缺:%s\n" "$missing"
  fail=$((fail + 1))
fi
expect_out "build 收口输出 doctor" "doctor" "$out"
node -e 'const p=require(process.argv[1]);process.exit(p.scripts&&p.scripts["build:agents"]?0:1)' "$TMP/proj/package.json"
check "目标 package.json 带 build:agents" 0 "$?"
node -e 'const m=require(process.argv[1]);process.exit(m.status==="complete"?0:1)' "$TMP/proj/.harness-manifest.json"
check "manifest 落成 complete（不是 pending）" 0 "$?"
node -e 'const m=require(process.argv[1]);process.exit(m.generated.length>0&&m.generated.every(g=>g&&typeof g.path==="string"&&!g.path.endsWith("/agents")&&typeof g.sha256==="string"&&g.sha256.length>=8)?0:1)' "$TMP/proj/.harness-manifest.json"
check "manifest.generated 是带 hash 的文件清单（v3 契约）" 0 "$?"

echo "== 6. init：冲突不覆盖 =="
mkdir -p "$TMP/conflict"
echo "# 我们自己的常驻规则" > "$TMP/conflict/AGENTS.md"
CLI init "$TMP/conflict" >/dev/null 2>&1
check "已存在的 AGENTS.md 原样保留" 0 "$(grep -qF '我们自己的常驻规则' "$TMP/conflict/AGENTS.md" && echo 0 || echo 1)"
node -e 'const m=require(process.argv[1]);process.exit(m.files.some(f=>f.path==="AGENTS.md"&&f.action==="conflict")?0:1)' "$TMP/conflict/.harness-manifest.json"
check "manifest 记录 conflict" 0 "$?"

echo "== 7. init --agents read-only：子集生效 =="
mkdir -p "$TMP/ro"
CLI init "$TMP/ro" --agents read-only >/dev/null 2>&1
check "coder 未生成" 1 "$([ -e "$TMP/ro/.claude/agents/coder.md" ] && echo 0 || echo 1)"
check "spec-reviewer 已生成" 0 "$([ -e "$TMP/ro/.claude/agents/spec-reviewer.md" ] && echo 0 || echo 1)"
check "writes.json 不含 coder" 1 "$(grep -q '"coder"' "$TMP/ro/.ai/writes.json" && echo 0 || echo 1)"

echo "== 8. agents.enabled 非法清单 → build 拒绝（不是静默少生成） =="
mkdir -p "$TMP/ba"
cp -R "$HERE/agents" "$HERE/scripts" "$TMP/ba/"
cp "$HERE/harness.config.json" "$TMP/ba/"
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1]));c.agents={enabled:["coder"]};fs.writeFileSync(process.argv[1],JSON.stringify(c,null,2))' "$TMP/ba/harness.config.json"
out="$(cd "$TMP/ba" && node scripts/build-agents.mjs 2>&1)"
code=$?
expect_out "缺 orchestrator 被拒" "必须包含 orchestrator" "$out"
check "退出码 1" 1 "$code"

echo "== 9. remove：先预览后执行，外来内容不动 =="
mkdir -p "$TMP/proj/.ai/tasks/keep" "$TMP/proj/docs-mine"
echo '{}' > "$TMP/proj/.ai/tasks/keep/state.json"
echo 'own' > "$TMP/proj/docs-mine/README.md"
CLI remove "$TMP/proj" --dry-run >/dev/null 2>&1
check "dry-run 后文件仍在" 0 "$([ -e "$TMP/proj/agents/orchestrator.agent.md" ] && echo 0 || echo 1)"
CLI remove "$TMP/proj" --yes >/dev/null 2>&1
check "模板文件已删" 1 "$([ -e "$TMP/proj/agents/orchestrator.agent.md" ] && echo 0 || echo 1)"
check "生成物已删" 1 "$([ -e "$TMP/proj/.claude/agents" ] && echo 0 || echo 1)"
check "外来文件保留" 0 "$([ -f "$TMP/proj/docs-mine/README.md" ] && echo 0 || echo 1)"
check ".ai/tasks 保留（进度数据）" 0 "$([ -f "$TMP/proj/.ai/tasks/keep/state.json" ] && echo 0 || echo 1)"

echo "== 10. deny ledger：拦截落账 + 故障不影响判定 =="
export HARNESS_LEDGER_DIR="$TMP/ledger"
# 自测流量必须自报家门：否则装完跑一次测试就往真实账本里灌几十条必然命中的探测，
# 作为"误拦率基线"的 ledger 直接失去意义（case 36 断言这条标记真的落了）。
export HARNESS_LEDGER_SOURCE=selftest
# 载荷运行时拼出真值（源码不含字面量，CI 高危扫描才不误伤夹具；guard 收到的仍是同一条命令）
PAYLOAD='git push --fo'"rce origin main"
printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$PAYLOAD" \
  | node "$HERE/hooks/guard_command.mjs" >/dev/null 2>&1
check "force push 仍被拦（exit 2）" 2 "$?"
check "ledger 落账" 0 "$([ -f "$HARNESS_LEDGER_DIR/deny.jsonl" ] && echo 0 || echo 1)"
expect_out "账目含 hook 名" "guard_command" "$(cat "$HARNESS_LEDGER_DIR/deny.jsonl")"
expect_out "账目含拦截对象（被拦的那条命令）" "$PAYLOAD" "$(cat "$HARNESS_LEDGER_DIR/deny.jsonl")"
touch "$TMP/ledger-broken"   # 目录位置被文件占用 → mkdir 失败 → ledger 必须静默降级
HARNESS_LEDGER_DIR="$TMP/ledger-broken" bash -c '
  PAYLOAD="git push --fo""rce origin main"
  printf %s "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$PAYLOAD\"}}" \
  | node "'"$HERE"'/hooks/guard_command.mjs" >/dev/null 2>&1'
check "ledger 故障不改变判定（仍 exit 2）" 2 "$?"

echo "== 11. schema：未知版本两侧都显式报错 =="
mkdir -p "$TMP/gs/.ai/tasks/x"
printf '{"meta":{"schema_version":99,"task":"x"},"todos":[]}' > "$TMP/gs/.ai/tasks/x/state.json"
out="$(node "$HERE/scripts/ci-verify.mjs" --file "$TMP/gs/.ai/tasks/x/state.json" 2>&1)"
code=$?
expect_out "ci-verify 拒未知 schema" "[schema]" "$out"
check "退出码 1" 1 "$code"
node -e '
  const state = { meta: { schema_version: 99, task: "y" }, stage: "impl", todos: [] };
  const payload = { tool_name: "Write", tool_input: { file_path: ".ai/tasks/y/state.json", content: JSON.stringify(state) } };
  require("fs").writeFileSync(process.argv[1], JSON.stringify(payload));
' "$TMP/gs-payload.json"
out="$(HARNESS_ROOT="$TMP/gs" node "$HERE/hooks/guard_state.mjs" < "$TMP/gs-payload.json" 2>&1)"
code=$?
expect_out "guard_state 拒未知 schema" "高于本工具已知版本" "$out"
check "guard_state 退出码 2" 2 "$code"
mkdir -p "$TMP/gs2"
HARNESS_ROOT="$TMP/gs2" bash "$HERE/scripts/init-harness.sh" fresh-task M >/dev/null 2>&1
check "新档写入 schema_version" 1 "$(grep -c schema_version "$TMP/gs2/.ai/tasks/fresh-task/state.json")"

echo "== 12. analyze --out：symlink 指向目标内部同样被拒 =="
mkdir -p "$TMP/leakproj/src" "$TMP/leakproj/leakout"
echo 'export const a = 1;' > "$TMP/leakproj/src/a.ts"
ln -s "$TMP/leakproj/leakout" "$TMP/rep-link"
out="$(CLI analyze "$TMP/leakproj" --out "$TMP/rep-link" 2>&1)"
code=$?
expect_out "symlink 指进项目内被拒" "symlink" "$out"
check "拒绝退出码非 0" 1 "$([ $code -ne 0 ] && echo 1 || echo 0)"
check "目标项目内零写入" 0 "$(ls -A "$TMP/leakproj/leakout" 2>/dev/null | wc -l | tr -d ' ')"

echo "== 13. 嵌套构建根：各自成根，不合并成 services =="
mkdir -p "$TMP/mono/services/api" "$TMP/mono/services/web"
echo '<project/>' > "$TMP/mono/services/api/pom.xml"
echo '<project/>' > "$TMP/mono/services/web/pom.xml"
out="$(CLI detect "$TMP/mono" 2>&1)"
expect_out "api 是独立构建根" "services/api" "$out"
expect_out "web 是独立构建根" "services/web" "$out"
expect_out "同类型双根 → 要求选主栈" "只支持单主栈" "$out"
CLI init "$TMP/mono" --stack-dir services/api >/dev/null 2>&1
node -e 'const c=require(process.argv[1]);const p=Array.isArray(c.projects)?c.projects:Object.values(c.stacks||{});process.exit(p.some(x=>x.dir==="services/api")?0:1)' "$TMP/mono/harness.config.json"
check "--stack-dir 落到 projects 对应条目" 0 "$?"

echo "== 14. 重跑 init：manifest 合并，remove 仍然干净 =="
mkdir -p "$TMP/reinit"
CLI init "$TMP/reinit" >/dev/null 2>&1
out="$(CLI init "$TMP/reinit" 2>&1)"
expect_out "重跑仍执行 build（跳过只在 config 冲突时）" "build-agents" "$out"
created=$(node -e 'const m=require(process.argv[1]);console.log(m.files.filter(f=>f.action==="create").length)' "$TMP/reinit/.harness-manifest.json")
check "重跑后 create 记录仍在（不是全变 skip）" 1 "$([ "$created" -gt 50 ] && echo 1 || echo 0)"
CLI remove "$TMP/reinit" --yes >/dev/null 2>&1
check "重跑后 remove 仍能删掉模板文件" 1 "$([ -e "$TMP/reinit/agents/orchestrator.agent.md" ] && echo 0 || echo 1)"

echo "== 15. remove：不删 generated 目录里的用户文件；改过的文件要 --force =="
mkdir -p "$TMP/u"
CLI init "$TMP/u" >/dev/null 2>&1
echo "my own agent" > "$TMP/u/.claude/agents/mine.md"
echo "" >> "$TMP/u/AGENTS.md"   # 安装后改过 → sha256 不符
CLI remove "$TMP/u" --yes >/dev/null 2>&1
check "用户自加的 .claude/agents/mine.md 保留" 0 "$([ -f "$TMP/u/.claude/agents/mine.md" ] && echo 0 || echo 1)"
check "被改过的 AGENTS.md 不删（先警告）" 0 "$([ -f "$TMP/u/AGENTS.md" ] && echo 0 || echo 1)"
CLI remove "$TMP/u" --yes --force >/dev/null 2>&1
check "--force 后才删被改过的文件" 1 "$([ -f "$TMP/u/AGENTS.md" ] && echo 0 || echo 1)"
check "用户文件在 --force 下仍保留（不在 manifest）" 0 "$([ -f "$TMP/u/.claude/agents/mine.md" ] && echo 0 || echo 1)"

echo "== 16. check：打印运行时前提 =="
out="$(CLI check "$FIX/java-small" 2>&1)"
code=$?
expect_out "打印 node 版本" "node v" "$out"
expect_out "打印 bash 状态" "bash" "$out"
check "前提齐备时 exit 0" 0 "$code"

echo "== 17. 不支持的栈：只识别，不发明命令 =="
mkdir -p "$TMP/goproj"
echo 'module example.com/x' > "$TMP/goproj/go.mod"
echo 'package main' > "$TMP/goproj/main.go"
out="$(CLI detect "$TMP/goproj" 2>&1)"
expect_out "Go 标 unsupported" "unsupported" "$out"
CLI init "$TMP/goproj" >/dev/null 2>&1
node -e 'const c=require(process.argv[1]);const p=Array.isArray(c.projects)?c.projects:Object.values(c.stacks||{});const bad=p.some(x=>/go (test|vet)/.test(x.test||""));process.exit(bad?1:0)' "$TMP/goproj/harness.config.json"
check "config 里没有凭空生成的 Go 命令" 0 "$?"

echo "== 18. analysis.json 契约字段 =="
CLI analyze "$FIX/java-small" --out "$TMP/rep2" >/dev/null 2>&1
node -e '
  const r = require(process.argv[1]);
  const ok = r.schema_version === 3
    && Array.isArray(r.warnings)
    && r.evidence && typeof r.evidence.imports_parsed === "number"
    && r.tool && typeof r.tool.method === "string"
    && Array.isArray(r.edges) && Array.isArray(r.buildRoots);
  process.exit(ok ? 0 : 1);
' "$TMP/rep2/analysis.json"
check "含 schema_version / warnings / evidence / tool / edges / buildRoots" 0 "$?"
# v3 的新契约：四类 import 口径齐备、未解析留样本、明细边截断要显式标记。
# 这三样都是"报告可复核"的组成部分，缺一个就又回到"只有一个数字"。
node -e '
  const e = require(process.argv[1]).evidence;
  const ok = ["imports_resolved","imports_unresolved","imports_external","imports_stdlib"].every(k=>typeof e[k]==="number")
    && Array.isArray(e.unresolved_samples)
    && typeof e.harness_files_excluded === "number";
  process.exit(ok ? 0 : 1);
' "$TMP/rep2/analysis.json"
check "v3 evidence 四类口径 + 未解析样本 + 安装物计数齐备" 0 "$?"
check "edges_truncated 字段存在（null 表示未截断）" 0 "$(node -e '
  const r=require(process.argv[1]);
  const ok = Object.prototype.hasOwnProperty.call(r,"edges_truncated") && (r.edges_truncated===null || typeof r.edges_truncated.total==="number");
  console.log(ok?0:1);' "$TMP/rep2/analysis.json")"

echo "== 18b. 明细边上限（1.9MB 的 analysis.json 会让 agent 直接读不动） =="
CLI analyze "$FIX/java-small" --out "$TMP/edgecap" --max-edges 1 >/dev/null 2>&1
check "--max-edges 截断且把总数亮出来" 0 "$(node -e '
  const r=require(process.argv[1]);
  const ok=r.edges.length===1 && r.edges_truncated && r.edges_truncated.kept===1 && r.edges_truncated.total>1;
  console.log(ok?0:1);' "$TMP/edgecap/analysis.json")"
CLI analyze "$FIX/java-small" --out "$TMP/edgefull" --full-edges >/dev/null 2>&1
check "--full-edges 不截断（标记为 null，不是假的全量）" 0 "$(node -e '
  const r=require(process.argv[1]);
  console.log(r.edges_truncated===null?0:1);' "$TMP/edgefull/analysis.json")"
check "CLI 输出提示截断（不静默少几万条）" 0 "$(CLI analyze "$FIX/java-small" --out "$TMP/edgecap2" --max-edges 1 2>&1 | grep -qF "明细边已截断" && echo 0 || echo 1)"

echo "== 19. init 用探测结果适配 config（不再是模板占位值） =="
CLI init "$FIX/java-small" >/dev/null 2>&1
node -e 'const c=require(process.argv[1]);const p=Array.isArray(c.projects)?c.projects:Object.values(c.stacks||{});process.exit(c.project.name==="java-small"&&p.some(x=>x.dir===".")?0:1)' "$FIX/java-small/harness.config.json"
check "project.name 与 stacks 按探测回填" 0 "$?"
# init 之后项目里多了 hooks/*.mjs、scripts/*.mjs —— 它们是 harness 的安装物，不是业务代码。
# 不排除的话，"代码文件数/热点/巨石文件"会把这些工具算进项目，而报告读者以为那是业务。
CLI analyze "$FIX/java-small" --out "$TMP/inst-map" >/dev/null 2>&1
check "harness 安装物不进依赖图（无 hooks/ scripts/ 的节点）" 0 "$(node -e '
  const r=require(process.argv[1]);
  const bad=r.edges.filter(e=>/^(hooks|scripts)\//.test(e.from)||/^(hooks|scripts)\//.test(e.to));
  if(bad.length) console.error("残留："+JSON.stringify(bad.slice(0,3)));
  console.log(bad.length?1:0);' "$TMP/inst-map/analysis.json")"
check "evidence 报出排除了多少安装物（口径可复核）" 0 "$(node -e '
  const r=require(process.argv[1]);
  console.log((r.evidence.harness_files_excluded||0)>0?0:1);' "$TMP/inst-map/analysis.json")"

echo "== 20. 未知 flag 直接 usage（不被当成 positional 吞掉） =="
CLI init "$TMP/whatever" --stackdir svc-a >/dev/null 2>&1
check "拼错的 --stackdir → exit 64" 64 "$?"

echo "== 21. init：已有 package.json 合并 scripts（否则 npm run gate 是纸面的） =="
mkdir -p "$TMP/haspkg"
printf '{"name":"mine","scripts":{"build":"tsc"}}\n' > "$TMP/haspkg/package.json"
out="$(CLI init "$TMP/haspkg" 2>&1)"
expect_out "dry 输出提到合并 scripts" "合并 scripts" "$out"
node -e 'const p=require(process.argv[1]);process.exit(p.name==="mine"&&p.scripts.build==="tsc"&&p.scripts.gate&&p.scripts["build:agents"]?0:1)' "$TMP/haspkg/package.json"
check "保留原有键并补上 gate/build:agents" 0 "$?"
CLI remove "$TMP/haspkg" --yes >/dev/null 2>&1
check "merge 的 package.json 不被 remove 删除（不是我们建的）" 0 "$([ -f "$TMP/haspkg/package.json" ] && echo 0 || echo 1)"

echo "== 22. init：bash 缺失 → 拒绝安装（exit 69，零落盘） =="
mkdir -p "$TMP/nobash/bin" "$TMP/nobash/p"
printf '#!/bin/sh\nexit 1\n' > "$TMP/nobash/bin/bash"
chmod +x "$TMP/nobash/bin/bash"
PATH="$TMP/nobash/bin:$PATH" CLI init "$TMP/nobash/p" >/dev/null 2>&1
check "缺失 bash → exit 69" 69 "$?"
check "拒绝时零落盘" 0 "$(ls -A "$TMP/nobash/p" | wc -l | tr -d ' ')"

echo "== 32. projects 数组：多栈混合探测回填（v2 核心，TDasset 解锁件） =="
out="$(CLI detect "$FIX/multi-stack" --json 2>&1)"
check "Java + Go 两个构建根都识别到" 0 "$(node -e '
  const r=JSON.parse(process.argv[1]);
  const ok=r.buildRoots.some(b=>b.dir==="svc-java")&&r.buildRoots.some(b=>b.dir==="svc-go");
  console.log(ok?0:1);' "$out")"
check "Java 栈生成命令、Go 标 unsupported（不猜）" 0 "$(node -e '
  const r=JSON.parse(process.argv[1]);
  const java=r.stacks.find(s=>s.dir==="svc-java"&&s.supported);
  const go=r.stacks.find(s=>s.dir==="svc-go"&&!s.supported);
  console.log(java&&go?0:1);' "$out")"
# init 后 config 里 projects 是数组且含 Java 条目
mkdir -p "$TMP/multi-adopt"
CLI init "$TMP/multi-adopt" >/dev/null 2>&1
# init 用的是探测回填到目标，需要先有构建清单才能探测到——直接验证 config 结构
check "v2 allStacks 兼容：对象→数组" 0 "$(node -e '
  // 模拟 v1 对象形态的 config → allStacks 正确提取
  const {allStacks} = await import(process.argv[1] + "/scripts/lib/analyzer.mjs");
  const v1 = allStacks({stacks:{backend:{dir:".",srcGlob:"**/*.java"}}});
  const v2 = allStacks({projects:[{id:"backend",dir:"."},{id:"backend-go",dir:"svc-go"}]});
  const empty = allStacks({});
  console.log(v1.length===1 && v2.length===2 && empty.length===0 ? 0 : 1);
' "$HERE")"

echo "== 30. Go import 解析（TDC-Go 关系视图空白 → go.mod 前缀 + 包级索引） =="
CLI analyze "$FIX/go-small" --out "$TMP/go-map" >/dev/null 2>&1
check "Go import 解析到包内文件" 0 "$(node -e '
  const r=require(process.argv[1]);
  const ok=r.evidence.imports_unresolved===0
    && r.edges.some(e=>e.from==="main.go"&&e.to==="pkg/controller/reconcile.go");
  console.log(ok?0:1);' "$TMP/go-map/analysis.json")"
check "标准库（fmt/flag）不产生未解析" 0 "$(node -e '
  const r=require(process.argv[1]);
  console.log(r.evidence.imports_unresolved===0?0:1);' "$TMP/go-map/analysis.json")"
# 上一轮这两条断言的是同一个条件（都只判 unresolved===0），"2 条用例"其实只有 1 条覆盖。
# 换成两条互不重复的口径：函数体字符串不算 import（旧正则会把 return "..." 计进来），
# 以及四类互斥计数必须相加等于总数（任何一类漏算都会破坏这个恒等式）。
check "函数体里的字符串不算 import（只认 import 声明）" 2 "$(node -e '
  const r=require(process.argv[1]);
  console.log(r.evidence.imports_parsed);' "$TMP/go-map/analysis.json")"
check "四类口径互斥且相加等于总数" 0 "$(node -e '
  const e=require(process.argv[1]).evidence;
  const sum=e.imports_resolved+e.imports_unresolved+e.imports_external+e.imports_stdlib;
  if(sum!==e.imports_parsed) console.error(`${sum} !== ${e.imports_parsed}`);
  console.log(sum===e.imports_parsed?0:1);' "$TMP/go-map/analysis.json")"
check "标准库单独计数（不混进外部包）" 0 "$(node -e '
  const e=require(process.argv[1]).evidence;
  console.log(e.imports_stdlib===1&&e.imports_external===0?0:1);' "$TMP/go-map/analysis.json")"

echo "== 31. MyBatis 表血缘（mapper XML/注解 SQL → 数据表，DB 迁移影响面） =="
CLI analyze "$FIX/java-small" --out "$TMP/mb-map" >/dev/null 2>&1
check "XML mapper 表血缘（namespace→Java 接口 + 表名）" 0 "$(node -e '
  const r=require(process.argv[1]);
  const ok=r.tableLineage.some(t=>t.tables.includes("td_demo")&&t.tables.includes("td_app"));
  console.log(ok?0:1);' "$TMP/mb-map/analysis.json")"

echo "== 29. Maven Reactor 折叠 + 模块级聚合（TDC 实测：35 个假根、跨模块改动没有影响面视图） =="
out="$(CLI detect "$FIX/maven-reactor" --json 2>&1)"
check "子模块折叠（构建根只剩 .）" 0 "$(node -e '
  const r=JSON.parse(process.argv[1]);
  console.log(r.buildRoots.length===1 && r.buildRoots[0].dir==="." ? 0 : 1);' "$out")"
CLI analyze "$FIX/maven-reactor" --out "$TMP/reactor-map" >/dev/null 2>&1
check "模块依赖边 app→lib 聚合正确" 0 "$(node -e '
  const r=require(process.argv[1]);
  const ok=r.moduleGraph.some(e=>e.from==="app"&&e.to==="lib"&&e.weight===2)
    && r.modules.some(m=>m.dir==="app"&&m.files===1)
    && r.modules.some(m=>m.dir==="lib"&&m.files===2); // lib + lib/sub 同单元
  console.log(ok?0:1);' "$TMP/reactor-map/analysis.json")"
check "嵌套子模块归并到最近聚合单元" 0 "$(node -e '
  const r=require(process.argv[1]);
  const ok=r.modules.every(m=>m.dir!=="lib/sub"); // 不该单独出现
  console.log(ok?0:1);' "$TMP/reactor-map/analysis.json")"

echo "== 29b. 单模块项目也要有模块视图（此前 modules 恒为空，且无告警） =="
# 坑在 `f.startsWith(d + "/")`：d 为 "." 时前缀是 "./"，任何相对路径都不匹配，
# 于是根目录下的源码全部归不到任何模块。单模块/根目录放源码是最常见的项目形态，
# 夹具过去只覆盖了 reactor（子模块目录非 "."），这一支一直没被人走过。
CLI analyze "$FIX/java-small" --out "$TMP/single-map" >/dev/null 2>&1
check "java-small 的模块视图里有根模块 ." 0 "$(node -e '
  const r=require(process.argv[1]);
  const ok=r.modules.some(m=>m.dir==="."&&m.files===4);
  console.log(ok?0:1);' "$TMP/single-map/analysis.json")"
check "根模块的文件数不是 0（不是有键无值）" 0 "$(node -e '
  const r=require(process.argv[1]);
  const m=r.modules.find(x=>x.dir===".");
  console.log(m&&m.files>0?0:1);' "$TMP/single-map/analysis.json")"

echo "== 32. 血缘只认 SQL 结构：列名/参数名/注释掉的 SQL 都不算表 =="
# 旧实现把整个文件的字符串拼起来扫 from/join/update，TDC 实测 112 个"表"里
# 25 个是列名或参数名（appid / cpu / update_time / user…），占 22%。
# 血缘的用途是 DB 变更影响面——错表名比没有表名更糟，所以这里既断言"有"也断言"没有"。
CLI analyze "$FIX/mybatis-annot" --out "$TMP/annot-map" >/dev/null 2>&1
check "注解 SQL 只提取真表（td_user / td_order）" 0 "$(node -e '
  const r=require(process.argv[1]);
  const t=r.tableLineage.find(x=>x.mapper.endsWith("UserMapper.java"));
  const ok=t && JSON.stringify(t.tables)===JSON.stringify(["td_order","td_user"]);
  console.log(ok?0:1);' "$TMP/annot-map/analysis.json")"
check "参数名/列名/注释里的表都不进血缘" 0 "$(node -e '
  const r=require(process.argv[1]);
  const bad=["appid","cpu","cpu_usage","ghost_table","update_time","monitor"];
  const hit=r.tableLineage.flatMap(x=>x.tables).filter(t=>bad.includes(t));
  if(hit.length) console.error("误报："+hit.join(","));
  console.log(hit.length?1:0);' "$TMP/annot-map/analysis.json")"
check "XML 只取 statement 元素（注释语句/resultMap 列名不算）" 0 "$(node -e '
  const r=require(process.argv[1]);
  const t=r.tableLineage.find(x=>x.mapper.endsWith("OrderMapper.xml"));
  const ok=t && JSON.stringify(t.tables)===JSON.stringify(["td_order"]);
  console.log(ok?0:1);' "$TMP/annot-map/analysis.json")"


echo "== 28. Java FQN 解析 + 基础包多数派（TDC 1.1万/TDasset 2.9万假 unresolved 的解药） =="
CLI analyze "$FIX/java-small" --out "$TMP/fqn-map" >/dev/null 2>&1
check "第三方 import 不算 unresolved（=0）且重名类精确解析" 0 "$(node -e '
  const r=require(process.argv[1]); const e=r.evidence;
  const aEdges=r.edges.filter(x=>x.from.includes("demo/A.java"));
  const ok=e.imports_unresolved===0
    && aEdges.some(x=>x.to.includes("other/B.java"))
    && aEdges.some(x=>x.to.includes("demo/B.java"))
    && e.java_bases.length>=1;
  console.log(ok?0:1);' "$TMP/fqn-map/analysis.json")"
check "基础包进报告可复核（java_bases 非空）" 0 "$(node -e '
  const r=require(process.argv[1]);
  console.log((r.evidence.java_bases||[]).length>0?0:1);' "$TMP/fqn-map/analysis.json")"

echo "== 27. 项目 .gitignore 目录级推导（TDasset 实测：.worktrees 在项目 gitignore 里写着） =="
out="$(CLI detect "$FIX/gitignore-noise" --json 2>&1)"
check ".worktrees/ 与 snapshots/ 不出现在构建根" 0 "$(node -e '
  const r=JSON.parse(process.argv[1]);
  const bad=r.buildRoots.some(b=>b.dir.includes(".worktrees")||b.dir.includes("snapshots")&&b.dir.includes("scratch"));
  console.log(bad?1:0);' "$out")"
check "否定救回的 golden/snapshots 保留为构建根" 0 "$(node -e '
  const r=JSON.parse(process.argv[1]);
  console.log(r.buildRoots.some(b=>b.dir==="golden/snapshots")?0:1);' "$out")"

echo "== 26. Go 模块缓存（pkg/mod）不算构建根（TDC-Go 实测：220 个依赖淹死真项目） =="
out="$(CLI detect "$FIX/go-small" 2>&1)"
expect_out "识别到 Go 栈" "Go" "$out"
check "pkg/mod 不出现在构建根里" 1 "$(printf '%s' "$out" | grep -q "pkg/mod" && echo 0 || echo 1)"
out="$(CLI detect "$FIX/go-small" --json 2>&1)"
check "构建根只剩真项目（. / operator / test）" 0 "$(node -e '
  const r=JSON.parse(process.argv[1]);
  const ok=r.buildRoots.length===3 && [".","operator","test"].every(d=>r.buildRoots.some(x=>x.dir===d));
  console.log(ok?0:1);' "$out")"

echo "== 23. Node 命令从 package.json 推导（不硬编码、不发明） =="
mkdir -p "$TMP/nodesrv"
cat > "$TMP/nodesrv/package.json" <<'EOF'
{ "name": "nodesrv", "scripts": { "test": "vitest run", "lint": "eslint ." }, "devDependencies": { "vitest": "^1.0.0" } }
EOF
: > "$TMP/nodesrv/pnpm-lock.yaml"
out="$(CLI detect "$TMP/nodesrv" --json 2>&1)"
expect_out "test 取自 scripts（pnpm）" '"test": "pnpm run test"' "$out"
expect_out "testOne 按 vitest 推导" '"testOne": "pnpm exec vitest run <file>"' "$out"
expect_out "lint 取自 scripts" '"lint": "pnpm run lint"' "$out"
out="$(CLI detect "$FIX/vue-small" --json 2>&1)"
expect_out "无脚本不发明命令（test 留空）" '"test": ""' "$out"
expect_out "留空给出手填警告" 'stacks.test 留空' "$out"

echo "== 24. init 未完成必须失败退出（不能把坏现场当成功） =="
mkdir -p "$TMP/badcfg"
echo '{}' > "$TMP/badcfg/harness.config.json"
out="$(CLI init "$TMP/badcfg" 2>&1)"
code=$?
check "配置冲突 → exit 1" 1 "$code"
expect_out "输出点名冲突" "冲突" "$out"
node -e 'const m=require(process.argv[1]);process.exit(m.status==="incomplete"?0:1)' "$TMP/badcfg/.harness-manifest.json"
check "manifest.status=incomplete" 0 "$?"
# 空目录（无任何构建清单）也是刻意的 incomplete：stacks 留空待手填，doctor 会一直红到填完
mkdir -p "$TMP/emptyp"
out="$(CLI init "$TMP/emptyp" 2>&1)"
code=$?
check "空目录安装 → exit 1（未填 stacks 前不算装好）" 1 "$code"
expect_out "提示手填 stacks" "手填" "$out"

echo "== 25. remove 保护安装后被改过的生成文件 =="
mkdir -p "$TMP/prot"
CLI init "$TMP/prot" >/dev/null 2>&1
echo "// 用户手改" >> "$TMP/prot/.claude/agents/orchestrator.md"
out="$(CLI remove "$TMP/prot" --yes 2>&1)"
# 给了 --yes 却一个文件都没删，必须非零：exit 0 会让脚本把"什么都没删"当成"卸载完成"
check "remove --yes 有保护项 → exit 2（不是假成功）" 2 "$?"
expect_out "点名被改文件" "安装后被修改过" "$out"
expect_out "说明本次未删除任何文件" "未删除任何文件" "$out"
check "被改的生成文件保留" 0 "$([ -f "$TMP/prot/.claude/agents/orchestrator.md" ] && echo 0 || echo 1)"
mkdir -p "$TMP/protf"
CLI init "$TMP/protf" >/dev/null 2>&1
echo "// 用户手改" >> "$TMP/protf/.claude/agents/orchestrator.md"
CLI remove "$TMP/protf" --yes --force >/dev/null 2>&1
check "--force 才删被改文件" 1 "$([ -f "$TMP/protf/.claude/agents/orchestrator.md" ] && echo 0 || echo 1)"

echo "== 26. 重跑 init 后 remove 必须删净（含条件生成项） =="
# package.json / .gitignore / CI workflow 只有首装才进 plan；按 plan 重建 manifest 会把它们
# 从归属记录里除名，remove 后残留而输出仍称"退出干净"。
mkdir -p "$TMP/again"
CLI init "$TMP/again" >/dev/null 2>&1
CLI init "$TMP/again" >/dev/null 2>&1
CLI remove "$TMP/again" --yes >/dev/null 2>&1
left="$(ls -A "$TMP/again" | tr '\n' ' ')"
check "重跑后卸载无残留（只剩空目录）" "" "$left"

echo "== 27. 安装前就存在的生成物目录文件 → 归属不是我们，remove 保留 =="
mkdir -p "$TMP/preex/.claude/commands"
echo "# 我手写的部署命令" > "$TMP/preex/.claude/commands/deploy.md"
CLI init "$TMP/preex" >/dev/null 2>&1
node -e 'const m=require(process.argv[1]);process.exit(Array.isArray(m.foreign)&&m.foreign.includes(".claude/commands/deploy.md")?0:1)' "$TMP/preex/.harness-manifest.json"
check "用户既有文件记入 manifest.foreign" 0 "$?"
CLI remove "$TMP/preex" --yes >/dev/null 2>&1
check "remove 不删用户既有文件" 0 "$([ -f "$TMP/preex/.claude/commands/deploy.md" ] && echo 0 || echo 1)"

echo "== 28. build 覆盖用户既有生成物 → 备份 + 点名（覆盖可恢复） =="
mkdir -p "$TMP/over/.ai"
printf '{"my":"手写规则"}\n' > "$TMP/over/.ai/writes.json"
out="$(CLI init "$TMP/over" 2>&1)"
expect_out "点名被覆盖的文件" "覆盖了 1 个安装前已存在的文件" "$out"
expect_out "指出备份位置" ".ai/backup/" "$out"
check "原内容已备份" 0 "$(find "$TMP/over/.ai/backup" -name 'writes.json' 2>/dev/null | grep -q . && echo 0 || echo 1)"
check "备份内容就是原文件" 0 "$(grep -q '手写规则' "$(find "$TMP/over/.ai/backup" -name 'writes.json' | head -1)" && echo 0 || echo 1)"

echo "== 29. init 到不存在的目录：创建并说明，不是 ENOENT 崩溃 =="
out="$(CLI init "$TMP/brand-new" 2>&1)"
code=$?
expect_out "明说目录已创建" "已创建" "$out"
check "没有 node 堆栈" 1 "$(printf '%s' "$out" | grep -qE 'at (Object|ModuleJob|async)' && echo 0 || echo 1)"
check "目录与产物齐全" 0 "$([ -f "$TMP/brand-new/harness.config.json" ] && [ -d "$TMP/brand-new/hooks" ] && echo 0 || echo 1)"
check "全新项目：未填 stacks 前 exit 1（与空目录口径一致）" 1 "$code"

echo "== 30. 构建清单只看直属文件：根 package.json 不因下属 build.gradle 变 Java 栈 =="
mkdir -p "$TMP/gradle/sub/build"
printf '{"name":"fe","devDependencies":{"react":"18"}}\n' > "$TMP/gradle/package.json"
printf 'plugins{}\n' > "$TMP/gradle/sub/build/build.gradle"
out="$(CLI detect "$TMP/gradle" 2>&1)"
check "根目录不再被误判 Java/Gradle" 1 "$(printf '%s' "$out" | grep -qE 'Java/Gradle +dir=\.$' && echo 0 || echo 1)"
check "没有凭空撞车告警" 1 "$(printf '%s' "$out" | grep -q '撞车' && echo 0 || echo 1)"

echo "== 31. ci-verify：拼错的 flag / 缺值必须报错，不静默降级 =="
node "$HERE/scripts/ci-verify.mjs" --lcoal >/dev/null 2>&1
check "未知 flag → exit 64" 64 "$?"
node "$HERE/scripts/ci-verify.mjs" --file >/dev/null 2>&1
check "--file 缺值 → exit 64" 64 "$?"

echo "== 32. guides/ 随模板安装（orchestrator 引用了它，不能是死链） =="
check "需求变更指南已安装" 0 "$([ -f "$TMP/brand-new/guides/需求变更与Bug修复.md" ] && echo 0 || echo 1)"

echo "== 33. remove 遇 symlink：跳过并说明，不中断整场卸载 =="
mkdir -p "$TMP/lnk" "$TMP/ext-dir"
CLI init "$TMP/lnk" >/dev/null 2>&1
mv "$TMP/lnk/agents" "$TMP/ext-dir/agents"
ln -s "$TMP/ext-dir/agents" "$TMP/lnk/agents"
out="$(CLI remove "$TMP/lnk" --yes 2>&1)"
check "symlink 场景不中断（exit 0）" 0 "$?"
expect_out "说明跳过原因" "symlink" "$out"
check "链接指向的外部内容未动" 0 "$([ -f "$TMP/ext-dir/agents/orchestrator.agent.md" ] && echo 0 || echo 1)"
check "其余条目照常删净" 1 "$([ -d "$TMP/lnk/hooks" ] && echo 0 || echo 1)"
check "有跳过项时不说'退出干净'" 1 "$(printf '%s' "$out" | grep -q '退出干净' && echo 0 || echo 1)"

echo "== 34. resume：停在 blocker 上的任务必须有恢复入口 =="
# 真实任务（TDC 第一个任务）停在 adr、8 条决策等人裁决，此前没有任何工具能接回来：
# 用户只能手改 state.json —— 而手改正是门禁最该防的动作（漏 resolved_by、忘记重跑 gate）。
RS="$TMP/resume"
mkdir -p "$RS/.ai/tasks/t1"
cat > "$RS/.ai/tasks/t1/state.json" <<'JSON'
{
  "meta": { "schema_version": 1, "task": "t1", "type": "feature", "flow_tier": "L" },
  "stage": "adr",
  "stage_history": [{ "stage": "adr", "entered_at": "2026-10-31T09:10:00Z", "exited_at": null, "gate": "fail", "waived_by": null, "agent": "orchestrator" }],
  "artifacts": {},
  "todos": [
    { "id": "T1", "stack": "backend", "status": "pending", "text": "实现 A", "ooda_stage": "observe", "blocked_by": ["D1"] },
    { "id": "T2", "stack": "backend", "status": "pending", "text": "盘点现状", "ooda_stage": "observe" }
  ],
  "blockers": [
    { "type": "human_decision", "id": "D1", "question": "指标范围?", "options": ["磁盘", "CPU"], "recommendation": "先磁盘", "evidence": ["e1"], "resolved": false },
    { "type": "capability", "id": "B1", "question": "会话无 agent.spawn", "remediation": { "missing": "子 agent", "who": "用户", "rerun": "adr 门禁" }, "resolved": false }
  ],
  "gate_result": { "last_check": "2026-10-31T09:30:00Z", "stage": "adr", "checks": [{ "name": "adr_human_decision_records", "pass": false }] },
  "deviations": []
}
JSON
out="$(CLI resume "$RS" 2>&1)"; code=$?
check "有待决 blocker 时退出码 3（可被 CI/脚本判读）" 3 "$code"
expect_out "总览点名任务与卡点数" "未决 blocker 2" "$out"
out="$(CLI resume "$RS" t1 2>&1)"
expect_out "点名待裁决的决策 id" "D1" "$out"
expect_out "给出可立即开工的 TODO（不被已决策项挡住的那条）" "T2" "$out"
check "只读：state.json 未被改写" 1 "$(grep -q '"resolved": true' "$RS/.ai/tasks/t1/state.json" && echo 0 || echo 1)"

out="$(CLI resume "$RS" t1 --decide "D1=磁盘" 2>&1)"; code=$?
check "回填决策缺 --by → exit 64（无记名决策一律拒绝）" 64 "$code"
expect_out "说明为什么必须记名" "无记名" "$out"

out="$(CLI resume "$RS" t1 --decide "B1=x" --by 张三 2>&1)"; code=$?
check "用 --decide 处理能力阻断 → exit 64" 64 "$code"
expect_out "指向正确的开关" "--resolve" "$out"

out="$(CLI resume "$RS" t1 --decide "D9=x" --by 张三 2>&1)"; code=$?
check "未知 blocker id → exit 64" 64 "$code"

out="$(CLI resume "$RS" t1 --decide "D1=磁盘" --by 张三 2>&1)"; code=$?
check "回填一条决策后仍待决 → exit 3" 3 "$code"
node -e '
const s=require(process.argv[1]);const d=s.blockers.find(b=>b.id==="D1");
console.log([d.resolved===true, d.resolved_by==="张三", d.decision==="磁盘", !!d.resolved_at].every(Boolean)?"ok":"bad");
' "$RS/.ai/tasks/t1/state.json" > "$TMP/d1.txt"
check "落盘含 resolved/by/decision/时间四要素" "ok" "$(cat "$TMP/d1.txt")"
check "adr 决策检查随之转 pass" 0 "$(node -e 'const s=require(process.argv[1]);console.log(s.gate_result.checks.find(c=>c.name==="adr_human_decision_records").pass===true?0:1)' "$RS/.ai/tasks/t1/state.json")"

out="$(CLI resume "$RS" t1 --advance 2>&1)"; code=$?
check "还有未决 blocker 时 --advance 被拒（exit 3）" 3 "$code"

out="$(CLI resume "$RS" t1 --resolve "B1=换到有子 agent 的会话" --by 张三 2>&1)"; code=$?
check "阻断清空 → 自动推进，exit 0" 0 "$code"
expect_out "报出推进方向" "adr → fs_review" "$out"
node -e '
const s=require(process.argv[1]);
const h=s.stage_history;
console.log(s.stage==="fs_review" && h[h.length-2].gate==="pass" && h[h.length-2].exited_at && h[h.length-1].stage==="fs_review" ? "ok":"bad");
' "$RS/.ai/tasks/t1/state.json" > "$TMP/adv.txt"
check "stage 推进且历史收口（上一阶段 gate=pass + exited_at）" "ok" "$(cat "$TMP/adv.txt")"

echo "== 35. promotionDir 必须落在某个 agent 的 writes 里（否则定稿无处落盘） =="
check "模板自身覆盖 docs/plans/**" 1 "$(CLI check "$FIX/java-small" 2>&1 | grep -q 'promotionDir=' && echo 0 || echo 1)"
node -e '
const w=require(process.argv[1]);
console.log(Object.values(w.agents).flatMap(a=>a.writes).some(x=>x.startsWith("docs/plans"))?"ok":"bad");
' "$HERE/.ai/writes.json" > "$TMP/promo.txt"
check "orchestrator 写入域含 docs/plans/**" "ok" "$(cat "$TMP/promo.txt")"

echo "== 36. ledger 区分自测与真实拦截 =="
mine="$(node -e '
const fs=require("fs");
const p=process.argv[1];
if(!fs.existsSync(p)){console.log("none");process.exit(0)}
const l=fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const s=new Set(l.map(e=>e.source||"(missing)"));
console.log([...s].join(","));
' "$HARNESS_LEDGER_DIR/deny.jsonl")"
check "自测流量标 selftest（不污染真实拦截基线）" "selftest" "$mine"

echo "== 37. 装进项目后工具要能用在自己身上（resume .） =="
# 装完之后 CLI 就住在项目里，`resume .` 是最常用形态。把"禁止自复制"的安全规则
# 套到只读/进度类动词上，会让工具在自己的项目里直接失效（TDC 实测踩到）。
out="$(CLI resume "$HERE" 2>&1)"; code=$?
# 断言只针对"自操作不再被安全规则挡下"；退出码取决于是不是真的有任务
# （模板仓库通常没有 → 64；装进项目后通常有 → 3），两种都算通过。
check "resume 自身不再报'互相嵌套'" 1 "$(printf '%s' "$out" | grep -q '互相嵌套' && echo 0 || echo 1)"
check "退出码落在 0/3/64 之内（不是崩溃）" 0 "$([ "$code" = 0 ] || [ "$code" = 3 ] || [ "$code" = 64 ] && echo 0 || echo 1)"
out="$(CLI init "$HERE" --dry-run 2>&1)"; code=$?
check "init 仍拒绝自复制（安全内核不放宽）" 1 "$code"
expect_out "init 的拒绝理由照旧" "互相嵌套" "$out"

# 造一个停在 adr、有三档待决项的任务。
# D1 多选（必须现在定）/ D2 有前置（可缓）/ D3 有安全默认（可批）——
# 三档正好覆盖 triage 的三个分支。
mkdec() {
  mkdir -p "$1/.ai/tasks/t1"
  cat > "$1/.ai/tasks/t1/state.json" <<'JSON'
{
  "meta": { "schema_version": 1, "task": "t1", "type": "feature", "flow_tier": "L" },
  "stage": "adr",
  "todos": [],
  "gate_result": { "stage": "adr", "last_check": "2026-01-01T00:00:00Z", "checks": [{ "name": "adr_human_decision_records", "pass": false, "detail": "未决" }] },
  "blockers": [
    { "type": "human_decision", "id": "D1", "question": "哪些指标进规则?", "options": ["磁盘", "CPU", "内存"], "multi": true, "recommendation": "1,2", "evidence": ["MonitorController.java:1"], "resolved": false },
    { "type": "human_decision", "id": "D2", "question": "要不要总览页?", "options": ["仅补缺口", "新增总览页"], "defer_until": "T1", "recommendation": "等盘点", "resolved": false },
    { "type": "human_decision", "id": "D3", "question": "通知渠道?", "options": ["邮件+站内信", "加短信"], "default_ok": true, "recommendation": "邮件+站内信", "resolved": false }
  ]
}
JSON
}

# 往决策单里填一条（按 id 定位「回填：」行）
fill_md() {
  node -e '
const fs=require("fs");
const [p,id,val]=process.argv.slice(1);
const t=fs.readFileSync(p,"utf8").split("\n");
let cur=null;
for(let i=0;i<t.length;i++){
  const h=t[i].match(/^###\s+([A-Za-z]+\d+)/);
  if(h) cur=h[1];
  if(cur===id && /^-\s*回填[：:]/.test(t[i])) { t[i]="- 回填："+val; break; }
}
fs.writeFileSync(p,t.join("\n"));
' "$1" "$2" "$3"
}

echo "== 38. 停点落成决策单（可留存、可转发，而不是一次 stdout）=="
DEC="$TMP/dec1"
mkdec "$DEC"
out="$(CLI resume "$DEC" t1 2>&1)"
expect_out "给出恢复命令" "--from DECISIONS.md" "$out"
check "决策单已生成" 0 "$([ -f "$DEC/.ai/tasks/t1/DECISIONS.md" ] && echo 0 || echo 1)"
md="$(cat "$DEC/.ai/tasks/t1/DECISIONS.md")"
expect_out "第一档：必须现在决定（只有 D1）" "## 一、必须现在决定（1 项）" "$md"
expect_out "第二档：可以先干再定（D2 有前置）" "## 二、可以先干再定（1 项）" "$md"
expect_out "第三档：按建议默认（D3 有 default_ok）" "## 三、按建议默认即可" "$md"
expect_out "选项带编号（看到的 1/2/3 就是填回去的 1/2/3）" '`1` 磁盘' "$md"
expect_out "D2 标明前置" "前置：T1 完成后再定" "$md"

echo "== 39. 决策值必须落在选项内（枚举闭合，§16）=="
out="$(CLI resume "$DEC" t1 --decide "D2=随便" --by 测试 2>&1)"; code=$?
check "自由文本被拒（exit 64）" 64 "$code"
expect_out "报错列出合法选项" "不是合法选项" "$out"
out="$(CLI resume "$DEC" t1 --decide "D2=1,2" --by 测试 2>&1)"; code=$?
check "单选填两项被拒（exit 64）" 64 "$code"
expect_out "说明是单选并点出 multi" "multi 未置 true" "$out"
out="$(CLI resume "$DEC" t1 --decide "D1=1,3" --by 测试 2>&1)"; code=$?
# 剩下的 D2 有前置（defer_until）、D3 标了 default_ok —— 都不算阻塞，所以 exit 0。
# 三档分诊若只改显示不改判定，屏幕分了档、判定还按一档算，等于白分（P2-3）。
check "多选（multi=true）允许多项，且剩余项都属可稍后定 → exit 0" 0 "$code"
expect_out "回填为可读文本" "磁盘 + 内存" "$out"
expect_out "可稍后定的项单独点名" "可稍后定：2 项" "$out"

echo "== 40. 从决策单读回（--from）=="
DEC2="$TMP/dec2"
mkdec "$DEC2"
CLI resume "$DEC2" t1 >/dev/null 2>&1
fill_md "$DEC2/.ai/tasks/t1/DECISIONS.md" D1 "1,2"
fill_md "$DEC2/.ai/tasks/t1/DECISIONS.md" D3 "1"
out="$(CLI resume "$DEC2" t1 --from DECISIONS.md --by 袁源 2>&1)"; code=$?
# D2 未决但有前置（不挡路）→ 不再按 exit 3 计。挡住推进的只有"必须现在定"的档。
check "读回成功（D2 属可稍后定 → exit 0）" 0 "$code"
expect_out "点名回填了哪些" "D1=" "$out"
ids="$(node -e 'const s=require(process.argv[1]);const b=s.blockers.find(x=>x.id==="D1");console.log((b.decision_ids||[]).join(",")+"|"+b.resolved_by)' "$DEC2/.ai/tasks/t1/state.json")"
check "decision_ids 落盘（机器可判，不靠文本解析）" "1,2|袁源" "$ids"
d3="$(node -e 'const s=require(process.argv[1]);const b=s.blockers.find(x=>x.id==="D3");console.log(b.resolved===true&&b.decision==="邮件+站内信"?"ok":"bad")' "$DEC2/.ai/tasks/t1/state.json")"
check "勾选编号同样生效" "ok" "$d3"

echo "== 41. 人已经填好但没应用的输入，不能被刷新冲掉 =="
DEC3="$TMP/dec3"
mkdec "$DEC3"
CLI resume "$DEC3" t1 >/dev/null 2>&1
fill_md "$DEC3/.ai/tasks/t1/DECISIONS.md" D2 "1"
out="$(CLI resume "$DEC3" t1 2>&1)"
expect_out "点名有未应用的填写" "还没应用" "$out"
expect_out "说明不会覆盖" "没有覆盖" "$out"
check "填写仍在文件里" 0 "$(grep -q '^- 回填：1$' "$DEC3/.ai/tasks/t1/DECISIONS.md" && echo 0 || echo 1)"

echo "== 42. 批量接受建议只作用于第三档 =="
DEC4="$TMP/dec4"
mkdec "$DEC4"
out="$(CLI resume "$DEC4" t1 --accept-suggested --by 袁源 2>&1)"
r3="$(node -e 'const s=require(process.argv[1]);const b=s.blockers.find(x=>x.id==="D3");console.log(b.resolved===true&&(b.decision_ids||[]).join(",")==="1"?"ok":"bad")' "$DEC4/.ai/tasks/t1/state.json")"
check "default_ok 项被批（建议映射到选项编号）" "ok" "$r3"
r1="$(node -e 'const s=require(process.argv[1]);console.log(s.blockers.filter(b=>!b.resolved).map(b=>b.id).join(","))' "$DEC4/.ai/tasks/t1/state.json")"
check "第一、二档不动（只有 D3 被批）" "D1,D2" "$r1"

DEC5="$TMP/dec5"
mkdec "$DEC5"
CLI resume "$DEC5" t1 --accept-suggested --except D3 --by 袁源 >/dev/null 2>&1
r5="$(node -e 'const s=require(process.argv[1]);console.log(s.blockers.filter(b=>!b.resolved).length)' "$DEC5/.ai/tasks/t1/state.json")"
check "--except 排除的项不被批" 3 "$r5"
out="$(CLI resume "$DEC5" t1 --accept-suggested 2>&1)"; code=$?
check "批量接受同样必须记名（exit 64）" 64 "$code"
expect_out "说清为什么" "必须带 --by" "$out"

echo "== 43. 门禁没通过 / TODO 没收尾 → 不许推进（P1-1 实测复现过的假推进）=="
ADV="$TMP/adv"
mkdir -p "$ADV/.ai/tasks/t1"
cat > "$ADV/.ai/tasks/t1/state.json" <<'JSON'
{
  "meta": { "schema_version": 1, "task": "t1", "type": "feature", "flow_tier": "M" },
  "stage": "impl",
  "stage_history": [{ "stage": "impl", "entered_at": "2026-10-31T09:10:00Z", "exited_at": null, "gate": "fail", "waived_by": null, "agent": "orchestrator" }],
  "todos": [{ "id": "T1", "status": "pending", "text": "实现 A", "ooda_stage": "observe", "files": [] }],
  "blockers": [],
  "gate_result": { "stage": "impl", "last_check": "2026-10-31T09:30:00Z", "checks": [{ "name": "impl_verify_evidence", "pass": false }] }
}
JSON
out="$(CLI resume "$ADV" t1 --advance 2>&1)"; code=$?
check "gate 记着 fail + TODO 未收尾 → 拒绝推进（exit 3）" 3 "$code"
expect_out "点名是门禁没过" "门禁未通过" "$out"
expect_out "点名未收尾的 TODO" "实现阶段收尾" "$out"
st="$(node -e 'const s=require(process.argv[1]);const h=s.stage_history;console.log(s.stage+"|"+h[h.length-1].gate)' "$ADV/.ai/tasks/t1/state.json")"
check "state 未被改写（stage 与 gate 都保持原样，没被推进动作翻成 pass）" "impl|fail" "$st"

# 门禁全 pass、但 impl 里还留着 pending：仍然不许推进（否则"实现完了"是句空话）
node -e '
const fs=require("fs");const p=process.argv[1];const s=JSON.parse(fs.readFileSync(p,"utf8"));
s.gate_result.checks=[{ "name": "impl_verify_evidence", "pass": true }];
fs.writeFileSync(p, JSON.stringify(s,null,2));
' "$ADV/.ai/tasks/t1/state.json"
out="$(CLI resume "$ADV" t1 --advance 2>&1)"; code=$?
check "门禁全 pass 但 TODO 未收尾 → 仍拒绝（exit 3）" 3 "$code"
expect_out "说清是阶段收尾要求" "实现阶段收尾" "$out"

# 条件齐备时的推进：必须把 gate_result 清成「本阶段未评估」，不能把上一阶段的结论带走。
# 实测过的坏形态：TDC 的 state 漂到 stage=impl 时，gate_result.stage 还是 adr，
# 于是 impl 到底评没评，谁也说不出——最后靠人手清。工具不该产出这种状态。
# 用一个 rs 阶段、空 todos 的任务：这条只测"推进时怎么写 gate_result"，
# 掺进别的判据（TODO 证据链）就分不清是谁在拦。
ADV2="$TMP/adv2"
mkdir -p "$ADV2/.ai/tasks/t2"
cat > "$ADV2/.ai/tasks/t2/state.json" <<'JSON'
{
  "meta": { "schema_version": 1, "task": "t2", "type": "feature", "flow_tier": "S" },
  "stage": "rs",
  "stage_history": [{ "stage": "rs", "entered_at": "2026-10-31T09:10:00Z", "exited_at": null, "gate": "pending", "waived_by": null, "agent": "orchestrator" }],
  "todos": [],
  "blockers": [],
  "gate_result": { "stage": "rs", "last_check": "2026-10-31T09:30:00Z", "checks": [{ "name": "rs_doc", "pass": true }] }
}
JSON
out="$(CLI resume "$ADV2" t2 --advance 2>&1)"; code=$?
check "门禁全 pass → 放行推进" 0 "$code"
st="$(node -e 'const s=require(process.argv[1]);console.log(s.stage+"|"+s.gate_result.stage+"|"+(s.gate_result.checks||[]).length+"|"+String(s.gate_result.last_check))' "$ADV2/.ai/tasks/t2/state.json")"
check "推进后 gate_result 清成空、stage 同步到新阶段" "adr|adr|0|null" "$st"
hist_gate="$(node -e 'const s=require(process.argv[1]);const h=s.stage_history;console.log(h[0].gate+"|"+h[1].gate+"|"+h[0].exited_at)' "$ADV2/.ai/tasks/t2/state.json")"
case "$hist_gate" in
  pass"|"pending"|"*) r=ok ;;
  *) r="BAD: $hist_gate" ;;
esac
check "上一阶段记 pass 且有 exited_at，新阶段是 pending" ok "$r"
out="$(CLI resume "$ADV2" t2 2>&1)"
expect_out "清空后不会冒充已评估" "门禁尚未评估" "$out"

echo "== 44. 产物索引：显示缺失与形状异常，但不判死（advisory，P3-10）=="
ART="$TMP/art"
mkdir -p "$ART/.ai/tasks/t1" "$ART/docs"
: > "$ART/docs/rs.md"
cat > "$ART/.ai/tasks/t1/state.json" <<'JSON'
{
  "meta": { "schema_version": 1, "task": "t1", "type": "feature", "flow_tier": "M" },
  "stage": "rs",
  "todos": [],
  "blockers": [],
  "artifacts": {
    "rs": "docs/rs.md",
    "adr": "docs/adr-404.md",
    "fs_final": null,
    "promotion_note": "决策冻结后把定稿移到 docs/plans/"
  }
}
JSON
out="$(CLI resume "$ART" t1 2>&1)"; code=$?
check "索引不影响退出码（无阻塞无校验失败 → 0）" 0 "$code"
expect_out "报出索引统计" "产物索引  1/2 存在" "$out"
expect_out "缺失的产物被点名" "docs/adr-404.md" "$out"
expect_out "形状异常只提示不改写" "不是路径" "$out"
expect_out "给出找法，而不是判死" "按目录约定找" "$out"
st="$(node -e 'const s=require(process.argv[1]);console.log(JSON.stringify(s.artifacts))' "$ART/.ai/tasks/t1/state.json")"
check "state 里的 artifacts 一个字节都没被改" '{"rs":"docs/rs.md","adr":"docs/adr-404.md","fs_final":null,"promotion_note":"决策冻结后把定稿移到 docs/plans/"}' "$st"

echo "== 45. verify：统一验证入口（读磁盘，不读 hook 载荷）=="
# 这个子命令存在的理由，是让判据不再只能由"挂了 hook 的那条路"触发。
# 所以三条必须成立：不要 stdin payload、结论机器可读、口径拼错就报错（不静默降级）。
# 判据只有一份（scripts/ci-verify.mjs），这里只搭一个最小可判项目把入口跑通。
VPROJ="$TMP/vproj"
mkdir -p "$VPROJ/scripts" "$VPROJ/hooks/lib" "$VPROJ/.ai/tasks/demo"
cp "$HERE/scripts/ci-verify.mjs" "$VPROJ/scripts/"
cp "$HERE"/hooks/lib/*.mjs "$VPROJ/hooks/lib/"
cp "$HERE/harness.config.json" "$VPROJ/"
cp -R "$HERE/templates" "$VPROJ/templates"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1]+"/.ai/tasks/demo/state.json",JSON.stringify({meta:{schema_version:1,task:"demo",flow_tier:"S"},stage:"impl",stage_history:[{stage:"rs",gate:"pass"},{stage:"adr",gate:"deferred",waived_by:"张三（无架构级取舍）"},{stage:"fs_review",gate:"pass"},{stage:"wbs",gate:"pass"},{stage:"impl"}],todos:[],artifacts:{}},null,2))' "$VPROJ"
out="$(CLI verify "$VPROJ" --json 2>&1)"; code=$?
check "合规 state → 退出码 0" 0 "$code"
expect_out "结论可被机器读（ok:true）" '"ok": true' "$out"
expect_out "报出实际检过的 state" '"demo"' "$out"

# 反向用例：没有证据的完成态必须红。只证"能过"的入口等于给自己发绿灯。
node -e 'const fs=require("fs"),p=process.argv[1]+"/.ai/tasks/demo/state.json";const s=JSON.parse(fs.readFileSync(p,"utf8"));s.todos=[{id:"T1",title:"须有证据",status:"completed",files:[],verify:null,audit:null}];fs.writeFileSync(p,JSON.stringify(s,null,2))' "$VPROJ"
out="$(CLI verify "$VPROJ" --json 2>&1)"; code=$?
check "无证据的完成态 → 退出码 1" 1 "$code"
expect_out "结论可被机器读（ok:false）" '"ok": false' "$out"
expect_out "失败项能定位到具体 todo" 'T1' "$out"

CLI verify "$VPROJ" --mode locl >/dev/null 2>&1
check "拼错的 --mode 不许静默降级 → 64" 64 "$?"

CLI verify "$TMP" >/dev/null 2>&1
check "非 harness 目录 → 明确拒绝（非 0）" 1 "$?"



echo "== 46. 发布包必须带齐 init 声明要拷的模板文件 =="
# 实测过的坑：harness.rules.json 进了 TEMPLATE_FILES，却漏在 package.json 的 files 里。
# 源码仓库一切正常，装出来的项目 init 成功、审核路由每次 exit 2——装的时候不报错，
# 用的时候才红，而且红在一个跟"安装"看不出因果关系的地方。
# 用 --json：文件清单走 stdout 数据通道，不受 loglevel 影响——`npm run -s` 会注入
# loglevel=silent，把 notice 形式的清单全部吞掉，本地跑必红而 CI（不带 -s）绿，
# 两边不同答案（2026-11-11 CR Y4 根因）。
PACKED="$(cd "$HERE" && npm pack --dry-run --json 2>/dev/null)"
check "发布包含 harness.rules.json" 0 "$(printf '%s' "$PACKED" | grep -q 'harness\.rules\.json' && echo 0 || echo 1)"
check "发布包含 harness.config.json（对照组）" 0 "$(printf '%s' "$PACKED" | grep -q 'harness\.config\.json' && echo 0 || echo 1)"

echo "== 47. abandon：封存要带理由，且不改 stage（stage 是「死在哪一阶段」的证据）=="
# 这条命令存在的唯一理由：让 doctor 的停滞判据有**出口**。判据不能只有"你错了"——
# 没有一条命令能把红变绿，人学会的只会是忽略红灯。所以这里每条拒绝都要断言。
AB="$TMP/ab"
mkdir -p "$AB/.ai/tasks/z1" "$AB/.ai/tasks/z2" "$AB/.ai/tasks/z3"
mkab() { # mkab <slug> <stage> <todo状态>
  node -e '
  const fs = require("fs");
  const [root, slug, stage, todoStatus] = process.argv.slice(1);
  fs.writeFileSync(`${root}/.ai/tasks/${slug}/state.json`, JSON.stringify({
    meta: { schema_version: 1, task: slug, task_type: "feature", flow_tier: "S", created_at: "2026-10-01T00:00:00Z" },
    stage, todos: [{ id: "T1", status: todoStatus }],
  }, null, 2) + "\n");
  ' "$AB" "$1" "$2" "$3"
}
mkab z1 impl pending      # 正常目标
mkab z2 done completed    # 已完成：不该被封存
mkab z3 impl pending      # 重复封存用

out="$(CLI abandon "$AB" z1 2>&1)"
check "缺 --reason → 64（没有理由的封存等于静默删除）" 64 "$?"
# 光判退出码不够：缺理由和理由太短都是 64，所以"删掉缺理由那条检查"不会让它变红。
# 断言到具体文案，才真的在守"两种拒绝说两句话"。
expect_out "缺理由说的是「必须带 --reason」，而不是笼统的「太短」" "封存必须带 --reason" "$out"
CLI abandon "$AB" z1 --reason "停了" >/dev/null 2>&1
check "理由太短 → 64（写不清为什么，等于没写）" 64 "$?"
CLI abandon "$AB" z1 --reason "TODO" >/dev/null 2>&1
check "占位理由 → 64" 64 "$?"
CLI abandon "$AB" ../x --reason "想写到别处去试试" >/dev/null 2>&1
check "slug 含 ../ → 64（它会拼进写入路径）" 64 "$?"
CLI abandon "$AB" nope --reason "不存在的任务也要报出来" >/dev/null 2>&1
check "任务不存在 → 64" 64 "$?"
CLI abandon "$AB" z2 --reason "已经做完的任务不该被封存" >/dev/null 2>&1
check "stage=done → 3（封存是给「不再往下走」用的）" 3 "$?"

out="$(CLI abandon "$AB" z1 --reason "对账登记任务，产物已在 abc1234 交付，不补收尾" --by "张三" 2>&1)"; code=$?
check "合规封存 → 0" 0 "$code"
expect_out "打印未收尾项（封存时留下现场）" "T1" "$out"
st="$(node -e 'const s=require(process.argv[1]);const a=s.meta.abandoned||{};console.log([s.meta.status,a.at_stage,a.by,s.stage,a.open_todos.join(",")].join("|"))' "$AB/.ai/tasks/z1/state.json")"
check "写入 status/at_stage/by，且 stage 保持 impl 不被覆盖" "abandoned|impl|张三|impl|T1" "$st"
CLI abandon "$AB" z1 --reason "重复封存不该叠加第二条记录" >/dev/null 2>&1
check "重复封存 → 3（不叠第二条记录）" 3 "$?"
out="$(CLI resume "$AB" 2>&1)"
if printf '%s' "$out" | grep -q "z1"; then
  check "封存后不再出现在 resume 清单（清单有噪音就没人读）" 1 0
else
  check "封存后不再出现在 resume 清单（清单有噪音就没人读）" 1 1
fi

echo "== 48. 封存豁免「必须做完」的判据，不豁免「做过就得有证据」 =="
# 两个方向都要断言：只证"封存后不红了"是给自己发绿灯——
# 它必须红的场景是"把没做的事记成做了"（completed 但没日志）。
SV="$TMP/sv"
mkdir -p "$SV/scripts" "$SV/hooks/lib" "$SV/.ai/tasks/sealed" "$SV/.ai/tasks/live"
cp "$HERE/scripts/ci-verify.mjs" "$SV/scripts/"
cp "$HERE"/hooks/lib/*.mjs "$SV/hooks/lib/"
cp "$HERE/harness.config.json" "$SV/"
cp -R "$HERE/templates" "$SV/templates"
node -e '
const fs = require("fs");
const root = process.argv[1];
// 两个任务都越过产出阶段却没登记产物、gate_result 也停在旧阶段——
// 唯一的差别是 status。
const base = (slug, extra) => ({
  meta: Object.assign({ schema_version: 1, task: slug, task_type: "feature", flow_tier: "S", created_at: "2026-11-01T00:00:00Z" }, extra),
  stage: "impl",
  stage_history: [{ stage: "rs", gate: "pass" }, { stage: "adr", gate: "deferred", waived_by: "张三（无架构级取舍）" }, { stage: "fs_review", gate: "pass" }, { stage: "wbs", gate: "pass" }, { stage: "impl" }],
  todos: [{ id: "T1", status: "pending" }],
  artifacts: {},
  gate_result: { stage: "impl", checks: [] },
});
fs.writeFileSync(root + "/.ai/tasks/live/state.json", JSON.stringify(base("live", {}), null, 2));
fs.writeFileSync(root + "/.ai/tasks/sealed/state.json", JSON.stringify(base("sealed", {
  status: "abandoned",
  abandoned: { at: "2026-11-02T00:00:00Z", by: "张三", reason: "对账登记任务，产物已在 abc1234 交付，不补收尾", at_stage: "impl", open_todos: ["T1"], todos_total: 1 },
}), null, 2));
' "$SV"
out="$(CLI verify "$SV" --json 2>&1)"
# 这一条是**提示**不是阻塞（产物登记归人审），所以断言消息、不判断退出码——
# 拿 exit code 去测一条 notice，测出来的是"它变了没"，不是"它对不对"。
expect_out "未封存的任务缺产物登记 → 提示" "live: 阶段 impl 已越过产出阶段" "$out"
if printf '%s' "$out" | grep -q "sealed: 阶段 impl 已越过产出阶段"; then
  check "已封存的任务不再要求补登记" 1 0
else
  check "已封存的任务不再要求补登记" 1 1
fi

# 判据本身直接断言（不经 CLI）：封存豁免「必须做完」，但不豁免「封存要写理由」，
# 也不豁免「status 拼错」——后者才是真正会静默的那种错（拼错 = 永远 active）。
verdict="$(cd "$HERE" && node --input-type=module -e '
import { checkStageTodoClosure, checkStage } from "./hooks/lib/verify.mjs";
const base = { meta: { schema_version: 1, created_at: "2026-11-01T00:00:00Z" }, stage: "impl", todos: [{ id: "T1", status: "pending" }] };
const open = (m) => checkStageTodoClosure({ ...base, meta: { ...base.meta, ...m } }).length;
const stage = (m) => checkStage({ ...base, meta: { ...base.meta, ...m } }).filter((f) => f.rule === "stage").length;
const out = [
  open({}),
  open({ status: "abandoned", abandoned: { reason: "有理由的封存" } }),
  stage({ status: "abandoned", abandoned: { reason: "  " } }),
  stage({ status: "closed" }),
];
console.log(out.join(","));
' 2>&1)"
check "未封存拦 1 条 / 已封存 0 条 / 封存无理由判 / status 拼错判" "1,0,1,1" "$verdict"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1