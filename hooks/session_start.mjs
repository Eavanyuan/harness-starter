#!/usr/bin/env node
/**
 * SessionStart 提醒 —— fail-open。
 *
 * 上下文压缩或换人接手后，最容易丢的不是代码，而是"现在推进到哪了"。
 * 这里输出两行摘要，不阻塞、不报错：
 *   1. 当前模型落在哪个 scaffold 档（modelTiers 的真实消费者）
 *   2. 进行中的任务与卡点数
 *
 * 为什么要打印 scaffold 档：modelTiers 长期没有任何代码读它，文档却在宣传"定义分层"。
 * 配置不生效比配置不存在更糟——它让"强模型豁免脚手架"变成一句口头承诺。
 * 现在每次会话把档位摆出来，模型和人看到的是同一句话。
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, loadConfig } from './lib/verify.mjs';

const TASKS = join(REPO_ROOT, '.ai/tasks');

/** `claude-*` 这类前缀通配，够用即可，不引入 glob 库。 */
function matches(pattern, value) {
  if (!pattern || !value) return false;
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(value);
}

function scaffoldLine() {
  const config = loadConfig(REPO_ROOT);
  if (!config) return null;
  const model = process.env.HARNESS_MODEL || process.env.ZCODE_MODEL || process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || '';
  const tiers = config.modelTiers || [];
  if (!tiers.length) return null;

  const tier = tiers.find((t) => (t.agents || []).some((p) => matches(p, model)));
  if (!model) {
    const fallback = tiers.find((t) => t.scaffold === 'full') || tiers[0];
    return `[harness] 未识别模型（设 HARNESS_MODEL 可判档）→ scaffold=${fallback.scaffold}`;
  }
  if (!tier) return `[harness] 模型 ${model} 不在任何 modelTiers 里 → 按常规档 scaffold=full`;
  return `[harness] 模型 ${model} → scaffold=${tier.scaffold}（${tier.label || tier.id}）`;
}

try {
  const line = scaffoldLine();
  if (line) console.log(line);

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
