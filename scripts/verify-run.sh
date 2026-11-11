#!/usr/bin/env bash
# 定向验证包装器 —— 让 verify 证据链只可能由「真跑过一次」产生。
#
# 用法：
#   bash scripts/verify-run.sh T1 -- mvn -q test -Dtest=FooTest
#   bash scripts/verify-run.sh V1 -- pnpm run test:unit
#
# 日志写到 .ai/verify/<id>.log，头部固定 4 行（有测试计数时 5 行），
# 供 hooks/lib/verify.mjs 机器校验（只认前 5 行，别往里插别的）。
# 末尾保留输出尾部 200 行：足够定位失败原因，又不会把仓库撑大。
set -uo pipefail
# 把 pipefail 传给被跑的命令（P2-2）。
#
# 本脚本自己的 `set -o pipefail` 只管自己：命令是子进程，默认不带这个选项。
# 于是证据链上最常见的写法 `npm test 2>&1 | tail -1` 会让退出码变成 tail 的 0——
# 套件红了链条照走，日志照样写 exit_code: 0。实测 RV2.log 就是这么绿过来的。
#
# 传导方式选 BASH_ENV 而不是 export SHELLOPTS：
# SHELLOPTS 会把**全部** shell 选项一起传下去，包括本脚本开的 `nounset`——
# 实测这样子跑 gate，harness-cli 那套立刻多出 1~8 条红（子 bash 里一个空变量
# 从"展开成空串"变成"unbound variable"，连带 `node -e <空路径>` 报 MODULE_NOT_FOUND），
# 而这跟证据真假毫无关系。BASH_ENV 指到的文件只做一件事：打开 pipefail。
PIPEFAIL_ENV="$(mktemp)"
printf 'set -o pipefail\n' > "$PIPEFAIL_ENV"
export BASH_ENV="$PIPEFAIL_ENV"
# sh/zsh 不读 BASH_ENV，那两个 shell 里这条传导无效——所以判据只看日志头的退出码，
# 不猜命令是怎么写的。

# 可选 `--task <名字>`（或环境变量 HARNESS_TASK）：声明"这条证据属于哪个任务"。
#
# 为什么需要它：`.ai/verify/<id>.log` 是**全局**命名空间，两个任务都用 `T1` 就会
# 互相覆盖，而覆盖是静默的——门禁只看"有日志且 exit_code=0"，串台看不出来。
# 实测踩过一次：给新任务生成第一条证据时，把另一个任务的 T1.log 冲掉了，事后才
# 发现那份证据已经不是我原来跑的东西。判据不报错，才是这类事故最贵的地方。
TASK="${HARNESS_TASK:-}"
if [ "${1:-}" = "--task" ]; then
  TASK="${2:-}"
  if [ -z "$TASK" ]; then
    echo "用法: bash scripts/verify-run.sh [--task <任务名>] <todo-id> -- <command...>" >&2
    exit 64
  fi
  shift 2
fi

