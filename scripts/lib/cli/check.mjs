/** check —— 运行时前提探测（node / bash / git / 构建根 / promotionDir 覆盖）。 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATE, die, survey, needsStackDir, preflight, printPreflight } from './shared.mjs';

export function cmdCheck(target) {
  const pf = preflight(target);
  printPreflight(pf);
  // 路径不存在时"前提齐备"是假绿灯：探测到的是一个空集合，不是项目。
  const exists = existsSync(target);
  if (!exists) console.log(`\n[harness] 目标不存在：${target}（拼错路径？init 会创建它）`);
  const sv = survey(target);
  console.log(`\n[harness] 构建根：${sv.roots.length ? sv.roots.map((r) => `${r.dir}（${r.manifests.join('+')}）`).join('、') : '（无构建清单）'}`);
  for (const s of sv.stacks) console.log(`  栈 ${s.id.padEnd(13)} ${s.lang.padEnd(20)} dir=${s.dir}${s.supported ? '' : '（unsupported：v1 不生成命令）'}`);
  if (needsStackDir(sv)) {
    console.log(`  ! ${sv.roots.length} 个构建根${sv.duplicateIds.length ? `、栈 id 撞车（${sv.duplicateIds.join('、')}）` : ''} —— stacks 按 id 命名，同名栈只能有一个：用 init --stack-dir 选主栈，其余标 unsupported`);
  }
  const hard = [];
  if (!pf.node.ok) hard.push('Node < 18');
  if (!pf.bash.ok) hard.push('bash 缺失');
  if (hard.length) {
    console.log(`\n结论：${hard.join('、')} —— 只读探测可继续，init 会被拒绝（这是硬依赖，不是建议）。`);
    return 1;
  }
  // promotionDir 必须落在某个 agent 的 writes 里，否则"FS 定稿移至 docs/plans/"
  // 是句谁也执行不了的话——真实项目就卡在过这里：orchestrator 只写 .ai/tasks/**，
  // 定稿那一步没有任何角色有权限，流程在这一环静默断掉。
  const promo = promotionGap(target);
  if (promo) console.log(`\n  ! ${promo}`);
  console.log(`\n结论：硬前提齐备${pf.git.ok ? '' : '（git 缺失：change 基线校验降级）'}。`);
  return 0;
}

/** 定稿目录的覆盖检查：读已装好的 .ai/writes.json，没有则读模板里的 agent 定义。 */
function promotionGap(target) {
  const cfg = readConfigJson(target) || readConfigJson(TEMPLATE) || {};
  const dir = (cfg.promotionDir || 'docs/plans').replace(/\/+$/, '');
  const writes = [];
  const installed = join(target, '.ai/writes.json');
  if (existsSync(installed)) {
    try {
      const w = JSON.parse(readFileSync(installed, 'utf8'));
      for (const a of Object.values(w.agents || {})) writes.push(...(a.writes || []));
    } catch { /* 投影坏了另有 CI diff 兜底，这里不重复报 */ }
  }
  if (!writes.length) {
    const dirPath = join(TEMPLATE, 'agents');
    if (existsSync(dirPath)) {
      for (const f of readdirSync(dirPath)) {
        if (!f.endsWith('.agent.md')) continue;
        const m = readFileSync(join(dirPath, f), 'utf8').match(/^writes:\s*(\[.*\])\s*$/m);
        if (!m) continue;
        try { writes.push(...JSON.parse(m[1])); } catch { /* 解析不了就当没声明 */ }
      }
    }
  }
  if (!writes.length) return null;
  const covered = writes.some((g) => {
    const g2 = String(g).replace(/\/+$/, '');
    return g2 === dir || g2 === `${dir}/**` || g2.startsWith(dir + '/');
  });
  return covered
    ? null
    : `promotionDir=${dir} 不在任何 agent 的 writes 里 —— 定稿无处落盘，流程会卡在"移至 ${dir}"这一步（给 orchestrator 的 writes 加上 ${dir}/**）`;
}

function readConfigJson(root) {
  try { return JSON.parse(readFileSync(join(root, 'harness.config.json'), 'utf8')); } catch { return null; }
}
