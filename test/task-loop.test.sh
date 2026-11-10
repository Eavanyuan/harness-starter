#!/usr/bin/env bash
# task-loop T3 核心自测：kill switch / headless 接线闸 / CAS 认领（双竞争+僵尸）/ 预算 / 审批三条件。
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HARNESS_LEDGER_DIR="$TMP/ledger"
# 凭据文件必须隔离：本机若真装过定时器，默认落点 ~/.harness/task-loop/task-loop.env 里
# 会有真实 token，于是"未接入 → exit 0/1"那几条会在开发机和 CI 上给出不同结论——
# 同一份代码两种答案，比没有判据更坏。指向不存在的路径 = 明确"本套件不用凭据文件"。
export HARNESS_ENV_FILE="$TMP/no-such-task-loop.env"

pass=0; fail=0; skip=0
check(){ if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); else printf "  \033[31m✗\033[0m %s (期望 %s，实际 %s)\n" "$1" "$3" "$2"; fail=$((fail+1)); fi; }

# fixture：裸仓库作 remote + 工作克隆（认领的目标仓库），rules 带 runtime.headless
git init -q --bare "$TMP/remote.git"
git clone -q "$TMP/remote.git" "$TMP/repo" 2>/dev/null
cd "$TMP/repo" && git config user.email t@t && git config user.name t
cp "$HERE/harness.rules.json" .
mkdir -p .zcode && printf '{"hooks":{"enabled":true,"PreToolUse":[]}}' > .zcode/config.json
git add -A && git commit -qm base && git branch -q -M main && git push -q origin main
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

echo "== 3. 剖面 A 显式指定但无凭据 → fail 显式 =="
# 注意这里是**显式** --profile a：接入是扩展条件，不给 profile 且没接入时应退出 0（见 3b）。
# 但"我就要跑 A"是一句断言，缺配置却静默跳过是最糟的结果，所以显式时缺配置必须 exit 1。
node "$HERE/scripts/task-loop.mjs" --once --root "$ROOT" --profile a > "$TMP/out3.txt" 2>&1
check "缺 GITLAB 配置 → exit 1" "1" "$?"
grep -q "GITLAB_TOKEN" "$TMP/out3.txt"; check "点名缺什么" "0" "$?"

echo "== 3b. 一个源都没接 → 退出 0（不接不算故障），并逐条说明缺什么 =="
# 配置里显式留空 projectKey 与 gitlab.url，模拟"还没接任何系统"的仓库
NR="$TMP/nosource"; mkdir -p "$NR/.zcode"
cp "$HERE/harness.rules.json" "$NR/"
node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p));j.runtime.feishu.projectKey="";j.runtime.gitlab.url="";fs.writeFileSync(p,JSON.stringify(j,null,2))' "$NR/harness.rules.json"
printf '{"hooks":{"enabled":true}}' > "$NR/.zcode/config.json"
env -u GITLAB_URL -u GITLAB_TOKEN -u FEISHU_PROJECT_KEY -u FEISHU_MCP_URL HOME="$TMP/nohome" \
  node "$HERE/scripts/task-loop.mjs" --once --root "$NR" > "$TMP/out3b.txt" 2>&1
check "未接入 → exit 0" "0" "$?"
grep -q "未接入任何触发源" "$TMP/out3b.txt"; check "明说未接入（不是装作跑过）" "0" "$?"
grep -q "runtime.gitlab.url" "$TMP/out3b.txt"; check "指出 GitLab 缺什么" "0" "$?"
grep -q "runtime.feishu.projectKey" "$TMP/out3b.txt"; check "指出飞书缺什么" "0" "$?"

echo "== 3c. 空 username 必须抛错，不许把自己的留言当成他人的打回 =="
# 实测：同一条讨论，username="me" → triggered=false；username="" → triggered=true 且 reviewState=changes_requested。
# 空串不是"没有他人"而是"不知道谁是我"，判不了就该拒绝，而不是给一个看起来正常的结论。
node --input-type=module -e '
import { unresolvedByOthers, classifyMr } from "'"$HERE"'/scripts/lib/gitlab-triggers.mjs";
const discs = [{ id: "d", notes: [{ id: 1, resolvable: true, resolved: false, author: { username: "me" }, body: "我自己问的" }] }];
const r = {};
try { unresolvedByOthers(discs, ""); r.u = "NO-THROW"; } catch { r.u = "throw"; }
try { classifyMr({ mr: { iid: 1, sha: "abc", author: { username: "me" } }, discussions: discs, username: "" }); r.c = "NO-THROW"; } catch { r.c = "throw"; }
r.mine = unresolvedByOthers(discs, "me").length;
console.log([r.u, r.c, r.mine].join(","));
process.exit(r.u === "throw" && r.c === "throw" && r.mine === 0 ? 0 : 1);' > "$TMP/out3c.txt" 2>&1
check "空 username 两处都抛错，正常值下自己的留言不计" "0" "$?"

