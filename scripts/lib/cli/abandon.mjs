/**
 * 封存（abandon）：明确写下"这个任务不再续跑"，以及为什么。
 *
 * 为什么必须有这个动作，而不是让人手改 state.json：
 *   1. **3 天规则要成为机器判据，前提是有一条便宜的出口**。doctor 一旦把停滞判成红，
 *      没有一条命令能把红变成绿的话，人学会的只会是忽略红灯——那比没判据更糟。
 *   2. 手改 state.json 会绕过 guard_state；而这一改动的全部价值就在于**留下理由**。
 *
 * 语义边界（一句话容易写歪，所以写死在这里）：abandoned = 不再续跑，**不是**工作没做。
 * 对账补登记类的任务（产物早已交付、只是补一张记录）用它封存，理由里写清产物在哪。
 * 它豁免"必须做完"的判据（TODO 收尾、产物登记），不豁免"做过就得有证据"。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { die, writeAtomic, nowIso } from './shared.mjs';
import { migrate, isAbandoned } from '../../../hooks/lib/verify.mjs';

export function cmdAbandon(target, slug, opts) {
  if (!slug) die('usage: harness-cli.mjs abandon <target> <slug> --reason "<为什么不再续跑>" [--by <人>]', 64);
  // slug 会拼进写入路径：`../x` 能改到别的任务的 state.json（verify-run 的 todo-id
  // 踩过同一个坑）。这里要写文件，比那边更该先关门。
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) || slug.includes('..')) {
    die(`slug 只接受字母数字与 . _ -（收到 "${slug}"）：它会拼进写入路径`, 64);
  }

  // 理由不能是占位符。一个空理由的封存与"把这个任务删了"在事后完全无法区分，
  // 而这套东西的全部意义就在于事后还能问出"当时为什么停"。
  const reason = String(opts.reason || '').trim();
  if (!reason) die('封存必须带 --reason：没有理由的封存等于静默删除，事后没人知道这任务为什么停', 64);
  if (reason.length < 8) die(`--reason 太短（"${reason}"）：写清为什么停、产物在哪，至少 8 个字`, 64);
  if (/^(todo|tbd|无|没有|none|n\/a|-+)$/i.test(reason)) die(`--reason 是占位符（"${reason}"），等于没写`, 64);

  const statePath = join(target, '.ai/tasks', slug, 'state.json');
  if (!existsSync(statePath)) die(`任务不存在：${statePath}`, 64);
  let state;
  try {
    state = migrate(JSON.parse(readFileSync(statePath, 'utf8'))).state;
  } catch (e) {
    die(`${statePath} 不是合法 JSON 或 schema 不可迁移：${e.message}（先修文件）`, 64);
  }

  if (state.stage === 'done') die(`${slug} 已经 stage=done —— 走完流程的任务不需要封存（封存是给"不再往下走"用的）`, 3);
  if (isAbandoned(state)) {
    const prev = state.meta.abandoned || {};
    die(`${slug} 已经是 abandoned（${prev.at || '?'} ${prev.by || '?'}：${prev.reason || '?'}）—— 要改理由就手改 meta.abandoned.reason，不要叠第二条记录`, 3);
  }

  const by = String(opts.by || '').trim()
    || (spawnSync('git', ['config', 'user.name'], { cwd: target, encoding: 'utf8' }).stdout || '').trim()
    || 'unknown';
  const openTodos = (state.todos || [])
    .filter((t) => t.status !== 'completed' && t.status !== 'done')
    .map((t) => t.id || '(无 id)');

  state.meta = state.meta || {};
  state.meta.status = 'abandoned';
  // stage 保留不动：它回答的是"走到哪停的"，而"任务一般死在哪一阶段"是流程该不该减重的证据。
  state.meta.abandoned = { at: nowIso(), by, reason, at_stage: state.stage || null, open_todos: openTodos, todos_total: (state.todos || []).length };

  writeAtomic(statePath, JSON.stringify(state, null, 2) + '\n');

  console.log(`[harness] abandoned  ${slug}`);
  console.log(`  停在    ${state.stage}（保留不覆盖：它是"死在哪一阶段"的证据）`);
  console.log(`  未收尾  ${openTodos.length ? openTodos.join('、') : '无（全部 TODO 已完成，封的是流程不是工作）'}`);
  console.log(`  理由    ${reason}`);
  console.log(`  记名    ${by} @ ${state.meta.abandoned.at}`);
  console.log('\n这是**不再续跑**，不是"工作没做"。产物若已交付，记得在 commit 里带上 state.json。');
  return 0;
}
