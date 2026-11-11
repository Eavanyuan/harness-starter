/** detect —— 栈 / CI 平台 / 多构建根探测摘要（只读）。 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { survey, needsStackDir } from './shared.mjs';

export function cmdDetect(target, json) {
  const sv = survey(target);
  const ci = existsSync(join(target, '.gitlab-ci.yml')) ? 'gitlab' : existsSync(join(target, '.github')) ? 'github' : 'none';
  const notes = [];
  if (!sv.roots.length) notes.push('未识别到构建清单：stacks 需要手填（harness.config.json）');
  if (needsStackDir(sv)) {
    notes.push(`v1 只支持单主栈（stacks 按 id 命名，同名栈只能有一个）：检测到 ${sv.roots.length} 个构建根${sv.duplicateIds.length ? `，且栈 id 撞车（${sv.duplicateIds.join('、')}）` : ''} —— 用 init --stack-dir <dir> 选主栈，其余标 unsupported`);
  }
  // 同名栈只提示一次并带目录清单（TDasset 实测：12 个 Go + 4 个 Python 根刷出 16 条
  // 逐字重复的警告——提示的第一价值是被人读完）。
  const unsupportedById = new Map();
  for (const s of sv.stacks.filter((x) => !x.supported)) {
    if (!unsupportedById.has(s.id)) unsupportedById.set(s.id, { lang: s.lang, dirs: [] });
    unsupportedById.get(s.id).dirs.push(s.dir);
  }
  for (const { lang, dirs } of unsupportedById.values()) {
    notes.push(`${lang}（${dirs.length} 个构建根：${dirs.slice(0, 6).join('、')}${dirs.length > 6 ? ' 等' : ''}）：v1 不生成命令，stacks 需手填`);
  }
  if (ci === 'gitlab') notes.push('CI 是 GitLab：quality-gate 的步骤需镜像进 .gitlab-ci.yml（工具不做，方案红线三）');

  const result = {
    target,
    buildRoots: sv.roots,
    stacks: sv.stacks,
    ci,
    needStackDir: needsStackDir(sv),
    notes,
  };
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`[harness] detect ${target}`);
  for (const s of sv.stacks) {
    console.log(`  栈 ${s.id.padEnd(13)} ${s.lang.padEnd(20)} dir=${s.dir.padEnd(16)} ${s.supported ? `test: ${s.test || '—（留空，见下）'}` : 'unsupported（不生成命令）'}`);
    for (const w of s.warnings || []) notes.push(`${s.id}（${s.dir}）：${w}`);
  }
  console.log(`  CI 平台 ${ci}`);
  for (const n of notes) console.log(`  ! ${n}`);
}
