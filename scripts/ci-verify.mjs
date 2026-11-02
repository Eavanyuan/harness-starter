#!/usr/bin/env node
/**
 * 状态与证据链门禁 —— 与本地 hook 共用 hooks/lib/verify.mjs。
 *
 * 存在的理由：hook 只拦 agent 走的那条路，人手动 commit 是直通的。
 * 所以 CI 才是最终裁决，hook 只是提前反馈。
 *
 * 默认按 **ci 口径** 判：git 不保存 mtime，在全新 checkout 上判"日志是否晚于源码"
 * 只会把合规 PR 判红。CI 侧只认 git 里可复现的事实（文件在不在、日志进没入库）。
 * 需要严格口径（工作树里判新鲜度）时加 --local。
 *
 * 校验：
 *   1. 所有 .ai/tasks/<slug>/state.json 里已完成 TODO 的证据链成立
 *      （status 枚举先闭合：拼错的状态判失败，不静默跳过）
 *   2. stage=done 的退出条件：所有 TODO 必须收尾
 *   3. stage_history 里 waived 必须记名（waived_by），无记名按 fail 计
 *   4. change/bugfix 的追溯链（机器可判子集）：related/baseline/affected_ids/回归 TODO
 *   5. RS / FS / WBS 的完备性（占位符残留、章节空、覆盖率、悬空任务）——
 *      自带阶段门槛，只在"已越过产出阶段"之后判
 *
 * 用法：
 *   node scripts/ci-verify.mjs                 # CI 口径，扫全部 state
 *   node scripts/ci-verify.mjs --local         # 本地口径，额外判新鲜度
 *   node scripts/ci-verify.mjs --file <path>   # 只校验一份 state（写入门禁/人工复查）
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateTodos,
  checkStageExit,
  checkTaskTraceability,
  checkStage,
  checkCompleteness,
  missingDeclarations,
  stageGate,
  gitStatusEntries,
  loadConfig,
  migrate,
} from '../hooks/lib/verify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS_DIR = join(ROOT, '.ai/tasks');

const argv = process.argv.slice(2);
// flag 白名单：拼错（--lcoal）或漏值（--file 后面没东西）必须报错。
// 静默降级成"全量扫描 / ci 口径"会给出一个看起来通过的绿灯，而校验其实没按你以为的口径跑——
// 这正是本仓库 checklist §16「枚举不闭合」的形态。
let mode = 'ci';
let onlyFile = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--local') mode = 'local';
  else if (a === '--file') {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) {
      console.error('[ci-verify] --file 需要一个 state 文件路径');
      process.exit(64);
    }
    onlyFile = v;
    i++;
  } else {
    console.error(`[ci-verify] 未知参数：${a}`);
    console.error('用法：node scripts/ci-verify.mjs [--local] [--file <state.json>]');
    process.exit(64);
  }
}

const config = loadConfig(ROOT) || {};
const problems = [];
/** 提示不判死：WIP 阶段门禁没跑完是正常的，CI 不该把半成品提交判红。 */
const notices = [];

