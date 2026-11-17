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

echo "== 5c-bis. 打回动词独立触发（live 形态：普通评论 + 撤批 + requested changes，零 resolvable）=="
# 2026-11-16 MR !1882 实测：评审者 approve→unapprove→requested changes + 普通评论（non-resolvable），
# 整条 MR 零 resolvable 讨论。旧判定：unresolved=0 → pending，MR 打回不可见。动词必须是独立的打回证据。
node --input-type=module -e '
import { classifyMr } from "'"$HERE"'/scripts/lib/gitlab-triggers.mjs";
const me = "me";
const plain = (o = {}) => ({ id: "c", system: false, resolvable: false, resolved: false, author: { username: "lead" }, created_at: "2026-11-16T01:58:19Z", body: "请查看非阻断项目", ...o });
const sys = (body, at, who = "lead") => ({ id: "s", system: true, resolvable: false, resolved: false, author: { username: who }, created_at: at, body });
const mr = { iid: 1882, author: { username: me } };
const c = (discussions, lastPushAt) => classifyMr({ mr, discussions, username: me, lastPushAt });
// L1 live 复现：普通评论 + 批 + 撤批 + 动词（全晚于末次 push 2026-11-15T13:13）
const l1 = c([{ id: "d1", notes: [plain(), sys("approved this merge request", "2026-11-16T01:59:03Z"), sys("unapproved this merge request", "2026-11-16T02:24:35Z"), sys("requested changes", "2026-11-16T02:24:41Z")] }], "2026-11-15T13:13:01Z");
// L2 批红晚于动词 → approved（最后的话算数）
const l2 = c([{ id: "d1", notes: [sys("requested changes", "2026-11-16T02:00:00Z"), sys("approved this merge request", "2026-11-16T03:00:00Z")] }], "2026-11-15T13:13:01Z");
// L3 动词早于末次 push（新 commit 已覆盖）且无未解决意见 → pending
const l3 = c([{ id: "d1", notes: [sys("requested changes", "2026-11-16T02:00:00Z")] }], "2026-11-16T05:00:00Z");
// L4 本人发的动词 → 不算（与自留言同口径）
const l4 = c([{ id: "d1", notes: [sys("requested changes", "2026-11-16T02:00:00Z", me)] }], "2026-11-15T13:13:01Z");
// L5 评审者 a 批红后评审者 b 要求改动（无撤批留言）→ 最后的话是动词 → 打回
const l5 = c([{ id: "d1", notes: [sys("approved this merge request", "2026-11-16T02:00:00Z", "a"), sys("requested changes", "2026-11-16T03:00:00Z", "b")] }], "2026-11-15T13:13:01Z");
const row = (x) => [x.reviewState, x.triggered, x.signal].join(":");
const all = [row(l1), row(l2), row(l3), row(l4), row(l5)].join(",");
console.log(all);
process.exit(all === "changes_requested:true:review_verb,approved:false:approval,pending:false:none,pending:false:none,changes_requested:true:review_verb" ? 0 : 1);
' "$HERE" > "$TMP/verb.txt" 2>&1
check "动词五形态：live 打回 / 批红在后不算 / push 已覆盖 / 自发不算 / 他批后另人动词" "0" "$?"

echo "== 5c-ter. fetchTriggers 热路径粗筛放行动词型 MR（旧版在 classifyMr 之前就 continue 掉）=="
node --input-type=module -e '
import { fetchTriggers } from "'"$HERE"'/scripts/lib/gitlab-triggers.mjs";
const mrWithVerb = { iid: 7, project_id: 1, sha: "s1", author: { username: "me" } };
const mrQuiet = { iid: 8, project_id: 2, sha: "s2", author: { username: "me" } };
const verbDiscs = [{ id: "d1", notes: [
  { id: "n1", system: false, resolvable: false, resolved: false, author: { username: "lead" }, body: "普通评论", created_at: "2026-11-16T01:58:19Z" },
  { id: "n2", system: true, author: { username: "lead" }, body: "unapproved this merge request", created_at: "2026-11-16T02:24:35Z" },
  { id: "n3", system: true, author: { username: "lead" }, body: "requested changes", created_at: "2026-11-16T02:24:41Z" },
]}];
const calls = [];
const fake = async (url) => {
  calls.push(url);
  const json = url.endsWith("/merge_requests?scope=created_by_me&state=opened&per_page=100") ? [mrWithVerb, mrQuiet]
    : /\/projects\/1\/merge_requests\/7\/discussions$/.test(url) ? verbDiscs
    : /\/projects\/2\/merge_requests\/8\/discussions$/.test(url) ? []
    : /repository\/commits/.test(url) ? { committed_date: "2026-11-15T13:13:01Z" }
    : null;
  if (json === null) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, json: async () => json };
};
const out = await fetchTriggers({ url: "https://g.example", token: "t", username: "me", fetchImpl: fake });
const quietWentDeep = calls.some((u) => /projects\/2\/repository\/commits/.test(u));
console.log(JSON.stringify({ n: out.length, id: out[0]?.id, signal: out[0]?.signal, quietWentDeep }));
process.exit(out.length === 1 && String(out[0].id) === "7" && out[0].signal === "review_verb" && !quietWentDeep ? 0 : 1);
' "$HERE" > "$TMP/fetch-verb.txt" 2>&1
check "fetchTriggers：动词型 MR 不被粗筛吃掉，无信号 MR 仍省 API 调用" "0" "$?"

echo "== 5c-quater. 建议性评论进修复范围（无 resolvable 时不空清单，但不双列、不收自发）=="
# 用户指令 2026-11-16：审核意见里的建议修改项纳入接单修复范围。动词型触发零 resolvable，
# 若只列 unresolved，ack 清单为空——修复会话不知道要修什么。
node --input-type=module -e '
import { reviewCommentsByOthers, fetchTriggers, changesRequestedAt } from "'"$HERE"'/scripts/lib/gitlab-triggers.mjs";
const me = "me";
const note = (o = {}) => ({ id: "n", system: false, resolvable: false, resolved: false, author: { username: "lead" }, created_at: "2026-11-16T01:58:19Z", body: "建议修改项 X", ...o });
const sys = (body, at, who = "lead") => ({ id: "s", system: true, author: { username: who }, created_at: at, body });
const discs = [
  { id: "d1", notes: [note(), sys("requested changes", "2026-11-16T02:24:41Z")] },        // 普通评论 → 收
  { id: "d2", notes: [note({ id: "mine", body: "自己的留言", author: { username: me } })] },   // 自发 → 不收
  { id: "d3", notes: [note({ id: "r", resolvable: true, resolved: false })] },              // resolvable → 走 unresolved，不双列
  { id: "d4", notes: [sys("approved this merge request", "2026-11-16T01:59:03Z")] },      // 系统留言 → 不收
];
const rc = reviewCommentsByOthers(discs, me);
// resolvable 线程里的普通回复也是建议项（note 级过滤，不整线程跳过——CR R3）
const d5 = [{ id: "d5", notes: [note({ id: "rr", resolvable: true, resolved: false, body: "改成幂等" }), note({ id: "pr", body: "补充：变量名也要改" })] }];
const rc5 = reviewCommentsByOthers(d5, me);
const ok1 = rc.length === 1 && rc[0].note === "n" && rc[0].id === "d1" && rc5.length === 1 && rc5[0].note === "pr";
let threw = false;
try { reviewCommentsByOthers(discs, ""); } catch { threw = true; }
// 动词同样不静默：空 username 抛错（CR R2，与 unresolvedByOthers 同口径）
let threwVerb = false;
try { changesRequestedAt(discs, ""); } catch { threwVerb = true; }
// 端到端：动词型触发的 payload 里带着建议性评论
const mrs = [{ iid: 9, project_id: 3, sha: "s9", author: { username: me } }];
const fake = async (url) => {
  const json = url.endsWith("scope=created_by_me&state=opened&per_page=100") ? mrs
    : /discussions$/.test(url) ? discs
    : /repository\/commits/.test(url) ? { committed_date: "2026-11-15T13:13:01Z" }
    : null;
  if (json === null) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, json: async () => json };
};
const out = await fetchTriggers({ url: "https://g.example", token: "t", username: me, fetchImpl: fake });
const ok2 = out.length === 1 && out[0].comments && out[0].comments.length === 1 && out[0].unresolved.length === 1;
console.log(ok1, threw, threwVerb, ok2);
process.exit(ok1 && threw && threwVerb && ok2 ? 0 : 1);
' "$HERE" > "$TMP/comments.txt" 2>&1
check "建议性评论：收普通与 resolvable 线程内回复/不收自发与系统/不双列/动词空 username 抛错" "0" "$?"

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

echo "== 5d-bis. 动词型触发 → ack 待修清单含建议性评论（零 resolvable 不空清单）=="
# CR R1（2026-11-16）：fromComments→ack 的合并曾零覆盖——删掉那行套件仍全绿，而文档/state 声称已验。
# 这条端到端补上：MR !1882 形态（普通评论+撤批+动词，零 resolvable）→ runner 落的 ack 必须带着评论。
TL3="$TMP/e2e3"; git init -q --bare "$TL3/r.git"
git clone -q "$TL3/r.git" "$TL3/w" 2>/dev/null
( cd "$TL3/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const p = q.url.split("?")[0];
  if (p === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 13, project_id: 1, title: "动词型", sha: "abc", author: { username: "me" } }]));
  if (/discussions$/.test(p)) return s.end(JSON.stringify([{ id: "d1", notes: [
    { id: 21, system: false, resolvable: false, resolved: false, author: { username: "lead" }, body: "建议修改项：杂凑下沉", created_at: "2026-11-16T01:58:19Z" },
    { id: 22, system: true, author: { username: "lead" }, body: "unapproved this merge request", created_at: "2026-11-16T02:24:35Z" },
    { id: 23, system: true, author: { username: "lead" }, body: "requested changes", created_at: "2026-11-16T02:24:41Z" },
  ] }]));
  if (/repository\/commits/.test(p)) return s.end(JSON.stringify({ committed_date: "2026-11-15T13:13:01Z" }));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + srv.address().port;
