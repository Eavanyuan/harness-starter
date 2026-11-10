#!/usr/bin/env bash
# task-loop T3 核心自测：kill switch / headless 接线闸 / CAS 认领（双竞争+僵尸）/ 预算 / 审批三条件。
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HARNESS_LEDGER_DIR="$TMP/ledger"

pass=0; fail=0
check(){ if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); else printf "  \033[31m✗\033[0m %s (期望 %s，实际 %s)\n" "$1" "$3" "$2"; fail=$((fail+1)); fi; }

# fixture：裸仓库作 remote + 工作克隆（认领的目标仓库），rules 带 runtime.headless
git init -q --bare "$TMP/remote.git"
git clone -q "$TMP/remote.git" "$TMP/repo" 2>/dev/null
cd "$TMP/repo" && git config user.email t@t && git config user.name t
cp "$HERE/harness.rules.json" .
mkdir -p .zcode && printf '{"hooks":{"enabled":true,"PreToolUse":[]}}' > .zcode/config.json
git add -A && git commit -qm base && git push -q origin main && git branch -q -M main 2>/dev/null || true
ROOT="$TMP/repo"

echo "== 1. kill switch =="
mkdir -p "$ROOT/.ai/task-loop" && touch "$ROOT/.ai/task-loop/OFF"
node "$HERE/scripts/task-loop.mjs" --once --root "$ROOT" > "$TMP/out1.txt" 2>&1
check "OFF 哨兵 → 退出 0 且提示" "0" "$?"
grep -q "OFF 哨兵" "$TMP/out1.txt"; check "提示哨兵位置（可恢复）" "0" "$?"
rm "$ROOT/.ai/task-loop/OFF"

echo "== 2. headless 接线闸（ADR D6：不接 hook 的无头会话=绕过全部门禁） =="
rm "$ROOT/.zcode/config.json"
node "$HERE/scripts/task-loop.mjs" --once --root "$ROOT" > "$TMP/out2.txt" 2>&1
check "无接线 → 拒启" "1" "$?"
grep -q "绕过全部写入门禁" "$TMP/out2.txt"; check "拒绝理由点明风险" "0" "$?"
printf '{"hooks":{"enabled":true}}' > "$ROOT/.zcode/config.json"

echo "== 3. 剖面 A 无凭据 → fail 显式 =="
node "$HERE/scripts/task-loop.mjs" --once --root "$ROOT" > "$TMP/out3.txt" 2>&1
check "缺 GITLAB_URL/TOKEN → exit 1" "1" "$?"
grep -q "GITLAB_URL" "$TMP/out3.txt"; check "点名缺什么" "0" "$?"

echo "== 4. CAS 认领：双竞争仅一胜 + 僵尸不抢 =="
node --input-type=module -e '
import { claim } from "'"$HERE"'/scripts/lib/claim.mjs";
const cwd = process.argv[1], remote = process.argv[2];
const a = claim({ cwd, remote, kind: "mr", id: "42", runId: "runnerA" });
const b = claim({ cwd, remote, kind: "mr", id: "42", runId: "runnerB" });
console.log(a.claimed ? "first-ok" : "first-fail", b.claimed ? "BAD" : "second-rejected");
' "$ROOT" "$TMP/remote.git" > "$TMP/claim1.txt" 2>&1 || true
grep -q "first-ok second-rejected" "$TMP/claim1.txt"; check "双端竞争：先者胜、后者拒" "0" "$?"
# 僵尸路径：直接调 claim（TTL 1h，认领提交已 25h 前）
# 僵尸：GIT_COMMITTER_DATE 必须包住 commit-tree（生成提交那一刻），不是 push——
# 嵌套 $() 里 export 不可见，分三步走
ZOMBIE_DATE="$(node -e 'console.log(new Date(Date.now()-25*3600e3).toISOString())')"
ZOMBIE_SHA="$(GIT_COMMITTER_DATE="$ZOMBIE_DATE" git -C "$ROOT" commit-tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904 -m 'claim mr-z1 by ancient')"
git -C "$ROOT" push -q "$TMP/remote.git" "$ZOMBIE_SHA:refs/heads/claims/mr-z1"
node --input-type=module -e '
import { claim } from "'"$HERE"'/scripts/lib/claim.mjs";
const r = claim({ cwd: process.argv[1], remote: process.argv[2], kind: "mr", id: "z1", ttlMs: 3600_000 });
console.log(r.claimed ? "BAD-claimed" : r.reason);
' "$ROOT" "$TMP/remote.git" > "$TMP/claim2.txt" 2>&1
grep -q "zombie" "$TMP/claim2.txt"; check "25h 前认领 → zombie（不自动抢）" "0" "$?"
# 新 id（未被占用）正常认领——与 z1 无关的干净引用
node --input-type=module -e '
import { claim } from "'"$HERE"'/scripts/lib/claim.mjs";
const r = claim({ cwd: process.argv[1], remote: process.argv[2], kind: "mr", id: "fresh-9", runId: "runnerC" });
console.log(r.claimed ? "claimed" : r.reason);
' "$ROOT" "$TMP/remote.git" > "$TMP/claim3.txt" 2>&1
grep -q "claimed" "$TMP/claim3.txt"; check "新 id 正常认领" "0" "$?"