function report(statePath, name) {
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (err) {
    problems.push(`${name} 无法解析：${err.message}`);
    return;
  }

  // 与 guard_state 同一条迁移链（失效点 7：两边必须共用判据）；
  // 未知 schema 版本显式报错，不让未来格式的 state 静默绕过校验。
  try {
    ({ state } = migrate(state));
  } catch (err) {
    problems.push(`${name}: [schema] ${err.message}`);
    return;
  }

  // "impl 里还有未完成的 TODO"不能进 CI 判据：WIP 提交是常态，判死只会让 CI 变噪音。
  // 它只在 resume 推进时作为前置（checkStageTodoClosure）。
  //
  // checkCompleteness：文档完备性。它自带阶段门槛（越过产出阶段才判），所以 WIP 提交
  // 不会因为"FS 还只写了一半"变红——那时 stage 还停在产出阶段本身。
  for (const f of checkStage(state)
    .concat(validateTodos(state.todos, ROOT, { mode, config }))
    .concat(checkStageExit(state))
    .concat(checkTaskTraceability(state, ROOT))
    .concat(checkCompleteness(state, ROOT))) {
    problems.push(`${name}: ${f.id} [${f.rule}] ${f.reason}`);
  }

  // 检查范围由 artifacts 声明决定。没声明就检不到，这件事必须可见——
  // 否则"完备性通过"会被读成"文档没问题"，而实际上一个字节都没看。
  const undeclared = missingDeclarations(state);
  if (undeclared.length) {
    notices.push(
      `${name}: 阶段 ${state.stage} 已越过产出阶段，但 artifacts 里没登记 ${undeclared.map((d) => d.label).join('、')} —— 完备性检查覆盖不到未声明的产物（S 档可写 meta.no_doc_reason 说明为什么不需要文档）`
    );
  }

  // 门禁结论：CI 只判**记下来的失败**，不要求"必须有一份记录"。
  //
  // 为什么不要求：要求 done 必须有 gate_result，最省事的满足方式是手写
  // `checks:[{"pass":true}]`——于是它变成了"把声明当门禁"（§15），而且存量
  // 关联任务/桩任务会集体变红。机器只能判"你记了失败却当成功交付"，
  // 判不了"你根本没评估"。后者归人审，不在这里假装判。
  const gate = stageGate(state);
  if (gate.evaluated && gate.failed.length) {
    const msg = (c) => `${name}: [gate] ${state.stage === 'done' ? '完成态' : '本阶段'}门禁项 ${(c && c.name) || '?'} 记的是未通过`;
    for (const c of gate.failed) {
      if (state.stage === 'done') problems.push(msg(c));
      else notices.push(msg(c));
    }
  } else if (!gate.evaluated) {
    notices.push(`${name}: ${gate.reason}`);
  }

  // #20（实测：gate_result 停在 adr、stage 已到 impl，"能不能推进"没有输入）：
  // 过期的门禁结论在 CI 口径判红——上一阶段的 pass 冒充本阶段的评估，比没记录更误导。
  // local 口径维持提示：本地 WIP 阶段（进阶段后门禁还没跑）是常态。
  if (state.gate_result && state.gate_result.stage && state.gate_result.stage !== state.stage) {
    const msg = `${name}: gate_result 记的是 ${state.gate_result.stage} 阶段，当前在 ${state.stage} —— 换阶段后门禁必须重新评估，旧结论不能顺延`;
    if (mode === 'ci') problems.push(msg);
    else notices.push(msg);
  }

  for (const h of state.stage_history || []) {
    // deferred（实测引入：范围裁决后推迟，如"仅出实现计划"）与 waived 同律：必须记名。
    if ((h.gate === 'waived' || h.gate === 'deferred') && !h.waived_by) {
      problems.push(`${name}: stage "${h.stage}" 的 ${h.gate} 没有记名（waived_by 为空），按 fail 计`);
    }
  }
}

