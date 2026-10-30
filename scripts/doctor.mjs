#!/usr/bin/env node
/**
 * 配置体检 —— 照抄脚手架之后的第一步，比 gate 更早发现问题。
 *
 * gate 校验的是"已经配好之后对不对"，doctor 校验的是"配了没有"。
 * 这两类失败长得完全不同：前者是红灯，后者是门禁静默不生效。
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

// 1. 技术栈目录
const stacks = config.stacks || {};
if (Object.keys(stacks).length === 0) err('stacks 为空 —— coder 不知道该改哪个目录');
for (const [name, s] of Object.entries(stacks)) {
  const dir = join(ROOT, s.dir || name);
  if (!existsSync(dir)) {
    err(`stacks.${name}.dir="${s.dir}" 不存在 —— 这是脚手架占位值，改成项目真实目录`);
  } else ok.push(`stacks.${name} → ${s.dir}`);
  for (const k of ['lint', 'test', 'testOne']) {
    if (!s[k]) warn(`stacks.${name}.${k} 未配置，验证命令会靠模型猜`);
  }
}

// 2. hook 注册：hook 写完不注册 = 没写
const settingsPath = join(ROOT, '.claude/settings.json');
let registered = new Set();
if (!existsSync(settingsPath)) {
  err('.claude/settings.json 不存在 —— 所有 hook 都不会触发');
} else {
  try {
    const s = readFileSync(settingsPath, 'utf8');
    for (const m of s.matchAll(/hooks\/([\w.-]+\.mjs)/g)) registered.add(m[1]);
  } catch {
    err('.claude/settings.json 无法读取');
  }
}
const hookDir = join(ROOT, 'hooks');
let hookErr = 0;
if (existsSync(hookDir)) {
  for (const f of readdirSync(hookDir).filter((n) => n.endsWith('.mjs'))) {
    if (!registered.has(f)) {
      err(`hooks/${f} 没有注册到 .claude/settings.json —— 它永远不会执行`);
      hookErr++;
    }
  }
}
for (const f of registered) {
  if (!existsSync(join(hookDir, f))) {
    err(`.claude/settings.json 引用了不存在的 hooks/${f}`);
    hookErr++;
  }
}
if (registered.size && hookErr === 0) ok.push(`hook 已注册 ${registered.size} 个`);

// 3. 门禁代码改动必须有对应测试（治理规则的机器侧提示）
const tests = existsSync(join(ROOT, 'test'))
  ? readdirSync(join(ROOT, 'test')).filter((n) => n.endsWith('.test.sh'))
  : [];
if (tests.length === 0) warn('test/ 下没有测试 —— 门禁坏掉时不会有人知道');

// 4. 僵尸任务：stage 未完成且超过 7 天没动
const tasksDir = join(ROOT, '.ai/tasks');
if (existsSync(tasksDir)) {
  const DAY = 864e5 * 7;
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
    if (st.stage !== 'done' && age > DAY) {
      warn(`${d.name} 停在 stage=${st.stage}，已 ${Math.round(age / 864e5)} 天未动 —— 视为僵尸，重建而非续跑`);
    }
  }
}

// 5. skill 覆盖
const skillsDir = join(ROOT, '.skills');
const skillNames = existsSync(skillsDir)
  ? readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];
const extra = (config.skills && config.skills.extraStacks) || [];
for (const name of Object.keys(stacks)) {
  const covered = skillNames.some((d) => {
    const p = join(skillsDir, d, 'SKILL.md');
    if (!existsSync(p)) return false;
    return new RegExp(`^stack:\\s*${name}\\s*$`, 'm').test(readFileSync(p, 'utf8'));
  });
  if (!covered) warn(`stack "${name}" 没有 skill —— 该栈 coder 的 Stage 0 会是空转`);
}

// 6. agent 源与产物
const srcDir = join(ROOT, 'agents');
const srcCount = existsSync(srcDir) ? readdirSync(srcDir).filter((f) => f.endsWith('.agent.md')).length : 0;
if (srcCount === 0) err('agents/ 下没有 *.agent.md');
else ok.push(`agent 源 ${srcCount} 个`);
if (!existsSync(join(ROOT, '.ai/writes.json'))) {
  warn('.ai/writes.json 不存在 —— 先跑 npm run build:agents');
}

// 7. 常驻规则长度：它每次会话都进上下文，越长越没人读
const agentsMd = join(ROOT, 'AGENTS.md');
if (!existsSync(agentsMd)) {
  warn('AGENTS.md 不存在 —— 三个 CLI 都没有常驻规则入口');
} else {
  const n = readFileSync(agentsMd, 'utf8').split('\n').length;
  if (n > 70) {
    warn(`AGENTS.md ${n} 行，超过 70 —— 多出来的内容该挪进 skill，常驻规则越长越没人读`);
  } else {
    ok.push(`AGENTS.md ${n} 行`);
  }
}

// 输出
console.log('[doctor] 配置体检\n');
for (const o of ok) console.log(`  ✓ ${o}`);
for (const w of warns) console.log(`  ! ${w}`);
for (const e of errors) console.log(`  ✗ ${e}`);
console.log('');
if (errors.length) {
  console.log(`结果：${errors.length} 个阻塞问题，${warns.length} 个提醒。这些问题会让门禁静默失效，先修再开工。`);
  process.exit(1);
}
console.log(`结果：通过（${warns.length} 个提醒）`);