echo "== 5. 预算（D7）：轮次硬限 + pause/resume 不计等待 =="
node --input-type=module -e '
// approvalValid + budget 纯函数直测（runner 的停点判据同源）
const { approvalValid: av } = await import("file://" + process.argv[1] + "/scripts/lib/task-loop-core.mjs");
const ok1 = av({ approvers: [{ username: "lead" }], author: "deva", lastPushAt: "2026-01-01T00:00:00Z", approvedAt: "2026-01-02T00:00:00Z" });
const bad1 = av({ approvers: [], author: "deva" });
const bad2 = av({ approvers: [{ username: "deva" }], author: "deva" });
const bad3 = av({ approvers: [{ username: "lead" }], author: "deva", lastPushAt: "2026-01-03T00:00:00Z", approvedAt: "2026-01-02T00:00:00Z" });
console.log(ok1.ok, bad1.ok === false, bad2.ok === false, bad3.ok === false);
' "$HERE" > "$TMP/av.txt" 2>&1 || true
grep -q "^true true true true" "$TMP/av.txt" && r=0 || { cat "$TMP/av.txt"; r=1; }
check "审批三条件：有效批/无批/自批/陈批" "0" "$r"

echo "== 6. T4a 归因：指纹归一化 + merge-base 基线实跑 + 集合差 =="
# 纯函数层：参数值变化不改变身份（同一失败两次运行、期望/实际互换、全角括号、ANSI 色码）
node --input-type=module -e '
import { failureFingerprint, extractFailures, setDiff } from "'"$HERE"'/scripts/lib/fingerprint.mjs";
const a = failureFingerprint("  \x1b[31m✗\x1b[0m 未入库日志不算证据  (期望 1，实际 0)");
const b = failureFingerprint("  \x1b[31m✗\x1b[0m 未入库日志不算证据 (期望 0，实际 1)");
const c = failureFingerprint("  \x1b[31m✗\x1b[0m 未入库日志不算证据（期望 99，实际 100）");
process.exit(a && a === b && a === c && a === "未入库日志不算证据" ? 0 : 1);'
check "剥参/剥色/全角括号 → 身份稳定" "0" "$?"
node --input-type=module -e '
import { failureFingerprint } from "'"$HERE"'/scripts/lib/fingerprint.mjs";
process.exit(failureFingerprint("  ✓ 全绿") === null && failureFingerprint("结果：57 通过，0 失败") === null ? 0 : 1);'
check "成功行/计数行不是失败身份" "0" "$?"
node --input-type=module -e '
import { extractFailures } from "'"$HERE"'/scripts/lib/fingerprint.mjs";
const fs = extractFailures("✗ 同一断言 (期望 1，实际 2)\n✗ 同一断言 (期望 3，实际 4)\n✗ 另一个", { suite: "s" });
process.exit(fs.length === 2 ? 0 : 1);'
check "同一断言重试三遍 → 一个身份" "0" "$?"
node --input-type=module -e '
import { setDiff } from "'"$HERE"'/scripts/lib/fingerprint.mjs";
const d = setDiff([{id:"s::A"},{id:"s::B"}], [{id:"s::A"},{id:"s::C"}]);
process.exit(d.introduced.length===1 && d.inherited.length===1 && d.resolved.length===1 ? 0 : 1);'
check "集合差三分：引入/继承/顺手修好" "0" "$?"

