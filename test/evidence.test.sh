#!/usr/bin/env bash
# 证据链自测 —— 重点是"在 CI 上不误杀"。
#
# 背景：CI 跑在全新 checkout 上，git 不保存 mtime。上一版在 CI 侧也用 mtime 判新鲜度，
# 结果一份完全合规的证据（真日志、exit_code=0、审计四项齐备）在 clone 里必然判红：
# 要么"日志早于源码"，要么"找不到任何已改动的源码文件"（files: [] 的统一验证 TODO）。
# 门禁把合规 PR 判红，比不设门禁更快让人关掉它。
#
# 所以这里的第一条用例就是这个回归：干净检出 + 合规证据 → 必须通过。
#
# 用法：bash test/evidence.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/repo"
rsync -a --exclude '.git' --exclude 'node_modules' "$HERE/" "$TMP/repo/"
cd "$TMP/repo"
# 项目自身的 .gitignore 与本测试无关，且会干扰：Java 项目常见的 *.log 规则会把
# .ai/verify/*.log 证据挡在库外，CI 口径按"未入库"判红（TDC 收编实测踩到）。
# 证据链与项目忽略策略的冲突由 init 检测并补托管块（试装反馈 #7），不在本测试职责内。
rm -f .gitignore
rm -rf .ai/tasks && mkdir -p .ai/tasks/demo .ai/tasks/demo-base .ai/verify src
# demo-base：change/bugfix 的关联目标（related_task 完成态会复核存在性）
# 零 TODO 的完成态现在要求写清理由（meta.no_todo_reason）：否则删光 todos 就是最便宜的全绿捷径。
printf '{"meta":{"task":"demo-base","no_todo_reason":"关联目标，仅用于追溯"},"stage":"done","todos":[]}\n' > .ai/tasks/demo-base/state.json
: > src/A.java
git init -q
git config user.email harness@example.com
git config user.name harness

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

age() {
  local t
  t=$(node -e 'const d=new Date(Date.now()-Number(process.argv[1])*36e5);const p=n=>String(n).padStart(2,"0");console.log(`${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`)' "$2")
  touch -t "$t" "$1"
}

log() {
  cat > ".ai/verify/$1.log" <<EOF
# cmd: mvn -q test
# started: 2026-01-01T00:00:00Z
# exit_code: $2
# ---- output tail ----
BUILD SUCCESS
EOF
}

# 合规状态：T1 声明文件，V1 是统一验证（files: []）
mk_state() {
  cat > .ai/tasks/demo/state.json <<'EOF'
{
  "meta": { "task": "demo", "flow_tier": "M", "trust_level": "L1" },
  "stage": "impl",
  "stage_history": [{ "stage": "rs", "gate": "pass", "waived_by": null }],
  "todos": [
    { "id": "T1", "status": "completed", "ooda_stage": "audit", "files": ["src/A.java"],
      "audit": { "compile": true, "tests": "pass", "feature_complete": true, "quality_clean": true },
      "verify": { "log_path": ".ai/verify/T1.log" } },
    { "id": "V1", "status": "completed", "ooda_stage": "audit", "files": [],
      "audit": { "compile": true, "tests": "pass", "feature_complete": true, "quality_clean": true },
      "verify": { "log_path": ".ai/verify/V1.log" } }
  ],
  "gate_result": { "stage": "impl", "last_check": "2026-01-01T00:00:00Z",
                   "checks": [ { "name": "impl_verify_evidence", "pass": true } ] }
}
EOF
}

ci() { local code=0; node scripts/ci-verify.mjs "$@" >/dev/null 2>"$TMP/err" || code=$?; echo "$code"; }

mk_state
log T1 0
log V1 0
git add -A
git commit -qm "compliant evidence"

echo "== 1. 干净检出 + 合规证据 → 必须通过（上一版必红的回归）=="
check "CI 口径不误杀合规证据" 0 "$(ci)"

echo "== 2. --file 只校验一份 state → 通过 =="
check "单文件校验" 0 "$(ci --file .ai/tasks/demo/state.json)"

echo "== 3. 日志 exit_code 非 0 → 拦截 =="
log T1 3
git add -A && git commit -qm "bad exit"
check "失败命令不能入库成完成态" 1 "$(ci)"
git checkout -q HEAD~1 -- .ai/verify/T1.log && git commit -qm "restore" >/dev/null

