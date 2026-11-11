#!/usr/bin/env bash
# 停滞判据自测：3 天规则从"提醒"升级成"机器判据"之后，它必须真的会红、也会放。
#
# 这一条以前是 `warn` + 7 天 + 看 mtime，等于装饰：两个任务停在 impl 十天，
# doctor 只在终端里小声说一句，`npm run gate` 照样绿。绿灯说"没问题"，问题在原处。
#
# 本套件重点证伪的是**时钟选择**：把僵尸 state.json 的 mtime touch 到刚才，
# 判据必须仍然红。如果它变绿，说明判的是"文件什么时候写盘"（checkout 顺序、touch 都能左右），
# 而不是"这份进度什么时候落进仓库"。
#
# 用法：bash test/stale-task.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then
    printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass + 1))
  else
    printf "  \033[31m✗\033[0m %s  (期望 %s，实际 %s)\n" "$1" "$2" "$3"; fail=$((fail + 1))
  fi
}
# expect 名称 0/1（0=应当出现，1=不应出现） 片段 输出
expect() {
  if printf '%s' "$4" | grep -qF -- "$3"; then r=0; else r=1; fi
  check "$1" "$2" "$r"
}

# 夹具 = 一个能跑 doctor 的最小仓库。doctor 的 ROOT 由脚本位置推导，
# 所以必须把 doctor 与它依赖的 lib 一起拷进夹具，不能隔着目录跑真仓库
# （那样断言的是本仓库当下的状态：本仓库一好它就绿，判据坏了也测不出来）。
FIX="$TMP/fix"
mkdir -p "$FIX/scripts" "$FIX/hooks" "$FIX/.ai/tasks"
cp "$HERE/scripts/doctor.mjs" "$FIX/scripts/"
cp -R "$HERE/scripts/lib" "$FIX/scripts/lib"
cp -R "$HERE/hooks/lib" "$FIX/hooks/lib"
cp "$HERE/harness.config.json" "$FIX/"
set_threshold() {
  node -e '
  const fs = require("fs"), p = process.argv[1] + "/harness.config.json";
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  const v = process.argv[2];
  c.gates.staleTaskDays = v === "abc" ? "abc" : Number(v);
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
  ' "$FIX" "$1"
}
set_threshold 3

# mk <slug> <todo 状态> [abandoned] [blocked]
mk() {
  mkdir -p "$FIX/.ai/tasks/$1"
  node -e '
  const fs = require("fs");
  const [root, slug, todoStatus, isAbandoned, isBlocked] = process.argv.slice(1);
  const meta = { schema_version: 1, task: slug, task_type: "feature", flow_tier: "S", created_at: "2026-10-01T00:00:00Z" };
  if (isAbandoned === "1") {
    meta.status = "abandoned";
    meta.abandoned = { at: "2026-10-02T00:00:00Z", by: "自测", reason: "对账登记任务，产物已在 abc1234 交付，不补收尾", at_stage: "impl", open_todos: [], todos_total: 1 };
  }
  const st = { meta, stage: "impl", todos: [{ id: "T1", status: todoStatus }] };
  if (isBlocked === "1") st.blockers = [{ id: "B1", question: "等谁拍板", resolved: false }];
  fs.writeFileSync(`${root}/.ai/tasks/${slug}/state.json`, JSON.stringify(st, null, 2) + "\n");
  ' "$FIX" "$1" "$2" "${3:-0}" "${4:-0}"
}

cd "$FIX" || exit 1
git init -q . 2>/dev/null
git config user.email t@example.com
git config user.name t

# 旧任务：10 天前入库（用相对日期算，不写死日期——写死的话"已 N 天"会随当天日期漂，
# 断言就变成在测日历，不是在测判据）。
mk zombie   pending
mk finished completed
mk parked   pending 0 1
mk sealed   pending 1
git add -A
OLD="$(node -e 'console.log(new Date(Date.now() - 10 * 864e5).toISOString())')"
GIT_AUTHOR_DATE="$OLD" GIT_COMMITTER_DATE="$OLD" git commit -qm "旧任务入库" || exit 1

# 新任务：刚刚入库
mk fresh pending
git add -A
git commit -qm "fresh 刚动过" || exit 1

out="$(node "$FIX/scripts/doctor.mjs" 2>&1)"; code=$?

echo "== 1. 停滞 = 判红（不再是提醒）=="
check "有停滞任务时 doctor 退出码非 0" 1 "$code"
expect "停滞任务被点名" 0 "zombie 停在 stage=impl" "$out"
expect "报出天数和阈值（可核对，不是黑箱）" 0 "已 10 天没有任何提交（阈值 3 天）" "$out"
expect "给出 resume 出口" 0 "resume . zombie" "$out"
expect "给出 abandon 出口（红必须能变绿）" 0 "abandon . zombie --reason" "$out"

echo "== 2. 完工未收尾 vs 停滞：两种形态必须分开说 =="
expect "全部完成 → 说成完工未收尾" 0 "完工未收尾" "$out"
expect "完工未收尾也点名" 0 "finished 停在 stage=impl" "$out"

echo "== 3. 不该判的三类：新近动过 / 有未决 blocker / 已封存 =="
expect "刚提交的不判" 1 "fresh 停在" "$out"
expect "未决 blocker 是正当暂停，不判" 1 "parked 停在" "$out"
expect "已封存的不判（否则封存等于把红焊死在仓库里）" 1 "sealed 停在" "$out"

echo "== 4. 时钟是 git 提交时间，不是 mtime =="
# 这一条是整套判据的命门：touch 一下就把红变绿，说明判的是文件系统状态。
# 实测过 mtime 的不可靠：新 clone 的仓库里 mtime 全是检出时间，14 个历史任务集体"刚改过"。
touch "$FIX/.ai/tasks/zombie/state.json" "$FIX/.ai/tasks/finished/state.json"
out2="$(node "$FIX/scripts/doctor.mjs" 2>&1)"
expect "touch 后仍然判红（与 mtime 无关）" 0 "zombie 停在 stage=impl" "$out2"

echo "== 5. 有未提交改动 = 正在动（不冤 WIP）=="
node -e 'const fs=require("fs"),p=process.argv[1];const s=JSON.parse(fs.readFileSync(p,"utf8"));s.meta.note="在改";fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n")' "$FIX/.ai/tasks/zombie/state.json"
out3="$(node "$FIX/scripts/doctor.mjs" 2>&1)"
expect "本地改了还没提交 → 不算停滞" 1 "zombie 停在 stage=impl" "$out3"

echo "== 6. 阈值可配：设大就没人算停滞；设错必须报出来 =="
# 先把 §5 的本地改动撤掉，让 zombie 的时钟回到 10 天前——
# 否则"阈值 30 天不判"会因为它的提交时间刚被刷新而空转通过。
git checkout -- .ai/tasks/zombie/state.json
set_threshold 30
git add harness.config.json >/dev/null 2>&1
git commit -qm "阈值 30 天" >/dev/null 2>&1
out4="$(node "$FIX/scripts/doctor.mjs" 2>&1)"
expect "阈值 30 天 → 10 天的不算停滞" 1 "没有任何提交（阈值 30 天）" "$out4"

# 0 / 负数 / 字符串：写错时不能静默变成"永不报"，也不能变成"全都报"。
for bad in 0 -3 abc; do
  set_threshold "$bad"
  outb="$(node "$FIX/scripts/doctor.mjs" 2>&1)"
  expect "staleTaskDays=$bad → 判配置错误，不静默失效" 0 "停滞判据会静默失效" "$outb"
done

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
