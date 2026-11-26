#!/usr/bin/env bash
# rs-feishu-intake.test.py 的反向验证：把文档/证据逐项故意改坏，确认检查会红。
#
# 为什么要有它：一份只在正确时变绿的检查证明不了能拦东西——这份检查的第一版就漏掉了
# 「文档改称能读云文档」和「交叉引用改指错章节」两条最要紧的。
#
# 纪律：
#   - 变异锚点不匹配 → 立刻中止（上次有个变异静默失败，检查"绿"了，其实根本没改坏）
#   - 每条变异后核对文件确实变了（字节不同），否则这一条的结果作废
#   - 只在临时副本上改，不碰仓库里的真文件
#
# 用法：bash test/rs-feishu-intake.mutation.sh     全部按预期拦截退出 0
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$HERE/test/rs-feishu-intake.test.py"
RS_REL="docs/01-requirements/RS-飞书任务接入.md"
EV_REL="docs/06-reference/feishu-mcp-capabilities.json"
for f in "$CHECK" "$HERE/$RS_REL" "$HERE/$EV_REL"; do
  [ -f "$f" ] || { echo "缺文件: $f" >&2; exit 2; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/$(dirname "$RS_REL")" "$TMP/$(dirname "$EV_REL")"
RS="$TMP/$RS_REL"; EV="$TMP/$EV_REL"
restore() { cp "$HERE/$RS_REL" "$RS"; cp "$HERE/$EV_REL" "$EV"; }
restore

pass=0; fail=0; invalid=0
out=""; code=0
run() {  # $1 = 用例名  $2 = 期望（拦截 / 放行）  $3 = 说明
  out="$(python3 "$CHECK" "$TMP" 2>&1)"; code=$?
  local got; [ "$code" -ne 0 ] && got="拦截" || got="放行"
  if [ "$got" = "$2" ]; then
    printf '  \033[32m✓\033[0m %s → %s（符合预期）  %s\n' "$1" "$got" "$3"
    pass=$((pass + 1))
  else
    printf '  \033[31m✗\033[0m %s → %s，但期望%s\n' "$1" "$got" "$2"
    printf '       %s\n' "$(printf '%s' "$out" | tail -1 | cut -c1-170)"
    fail=$((fail + 1))
  fi
}
# 变异文档：锚点必须恰好出现一次；变异后文件字节必须不同
mut_rs() {  # $1 = 旧文本  $2 = 新文本
  python3 - "$RS" "$1" "$2" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding='utf-8').read()
n = s.count(old)
if n != 1:
    print('变异锚点出现 %d 次（应为 1）: %r' % (n, old[:40]), file=sys.stderr); sys.exit(3)
open(path, 'w', encoding='utf-8').write(s.replace(old, new, 1))
PY
}
# 变异证据：按键路径改一个值
mut_ev() {  # $1 = 点分路径  $2 = JSON 值
  python3 - "$EV" "$1" "$2" <<'PY'
import json, sys
path, dotted, value = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
d = json.load(open(path, encoding='utf-8'))
parts = dotted.split('.'); o = d
for p in parts[:-1]:
    o = o[int(p)] if isinstance(o, list) else o[p]
last = parts[-1]
if isinstance(o, list): o[int(last)] = value
else:
    if last not in o:
        print('证据里没有键: ' + dotted, file=sys.stderr); sys.exit(3)
    o[last] = value
json.dump(d, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
}
changed() { ! cmp -s "$RS" "$HERE/$RS_REL" || ! cmp -s "$EV" "$HERE/$EV_REL"; }
# 一次变异 + 校验真的改了 + 跑 + 还原
case_doc() {  # $1 名  $2 旧  $3 新  $4 期望  $5 说明
  if ! mut_rs "$2" "$3"; then printf '  \033[33m!\033[0m %s 变异失败（锚点问题），本条作废\n' "$1"; invalid=$((invalid + 1)); restore; return; fi
  if ! changed; then printf '  \033[33m!\033[0m %s 变异未落到文件，本条作废\n' "$1"; invalid=$((invalid + 1)); restore; return; fi
  run "$1" "$4" "$5"; restore
}
case_ev() {   # $1 名  $2 路径  $3 值  $4 期望  $5 说明
  if ! mut_ev "$2" "$3"; then printf '  \033[33m!\033[0m %s 变异失败（键问题），本条作废\n' "$1"; invalid=$((invalid + 1)); restore; return; fi
  if ! changed; then printf '  \033[33m!\033[0m %s 变异未落到文件，本条作废\n' "$1"; invalid=$((invalid + 1)); restore; return; fi
  run "$1" "$4" "$5"; restore
}

echo "== 基线 =="
run "未改动" "放行" "真文件"

echo "== 文档：事实被改错 =="
case_doc "复现步骤写回错误口径 1022" "996 字的复现步骤" "1022 字的复现步骤" "拦截" "数字须与证据一致"
case_doc "工具数写成 40" "48 个工具" "40 个工具" "拦截" "同上"

echo "== 文档：最重要的边界「读不到飞书云文档」 =="
case_doc "改称能读云文档正文" "**没有任何一个能读飞书云文档正文**" "**支持通过专用工具读取飞书云文档正文**" "拦截" "第一版漏掉"
case_doc "只删掉边界的前半句（行内还剩「都读不了」）" "**没有任何一个能读飞书云文档正文**。" "" "放行" "「都读不了」同样是边界声明，文档仍说清楚了读不到"
case_doc "把 §2.2-A 行里两处边界都删掉" \
  '，**没有任何一个能读飞书云文档正文**。描述里链接的文档、多维表格都读不了（证据 `tools`、`doc_reading`）' \
  '（证据 `tools`、`doc_reading`）' "拦截" "这一行不再说明读不到什么"
# 边界换成不含任何否定关键词的委婉说法：检查器认得出「这一行没有否定表述」。
# 它判的是「§2.2-A 行里有没有明确的否定」，不是「措辞对不对」——所以这种改写也会被拦。
case_doc "边界换成不含否定关键词的委婉说法" \
  "**没有任何一个能读飞书云文档正文**。描述里链接的文档、多维表格都读不了" \
  "**当前 MCP 的工具集不包含文档正文**。描述里链接的文档只能靠人打开" \
  "拦截" "这一行里不再有任何否定表述，检查器不认「不包含」"

echo "== 文档：交叉引用指错 =="
case_doc "§2.2-B 改指 §7（术语表）" "复用 §2.2-B 所述现有机制" "复用 §7 所述现有机制" "拦截" "第一版漏掉"
case_doc "谈待决的句子改指术语表" "五个开放问题的决定见 §8。" "五个待决问题的决定见 §7 术语表。" "拦截" "句子谈待决，引用的章节却不是开放问题"
case_doc "引用不存在的 §2.2-Z" "复用 §2.2-B 所述现有机制" "复用 §2.2-Z 所述现有机制" "拦截" "第二版漏掉"
case_doc "引用不存在的 §9" "五个开放问题的决定见 §8。" "五个开放问题的决定见 §9。" "拦截" "章节号越界"

echo "== 文档：结构 =="
case_doc "删掉核心需求章节" "## 4 核心需求" "## 4 设计" "拦截" "模板必备章节"
case_doc "核心需求表清空（只剩表头）" "| R1 | 入口命令解析 ID 或链接，校验工作项存在" "| X1 | 入口命令解析 ID 或链接，校验工作项存在" "放行" "只改了 1 行的编号，其余 8 行仍在——本条不要求拦"

echo "== 证据：被改坏（文档没动） =="
case_ev "附件下载改成失败" "attachment.ok" "false" "拦截" "撑不起「附件可读」"
case_ev "塞入一个下载地址" "tools.classification_rule" '"read: 见 https://project.feishu.cn/goapi/v5/platform/file/stream/download/ABC=="' "拦截" "证据不得含端点以外的地址"
case_ev "工具总数手改成 40" "tools.total" "40" "拦截" "计数须与名单一致"
case_ev "brief 传 fields 后描述「返回了」" "work_item_read.get_workitem_brief.with_fields_param.description_returned" "true" "拦截" "与文档主张相反"
case_ev "两个接口 ID 类型改成相同" "work_item_read.search_by_mql.id_type" '"string"' "拦截" "撑不起「类型不同」"
case_ev "doc_reading 结论说「有」，名单里却没有" "doc_reading.result" '"有对应工具"' "拦截" "证据自相矛盾"

echo
if [ "$fail" -eq 0 ] && [ "$invalid" -eq 0 ]; then
  printf '\033[32mrs-feishu-intake 反向验证通过（%d 项，其中应拦截的全部拦截）\033[0m\n' "$pass"
  exit 0
fi
[ "$invalid" -ne 0 ] && printf '\033[33m有 %d 项变异作废（锚点/键问题），结果不可信\033[0m\n' "$invalid"
[ "$fail" -ne 0 ] && printf '\033[31m有 %d 项与预期不符\033[0m\n' "$fail"
exit 1
