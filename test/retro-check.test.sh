#!/usr/bin/env bash
# retro 落盘机器判自测（P1-②，2026-11-11）—— checkRetroLanding 的正负向全覆盖。
#
# 背景：stage 链一直有 retro 阶段，但没有任何代码查"文档到底落没落"——
# 8 个 done 任务 retro/ 只有 3 份能对上号。这条判据把"经验沉淀链闭合"变成机器可查。
#
# 用法：bash test/retro-check.test.sh
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
    printf "  \033[31m✗\033[0m %s  (期望 %s，实际 %s)\n" "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

# fixture：最小项目 + retro 目录
mkdir -p "$TMP/proj/retro" "$TMP/proj/.ai/tasks/t1"

# 单元判据：直接 import 仓库的 verify.mjs，在 fixture repo 上判
mkstate() { # mkstate <slug> <created> <stage> <status> <retro声明或空>
  node -e '
    const fs = require("fs");
    const [dir, slug, created, stage, status, retro] = process.argv.slice(1);
    const s = {
      meta: { task: slug, created_at: created + "T00:00:00Z" },
      stage, todos: [],
      artifacts: retro ? { retro } : {},
    };
    if (status !== "active") s.meta.status = status;
    fs.writeFileSync(dir + "/.ai/tasks/t1/state.json", JSON.stringify(s, null, 2));
  ' "$TMP/proj" "$1" "$2" "$3" "$4" "$5"
}

judge() { # 输出 failures 数
  node --input-type=module -e '
    import { checkRetroLanding } from "'"$HERE"'/hooks/lib/verify.mjs";
    import { readFileSync } from "node:fs";
    const state = JSON.parse(readFileSync(process.argv[1] + "/.ai/tasks/t1/state.json", "utf8"));
    const out = checkRetroLanding(state, process.argv[1], "2026-11-11");
    console.log(out.length + "|" + (out[0] ? out[0].reason : ""));
  ' "$TMP/proj" 2>/dev/null | cut -d'|' -f1
}

echo "== 1. 新任务（created ≥ 2026-11-11）必须闭合 =="
mkstate new-task 2026-11-12 done active ""
check "无声明且无匹配文件 → 拦" 1 "$(judge)"

echo "x" > "$TMP/proj/retro/new-task-复盘.md"
check "retro/<slug>*.md 存在 → 过（slug 兜底约定）" 0 "$(judge)"

mkstate new-task 2026-11-12 done active "retro/new-task-复盘.md"
check "声明 artifacts.retro 且存在 → 过" 0 "$(judge)"

mkstate new-task 2026-11-12 done active "docs/plan.md"
check "声明到 retro/ 之外 → 拦（落盘位唯一）" 1 "$(judge)"

mkstate new-task 2026-11-12 done active "retro/不存在的文件.md"
check "声明的文件不存在 → 拦" 1 "$(judge)"

echo "== 2. 存量与豁免 =="
rm -f "$TMP/proj/retro/new-task-复盘.md"
mkstate legacy-task 2026-11-06 done active ""
check "存量任务（created < 2026-11-11）不追溯 → 过" 0 "$(judge)"

mkstate new-task 2026-11-12 done abandoned ""
check "abandoned 任务豁免 → 过" 0 "$(judge)"

mkstate new-task 2026-11-12 impl active ""
check "未到 done 不查 → 过" 0 "$(judge)"

echo "== 3. 变异：删掉判据本体则本套全红（可证伪）=="
node --input-type=module -e '
    import { checkRetroLanding } from "'"$HERE"'/hooks/lib/verify.mjs";
    import { readFileSync } from "node:fs";
    const state = { meta: { task: "new-task", created_at: "2026-11-12T00:00:00Z" }, stage: "done", todos: [], artifacts: {} };
    const out = checkRetroLanding(state, "'"$TMP"'/proj", "1970-01-01");
    console.log(out.length > 0 ? "alive" : "dead");
' | grep -q alive && r=0 || r=1
check "判据在（fromDate=1970 时任何 done 任务都该被查）" 0 "$r"

echo "== 4. retro 归属唯一性（复审补）：同一文件两个任务声明 → CI 双红 =="
UNIQ="$TMP/uniq"
mkdir -p "$UNIQ/scripts" "$UNIQ/hooks/lib" "$UNIQ/.ai/verify" "$UNIQ/retro" "$UNIQ/.ai/tasks/ta" "$UNIQ/.ai/tasks/tb"
cp "$HERE/scripts/ci-verify.mjs" "$UNIQ/scripts/"
cp "$HERE"/hooks/lib/*.mjs "$UNIQ/hooks/lib/"
cp "$HERE/harness.config.json" "$UNIQ/"
echo shared > "$UNIQ/retro/shared-f.md"
for t in ta tb; do
  node -e '
    const fs = require("fs");
    const [dir, t] = process.argv.slice(1);
    fs.writeFileSync(`${dir}/.ai/tasks/${t}/state.json`, JSON.stringify({
      // 存量日期：本节专测归属唯一性，新任务的 slug 命名规则在别的节判
      meta: { task: t, created_at: "2026-11-10T00:00:00Z" }, stage: "done", todos: [],
      artifacts: { retro: "retro/shared-f.md" },
    }, null, 2));
  ' "$UNIQ" "$t"
done
(cd "$UNIQ" && node scripts/ci-verify.mjs --mode ci) > "$TMP/uniq-out" 2>&1
rc=$?
check "双任务同 retro → ci-verify 红（exit 1）" 1 "$rc"
grep -q "同时声明" "$TMP/uniq-out" && r=0 || r=1
check "报错点名两个任务与文件" 0 "$r"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
