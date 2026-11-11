#!/usr/bin/env bash
# 初始化一个新任务的状态文件。
#
# 用法：bash scripts/init-harness.sh <slug> [flow-tier] [--type feature|change|bugfix]
#                [--related <slug>] [--baseline <ref>]
#   flow-tier: S | M | L | XL，缺省取 harness.config.json 的 project.defaultFlowTier
#   --type    : 任务类型。feature=新功能（默认）；change=已交付需求变更；bugfix=缺陷修复
#   --related : change/bugfix 必填——关联的原任务 slug（变更不重开旧 state，只引用）
#   --baseline: change 必填——需求基线，必须是 git commit hash（git rev-parse HEAD 可取）
#
# 一个任务一个 state 文件，是并行协作不冲突的前提。
# 不要退回到"全仓库一个 pipeline-state.json"，两个人同时开工就会撞。
set -euo pipefail

ROOT="${HARNESS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# HARNESS_ROOT 只给自测与 vendored 安装用，语义与 hooks 口径一致。
cd "$ROOT"

# 缺省档与初始信任级别取自配置，不在这里再抄一遍常量：
# 抄一遍的后果是配置改了没人发现，而这正是"配置项空转"最常见的形态。
cfg() {
  node -e 'try{const c=require("./harness.config.json");console.log(String((c.project||{})[process.argv[1]]))}catch{console.log("")}' "$1"
}

usage_err() { echo "用法: bash scripts/init-harness.sh <slug> [S|M|L|XL] [--type feature|change|bugfix] [--related <slug>] [--baseline <ref>]" >&2; exit 64; }

[ $# -ge 1 ] || usage_err
SLUG="$1"
shift

TIER="$(cfg defaultFlowTier)"
TIER="${TIER:-M}"
TYPE="feature"
RELATED=""
BASELINE=""

# 参数解析：前两个位置参数之外只认 --type/--related/--baseline，
# 未知参数一律报错而不是吞掉——拼错的开关静默失效等于没写。
positional=0
while [ $# -gt 0 ]; do
  case "$1" in
    --type)    [ $# -ge 2 ] || usage_err; TYPE="$2"; shift 2 ;;
    --related) [ $# -ge 2 ] || usage_err; RELATED="$2"; shift 2 ;;
    --baseline) [ $# -ge 2 ] || usage_err; BASELINE="$2"; shift 2 ;;
    -*) usage_err ;;
    *)
      if [ "$positional" -eq 0 ]; then TIER="$1"; positional=1; shift
      else usage_err
      fi
      ;;
  esac
done

# slug 同时是目录名和 JSON 字段值，两个都要防：
#   ../ 逃逸任务目录（状态文件写到 .ai/tasks 之外）；引号/反斜杠产出非法 JSON
#   （接手的人直接读不到进度）。白名单字符集一次关掉两类问题，比逐个黑名单可靠。
if ! printf '%s' "$SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]{0,63}$'; then
  echo "slug 只允许小写字母 / 数字 / 连字符（字母或数字开头，≤64 位），收到：$SLUG" >&2
  exit 64
fi

DIR=".ai/tasks/${SLUG}"

# slug 的日期段 = 建档日期，不是需求提出的日期。
# 这条约定此前只写在文档里，于是真实项目出现了 "2026-09-24-*" 的目录却在 10-31 建档——
# 按日期找任务的人会直接扑空。不硬拦（业务日期自有其意义），但必须当场提示，
# 并说清业务日期该写在哪里（meta.title / related_task），否则它会继续被误用。
if printf '%s' "$SLUG" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}-'; then
  SLUG_DATE="${SLUG:0:10}"
  TODAY="$(date +%F)"
  if [ "$SLUG_DATE" != "$TODAY" ]; then
    # 变量一律写 ${VAR}：macOS 的 bash 3.2 会把紧跟其后的全角括号首字节
    # 当成变量名的一部分，于是 "（$TODAY）" 报 TODAY<乱码>: unbound variable。
    echo "提示：slug 的日期段 ${SLUG_DATE} 不是今天（${TODAY}）。约定上它是**建档日期**；" >&2
    echo "      需求/变更的原始日期请写进 meta.title 或 --related，按日期检索任务才不会错位。" >&2
  fi