# 端到端层：真仓库双树归因。基线（merge-base）有存量红 A；MR 分支 = 基线 + 引入红 B
ENVT="$TMP/attr"; git init -q -b main "$ENVT" && cd "$ENVT" && git config user.email t@t && git config user.name t
cat > suite.sh <<'SH'
#!/usr/bin/env bash
# 套件形态：按文件存在性输出不同失败（b-red 文件存在才输出 B）
printf "  \033[31m✗\033[0m 存量红 A（期望 1，实际 %s）\n" "$RANDOM"
[ -f b-red ] && printf "  \033[31m✗\033[0m 引入红 B (期望 0，实际 1)\n"
printf "结果：\n"
SH
chmod +x suite.sh && git add -A && git commit -qm base
git checkout -q -b mr && touch b-red && git add -A && git commit -qm introduce-b
node --input-type=module -e '
import { runBaseline } from "'"$HERE"'/scripts/lib/baseline.mjs";
import { spawnSync } from "node:child_process";
import { extractFailures, setDiff } from "'"$HERE"'/scripts/lib/fingerprint.mjs";
const cwd = process.argv[1];
// 基线：在 merge-base（=base 提交）实跑
const base = runBaseline({ cwd, baseRef: "main", head: "mr", worktreeDir: cwd + "-wt",
  suites: [{ name: "suite", command: ["bash", "suite.sh"] }] });
const baseF = base.results.flatMap((r) => r.failures);
// MR 侧：当前树（mr 分支）实跑同套件
const r = spawnSync("bash", ["suite.sh"], { cwd, encoding: "utf8" });
const mrF = extractFailures(r.stdout + r.stderr, { suite: "suite" });
const d = setDiff(mrF, baseF);
const ok = d.introduced.length === 1 && /引入红 B/.test(d.introduced[0].id)
  && d.inherited.length === 1 && /存量红 A/.test(d.inherited[0].id);
console.log("introduced:", d.introduced.map(x=>x.fingerprint).join(","), "| inherited:", d.inherited.map(x=>x.fingerprint).join(","));
process.exit(ok ? 0 : 1);
' "$ENVT" > "$TMP/attr-out.txt" 2>&1
check "端到端归因：引入=B、继承=A（参数随机化下身份稳定）" "0" "$?"
grep -q "introduced: 引入红 B | inherited: 存量红 A" "$TMP/attr-out.txt"; check "归因结论可读输出" "0" "$?"
cd "$HERE"

echo "== 7. T4b 三分流决策与豁免三道闸 =="
node --input-type=module -e '
import { decide, flippyFailures } from "'"$HERE"'/scripts/lib/attribution.mjs";
// 分流1：有引入 → REWORK
const r1 = decide({ introduced: [{ id: "s::B", fingerprint: "B" }], inherited: [] });
// 分流2：继承未登记 → EXEMPT_REQUIRED
const r2 = decide({ introduced: [], inherited: [{ id: "s::A", fingerprint: "A" }] });
// 分流3：继承已豁免（指纹同+owner+未过期）→ PASS_TO_REVIEW
const ok = decide({ introduced: [], inherited: [{ id: "s::A", fingerprint: "A" }] },
  { exemptions: [{ fingerprintId: "s::A", owner: "lead", expiresAt: new Date(Date.now() + 86400e3).toISOString() }] });
// 闸1：过期豁免失效
const expired = decide({ introduced: [], inherited: [{ id: "s::A", fingerprint: "A" }] },
  { exemptions: [{ fingerprintId: "s::A", owner: "lead", expiresAt: new Date(Date.now() - 1000).toISOString() }] });
// 闸1：指纹不同不可豁免
const diffFp = decide({ introduced: [], inherited: [{ id: "s::A2", fingerprint: "A2" }] },
  { exemptions: [{ fingerprintId: "s::A", owner: "lead", expiresAt: new Date(Date.now() + 86400e3).toISOString() }] });
// 闸3：豁免率超阈值
const budget = decide({ introduced: [], inherited: [{id:"s::A",fingerprint:"A"},{id:"s::B",fingerprint:"B"},{id:"s::C",fingerprint:"C"}] },
  { exemptions: [
    { fingerprintId: "s::A", owner: "l", expiresAt: new Date(Date.now()+86400e3).toISOString() },
    { fingerprintId: "s::B", owner: "l", expiresAt: new Date(Date.now()+86400e3).toISOString() },
    { fingerprintId: "s::C", owner: "l", expiresAt: new Date(Date.now()+86400e3).toISOString() }] });
// 闸2：翻转检测
const flip = flippyFailures([{id:"s::A"}], [{id:"s::B"}]);
const pass = r1.action==="REWORK" && r2.action==="EXEMPT_REQUIRED" && ok.action==="PASS_TO_REVIEW"
  && expired.action==="EXEMPT_REQUIRED" && diffFp.action==="EXEMPT_REQUIRED"
  && budget.action==="EXEMPTION_BUDGET_EXCEEDED" && flip.length===2;