if [ $# -lt 3 ] || [ "$2" != "--" ]; then
  echo "用法: bash scripts/verify-run.sh [--task <任务名>] <todo-id> -- <command...>" >&2
  exit 64
fi

ID="$1"
shift 2

# id 同时是文件名。`../x` 会把日志写到 .ai/verify 之外（.ai/verify/../../scripts/x.log），
# 而"证据"落在别处不会被任何判据看见——这正是最贵的一类失败：静默。
# 字符集白名单一次关掉路径穿越、空白与隐藏文件名，比逐个拦 `..` 可靠。
if ! printf '%s' "$ID" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'; then
  echo "[verify] todo-id 只能用字母 / 数字 / . _ -（字母或数字开头，≤64 位），收到：${ID}" >&2
  exit 64
fi

# 命令必须先存进数组再跑。
# 反面教材（实测）：下面统计计数时用 `set -- $parsed` 拆字段，会覆盖位置参数 $@，
# 于是后面 `echo "# cmd: $*"` 打出来的是 "7 0 0 0"——命令字段变成了测试计数。
# 越是**有** surefire 报告的 Maven 运行越必然踩中，正好是它被设计要解决的场景。
CMD=("$@")
printf -v CMDLINE '%q ' "${CMD[@]}"
CMDLINE="${CMDLINE% }"

# 产证时的 HEAD（P1-③后半）：证据绑提交，CI 侧只认当前历史线上的运行。
# 拿不到 hash（空仓 / 非仓库）写 unknown —— 校验侧正则不认它，等价于旧日志的不追溯。
# 脏树同样写 unknown（复审 M1 抓回）：工作树有未提交改动时，日志内容来自"HEAD+改动"，
# 在 HEAD 的 checkout 上不可复现——盖一个真 hash 等于伪造可复现性。要拿到绑定的证据，
# 提交后重跑一次（DFG 的刷新就是这个用法）。
# 脏的口径要窄：只看**跟踪文件的源码改动**（staged+unstaged，排除 .ai/verify/——日志是
# 本次流程的产物，重写它不影响命令结果的可复现性）；未跟踪文件不参与（?? 在 porcelain 里
# 也会出现，但一个无关的临时文件不该让全部证据失去提交绑定）。
if ! git diff --quiet HEAD -- . ':(exclude).ai/verify' 2>/dev/null; then
  HEAD_COMMIT="unknown"
else
  HEAD_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
fi

mkdir -p .ai/verify
LOG=".ai/verify/${ID}.log"

# 归属检查：不悄悄覆盖别人已经当作证据引用的日志。
# 只有 id 被某个 state.json 的 verify.log_path 指到时才算"别人的"；没被引用的
# 同名文件（比如你自己上一次的临时产物）照旧直接覆盖。
claimers=()
for f in .ai/tasks/*/state.json; do
  [ -f "$f" ] || continue
  if grep -qF ".ai/verify/${ID}.log" "$f" 2>/dev/null; then
    claimers+=("$(basename "$(dirname "$f")")")
  fi
done

if [ -f "$LOG" ] && [ ${#claimers[@]} -gt 0 ]; then
  owned=0
  for c in "${claimers[@]}"; do
    [ "$c" = "$TASK" ] && owned=1
  done
  if [ "$owned" -eq 0 ]; then
    if [ -n "$TASK" ] || [ ${#claimers[@]} -gt 1 ]; then
      echo "[verify] 拒绝覆盖：$LOG 已被任务 ${claimers[*]} 引用，不是 ${TASK:-（未声明 --task）} 的。" >&2
      echo "[verify] 换个 id（例如在你的任务名下加前缀），或确认确实要改写别人的证据时加 --task ${claimers[0]}" >&2
      exit 2
    fi
    # 只被一个任务引用、又没声明任务名：最可能是自己重跑，提醒一句即可。
    echo "[verify] 注意：$LOG 已属于任务 ${claimers[0]}；若是同一任务重跑，加 --task ${claimers[0]} 显式确认" >&2
  fi
fi
OUT="$(mktemp)"
BENCH="$(mktemp)"   # 运行起点（毫秒时间戳）：本次运行写过的报告才计入
trap 'rm -f "$OUT" "$BENCH" "$PIPEFAIL_ENV"' EXIT

START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# 判据是"本次运行写过这份报告"，实现方式是运行起点的毫秒时间戳 vs 文件 mtime。
#
# 为什么不用 `find -newer`：busybox（alpine CI 镜像）的 -newer 只比较到**秒**，
# 同一秒内生成的 surefire 报告会被判成"不新"，计数静默变成 0、`# tests` 行整条消失，
# audit.tests 随即对不上账（实测：7+5 聚合在 alpine 上得到空值，macOS 正常）。
#
# 为什么也不用"运行前后文件清单差集"：mvn 重跑会把 target/surefire-reports/TEST-Foo.txt
# **原地重写**，路径不变，差集就当它没动过 —— 那是更常见的主场景，计数同样会丢。
# 文件身份回答不了"这份报告这次写过没有"，只有时间能回答；要换掉的是不可靠的
# 时间来源（find -newer 的秒级比较），不是时间语义本身。
node -e 'process.stdout.write(String(Date.now()))' >"$BENCH"

"${CMD[@]}" >"$OUT" 2>&1
CODE=$?
END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 从 surefire-reports 聚合测试计数写进头部（#17）：mvn -q 会把 Tests run 从 stdout 吞掉，
# 成功日志里若没有数字，audit.tests 的 N/M 就永远无法对账（实测同一事实出过 27/6/16 三个版本）。
# 只统计本次运行写过的报告（mtime >= 运行起点毫秒），跨次运行不重复计数。
TESTS_TOTAL=0; TESTS_FAIL=0; TESTS_ERR=0; TESTS_SKIP=0
while IFS= read -r txt; do
  line="$(grep -m1 '^Tests run:' "$txt" 2>/dev/null || true)"
  [ -z "$line" ] && continue
  parsed="$(printf '%s' "$line" | sed -n 's/^Tests run: \([0-9]*\), Failures: \([0-9]*\), Errors: \([0-9]*\), Skipped: \([0-9]*\).*/\1 \2 \3 \4/p')"
  [ -z "$parsed" ] && continue
  # 用 read 拆到具名变量，不动位置参数（见上面 CMD 的注释）
  read -r t f e s <<<"$parsed"
  TESTS_TOTAL=$((TESTS_TOTAL + t)); TESTS_FAIL=$((TESTS_FAIL + f))
  TESTS_ERR=$((TESTS_ERR + e)); TESTS_SKIP=$((TESTS_SKIP + s))
done < <(
  # 用 node 取 mtime：fs 侧给的是浮点毫秒，精度取决于文件系统，不取决于 find 的实现。
  # 只找 */target/surefire-reports/*.txt，跳过 .git / node_modules 免得在仓库根上白走。
  node -e '
    const fs = require("fs"), path = require("path");
    const start = Number(fs.readFileSync(process.argv[1], "utf8"));
    const hits = [];
    (function walk(dir) {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === ".git" || e.name === "node_modules") continue;
          walk(p);
        } else if (e.name.endsWith(".txt") &&
                   p.split(path.sep).join("/").includes("/target/surefire-reports/")) {
          try { if (fs.statSync(p).mtimeMs >= start) hits.push(p); } catch { /* 跑完被删掉的报告不计数 */ }
        }
      }
    })(".");
    for (const h of hits) console.log(h);
  ' "$BENCH" | sort
)

