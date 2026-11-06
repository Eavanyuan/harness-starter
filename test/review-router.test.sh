#!/usr/bin/env bash
# review-router 自测：变更文件 → 审核类型的路由判据。
#
# 覆盖面（对照 checklist §6/§14：只有"拦得住"没有"不误拦"等于没测）：
#   正向：rs/adr/cr 命中、多类型并存、evidence 恒在、projects 源码槽、fallback 兜底
#   负向：噪声跳过、未匹配不猜、规则缺失/非法 fail-closed（exit 2 而非空结果 0）
# 用法：bash test/review-router.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then
    printf "  \033[32m✓\033[0m %s\n" "$1"
    pass=$((pass + 1))
  else
    printf "  \033[31m✗\033[0m %s  (期望 %s，实际 %s)\n" "$1" "$3" "$2"
    fail=$((fail + 1))
  fi
}

# fixture：rules + v2 projects 配置
mkdir -p "$TMP/repo"
cp "$HERE/harness.rules.json" "$TMP/repo/"
cat > "$TMP/repo/harness.config.json" <<'EOF'
{ "projects": [ { "id": "java", "lang": "java", "dir": "backend" } ] }
EOF

run_router() { # 参数=文件列表（逐个）；输出路由 JSON 的 ids
  : > "$TMP/list.txt"
  for f in "$@"; do echo "$f" >> "$TMP/list.txt"; done
  node "$HERE/scripts/review-router.mjs" --root "$TMP/repo" --files "$TMP/list.txt" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.reviews.map(r=>r.id).sort().join(","))})'
}
run_router_code() { node "$HERE/scripts/review-router.mjs" "$@" 2>/dev/null; echo "exit=$?"; }

echo "== 1. 命中与分流 =="
check "RS 文档 → rs + evidence" "evidence,rs" "$(run_router 'docs/01-requirements/RS-x.md')"
check "任务目录 rs.md（单层 *）命中" "evidence,rs" "$(run_router '.ai/tasks/foo-bar/rs.md')"
check "任务目录深层 rs.md（跨层）不命中 rs" "evidence" "$(run_router '.ai/tasks/a/b/rs.md')"
check "ADR 命中（docs/plans 下 ADR- 前缀）" "adr,evidence" "$(run_router 'docs/plans/ADR-001.md')"
check "源码（projects 槽 backend）→ cr" "cr,evidence" "$(run_router 'backend/src/A.java')"
check "RS + 源码混合 → 三类并存" "cr,evidence,rs" "$(run_router 'docs/01-requirements/RS-x.md' 'backend/src/A.java')"
check "未匹配文件（README）→ 仅 evidence" "evidence" "$(run_router 'README.md')"

echo "== 2. 噪声与 trivial =="
out=$(run_router 'package-lock.json' '.ai/ledger/deny.jsonl' 'a/b/pnpm-lock.yaml')
check "纯噪声 → 无任何审核" "" "$out"
trivial=$(node "$HERE/scripts/review-router.mjs" --root "$TMP/repo" --files <(echo 'package-lock.json') 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).trivial))')
check "纯噪声 → trivial=true（evidence 也跳过）" "true" "$trivial"
check "噪声+真实混合 → 噪声不进 rs" "evidence,rs" "$(run_router 'package-lock.json' 'docs/01-requirements/RS-x.md')"

echo "== 3. projects 无配置时 fallback 兜底 =="
mkdir -p "$TMP/noconf"
cp "$HERE/harness.rules.json" "$TMP/noconf/"
out=$(cd "$TMP/noconf" && echo 'backend/src/A.java' > list.txt && node "$HERE/scripts/review-router.mjs" --files list.txt 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.reviews.map(r=>`${r.id}:${r.via}`).sort().join(","))})')
check "无 config → cr 走 fallback" "cr:fallback,evidence:always" "$out"
out=$(cd "$TMP/noconf" && echo 'src/lib/mod.py' > list.txt && node "$HERE/scripts/review-router.mjs" --files list.txt 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).reviews.some(r=>r.id==="cr")))')
check "fallback 槽 src/** 命中 python 源码" "true" "$out"

echo "== 4. fail-closed：规则坏了不许装没事 =="
mkdir -p "$TMP/bare"   # 只有清单文件，无 rules —— 才是真正的"规则缺失"
(cd "$TMP/bare" && echo x > list.txt && node "$HERE/scripts/review-router.mjs" --files list.txt >/dev/null 2>&1)
check "规则缺失 → exit 2" "2" "$?"
sed 's/"schema_version": 1/"schema_version": 9/' "$HERE/harness.rules.json" > "$TMP/repo/harness.rules.json"
(cd "$TMP/repo" && echo x > list.txt && node "$HERE/scripts/review-router.mjs" --files list.txt >/dev/null 2>&1)
check "schema_version 越界 → exit 2" "2" "$?"
cp "$HERE/harness.rules.json" "$TMP/repo/"

echo "== 5. git 模式（--base 真实 diff） =="
GT="$TMP/gitrepo"
mkdir -p "$GT" && cp "$HERE/harness.rules.json" "$GT/" && cp "$TMP/repo/harness.config.json" "$GT/"
git -C "$GT" init -q && git -C "$GT" config user.email t@t && git -C "$GT" config user.name t
mkdir -p "$GT/docs/01-requirements" && echo base > "$GT/docs/01-requirements/RS-old.md"
git -C "$GT" add -A && git -C "$GT" commit -qm base
echo new > "$GT/docs/01-requirements/RS-new.md"
git -C "$GT" add -A && git -C "$GT" commit -qm addrs
out=$(node "$HERE/scripts/review-router.mjs" --root "$GT" --base HEAD~1 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const rs=j.reviews.find(r=>r.id==="rs");console.log(rs?rs.files.join(","):"none")})')
check "--base diff 只取新文件" "docs/01-requirements/RS-new.md" "$out"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