echo "== 3d. username 从 token 派生（不配 GITLAB_USERNAME 也能判对） =="
# 上一版靠 GITLAB_USERNAME，而 install-task-loop.sh 从来没注入过它 → 定时器里恒为空串。
# 现在改成 GET /user：token 是谁就是谁。这条断言同时盯"真的问过 /user"和"自己的留言被排除"。
TG="$TMP/derive"; mkdir -p "$TG/.zcode"
cp "$HERE/harness.rules.json" "$TG/"
printf '{"hooks":{"enabled":true}}' > "$TG/.zcode/config.json"
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const [here, repo, ledger] = process.argv.slice(1);
const seen = [];
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const p = q.url.split("?")[0]; seen.push(p);
  if (p === "/api/v4/user") return s.end(JSON.stringify({ username: "derived-me" }));
  if (p === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 5, project_id: 1, title: "x", sha: "abc", author: { username: "derived-me" } }]));
  if (/discussions$/.test(p)) return s.end(JSON.stringify([{ id: "d", notes: [
    { id: 1, system: false, resolvable: true, resolved: false, author: { username: "lead" }, body: "改", created_at: "2026-11-09T10:00:00Z" },
    { id: 2, system: false, resolvable: true, resolved: false, author: { username: "derived-me" }, body: "我自己追问的一句", created_at: "2026-11-09T11:00:00Z" }] }]));
  if (/repository\/commits/.test(p)) return s.end(JSON.stringify({ committed_date: "2026-11-09T09:00:00Z" }));
  if (/approvals$/.test(p)) return s.end(JSON.stringify({ approved_by: [] }));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--dry-run", "--profile", "a", "--root", repo], {
  env: { ...process.env, GITLAB_URL: "http://127.0.0.1:" + srv.address().port, GITLAB_TOKEN: "f", GITLAB_USERNAME: "", HARNESS_LEDGER_DIR: ledger },
});
let out = ""; let err = "";
child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
const code = await new Promise((r) => child.on("close", r));
srv.close();
const asked = seen.includes("/api/v4/user");
const oneOnly = /修复 1 条未解决讨论/.test(out);
console.log([code, asked ? "asked" : "no-ask", oneOnly ? "one" : "wrong", err.includes("username") ? "ERR:" + err.slice(0, 60) : "clean"].join(" "));
' "$HERE" "$TG" "$TMP/ledgerDerive" > "$TMP/out3d.txt" 2>&1
grep -q "^0 asked one clean$" "$TMP/out3d.txt" && r=0 || { cat "$TMP/out3d.txt"; r=1; }
check "问了 /user，且只把他人那 1 条算作待修" "0" "$r"

echo "== 4. CAS 认领：双竞争仅一胜 + 僵尸不抢 =="
node --input-type=module -e '
import { claim } from "'"$HERE"'/scripts/lib/claim.mjs";
const cwd = process.argv[1], remote = process.argv[2];
const a = claim({ cwd, remote, kind: "mr", id: "42", runId: "runnerA" });
const b = claim({ cwd, remote, kind: "mr", id: "42", runId: "runnerB" });
console.log(a.claimed ? "first-ok" : "first-fail", b.claimed ? "BAD" : "second-rejected");
' "$ROOT" "$TMP/remote.git" > "$TMP/claim1.txt" 2>&1 || true
grep -q "first-ok second-rejected" "$TMP/claim1.txt"; check "双端竞争：先者胜、后者拒" "0" "$?"
# 僵尸路径：认领发生在**另一台机器**上——本机没有那个提交对象。
# 上一版 fixture 在同一个仓库里造 25h 前的提交再 push，对象天然在本地，等于走了真实路径
# 之外的分支：跨机时 git show 直接失败，被外层 catch 吞成 taken，僵尸判不出来，MR 永久锁死。
# 造数据的距离必须等于生产的距离，所以这里用 A/B 两个独立克隆，并反过来断言 B 确实没有该对象。
XL="$TMP/xm"; git init -q --bare "$XL/r.git"
git clone -q "$XL/r.git" "$XL/A" 2>/dev/null; git clone -q "$XL/r.git" "$XL/B" 2>/dev/null
( cd "$XL/A" && git config user.email t@t && git config user.name t && echo x > f && git add -A && git commit -qm base && git push -q origin HEAD:main )
( cd "$XL/B" && git config user.email t@t && git config user.name t && git fetch -q origin && git reset -q --hard origin/main )
ZOMBIE_DATE="$(node -e 'console.log(new Date(Date.now()-25*3600e3).toISOString())')"
ZOMBIE_SHA="$(cd "$XL/A" && GIT_COMMITTER_DATE="$ZOMBIE_DATE" git commit-tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904 -m 'claim mr-z1 by ancient')"
git -C "$XL/A" push -q "$XL/r.git" "${ZOMBIE_SHA}:refs/heads/claims/mr-z1"
if git -C "$XL/B" cat-file -e "$ZOMBIE_SHA" 2>/dev/null; then XM=1; else XM=0; fi
check "fixture 是跨机形态（B 本地没有该对象）" "$XM" "0"
node --input-type=module -e '
import { claim } from "'"$HERE"'/scripts/lib/claim.mjs";
const r = claim({ cwd: process.argv[1], remote: process.argv[2], kind: "mr", id: "z1", ttlMs: 3600_000 });
console.log(r.claimed ? "BAD-claimed" : r.reason, r.ageMs == null ? "no-age" : "age-ok");
' "$XL/B" "$XL/r.git" > "$TMP/claim2.txt" 2>&1
grep -q "zombie age-ok" "$TMP/claim2.txt"; check "跨机 25h 前认领 → zombie（对象不在本地也读得出时间）" "0" "$?"
# 新 id（未被占用）正常认领——与 z1 无关的干净引用
node --input-type=module -e '
import { claim } from "'"$HERE"'/scripts/lib/claim.mjs";
const r = claim({ cwd: process.argv[1], remote: process.argv[2], kind: "mr", id: "fresh-9", runId: "runnerC" });
console.log(r.claimed ? "claimed" : r.reason);
' "$ROOT" "$TMP/remote.git" > "$TMP/claim3.txt" 2>&1
grep -q "claimed" "$TMP/claim3.txt"; check "新 id 正常认领" "0" "$?"