const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
  env: { ...process.env, GITLAB_URL: url, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
});
let out = "", err = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { err += d; });
const code = await new Promise((r) => child.on("close", r));
srv.close();
let ack = null;
try { ack = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-13.json", "utf8")); } catch {}
const okAck = ack && Array.isArray(ack.pending) && ack.pending.length === 1
  && ack.pending[0].source === "comment" && /杂凑下沉/.test(ack.pending[0].body);
console.log(code, okAck ? "ack-ok" : "ack-bad", /1 条待修意见/.test(out) ? "msg-ok" : "msg-bad", /ReferenceError/.test(err) ? "CRASH" : "no-crash");
' "$HERE" "$TL3/w" "$TMP/ledgerE2E3" > "$TMP/e2e3.txt" 2>&1
grep -q "^0 ack-ok msg-ok no-crash$" "$TMP/e2e3.txt" && r=0 || { cat "$TMP/e2e3.txt"; r=1; }
check "动词型端到端：零 resolvable，ack 落 1 条建议性评论（fromComments 有覆盖）" "0" "$r"

echo "== 5d-ter. dry-run/shadow 展示面：动词型触发显示并落账建议评论数（CR 二轮遗留①）=="
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const [here, repo] = process.argv.slice(1);
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const p = q.url.split("?")[0];
  if (p === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 14, project_id: 1, title: "动词 dry-run", sha: "abc", author: { username: "me" } }]));
  if (/discussions$/.test(p)) return s.end(JSON.stringify([{ id: "d1", notes: [
    { id: 31, system: false, resolvable: false, resolved: false, author: { username: "lead" }, body: "建议修改项 Y", created_at: "2026-11-16T01:58:19Z" },
    { id: 32, system: true, author: { username: "lead" }, body: "requested changes", created_at: "2026-11-16T02:24:41Z" },
  ] }]));
  if (/repository\/commits/.test(p)) return s.end(JSON.stringify({ committed_date: "2026-11-15T13:13:01Z" }));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--dry-run", "--profile", "a", "--root", repo], {
  env: { ...process.env, GITLAB_URL: "http://127.0.0.1:" + srv.address().port, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: repo + "/.ledger" },
});
let out = "";
child.stdout.on("data", (d) => { out += d; });
const code = await new Promise((r) => child.on("close", r));
srv.close();
let last = null;
try { last = JSON.parse(readFileSync(repo + "/.ai/task-loop/shadow.jsonl", "utf8").trim().split("\n").pop()); } catch {}
const okMsg = /修复 0 条未解决讨论 \+ 1 条建议评论/.test(out);
const okShadow = last && last.id === 14 && last.unresolved === 0 && last.comments === 1;
console.log(code, okMsg ? "msg-ok" : "msg-bad", okShadow ? "shadow-ok" : "shadow-bad");
' "$HERE" "$TL3/w" > "$TMP/e2e4.txt" 2>&1
grep -q "^0 msg-ok shadow-ok$" "$TMP/e2e4.txt" && r=0 || { cat "$TMP/e2e4.txt"; r=1; }
check "dry-run/shadow：动词型显示与落账都含建议评论数" "0" "$r"

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

echo "== 5f. 源临时故障（超时/断网/5xx）：跳过该源不 die、不落节流戳、围栏可见（2026-11-16 实测事故）=="
# 背景：内网 GitLab 断连 9 小时，剖面 A 每轮超时 die(1)，剖面 B 还没轮询就被拖死；
# 且 die 只写 stderr（plist 分流到 .err），.out 里只见"凭据已载入"。三件事一起验：
# ①500=临时 → 不 die，走到围栏；②exit 1 但不落节流戳（下 tick 立即重试，不吃节拍）；③围栏行走 stdout。
TL5F="$TMP/e2e5f"; git init -q --bare "$TL5F/r.git"
git clone -q "$TL5F/r.git" "$TL5F/w" 2>/dev/null
( cd "$TL5F/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
const srv = createServer((q, s) => { s.statusCode = 500; s.end("{}"); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
  env: { ...process.env, GITLAB_URL: "http://127.0.0.1:" + srv.address().port, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
});
let out = "", err = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { err += d; });
const code = await new Promise((r) => child.on("close", r));
srv.close();
const soft = /临时不可达/.test(out) && !/剖面 A 触发轮询失败/.test(out);
const fence = /轮次结束：.*源故障 gitlab/.test(out) && /不落节流戳/.test(out);
const noStamp = !existsSync(repo + "/.ai/locks/task-loop.last-run");
console.log(code, soft ? "soft-ok" : "soft-bad", fence ? "fence-ok" : "fence-bad", noStamp ? "nostamp-ok" : "stamp-bad");
' "$HERE" "$TL5F/w" "$TMP/ledger5f" > "$TMP/e2e5f.txt" 2>&1
grep -q "^1 soft-ok fence-ok nostamp-ok$" "$TMP/e2e5f.txt" && r=0 || { cat "$TMP/e2e5f.txt"; r=1; }
check "源临时故障：跳过不 die、围栏可见、不落戳（exit 1 下 tick 重试）" "0" "$r"

echo "== 5f-bis. 硬故障（401）仍 die，且 die 双通道（stdout 同步，.out 不再无声）=="
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const [here, repo, ledger] = process.argv.slice(1);
const srv = createServer((q, s) => { s.statusCode = 401; s.end("{}"); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
  env: { ...process.env, GITLAB_URL: "http://127.0.0.1:" + srv.address().port, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
});
let out = "";
child.stdout.on("data", (d) => { out += d; });
const code = await new Promise((r) => child.on("close", r));
srv.close();
const died = /剖面 A 触发轮询失败/.test(out);
const fenced = /轮次结束/.test(out);
console.log(code, died ? "die-ok" : "die-bad", fenced ? "fence-bad" : "nofence-ok");
' "$HERE" "$TL5F/w" "$TMP/ledger5fb" > "$TMP/e2e5fb.txt" 2>&1
grep -q "^1 die-ok nofence-ok$" "$TMP/e2e5fb.txt" && r=0 || { cat "$TMP/e2e5fb.txt"; r=1; }
check "硬故障 die(1) 且报错同步到 stdout（die 即未成轮，不印围栏行）" "0" "$r"

echo "== 5f-ter. 429（限流）归临时故障：不 die、跳过该源（CR 二审补用例）=="
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const [here, repo, ledger] = process.argv.slice(1);
const srv = createServer((q, s) => { s.statusCode = 429; s.end("{}"); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
  env: { ...process.env, GITLAB_URL: "http://127.0.0.1:" + srv.address().port, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
});
let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
const code = await new Promise((r) => child.on("close", r));
srv.close();
console.log(code, /临时不可达/.test(out) && !/剖面 A 触发轮询失败/.test(out) ? "soft-ok" : "soft-bad");
' "$HERE" "$TL5F/w" "$TMP/ledger5ft" > "$TMP/e2e5ft.txt" 2>&1
grep -q "^1 soft-ok$" "$TMP/e2e5ft.txt" && r=0 || { cat "$TMP/e2e5ft.txt"; r=1; }
check "429 限流：归临时不 die（限流不该把剖面 B 拖死）" "0" "$r"

echo "== 5g. 关账半环：MR 不再触发（合并/批红/关闭）→ 释放认领 + 删 ack + trigger_gone 落账 =="
# 背景：修完的 MR 被批红后触发集里不再有它，ack 与远端认领会一直挂到 TTL 僵尸升级——
# "修完了"在账面上看不出来。第二轮返回空触发集，验证 sweep 把账关掉。
TL5G="$TMP/e2e5g"; git init -q --bare "$TL5G/r.git"
git clone -q "$TL5G/r.git" "$TL5G/w" 2>/dev/null
( cd "$TL5G/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
let phase = 1; // 1=打回待修；2=空触发集（已批红/合并）
const mr = () => JSON.stringify([{ iid: 31, project_id: 1, title: "关账验证", sha: "abc", author: { username: "me" } }]);
const notes = () => JSON.stringify([{ id: "d1", notes: [{ id: 51, system: false, resolvable: true, resolved: false, author: { username: "lead" }, body: "改成幂等", created_at: "2026-11-16T03:00:00Z" }] }]);
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const p = q.url.split("?")[0];
  if (p === "/api/v4/merge_requests") return s.end(phase === 1 ? mr() : "[]");
  if (p === "/api/v4/user") return s.end(JSON.stringify({ username: "me" }));
  if (/discussions$/.test(p)) return s.end(notes());
  if (/repository\/commits/.test(p)) return s.end(JSON.stringify({ committed_date: "2026-11-16T02:00:00Z" }));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + srv.address().port;
const run = async () => {
  const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
    env: { ...process.env, GITLAB_URL: url, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
  });
  let out = ""; child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const code = await new Promise((r) => child.on("close", r));
  return { code, out };
};
const r1 = await run();
const ack1 = existsSync(repo + "/.ai/task-loop/ack-31.json");
const pack1 = existsSync(repo + "/.ai/task-loop/pack-31.md");
phase = 2;
const r2 = await run();
srv.close();
const types = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
const ok = ack1 && pack1 && r1.code === 0 && r2.code === 0
  && !existsSync(repo + "/.ai/task-loop/ack-31.json")
  && !existsSync(repo + "/.ai/task-loop/pack-31.md")
  && types.includes("trigger_gone") && types.indexOf("trigger_gone") > types.indexOf("claimed")
  && /关账 1/.test(r2.out) && /不再触发/.test(r2.out);
console.log(ok ? "ok" : "bad", r1.code, r2.code);
' "$HERE" "$TL5G/w" "$TMP/ledger5g" > "$TMP/e2e5g.txt" 2>&1
grep -q "^ok 0 0$" "$TMP/e2e5g.txt" && r=0 || { cat "$TMP/e2e5g.txt"; r=1; }
check "关账：触发消失→释放+删 ack 与工单+trigger_gone（围栏计 关账 1）" "0" "$r"
git -C "$TL5G/r.git" for-each-ref refs/heads/claims/mr-31 --format='%(refname)' | grep -q . && r=1 || r=0
check "关账后认领引用已删（不留僵尸到 TTL）" "0" "$r"

echo "== 5g-bis. 软失败轮不动账：源断连时存量 ack/认领/工单原样保留（CR 复审 🔴#1 回归钉）=="
# 复审实测复现的误关账形态：健康轮认领 → 断连软失败轮 → 旧实现把 ack 删了、trigger_gone 落账、
# 认领释放（MR 并没合并）。断连→恢复循环还会反复清零 budget/TTL 绕过 maxRounds 升级保护。
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
let broken = false;
const srv = createServer((q, s) => {
  if (broken) { s.statusCode = 500; s.end("{}"); return; }
  s.setHeader("content-type", "application/json");
  const p = q.url.split("?")[0];
  if (p === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 61, project_id: 1, title: "软失败守账", sha: "abc", author: { username: "me" } }]));
  if (p === "/api/v4/user") return s.end(JSON.stringify({ username: "me" }));
  if (/discussions$/.test(p)) return s.end(JSON.stringify([{ id: "d1", notes: [{ id: 81, system: false, resolvable: true, resolved: false, author: { username: "lead" }, body: "意见", created_at: "2026-11-16T05:00:00Z" }] }]));
  if (/repository\/commits/.test(p)) return s.end(JSON.stringify({ committed_date: "2026-11-16T04:00:00Z" }));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + srv.address().port;
const run = async () => {
  const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
    env: { ...process.env, GITLAB_URL: url, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
  });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const code = await new Promise((r) => child.on("close", r));
  return { code, out };
};
const r1 = await run();
broken = true;
const r2 = await run(); // 断连软失败：不得动账
srv.close();
const types = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
const ok = r1.code === 0 && r2.code === 1
  && existsSync(repo + "/.ai/task-loop/ack-61.json") && existsSync(repo + "/.ai/task-loop/pack-61.md")
  && !types.includes("trigger_gone") && !types.includes("ack_stale") && !types.includes("ack_migrated")
  && /源故障 gitlab/.test(r2.out);
console.log(ok ? "ok" : "bad", r1.code, r2.code);
' "$HERE" "$TL5F/w" "$TMP/ledger5gb" > "$TMP/e2e5gb.txt" 2>&1
grep -q "^ok 0 1$" "$TMP/e2e5gb.txt" && r=0 || { cat "$TMP/e2e5gb.txt"; r=1; }
check "软失败轮不动账：ack/工单保留、无 trigger_gone（本轮看不见≠消失）" "0" "$r"
git -C "$TL5F/r.git" for-each-ref refs/heads/claims/mr-61 --format='%(refname)' | grep -q "claims/mr-61"
check "软失败轮认领不释放（不被别的机器抢走）" "0" "$?"

echo "== 5g-ter. --mr 过滤轮不动账：视角收窄不等于触发消失（CR 二审补用例）=="
# TL5F/w 里已有 ack-61（5g-bis 留下）：用 --mr 999 收窄视角跑一轮，ack 必须原样保留。
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const p = q.url.split("?")[0];
  if (p === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 61, project_id: 1, title: "软失败守账", sha: "abc", author: { username: "me" } }]));
  if (p === "/api/v4/user") return s.end(JSON.stringify({ username: "me" }));
  if (/discussions$/.test(p)) return s.end(JSON.stringify([{ id: "d1", notes: [{ id: 81, system: false, resolvable: true, resolved: false, author: { username: "lead" }, body: "意见", created_at: "2026-11-16T05:00:00Z" }] }]));
  if (/repository\/commits/.test(p)) return s.end(JSON.stringify({ committed_date: "2026-11-16T04:00:00Z" }));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo, "--mr", "999"], {
  env: { ...process.env, GITLAB_URL: "http://127.0.0.1:" + srv.address().port, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
});
let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
const code = await new Promise((r) => child.on("close", r));
srv.close();
const types = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
const ok = code === 0 && existsSync(repo + "/.ai/task-loop/ack-61.json")
  && !types.includes("trigger_gone") && !types.includes("ack_migrated");