fi

case "$TIER" in
  S | M | L | XL) ;;
  *)
    echo "flow-tier 只能是 S/M/L/XL，收到：$TIER" >&2
    exit 64
    ;;
esac

case "$TYPE" in
  feature | change | bugfix) ;;
  *)
    echo "--type 只能是 feature/change/bugfix，收到：$TYPE" >&2
    exit 64
    ;;
esac

# 关联任务两种形态（task-loop 剖面 B / 评审 M2）：
#   仓库内 slug：^[a-z0-9][a-z0-9-]{0,63}$——会被拼进路径，存在性必须验证；
#   外部来源：^[a-z][a-z0-9-]*:[A-Za-z0-9._/-]{1,64}$（如 feishu:7161559257）——
#     飞书单不在仓库里，追溯锚走 state.meta.remote_id（双向锚），格式校验替代存在性校验。
RELATED_IS_EXT=0
if [ -n "$RELATED" ]; then
  if printf '%s' "$RELATED" | grep -Eq '^[a-z][a-z0-9-]*:[A-Za-z0-9._/-]{1,64}$'; then
    RELATED_IS_EXT=1
  elif ! printf '%s' "$RELATED" | grep -Eq '^[a-z0-9][a-z0-9-]{0,63}$'; then
    echo "--related 只允许仓库内 slug（小写字母/数字/连字符）或外部来源（feishu:<单号> 等），收到：$RELATED" >&2
    exit 64
  fi
fi

# change/bugfix 必须挂到已有任务上：没有关联的变更是无法追溯的，
# 而"关联一个不存在的任务"和"没填"一样不可审计，宁可建档时就被打回。
# 外部来源跳过存在性检查（它锚在 remote_id，不在 .ai/tasks/ 里），但只对 change/bugfix 开放。
case "$TYPE" in
  change | bugfix)
    [ -n "$RELATED" ] || { echo "--type $TYPE 必须用 --related 指定关联任务（原任务或发现来源）" >&2; exit 64; }
    if [ "$RELATED_IS_EXT" -eq 0 ]; then
      [ -f ".ai/tasks/${RELATED}/state.json" ] || {
        echo "关联任务不存在：.ai/tasks/${RELATED}/state.json（--related 必须指向本仓库已有任务，或用 feishu:<单号> 外部来源）" >&2
        exit 64
      }
    fi
    ;;
  *)
    if [ "$RELATED_IS_EXT" -eq 1 ]; then
      # ${RELATED} 必须带花括号：macOS bash 3.2 对多字节字符（全角括号）后的 $VAR
      # 解析有 bug，会把中文字符的尾字节当变量名首字符（实测 unbound variable）
      echo "外部来源 --related（${RELATED}）只用于 change/bugfix，feature 不接受" >&2
      exit 64
    fi
    ;;
esac

# change 必须锚定需求基线，且只收 git commit hash：RS 是活文档，
# "v1.2" 这类修订号机器验证不了，等于没锚。hash 在 git 历史里可复现地存在或不存在。
if [ "$TYPE" = "change" ]; then
  [ -n "$BASELINE" ] || { echo "--type change 必须用 --baseline 锚定需求基线（git commit hash）" >&2; exit 64; }
  if ! printf '%s' "$BASELINE" | grep -Eq '^[0-9a-f]{7,40}$'; then
    echo "--baseline 必须是 7-40 位 git commit hash（git rev-parse HEAD 可取），收到：$BASELINE" >&2
    exit 64
  fi
  # 直接是本仓库根时顺带验证 commit 存在，尽早暴露打错的 hash。
  # 用 rev-parse --git-dir 而不是 [ -d .git ]：worktree / submodule 里 .git 是文件，
  # 用 -d 判断会静默跳过这层校验（而它正是"打错的 hash 当场暴露"的唯一机会）。
  if git rev-parse --git-dir >/dev/null 2>&1 && ! git cat-file -e "${BASELINE}^{commit}" 2>/dev/null; then
    echo "--baseline commit 在仓库历史里不存在：$BASELINE" >&2
    exit 64
  fi
