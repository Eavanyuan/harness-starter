#!/usr/bin/env node
/**
 * PreToolUse(TodoWrite) 门禁 —— fail-closed。
 *
 * 拦住三件事：
 *   1. 审计四项没填就标完成
 *   2. OODA 跳阶段（直接从 act 收尾）
 *   3. verify 证据不成立（日志缺失 / 非 0 / 早于源码）
 *
 * 只校验「工程 TODO」（id 形如 T1 / V2）。普通清单项不管，
 * 否则每加一个 todo 都被拦，会话会卡死。
 *
 * 退出码：0 放行；2 阻断（stderr 会回给模型）；其他视为 hook 自身故障。
 * 故障时一律按阻断处理 —— 门禁坏了不能变成放行。
 */
import { validateTodos, formatFailures, readStdinJson, repoRoot } from './lib/verify.mjs';

const MANAGED_ID = /^[TV]\d+$/;

function block(msg) {
  console.error(`[validate_todo] BLOCK\n${msg}`);
  process.exit(2);
}

const payload = readStdinJson();

if (payload === null) {
  if (!process.stdin.isTTY && process.env.HARNESS_ALLOW_EMPTY_STDIN === '1') {
    process.exit(0);
  }
  block('无法解析 hook 输入（stdin 不是合法 JSON）。按 fail-closed 处理。');
}

const toolName = payload.tool_name || '';
if (toolName && toolName !== 'TodoWrite') {
  process.exit(0);
}

const todos = payload.tool_input?.todos;
if (!Array.isArray(todos)) {
  block('TodoWrite 输入里没有 todos 数组。');
}

const managed = todos.filter((t) => MANAGED_ID.test(String(t.id || '')));
if (managed.length === 0) {
  process.exit(0);
}

let failures;
try {
  failures = validateTodos(managed, repoRoot());
} catch (err) {
  block(`校验过程异常：${err.message}\n按 fail-closed 处理，请修 hook 或 state 后重试。`);
}

if (failures.length) {
  block(
    `以下 TODO 不能标为完成：\n${formatFailures(failures)}\n\n` +
      '修复方式：真的跑一次验证并写入 .ai/verify/<todo-id>.log（scripts/verify-run.sh），' +
      '补齐审计四项与 ooda_stage，然后重新提交状态。\n' +
      '不要通过删除 verify 字段或改 status 枚举来绕过。'
  );
}

process.exit(0);