console.log(ok ? "ok" : "bad", code);
' "$HERE" "$TL5F/w" "$TMP/ledger5gt" > "$TMP/e2e5gt.txt" 2>&1
grep -q "^ok 0$" "$TMP/e2e5gt.txt" && r=0 || { cat "$TMP/e2e5gt.txt"; r=1; }
check "--mr 过滤轮不动账（视角收窄≠消失）" "0" "$r"

echo "== 5h. 待修内容更新：fingerprint 变化 → 重置 ack 重新认领 + 会话包重落（含 pack 首次落盘）=="
TL5H="$TMP/e2e5h"; git init -q --bare "$TL5H/r.git"
git clone -q "$TL5H/r.git" "$TL5H/w" 2>/dev/null
( cd "$TL5H/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
let extra = 0; // 0=只有建议甲；1=评审又补了建议乙
const notes = () => JSON.stringify([{ id: "d1", notes: [
  { id: 61, system: false, resolvable: false, resolved: false, author: { username: "lead" }, body: "建议甲：下沉杂凑", created_at: "2026-11-16T03:00:00Z" },
  ...(extra ? [{ id: 63, system: false, resolvable: false, resolved: false, author: { username: "lead" }, body: "建议乙：补测试", created_at: "2026-11-16T04:00:00Z" }] : []),
  { id: 62, system: true, author: { username: "lead" }, body: "requested changes", created_at: "2026-11-16T03:30:00Z" },
] }]);
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const p = q.url.split("?")[0];
  if (p === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 41, project_id: 1, title: "指纹验证", sha: "abc", author: { username: "me" } }]));
  if (p === "/api/v4/user") return s.end(JSON.stringify({ username: "me" }));
  if (/discussions$/.test(p)) return s.end(notes());
  if (/repository\/commits/.test(p)) return s.end(JSON.stringify({ committed_date: "2026-11-16T02:00:00Z" }));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + srv.address().port;
const run = async () => {
  const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
    env: { ...process.env, GITLAB_URL: url, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
  });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const code = await new Promise((r) => child.on("close", r));
  return { code, out };
};
const r1 = await run();
const pack1 = readFileSync(repo + "/.ai/task-loop/pack-41.md", "utf8");
// 旧格式迁移（CR 🟡#6）：剥掉 fingerprint 模拟升级前存量 ack（live ack-1882 形态）
const ack1 = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-41.json", "utf8"));
delete ack1.fingerprint;
writeFileSync(repo + "/.ai/task-loop/ack-41.json", JSON.stringify(ack1, null, 2));
extra = 1;
const r2 = await run(); // 无指纹 + 内容变 → ack_migrated 一次性重认领重建（不是补写）
const r3 = await run(); // 同内容再跑：fingerprint 一致 → 不再动账（迁移幂等）
srv.close();
const ack2 = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-41.json", "utf8"));
const pack2 = readFileSync(repo + "/.ai/task-loop/pack-41.md", "utf8");
const types = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
const claimedCount = types.filter((x) => x === "claimed").length;
const ok = r1.code === 0 && r2.code === 0 && r3.code === 0
  && /建议甲/.test(pack1) && !/建议乙/.test(pack1)
  && ack2.pending.length === 2 && /建议乙/.test(pack2) && !!ack2.fingerprint
  && types.includes("ack_migrated") && !types.includes("ack_stale")
  && types.lastIndexOf("claimed") > types.indexOf("ack_migrated")
  && claimedCount === 2
  && /内容更新 1/.test(r2.out) && /会话包/.test(r1.out);
console.log(ok ? "ok" : "bad", r1.code, r2.code, r3.code, ack2.pending.length);
' "$HERE" "$TL5H/w" "$TMP/ledger5h" > "$TMP/e2e5h.txt" 2>&1
grep -q "^ok 0 0 0 2$" "$TMP/e2e5h.txt" && r=0 || { cat "$TMP/e2e5h.txt"; r=1; }
check "内容更新/迁移：旧格式→ack_migrated 重认领重建 2 条含指纹；同内容再跑不动账（幂等）" "0" "$r"
git -C "$TL5H/r.git" for-each-ref refs/heads/claims/mr-41 --format='%(refname)' | grep -q "claims/mr-41"
check "重认领后引用仍在（还挂着活）" "0" "$?"

echo "== 5i. 空清单终态：纯动词打回（零意见零评论）→ awaiting_rereview + claim_noop，不落会话包 =="
TL5I="$TMP/e2e5i"; git init -q --bare "$TL5I/r.git"
git clone -q "$TL5I/r.git" "$TL5I/w" 2>/dev/null
( cd "$TL5I/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const p = q.url.split("?")[0];
  if (p === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 51, project_id: 1, title: "纯动词", sha: "abc", author: { username: "me" } }]));
  if (p === "/api/v4/user") return s.end(JSON.stringify({ username: "me" }));
  if (/discussions$/.test(p)) return s.end(JSON.stringify([{ id: "d1", notes: [
    { id: 71, system: true, author: { username: "lead" }, body: "requested changes", created_at: "2026-11-16T03:30:00Z" },
  ] }]));
  if (/repository\/commits/.test(p)) return s.end(JSON.stringify({ committed_date: "2026-11-16T02:00:00Z" }));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
  env: { ...process.env, GITLAB_URL: "http://127.0.0.1:" + srv.address().port, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
});
let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
const code = await new Promise((r) => child.on("close", r));
srv.close();
const ack = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-51.json", "utf8"));
const types = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
const ok = code === 0 && ack.state === "awaiting_rereview" && ack.fingerprint === "empty" && ack.pending.length === 0
  && types.includes("claim_noop") && !types.includes("claim_held")
  && !existsSync(repo + "/.ai/task-loop/pack-51.md")
  && /等 re-review/.test(out) && /待复核 1/.test(out);
console.log(ok ? "ok" : "bad", code);
' "$HERE" "$TL5I/w" "$TMP/ledger5i" > "$TMP/e2e5i.txt" 2>&1
grep -q "^ok 0$" "$TMP/e2e5i.txt" && r=0 || { cat "$TMP/e2e5i.txt"; r=1; }
check "空清单终态：awaiting_rereview+claim_noop+无 pack（不再说『已落清单 0 条』那种含混话）" "0" "$r"

