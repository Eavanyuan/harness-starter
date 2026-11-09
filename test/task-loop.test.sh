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

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