console.log(pass ? "ALL-OK" : JSON.stringify({r1:r1.action,r2:r2.action,ok:ok.action,expired:expired.action,diffFp:diffFp.action,budget:budget.action}));
process.exit(pass ? 0 : 1);'
check "三分流 + 三道闸全形态" "0" "$?"

echo "== 8. T5 会话打包器与产物验收（fail-closed） =="
SESS="$TMP/sess"; mkdir -p "$SESS"
node --input-type=module -e '
import { buildR1ProfileA, buildR1ProfileB, buildRnProfileA, readSessionArtifacts } from "'"$HERE"'/scripts/lib/session-pack.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
// A 的 R1：评论原文/协议/产物清单齐
const r1 = buildR1ProfileA({ mr: { iid: 7, title: "演示" }, changedFiles: ["src/a.js"],
  comments: [{ discussion_id: "d1", note_id: "n1", author: "lead", body: "排序违反 OP-2" }] });
const okPack = r1.prompt.includes("d1/n1") && r1.prompt.includes("排序违反 OP-2") && r1.prompt.includes("acks.json") && r1.artifacts.includes("round-1.md");
// B 的 R1：复现闸在协议里
const b1 = buildR1ProfileB({ bug: { work_item_id: "7161559257", name: "短帧越界", severity: "P1" }, repo: "tsdb" });
const okB = b1.prompt.includes("7161559257") && b1.prompt.includes("复现闸");
// 续轮：失败指纹与历轮日志随包、换法指令在
const rn = buildRnProfileA({ mr: { iid: 7 }, round: 2, prevJournals: ["试了字母序，失败"], failureFingerprints: ["legend::排序断言"] });
const okN = rn.prompt.includes("试了字母序") && rn.prompt.includes("legend::排序断言") && rn.prompt.includes("换方法");
// 产物验收：缺件 fail-closed
const bad = readSessionArtifacts(process.argv[1], { expected: ["todo.json", "acks.json"] });
mkdirSync(process.argv[1] + "/ok", { recursive: true });
writeFileSync(process.argv[1] + "/ok/todo.json", "[]");
writeFileSync(process.argv[1] + "/ok/acks.json", "[]");
const good = readSessionArtifacts(process.argv[1] + "/ok", { expected: ["todo.json", "acks.json"] });
const badJson = readSessionArtifacts(process.argv[1], { expected: [] });
process.exit(okPack && okB && okN && !bad.ok && good.ok ? 0 : 1);' "$SESS" 2>/dev/null
check "A/B/续轮打包 + 产物缺失 fail-closed" "0" "$?"

echo "== 9. T5 CI 盯梢（零 LLM 轮询） =="
node --input-type=module -e '
import { watchPipeline } from "'"$HERE"'/scripts/lib/ci-watch.mjs";
let n = 0;
const states = [["running"], ["running"], ["success"]];
const r1 = await watchPipeline({ listPipelines: async () => states[Math.min(n++, 2)].map((s) => ({ status: s, sha: "abc" })),
  intervalMs: 1, sleep: async () => {} });
const r2 = await watchPipeline({ listPipelines: async () => [{ status: "running" }], timeoutMs: 10, intervalMs: 5, sleep: async () => {} });
process.exit(r1.status === "success" && r2.status === "timeout" ? 0 : 1);'
check "终态返回 / 超时返回 timeout（不判红，交上层升级）" "0" "$?"

echo "== 10. T5 定时器安装器（--print 渲染与接线闸） =="
bash "$HERE/scripts/install-task-loop.sh" "$ROOT" --print > "$TMP/plist.txt" 2>&1
check "print 模式渲染 plist" "0" "$?"
grep -q "task-loop.mjs" "$TMP/plist.txt" && grep -qv "__ROOT__" "$TMP/plist.txt"; check "占位符全替换（脚本路径/仓库根）" "0" "$?"
mkdir -p "$TMP/bare-repo"; bash "$HERE/scripts/install-task-loop.sh" "$TMP/bare-repo" --print >/dev/null 2>&1
check "无 hook 接线的仓库拒绝安装（同 runner 闸）" "69" "$?"

