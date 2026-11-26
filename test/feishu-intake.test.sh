#!/usr/bin/env bash
# feishu-intake（`harness feishu`）自测。
#
# 四段：
#   1. 纯函数：ID 解析、字段名解析、配置形状、链接提取、类型规则、只读闸
#   2. 读取阶段：注入假的飞书通道与内存文件系统，不起网络、不占端口
#   3. 真实建档：在仓库副本上跑真的 init-harness.sh、真的 ci-verify、真的 resume
#      ——「工具写下的状态能不能过它自己的门禁」「待决项答不答得回来」这两条，用假的是答不了的
#   4. 变异检验：把代码改坏，对应断言必须红；锚点失效（变异没做成）一律判红
#
# 用法：bash test/feishu-intake.test.sh     全部通过退出 0
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$HERE/scripts/lib/feishu-intake.mjs"
ASSERT="$HERE/test/feishu-intake.assert.mjs"
for f in "$LIB" "$ASSERT"; do [ -f "$f" ] || { echo "缺文件: $f" >&2; exit 2; }; done
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then
    printf '  \033[32m✓\033[0m %s\n' "$1"
    pass=$((pass + 1))
  else
    printf '  \033[31m✗\033[0m %s  (期望 %s，实际 %s)\n' "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}
# 跑一个套件并打印它的逐条结果（证据日志里要有可对账的断言计数，不能只有一句「通过」）。
run_suite() {
  local name="$1"; shift
  local r=0
  node "$ASSERT" "$@" > "$TMP/out-$name.txt" 2>&1 || r=1
  cat "$TMP/out-$name.txt"
  check "套件 ${name}：全部断言通过" 0 "$r"
}

echo "== 1. 纯函数 =="
run_suite unit "$LIB" unit

echo
echo "== 2. 读取阶段（假的飞书通道 + 内存文件系统） =="
run_suite intake "$LIB" intake

echo
echo "== 3. 真实建档（仓库副本） =="
COPY="$TMP/repo"
mkdir -p "$COPY"
# 用 tar 复制整棵树，不用 rsync：CI 镜像里没有 rsync，而「命令不存在」不会让脚本停下，
# 只会留下一个空壳副本，后面几十条断言全在错的地基上跑。
if ! ( cd "$HERE" && tar -cf - --exclude=./.git --exclude=./node_modules --exclude=./.ai/intake --exclude=./.zwork . ) | ( cd "$COPY" && tar -xf - ); then
  echo "  仓库副本建不起来（tar 复制失败），这一段的断言没有意义" >&2
  check "仓库副本建立" 0 1
else
  # 仓库校验只认 git 里的事实，副本得是个仓库；建不起来就明说，不把断言建在坏地基上
  g=0
  ( cd "$COPY" && git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm base ) || g=1
  check "副本 git 仓库建立（校验只认 git 里的事实）" 0 "$g"
  [ "$g" = 0 ] && run_suite confirm-real "$LIB" confirm-real "$COPY"
fi

echo
echo "== 4. 变异检验：把代码改坏，对应断言必须红 =="
# 跑不起来、锚点失效、清单缺失都一律判红——这里静默判绿等于变异检验整个作废
# （实测踩过：PATH 缺 python3 → heredoc 静默失败 → 循环空转 → 「全部通过」退出 0）
py_ok=0
if command -v python3 >/dev/null 2>&1; then
  python3 - "$LIB" "$TMP" <<'PY' && py_ok=1
