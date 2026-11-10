#!/usr/bin/env bash
# task-loop 账实一致契约（契约测试，不是功能测试）。
#
# 为什么需要它：T1–T6 的代码已经全部落到 main，而 .ai/tasks/task-loop/state.json 还停在
# stage=fs_review、artifacts.fs=null、T0=pending。ci-verify 不校验 stage 与 todos 的关系，
# 所以门禁照绿——账本和代码打架，且没有任何一条判据看得见。
# 这个套件只问一件事：**账上写的，跟仓库里有的，是不是同一件事。**
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
check(){ if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); else printf "  \033[31m✗\033[0m %s (期望 %s，实际 %s)\n" "$1" "$3" "$2"; fail=$((fail+1)); fi; }
MUT="$(mktemp -d)"; trap 'rm -rf "$MUT"' EXIT

STATE="$HERE/.ai/tasks/task-loop/state.json"
WBS="$HERE/docs/02-features/task-loop/task-loop.wbs.md"

echo "== 1. 产物声明：artifacts 里登记的每一份都必须真实存在 =="
node --input-type=module -e '
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const [root, statePath] = process.argv.slice(1);
const s = JSON.parse(readFileSync(statePath, "utf8"));
const nulls = [], missing = [];
for (const [k, v] of Object.entries(s.artifacts || {})) {
  if (!v) { nulls.push(k); continue; }
  if (!existsSync(join(root, v))) missing.push(k + "=" + v);
}
console.log("空声明:" + (nulls.join(",") || "-"), "| 文件缺失:" + (missing.join(",") || "-"));
process.exit(missing.length ? 1 : 0);
' "$HERE" "$STATE" > "$MUT/artifacts.txt" 2>&1
check "登记过的产物文件都在" "0" "$?"
sed -n '1p' "$MUT/artifacts.txt" | grep -q "文件缺失:-" || cat "$MUT/artifacts.txt"

echo "== 2. 账实进度：todo 全绿时 stage 不能还停在产出阶段 =="
# 代码跑到 T6、账上写 fs_review——下一次有人真去推进阶段时，前置全是乱的。
node --input-type=module -e '
import { readFileSync } from "node:fs";
const [root, statePath] = process.argv.slice(1);
const { STAGE_CHAIN, STAGE_INDEX } = await import("file://" + root + "/hooks/lib/verify.mjs");
const s = JSON.parse(readFileSync(statePath, "utf8"));
if (!STAGE_CHAIN.includes(s.stage)) { console.log("未知阶段:" + s.stage); process.exit(1); }
const todos = s.todos || [];
const done = todos.filter((t) => t.status === "completed").length;
// 本任务的 TODO 全是实现项（T0 仓库税 / T1–T6 代码）。只要有一个已完成，
// 就说明实现已经开工，stage 必须至少到 impl。用"全部完成"当日志会漏掉"7/8 但代码已到 T6"
// 这种最常见的账实不符——所以判据取"有没有开始"，不取"有没有做完"。
const ok = done === 0 || STAGE_INDEX[s.stage] >= STAGE_INDEX.impl;
console.log(s.stage, done + "/" + todos.length, ok ? "consistent" : "ahead-of-stage");
process.exit(ok ? 0 : 1);
' "$HERE" "$STATE" > "$MUT/stage.txt" 2>&1
check "stage 与 todo 完成度一致（已完成实现项却停在 fs_review 会红）" "0" "$?"
sed -n '1p' "$MUT/stage.txt" | grep -q "consistent" || cat "$MUT/stage.txt"

echo "== 3. WBS 与账本用同一套 TODO 编号（写了没立项 / 立项了没写 都算不一致）="
node --input-type=module -e '
import { readFileSync } from "node:fs";
const [wbsPath, statePath] = process.argv.slice(1);
const wbs = readFileSync(wbsPath, "utf8");
const s = JSON.parse(readFileSync(statePath, "utf8"));
const inWbs = new Set([...wbs.matchAll(/\|\s*(T[0-9]+[a-z]?|V[0-9]+)\s*\|/g)].map((m) => m[1]));
const inState = new Set((s.todos || []).map((t) => t.id));
const onlyWbs = [...inWbs].filter((x) => !inState.has(x));
const onlyState = [...inState].filter((x) => !inWbs.has(x));
console.log("wbs:" + inWbs.size, "state:" + inState.size, "只有WBS:" + (onlyWbs.join(",") || "-"), "只有账本:" + (onlyState.join(",") || "-"));
process.exit(onlyWbs.length || onlyState.length ? 1 : 0);
' "$WBS" "$STATE" > "$MUT/ids.txt" 2>&1
check "WBS 的 TODO 编号与 state.todos 完全一致" "0" "$?"
sed -n '1p' "$MUT/ids.txt" | grep -q "只有WBS:- 只有账本:-" || cat "$MUT/ids.txt"

echo "== 4. 阶段历史：每个阶段都要有门禁结论，waived/deferred 必须记名 =="
node --input-type=module -e '
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.argv[1], "utf8"));
const bad = [];
for (const h of s.stage_history || []) {
  if (!h.gate) bad.push(h.stage + ":无结论");
  if ((h.gate === "waived" || h.gate === "deferred") && !h.waived_by) bad.push(h.stage + ":未记名");
}
console.log(bad.length ? bad.join(",") : "ok");
process.exit(bad.length ? 1 : 0);
' "$STATE" > "$MUT/hist.txt" 2>&1
check "阶段历史无裸结论 / 无未记名豁免" "0" "$?"

echo "== 5. 反向自检：把账本改回"代码先行"的形态，第 2 条必须变红 =="
# 一条不会红的契约测试等于没有。用临时副本做变异，不碰真账本。
node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
s.stage = "fs_review";
fs.writeFileSync(process.argv[2], JSON.stringify(s, null, 2));
' "$STATE" "$MUT/state.json"
node --input-type=module -e '
import { readFileSync } from "node:fs";
const [root, statePath] = process.argv.slice(1);
const { STAGE_INDEX } = await import("file://" + root + "/hooks/lib/verify.mjs");
const s = JSON.parse(readFileSync(statePath, "utf8"));
const todos = s.todos || [];
const done = todos.filter((t) => t.status === "completed").length;
process.exit(done === 0 || STAGE_INDEX[s.stage] >= STAGE_INDEX.impl ? 0 : 1);
' "$HERE" "$MUT/state.json" && r=0 || r=1
check "变异（stage 退回 fs_review）→ 判据变红" "$r" "1"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