echo "== 5. 预算（D7）：轮次硬限 + pause/resume 不计等待 =="
# 上一版这一节标题写的是预算，断言却只覆盖 approvalValid——标题承诺 > 实际覆盖，
# 正是 H9 想拦的那类事。而 runner 里 createBudget 从未被调用，也就没有任何断言会红。
node --input-type=module -e '
const { createBudget } = await import("file://" + process.argv[1] + "/scripts/lib/task-loop-core.mjs");
// 轮次硬限：单任务 2 轮，第 2 轮才耗尽（不是第 1 轮，也不是永远不）
let t = 0;
const b = createBudget({ maxRounds: 2, maxActiveMs: 1e9, now: () => t });
b.start(); b.pause();
const r0 = b.exhausted();
b.spendRound(); const r1 = b.exhausted();
b.spendRound(); const r2 = b.exhausted();
// 等待不计活动墙钟：活动 500 + 等 CI 100 秒 + 活动 400 = 900ms，仍在 1000 以内；
// 再活动 200 → 1100ms 才耗尽。把等待算进去的话，第二段一开始就会被判耗尽。
let u = 0;
const w = createBudget({ maxRounds: 9, maxActiveMs: 1000, now: () => u });
w.start(); u += 500; w.pause();
u += 100000;
w.resume(); u += 400; w.pause();
const waitNotCounted = !w.exhausted();
// 顺序要紧：resume 记的是"此刻"，先推进时钟再 resume 会把这 200ms 记成 0
w.resume(); u += 200;
const activeCounted = w.exhausted();
console.log([r0, r1, r2, waitNotCounted, activeCounted].join(" "));
' "$HERE" > "$TMP/budget.txt" 2>&1
grep -q "^false false true true true$" "$TMP/budget.txt" && r=0 || { cat "$TMP/budget.txt"; r=1; }
check "轮次第 2 轮才耗尽；100s 等待不计墙钟，1100ms 活动才耗尽" "0" "$r"

echo "== 5b. 审批三条件（停点判据，ADR D3） =="
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

echo "== 5c. 剖面 A 触发判定：打回 = 他人未解决意见 且 无有效批红 =="
# 判定从 runner 搬到 lib/gitlab-triggers.mjs 才喂得进假数据。上一版它带 process.exit，
# 测试 import 即执行，于是把判定整段反转（有他人未解决 → 已解决且是我写的），17 条断言零新增红。
node --input-type=module -e '
import { classifyMr } from "'"$HERE"'/scripts/lib/gitlab-triggers.mjs";
const me = "me";
const note = (o = {}) => ({ id: "n", system: false, resolvable: true, resolved: false, author: { username: "lead" }, created_at: "2026-11-09T10:00:00Z", body: "改成幂等", ...o });
const approved = (at) => ({ id: "s", system: true, body: "approved this merge request", author: { username: "lead" }, created_at: at });
const mr = { iid: 7, author: { username: me } };
const c = (discussions, lastPushAt) => classifyMr({ mr, discussions, username: me, lastPushAt });
const a = c([{ id: "d", notes: [note({ resolved: true })] }]);
const b = c([{ id: "d", notes: [note()] }], "2026-11-09T09:00:00Z");
const d = c([{ id: "d", notes: [note(), approved("2026-11-09T12:00:00Z")] }], "2026-11-09T09:00:00Z");
const e = c([{ id: "d", notes: [note(), approved("2026-11-09T08:00:00Z")] }], "2026-11-09T09:00:00Z");
const f = c([{ id: "d", notes: [note({ author: { username: me } })] }], "2026-11-09T09:00:00Z");
console.log([a.reviewState, a.triggered, b.reviewState, b.triggered, d.reviewState, d.triggered, e.reviewState, e.triggered, f.triggered].join(","));
process.exit([a.reviewState, a.triggered, b.reviewState, b.triggered, d.reviewState, d.triggered, e.reviewState, e.triggered, f.triggered].join(",")
  === "pending,false,changes_requested,true,approved,false,changes_requested,true,false" ? 0 : 1);