echo "== 5k. CI 红触发端到端：无打回证据 + head_pipeline failed → 认领→拉日志→归因→失败工单（ci-fail-trigger）=="
# 形态来自 git.tdengine.net MR !1896 实测：列表接口不带 head_pipeline（详情才有）、
# 两个 job 同因编译错、日志带 runner 时间戳前缀、同一文件在不同 job 绝对前缀不同。
TL5K="$TMP/e2e5k"; git init -q --bare "$TL5K/r.git"
git clone -q "$TL5K/r.git" "$TL5K/w" 2>/dev/null
( cd "$TL5K/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
let phase = 1; // 1=CI 红(pipeline 7001) 2=转绿 3=新流水又红(7002)
const TRACE = [
  "2026-11-16T10:41:13.890073Z 01O [ERROR] COMPILATION ERROR : ",
  "2026-11-16T10:41:13.890093Z 01O [ERROR] /root/gitlab-runner/builds/qceIO3XVF/0/rd-app/idmp/tda-server/src/main/java/com/taosdata/asset/resource/FileResource.java:[93,29] variable elementAccessScopeService is already defined in class com.taosdata.asset.resource.FileResource",
  "2026-11-16T10:41:13.890099Z 01O [ERROR] /workspace/tda-server/src/main/java/com/taosdata/asset/service/dashboard/PanelService.java:[144,75] cannot find symbol",
  "2026-11-16T10:40:21.908114Z 01O [INFO] Tests run: 4, Failures: 0, Errors: 0 -- in com.taosdata.X",
].join("\n");
const hp = () => phase === 1 ? { id: 7001, status: "failed", web_url: "http://g/pipelines/7001" }
  : phase === 2 ? { id: 7001, status: "success", web_url: "http://g/pipelines/7001" }
  : { id: 7002, status: "failed", web_url: "http://g/pipelines/7002" };
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const u = q.url.split("?")[0];
  const qs = q.url;
  if (u === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 91, project_id: 1, target_branch: "main", title: "CI 红验证", sha: "abc", author: { username: "me" } }]));
  if (u === "/api/v4/user") return s.end(JSON.stringify({ username: "me" }));
  if (/\/merge_requests\/91\/discussions$/.test(u)) return s.end("[]"); // 无打回证据 → 走 CI 分支
  if (/\/merge_requests\/91$/.test(u)) return s.end(JSON.stringify({ iid: 91, target_branch: "main", head_pipeline: hp() }));
  if (/\/pipelines\/700[12]\/jobs$/.test(u)) return s.end(JSON.stringify([
    { id: 11, name: "compile-and-upload", stage: "build", status: "failed", web_url: "http://g/j/11" },
    { id: 12, name: "check", stage: "test", status: "success" },
  ]));
  if (/\/jobs\/11\/trace$/.test(u)) { s.setHeader("content-type", "text/plain"); return s.end(TRACE); }
  // 目标分支最新流水：基线绿（phase 无关——归因应全引入）
  if (qs.startsWith("/api/v4/projects/1/pipelines?ref=")) return s.end(JSON.stringify([{ id: 6999, status: "success", sha: "bbb" }]));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + srv.address().port;
const run = async () => {
  const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
    env: { ...process.env, GITLAB_URL: url, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
  });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const code = await new Promise((r) => child.on("close", r));
  return { code, out };
};
const r1 = await run();
const ack1 = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-91.json", "utf8"));
const pack1 = readFileSync(repo + "/.ai/task-loop/pack-91.md", "utf8");
const t1 = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
const ok1 = r1.code === 0
  && ack1.state === "working" && ack1.fingerprint === "ci:7001" && ack1.pending.length === 2
  && ack1.ci && ack1.ci.baselineStatus === "success"
  && /cannot find symbol/.test(pack1) && /FileResource/.test(pack1) && /elementAccessScopeService/.test(pack1) && /基线/.test(pack1)
  && ["trigger_found","claimed","ci_attributed","claim_held"].every((t) => t1.includes(t))
  && /CI 失败 2 条引入 \/ 0 条基线同款/.test(r1.out);
// phase 3：推了新 commit → 新流水 7002 又红（≠ fingerprint ci:7001）→ ack_stale 重认领重建
phase = 3;
const r2 = await run();
const ack3 = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-91.json", "utf8"));
const t3 = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
const ok3 = r2.code === 0 && ack3.fingerprint === "ci:7002" && ack3.pending.length === 2
  && t3.includes("ack_stale") && t3.lastIndexOf("claimed") > t3.indexOf("ack_stale")
  && /内容更新 1/.test(r2.out);
// phase 2：修好推上去转绿 → 关账（ack 与工单同删）
phase = 2;
const r3 = await run();
const closed = r3.code === 0 && !existsSync(repo + "/.ai/task-loop/ack-91.json") && !existsSync(repo + "/.ai/task-loop/pack-91.md")
  && /关账 1/.test(r3.out);
srv.close();
console.log(ok1 ? "ok1" : "bad1", closed ? "closed" : "noclose", ok3 ? "ok3" : "bad3", r1.code, r2.code, r3.code);
' "$HERE" "$TL5K/w" "$TMP/ledger5k" > "$TMP/e2e5k.txt" 2>&1
grep -q "^ok1 closed ok3 0 0 0$" "$TMP/e2e5k.txt" && r=0 || { cat "$TMP/e2e5k.txt"; r=1; }
check "CI 红全链：认领→拉日志→归因（基线绿全引入）→工单；转绿关账；新流水重认领" "0" "$r"

echo "== 5k-bis. 基线同款 → inherited_only：本 MR 无引入项不修、不落工单 =="
TL5KB="$TMP/e2e5kb"; git init -q --bare "$TL5KB/r.git"
git clone -q "$TL5KB/r.git" "$TL5KB/w" 2>/dev/null
( cd "$TL5KB/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
// 同一份编译错：MR 流水与目标分支流水都在报 → 全部继承
const TRACE = "2026-11-16T10:41:13.890099Z 01O [ERROR] /workspace/tda-server/src/main/java/com/taosdata/asset/service/dashboard/PanelService.java:[144,75] cannot find symbol\n";
const jobs = (jid) => JSON.stringify([{ id: jid, name: "build", stage: "compile", status: "failed", web_url: "http://g/j/" + jid }]);
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const u = q.url.split("?")[0]; const qs = q.url;
  if (u === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 92, project_id: 1, target_branch: "main", title: "基线同款", sha: "abc", author: { username: "me" } }]));
  if (u === "/api/v4/user") return s.end(JSON.stringify({ username: "me" }));
  if (/\/merge_requests\/92\/discussions$/.test(u)) return s.end("[]");
  if (/\/merge_requests\/92$/.test(u)) return s.end(JSON.stringify({ iid: 92, target_branch: "main", head_pipeline: { id: 7101, status: "failed", web_url: "http://g/p/7101" } }));
  if (u === "/api/v4/projects/1/pipelines/7101/jobs") return s.end(jobs(31));
  if (u === "/api/v4/projects/1/pipelines/6100/jobs") return s.end(jobs(32));
  if (/\/jobs\/3[12]\/trace$/.test(u)) { s.setHeader("content-type", "text/plain"); return s.end(TRACE); }
  if (qs.startsWith("/api/v4/projects/1/pipelines?ref=")) return s.end(JSON.stringify([{ id: 6100, status: "failed", sha: "bbb" }]));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
  env: { ...process.env, GITLAB_URL: "http://127.0.0.1:" + srv.address().port, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
});
let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
const code = await new Promise((r) => child.on("close", r));
srv.close();
const ack = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-92.json", "utf8"));
const types = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const noopEv = types.find((x) => x.type === "claim_noop");
const ok = code === 0
  && ack.state === "inherited_only" && ack.pending.length === 0 && ack.ci.inheritedCount === 1 && ack.ci.baselineStatus === "failed"
  && !existsSync(repo + "/.ai/task-loop/pack-92.md")
  && noopEv && noopEv.detail.why === "inherited_only"
  && /基线同款/.test(out) && /不修/.test(out);
console.log(ok ? "ok" : "bad", code);
' "$HERE" "$TL5KB/w" "$TMP/ledger5kb" > "$TMP/e2e5kb.txt" 2>&1
grep -q "^ok 0$" "$TMP/e2e5kb.txt" && r=0 || { cat "$TMP/e2e5kb.txt"; r=1; }
check "基线同款终态：inherited_only+claim_noop(why)+无工单（不在本 MR 修基线红）" "0" "$r"

echo "== 5k-ter. 无法归因不判『不修』：trace 拉不到 → job 级工单 + ci_opaque（CR 🔴#1 回归钉）=="
TL5T="$TMP/e2e5t"; git init -q --bare "$TL5T/r.git"
git clone -q "$TL5T/r.git" "$TL5T/w" 2>/dev/null
( cd "$TL5T/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const u = q.url.split("?")[0]; const qs = q.url;
  if (u === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 81, project_id: 1, target_branch: "main", title: "trace 拿不到", sha: "abc", author: { username: "me" } }]));
  if (u === "/api/v4/user") return s.end(JSON.stringify({ username: "me" }));
  if (/\/merge_requests\/81\/discussions$/.test(u)) return s.end("[]");
  if (/\/merge_requests\/81$/.test(u)) return s.end(JSON.stringify({ iid: 81, target_branch: "main", head_pipeline: { id: 7201, status: "failed", web_url: "http://g/p/7201" } }));
  if (u === "/api/v4/projects/1/pipelines/7201/jobs") return s.end(JSON.stringify([{ id: 41, name: "gradle-build", stage: "build", status: "failed", web_url: "http://g/j/41" }]));
  if (/\/jobs\/41\/trace$/.test(u)) { s.statusCode = 500; return s.end("{}"); }
  if (qs.startsWith("/api/v4/projects/1/pipelines?ref=")) return s.end(JSON.stringify([{ id: 6500, status: "success", sha: "bbb" }]));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
  env: { ...process.env, GITLAB_URL: "http://127.0.0.1:" + srv.address().port, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
});
let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
const code = await new Promise((r) => child.on("close", r));
srv.close();
const ack = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-81.json", "utf8"));
const pack = readFileSync(repo + "/.ai/task-loop/pack-81.md", "utf8");
const types = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
const ok = code === 0
  && ack.state === "working" && ack.pending.length === 1 && ack.pending[0].kind === "job" && /gradle-build/.test(ack.pending[0].fingerprint)
  && ack.ci.opaque === true && ack.ci.traceFailures === 1
  && types.includes("ci_opaque") && !types.includes("claim_noop")
  && /自动归因失败/.test(pack) && /http:\/\/g\/j\/41/.test(pack);
