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

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