if (onlyFile) {
  const p = resolve(ROOT, onlyFile);
  if (!existsSync(p)) {
    console.error(`[ci-verify] 文件不存在：${onlyFile}`);
    process.exit(2);
  }
  report(p, onlyFile);
} else if (!existsSync(TASKS_DIR)) {
  console.log('[ci-verify] 没有 .ai/tasks，跳过状态校验');
} else {
  const declared = new Set();
  const statePaths = [];
  for (const d of readdirSync(TASKS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const statePath = join(TASKS_DIR, d.name, 'state.json');
    if (!existsSync(statePath)) continue;
    statePaths.push(statePath);
    report(statePath, d.name);
    try {
      const state = migrate(JSON.parse(readFileSync(statePath, 'utf8'))).state;
      for (const t of state.todos || []) for (const f of t.files || []) declared.add(f);
    } catch { /* 单文件解析失败已在 report 里报过 */ }
  }

  // #18（实测：surefire 升级影响全员 CI 行为，却不在任何 TODO 的 files 里）：
  // 改动文件若没声明进任何 TODO——基建类（pom/lock/Dockerfile/CI 配置…）直接判红，
  // 其余列出提示（它们不在新鲜度比对的输入里，人要知道）。CI 干净树上天然无信号，
  // 这条在本地/pre-commit/resume 时发威。豁免 harness 安装清单（.harness-manifest.json
  // 登记的文件有自己的来源账）。
  const INFRA_RE = /(^|\/)(pom\.xml|build\.gradle(\.kts)?|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|Makefile|settings\.xml|\.github\/.+|gitlab-ci\.yml)$/;
  const installed = new Set();
  const manifestPath = join(ROOT, '.harness-manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const f of m.files || []) if (f.path) installed.add(f.path);
    } catch { /* 坏 manifest 由 init/doctor 报 */ }
  }
  // 夹具里的 pom.xml / package.json 不是"项目的构建基建"：它们是**被检测的样本**，
  // 改了不影响任何人的构建（harness 自己往目标项目做进 fixtures 就是为了测这种样本）。
  // 判红会让"改一个夹具"变成违规，而这条规则一旦开始误报，下一步就是被整条关掉。
  // 路径不限定 test/ 前缀：真实仓库里夹具常在顶层 fixtures/（TDC 就是）。
  const FIXTURE_RE = /(^|\/)fixtures\//;
  const entries = gitStatusEntries(ROOT).filter((e) => !FIXTURE_RE.test(e.path));
  const isUndeclared = (f) => !declared.has(f) && !installed.has(f);
  // 判据只对 git 已经知道的东西发火（M/A/D/R）；未跟踪（??）只提示。
  // 未跟踪说明"仓库里有东西没入库"，可能是别人留下的半成品或整片产物目录——
  // 拿它当"改动了构建基建"的证据，大仓库里会天天报红，然后人就把它关了。
  const infraUndeclared = entries.filter((e) => INFRA_RE.test(e.path) && isUndeclared(e.path));
  const undeclaredInfra = infraUndeclared.filter((e) => e.status !== '??').map((e) => e.path);
  const untrackedInfra = infraUndeclared.filter((e) => e.status === '??').map((e) => e.path);
  const undeclaredOther = entries
    .filter((e) => !INFRA_RE.test(e.path) && isUndeclared(e.path))
    .map((e) => e.path);
  if (undeclaredInfra.length) {
    problems.push(`改动未声明进任何 TODO 的构建基建文件：${undeclaredInfra.join('、')} —— 影响构建/CI 行为的变更必须显式归属（写进 TODO 的 files，或独立 change 任务），不接受暗层副产物`);
  }
  if (untrackedInfra.length) {
    // 不判红，但也不能静默：未跟踪的基建文件一旦入库就受上面那条管，
    // 现在不提示，等于让它带着"没归属"入土。
    notices.push(
      `${untrackedInfra.length} 个构建基建文件还没入库（${untrackedInfra.slice(0, 5).join('、')}${untrackedInfra.length > 5 ? ' 等' : ''}）—— 未入库不算违规，但入库时必须归属到某个 TODO`
    );
  }
  if (undeclaredOther.length) {
    notices.push(`${undeclaredOther.length} 个改动文件未声明进任何 TODO（新鲜度比对不覆盖它们，收口前补进对应 TODO 的 files）：${undeclaredOther.slice(0, 5).join('、')}${undeclaredOther.length > 5 ? ' 等' : ''}`);
  }
}

if (notices.length) {
  // fail-open 的观测面：给"门禁还没跑"留一条可见的痕迹，但不改变退出码。
  console.log('[ci-verify] 提示（不判失败）：\n' + notices.map((n) => '  ! ' + n).join('\n'));
}

if (problems.length) {
  console.error(
    `[ci-verify] 门禁未通过（口径 ${mode}）：\n` + problems.map((p) => '  ✗ ' + p).join('\n')
  );
  if (mode === 'ci') {
    console.error('\nCI 口径只认 git 事实：日志是否入库、exit_code 是否为 0、声明文件是否存在。');
    console.error('新鲜度（日志晚于源码、72h 时效）只在本地 hook 里判：npm run verify:state -- --local');
  }
  process.exit(1);
}

console.log(`[ci-verify] 状态与证据链校验通过（口径 ${mode}）`);