const fsmod = await import("node:fs");
const traceFile = fsmod.existsSync(repo + "/.ai/task-loop/traces/81/gradle-build.log");
console.log(ok && traceFile ? "ok" : "bad", code);
' "$HERE" "$TL5T/w" "$TMP/ledger5t" > "$TMP/e2e5t.txt" 2>&1
grep -q "^ok 0$" "$TMP/e2e5t.txt" && r=0 || { cat "$TMP/e2e5t.txt"; r=1; }
check "无法归因：trace 拉不到 → job 级工单+ci_opaque（不是 inherited_only『不修』）" "0" "$r"

echo "== 5k-quad. 详情瞬断 → 整源软失败 → 存量 ack 不误关账（CR 🔴#2 回归钉）=="
TL5Q="$TMP/e2e5q"; git init -q --bare "$TL5Q/r.git"
git clone -q "$TL5Q/r.git" "$TL5Q/w" 2>/dev/null
( cd "$TL5Q/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
let detailBroken = false;
const TRACE = "2026-11-16T10:41:13.890099Z 01O [ERROR] /workspace/tda-server/src/main/java/A.java:[1,1] cannot find symbol\n";
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const u = q.url.split("?")[0]; const qs = q.url;
  if (u === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 71, project_id: 1, target_branch: "main", title: "详情瞬断", sha: "abc", author: { username: "me" } }]));
  if (u === "/api/v4/user") return s.end(JSON.stringify({ username: "me" }));
  if (/\/merge_requests\/71\/discussions$/.test(u)) return s.end("[]");
  if (/\/merge_requests\/71$/.test(u)) {
    if (detailBroken) { s.statusCode = 500; return s.end("{}"); }
    return s.end(JSON.stringify({ iid: 71, target_branch: "main", head_pipeline: { id: 7301, status: "failed", web_url: "http://g/p/7301" } }));
  }
  if (u === "/api/v4/projects/1/pipelines/7301/jobs") return s.end(JSON.stringify([{ id: 51, name: "build", stage: "compile", status: "failed", web_url: "http://g/j/51" }]));
  if (/\/jobs\/51\/trace$/.test(u)) { s.setHeader("content-type", "text/plain"); return s.end(TRACE); }
  if (qs.startsWith("/api/v4/projects/1/pipelines?ref=")) return s.end(JSON.stringify([{ id: 6400, status: "success", sha: "bbb" }]));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + srv.address().port;
const run = async () => {
  const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
    env: { ...process.env, GITLAB_URL: url, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
  });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const code = await new Promise((r) => child.on("close", r));
  return { code, out };
};
const r1 = await run();
detailBroken = true;
const r2 = await run();
srv.close();
const types = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
const ok = r1.code === 0 && r2.code === 1
  && existsSync(repo + "/.ai/task-loop/ack-71.json") && existsSync(repo + "/.ai/task-loop/pack-71.md")
  && !types.includes("trigger_gone") && /源故障 gitlab/.test(r2.out);
console.log(ok ? "ok" : "bad", r1.code, r2.code);
' "$HERE" "$TL5Q/w" "$TMP/ledger5q" > "$TMP/e2e5q.txt" 2>&1
grep -q "^ok 0 1$" "$TMP/e2e5q.txt" && r=0 || { cat "$TMP/e2e5q.txt"; r=1; }
check "详情瞬断：软失败不动账（ack/工单保留、无 trigger_gone）" "0" "$r"

echo "== 5k-ter2. 混合视角不判『不修』：可见失败全继承 + 部分 trace 拉不到 → opaque（CR 二审 🔴#1′ 回归钉）=="
TL5T2="$TMP/e2e5t2"; git init -q --bare "$TL5T2/r.git"
git clone -q "$TL5T2/r.git" "$TL5T2/w" 2>/dev/null
( cd "$TL5T2/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
// job 61 trace 正常且失败与基线同款（继承）；job 62 trace 500 → 视角不完整 → 不得 inherited_only
const TRACE_A = "[ERROR] /w/a/src/A.java:[1,1] boom\n";
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const u = q.url.split("?")[0]; const qs = q.url;
  if (u === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 83, project_id: 1, target_branch: "main", title: "混合视角", sha: "abc", author: { username: "me" } }]));
  if (u === "/api/v4/user") return s.end(JSON.stringify({ username: "me" }));
  if (/\/merge_requests\/83\/discussions$/.test(u)) return s.end("[]");
  if (/\/merge_requests\/83$/.test(u)) return s.end(JSON.stringify({ iid: 83, target_branch: "main", head_pipeline: { id: 7401, status: "failed", web_url: "http://g/p/7401" } }));
  if (u === "/api/v4/projects/1/pipelines/7401/jobs") return s.end(JSON.stringify([
    { id: 61, name: "job-a", stage: "test", status: "failed", web_url: "http://g/j/61" },
    { id: 62, name: "job-b", stage: "test", status: "failed", web_url: "http://g/j/62" },
  ]));
  if (u === "/api/v4/projects/1/pipelines/6200/jobs") return s.end(JSON.stringify([{ id: 63, name: "base", stage: "test", status: "failed", web_url: "http://g/j/63" }]));
  if (/\/jobs\/61\/trace$/.test(u)) { s.setHeader("content-type", "text/plain"); return s.end(TRACE_A); }
  if (/\/jobs\/62\/trace$/.test(u)) { s.statusCode = 500; return s.end("{}"); }
  if (/\/jobs\/63\/trace$/.test(u)) { s.setHeader("content-type", "text/plain"); return s.end(TRACE_A); }
  if (qs.startsWith("/api/v4/projects/1/pipelines?ref=")) return s.end(JSON.stringify([{ id: 6200, status: "failed", sha: "bbb" }]));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
  env: { ...process.env, GITLAB_URL: "http://127.0.0.1:" + srv.address().port, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
});
let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
const code = await new Promise((r) => child.on("close", r));
srv.close();
const ack = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-83.json", "utf8"));
const pack = readFileSync(repo + "/.ai/task-loop/pack-83.md", "utf8");
const types = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
const ok = code === 0
  && ack.state === "working" && ack.ci.opaque === true && ack.pending.length >= 1
  && types.includes("ci_opaque") && !types.includes("claim_noop")
  && /视角不完整/.test(pack) && /job-b/.test(pack);
console.log(ok ? "ok" : "bad", code);
' "$HERE" "$TL5T2/w" "$TMP/ledger5t2" > "$TMP/e2e5t2.txt" 2>&1
grep -q "^ok 0$" "$TMP/e2e5t2.txt" && r=0 || { cat "$TMP/e2e5t2.txt"; r=1; }
check "混合视角：可见全继承+trace 缺失 → opaque（不判 inherited_only）" "0" "$r"

echo "== 5k-ter3. 零识别栈（trace 正常但无失败行）→ 同样 opaque；404 详情有观测 =="
TL5T3="$TMP/e2e5t3"; git init -q --bare "$TL5T3/r.git"
git clone -q "$TL5T3/r.git" "$TL5T3/w" 2>/dev/null
( cd "$TL5T3/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
let phase = 1; // 1=trace 正常但 Gradle 形态零识别；2=详情 404（刚被关闭的竞态）
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const u = q.url.split("?")[0]; const qs = q.url;
  if (u === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 84, project_id: 1, target_branch: "main", title: "零识别", sha: "abc", author: { username: "me" } }]));
  if (u === "/api/v4/user") return s.end(JSON.stringify({ username: "me" }));
  if (/\/merge_requests\/84\/discussions$/.test(u)) return s.end("[]");
  if (/\/merge_requests\/84$/.test(u)) {
    if (phase === 2) { s.statusCode = 404; return s.end("{}"); }
    return s.end(JSON.stringify({ iid: 84, target_branch: "main", head_pipeline: { id: 7501, status: "failed", web_url: "http://g/p/7501" } }));
  }
  if (u === "/api/v4/projects/1/pipelines/7501/jobs") return s.end(JSON.stringify([{ id: 45, name: "gradle", stage: "build", status: "failed", web_url: "http://g/j/45" }]));
  if (/\/jobs\/45\/trace$/.test(u)) { s.setHeader("content-type", "text/plain"); return s.end("Starting Gradle Daemon...\n> Task :compileJava FAILED\n\nBUILD FAILED in 12s\n"); }
  if (qs.startsWith("/api/v4/projects/1/pipelines?ref=")) return s.end(JSON.stringify([{ id: 6300, status: "success", sha: "bbb" }]));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + srv.address().port;
const run = async () => {
  const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
    env: { ...process.env, GITLAB_URL: url, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
  });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const code = await new Promise((r) => child.on("close", r));
  return { code, out };
};
const r1 = await run(); // 零识别 → opaque
const ack = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-84.json", "utf8"));
const pack = readFileSync(repo + "/.ai/task-loop/pack-84.md", "utf8");
phase = 2;
const r2 = await run(); // 详情 404 → 无触发但有观测行，不 die 不崩
srv.close();
const types = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
const ok1 = r1.code === 0 && ack.ci.opaque === true && ack.pending[0].kind === "job" && /自动归因失败/.test(pack) && types.includes("ci_opaque");
const ok2 = r2.code === 0 && /404/.test(r2.out) && types.includes("mr_detail_404");
console.log(ok1 ? "ok1" : "bad1", ok2 ? "ok2" : "bad2", r1.code, r2.code);
' "$HERE" "$TL5T3/w" "$TMP/ledger5t3" > "$TMP/e2e5t3.txt" 2>&1
grep -q "^ok1 ok2 0 0$" "$TMP/e2e5t3.txt" && r=0 || { cat "$TMP/e2e5t3.txt"; r=1; }
check "零识别栈同样 opaque；详情 404 竞态有观测行不 die（mr_detail_404）" "0" "$r"

