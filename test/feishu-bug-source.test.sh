#!/usr/bin/env bash
# 剖面 B 触发源自测（离线，不连网）：MQL 生成 / 真实响应解析 / 严重级归一 / 分级门槛 / fail-closed。
#
# 为什么这个套件必须存在：2026-11-10 之前这整段零覆盖，于是四个错一起活到了实跑——
#   表名单段（服务端 semantic error）、owner 当负责人（那是"创建者"）、
#   severity 字段不存在、状态下限写成中文"待处理"（枚举里只有 New/Processing/...）。
# 四个错里只有第一个报错，后三个是静默的：查询通了但结果为空、或者有结果却被判 P3 全丢。
# 所以下面的断言分两类：语法形状（防拼错）和真实 fixture 解析（防"通了但没人"）。
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
LIB="$HERE/scripts/lib/feishu-bug-source.mjs"
FIX_REAL="$HERE/test/fixtures/feishu-mql-defect-new.json"
FIX_MIX="$HERE/test/fixtures/feishu-mql-defect-mixed.json"

pass=0; fail=0
check(){ if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); else printf "  \033[31m✗\033[0m %s (期望 %s，实际 %s)\n" "$1" "$3" "$2"; fail=$((fail+1)); fi; }
contains(){ case "$1" in *"$2"*) return 0;; *) return 1;; esac; }

