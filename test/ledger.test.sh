#!/usr/bin/env bash
# 账本读取端自测 —— 观测面只写不读，等于没有观测面（失效点 §26）。
#
# 这里测的是"报告有没有把人需要判断的东西说出来"：
#   · 真实拦截与自测流量分开（混在一起，基线立刻失去意义）；
#   · 按规则聚合（只记 hook 名，问不出"哪条规则在拦"）；
#   · events 心跳（只有 deny 时，"没拦人"和"没接上"长得一样）。
#
# 用法：bash test/ledger.test.sh     全部通过退出 0
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export HARNESS_LEDGER_DIR="$TMP/ledger"
OUT="$TMP/out.txt"
JSONOUT="$TMP/out.json"

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then
    printf "  \033[32m✓\033[0m %s\n" "$1"
    pass=$((pass + 1))
  else
    printf "  \033[31m✗\033[0m %s  (期望 %s，实际 %s)\n" "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

run() { node "$HERE/scripts/ledger-report.mjs" "$@" >"$OUT" 2>&1; }
has() { grep -q "$1" "$OUT" && echo ok || echo missing; }

echo "== 1. 没有账本时要说清"不是没拦过"和"没接上"的区别 =="
run
check "没有账本 → 不崩，exit 0" 0 "$?"
check "提示门禁可能没接上（不把空白当干净）" ok "$(has '门禁根本没接上')"

echo "== 2. 真实拦截与自测流量必须分开 =="
mkdir -p "$HARNESS_LEDGER_DIR"
NOW="$(node -e 'process.stdout.write(new Date().toISOString())')"
cat > "$HARNESS_LEDGER_DIR/deny.jsonl" <<EOF
{"ts":"$NOW","hook":"guard_command","rule":"rm -rf /","target":"rm -rf /tmp/x","source":"tool"}
{"ts":"$NOW","hook":"guard_command","rule":"rm -rf /","target":"rm -rf /tmp/y","source":"tool"}
{"ts":"$NOW","hook":"guard_write","rule":"block","target":".env","source":"selftest"}
EOF
run
check "真实 2 条、自测 1 条分开计" ok "$(has '3 条拦截（真实 2，自测 1）')"
check "按规则名聚合（不是只记 hook 名）" ok "$(has 'guard_command｜rm -rf /')"
check "自测流量不进真实基线" ok "$(has '按规则（真实拦截）')"

echo "== 3. 同一条规则反复拦 → 要提示回看原话 =="
for i in 1 2 3 4 5; do
  printf '{"ts":"%s","hook":"guard_command","rule":"skipTests","target":"mvn -DskipTests x","source":"tool"}\n' "$NOW" >> "$HARNESS_LEDGER_DIR/deny.jsonl"
done
run
check "≥5 次时提示核对是否规则写宽" ok "$(has '该回看被拦的原话')"

echo "== 4. 没有 events → 明确说无法证明门禁在线 =="
check "点名"没法证明在线"" ok "$(has '无法证明门禁在任意时段在线')"

echo "== 5. 有 events → 报在线条数、覆盖整点、最近一次 =="
cat > "$HARNESS_LEDGER_DIR/events.jsonl" <<EOF
{"ts":"$NOW","hook":"session_start","type":"session","detail":{}}
{"ts":"$NOW","hook":"session_start","type":"session","detail":{}}
EOF
run
check "报出在线条数与整点数" ok "$(has '门禁在线记录（events）：2 条，覆盖')"
check "说明它的用途是有分母" ok "$(has '拦截次数才有分母')"
check "有 events 后不再说'无法证明在线'" missing "$(has '无法证明门禁在任意时段在线')"

echo "== 6. 坏行不猜内容，也不崩 =="
printf 'not-json\n{"ts":"%s","hook":"guard_write","rule":"block","source":"tool"\n' "$NOW" >> "$HARNESS_LEDGER_DIR/deny.jsonl"
run
check "坏行后仍 exit 0" 0 "$?"
check "坏行计数提示" ok "$(has '行无法解析')"

echo "== 7. --json 里要有 events（给自动化用）=="
node "$HERE/scripts/ledger-report.mjs" --json >"$JSONOUT" 2>&1
node -e '
const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const ok = j.events && j.events.total === 2 && Array.isArray(j.events.by_type) && j.events.online_hours >= 1;
process.stdout.write(ok ? "ok" : JSON.stringify(j.events));
' "$JSONOUT" > "$TMP/j.txt" 2>&1
check "--json 里 events.total / by_type / online_hours 齐备" ok "$(cat "$TMP/j.txt")"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