echo "== 5m. 在途流水不关账：推送后 running 保持账目，终态 success 才关账（ci-inflight-hold 实测事故钉）=="
# 实测：执行器 18:10 推送 → 流水 running → 18:14 sweep 把 !1847 当"已合并/已批红"关账（误报）。
TL5M="$TMP/e2e5m"; git init -q --bare "$TL5M/r.git"
git clone -q "$TL5M/r.git" "$TL5M/w" 2>/dev/null
( cd "$TL5M/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
let phase = 1; // 1=failed(认领) 2=running(在途) 2.5=无流水(推送→创建的秒级窗口) 3=success(终态关账)
const TRACE = "[ERROR] /w/a/src/A.java:[1,1] boom\n";
const hp = () => phase === 1 ? { id: 7001, status: "failed", web_url: "http://g/p/7001" }
  : phase === 2 ? { id: 7002, status: "running", web_url: "http://g/p/7002" }
  : phase === 2.5 ? null
  : { id: 7002, status: "success", web_url: "http://g/p/7002" };
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const u = q.url.split("?")[0]; const qs = q.url;
  if (u === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 95, project_id: 1, target_branch: "main", title: "在途", sha: "abc", author: { username: "me" } }]));
  if (u === "/api/v4/user") return s.end(JSON.stringify({ username: "me" }));
  if (/\/merge_requests\/95\/discussions$/.test(u)) return s.end("[]");
  if (/\/merge_requests\/95$/.test(u)) return s.end(JSON.stringify({ iid: 95, target_branch: "main", head_pipeline: hp() }));
  if (u === "/api/v4/projects/1/pipelines/7001/jobs") return s.end(JSON.stringify([{ id: 13, name: "b", stage: "build", status: "failed", web_url: "http://j/13" }]));
  if (/\/jobs\/13\/trace$/.test(u)) { s.setHeader("content-type", "text/plain"); return s.end(TRACE); }
  if (qs.startsWith("/api/v4/projects/1/pipelines?ref=")) return s.end(JSON.stringify([{ id: 6999, status: "success", sha: "b" }]));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + srv.address().port;
const run = async () => {
  const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
    env: { ...process.env, GITLAB_URL: url, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
  });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const code = await new Promise((r) => child.on("close", r));
  return { code, out };
};
const r1 = await run(); // 认领 failed
phase = 2;
const r2 = await run(); // running：不关账、不重认领、账目保持
phase = 2.5;
const r25 = await run(); // 无流水（推送→创建窗口）：同样保持（终态白名单的对面）
const held = r2.code === 0 && r25.code === 0 && existsSync(repo + "/.ai/task-loop/ack-95.json") && /流水在跑/.test(r2.out) && /流水在跑/.test(r25.out);
const types2 = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
const noGone = !types2.includes("trigger_gone");
phase = 3;
const r3 = await run(); // success：真终态，关账
srv.close();
const closed = r3.code === 0 && !existsSync(repo + "/.ai/task-loop/ack-95.json") && /关账 1/.test(r3.out);
console.log(held && noGone ? "held-ok" : "held-bad", closed ? "closed-ok" : "closed-bad", r1.code, r2.code, r25.code, r3.code);
' "$HERE" "$TL5M/w" "$TMP/ledger5m" > "$TMP/e2e5m.txt" 2>&1
grep -q "^held-ok closed-ok 0 0 0 0$" "$TMP/e2e5m.txt" && r=0 || { cat "$TMP/e2e5m.txt"; r=1; }
check "在途流水：running 与无流水窗口都保持账目（无 trigger_gone），success 才关账" "0" "$r"

