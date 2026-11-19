#!/usr/bin/env bash
# perf 卡点自测 —— P0 卡点1（review-checks 性能反模式）+ P0 卡点2（verify-run 耗时基线）。
#
# 这两个判据的输入源是"变更文件"与"started/finished 头"：
#   · 反模式扫描误报会训练人忽略 yellow——正例/负例都必须测；
#   · 基线比对算错会把快当慢、慢当快——四档（正常/改善/超五成/超一倍）逐档断言。
#
# 用法：bash test/perf-checks.test.sh     全部通过退出 0
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

echo "== 1. perf_anti_patterns：正例（应命中 4 类各 ≥1）=="
mkdir -p "$TMP/src"
cat > "$TMP/src/Bad.java" <<'EOF'
// 正例文件：四类反模式各一处
for (User u : users) { User db = mapper.findById(u.getId()); }          // N+1
for (String s : urls) { String r = client.get(s); }                       // 循环内 IO
for (int i = 0; i < n; i++) { for (int j = 0; j < m; j++) { sum += a[i][j]; } } // 嵌套
List<X> all = list.stream().collect(Collectors.toList());                 // 无界
EOF
OUT=$(cd "$TMP" && node -e "
  import('$HERE/scripts/lib/review-checks.mjs').then(({ runMachineChecks }) => {
    const findings = runMachineChecks(
      [{ id: 'perf_anti_patterns', severity: 'yellow' }],
      '$TMP', ['src/Bad.java']);
    const ids = [...new Set(findings.map(f => f.rule.split(':')[1]))].sort();
    console.log(ids.join(','));
  });
")
check "四类反模式全命中" "perf_n_plus_1,perf_nested_loop,perf_sync_io,perf_unbounded" "$OUT"

echo "== 2. perf_anti_patterns：负例（干净代码零命中）=="
cat > "$TMP/src/Good.java" <<'EOF'
// 负例：批量查询 / 流式 IO / 无嵌套
List<User> all = mapper.findByIds(ids);
List<R> rs = client.getAll(urls);
int t = n + m;
EOF
OUT=$(node -e "
  import('$HERE/scripts/lib/review-checks.mjs').then(({ runMachineChecks }) => {
    const findings = runMachineChecks(
      [{ id: 'perf_anti_patterns', severity: 'yellow' }],
      '$TMP', ['src/Good.java']);
    console.log(findings.length);
  });
")
check "干净代码零命中" "0" "$OUT"

echo "== 3. perf_anti_patterns：测试文件豁免（test/ 路径不扫）=="
mkdir -p "$TMP/test"
cp "$TMP/src/Bad.java" "$TMP/test/Bad.java"
OUT=$(node -e "
  import('$HERE/scripts/lib/review-checks.mjs').then(({ runMachineChecks }) => {
    const findings = runMachineChecks(
      [{ id: 'perf_anti_patterns', severity: 'yellow' }],
      '$TMP', ['test/Bad.java']);
    console.log(findings.length);
  });
")
check "test/ 路径不扫" "0" "$OUT"

echo "== 4. verify-run 耗时基线：首跑记录 → 四档比对 =="
mkdir -p "$TMP/scripts" "$TMP/perf-root"
cp "$HERE/scripts/verify-run.sh" "$TMP/scripts/"
# 基线文件必须由 verify-run 自己首次写入：用固定基线直接测比对分支更稳——
# 这里直接构造四种基线/时长组合，断言档位输出。
cd "$TMP/perf-root"
run_case() { # $1=baseline_ms $2=sleep_s $3=期望档位标记(🟡/🔴/✅/无)
  rm -rf .ai
  mkdir -p .ai/perf
  printf '{ "T%d": %s }\n' "$4" "$1" > .ai/perf/baseline.json
  OUT=$(bash "$TMP/scripts/verify-run.sh" --task "T$4-t" "T$4" -- bash -c "sleep $2" 2>&1 | grep -o '🟡\|🔴\|✅' | head -1)
  [ -z "$OUT" ] && OUT="无"
  check "基线${1}ms + sleep${2}s → $3" "$3" "$OUT"
}
# 注意：ID 传参形态为 --task <task> <ID>，基线键 = ID。时间戳秒级分辨率 ±1s 抖动，
# sleep 6s 时长落在 [6000,7000]ms——基线选在抖动区间内仍确定归档的值：
run_case 5000 4.0 无  1   # ~80-100% 正常区间
run_case 10000 4.0 ✅ 2   # ~40-50% 改善
run_case 2600 4.0 🟡 3   # ~154-192% 超五成
run_case 1800 4.0 🔴 4   # ~222-278% 超一倍

echo
if [ "$fail" -eq 0 ]; then
  printf "\033[32mperf-checks 全部通过（%s 项）\033[0m\n" "$pass"
  exit 0
else
  printf "\033[31mperf-checks 失败 %s 项\033[0m\n" "$fail"
  exit 1
fi