' "$HERE" > "$TMP/trigger.txt" 2>&1
check "五形态：无意见 / 打回 / 已批红跳过 / 陈批仍打回 / 自留言不算" "0" "$?"

echo "== 5d. 真触发端到端：假 GitLab → 认领 → 账本配对 =="
# 这条路径上一版完全没走过：--dry-run 不经过 claim 与 budget，所以影子周全绿而单任务首跑即崩。
TLROOT="$TMP/e2e"; git init -q --bare "$TLROOT/r.git"
git clone -q "$TLROOT/r.git" "$TLROOT/w" 2>/dev/null
( cd "$TLROOT/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const [here, repo, ledger] = process.argv.slice(1);
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const p = q.url.split("?")[0];
  if (p === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 7, project_id: 1, title: "假 MR", sha: "abc", author: { username: "me" } }]));
  if (/discussions$/.test(p)) return s.end(JSON.stringify([{ id: "d1", notes: [{ id: 11, system: false, resolvable: true, resolved: false, author: { username: "lead" }, body: "改成幂等", created_at: "2026-11-09T10:00:00Z" }] }]));
  if (/repository\/commits/.test(p)) return s.end(JSON.stringify({ committed_date: "2026-11-09T09:00:00Z" }));
  if (/approvals$/.test(p)) return s.end(JSON.stringify({ approved_by: [] }));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + srv.address().port;
// 必须异步起子进程：spawnSync 会把这一个事件循环堵死，假服务器再也回不了包（自己把自己等死）
const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
  env: { ...process.env, GITLAB_URL: url, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
});
let out = "", err = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { err += d; });
const code = await new Promise((r) => child.on("close", r));
srv.close();
console.log(code, /已认领并落确认清单（1 条待修意见/.test(out) ? "ok" : "no-ack", /ReferenceError|is not defined/.test(err) ? "CRASH" : "no-crash");
' "$HERE" "$TLROOT/w" "$TMP/ledgerE2E" > "$TMP/e2e.txt" 2>&1
grep -q "^0 ok no-crash$" "$TMP/e2e.txt" && r=0 || { cat "$TMP/e2e.txt"; r=1; }
check "真触发跑通（旧版在 budget.start() 处 ReferenceError）" "0" "$r"
git -C "$TLROOT/r.git" for-each-ref refs/heads/claims/mr-7 --format='%(refname)' | grep -q "claims/mr-7"
check "认领引用落在远端" "0" "$?"
node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map((l)=>JSON.parse(l).type);const i=t.indexOf("trigger_found"),j=t.indexOf("claimed"),k=t.indexOf("claim_held");process.exit(i>=0&&j>i&&k>j?0:1)' "$TMP/ledgerE2E/events.jsonl"
check "账本：trigger_found → claimed → claim_held（无孤儿）" "0" "$?"

echo "== 5e. 认领之后失败 → 当场释放（不留孤儿引用） =="
# 实测过的泄漏：崩在 claim 之后，引用留在远端，release 从未被调用，第二次运行认领被拒，
# 于是静默 exit 0——这条 MR 从此永远不再被处理，而外部看起来"跑过了、没事"。
TL2="$TMP/e2e2"; git init -q --bare "$TL2/r.git"
git clone -q "$TL2/r.git" "$TL2/w" 2>/dev/null
( cd "$TL2/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && mkdir -p .ai && : > .ai/task-loop \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const [here, repo, ledger] = process.argv.slice(1);
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const p = q.url.split("?")[0];
  if (p === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 11, project_id: 1, title: "会失败", sha: "abc", author: { username: "me" } }]));
  if (/discussions$/.test(p)) return s.end(JSON.stringify([{ id: "d1", notes: [{ id: 1, system: false, resolvable: true, resolved: false, author: { username: "lead" }, body: "x", created_at: "2026-11-09T10:00:00Z" }] }]));
  if (/repository\/commits/.test(p)) return s.end(JSON.stringify({ committed_date: "2026-11-09T09:00:00Z" }));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
  env: { ...process.env, GITLAB_URL: "http://127.0.0.1:" + srv.address().port, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
});
let err = "";
child.stderr.on("data", (d) => { err += d; });
const code = await new Promise((r) => child.on("close", r));
srv.close();
console.log(code, /处理失败/.test(err) && /认领已释放/.test(err) ? "handled" : "silent");
' "$HERE" "$TL2/w" "$TMP/ledgerRE" > "$TMP/release.txt" 2>&1
grep -q "^1 handled$" "$TMP/release.txt" && r=0 || { cat "$TMP/release.txt"; r=1; }
check "异常路径 exit 1 且明说已释放（不是静默 0）" "0" "$r"
git -C "$TL2/r.git" for-each-ref refs/heads/claims/mr-11 --format='%(refname)' | grep -q . && r=1 || r=0
check "认领引用已删除（无残留）" "0" "$r"
node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map((l)=>JSON.parse(l).type);process.exit(t.includes("claimed")&&t.includes("released")&&t.indexOf("released")>t.indexOf("claimed")?0:1)' "$TMP/ledgerRE/events.jsonl"
check "账本：claimed 有配对的 released" "0" "$?"

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
// 闸3：豁免率超阈值（分母由调用方给：3 条豁免 / 2 条全绿 = 60%）
const budget = decide({ introduced: [], inherited: [{id:"s::A",fingerprint:"A"},{id:"s::B",fingerprint:"B"},{id:"s::C",fingerprint:"C"}], greenCount: 2 },
  { exemptions: [
    { fingerprintId: "s::A", owner: "l", expiresAt: new Date(Date.now()+86400e3).toISOString() },
    { fingerprintId: "s::B", owner: "l", expiresAt: new Date(Date.now()+86400e3).toISOString() },
    { fingerprintId: "s::C", owner: "l", expiresAt: new Date(Date.now()+86400e3).toISOString() }] });