echo "== 1. MQL 生成：表名两段式 / 指派字段 / 状态算子 =="
cat > "$TMP/gen.mjs" <<JS
import { buildMyBugsMql } from '$LIB';
const mql = buildMyBugsMql({ projectKey: 'taosdata_td', type: 'Defect' });
console.log(JSON.stringify({
  mql,
  twoPart: /FROM \`taosdata_td\`\.\`Defect\`/.test(mql),
  noOnePart: !/FROM \`(缺陷|Defect)\`/.test(mql),
  assigneeField: /array_contains\(\`current_status_operator\`, current_login_user\(\)\)/.test(mql),
  noOwner: !/\`owner\`/.test(mql),
  statusEq: /\`work_item_status\` = 'New'/.test(mql),
  noArrayOnStatus: !/array_contains\(\`work_item_status\`/.test(mql),
  hasSeverityCol: /\`field_6bff71\`/.test(mql),
}));
JS
node "$TMP/gen.mjs" > "$TMP/gen.json" 2>&1
if [ ! -s "$TMP/gen.json" ]; then cat "$TMP/gen.json"; fi
val(){ node -e "const j=require('$TMP/gen.json'); process.stdout.write(String(j['$1']))"; }
check "FROM 是 \`空间\`.\`类型\` 两段式" "$(val twoPart)" "true"
check "不是单段表名（服务端报 semantic error 的那个形态）" "$(val noOnePart)" "true"
check "指派判据用 current_status_operator" "$(val assigneeField)" "true"
check "不含 owner（该空间 owner 是创建者，不是负责人）" "$(val noOwner)" "true"
check "状态用 = 而非 array_contains（该字段不支持该算子）" "$(val statusEq)" "true"
check "状态字段未用 array_contains" "$(val noArrayOnStatus)" "true"
check "SELECT 带出严重级字段" "$(val hasSeverityCol)" "true"
contains "$(val mql)" "LIMIT 20"; check "默认 LIMIT 20（上限 50 内）" "0" "$?"

echo
echo "== 2. 缺参数本地拦下（不把坏 MQL 发出去换一句 semantic error）=="
node --input-type=module -e '
import { buildMyBugsMql } from "'"$LIB"'";
const msg = (f) => { try { f(); return "(未抛错)"; } catch (e) { return e.message; } };
console.log(JSON.stringify({
  noProject: msg(() => buildMyBugsMql({})),
  noType: msg(() => buildMyBugsMql({ projectKey: "p" })),
  overLimit: buildMyBugsMql({ projectKey: "p", limit: 999 }),
}));
' > "$TMP/err.json" 2>&1
val2(){ node -e "const j=require('$TMP/err.json'); process.stdout.write(String(j['$1']))"; }
contains "$(val2 noProject)" "FEISHU_PROJECT_KEY"; check "缺 projectKey 报错并给出环境变量名" "0" "$?"
contains "$(val2 noProject)" "semantic error"; check "报错解释了服务端会怎么错（可诊断）" "0" "$?"
contains "$(val2 overLimit)" "LIMIT 50"; check "LIMIT 超上限被夹到 50" "0" "$?"

echo
echo "== 3. 真实响应解析（fixture 抓自 taosdata_td，未手写）=="
cat > "$TMP/parse.mjs" <<JS
import { readFileSync } from 'node:fs';
import { parseMqlResult } from '$LIB';
const real = readFileSync('$FIX_REAL', 'utf8');
const bugs = parseMqlResult(real, { severityKey: 'field_6bff71' });
console.log(JSON.stringify({
  n: bugs.length,
  ids: bugs.map((b) => b.work_item_id),
  sev: bugs.map((b) => b.severity),
  status: [...new Set(bugs.map((b) => b.status))],
  name0: bugs[0].name,
}));
JS
node "$TMP/parse.mjs" > "$TMP/parse.json" 2>&1
if [ ! -s "$TMP/parse.json" ]; then cat "$TMP/parse.json"; fi
val3(){ node -e "const j=require('$TMP/parse.json'); const v=j['$1']; process.stdout.write(Array.isArray(v)?v.join(','):String(v))"; }
check "真实形态解析出 3 行" "$(val3 n)" "3"
check "work_item_id 取到 long_value 本体（非对象）" "$(val3 ids)" "7067679088,7051528312,7016527863"
check "严重级「中」→ P2" "$(val3 sev)" "P2,P2,P2"
check "状态取 label（New）而非内部 key（Not started）" "$(val3 status)" "New"
check "标题取到 string_value" "$(val3 name0)" "样例缺陷标题 1"

echo
echo "== 4. 严重级归一：中文轻重 / P 档 / 英文 / 空值 =="
node --input-type=module -e '
import { normSeverity } from "'"$LIB"'";
const cases = [["高","P1"],["中","P2"],["低","P3"],["P0","P0"],["P1","P1"],["P2","P2"],["P3","P3"],
  ["严重","P1"],["一般","P2"],["致命","P0"],["Blocker","P0"],["Critical","P1"],["Major","P2"],["Minor","P3"],
  ["高优先级","P3"],["","P3"],[null,"P3"],[undefined,"P3"]];
const bad = cases.filter(([i,o]) => normSeverity(i) !== o);
console.log(JSON.stringify({ total: cases.length, bad }));
' > "$TMP/sev.json" 2>&1
node -e 'const j=require("'"$TMP"'/sev.json"); process.stdout.write(String(j.total))' > "$TMP/n.txt"
check "18 个归一用例全部通过" "$(node -e 'const j=require("'"$TMP"'/sev.json"); process.stdout.write(j.bad.length?JSON.stringify(j.bad):"0")')" "0"

echo
echo "== 5. 分级门槛：高→auto / 中→confirm / 低→skip / 缺值→skip =="
cat > "$TMP/gate.mjs" <<JS
import { readFileSync } from 'node:fs';
import { parseMqlResult, gateBySeverity } from '$LIB';
const bugs = parseMqlResult(readFileSync('$FIX_MIX', 'utf8'), { severityKey: 'field_6bff71' });
const g = gateBySeverity(bugs);
console.log(JSON.stringify({
  auto: g.auto.map((b) => b.work_item_id),
  confirm: g.confirm.map((b) => b.work_item_id),
  skip: g.skip.map((b) => b.work_item_id),
  total: g.auto.length + g.confirm.length + g.skip.length,
}));
JS
node "$TMP/gate.mjs" > "$TMP/gate.json" 2>&1
if [ ! -s "$TMP/gate.json" ]; then cat "$TMP/gate.json"; fi
val5(){ node -e "const j=require('$TMP/gate.json'); const v=j['$1']; process.stdout.write(Array.isArray(v)?v.join(','):String(v))"; }
check "高 → 自动接" "$(val5 auto)" "9001"
check "中 → 待确认" "$(val5 confirm)" "9002"
check "低 → 不接" "$(val5 skip)" "9003,9004"
check "去向合计等于单数（不丢单）" "$(val5 total)" "4"

echo
echo "== 7. 截断可见：命中数 > 取回数时必须说得出来（LIMIT 是截断，不是分页）=="
cat > "$TMP/trunc.mjs" <<JS
import { readFileSync } from 'node:fs';
import { parseMqlPage } from '$LIB';
const j = JSON.parse(readFileSync('$FIX_MIX', 'utf8'));
const roomy = parseMqlPage(JSON.stringify(j), { severityKey: 'field_6bff71' });
j.list[0].count = 60;                                    // 真实场景：待办 60 张，LIMIT 只取回 4 张
const tight = parseMqlPage(JSON.stringify(j), { severityKey: 'field_6bff71' });
console.log(JSON.stringify({
  roomyCount: roomy.count, roomyRows: roomy.bugs.length,
  tightCount: tight.count, tightRows: tight.bugs.length,
  sessionId: roomy.sessionId,
}));
JS
node "$TMP/trunc.mjs" > "$TMP/trunc.json" 2>&1
if [ ! -s "$TMP/trunc.json" ]; then cat "$TMP/trunc.json"; fi
val7(){ node -e "const j=require('$TMP/trunc.json'); process.stdout.write(String(j['$1']))"; }
check "count 与行数相等时不算截断" "$(val7 roomyCount):$(val7 roomyRows)" "4:4"
check "count 60 / 行数 4 → 调用方可判出截断" "$(val7 tightCount):$(val7 tightRows)" "60:4"
check "session_id 一并带出（翻页要用）" "$(val7 sessionId)" "fixture-session-mixed"

echo
echo "== 8. fail-closed：读不懂就报错，不装「没有单子」=="
node --input-type=module -e '
import { parseMqlResult } from "'"$LIB"'";
const t = (s) => { try { const r = parseMqlResult(s); return "return:" + JSON.stringify(r); } catch (e) { return "throw:" + e.message.slice(0, 40); } };
console.log(JSON.stringify({
  empty: t(""),
  notJson: t("{ this is not json"),
  semantic: t("error=ErrMoqlSemanticError,message=semantic error,semantic error (Code: 4001) | Context: project_name or project_key is missing in MQL"),
}));
' > "$TMP/fc.json" 2>&1
fc(){ node -e "const j=require('$TMP/fc.json'); process.stdout.write(String(j['$1']))"; }
contains "$(fc empty)" "throw:"; check "空字符串抛错" "0" "$?"
contains "$(fc notJson)" "throw:"; check "半个 JSON 抛错" "0" "$?"
contains "$(fc semantic)" "throw:"; check "服务端 error= 文本抛错（不被当成 0 条）" "0" "$?"

echo
echo "== 9. 配置驱动：harness.rules.json 是唯一真相，env 只做临时覆盖 =="
cat > "$TMP/cfg.mjs" <<JS
import { readFileSync } from 'node:fs';
import { resolveFeishuConfig, buildMyBugsMql, parseMqlResult, gateBySeverity } from '$LIB';
const rules = JSON.parse(readFileSync('$HERE/harness.rules.json', 'utf8'));
const fromRules = resolveFeishuConfig({ rules, env: {} });
const overridden = resolveFeishuConfig({ rules, env: { FEISHU_PROJECT_KEY: 'other_space', FEISHU_MQL_LIMIT: '7' } });
const emptyEnv = resolveFeishuConfig({ rules, env: { FEISHU_PROJECT_KEY: '', FEISHU_WORK_ITEM_TYPE: '  ' } });
const noRules = resolveFeishuConfig({ rules: null, env: {} });
// 配置里的词表真的被消费吗：把「高」映射到 P3，同一批单的去向必须变
// （词表在**解析时**生效——解析一完平台词就变成 P 档了，这时再传词表已经晚了）
const bugs = parseMqlResult(readFileSync('$FIX_MIX', 'utf8'), { severityField: 'field_6bff71' });
const flipped = gateBySeverity(parseMqlResult(readFileSync('$FIX_MIX', 'utf8'), { severityField: 'field_6bff71', severityMap: { 高: 'P3', 中: 'P2', 低: 'P3' } }));
const custom = buildMyBugsMql({ projectKey: fromRules.projectKey, workItemType: fromRules.workItemType, assigneeField: 'owner', severityField: fromRules.severityField });
console.log(JSON.stringify({
  projectKey: fromRules.projectKey, workItemType: fromRules.workItemType,
  severityField: fromRules.severityField, mapHigh: fromRules.severityMap['高'],
  ovProject: overridden.projectKey, ovLimit: overridden.mqlLimit,
  emptyProject: emptyEnv.projectKey, emptyType: emptyEnv.workItemType,
  fallbackType: noRules.workItemType, fallbackMap: noRules.severityMap['高'],
  flippedAuto: flipped.auto.length, flippedSkip: flipped.skip.map((b) => b.work_item_id).join(','),
  ownerMql: /\`owner\`/.test(custom),
}));
JS
node "$TMP/cfg.mjs" > "$TMP/cfg.json" 2>&1
if [ ! -s "$TMP/cfg.json" ]; then cat "$TMP/cfg.json"; fi
val9(){ node -e "const j=require('$TMP/cfg.json'); process.stdout.write(String(j['$1']))"; }
check "配置读到 projectKey" "$(val9 projectKey)" "taosdata_td"
check "配置读到工作项类型" "$(val9 workItemType)" "Defect"
check "配置读到严重级字段 key" "$(val9 severityField)" "field_6bff71"
check "配置读到严重级词表（高→P1）" "$(val9 mapHigh)" "P1"
check "环境变量覆盖配置（临时切空间）" "$(val9 ovProject)" "other_space"
check "环境变量覆盖数值配置" "$(val9 ovLimit)" "7"
check "空字符串环境变量不覆盖（按\"没配\"处理）" "$(val9 emptyProject):$(val9 emptyType)" "taosdata_td:Defect"
check "配置整个缺失时退回内置兜底" "$(val9 fallbackType):$(val9 fallbackMap)" "Defect:P1"
check "改配置里的词表真会改变去向（高→P3 后 auto 归零）" "$(val9 flippedAuto)" "0"
check "被改判的单确实落进 skip" "$(val9 flippedSkip)" "9001,9003,9004"
check "指派字段可配（改成 owner 后 MQL 跟着变）" "$(val9 ownerMql)" "true"

echo
echo "== 9b. 任务类型可多选（同一空间里缺陷/需求是不同工作项，MQL 表名不同） =="
# 一个 MQL 只能查一种工作项，所以"多类型"必须落到"多条 MQL"，不能拼进一句。
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { resolveFeishuConfig, buildMyBugsMql } from "'"$LIB"'";
const base = JSON.parse(readFileSync("'"$HERE"'/harness.rules.json", "utf8"));
const fromRules = resolveFeishuConfig({ rules: base, env: {} });
const two = JSON.parse(JSON.stringify(base)); two.runtime.feishu.taskTypes = ["Defect", "需求", "任务"];
const multi = resolveFeishuConfig({ rules: two, env: {} });
const envOne = resolveFeishuConfig({ rules: two, env: { FEISHU_WORK_ITEM_TYPE: "缺陷" } });
const legacy = JSON.parse(JSON.stringify(base));
delete legacy.runtime.feishu.taskTypes; legacy.runtime.feishu.workItemType = "Defect";
const old = resolveFeishuConfig({ rules: legacy, env: {} });
const mqls = multi.taskTypes.map((t) => buildMyBugsMql({ projectKey: "taosdata_td", workItemType: t }));
const distinct = new Set(mqls.map((m) => m.match(/FROM `[^`]+`\.`([^`]+)`/)[1])).size;
console.log([fromRules.taskTypes.join("|"), fromRules.workItemType, multi.taskTypes.length, envOne.taskTypes.join("|"), old.taskTypes.join("|"), distinct].join(","));
process.exit(fromRules.taskTypes.join("|") === "Defect" && fromRules.workItemType === "Defect"
  && multi.taskTypes.length === 3 && envOne.taskTypes.join("|") === "缺陷"
  && old.taskTypes.join("|") === "Defect" && distinct === 3 ? 0 : 1);' > "$TMP/types.txt" 2>&1
r=$?; [ "$r" -eq 0 ] || cat "$TMP/types.txt"
check "配置多类型 / env 覆盖 / 旧字符串兼容 / 每条 MQL 表名各不相同" "0" "$r"

# 空配置曾解析成字符串 "undefined"（String(undefined)），拼出 `undefined`.`Defect` 表名：
# 查询照样成功、零行，与"今天没活"无法区分。这类错只能靠断言拦。
node --input-type=module -e '
import { resolveFeishuConfig, buildMyBugsMql } from "'"$LIB"'";
const empty = resolveFeishuConfig({ rules: { runtime: { feishu: { projectKey: "" } } }, env: {} });
const none = resolveFeishuConfig({ rules: {}, env: {} });
let threw = false;
try { buildMyBugsMql({ projectKey: empty.projectKey }); } catch { threw = true; }
console.log(JSON.stringify([empty.projectKey, none.projectKey, threw]));
process.exit(empty.projectKey === "" && none.projectKey === "" && threw ? 0 : 1);' > "$TMP/empty.txt" 2>&1
r=$?; [ "$r" -eq 0 ] || cat "$TMP/empty.txt"
check "空/缺 projectKey → 空串并被拦下（不是 \"undefined\" 拼进表名）" "0" "$r"

echo "== 10. 变异检验：把判据改坏，套件必须变红 =="
# 变异一：解析时严重级字段传错（模拟换了空间没改 FEISHU_SEVERITY_FIELD）→ 全部 P3 → 有人也变没人
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { parseMqlResult, gateBySeverity } from "'"$LIB"'";
const bugs = parseMqlResult(readFileSync("'"$FIX_MIX"'", "utf8"), { severityKey: "field_wrong" });
const g = gateBySeverity(bugs);
console.log(JSON.stringify({ auto: g.auto.length, confirm: g.confirm.length, skip: g.skip.length }));
' > "$TMP/mut1.json" 2>&1
check "严重级字段配错 → auto 归零（说明第 5 组断言真的在起作用）" "$(node -e 'const j=require("'"$TMP"'/mut1.json");process.stdout.write(String(j.auto+":"+j.skip))')" "0:4"

# 变异二：把 current_status_operator 换回 owner（历史 bug）→ 第 1 组断言变红
cp "$LIB" "$TMP/mut2.mjs"
sed -i '' 's/current_status_operator/owner/g' "$TMP/mut2.mjs" 2>/dev/null || sed -i 's/current_status_operator/owner/g' "$TMP/mut2.mjs"
node --input-type=module -e '
import { buildMyBugsMql } from "'"$TMP"'/mut2.mjs";
process.stdout.write(buildMyBugsMql({ projectKey: "taosdata_td" }));
' > "$TMP/mut2.txt" 2>&1
if contains "$(cat "$TMP/mut2.txt")" "current_status_operator"; then r=still-has; else r=new-red; fi
check "改回 owner → 断言识别为红" "$r" "new-red"

# 变异三：状态判据换成中文「待处理」（历史 bug）→ 断言识别为红
cp "$LIB" "$TMP/mut3.mjs"
sed -i '' "s/DEFAULT_NEW_STATUS = 'New'/DEFAULT_NEW_STATUS = '待处理'/" "$TMP/mut3.mjs" 2>/dev/null || sed -i "s/DEFAULT_NEW_STATUS = 'New'/DEFAULT_NEW_STATUS = '待处理'/" "$TMP/mut3.mjs"
node --input-type=module -e '
import { buildMyBugsMql } from "'"$TMP"'/mut3.mjs";
process.stdout.write(buildMyBugsMql({ projectKey: "taosdata_td" }));
' > "$TMP/mut3.txt" 2>&1
if contains "$(cat "$TMP/mut3.txt")" "= 'New'"; then r3=still-new; else r3=new-red; fi
check "改成中文待处理 → 断言识别为红" "$r3" "new-red"

echo "== 8. 迭代周期前缀过滤（TDasset 落地规则 2026-11-14：迭代 IDMP 开头才是本产品 bug）=="
# 1) MQL：配了 field 才带出迭代列，不配时零变化
node --input-type=module -e '
import { buildMyBugsMql } from "./scripts/lib/feishu-bug-source.mjs";
process.stdout.write(buildMyBugsMql({ projectKey: "taosdata_td", iterationField: "sprint" }));
' > "$TMP/iter-mql.txt" 2>&1
contains "$(cat "$TMP/iter-mql.txt")" 'sprint' && r=0 || r=1
check "配 iterationField 后 SELECT 带出迭代列" 0 "$r"
node --input-type=module -e '
import { buildMyBugsMql } from "./scripts/lib/feishu-bug-source.mjs";
const m = buildMyBugsMql({ projectKey: "taosdata_td" });
process.stdout.write(m.includes("sprint") ? "leak" : "clean");
' > "$TMP/iter-mql2.txt" 2>&1
check "不配时 MQL 零变化（不残留迭代列）" "clean" "$(cat "$TMP/iter-mql2.txt")"
# 2) 前缀过滤：命中/非本线/无迭代/大小写；未配置为 no-op
node --input-type=module -e '
import { filterByIterationPrefix } from "./scripts/lib/feishu-bug-source.mjs";
const bugs = [
  { work_item_id: "1", iteration: "IDMP-2026-11 迭代" },
  { work_item_id: "2", iteration: "TDC-2026-11 迭代" },
  { work_item_id: "3", iteration: "" },
  { work_item_id: "4", iteration: "idmp-下月迭代" },
];
const r1 = filterByIterationPrefix(bugs, "IDMP");
console.log(r1.matched.map((b) => b.work_item_id).join(",") + "|" + r1.skipped.map((b) => b.work_item_id).join(","));
const r2 = filterByIterationPrefix(bugs, "");
console.log(r2.matched.length + "|" + r2.skipped.length);
' > "$TMP/iter-filter.txt" 2>&1
check "命中 IDMP（大小写不敏感）；非本线与无迭代筛掉" "1,4|2,3" "$(sed -n 1p "$TMP/iter-filter.txt")"
check "prefix 为空不过滤（未配置空间零行为变化）" "4|0" "$(sed -n 2p "$TMP/iter-filter.txt")"
# 3) 解析透传：真实 moql 形态里迭代字段取 key_label_value 的 label
node --input-type=module -e '
import { parseMqlPage, filterByIterationPrefix } from "./scripts/lib/feishu-bug-source.mjs";
const page = JSON.stringify({
  list: [{ count: 2 }],
  data: { "1": [
    { moql_field_list: [
      { key: "work_item_id", value: { long_value: 101 } },
      { key: "name", value: { string_value: "曲线导不出" } },
      { key: "sprint", value: { key_label_value: { key: "spr_42", label: "IDMP-2026-11 迭代" } } },
    ] },
    { moql_field_list: [
      { key: "work_item_id", value: { long_value: 102 } },
      { key: "name", value: { string_value: "别的产品线" } },
      { key: "sprint", value: { key_label_value: { key: "spr_43", label: "TDC-2026-11 迭代" } } },
    ] },
  ] },
});
const r = parseMqlPage(page, { iterationField: "sprint" });
const f = filterByIterationPrefix(r.bugs, "IDMP");
console.log(f.matched.length + "|" + f.skipped.length + "|" + (f.matched[0]?.iteration || ""));
' > "$TMP/iter-parse.txt" 2>&1
check "解析取迭代 label，过滤后只留 IDMP 单" "1|1|IDMP-2026-11 迭代" "$(cat "$TMP/iter-parse.txt")"
# 4) 可证伪：把过滤条件改成恒真 → 斷言必红
cp "$HERE/scripts/lib/feishu-bug-source.mjs" "$TMP/mut4.mjs"
sed -i.bak 's/if (iter \&\& iter.toLowerCase().startsWith(p.toLowerCase())) matched.push(b);/if (true) matched.push(b);/' "$TMP/mut4.mjs"
node --input-type=module -e '
import { filterByIterationPrefix } from "'"$TMP"'/mut4.mjs";
const r = filterByIterationPrefix([{ work_item_id: "9", iteration: "OTHER" }], "IDMP");
process.stdout.write(String(r.matched.length));
' > "$TMP/mut4.txt" 2>&1
check "变异：过滤恒真（非 IDMP 也放行）被断言抓到" "1" "$(cat "$TMP/mut4.txt")"

echo
if [ "$fail" -eq 0 ]; then
  printf "\033[32m全部通过：%d 条\033[0m\n" "$pass"
  exit 0
else
  printf "\033[31m失败 %d 条 / 共 %d 条\033[0m\n" "$fail" "$((pass+fail))"
  exit 1
fi
