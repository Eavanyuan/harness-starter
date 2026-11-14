#!/usr/bin/env bash
# feishu-sync（接单三连）自测 —— mock call，不打真通道。
#
# 覆盖（2026-11-14 接线时的定案）：
#   · 调序与英文状态名：add_comment → get_transitable_states → update_field(Processing)
#   · fail-closed：目标态不在可流转列表 → 不硬转（update_field 不被调用）
#   · 写后读读不回 → 评论兜底留凭（degraded），ok 仍真
#   · 类型名 Defect 透传（中文「缺陷」会被空间拒绝）
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
check(){ if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); else printf "  \033[31m✗\033[0m %s  (期望 %s，实际 %s)\n" "$1" "$3" "$2"; fail=$((fail+1)); fi; }

run_case() { # run_case <js 文件> → stdout
  node --input-type=module < "$1" 2>&1
}

echo "== 1. 接单三连 happy path：调序 / 英文状态名 / 类型名 =="
cat > "$TMP/case1.mjs" <<'EOF'
import { acknowledgeBug } from './scripts/lib/feishu-sync.mjs';
const calls = [];
const call = async (tool, args) => {
  calls.push(`${tool}:${JSON.stringify(args.value ?? args.content ?? args.work_item_type ?? 'x').slice(0, 40)}`);
  if (tool === 'get_transitable_states') return JSON.stringify({ transition: [{ state_name: 'Processing' }, { state_name: 'Releasing' }] });
  if (tool === 'get_workitem_brief') return JSON.stringify({ work_item_attribute: { work_item_status: { state_name: 'Processing' } } });
  return '{}';
};
const r = await acknowledgeBug({ call, projectKey: 'taosdata_td', workItemId: '7167694064', note: 'hi' });
console.log(r.ok + '|' + calls.join(' > '));
EOF
out="$(cd "$HERE" && run_case "$TMP/case1.mjs")"
check "ok=true" "$(printf '%s' "$out" | cut -d'|' -f1)" "true"
check "调序：评论 → 可流转态 → 写状态(Processing) → 回读" \
  "$(printf '%s' "$out" | cut -d'|' -f2 | cut -d'>' -f1-4 | tr -d ' ')" \
  "add_comment:\"hi\">get_transitable_states:\"Defect\">update_field:\"Processing\">get_workitem_brief:\"x\""

echo "== 2. 目标态不在可流转列表 → fail-closed 不硬转 =="
cat > "$TMP/case2.mjs" <<'EOF'
import { transitionStatus } from './scripts/lib/feishu-sync.mjs';
const calls = [];
const call = async (tool, args) => {
  calls.push(tool);
  if (tool === 'get_transitable_states') return JSON.stringify({ transition: [{ state_name: 'Releasing' }] });
  return '{}';
};
const r = await transitionStatus({ call, projectKey: 'p', workItemId: '1', toStatus: 'Processing' });
console.log(r.ok + '|' + (r.reason || '').startsWith('目标状态') + '|' + calls.includes('update_field'));
EOF
out="$(cd "$HERE" && run_case "$TMP/case2.mjs")"
check "ok=false 且理由以「目标状态」开头" "$(printf '%s' "$out" | cut -d'|' -f1-2)" "false|true"
check "update_field 未被调用（不硬转）" "$(printf '%s' "$out" | cut -d'|' -f3)" "false"

echo "== 3. 写后读读不回 → 评论兜底留凭（degraded），ok 仍真 =="
cat > "$TMP/case3.mjs" <<'EOF'
import { transitionStatus } from './scripts/lib/feishu-sync.mjs';
const calls = [];
const call = async (tool, args) => {
  calls.push(tool);
  if (tool === 'get_transitable_states') return JSON.stringify({ transition: [{ state_name: 'Processing' }] });
  if (tool === 'get_workitem_brief') return JSON.stringify({ work_item_attribute: { work_item_status: { state_name: 'New' } } }); // 回读仍是 New
  return '{}';
};
const r = await transitionStatus({ call, projectKey: 'p', workItemId: '1', toStatus: 'Processing' });
console.log(r.ok + '|' + r.via + '|' + (r.degraded || []).join(','));
EOF
out="$(cd "$HERE" && run_case "$TMP/case3.mjs")"
check "回读失败仍 ok=true（兜底成功不算失败）" "$(printf '%s' "$out" | cut -d'|' -f1)" "true"
check "via=comment-fallback" "$(printf '%s' "$out" | cut -d'|' -f2)" "comment-fallback"
check "degraded 点名 status" "$(printf '%s' "$out" | cut -d'|' -f3)" "status"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