echo "== 4. 日志缺失 → 拦截 =="
rm -f .ai/verify/V1.log
git add -A && git commit -qm "drop log"
check "没有证据不算完成" 1 "$(ci)"
git checkout -q HEAD~1 -- .ai/verify/V1.log && git commit -qm "restore2" >/dev/null

echo "== 5. 日志未入库（只在本机）→ 拦截 =="
log T2 0
cp .ai/tasks/demo/state.json "$TMP/state.bak"
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.todos[1].id="T2";
  s.todos[1].verify.log_path=".ai/verify/T2.log";
  fs.writeFileSync(p, JSON.stringify(s,null,2));
'
git add .ai/tasks/demo/state.json && git commit -qm "state only, log untracked"
check "未入库日志不算证据" 1 "$(ci)"
cp "$TMP/state.bak" .ai/tasks/demo/state.json && rm -f .ai/verify/T2.log && git add -A && git commit -qm "restore3" >/dev/null

echo "== 6. waived 没有记名 → 拦截 =="
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.stage_history.push({stage:"sr",gate:"waived",waived_by:null});
  fs.writeFileSync(p, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "waived without name"
check "豁免必须记名" 1 "$(ci)"
git checkout -q HEAD~1 -- .ai/tasks/demo/state.json && git commit -qm "restore4" >/dev/null

echo "== 6b. 拼错的 status → CI 拦截（枚举闭合，状态不能藏出门禁）=="
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.todos[0].status="complted";
  fs.writeFileSync(p, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "typo status"
check "非法状态被 CI 拦住" 1 "$(ci)"
grep -q "status 非法" "$TMP/err" && r=0 || r=1
check "CI 输出点名非法状态" 0 "$r"
git checkout -q HEAD~1 -- .ai/tasks/demo/state.json && git commit -qm "restore5" >/dev/null

echo "== 6c. stage=done 但 TODO 未收尾 → CI 拦截（退出条件）=="
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.stage="done"; s.todos[1].status="doing";
  fs.writeFileSync(p, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "premature done"
check "stage=done 退出条件不满足被拦" 1 "$(ci)"
git checkout -q HEAD~1 -- .ai/tasks/demo/state.json && git commit -qm "restore6" >/dev/null

echo "== 6d. change 任务完成态缺追溯字段 → CI 拦截 =="
CHG_BASE="$(git rev-parse HEAD)"
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.stage="done";
  s.gate_result={stage:"done",last_check:"2026-01-01T00:00:00Z",checks:[{name:"retro_doc",pass:true}]};
  s.meta.task_type="change"; s.meta.related_task="demo-base";
  fs.writeFileSync(p, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "change missing trace"
check "change 缺 baseline/affected_ids/change_tier 被拦" 1 "$(ci)"
grep -q "baseline" "$TMP/err" && r=0 || r=1
check "CI 输出点名缺基线" 0 "$r"
# 补齐追溯字段 → 同一份证据放行
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.meta.baseline=process.argv[1]; s.meta.change_tier=2; s.meta.affected_ids=["US-4"];
  fs.writeFileSync(p, JSON.stringify(s,null,2));
' "$CHG_BASE"
git add -A && git commit -qm "change trace complete"
check "change 追溯字段齐备（真实 hash）→ 放行" 0 "$(ci)"
# baseline 是合法 hash 形态但不在历史里 → 仍拦
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.meta.baseline="deadbee";
  fs.writeFileSync(p, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "baseline phantom commit"
check "baseline commit 不在历史里被拦" 1 "$(ci)"
grep -q "仓库历史里不存在" "$TMP/err" && r=0 || r=1
check "CI 输出点名幽灵 commit" 0 "$r"
git checkout -q HEAD~3 -- .ai/tasks/demo/state.json && git commit -qm "restore7" >/dev/null

echo "== 6e. bugfix 完成态：回归测试须带红灯日志（修复前的失败运行）=="
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.stage="done";
  s.gate_result={stage:"done",last_check:"2026-01-01T00:00:00Z",checks:[{name:"retro_doc",pass:true}]};
  s.meta.task_type="bugfix"; s.meta.related_task="demo-base"; s.meta.affected_ids=["mod-a"];
  fs.writeFileSync(p, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "bugfix without regression"
check "bugfix 缺 kind=regression 的完成 TODO 被拦" 1 "$(ci)"
grep -q "regression" "$TMP/err" && r=0 || r=1
check "CI 输出点名缺回归测试" 0 "$r"
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.todos[0].kind="regression";
  fs.writeFileSync(p, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "regression without red log"
check "回归 TODO 缺红灯日志被拦" 1 "$(ci)"
grep -q "red_log_path" "$TMP/err" && r=0 || r=1
check "CI 输出点名缺红灯日志" 0 "$r"
# 红灯日志 exit 0 → 不是复现记录
cat > .ai/verify/RED.log <<'EOF'
# cmd: mvn -q test -Dtest=FooRegressionTest
# started: 2026-01-01T00:00:00Z
# exit_code: 0
# ---- output tail ----
BUILD SUCCESS
EOF
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.todos[0].red_log_path=".ai/verify/RED.log";
  fs.writeFileSync(p, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "red log that is green"
check "红灯日志 exit_code=0 被拦（修复前必须失败过）" 1 "$(ci)"
grep -q "必须是失败" "$TMP/err" && r=0 || r=1
check "CI 输出点名红灯日志不红" 0 "$r"
# 真红灯：失败运行 + 入库 → 放行
cat > .ai/verify/RED.log <<'EOF'
# cmd: mvn -q test -Dtest=FooRegressionTest
# started: 2026-01-01T00:00:00Z
# exit_code: 1
# ---- output tail ----
Tests run: 1, Failures: 1
EOF
git add -A && git commit -qm "real red log"
check "bugfix 有已完成回归 TODO + 红灯日志 → 放行" 0 "$(ci)"
git checkout -q HEAD~4 -- .ai/tasks/demo/state.json && git commit -qm "restore8" >/dev/null

echo "== 7. --local 仍判新鲜度：日志早于源码 → 拦截 =="
age .ai/verify/T1.log 48
age .ai/verify/V1.log 48
age src/A.java 1
check "本地口径拦陈旧证据" 1 "$(ci --local)"

echo "== 8. --local 把栈内未声明的源码改动也计入（srcGlob 生效）=="
age .ai/verify/T1.log 48
age .ai/verify/V1.log 48
age src/A.java 72
: > src/B.java
age src/B.java 1
check "未声明但同栈改动的源码使旧日志失效" 1 "$(ci --local)"

echo "== 9. --local 合规（日志晚于所有源码）→ 通过 =="
age src/A.java 72
age src/B.java 72
age .ai/verify/T1.log 1
age .ai/verify/V1.log 1
check "本地口径放行新鲜证据" 0 "$(ci --local)"

echo "== 10. stage 拼错 → CI 拦截（阶段名是判据，不是标签）=="
# init 曾写 stage:"intake"、人手写会写成 fs-review（连字符）：不在链上的阶段名
# 会让所有"按阶段"的判据静默跳过——门禁看起来在跑，实际一条都没命中。
cat > .ai/tasks/demo/state.json <<'EOF'
{ "meta": { "task": "demo" }, "stage": "fs-review", "todos": [] }
EOF
git add -A && git commit -qm "bad stage" --no-verify 2>/dev/null || git add -A
check "连字符阶段名被 CI 拦下" 1 "$(ci)"
grep -q "stage 非法" "$TMP/err" && r=0 || r=1
check "CI 输出点名 stage 非法" 0 "$r"

echo "== 11. 跳阶没记名 → CI 拦截；记名 → 放行 =="
cat > .ai/tasks/demo/state.json <<'EOF'
{ "meta": { "task": "demo" }, "stage": "impl", "stage_history": [ { "stage": "rs" }, { "stage": "impl" } ], "todos": [] }
EOF
git add -A
check "rs → impl 跳阶且无记名 → 拦" 1 "$(ci)"
grep -q "相邻阶段" "$TMP/err" && r=0 || r=1
check "报错说清是跳阶" 0 "$r"
cat > .ai/tasks/demo/state.json <<'EOF'
{ "meta": { "task": "demo" }, "stage": "impl", "stage_history": [ { "stage": "rs" }, { "stage": "impl", "waived_by": "张三" } ], "todos": [] }
EOF
git add -A
check "跳阶记了名 → 放行（可以跳，但要有人签字）" 0 "$(ci)"

# P1-2（实测：TDC 真实 history 是 `rs → wbs → adr → fs_review → impl`）：链序在
# 2026-11-02 改过一次（wbs 挪到 fs_review 之后）。存量 history 记的是当时的正式次序，
# 用新链判相邻会把合规的历史判成"跳阶且没记名"——于是人只剩两条路：改历史或关掉检查。
# 退休链必须认，否则这次判据变更的净效果是让人伪造记录。
cat > .ai/tasks/demo/state.json <<'EOF'
{ "meta": { "task": "demo" }, "stage": "impl", "stage_history": [ { "stage": "rs" }, { "stage": "wbs" }, { "stage": "adr" }, { "stage": "fs_review" }, { "stage": "impl" } ], "todos": [] }
EOF
git add -A
check "退休链序 rs→wbs→adr→fs_review→impl → 放行（当时不是跳阶）" 0 "$(ci)"

# 豁免只补"旧链相邻"这个事实，不是给跳阶开后门：逆序在两个链上都不相邻，仍要记名
cat > .ai/tasks/demo/state.json <<'EOF'
{ "meta": { "task": "demo" }, "stage": "adr", "stage_history": [ { "stage": "rs" }, { "stage": "adr" }, { "stage": "fs_review" }, { "stage": "adr" } ], "todos": [] }
EOF
git add -A
check "倒退回上一阶段（新旧链都不相邻）→ 仍拦" 1 "$(ci)"
grep -q "相邻阶段" "$TMP/err" && r=0 || r=1
check "报错仍说清是跳阶" 0 "$r"
git checkout -q HEAD -- .ai/tasks/demo/state.json 2>/dev/null || true

# 本组用例自带干净基线：前面用例的恢复链不可依赖（实测教训：叠加用例必须自带基线，
# 否则上游恢复不彻底时，下游用例在脏状态上跑，挂得莫名其妙）
mk_state
git add -A && git commit -qm "reset base for 14-16"

echo "== 14. 决策型工作包（#12）：证据=blockers 全 resolved，免 verify 日志 =="
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.blockers=[{type:"human_decision",question:"样例决策",resolved:true,resolved_by:"user",decision:"A"}];
  s.todos.push({id:"T9",kind:"decision",status:"done",ooda_stage:"audit",text:"决策包：裁决 D-x"});
  fs.writeFileSync(p,JSON.stringify(s,null,2));
'
git add -A && git commit -qm "decision todo ok"
check "决策包完成（blockers 全 resolved）合法" 0 "$(ci)"
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.blockers[0].resolved=false;
  fs.writeFileSync(p,JSON.stringify(s,null,2));
'
git add -A && git commit -qm "decision todo unresolved"
check "有未决 blocker 的决策包标完成 → 拦" 1 "$(ci)"
check "拦截信息点名决策未落全" 1 "$(node scripts/ci-verify.mjs 2>&1 | grep -c '决策没落全')"
git checkout -q HEAD~2 -- .ai/tasks/demo/state.json && git commit -qm "restore-11" >/dev/null

echo "== 15. gate=deferred 必须记名（范围裁决与豁免同律）=="
# 改造既有条目而不是追加新条目：新条目会触发阶段链跳阶校验（另一判据），遮蔽本用例
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.stage_history[s.stage_history.length-1].gate="deferred";
  s.stage_history[s.stage_history.length-1].waived_by=null;
  fs.writeFileSync(p,JSON.stringify(s,null,2));
'
git add -A && git commit -qm "deferred no name"
check "无记名的 deferred → 拦" 1 "$(ci)"
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.stage_history[s.stage_history.length-1].waived_by="user(仅出实现计划)";
  fs.writeFileSync(p,JSON.stringify(s,null,2));
'
git add -A && git commit -qm "deferred named"
check "记名的 deferred → 放行" 0 "$(ci)"
git checkout -q HEAD~2 -- .ai/tasks/demo/state.json && git commit -qm "restore-12" >/dev/null

echo "== 16. todo.stack 未注册 → 拦（枚举闭合，#9）=="
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.todos[0].stack="ghost";
  fs.writeFileSync(p,JSON.stringify(s,null,2));
'
git add -A && git commit -qm "ghost stack"
check "未注册栈 → 拦" 1 "$(ci)"
check "拦截信息列出合法栈" 1 "$(node scripts/ci-verify.mjs 2>&1 | grep -c '不是已注册栈')"
git checkout -q HEAD~1 -- .ai/tasks/demo/state.json && git commit -qm "restore-13" >/dev/null

# 本组用例自带干净基线（同前：上游恢复链不可依赖）
mk_state
log T1 0
log V1 0
git add -A && git commit -qm "reset base for 17-21"

echo "== 17. 日志头窗口：exit_code 必须在前 5 行（#16，贴来的 BUILD SUCCESS 不算证据）=="
{ echo "# 伪造头"; echo "# line2"; echo "# line3"; echo "# line4"; echo "# line5"; echo "# line6"; echo "# exit_code: 0"; cat .ai/verify/T1.log; } > /tmp/h.log && mv /tmp/h.log .ai/verify/T1.log
check "exit_code 埋在窗口外 → 拦" 1 "$(ci)"
log T1 0
git add -A && git commit -qm "restore-17"

echo "== 18. audit 数字与日志对账（#17，27/6/16 三版本并存的教训）=="
node -e '
  const fs=require("fs");
  const p=".ai/verify/T1.log"; const t=fs.readFileSync(p,"utf8");
  fs.writeFileSync(p, t.replace("# exit_code: 0", "# exit_code: 0\n# tests: total=16 failures=0 errors=0 skipped=0（来源 surefire-reports，非 stdout）"));
  const sp=".ai/tasks/demo/state.json"; const s=JSON.parse(fs.readFileSync(sp,"utf8"));
  s.todos[0].audit.tests="6/16";
  fs.writeFileSync(sp, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "audit match ok"
check "audit.tests 16 分母与日志 total=16 一致 → 放行" 0 "$(ci)"
node -e '
  const fs=require("fs");const sp=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(sp,"utf8")); s.todos[0].audit.tests="27/27";
  fs.writeFileSync(sp, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "audit mismatch"
check "audit.tests 27/27 与日志 total=16 → 拦" 1 "$(ci)"
check "拦截信息要求以日志为准" 1 "$(node scripts/ci-verify.mjs 2>&1 | grep -c '以日志为准')"
git checkout -q HEAD~2 -- .ai/tasks/demo/state.json .ai/verify/T1.log && git commit -qm "restore-18"

echo "== 19. done 前 deviations 必须处置（#19）=="
node -e '
  const fs=require("fs");const sp=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(sp,"utf8"));
  s.stage="done"; s.gate_result.stage="done";
  s.stage_history.push({stage:"done",gate:"pass",waived_by:"user(测试跳阶，记名)"});
  s.deviations=[{what:"@InternalApi 按 FS 应加但省略",why:"时间"}];
  fs.writeFileSync(sp, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "deviation open"
check "done 带未处置偏离 → 拦" 1 "$(ci)"
node -e '
  const fs=require("fs");const sp=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(sp,"utf8"));
  s.deviations[0].disposition="acknowledged"; s.deviations[0].by="user";
  fs.writeFileSync(sp, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "deviation acked"
check "偏离已记名处置 → 放行" 0 "$(ci)"
git checkout -q HEAD~2 -- .ai/tasks/demo/state.json && git commit -qm "restore-19"

echo "== 20. known_issues 收口闭环（#21）=="
node -e '
  const fs=require("fs");const sp=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(sp,"utf8"));
  s.stage="done"; s.gate_result.stage="done";
  s.stage_history.push({stage:"done",gate:"pass",waived_by:"user(测试跳阶，记名)"});
  s.known_issues=[{id:"KI-1",symptom:"console 3 例集成测试 MySQL 不可达",owner_todo:"T7"}];
  fs.writeFileSync(sp, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "ki open"
check "done 带未闭环 known_issue → 拦" 1 "$(ci)"
node -e '
  const fs=require("fs");const sp=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(sp,"utf8"));
  s.known_issues[0].resolution="T7 统一验证中跑通（MySQL 起 docker-compose）";
  fs.writeFileSync(sp, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "ki resolved"
check "known_issue 已给结论 → 放行" 0 "$(ci)"
git checkout -q HEAD~2 -- .ai/tasks/demo/state.json && git commit -qm "restore-20"

echo "== 21. gate_result 过期：CI 判红、local 仅提示（#20）=="
node -e '
  const fs=require("fs");const sp=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(sp,"utf8"));
  s.gate_result.stage="adr";
  // 本用例只测 gate_result 过期；V1 的 files:[] 在干净树 + local 口径下会撞
  // "找不到已改动源码"那条既有边界（与本用例无关），填上声明文件隔离干扰
  s.todos[1].files=["src/A.java"];
  fs.writeFileSync(sp, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "stale gate"
check "CI 口径：过期 gate_result → 拦" 1 "$(ci)"
touch .ai/verify/T1.log .ai/verify/V1.log   # local 口径判 mtime：先让日志比源码新，避免新旧平局干扰本用例
check "local 口径：仅提示不判死" 0 "$(ci --local)"
git checkout -q HEAD~1 -- .ai/tasks/demo/state.json && git commit -qm "restore-21"
echo "== 22. gitChangedFiles 不能吃掉首条目的首字符（实测：pom.xml → om.xml）=="
# 根因是 git() 对整段 stdout 做 trim()：第一条的状态位前导空格被吃掉，
# 之后固定 slice(3) 就多切一个字符。git 按字母序输出，Maven 仓库里 pom.xml
# 几乎总在第一条——恰好是 #18 最该抓到的那个文件，于是规则静默失效。
GT="$(mktemp -d)"
(
  cd "$GT" && git init -q . && git config user.email a@b && git config user.name t &&
  echo a > pom.xml && echo b > z.java && git add -A && git commit -qm init &&
  echo c >> pom.xml && echo d >> z.java
) >/dev/null 2>&1
out="$(node -e 'import(process.argv[1]).then(v=>process.stdout.write(v.gitChangedFiles(process.argv[2]).join(",")))' "$HERE/hooks/lib/verify.mjs" "$GT")"
check "首个改动文件是完整路径" "pom.xml,z.java" "$out"
# 新增目录要展开成文件：默认 porcelain 会把新目录压成一行 "?? .github/"，
# 新目录**里面**的基建文件从此拿不到路径，INFRA_RE 也就永远匹配不上。
( cd "$GT" && mkdir -p .github/workflows && echo x > .github/workflows/ci.yml ) >/dev/null 2>&1
out2="$(node -e 'import(process.argv[1]).then(v=>process.stdout.write(v.gitChangedFiles(process.argv[2]).join(",")))' "$HERE/hooks/lib/verify.mjs" "$GT")"
case ",$out2," in
  *",.github/workflows/ci.yml,"*) r=ok ;;
  *) r="BAD: $out2" ;;
esac
check "新增目录内的文件展开成具体路径（不是目录名）" ok "$r"
rm -rf "$GT"

echo "== 23. 未声明进任何 TODO 的构建基建文件 → CI 拦（#18 此前完全没有用例）=="
# 规则写了、用例没有、真跑时被上面那个截断 bug 静默放行——三种状态合起来
# 就是\"以为有门禁\"。这条用例同时钉住规则和 bug。
printf '<project/>\n' > pom.xml
git add -A
check "未声明的 pom.xml → 拦" 1 "$(ci)"
grep -q "pom.xml" "$TMP/err" && r=0 || r=1
check "报错点名 pom.xml（不是被切坏的 om.xml）" 0 "$r"
git rm -q --cached pom.xml && rm -f pom.xml && git commit -qm "drop-pom" >/dev/null 2>&1 || true

echo "== 24. 测试夹具里的 pom.xml 不算构建基建（该放的放）=="
# 夹具是"被检测的样本"，改了不影响任何人的构建。少了这条反向用例，
# 上面那条规则会因为改一个夹具就判红，然后被人整条关掉——误报比漏报更能杀死规则。
mkdir -p test/fixtures/demo && printf '<project/>\n' > test/fixtures/demo/pom.xml
git add -A
check "改测试夹具不判红" 0 "$(ci)"
rm -rf test/fixtures/demo

echo "== 25. 未跟踪的基建文件只提示，不判红（大仓库里天天有）=="
# 未跟踪说明"仓库里有东西没入库"，可能是别人留下的半成品、构建产物、整片新目录。
# 拿它当"改动了构建基建"的证据，真仓库里会天天报红，然后这条规则就被关掉了。
printf 'all:\n\techo hi\n' > Makefile
check "未跟踪的 Makefile 不判红" 0 "$(ci)"
out="$(node scripts/ci-verify.mjs 2>&1)"
case "$out" in
  *Makefile*) r=ok ;;
  *) r="BAD: 未跟踪文件应当仍出现在提示里" ;;
esac
check "但仍然可见（不静默丢弃）" ok "$r"
rm -f Makefile


echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
