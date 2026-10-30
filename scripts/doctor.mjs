#!/usr/bin/env node
/**
 * 配置体检 —— 照抄脚手架之后的第一步，比 gate 更早发现问题。
 *
 * gate 校验的是"已经配好之后对不对"，doctor 校验的是"配了没有"。
 * 这两类失败长得完全不同：前者是红灯，后者是门禁静默不生效。
 *
 * 本文件自己也被这套 harness 的规则约束：任何"看起来存在、实际不生效"的东西都要报出来。
 * 所以除了占位值与未注册 hook，还检查两件更隐蔽的事：
 *   · 某个 CLI 的 hook 接线是否真的存在（不是"某个 CLI 存在"就够了）
 *   · 配置里每个功能键是否真有代码读它（空转的配置键 = 假门禁）
 *
 * 用法：node scripts/doctor.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warns = [];
const ok = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

let config;
try {
  config = JSON.parse(readFileSync(join(ROOT, 'harness.config.json'), 'utf8'));
} catch (e) {
  console.error(`[doctor] harness.config.json 无法解析：${e.message}`);
  process.exit(1);
}

const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);
const json = (p) => {
  const t = read(p);
  if (t === null) return { exists: false, value: null };
  try {
    return { exists: true, value: JSON.parse(t) };
  } catch (e) {
    return { exists: true, value: null, error: e.message };
  }
};

// 0. 模板态：脚手架刚 clone 下来、还没指向真实项目
const PLACEHOLDER_NAME = 'harness-starter';
const templateMode = (config.project && config.project.name) === PLACEHOLDER_NAME;

// 1. 技术栈目录
const stacks = config.stacks || {};
if (Object.keys(stacks).length === 0) err('stacks 为空 —— coder 不知道该改哪个目录');
let stackMissing = 0;
for (const [name, s] of Object.entries(stacks)) {
  const dir = join(ROOT, s.dir || name);
  if (!existsSync(dir)) {
    stackMissing++;
    if (templateMode) {
      warn(`stacks.${name}.dir="${s.dir}" 还不存在（模板态，预期如此）—— 改成项目真实目录后此提醒消失`);
    } else {
      err(`stacks.${name}.dir="${s.dir}" 不存在 —— 占位值没改成项目真实目录，验证命令会跑空`);
    }
  } else ok.push(`stacks.${name} → ${s.dir}`);
  for (const k of ['lint', 'test', 'testOne']) {
    if (!s[k]) warn(`stacks.${name}.${k} 未配置，验证命令会靠模型猜`);
  }
  if (!s.srcGlob) warn(`stacks.${name}.srcGlob 未配置 —— 证据新鲜度判断会退化成"所有改动文件"`);
}

// 2. hook 接线：按 CLI 逐个查，不是"某个 CLI 注册了就算"
const manifest = json((config.hooks && config.hooks.manifest) || 'hooks/hooks.manifest.json');
const declaredHooks = new Set();
if (!manifest.exists || !manifest.value) {
  err('hooks/hooks.manifest.json 缺失或无法解析 —— 接线没有事实源');
} else {
  for (const groups of Object.values(manifest.value.events || {})) {
    for (const g of groups || []) for (const h of g.hooks || []) if (h.script) declaredHooks.add(h.script);
  }
}

const targets = config.targets || {};
for (const [name, t] of Object.entries(targets)) {
  if (!t.enabled) continue;
  if (!t.hooksFile) {
    warn(`target "${name}" 没有 hook 机制 —— 只有 CI 兜底，文档里不要写"hook 硬拦"`);
    continue;
  }
  const f = json(t.hooksFile);
  if (!f.exists) {
    err(`${t.hooksFile} 不存在 —— ${name} 会话里没有任何 hook（跑 npm run build:hooks）`);
    continue;
  }
  if (f.error) {
    err(`${t.hooksFile} 无法解析：${f.error}`);
    continue;
  }
  const text = read(t.hooksFile) || '';
  const missing = [...declaredHooks].filter((s) => !text.includes(s));
  if (missing.length) {
    err(`${t.hooksFile} 少了 ${missing.length} 个 hook：${missing.join(', ')} —— ${name} 侧门禁不完整`);
  }
  if (name === 'zcode' && f.value.hooks && f.value.hooks.enabled !== true) {
    err(`${t.hooksFile} 的 hooks.enabled 不是 true —— ZCode 默认关闭 hook，写了也不执行`);
  }
  if (!missing.length) ok.push(`${name} hook 接线完整（${declaredHooks.size} 个）`);
}

// 3. hooks/ 下有脚本但没人接线 = 永不执行
const hookDir = join(ROOT, 'hooks');
if (existsSync(hookDir)) {
  for (const f of readdirSync(hookDir).filter((n) => n.endsWith('.mjs'))) {
    if (!declaredHooks.has(`hooks/${f}`)) err(`hooks/${f} 没有被 manifest 引用 —— 它永远不会执行`);
  }
}

// 4. 配置键必须有人消费。空转的键比没有键更糟：文档拿它当承诺。
const codeFiles = [];
for (const dir of ['hooks', 'scripts']) {
  const d = join(ROOT, dir);
  if (!existsSync(d)) continue;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(mjs|sh)$/.test(e.name)) codeFiles.push(full);
    }
  };
  walk(d);
}
const code = codeFiles.map((p) => readFileSync(p, 'utf8')).join('\n');
const CONSUMED = [
  'defaultFlowTier',
  'trustLevel',
  'requireVerifyLog',
  'verifyFreshnessHours',
  'blockedCommands',
  'sensitiveRead',
  'writeGuards',
  'sensitiveExempt',
  'modelTiers',
  'maxLines',
  'requiredSections',
  'extraStacks',
  'capabilityMap',
  'hooksFile',
  'srcGlob',
];
const dead = CONSUMED.filter((k) => !code.includes(k));
if (dead.length) err(`配置键没有任何代码消费（看起来是门禁，实际不生效）：${dead.join(', ')}`);
else ok.push(`配置键均有消费者（${CONSUMED.length} 个）`);

// 5. 门禁代码改动必须有对应测试
const testDir = join(ROOT, 'test');
const tests = existsSync(testDir) ? readdirSync(testDir).filter((n) => n.endsWith('.test.sh')) : [];
if (tests.length === 0) warn('test/ 下没有测试 —— 门禁坏掉时不会有人知道');
else ok.push(`门禁自测 ${tests.length} 个`);

// 6. 僵尸任务：stage 未完成且超过 7 天没动
const tasksDir = join(ROOT, '.ai/tasks');
if (existsSync(tasksDir)) {
  const WEEK = 864e5 * 7;
  for (const d of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = join(tasksDir, d.name, 'state.json');
    if (!existsSync(p)) {
      warn(`.ai/tasks/${d.name}/ 没有 state.json`);
      continue;
    }
    let st;
    try {
      st = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      err(`.ai/tasks/${d.name}/state.json 无法解析`);
      continue;
    }
    const age = Date.now() - statSync(p).mtimeMs;
    if (st.stage !== 'done' && age > WEEK) {
      warn(`${d.name} 停在 stage=${st.stage}，已 ${Math.round(age / 864e5)} 天未动 —— 视为僵尸，重建而非续跑`);
    }
  }
}

// 7. skill 覆盖
const skillsDir = join(ROOT, '.skills');
const skillNames = existsSync(skillsDir)
  ? readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];
for (const name of Object.keys(stacks)) {
  const covered = skillNames.some((d) => {
    const p = join(skillsDir, d, 'SKILL.md');
    if (!existsSync(p)) return false;
    return new RegExp(`^stack:\\s*${name}\\s*$`, 'm').test(readFileSync(p, 'utf8'));
  });
  if (!covered) warn(`stack "${name}" 没有 skill —— 该栈 coder 的 Stage 0 会是空转`);
}

// 8. agent 源与产物
const srcDir = join(ROOT, 'agents');
const srcCount = existsSync(srcDir) ? readdirSync(srcDir).filter((f) => f.endsWith('.agent.md')).length : 0;
if (srcCount === 0) err('agents/ 下没有 *.agent.md');
else ok.push(`agent 源 ${srcCount} 个`);
if (!existsSync(join(ROOT, '.ai/writes.json'))) warn('.ai/writes.json 不存在 —— 先跑 npm run build:agents');

// 9. 常驻规则长度：它每次会话都进上下文，越长越没人读
const AGENTS_LIMIT = 70;
const agentsMd = read('AGENTS.md');
if (agentsMd === null) {
  warn('AGENTS.md 不存在 —— 三个 CLI 都没有常驻规则入口');
} else {
  const n = agentsMd.split('\n').length;
  if (n > AGENTS_LIMIT) {
    warn(`AGENTS.md ${n} 行，超过 ${AGENTS_LIMIT} —— 多出来的内容该挪进 skill，常驻规则越长越没人读`);
  } else {
    ok.push(`AGENTS.md ${n}/${AGENTS_LIMIT} 行`);
  }
}

// 输出
console.log('[doctor] 配置体检\n');
if (templateMode) {
  console.log(`  说明：project.name 仍是 "${PLACEHOLDER_NAME}"，按模板态体检（占位目录只算提醒）。`);
  console.log('        接到真实项目后先改 harness.config.json 的 project.name 与 stacks，再重跑。\n');
}
for (const o of ok) console.log(`  ✓ ${o}`);
for (const w of warns) console.log(`  ! ${w}`);
for (const e of errors) console.log(`  ✗ ${e}`);
console.log('');
if (errors.length) {
  console.log(`结果：${errors.length} 个阻塞问题，${warns.length} 个提醒。这些问题会让门禁静默失效，先修再开工。`);
  process.exit(1);
}
console.log(`结果：通过（${warns.length} 个提醒）`);
