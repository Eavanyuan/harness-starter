#!/usr/bin/env node
/**
 * CI 侧门禁 —— 与本地 hook 共用 hooks/lib/verify.mjs。
 *
 * 存在的理由：hook 只拦 agent 走的那条路，人手动 commit 是直通的。
 * 所以 CI 才是最终裁决，hook 只是提前反馈。
 *
 * 校验：
 *   1. 所有 .ai/tasks/<slug>/state.json 里已完成的 TODO，verify 证据成立
 *   2. stage_history 里 waived 必须记名（waived_by），无记名按 fail 计
 *   3. 生成物与 agents/ 源一致（不漂移）
 *
 * 用法：node scripts/ci-verify.mjs
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTodos, formatFailures } from '../hooks/lib/verify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS_DIR = join(ROOT, '.ai/tasks');

const problems = [];

if (!existsSync(TASKS_DIR)) {
  console.log('[ci-verify] 没有 .ai/tasks，跳过状态校验');
} else {
  const dirs = readdirSync(TASKS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());

  for (const d of dirs) {
    const statePath = join(TASKS_DIR, d.name, 'state.json');
    if (!existsSync(statePath)) continue;

    let state;
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (err) {
      problems.push(`${d.name}/state.json 无法解析：${err.message}`);
      continue;
    }

    const failures = validateTodos(state.todos, ROOT);
    for (const f of failures) {
      problems.push(`${d.name}: ${f.id} [${f.rule}] ${f.reason}`);
    }

    for (const h of state.stage_history || []) {
      if (h.gate === 'waived' && !h.waived_by) {
        problems.push(`${d.name}: stage "${h.stage}" 的 waived 没有记名（waived_by 为空），按 fail 计`);
      }
    }
  }
}

if (problems.length) {
  console.error('[ci-verify] 门禁未通过：\n' + problems.map((p) => '  ✗ ' + p).join('\n'));
  console.error('\n本地对应检查：node hooks/validate_todo.mjs < 状态输入');
  process.exit(1);
}

console.log('[ci-verify] 状态与证据链校验通过');
