#!/usr/bin/env bash
# feishu-ask（信息完备性检查与追问）自测 —— mock call，不打真通道。
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
check(){ if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); else printf "  \033[31m✗\033[0m %s  (期望 %s，实际 %s)\n" "$1" "$3" "$2"; fail=$((fail+1)); fi; }

echo "== 1. 描述判定启发式 =="
node --input-type=module > "$TMP/assess.txt" 2>&1 <<'EOF'
import { assessDescription } from './scripts/lib/feishu-ask.mjs';
// 完备：有步骤+环境+截图+日志
console.log(assessDescription('在 IDMP v2.0.4 环境下，按步骤操作 dashboard share，截图如下 img.png，日志 log stack trace 出现 NPE').complete);
// 不完备：太短
console.log(assessDescription('页面报错').complete);
// 不完备：三项全缺
console.log(assessDescription('这个问题很长但没有任何有用信息，只是一段很长的话，没有关键词').missing.length >= 2);
// 边界：有步骤+环境但无截图无日志 → 缺 2 项 < 3 → complete=true（可接，修的时候再要）
console.log(assessDescription('在 IDMP v2.0.4 版本下，按以下步骤操作复现：1.打开页面 2.点击按钮 3.观察异常').complete);
// 空
console.log(assessDescription('').complete);
EOF
check "完备描述 → complete" "$(sed -n 1p "$TMP/assess.txt")" "true"
check "过短 → 不完备" "$(sed -n 2p "$TMP/assess.txt")" "false"
check "三项全缺 → missing>=2" "$(sed -n 3p "$TMP/assess.txt")" "true"
check "有步骤+环境（缺截图+日志）→ 可接" "$(sed -n 4p "$TMP/assess.txt")" "true"
check "空描述 → 不完备" "$(sed -n 5p "$TMP/assess.txt")" "false"

echo "== 2. checkInfoOrAsk：信息够 → ok=true 不评论 =="
cat > "$TMP/case2.mjs" <<'EOF'
import { checkInfoOrAsk } from './scripts/lib/feishu-ask.mjs';
let commented = false;
const call = async (tool) => {
  if (tool === 'get_workitem_brief') return JSON.stringify({
    work_item_attribute: { create_by: { key: '123', name: '张三' } },
    work_item_fields: [{ key: 'description', value: '在 IDMP v2.0.4 下按步骤复现，截图 img.png，日志 log trace 存在' }],
  });
  if (tool === 'add_comment') { commented = true; }
  return '{}';
};
const r = await checkInfoOrAsk({ call, projectKey: 'p', workItemId: '1' });
console.log(r.ok + '|' + commented);
EOF
out="$(cd "$HERE" && node --input-type=module < "$TMP/case2.mjs" 2>&1)"
check "ok=true 零评论" "$out" "true|false"

echo "== 3. 信息不全 → 评论 @提交者（含 lark_user_id 格式）=="
cat > "$TMP/case3.mjs" <<'EOF'
import { checkInfoOrAsk } from './scripts/lib/feishu-ask.mjs';
let commentContent = '';
const call = async (tool, args) => {
  if (tool === 'get_workitem_brief') return JSON.stringify({
    work_item_attribute: { create_by: { key: '12345', name: '张三' } },
    work_item_fields: [{ key: 'description', value: '页面报错' }],
  });
  if (tool === 'list_workitem_comments') return '[]';
  if (tool === 'search_user_info') return JSON.stringify([{ lark_user_id: 9876543210, name_cn: '张三' }]);
  if (tool === 'add_comment') { commentContent = args.content; return '{}'; }
  return '{}';
};
const r = await checkInfoOrAsk({ call, projectKey: 'p', workItemId: '1' });
console.log(r.ok + '|' + r.asked + '|' + (commentContent.includes('[自动追问]') ? 'has-marker' : 'no-marker') + '|' + (commentContent.includes('mention:{"id":"lark_user_id_9876543210"') ? 'has-mention' : 'no-mention') + '|' + (commentContent.includes('截图') && commentContent.includes('日志') && commentContent.includes('复现步骤') ? 'asks-all' : 'asks-partial'));
EOF
out="$(cd "$HERE" && node --input-type=module < "$TMP/case3.mjs" 2>&1)"
check "ok=false asked=true 含标记+@格式+追问三要素" "$out" "false|true|has-marker|has-mention|asks-all"

echo "== 4. 已追问过 → 不再发（防刷屏）=="
cat > "$TMP/case4.mjs" <<'EOF'
import { checkInfoOrAsk } from './scripts/lib/feishu-ask.mjs';
let commented = false;
const call = async (tool) => {
  if (tool === 'get_workitem_brief') return JSON.stringify({
    work_item_attribute: { create_by: { key: '123', name: '张三' } },
    work_item_fields: [{ key: 'description', value: '页面报错' }],
  });
  if (tool === 'list_workitem_comments') return JSON.stringify([{ content: '[自动追问] @张三 本单信息不全...' }]);
  if (tool === 'add_comment') { commented = true; }
  return '{}';
};
const r = await checkInfoOrAsk({ call, projectKey: 'p', workItemId: '1' });
console.log(r.ok + '|' + r.already_asked + '|' + commented);
EOF
out="$(cd "$HERE" && node --input-type=module < "$TMP/case4.mjs" 2>&1)"
check "ok=false already_asked=true 不再评论" "$out" "false|true|false"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