// 闸2：翻转检测
const flip = flippyFailures([{id:"s::A"}], [{id:"s::B"}]);
// 闸3 的反面：40 条全绿 + 3 条豁免 = 7%，不该被判成门禁退化
const mixed = decide({ introduced: [], inherited: [{id:"s::A",fingerprint:"A"},{id:"s::B",fingerprint:"B"},{id:"s::C",fingerprint:"C"}], greenCount: 40 },
  { exemptions: [
    { fingerprintId: "s::A", owner: "l", expiresAt: new Date(Date.now()+86400e3).toISOString() },
    { fingerprintId: "s::B", owner: "l", expiresAt: new Date(Date.now()+86400e3).toISOString() },
    { fingerprintId: "s::C", owner: "l", expiresAt: new Date(Date.now()+86400e3).toISOString() }] });
// 分母缺失：不可判定就明说，不塞默认值（旧写法 total/(total+0) 恒等于 1，1 条豁免就报 100%）
const unknown = decide({ introduced: [], inherited: [{id:"s::A",fingerprint:"A"}] },
  { exemptions: [{ fingerprintId: "s::A", owner: "l", expiresAt: new Date(Date.now()+86400e3).toISOString() }] });
const pass = r1.action==="REWORK" && r2.action==="EXEMPT_REQUIRED" && ok.action==="PASS_TO_REVIEW"
  && expired.action==="EXEMPT_REQUIRED" && diffFp.action==="EXEMPT_REQUIRED"
  && budget.action==="EXEMPTION_BUDGET_EXCEEDED" && flip.length===2
  && mixed.action==="PASS_TO_REVIEW" && Math.abs(mixed.exemptionRate - 3/43) < 1e-9
  && unknown.rateKnown === false && unknown.exemptionRate === null && unknown.action==="PASS_TO_REVIEW";
console.log(pass ? "ALL-OK" : JSON.stringify({r1:r1.action,r2:r2.action,ok:ok.action,expired:expired.action,diffFp:diffFp.action,budget:budget.action,mixed:mixed.action,rate:mixed.exemptionRate,unknown:unknown.action,known:unknown.rateKnown}));
process.exit(pass ? 0 : 1);'
check "三分流 + 三道闸全形态（含 7% 不误报 / 分母缺失不猜）" "0" "$?"

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