echo "== 5m-bis. 跨流水轮次上限：第 4 轮归因 → needs_human 升级，不再出工单（防越修越坏循环）=="
TL5MB="$TMP/e2e5mb"; git init -q --bare "$TL5MB/r.git"
git clone -q "$TL5MB/r.git" "$TL5MB/w" 2>/dev/null
( cd "$TL5MB/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
node --input-type=module -e '
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const [here, repo, ledger] = process.argv.slice(1);
let pipeId = 7101;
const TRACE = "[ERROR] /w/a/src/A.java:[1,1] boom\n";
const srv = createServer((q, s) => {
  s.setHeader("content-type", "application/json");
  const u = q.url.split("?")[0]; const qs = q.url;
  if (u === "/api/v4/merge_requests") return s.end(JSON.stringify([{ iid: 96, project_id: 1, target_branch: "main", title: "轮次上限", sha: "abc", author: { username: "me" } }]));
  if (u === "/api/v4/user") return s.end(JSON.stringify({ username: "me" }));
  if (/\/merge_requests\/96\/discussions$/.test(u)) return s.end("[]");
  if (/\/merge_requests\/96$/.test(u)) return s.end(JSON.stringify({ iid: 96, target_branch: "main", head_pipeline: { id: pipeId, status: "failed", web_url: "http://g/" + pipeId } }));
  if (new RegExp("/api/v4/projects/1/pipelines/" + pipeId + "/jobs$").test(u)) return s.end(JSON.stringify([{ id: 21, name: "b", stage: "build", status: "failed", web_url: "http://j/21" }]));
  if (/\/jobs\/21\/trace$/.test(u)) { s.setHeader("content-type", "text/plain"); return s.end(TRACE); }
  if (qs.startsWith("/api/v4/projects/1/pipelines?ref=")) return s.end(JSON.stringify([{ id: 6998, status: "success", sha: "b" }]));
  s.statusCode = 404; s.end("{}");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + srv.address().port;
const run = async () => {
  const child = spawn("node", [here + "/scripts/task-loop.mjs", "--once", "--profile", "a", "--root", repo], {
    env: { ...process.env, GITLAB_URL: url, GITLAB_TOKEN: "f", GITLAB_USERNAME: "me", HARNESS_LEDGER_DIR: ledger },
  });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const code = await new Promise((r) => child.on("close", r));
  return { code, out };
};
// 轮 1：正常认领（rounds=1）
const r1 = await run();
if (!existsSync(repo + "/.ai/task-loop/ack-96.json")) { console.log("R1-DIAG code=" + r1.code + " out=" + r1.out.slice(0, 800)); process.exit(1); }
const ack1 = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-96.json", "utf8"));
// 轮 2：新流水 → stale 重认领，rounds 携带为 2
pipeId = 7102;
const r2 = await run();
const ack2 = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-96.json", "utf8"));
// 轮 3：预置 rounds=3 的 ack + 新流水 → 第 4 轮归因 → needs_human 升级、无工单
pipeId = 7103;
const a = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-96.json", "utf8"));
a.ci.rounds = 3;
writeFileSync(repo + "/.ai/task-loop/ack-96.json", JSON.stringify(a, null, 2));
const r3 = await run();
srv.close();
if (!existsSync(repo + "/.ai/task-loop/ack-96.json")) { console.log("R3-DIAG code=" + r3.code + " out=" + r3.out.slice(0, 900)); process.exit(1); }
const ack3 = JSON.parse(readFileSync(repo + "/.ai/task-loop/ack-96.json", "utf8"));
const types = readFileSync(ledger + "/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
const ok = r1.code === 0 && r2.code === 0 && r3.code === 0
  && ack1.ci.rounds === 1 && ack2.ci.rounds === 2
  && ack3.state === "needs_human" && ack3.ci.rounds === 4
  && !existsSync(repo + "/.ai/task-loop/pack-96.md")
  && types.includes("ci_escalated") && /升级给人/.test(r3.out);
console.log(ok ? "ok" : "bad", r1.code, r2.code, r3.code, ack1.ci.rounds, ack2.ci.rounds, ack3.ci.rounds, ack3.state);
' "$HERE" "$TL5MB/w" "$TMP/ledger5mb" > "$TMP/e2e5mb.txt" 2>&1
grep -q "^ok 0 0 0 1 2 4 needs_human$" "$TMP/e2e5mb.txt" && r=0 || { cat "$TMP/e2e5mb.txt"; r=1; }
check "轮次携带与上限：rounds 跨流水累计（1→2→4），超 3 → needs_human+ci_escalated+无新工单" "0" "$r"

echo "== 5n. 轮次锁：并发轮互斥（launchd 180s 心跳 vs 慢轮次），孤儿锁 30min 接管 =="
TL5N="$TMP/e2e5n"; git init -q --bare "$TL5N/r.git"
git clone -q "$TL5N/r.git" "$TL5N/w" 2>/dev/null
( cd "$TL5N/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
# 新鲜锁 → 跳过（HOME 隔离：锁检查之后才解析源，顺序一挪就会读真凭据——同 10d 教训）
mkdir -p "$TMP/h5n1" "$TL5N/w/.ai/locks" && printf "other-123\n" > "$TL5N/w/.ai/locks/task-loop.round"
OUT1="$(env HOME="$TMP/h5n1" GITLAB_URL= GITLAB_TOKEN= HARNESS_ENV_FILE=/nonexistent node "$HERE/scripts/task-loop.mjs" --once --root "$TL5N/w" 2>&1 | head -2)"
case "$OUT1" in *"上一轮仍在进行"*) r1=0 ;; *) r1=1; echo "FRESH-LOCK-OUT: $OUT1";; esac
check "新鲜轮次锁 → 本轮跳过（不并发改账）" "0" "$r1"
# 🔴 CR 回归钉：跳过的进程不得删持有者的锁（否则慢轮场景第三进程趁虚而入=锁自毁）
[ -s "$TL5N/w/.ai/locks/task-loop.round" ]; check "跳过后持有者的锁仍在（exit 只清自己的锁）" "0" "$?"
# 孤儿锁（mtime 40 分钟前）→ 接管照跑
touch -t "$(date -v-40M +%Y%m%d%H%M.%S 2>/dev/null || date -d '40 minutes ago' +%Y%m%d%H%M.%S)" "$TL5N/w/.ai/locks/task-loop.round"
# HOME 必须给假目录：否则读到本机真实 feishu 凭据并对生产飞书发请求（同 10d 的教训）
mkdir -p "$TMP/h5n"
OUT2="$(env HOME="$TMP/h5n" GITLAB_URL= GITLAB_TOKEN= HARNESS_ENV_FILE=/nonexistent node "$HERE/scripts/task-loop.mjs" --once --root "$TL5N/w" 2>&1 | grep -c "未接入任何触发源")"
check "孤儿锁（>30min）→ 接管并正常跑（退出 0 路径不受影响）" "1" "$OUT2"
[ -e "$TL5N/w/.ai/locks/task-loop.round" ] && r3=1 || r3=0
check "正常轮结束自清锁（不留假锁害下一轮）" "0" "$r3"
# 🟡#2：fresh clone 首跑没有 locks 目录——锁要自建目录而不是静默无锁
TL5N2="$TMP/e2e5n2"; git init -q --bare "$TL5N2/r.git" 2>/dev/null
git clone -q "$TL5N2/r.git" "$TL5N2/w" 2>/dev/null
( cd "$TL5N2/w" && git config user.email t@t && git config user.name t \
  && cp "$HERE/harness.rules.json" . && mkdir -p .zcode && printf '{"hooks":{"enabled":true}}' > .zcode/config.json \
  && git add -A && git commit -qm base && git push -q origin HEAD:main )
rm -rf "$TL5N2/w/.ai/locks"
OUT4="$(env HOME="$TMP/h5n1" GITLAB_URL= GITLAB_TOKEN= HARNESS_ENV_FILE=/nonexistent node "$HERE/scripts/task-loop.mjs" --once --root "$TL5N2/w" 2>&1 | grep -c "未接入任何触发源")"
check "fresh clone 无 locks 目录 → 自建并正常跑（不静默无锁）" "1" "$OUT4"

echo "== 5k-quin. 识别器单元：多栈行/噪声跳过/路径归一/去重/未知基线保守 =="
node --input-type=module -e '
import { ciFailure, extractCiFailures, normalizeCodePath, attributeCi } from "'"$HERE"'/scripts/lib/ci-failures.mjs";
const must = (cond, name) => { if (!cond) { console.log("FAIL " + name); process.exit(1); } };
must(ciFailure("2026-11-16T10:41:13.890093Z 01O [ERROR] /root/gitlab-runner/builds/qceIO3XVF/0/rd-app/idmp/tda-server/src/main/java/A.java:[93,29] variable x is already defined").kind === "javac", "javac");
must(ciFailure("[ERROR] /workspace/tda-server/src/main/java/A.java:[93,29] variable x is already defined").kind === "javac", "javac-no-prefix");
must(ciFailure("[ERROR]   com.taosdata.XTest.testScope:42 expected: true but was: false").fingerprint === "com.taosdata.XTest.testScope", "surefire");
must(ciFailure("FAILED tests/test_api.py::test_share_denied - AssertionError: assert 403").kind === "test", "pytest");
must(ciFailure("--- FAIL: TestPanelScope (0.01s)").fingerprint === "TestPanelScope", "go");
must(ciFailure("  ✗ 未入库日志不算证据 (期望 1，实际 0)").kind === "check", "repo-check");
must(!ciFailure("2026-11-16T10:41:13.890073Z 01O [ERROR] COMPILATION ERROR : "), "noise-compilation");
must(!ciFailure("[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0"), "noise-summary");
must(!ciFailure("[INFO] Tests run: 4, Failures: 0"), "noise-info");
must(ciFailure("2026-11-16T10:41:13.890093Z 01O [ERROR] /root/gitlab-runner/builds/qceIO3XVF/0/rd-app/idmp/tda-server/src/main/java/A.java:[93,29] x")?.fingerprint === ciFailure("[ERROR] /workspace/tda-server/src/main/java/A.java:[93,29] x")?.fingerprint, "path-normalize");
must(normalizeCodePath("/workspace/tda-server/src/main/java/A.java") === "tda-server/src/main/java/A.java", "normalize-unit");
must(extractCiFailures("[ERROR] /w/a/src/A.java:[1,1] boom\n[ERROR] /r/b/x/a/src/A.java:[1,1] boom\n[ERROR] /w/a/src/A.java:[2,1] boom").length === 1, "dedup");
must(ciFailure("\u001b[90m2026-11-16T10:41:13.890093Z\u001b[0m 01O [ERROR] /w/a/src/A.java:[1,1] boom")?.fingerprint === ciFailure("[ERROR] /w/a/src/A.java:[1,1] boom")?.fingerprint, "ansi-timestamp");
must(ciFailure("[ERROR] C:\\build\\a\\src\\A.java:[1,1] boom")?.fingerprint === ciFailure("[ERROR] D:\\other\\a\\src\\A.java:[1,1] boom")?.fingerprint, "backslash");
must(ciFailure(" ✕ renders panel (12 ms)")?.fingerprint === ciFailure(" ✕ renders panel (15ms)")?.fingerprint, "jest-duration");
const a = attributeCi({ mine: [{ id: "x", suite: "j", fingerprint: "x" }], baseline: null });
must(a.baselineKnown === false && a.introduced.length === 1 && a.inherited.length === 0, "unknown-baseline-conservative");
const b = attributeCi({ mine: [{ id: "x", suite: "j", fingerprint: "x" }, { id: "y", suite: "j", fingerprint: "y" }], baseline: { status: "failed", failures: [{ id: "x", suite: "b", fingerprint: "x" }] } });
must(b.introduced.length === 1 && b.inherited.length === 1 && b.resolved.length === 0, "setdiff-reuse");
console.log("unit-ok");
' > "$TMP/ciunit.txt" 2>&1
grep -q "^unit-ok$" "$TMP/ciunit.txt" && r=0 || { cat "$TMP/ciunit.txt"; r=1; }
check "识别器/归因单元：六栈识别、噪声跳过、同文件跨 job 同指纹、未知基线保守" "0" "$r"

echo "== 5j. 节拍入库：pollSeconds 1800=30min（2026-11-17 与执行器节拍对齐）=="
grep -q '"pollSeconds": 1800' "$HERE/harness.rules.json"
check "runtime.taskLoop.pollSeconds=1800 已入库（文档口径同步 FS §8）" "0" "$?"

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
# label 随仓库目录名派生（U8 多仓隔离）：测试按同一规则推期望值，不写死
EXP_LABEL="com.harness.task-loop.$(basename "$ROOT" | tr -c 'A-Za-z0-9' '-' | sed -e 's/-\{2,\}/-/g' -e 's/^-*//' -e 's/-*$//' | cut -c1-24)"
HOME="$TMP/h2" GITLAB_URL=http://127.0.0.1:1 GITLAB_TOKEN="$FAKE_TOKEN" FEISHU_MCP_URL=https://m.example.com/x \
  bash "$HERE/scripts/install-task-loop.sh" "$ROOT" --no-activate > "$TMP/inst.txt" 2>&1
check "安装成功" "0" "$?"
mode_of(){ if [ "$(uname)" = "Darwin" ]; then stat -f %Lp "$1"; else stat -c %a "$1"; fi; }
D="$TMP/h2/.harness/task-loop"
check "凭据文件 0600" "600" "$(mode_of "$D/task-loop.env")"
check "包装脚本 0700（定时器实际执行的是它）" "700" "$(mode_of "$D/run-round.sh")"
check "凭据目录 0700" "700" "$(mode_of "$D")"
# 定时器配置按平台落点：macOS 写 plist、Linux 写 systemd user unit。
# 权限断言只在 plist 上做——安装器给它 chmod 600，unit 则没有（也不该有：
# systemd 的 unit 不是秘密文件的容器，真正的秘密在 task-loop.env 里）。
# 两边都要断言的是**不含 token**，那才是这条要守的性质；把"unit 必须 0600"写成判据
# 等于凭空造一条需求，然后为了让测试过而去改安装器。
if [ "$(uname)" = "Darwin" ]; then
  UNIT_FILE="$TMP/h2/Library/LaunchAgents/${EXP_LABEL}.plist"
  check "plist 0600" "600" "$(mode_of "$UNIT_FILE")"
else
  UNIT_FILE="$TMP/h2/.config/systemd/user/${EXP_LABEL}.service"
fi
grep -q "$FAKE_TOKEN" "$UNIT_FILE" 2>/dev/null
check "定时器配置不含 token" "1" "$?"
grep -q "GITLAB_TOKEN=$FAKE_TOKEN" "$D/task-loop.env"; check "token 落在 0600 文件里" "0" "$?"

echo "== 10d. wrapper 是凭据的唯一入口：干净环境（模拟 launchd）下仍能取到 token =="
# launchd 不继承登录 shell 的 env，systemd 的 unit 也不再写 Environment=。
# 所以这条必须用 env -i 跑：带环境的测试证明不了"定时器环境里能读到凭据"。
bash -n "$D/run-round.sh"; check "wrapper 语法合法" "0" "$?"
# stderr 合流（2026-11-16）：plist 把 stderr 分流到 .err，只走 stderr 的报错在 .out 里不可见
# （实测：源超时 die(1) 连转 9 小时，.out 只有"凭据已载入"）。exec 行 2>&1 把 node 输出合进 .out；
# bash 自身 shell-init 噪声仍留 .err（发生在 exec 之前）。
grep -q '2>&1' "$D/run-round.sh"; check "wrapper exec 行 2>&1（stderr 不再被藏起来）" "0" "$?"
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
# 地址指向不可达端口：连不上（临时故障）不再 die，但"剖面 A 临时不可达"同样证明
# GITLAB_URL/TOKEN 被读进来了（没读到会走"未接入"分支退出 0，不提剖面 A）。
case "$OUT" in *"剖面 A"*) check "wrapper 注入凭据并进入 runner" "0" "0" ;; *) check "wrapper 注入凭据并进入 runner" "0" "1: $OUT" ;; esac

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

echo "== 10g. 旧版安装器写过明文 token 的 plist / unit：重装后必须提示轮换 =="
# 重写文件不会让已经落盘的 token 失效。写过就当泄露处理——这是唯一诚实的处置。
# 落点按平台取：安装器只检查本平台的定时器配置，在 Linux 上摆一个 plist 什么也证明不了
# （它根本不会被读），那会变成一条"看起来在判、其实对着空气"的断言。
mkdir -p "$TMP/h3/Library/LaunchAgents" "$TMP/h3/.config/systemd/user"
if [ "$(uname)" = "Darwin" ]; then
  LEGACY="$TMP/h3/Library/LaunchAgents/com.harness.task-loop.plist"
  printf '<plist><dict><key>GITLAB_TOKEN</key><string>old-plaintext</string></dict></plist>\n' > "$LEGACY"
else
  LEGACY="$TMP/h3/.config/systemd/user/com.harness.task-loop.service"
  printf '[Service]\nEnvironment=GITLAB_TOKEN=old-plaintext\n' > "$LEGACY"
fi
HOME="$TMP/h3" GITLAB_TOKEN=newt bash "$HERE/scripts/install-task-loop.sh" "$ROOT" --no-activate > "$TMP/legacy.txt" 2>&1
grep -q "明文凭据" "$TMP/legacy.txt"; check "旧定时器配置含 token → 提示撤销重建" "0" "$?"
# 2026-11-14 起：旧明文文件被改名封存（.leaked.<日期>）——原路径无文件也算"已无 token"
if [ ! -f "$LEGACY" ] || ! grep -q "GITLAB_TOKEN" "$LEGACY" 2>/dev/null; then r=0; else r=1; fi
check "重装后原路径已无 token（改名封存或清除）" "0" "$r"

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
# 第二行是一条**会留下痕迹**的 shell 命令（不是 KEY=VALUE）。如果哪天真被 source 了，
# pwn4 就会出现——这条比"报错文案好看"更能证明文件没被执行。
# 别在这里写"下载再交给 shell"那种一行式：仓库自己的高危命令扫描会命中 `| sh`，
# 于是这条断言会把 CI 判红，而它想证明的恰恰是"这类东西不该被执行"。
BADC="$TMP/bad.env"
printf 'GITLAB_TOKEN=x\ntouch %s/pwn4\n' "$TMP" > "$BADC"; chmod 600 "$BADC"
env -u GITLAB_URL -u GITLAB_TOKEN HOME="$TMP/h4" HARNESS_ENV_FILE="$BADC" \
  node "$HERE/scripts/task-loop.mjs" --once --root "$ROOT" > "$TMP/badenv.txt" 2>&1
check "非法行 → exit 1（不静默当作没配）" "1" "$?"
grep -q ":2" "$TMP/badenv.txt"; check "报错带行号（定位不用猜）" "0" "$?"
[ -e "$TMP/pwn4" ] && P4=存在 || P4=不存在
check "那一行没有被执行（pwn4 不存在）" "不存在" "$P4"

echo "== 10j. runner 自己读 HARNESS_ENV_FILE：不靠 shell 注入也能拿到凭据 =="
NODE_BIN="$(command -v node)"
GOODC="$TMP/good.env"
printf 'GITLAB_URL=http://127.0.0.1:1\nGITLAB_TOKEN=glpat-from-file\n' > "$GOODC"; chmod 600 "$GOODC"
run_clean_env() { env -i HOME="$TMP/h6" PATH=/usr/bin:/bin HARNESS_ENV_FILE="$GOODC" \
  HARNESS_LEDGER_DIR="$TMP/l6" "$NODE_BIN" "$HERE/scripts/task-loop.mjs" --once --root "$ROOT" 2>&1 | head -6; }
OUT="$(run_clean_env)"
# 地址指向不可达端口：连不上（临时故障）不再 die，但只要提到"剖面 A"就证明 url/token 被读进来了
# （没读到会走"未接入"分支退出 0，一个字都不提剖面 A）。
case "$OUT" in *"剖面 A"*) check "干净环境 + 凭据文件 → 进入 runner 并真的用了凭据" "0" "0" ;; *) check "干净环境 + 凭据文件 → 进入 runner 并真的用了凭据" "0" "1: $OUT" ;; esac
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
# 2026-11-15 语义重写（真实首跑三教训）：transition_state 专用工具 + MQL 回读 + 零评论。
# 旧四路（update_field/评论兜底/readbackOrComment）全部作废——该版本曾静默不流转+刷屏评论。
node --input-type=module -e '
import { transitionStatus } from "'"$HERE"'/scripts/lib/feishu-sync.mjs";
const mql = (label) => JSON.stringify({ data: { "1": [{ moql_field_list: [{ key: "work_item_status", value: { key_label_value_list: [{ label }] } }] }] } });
let flipped = false; const tools = [];
const mk = (states) => async (n, a) => {
  tools.push(n);
  if (n === "search_by_mql") return mql(flipped ? "Processing" : "New");
  if (n === "get_transitable_states") return typeof states === "string" ? states : JSON.stringify(states);
  if (n === "transition_state") { flipped = true; return "success"; }
  if (n === "add_comment") throw new Error("不得调用 add_comment（零评论语义）");
  return "{}";
};
// 1) 正常：New→Processing，transition_state(id) + 回读确认，全程无评论
const r1 = await transitionStatus({ call: mk({ transition: [{ id: 42, state_name: "Processing" }] }), projectKey: "t", workItemId: "1" });
// 2) 幂等：已是目标态 → already，不再调流转（把回读预设为 Processing）
flipped = true;
const r2 = await transitionStatus({ call: mk({ transition: [{ id: 42, state_name: "Processing" }] }), projectKey: "t", workItemId: "2" });
// 3) 目标不在可流转列表 → fail-closed 不硬转（回读重置为 New）
flipped = false;
const r3 = await transitionStatus({ call: mk({ transition: [{ id: 7, state_name: "Releasing" }] }), projectKey: "t", workItemId: "3", toStatus: "Processing" });
process.exit(r1.ok && r1.via === "transition_state" && r2.ok && r2.via === "already" && !r3.ok && !tools.includes("add_comment") && !tools.includes("update_field") ? 0 : 1);'
check "同步三路：transition_state 流转/幂等 already/拒硬转，全程零评论零 update_field" "0" "$?"
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

