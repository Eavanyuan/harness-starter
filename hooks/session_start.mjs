#!/usr/bin/env node
/**
 * SessionStart 提醒 —— fail-open。
 *
 * 上下文压缩或换人接手后，最容易丢的不是代码，而是"现在推进到哪了"。
 * 这里只输出一行摘要，不阻塞、不报错。没有 state 就直接静默退出。
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = join(ROOT, '.ai/tasks');

try {
  if (!existsSync(TASKS)) process.exit(0);

  const states = [];
  for (const d of readdirSync(TASKS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = join(TASKS, d.name, 'state.json');
    if (!existsSync(p)) continue;
    try {
      states.push(JSON.parse(readFileSync(p, 'utf8')));
    } catch {
      states.push({ meta: { task: d.name }, stage: 'unparseable' });
    }
  }

  if (states.length === 0) process.exit(0);

  const doing = states.filter((s) => s.stage && s.stage !== 'done');
  const lines = [];
  for (const s of doing.slice(0, 3)) {
    const todos = s.todos || [];
    const open = todos.filter((t) => t.status !== 'completed' && t.status !== 'done').length;
    const blocked = (s.blockers || []).filter((b) => !b.resolved).length;
    lines.push(
      `· ${s.meta?.task || '?'} — stage=${s.stage} tier=${s.meta?.flow_tier || '?'} 未完成 ${open} 项` +
        (blocked ? ` · ${blocked} 个 blocker 待决` : '')
    );
  }

  if (lines.length) {
    console.log('[harness] 进行中的任务：');
    for (const l of lines) console.log(l);
    console.log('接手前先读对应 state.json；不要凭会话记忆推断进度。');
  }
} catch {
  process.exit(0);
}
