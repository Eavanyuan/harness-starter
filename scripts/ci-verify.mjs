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
 *   2. stage_history 里 waived 必须记名（waived_by），无记名按 fail 计
 *
 * 用法：
 *   node scripts/ci-verify.mjs                 # CI 口径，扫全部 state
 *   node scripts/ci-verify.mjs --local         # 本地口径，额外判新鲜度
 *   node scripts/ci-verify.mjs --file <path>   # 只校验一份 state（写入门禁/人工复查）
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTodos, formatFailures, loadConfig } from '../hooks/lib/verify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS_DIR = join(ROOT, '.ai/tasks');

const argv = process.argv.slice(2);
const mode = argv.includes('--local') ? 'local' : 'ci';
const fileAt = argv.indexOf('--file');
const onlyFile = fileAt >= 0 ? argv[fileAt + 1] : null;

const config = loadConfig(ROOT) || {};
const problems = [];

function report(statePath, name) {
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (err) {
    problems.push(`${name} 无法解析：${err.message}`);
    return;
  }

  for (const f of validateTodos(state.todos, ROOT, { mode, config })) {
    problems.push(`${name}: ${f.id} [${f.rule}] ${f.reason}`);
  }

  for (const h of state.stage_history || []) {
    if (h.gate === 'waived' && !h.waived_by) {
      problems.push(`${name}: stage "${h.stage}" 的 waived 没有记名（waived_by 为空），按 fail 计`);
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
  for (const d of readdirSync(TASKS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const statePath = join(TASKS_DIR, d.name, 'state.json');
    if (!existsSync(statePath)) continue;
    report(statePath, d.name);
  }
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