echo "== 11. 轮询节拍可配置（runtime.taskLoop.pollSeconds）：定时器心跳 vs 真实节拍 =="
# 夹具：无源仓库（同 3b），轮次走「未接入任何触发源」exit 0 路径，不碰任何凭据
TL="$TMP/throttle"; mkdir -p "$TL/.zcode"
cp "$HERE/harness.rules.json" "$TL/"
node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p));j.runtime.feishu.projectKey="";j.runtime.gitlab.url="";j.runtime.taskLoop={pollSeconds:180};fs.writeFileSync(p,JSON.stringify(j,null,2))' "$TL/harness.rules.json"
printf '{"hooks":{"enabled":true}}' > "$TL/.zcode/config.json"
mkdir -p "$TL/.ai/locks"
touch "$TL/.ai/locks/task-loop.last-run"
# 1) 定时器触发 + 新鲜戳 → 节流跳过
env -u GITLAB_URL -u GITLAB_TOKEN -u FEISHU_PROJECT_KEY HARNESS_TIMER=1 HOME="$TMP/nohome" \
  node "$HERE/scripts/task-loop.mjs" --once --root "$TL" > "$TMP/tl1.txt" 2>&1
check "定时器+新鲜戳 → 节流跳过（exit 0）" "0" "$?"
grep -q "本轮跳过" "$TMP/tl1.txt"; check "跳过说明节拍来源（pollSeconds）" "0" "$?"
# 2) 定时器触发 + 陈旧戳 → 正常跑并刷新戳
touch -t 202001010000 "$TL/.ai/locks/task-loop.last-run"
env -u GITLAB_URL -u GITLAB_TOKEN -u FEISHU_PROJECT_KEY HARNESS_TIMER=1 HOME="$TMP/nohome" \
  node "$HERE/scripts/task-loop.mjs" --once --root "$TL" > "$TMP/tl2.txt" 2>&1
check "定时器+陈旧戳 → 正常轮次（exit 0）" "0" "$?"
grep -q "未接入任何触发源" "$TMP/tl2.txt"; check "走的是真实轮次路径" "0" "$?"
node -e 'const {statSync}=require("fs");process.exit(Date.now()-statSync(process.argv[1]).mtimeMs<5000?0:1)' "$TL/.ai/locks/task-loop.last-run"
check "轮次成功后节流戳已刷新" "0" "$?"
# 3) 手动运行不受节拍限制（新鲜戳也照跑）
touch "$TL/.ai/locks/task-loop.last-run"
env -u GITLAB_URL -u GITLAB_TOKEN -u FEISHU_PROJECT_KEY -u HARNESS_TIMER HOME="$TMP/nohome" \
  node "$HERE/scripts/task-loop.mjs" --once --root "$TL" > "$TMP/tl3.txt" 2>&1
check "手动 --once + 新鲜戳 → 不节流照跑" "0" "$?"
grep -q "未接入任何触发源" "$TMP/tl3.txt"; check "确实跑了（不是被跳过）" "0" "$?"
# 4) env 覆盖：TASK_LOOP_INTERVAL=1 + 睡 1.2s → 新鲜戳也放行
touch "$TL/.ai/locks/task-loop.last-run"; sleep 1.2
env -u GITLAB_URL -u GITLAB_TOKEN -u FEISHU_PROJECT_KEY HARNESS_TIMER=1 TASK_LOOP_INTERVAL=1 HOME="$TMP/nohome" \
  node "$HERE/scripts/task-loop.mjs" --once --root "$TL" > "$TMP/tl4.txt" 2>&1
check "env TASK_LOOP_INTERVAL 覆盖生效（1s 节拍放行）" "0" "$?"
grep -q "未接入任何触发源" "$TMP/tl4.txt"; check "覆盖后走真实轮次" "0" "$?"
# 5) 模板注入了 HARNESS_TIMER（心跳与节拍的接合部）
grep -q "HARNESS_TIMER" "$HERE/deploy/task-loop/launchd.plist.template"; check "launchd 模板注入 HARNESS_TIMER=1" "0" "$?"
grep -q "Environment=HARNESS_TIMER=1" "$HERE/deploy/task-loop/systemd.service.template"; check "systemd 模板注入 HARNESS_TIMER=1" "0" "$?"

echo
[ "$skip" -eq 0 ] || printf "跳过：%d 项（原因见上，不计入通过/失败）\n" "$skip"
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
