#!/usr/bin/env node
/**
 * PreToolUse(Write|Edit|MultiEdit) 门禁 —— fail-closed。
 *
 * 拦的是「把 state.json 写成一份没证据的完成态」。
 *
 * 为什么不挂在 TodoWrite 上（上一版的错误）：
 *   Claude Code / ZCode 的 TodoWrite 入参是 {content, status, priority}，
 *   且 schema 是 strict 的 —— 我们需要的 id / audit / verify / ooda_stage 根本不存在，
 *   模型即使"想"带也带不进来。于是 MANAGED_ID 永远不命中，hook 恒放行，
 *   只在自造 payload 的测试里有效。那是个从来不触发的门。
 *
 * 真正的契约载体是 state.json：orchestrator 用 Write/Edit 落盘，写之前载荷里就有全文，
 * 可以在落盘前判定，失败则这次写入根本不发生。判据与 CI 共用 hooks/lib/verify.mjs，
 * 差别只在 mode：这里在开发者工作树里，mtime 可信，按 local 口径判。
 *
 * 退出码：0 放行；2 阻断（stderr 会回给模型）；其他视为 hook 自身故障。
 * 故障时一律按阻断处理 —— 门禁坏了不能变成放行。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateTodos,
  formatFailures,
  checkStageExit,
  checkTaskTraceability,
  checkStage,
  migrate,
  readStdinJson,
} from './lib/verify.mjs';
import { WRITE_TOOLS, writeTarget, prospectiveContent } from './lib/write_tools.mjs';
import { recordDeny } from './lib/ledger.mjs';

// HARNESS_ROOT 只给自测与 vendored 安装用：hook 跑在 CLI 起的进程里，
// agent 无法通过自己执行的命令改它（Bash 改不了父进程环境）。
// 门禁判据本身不依赖这个变量，它只决定"相对谁算路径"。
const ROOT = process.env.HARNESS_ROOT
  ? resolve(process.env.HARNESS_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STATE_RE = /^\.ai\/tasks\/[^/]+\/state\.json$/;

/** 拦截对象（state 文件相对路径）——ledger 靠它算误拦率，不能只记规则名。 */
let SUBJECT = null;

function block(msg) {
  recordDeny('guard_state', 'block', msg, { root: ROOT, target: SUBJECT });
  console.error(`[guard_state] BLOCK\n${msg}`);
  process.exit(2);
}

const payload = readStdinJson();
if (payload === null) block('无法解析 hook 输入（stdin 不是合法 JSON）。按 fail-closed 处理。');

const tool = payload.tool_name || '';
if (!WRITE_TOOLS.has(tool)) process.exit(0);

const input = payload.tool_input || {};
const target = writeTarget(input);
if (!target) process.exit(0);

const abs = isAbsolute(target) ? target : resolve(ROOT, target);
const rel = relative(ROOT, abs).split('\\').join('/');
if (!STATE_RE.test(rel)) process.exit(0);
SUBJECT = rel;

const text = prospectiveContent(tool, input, abs, (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null));
if (text === null) {
  block(
    `无法从这次 ${tool} 推出 ${rel} 的写入结果（old_string 没命中、文件不存在，或该命令不带可推导的结果）。\n` +
      'state.json 是进度唯一事实源，改不动就别声称改过了：重新读取当前内容后再编辑（Write / Edit / MultiEdit 都可）。'
  );
}

let state;
try {
  state = JSON.parse(text);
} catch (err) {
  block(`${rel} 写完之后不是合法 JSON：${err.message}\nJSON 坏了，接手的下一个人（或 agent）会直接读不到进度。`);
}

// schema 迁移只产出校验视图，不改写落盘内容（方案 §9）；
// 未知版本显式拦下，不给"未来格式的 state"绕过校验的口子（失效点 15）。
try {
  ({ state } = migrate(state));
} catch (err) {
  block(`${rel} ${err.message}`);
}

const todos = state.todos;
if (todos !== undefined && !Array.isArray(todos)) {
  block(`${rel} 的 todos 不是数组。`);
}

for (const t of todos || []) {
  if (t.status === 'completed' && !t.id) {
    block(`${rel} 里有已完成的 TODO 没有 id —— 失败时无法定位，证据日志也无法命名（.ai/verify/<id>.log）。`);
  }
}

const ids = (todos || []).map((t) => t.id).filter(Boolean);
const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dup.length) block(`${rel} 里 id 重复：${[...new Set(dup)].join(', ')}（证据会互相覆盖）`);

let failures;
try {
  // checkStage：阶段名/档位必须在枚举内，跳阶必须记名（不在链上的 stage 会让所有按阶段的判据静默跳过）。
  // checkStageExit：stage=done 却留未收尾的 TODO，与"没证据的完成态"同罪，落盘前拦下。
  // checkTaskTraceability：change/bugfix 的追溯字段（同一判据库，失效点 7）。
  //
  // 注意**不**包含"impl 阶段 TODO 必须全收尾"：那是**退出**条件，不是写入条件。
  // impl 进行中当然有 pending/doing，写一次进度就被拦，等于让人不敢记状态。
  // 退出条件只在 resume 推进时判（checkStageTodoClosure）。
  failures = checkStage(state)
    .concat(validateTodos(todos || [], ROOT, { mode: 'local' }))
    .concat(checkStageExit(state))
    .concat(checkTaskTraceability(state, ROOT));
} catch (err) {
  block(`校验过程异常：${err.message}\n按 fail-closed 处理，请修 hook 或 state 后重试。`);
}

if (failures.length) {
  block(
    `以下 TODO 不能标为完成：\n${formatFailures(failures)}\n\n` +
      '修复方式：真的跑一次验证并写入 .ai/verify/<todo-id>.log（scripts/verify-run.sh），' +
      '补齐审计四项与 ooda_stage，然后重新提交状态。\n' +
      '不要通过删除 verify 字段或改 status 枚举来绕过——CI 侧同样会判。'
  );
}

process.exit(0);
