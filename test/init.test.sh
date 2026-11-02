#!/usr/bin/env bash
# init 脚本自测：slug 白名单 + state.json 可解析。
#
# 真实故障形态（评审发现）：
#   slug 含 ../  → 状态文件写到 .ai/tasks 之外（路径逃逸）
#   slug 含引号  → heredoc 手拼的 JSON 非法，接手的人读不到进度
# 根因相同：未校验的用户输入被直接拼进路径与模板串。白名单 + JSON.stringify 双修。
#
# 用法：bash test/init.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 隔离：init 以 HARNESS_ROOT 为根（与 hooks 同一开关），测试不污染真实 .ai/tasks
export HARNESS_ROOT="$TMP"
cp "$HERE/harness.config.json" "$TMP/"
cd "$TMP"

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

echo "== 1. 合法 slug → 建档，state.json 可解析且字段原样 =="
bash "$HERE/scripts/init-harness.sh" selftest-ok M >/dev/null 2>&1
check "合法 slug 建档" 0 "$?"
ok=0
node -e 'const s=require("./.ai/tasks/selftest-ok/state.json");process.exit(s.meta.task==="selftest-ok"&&s.stage==="rs"&&s.meta.flow_tier==="M"?0:1)' || ok=$?
check "state.json 合法且字段正确（起始阶段在链上=rs）" 0 "$ok"

echo "== 2. 重复初始化 → 不覆盖 =="
bash "$HERE/scripts/init-harness.sh" selftest-ok M >/dev/null 2>&1
check "已存在时 exit 0 不覆盖" 0 "$?"

echo "== 3. 路径逃逸 → 拒绝 =="
bash "$HERE/scripts/init-harness.sh" ../evil M >/dev/null 2>&1
check "../ 被拒（exit 64）" 64 "$?"
if [ ! -e "$TMP/evil" ] && [ ! -e "$TMP/.ai/evil" ]; then
  printf "  \033[32m✓\033[0m %s\n" "任务目录外无落盘"
  pass=$((pass + 1))
else
  printf "  \033[31m✗\033[0m 任务目录外出现了文件\n"
  fail=$((fail + 1))
fi

echo "== 4. 非法字符 → 拒绝 =="
bash "$HERE/scripts/init-harness.sh" 'a"b' M >/dev/null 2>&1
check "引号 slug 被拒" 64 "$?"
bash "$HERE/scripts/init-harness.sh" 'Demo' M >/dev/null 2>&1
check "大写 slug 被拒" 64 "$?"
bash "$HERE/scripts/init-harness.sh" '-x' M >/dev/null 2>&1
check "连字符开头被拒（防选项注入）" 64 "$?"

echo "== 5. 非法 flow-tier → 仍拒绝 =="
bash "$HERE/scripts/init-harness.sh" selftest-ok X >/dev/null 2>&1
check "tier 越界被拒" 64 "$?"

echo "== 6. 任务类型与追溯参数（change/bugfix 门槛）=="
bash "$HERE/scripts/init-harness.sh" selftest-ok M --type change >/dev/null 2>&1
check "change 缺 --related 被拒" 64 "$?"
bash "$HERE/scripts/init-harness.sh" selftest-ok M --type change --related no-such-task --baseline c0ffee >/dev/null 2>&1
check "change 关联不存在的任务被拒" 64 "$?"

# 先建一个合法的原任务，供 change/bugfix 关联
bash "$HERE/scripts/init-harness.sh" selftest-base M >/dev/null 2>&1

# git 仓库用于 baseline 存在性校验（change 基线必须是仓库历史里真实存在的 commit hash）
git init -q
git config user.email harness@example.com
git config user.name harness
git add -A
git commit -qm "init for baseline test"
BASE_HASH="$(git rev-parse HEAD)"

bash "$HERE/scripts/init-harness.sh" selftest-ok M --type change --related selftest-base >/dev/null 2>&1
check "change 缺 --baseline 被拒" 64 "$?"
bash "$HERE/scripts/init-harness.sh" selftest-ok M --type change --related selftest-base --baseline "v1.2" >/dev/null 2>&1
check "baseline 非 commit hash 被拒（修订号机器验证不了，不收）" 64 "$?"
bash "$HERE/scripts/init-harness.sh" selftest-ok M --type change --related selftest-base --baseline deadbee >/dev/null 2>&1
check "baseline commit 不在历史里被拒" 64 "$?"
bash "$HERE/scripts/init-harness.sh" selftest-ok M --type bugfix >/dev/null 2>&1
check "bugfix 缺 --related 被拒" 64 "$?"
bash "$HERE/scripts/init-harness.sh" selftest-bug M --type bugfix --related selftest-base >/dev/null 2>&1
check "bugfix 关联合法任务建档成功" 0 "$?"
ok=0
node -e 'const s=require("./.ai/tasks/selftest-bug/state.json");process.exit(s.meta.task_type==="bugfix"&&s.meta.related_task==="selftest-base"&&Array.isArray(s.meta.affected_ids)&&s.meta.affected_ids.length===0?0:1)' || ok=$?
check "bugfix state 追溯字段正确" 0 "$ok"

bash "$HERE/scripts/init-harness.sh" selftest-chg M --type change --related selftest-base --baseline "$BASE_HASH" >/dev/null 2>&1
check "change 全参数（真实 hash）建档成功" 0 "$?"
ok=0
node -e 'const s=require("./.ai/tasks/selftest-chg/state.json");process.exit(s.meta.task_type==="change"&&s.meta.baseline===process.argv[1]&&s.meta.change_tier===null?0:1)' "$BASE_HASH" || ok=$?
check "change state 基线与档位字段正确" 0 "$ok"

echo "== 7. 类型与参数的其他拒绝路径 =="
bash "$HERE/scripts/init-harness.sh" selftest-ok M --type hotfix >/dev/null 2>&1
check "未知 --type 被拒" 64 "$?"
bash "$HERE/scripts/init-harness.sh" selftest-ok M --related selftest-base >/dev/null 2>&1
check "feature 带 --related 被拒（开关拼错早暴露）" 64 "$?"
bash "$HERE/scripts/init-harness.sh" selftest-ok M --type bugfix --related ../escape >/dev/null 2>&1
check "--related 含路径逃逸被拒" 64 "$?"
bash "$HERE/scripts/init-harness.sh" selftest-ok M --unknown x >/dev/null 2>&1
check "未知开关被拒（不静默吞掉）" 64 "$?"

# slug 的日期段约定 = 建档日期。真实项目出现过 2026-09-24-* 的目录却在 10-31 建档，
# 按日期找任务的人直接扑空。不硬拦（业务日期有意义），但必须当场说清楚。
out="$(bash "$HERE/scripts/init-harness.sh" 2026-09-24-old-slug M 2>&1)"
check "日期段与今天不符时提示" 0 "$(printf '%s' "$out" | grep -q '不是今天' && echo 0 || echo 1)"
out="$(bash "$HERE/scripts/init-harness.sh" "$(date +%F)-today-slug" M 2>&1)"
check "日期段就是今天 → 不打提示" 1 "$(printf '%s' "$out" | grep -q '不是今天' && echo 0 || echo 1)"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
