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
import { validateTodos, formatFailures, readStdinJson } from './lib/verify.mjs';

// HARNESS_ROOT 只给自测与 vendored 安装用：hook 跑在 CLI 起的进程里，
// agent 无法通过自己执行的命令改它（Bash 改不了父进程环境）。
// 门禁判据本身不依赖这个变量，它只决定"相对谁算路径"。
const ROOT = process.env.HARNESS_ROOT
  ? resolve(process.env.HARNESS_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'create_file']);
const STATE_RE = /^\.ai\/tasks\/[^/]+\/state\.json$/;

function block(msg) {
  console.error(`[guard_state] BLOCK\n${msg}`);
  process.exit(2);
}

/** 从工具入参推出"写完之后文件长什么样"。推不出来就返回 null。 */
function prospectiveContent(tool, input, abs) {
  if (typeof input.content === 'string' && tool === 'Write') return input.content;

  const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;

  if (tool === 'Edit') {
    if (current === null) return null;
    const oldStr = String(input.old_string ?? '');
    const newStr = String(input.new_string ?? '');
    if (!oldStr || !current.includes(oldStr)) return null;
    return input.replace_all
      ? current.split(oldStr).join(newStr)
      : current.replace(oldStr, newStr);
  }

  if (tool === 'MultiEdit') {
    if (current === null) return null;
    let text = current;
    for (const e of input.edits || []) {
      const oldStr = String(e.old_string ?? '');
      if (!oldStr || !text.includes(oldStr)) return null;
      text = e.replace_all ? text.split(oldStr).join(String(e.new_string ?? '')) : text.replace(oldStr, String(e.new_string ?? ''));
    }
    return text;
  }

  return null;
}

const payload = readStdinJson();
if (payload === null) block('无法解析 hook 输入（stdin 不是合法 JSON）。按 fail-closed 处理。');

const tool = payload.tool_name || '';
if (!WRITE_TOOLS.has(tool)) process.exit(0);

const input = payload.tool_input || {};
const target = String(input.file_path || input.path || '');
if (!target) process.exit(0);

const abs = isAbsolute(target) ? target : resolve(ROOT, target);
const rel = relative(ROOT, abs).split('\\').join('/');
if (!STATE_RE.test(rel)) process.exit(0);

const text = prospectiveContent(tool, input, abs);
if (text === null) {
  block(
    `无法从这次 ${tool} 推出 ${rel} 的写入结果（old_string 没命中，或文件不存在）。\n` +
      'state.json 是进度唯一事实源，改不动就别声称改过了：重新读取当前内容后再编辑。'
  );
}

let state;
try {
  state = JSON.parse(text);
} catch (err) {
  block(`${rel} 写完之后不是合法 JSON：${err.message}\nJSON 坏了，接手的下一个人（或 agent）会直接读不到进度。`);
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
  failures = validateTodos(todos || [], ROOT, { mode: 'local' });
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