echo "== 10b. 凭据不进 plist/unit（明文配置会被 launchctl print / systemctl cat 打出来） =="
FAKE_TOKEN="glpat-SHOULD-NEVER-LEAK-9f3a"
# 结构级判据：模板里只要存在「秘密类占位符」，渲染结果就必然带秘密，逐个平台查太脆弱。
# 这里直接禁止 token/secret/password 类占位符出现在 deploy/task-loop 的任何模板里。
if grep -qE "__[A-Z_]*(TOKEN|SECRET|PASSWORD|KEY)[A-Z_]*__" "$HERE"/deploy/task-loop/*.template 2>/dev/null; then
  check "模板不含秘密占位符" "有" "无"; else check "模板不含秘密占位符" "无" "无"; fi
PL="$(HOME="$TMP/h1" GITLAB_TOKEN="$FAKE_TOKEN" GITLAB_URL=https://g.example.com \
      bash "$HERE/scripts/install-task-loop.sh" "$ROOT" --print 2>&1)"
case "$PL" in *"$FAKE_TOKEN"*) check "print 输出不含 token" "含" "不含" ;; *) check "print 输出不含 token" "不含" "不含" ;; esac
# 注意：别把 case 塞进 $( )——`in *x*)` 的右括号会被当成命令替换的结尾
case "$PL" in *task-loop.env*) HAS_CRED=0 ;; *) HAS_CRED=1 ;; esac
check "print 仍给出凭据落点（人要知道去哪儿配）" "0" "$HAS_CRED"

echo "== 10c. 实装落盘权限与内容（--no-activate：不在跑测试的机器上注册真定时器） =="
HOME="$TMP/h2" GITLAB_URL=http://127.0.0.1:1 GITLAB_TOKEN="$FAKE_TOKEN" FEISHU_MCP_URL=https://m.example.com/x \
  bash "$HERE/scripts/install-task-loop.sh" "$ROOT" --no-activate > "$TMP/inst.txt" 2>&1
check "安装成功" "0" "$?"
mode_of(){ if [ "$(uname)" = "Darwin" ]; then stat -f %Lp "$1"; else stat -c %a "$1"; fi; }
D="$TMP/h2/.harness/task-loop"
check "凭据文件 0600" "600" "$(mode_of "$D/task-loop.env")"
check "包装脚本 0700（定时器实际执行的是它）" "700" "$(mode_of "$D/run-round.sh")"
check "凭据目录 0700" "700" "$(mode_of "$D")"
# 定时器配置文件的平台分支：macOS 写 plist、Linux 写 systemd unit——凭据安全断言等价
if [ "$(uname)" = "Darwin" ]; then
  UNIT_FILE="$TMP/h2/Library/LaunchAgents/com.harness.task-loop.plist"
else
  UNIT_FILE="$TMP/h2/.config/systemd/user/com.harness.task-loop.service"
fi
check "定时器配置文件权限" "600" "$(mode_of "$UNIT_FILE")"
grep -q "$FAKE_TOKEN" "$UNIT_FILE" 2>/dev/null
check "定时器配置不含 token" "1" "$?"
grep -q "GITLAB_TOKEN=$FAKE_TOKEN" "$D/task-loop.env"; check "token 落在 0600 文件里" "0" "$?"

echo "== 10d. wrapper 是凭据的唯一入口：干净环境（模拟 launchd）下仍能取到 token =="
# launchd 不继承登录 shell 的 env，systemd 的 unit 也不再写 Environment=。
# 所以这条必须用 env -i 跑：带环境的测试证明不了"定时器环境里能读到凭据"。
bash -n "$D/run-round.sh"; check "wrapper 语法合法" "0" "$?"
# 结构判据：包装脚本不得把凭据文件当**代码**加载（`.` 与 `source` 两种写法、行首还是行中都算——
# `set -a; . file; set +a` 这种一行式写法是最容易混进来的一种）。
# 一旦 source，"能写凭据文件"就升级成"能以定时器身份执行任意命令"——这是本层的核心边界，
# 只靠"别写错"守不住，得有断言。
grep -vE '^[[:space:]]*#' "$D/run-round.sh" | grep -qE '(^|[[:space:];&|])(source|\.)[[:space:]]+[^[:space:]]'
check "wrapper 不 source 凭据文件（行中一行式也算）" "1" "$?"
grep -q 'HARNESS_ENV_FILE=' "$D/run-round.sh"; check "wrapper 只交出凭据文件路径（由 runner 解析）" "0" "$?"
# HOME 必须显式给假目录：node 的 os.homedir() 在 HOME 缺失时回落 passwd 里的真实家目录，
# 于是会读到本机真实的 feishu-oauth.json 并对生产飞书发请求——测试不该有外部副作用。
OUT="$(env -i HOME="$TMP/h2" PATH=/usr/bin:/bin /bin/bash "$D/run-round.sh" 2>&1 | head -3)"
# 地址指向不可达端口：连不上恰好证明 GITLAB_URL/TOKEN 被读进来了（没读到会走"未接入"分支退出 0）
case "$OUT" in *"剖面 A 触发轮询失败"*) check "wrapper 注入凭据并进入 runner" "0" "0" ;; *) check "wrapper 注入凭据并进入 runner" "0" "1: $OUT" ;; esac

echo "== 10e. 重装不覆盖已有凭据（换一个变量不该把上次的 token 清掉） =="
printf 'HARNESS_EXTRA=kept\n' >> "$D/task-loop.env"
HOME="$TMP/h2" GITLAB_URL=https://g2.example.com \
  bash "$HERE/scripts/install-task-loop.sh" "$ROOT" --no-activate >/dev/null 2>&1
grep -q "GITLAB_TOKEN=$FAKE_TOKEN" "$D/task-loop.env"; check "未提供的 token 保留" "0" "$?"
grep -q "^GITLAB_URL=https://g2.example.com$" "$D/task-loop.env"; check "提供的 url 被更新" "0" "$?"
grep -q "HARNESS_EXTRA=kept" "$D/task-loop.env"; check "手加的键不被抹掉" "0" "$?"
check "重装后仍是 0600" "600" "$(mode_of "$D/task-loop.env")"

echo "== 10f. --status 能查出被改宽的权限（cp/rsync 保留不了 0600） =="
HOME="$TMP/h2" bash "$HERE/scripts/install-task-loop.sh" "$ROOT" --status > "$TMP/st1.txt" 2>&1
grep -q "0600" "$TMP/st1.txt"; check "正常权限 → 报 0600" "0" "$?"
chmod 644 "$D/task-loop.env"
HOME="$TMP/h2" bash "$HERE/scripts/install-task-loop.sh" "$ROOT" --status > "$TMP/st2.txt" 2>&1
grep -q "权限过宽" "$TMP/st2.txt"; check "644 → 报过宽并给修法" "0" "$?"
chmod 600 "$D/task-loop.env"

echo "== 10g. 旧版安装器写过明文 token 的 plist：重装后必须提示轮换 =="
# 重写文件不会让已经落盘的 token 失效。写过就当泄露处理——这是唯一诚实的处置。
mkdir -p "$TMP/h3/Library/LaunchAgents"
printf '<plist><dict><key>GITLAB_TOKEN</key><string>old-plaintext</string></dict></plist>\n' \
  > "$TMP/h3/Library/LaunchAgents/com.harness.task-loop.plist"
HOME="$TMP/h3" GITLAB_TOKEN=newt bash "$HERE/scripts/install-task-loop.sh" "$ROOT" --no-activate > "$TMP/legacy.txt" 2>&1
grep -q "明文凭据" "$TMP/legacy.txt"; check "旧 plist 含 token → 提示撤销重建" "0" "$?"
if [ "$(uname)" = "Darwin" ]; then
  grep -q "GITLAB_TOKEN" "$TMP/h3/Library/LaunchAgents/com.harness.task-loop.plist"
else
  grep -q "GITLAB_TOKEN" "$TMP/h3/.config/systemd/user/com.harness.task-loop.service"
fi
check "重装后定时器配置已无 token" "1" "$?"

echo "== 10h. 凭据文件按数据解析（能写它 ≠ 能以定时器身份执行命令） =="
cat > "$TMP/envprobe.mjs" <<'JSEOF'
import { chmodSync, writeFileSync } from 'node:fs';
const [mod, dir] = process.argv.slice(2);
const { parseEnvFile, loadEnvFile } = await import(mod);
const bad = [];
const eq = (name, a, b) => { if (String(a) !== String(b)) bad.push(`${name}（得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`); };

const text = [
  '# 注释行',
  '',
  'export GITLAB_URL=https://git.example.com',
  'GITLAB_TOKEN="glpat-quoted"',
  "SINGLE='a b'",
  `EVIL=$(touch ${dir}/pwn1)`,
  `TICK=\`touch ${dir}/pwn2\``,
  'EMPTY=',
].join('\n');
const entries = parseEnvFile(text, { file: 'x.env' });
const got = Object.fromEntries(entries.map((e) => [e.key, e.value]));
eq('注释/空行被跳过', entries.length, 6);
eq('export 前缀被剥掉', got.GITLAB_URL, 'https://git.example.com');
eq('双引号外壳被剥掉', got.GITLAB_TOKEN, 'glpat-quoted');
eq('单引号外壳被剥掉', got.SINGLE, 'a b');
eq('命令替换原样保留（不求值）', got.EVIL, `$(touch ${dir}/pwn1)`);
eq('反引号原样保留（不求值）', got.TICK, '`touch ' + dir + '/pwn2`');
eq('空值合法', got.EMPTY, '');

// 非法行：报错 + 带行号，且**不回显原文**（那一行可能正是被拼坏的 token，报错会进日志/工单）
let msg = '';
try { parseEnvFile('OK=1\ntouch ' + dir + '/pwn3\n', { file: 'x.env' }); } catch (e) { msg = e.message; }
eq('非法行报行号', /:2\b/.test(msg), 'true');
eq('非法行不回显原文', msg.includes('pwn3'), 'false');

// 优先级：env 非空 > 文件；env 为空串按"没配"，由文件补上
const f = dir + '/creds.env';
writeFileSync(f, 'A=from-file\nB=from-file\n', { mode: 0o600 });
const env1 = { A: 'from-env', B: '' };
const r1 = loadEnvFile(f, { env: env1 });
eq('env 非空 → 文件不覆盖（临时覆盖语义）', env1.A, 'from-env');
eq('env 为空串 → 文件补上', env1.B, 'from-file');
eq('loaded / shadowed 分开记', r1.loaded.join(',') + '|' + r1.shadowed.join(','), 'B|A');

// 缺文件不是错误：凭据不在场 = 未接入（与 GitLab/飞书同一条判据）
eq('缺文件 → exists=false 且不抛', loadEnvFile(dir + '/nope.env', { env: {} }).exists, 'false');

// 权限过宽要告警：cp / rsync / 编辑器另存都保留不了 0600
chmodSync(f, 0o644);
eq('644 告警', /权限 644/.test(loadEnvFile(f, { env: {} }).warnings.join('')), 'true');

console.log(bad.length ? 'FAIL ' + bad.join(' | ') : 'OK');
process.exit(bad.length ? 1 : 0);
JSEOF
R="$(node "$TMP/envprobe.mjs" "$HERE/scripts/lib/env-file.mjs" "$TMP" 2>&1)"; RC=$?
check "解析/优先级/缺文件/权限告警（14 项）" "0" "$RC"
[ "$RC" = 0 ] || echo "    $R"
check "文件里没有命令被执行（pwn1/pwn2/pwn3 都不存在）" "0" "$(ls "$TMP"/pwn1 "$TMP"/pwn2 "$TMP"/pwn3 2>/dev/null | wc -l | tr -d ' ')"

echo "== 10i. 凭据文件里的裸命令：runner 报错退出，不执行 =="
BADC="$TMP/bad.env"
printf 'GITLAB_TOKEN=x\ncurl -s http://127.0.0.1:1/x.sh | sh\n' > "$BADC"; chmod 600 "$BADC"
env -u GITLAB_URL -u GITLAB_TOKEN HOME="$TMP/h4" HARNESS_ENV_FILE="$BADC" \
  node "$HERE/scripts/task-loop.mjs" --once --root "$ROOT" > "$TMP/badenv.txt" 2>&1
check "非法行 → exit 1（不静默当作没配）" "1" "$?"
grep -q ":2" "$TMP/badenv.txt"; check "报错带行号（定位不用猜）" "0" "$?"

echo "== 10j. runner 自己读 HARNESS_ENV_FILE：不靠 shell 注入也能拿到凭据 =="
NODE_BIN="$(command -v node)"
GOODC="$TMP/good.env"
printf 'GITLAB_URL=http://127.0.0.1:1\nGITLAB_TOKEN=glpat-from-file\n' > "$GOODC"; chmod 600 "$GOODC"
run_clean_env() { env -i HOME="$TMP/h6" PATH=/usr/bin:/bin HARNESS_ENV_FILE="$GOODC" \
  HARNESS_LEDGER_DIR="$TMP/l6" "$NODE_BIN" "$HERE/scripts/task-loop.mjs" --once --root "$ROOT" 2>&1 | head -6; }
OUT="$(run_clean_env)"
# 地址指向不可达端口：连不上恰好证明 url/token 被读进来了（没读到会走"未接入"分支退出 0）
case "$OUT" in *"剖面 A 触发轮询失败"*) check "干净环境 + 凭据文件 → 进入 runner 并真的用了凭据" "0" "0" ;; *) check "干净环境 + 凭据文件 → 进入 runner 并真的用了凭据" "0" "1: $OUT" ;; esac
case "$OUT" in *"凭据文件已载入 2 键"*) check "载入了几键有交代（排查「配了没生效」要看得到）" "0" "0" ;; *) check "载入了几键有交代" "0" "1: $OUT" ;; esac
chmod 644 "$GOODC"
OUT="$(run_clean_env)"
case "$OUT" in *"权限 644"*) check "权限漂移在 runtime 也告警（不只在 --status）" "0" "0" ;; *) check "权限漂移在 runtime 也告警" "0" "1: $OUT" ;; esac

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
const mql = buildMyBugsMql({ projectKey: "taosdata_td" });
const a = parseMqlResult(JSON.stringify([{work_item_id:1,severity:"致命"},{work_item_id:2,severity:"严重"}]));
const b = parseMqlResult("| work_item_id | name | severity |\n|---|---|---|\n| 3 | x | 一般 |");
const g = gateBySeverity([...a, ...b]);
let threw = false; try { parseMqlResult("junk"); } catch { threw = true; }
let noKey = false; try { buildMyBugsMql({}); } catch { noKey = true; }
process.exit(mql.includes("current_login_user()") && mql.includes("`taosdata_td`.`Defect`") && a.length===2 && b.length===1
  && g.auto.length===2 && g.confirm.length===1 && threw && noKey ? 0 : 1);'
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
# 凭据必须隔离：不隔离的话，本机已登录时 ensureToken() 会成功、CI 上则失败——
# 同一份代码两种结论，等于没有判据（本地红、CI 绿就是从这里来的）。
env -u FEISHU_MCP_URL -u FEISHU_MCP_KEY -u FEISHU_USER_KEY FEISHU_OAUTH_FILE="$TMP/no-creds/feishu-oauth.json" \
  node "$HERE/scripts/task-loop.mjs" --once --profile b --root "$ROOT" > "$TMP/pb1.txt" 2>&1
grep -q "FEISHU_MCP_URL" "$TMP/pb1.txt" && grep -q "feishu-auth.mjs login" "$TMP/pb1.txt"; check "剖面 B 缺凭据 → 两条路都点名（login / FEISHU_MCP_URL）" "0" "$?"
# 活通道探测：需要外网。离线时**显式跳过并单独计数**，不假装通过——
# 这条断言要证明的是"真实 MCP 的 perm 档报错带后台指引"，离线环境里它什么也没证明。
if node -e 'fetch(process.argv[1],{method:"HEAD",signal:AbortSignal.timeout(5000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))' "https://project.feishu.cn" 2>/dev/null; then
  FEISHU_MCP_URL="https://project.feishu.cn/mcp_server/v1?mcpKey=m-dca0c1ab-4fec-4e26-97b7-81aabe932c97&userKey=7231777938960613378" FEISHU_PROJECT_KEY=taosdata_td \
    node "$HERE/scripts/task-loop.mjs" --once --profile b --root "$ROOT" > "$TMP/pb2.txt" 2>&1
  grep -q "数据档未授权" "$TMP/pb2.txt"; check "数据档未开 → perm 报错带后台指引（活通道）" "0" "$?"
else
  printf "  \033[33m⤷\033[0m 跳过：数据档 perm 探测（无外网，活通道断言不可执行）\n"
  skip=$((skip+1))
fi

echo
[ "$skip" -eq 0 ] || printf "跳过：%d 项（原因见上，不计入通过/失败）\n" "$skip"
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