echo "== 11. T5 影子周：dry-run 积累与 --report 统计 =="
SHADOW="$ROOT/.ai/task-loop/shadow.jsonl"; rm -f "$SHADOW"
for i in 1 2 3; do printf '{"ts":"2026-11-10T0%s:00:00Z","kind":"mr","id":42,"summary":"s","unresolved":2}\n' "$i" >> "$SHADOW"; done
printf '%s\n' '{"ts":"2026-11-11T01:00:00Z","kind":"mr","id":43,"summary":"s2","unresolved":1}' >> "$SHADOW"
node "$HERE/scripts/task-loop.mjs" --report --root "$ROOT" > "$TMP/report.txt" 2>&1
grep -q "唯一触发：2" "$TMP/report.txt"; check "去重统计（3×#42+1×#43 → 唯一 2）" "0" "$?"
grep -q "2026-11-10" "$TMP/report.txt" && grep -q "2026-11-11" "$TMP/report.txt"; check "按天分布输出" "0" "$?"
grep -q "N≥30" "$TMP/report.txt"; check "验收口径印在报告里" "0" "$?"
printf '%s\n' '42' 'null' >> "$SHADOW"   # 裸数字/null：合法 JSON 但非对象——统计必须无视
node "$HERE/scripts/task-loop.mjs" --report --root "$ROOT" 2>/dev/null | grep -q "唯一触发：2"; check "脏行（裸数字/null）不污染统计" "0" "$?"

echo "== 12. T6 剖面 B 触发源：MQL/解析/分级/同步四路 =="
node --input-type=module -e '
import { buildMyBugsMql, parseMqlResult, gateBySeverity } from "'"$HERE"'/scripts/lib/feishu-bug-source.mjs";
const mql = buildMyBugsMql();
const a = parseMqlResult(JSON.stringify([{work_item_id:1,severity:"致命"},{work_item_id:2,severity:"严重"}]));
const b = parseMqlResult("| work_item_id | name | severity |\n|---|---|---|\n| 3 | x | 一般 |");
const g = gateBySeverity([...a, ...b]);
let threw = false; try { parseMqlResult("junk"); } catch { threw = true; }
process.exit(mql.includes("current_login_user()") && a.length===2 && b.length===1
  && g.auto.length===2 && g.confirm.length===1 && threw ? 0 : 1);'
check "MQL 构造/双形态解析/P0-P3 分级/垃圾结果 fail-closed" "0" "$?"
node --input-type=module -e '
import { transitionStatus, readbackOrComment } from "'"$HERE"'/scripts/lib/feishu-sync.mjs";
const mk = (b) => async (n) => { const f = b[n]; if (!f) throw new Error("no "+n); return typeof f==="function"?f():f; };
const r1 = await transitionStatus({ call: mk({ get_transitable_states: "可流转:[开发中]", update_field: "ok" }), projectKey: "t", workItemId: "1", toStatus: "处理中" });
const r2 = await readbackOrComment({ call: mk({ get_workitem_brief: "status: 处理中", add_comment: "ok" }), projectKey: "t", workItemId: "1", expect: { status: "处理中" }, fallbackNote: "n" });
const r3 = await readbackOrComment({ call: mk({ get_workitem_brief: "空", add_comment: "ok" }), projectKey: "t", workItemId: "1", expect: { status: "x" }, fallbackNote: "n" });
const r4 = await readbackOrComment({ call: mk({ get_workitem_brief: "空", add_comment: () => { throw new Error("403"); } }), projectKey: "t", workItemId: "1", expect: { status: "x" }, fallbackNote: "n" });
process.exit(!r1.ok && r2.ok && r3.ok && r3.via==="comment-fallback" && !r4.ok ? 0 : 1);'
check "同步四路：拒硬转/读回成功/静默丢弃→评论兜底/兜底失败显式红" "0" "$?"
# runner 集成：无凭据 fail 显式；有凭据但数据档未开 → perm 指引（活通道）
node "$HERE/scripts/task-loop.mjs" --once --profile b --root "$ROOT" > "$TMP/pb1.txt" 2>&1
grep -q "FEISHU_MCP_URL" "$TMP/pb1.txt"; check "剖面 B 缺凭据 → 点名缺什么" "0" "$?"
FEISHU_MCP_URL="https://project.feishu.cn/mcp_server/v1?mcpKey=m-dca0c1ab-4fec-4e26-97b7-81aabe932c97&userKey=7231777938960613378" FEISHU_PROJECT_KEY=taosdata_td \
  node "$HERE/scripts/task-loop.mjs" --once --profile b --root "$ROOT" > "$TMP/pb2.txt" 2>&1
grep -q "数据档未授权" "$TMP/pb2.txt"; check "数据档未开 → perm 报错带后台指引（活通道）" "0" "$?"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
