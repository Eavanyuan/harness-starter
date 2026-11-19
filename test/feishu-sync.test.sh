#!/usr/bin/env bash
# feishu-sync（接单=只流转状态）自测 —— mock call，不打真通道。
#
# 2026-11-15 重写后的语义（真实首跑三教训的回归锁）：
#   · 状态流转用 transition_state{transition_id}（id 来自 get_transitable_states），
#     绝不用 update_field（静默失败的错工具）
#   · 回读用 search_by_mql（brief 的 status 读不出，曾致每次误判"未确认"）
#   · 全程零 add_comment（用户指令：不要添加评论）；失败如实失败，无兜底评论
#   · 幂等：当前已是目标态 → ok(via=already)，不再调 transition_state
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# 被测模块路径必须由 $HERE 推出来，不能写死绝对路径。
# 曾经 case2/case3 的 heredoc 用了 <<'EOF'（单引号 = 不展开变量），于是 $HERE 用不了，
# 作者就把当时的绝对路径粘了进去 —— 在本机永远绿，在 CI 上 100% ERR_MODULE_NOT_FOUND。
# 这套件此前只有本地 `npm run gate` 在跑，所以一直没人看见；接进 CI 的第一分钟就红了。
LIB="$HERE/scripts/lib/feishu-sync.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
check(){ if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); else printf "  \033[31m✗\033[0m %s  (期望 %s，实际 %s)\n" "$1" "$3" "$2"; fail=$((fail+1)); fi; }

mkcall() { # mkcall <初始状态> <流转后状态 or FAIL>  → 输出 "ok|via|tools"
  cat > "$TMP/case.mjs" <<EOF
import { acknowledgeBug } from '$LIB';
const calls = [];
let flipped = false;
const call = async (tool, args) => {
  calls.push(tool + (tool === 'transition_state' ? ':' + args.transition_id : ''));
  if (tool === 'search_by_mql') {
    const label = flipped ? '$2' : '$1';
    return JSON.stringify({ data: { "1": [{ moql_field_list: [{ key: 'work_item_status', value: { key_label_value_list: [{ label }] } }] }] } });
  }
  if (tool === 'get_transitable_states') return JSON.stringify({ transition: [{ id: 21912443, state_key: 'In Progress', state_name: 'Processing' }] });
  if (tool === 'transition_state') { flipped = true; return 'success'; }
  if (tool === 'add_comment') { globalThis.__commented = true; return '{}'; }
  return '{}';
};
const r = await acknowledgeBug({ call, projectKey: 'taosdata_td', workItemId: '7167910546' });
console.log(r.ok + '|' + (r.transition?.via ?? '') + '|' + calls.join('>') + '|' + (globalThis.__commented ? 'COMMENTED' : 'no-comment'));
EOF
  node "$TMP/case.mjs" 2>&1
}

echo "== 1. 正常接单：New→Processing，用 transition_state，零评论 =="
out="$(mkcall New Processing)"
check "ok=true" "$(printf '%s' "$out" | cut -d'|' -f1)" "true"
check "via=transition_state" "$(printf '%s' "$out" | cut -d'|' -f2)" "transition_state"
check "调序：MQL回读→可流转态→transition_state(id)→MQL回读，无 update_field/add_comment" \
  "$(printf '%s' "$out" | cut -d'|' -f3)" "search_by_mql>get_transitable_states>transition_state:21912443>search_by_mql"
check "全程无评论" "$(printf '%s' "$out" | cut -d'|' -f4)" "no-comment"

echo "== 2. 幂等：已是 Processing → ok(already)，不再流转 =="
cat > "$TMP/case2.mjs" <<EOF
import { acknowledgeBug } from '$LIB';
const calls = [];
const call = async (tool, args) => {
  calls.push(tool);
  if (tool === 'search_by_mql') return JSON.stringify({ data: { "1": [{ moql_field_list: [{ key: 'work_item_status', value: { key_label_value_list: [{ label: 'Processing' }] } }] }] } });
  return '{}';
};
const r = await acknowledgeBug({ call, projectKey: 'p', workItemId: '1' });
console.log(r.ok + '|' + r.transition.via + '|' + calls.length);
EOF
out="$(node "$TMP/case2.mjs" 2>&1)"
check "ok=true via=already" "$(printf '%s' "$out" | cut -d'|' -f1-2)" "true|already"
check "只调了一次 MQL 回读（未动流转）" "$(printf '%s' "$out" | cut -d'|' -f3)" "1"

echo "== 3. 目标态不在可流转列表 → fail-closed 如实报错，不硬转 =="
cat > "$TMP/case3.mjs" <<EOF
import { transitionStatus } from '$LIB';
const calls = [];
const call = async (tool) => {
  calls.push(tool);
  if (tool === 'search_by_mql') return JSON.stringify({ data: { "1": [{ moql_field_list: [{ key: 'work_item_status', value: { key_label_value_list: [{ label: 'New' }] } }] }] } });
  if (tool === 'get_transitable_states') return JSON.stringify({ transition: [{ id: 9, state_name: 'Releasing' }] });
  return '{}';
};
const r = await transitionStatus({ call, projectKey: 'p', workItemId: '1', toStatus: 'Processing' });
console.log(r.ok + '|' + (r.reason || '').startsWith('目标状态') + '|' + calls.includes('transition_state'));
EOF
out="$(node "$TMP/case3.mjs" 2>&1)"
check "ok=false 且理由以「目标状态」开头" "$(printf '%s' "$out" | cut -d'|' -f1-2)" "false|true"
check "transition_state 未被调用" "$(printf '%s' "$out" | cut -d'|' -f3)" "false"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