{
  echo "# cmd: ${CMDLINE}"
  echo "# started: ${START}"
  echo "# finished: ${END}"
  echo "# exit_code: ${CODE}"
  echo "# commit: ${HEAD_COMMIT}"
  # 归属绑定（复审补）：日志与任务绑定，S 档折叠的 gate 日志校验据此拒"借别的任务的绿日志"。
  # 不传 --task 则不写（历史用法兼容）；校验侧只在头存在时才判归属。
  [ -n "$TASK" ] && echo "# task: ${TASK}"
  # 没有报告就不写这一行：写个 total=0 等于伪造一条「跑了 0 个用例」的结论，
  # 而 checkAuditTestsMatch 会拿它去对账，把「没统计到」变成「对不上」。
  if [ "$TESTS_TOTAL" -gt 0 ]; then
    echo "# tests: total=${TESTS_TOTAL} failures=${TESTS_FAIL} errors=${TESTS_ERR} skipped=${TESTS_SKIP}（来源 surefire-reports，非 stdout）"
  fi
  echo "# ---- output tail (last 200 lines) ----"
  tail -n 200 "$OUT"
} >"$LOG"

if [ "$CODE" -eq 0 ]; then
  echo "[verify] PASS  ${LOG}"
else
  echo "[verify] FAIL(exit=${CODE})  ${LOG}" >&2
fi
exit "$CODE"