import sys
src, tmp = sys.argv[1], sys.argv[2]
s = open(src, encoding='utf-8').read()
# (编号, 原文, 改坏成, 说明)
muts = [
    ('1', "return markers.map(normName).includes(normName(t)) ? 'no_change' : 'changed';", "return 'no_change';",
     '行为变更判断被改成恒「无变更」'),
    ('2', "if (Array.isArray(v)) items = v;\n    else if (Array.isArray(v?.key_label_value_list)) items = v.key_label_value_list;",
     "if (Array.isArray(v?.key_label_value_list)) items = v.key_label_value_list;",
     '附件取值退回冒烟前的写法（附件曾因此静默丢失）'),
    ('3', "if (io_.exists(summaryPath) && !io_.readText(summaryPath).startsWith(GENERATED_MARK)) {",
     "if (false && io_.exists(summaryPath)) {", '「不覆盖人的编辑」保护被拿掉'),
    ('4', "if (!READ_ONLY_TOOLS.includes(name)) {", "if (false) {", '只读闸被拿掉'),
    ('5', "if (!who) throw new IntakeError('确认必须记名", "if (false) throw new IntakeError('确认必须记名", '确认不再强制记名'),
    ('6', "if (!INTAKE_TYPES.includes(type)) {", "if (false) {", '类型枚举校验被拿掉'),
    ('7', "const relatedFields = fieldList.filter((f) => /^workitem_related/i.test(String(f?.field_type || '')));", "const relatedFields = [];",
     '关联工作项不再读取（独立评审抓到的漏项）'),
    ('8', "state.meta.confirmed_by = who;", "state.meta.confirmed_by = undefined;", '确认人不再落盘（记名只用来校验）'),
    ('9', "const ran = (v.status === 0 || v.status === 1) && verdict != null && Array.isArray(verdict.problems);", "const ran = true;",
     '校验器结果不再判读（没跑成也算通过）'),
]
ok, bad = [], []
for n, old, new, desc in muts:
    c = s.count(old)
    if c != 1:
        bad.append('变异 %s（%s）的锚点出现 %d 次，应为 1——变异没做成，这一条的结果不可信' % (n, desc, c))
        continue
    open('%s/mut-%s.mjs' % (tmp, n), 'w', encoding='utf-8').write(s.replace(old, new, 1))
    ok.append((n, desc))
open('%s/mut-failed.txt' % tmp, 'w', encoding='utf-8').write(''.join(x + '\n' for x in bad))   # 没有失败就写空文件
open('%s/muts.txt' % tmp, 'w', encoding='utf-8').write(''.join('%s\t%s\n' % (n, d) for n, d in ok))
open('%s/mut-expected.txt' % tmp, 'w', encoding='utf-8').write(str(len(muts)))
PY
fi
check "变异清单生成（python3 存在且正常退出）" 1 "$py_ok"
made=0; expected=-1
[ -f "$TMP/muts.txt" ] && made=$(wc -l < "$TMP/muts.txt" | tr -d ' ')
[ -f "$TMP/mut-expected.txt" ] && expected=$(cat "$TMP/mut-expected.txt")
check "变异做成条数 = 期望条数（缺 python3 或锚点失效都在这里红）" "$expected" "$made"
if [ "$py_ok" = 1 ] && [ -s "$TMP/mut-failed.txt" ]; then
  while IFS= read -r line; do [ -n "$line" ] && printf '  \033[31m✗\033[0m %s\n' "$line"; done < "$TMP/mut-failed.txt"
fi
if [ "$made" -gt 0 ] 2>/dev/null; then
while IFS=$'\t' read -r n desc; do
  [ -n "$n" ] || continue
  r_orig=0; r_mut=0
  node "$ASSERT" "$LIB" "mutation-$n" > "$TMP/mut-$n-base.txt" 2>&1 || r_orig=1
  node "$ASSERT" "$TMP/mut-$n.mjs" "mutation-$n" > "$TMP/mut-$n-out.txt" 2>&1 || r_mut=1
  detail="$(rg '✗' "$TMP/mut-$n-out.txt" | head -1 | sed 's/^ *//' | cut -c1-110)"
  if [ "$r_orig" = 0 ] && [ "$r_mut" = 1 ]; then
    printf '  \033[32m✓\033[0m 变异 %s：%s → 断言变红（%s）\n' "$n" "$desc" "$detail"
    pass=$((pass + 1))
  else
    printf '  \033[31m✗\033[0m 变异 %s：%s → 未变异 exit=%s，变异后 exit=%s（应 0 → 1）\n' "$n" "$desc" "$r_orig" "$r_mut"
    fail=$((fail + 1))
  fi
done < "$TMP/muts.txt"
fi

echo
printf '结果：%d 通过，%d 失败\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