fi

# feature 带上 change/bugfix 的专属参数多半是开关拼错，拒绝而不是忽略。
if [ "$TYPE" = "feature" ] && { [ -n "$RELATED" ] || [ -n "$BASELINE" ]; }; then
  echo "--type feature 不接受 --related/--baseline（要挂关联请用 --type change 或 bugfix）" >&2
  exit 64
fi

if [ -f "${DIR}/state.json" ]; then
  echo "已存在：${DIR}/state.json（不覆盖，避免抹掉进度）" >&2
  exit 0
fi

TRUST="$(cfg trustLevel)"
TRUST="${TRUST:-L1}"

mkdir -p "$DIR" .ai/verify .ai/locks

# state.json 用 node 序列化而不是 heredoc 拼接：字符串值必须 JSON.stringify，
# 手拼模板串是非法 JSON 与字段注入的共同源头。
node -e '
  const fs = require("fs");
  const [slug, tier, trust, type, related, baseline] = process.argv.slice(1);
  // 外部来源（feishu:7161559257）：related_task 保留原串（人可读），
  // remote_id 拆出系统与单号——收尾回写按它找平台上的实例（task-loop 剖面 B 的双向锚）。
  const mExt = related ? /^([a-z][a-z0-9-]*):([A-Za-z0-9._/-]{1,64})$/.exec(related) : null;
  const state = {
    meta: {
      schema_version: 1,
      task: slug,
      task_type: type,
      related_task: related || null,
      // 外部来源锚：source=系统前缀，id=单号。仓库内关联时为 null（锚就是 .ai/tasks/<slug>）。
      remote_id: mExt ? { source: mExt[1], id: mExt[2] } : null,
      baseline: baseline || null,
      affected_ids: type === "change" || type === "bugfix" ? [] : null,
      change_tier: null,
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      flow_tier: tier,
      init_flow_tier: tier, // 建档存底（复审抓回）：checkStage 比对两者，中途改档即拦
      risk_tier: "MEDIUM",
      ui_scope: "NONE",
      trust_level: trust,
    },
    // 起始阶段必须落在 hooks/lib/verify.mjs 的 STAGE_CHAIN 上。
    // 这里曾写 "intake"——一个不在链上的名字，新任务从第一天起就站在状态机之外：
    // resume 认不出下一阶段，ci-verify 也只判 todos 不判 stage，拼错的阶段名照样绿。
    stage: "rs",
    stage_history: [],
    artifacts: {},
    todos: [],
    blockers: [],
    // 这两个字段是收口判据（checkStageExit）：偏离没有处置、已知问题没有结论，
    // stage=done 会被拦。空数组就是"确实没有"，别省略键——省掉的键和"没想到"没法区分。
    deviations: [],
    known_issues: [],
    gate_result: { last_check: null, stage: null, checks: [] },
  };
  fs.writeFileSync(`.ai/tasks/${slug}/state.json`, JSON.stringify(state, null, 2) + "\n");
' "$SLUG" "$TIER" "$TRUST" "$TYPE" "$RELATED" "$BASELINE"

echo "OK  ${DIR}/state.json  (tier=${TIER} type=${TYPE})"
case "$TYPE" in
  change)
    echo "变更任务：只更新受影响内容并把影响链补齐（受影响 RS/FS → TODO → 测试）。"
    echo "定档影响范围后在 meta.change_tier 写 1|2|3，逐条填 meta.affected_ids。"
    ;;
  bugfix)
    echo "修复任务：先补能复现问题的回归测试（TODO 标 kind=\"regression\"），再修，再验证。"
    echo "受影响模块填 meta.affected_ids。"
    ;;
  *)
    echo "下一步：让 orchestrator 定档并调度，或直接 /rs 产出需求规格。"
    ;;
esac
