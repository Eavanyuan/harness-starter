#!/usr/bin/env node
// 校验 .skills/ 的结构与引用完整性。
//
// 为什么需要它：skill 是运行时加载物，膨胀和断链不会报错，只会静默退化——
// 模型读不到清单就跳过 Stage 0，引用路径写错就当没有那份参考。
// 这里把「能不能被正确加载」变成 CI 里的红灯。
//
// 校验项：
//   1. 每个栈目录必须有 SKILL.md，frontmatter 必填项齐全
//   2. name 必须等于目录名
//   3. stack 必须是 harness.config.json 里 stacks 的键
//   4. 必备章节存在（Stage 0 / 硬规则 / 交付）
//   5. references 列出的文件真实存在
//   6. 单文件行数不超过上限（默认 200）
//   7. 不得引用其他 skill 的 SKILL.md（禁止级联）
//   8. .ai/ 下出现的 required_skills 必须能解析到真实 skill
//
// 用法：node scripts/check-skills.mjs [--json]

import { readFileSync, readdirSync, existsSync, statSync, readdirSync as rd } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, '.skills');
const JSON_OUT = process.argv.includes('--json');

const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

const config = JSON.parse(readFileSync(join(ROOT, 'harness.config.json'), 'utf8'));
const cfg = config.skills || {};
const MAX_LINES = cfg.maxLines || 200;
const REQUIRED_SECTIONS = cfg.requiredSections || ['## Stage 0', '## 硬规则', '## 交付'];
// v2 projects 数组 + v1 stacks 对象统一提取 id 集合
const stackKeys = Array.isArray(config.projects)
  ? [...new Set(config.projects.map((p) => p.id))]
  : Object.keys(config.stacks || {});
// 技术栈之外的受管区域（如 harness 自身）。它们有自己的文件域，但不是 stacks。
const extraStacks = cfg.extraStacks || [];

function strip(v) {
  let s = String(v).trim();
  s = s.replace(/\s+#\s.*$/, '');
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

// YAML 子集：只支持 key: value、key: 后跟 - item 列表。够用即可，不引依赖。
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const fm = {};
  let cur = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && cur) {
      if (!Array.isArray(fm[cur])) fm[cur] = [];
      fm[cur].push(strip(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (v.trim() === '') {
      fm[k] = [];
      cur = k;
    } else {
      fm[k] = strip(v);
      cur = null;
    }
  }
  return { fm, body: text.slice(m[0].length) };
}

const skillNames = new Set();
const skillStacks = new Map();
const report = [];

if (!existsSync(SKILLS_DIR)) {
  err('.skills/ 目录不存在');
} else {
  const entries = readdirSync(SKILLS_DIR).filter((n) => {
    const p = join(SKILLS_DIR, n);
    return statSync(p).isDirectory() && !n.startsWith('.');
  });

  if (entries.length === 0) err('.skills/ 下没有任何栈目录');

  for (const dir of entries.sort()) {
    const entry = join(SKILLS_DIR, dir, 'SKILL.md');
    if (!existsSync(entry)) {
      err(`${dir}/ 缺少 SKILL.md`);
      continue;
    }
    const text = readFileSync(entry, 'utf8');
    const lines = text.split(/\r?\n/).length - 1;
    const parsed = parseFrontmatter(text);
    if (!parsed) {
      err(`${dir}/SKILL.md 缺少 frontmatter（首行必须是 ---）`);
      continue;
    }
    const { fm, body } = parsed;

    for (const k of cfg.requiredKeys || ['name', 'stack', 'version', 'stage0']) {
      if (fm[k] === undefined || fm[k] === '') err(`${dir}/SKILL.md frontmatter 缺 ${k}`);
    }

    if (fm.name && fm.name !== dir) {
      err(`${dir}/SKILL.md 的 name=${fm.name}，与目录名不一致`);
    }
    skillNames.add(fm.name || dir);

    if (fm.stack) {
      const st = String(fm.stack);
      skillStacks.set(dir, st);
      const known = st === 'any' || stackKeys.includes(st) || extraStacks.includes(st);
      if (!known) {
        err(
          `${dir}/SKILL.md 的 stack=${st} 既不在 stacks（${stackKeys.join(' / ')}）也不在 skills.extraStacks（${extraStacks.join(' / ') || '空'}）`
        );
      }
    }

    const applies = Array.isArray(fm.applies_to) ? fm.applies_to : fm.applies_to ? [fm.applies_to] : [];
    if (applies.length === 0) {
      err(`${dir}/SKILL.md 缺 applies_to —— 没有它就无法按文件路径选 skill`);
    }
    for (const g of applies) {
      if (!g || typeof g !== 'string') {
        err(`${dir}/SKILL.md 的 applies_to 含空值或非字符串`);
        continue;
      }
      if (g.startsWith('/') || g.includes('..')) {
        err(`${dir}/SKILL.md 的 applies_to「${g}」必须是仓库相对路径，且不含 ..`);
      }
      if (!/[*?]/.test(g) && !g.includes('.')) {
        warn(`${dir}/SKILL.md 的 applies_to「${g}」既无通配也无扩展名，几乎匹配不到任何文件`);
      }
    }

    // references：可选的单个值或列表
    const refs = Array.isArray(fm.references) ? fm.references : fm.references ? [fm.references] : [];
    for (const r of refs) {
      const p = join(SKILLS_DIR, dir, r);
      if (!existsSync(p)) err(`${dir}/SKILL.md 引用的 ${r} 不存在`);
    }
    if (refs.length > 3) {
      warn(`${dir}/SKILL.md 的 references 有 ${refs.length} 个，Stage 0 超过 3 个文件就会开始被跳过`);
    }

    for (const sec of REQUIRED_SECTIONS) {
      if (!body.includes(sec)) err(`${dir}/SKILL.md 缺章节「${sec}」`);
    }

    if (lines > MAX_LINES) {
      err(`${dir}/SKILL.md ${lines} 行，超过上限 ${MAX_LINES}（该拆 references 或删规则）`);
    }

    // 禁止级联：skill 不得引用别的 skill 的入口
    for (const mm of body.matchAll(/\.skills\/([A-Za-z0-9_-]+)\/SKILL\.md/g)) {
      if (mm[1] !== dir) {
        err(`${dir}/SKILL.md 引用了另一个 skill 的入口 .skills/${mm[1]}/SKILL.md（禁止级联，深度固定 2 层）`);
      }
    }

    // 硬规则编号连续性：R1..Rn / F1..Fn / E1..En 必须从 1 连续
    const ids = [...body.matchAll(/^\|\s*([A-Z])(\d+)\s*\|/gm)];
    if (ids.length > 0) {
      const byPrefix = {};
      for (const [, p, n] of ids) (byPrefix[p] ||= []).push(Number(n));
      for (const [p, nums] of Object.entries(byPrefix)) {
        const sorted = [...new Set(nums)].sort((a, b) => a - b);
        const expect = Array.from({ length: sorted.length }, (_, i) => i + 1);
        if (sorted.join(',') !== expect.join(',')) {
          warn(`${dir}/SKILL.md 的 ${p}# 编号不连续：${sorted.join(',')}`);
        }
      }
    }

    report.push({ skill: dir, stack: fm.stack, lines, refs: refs.length, version: fm.version });
  }
}

// required_skills 可解析性：扫描 .ai/ 下的 json
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of rd(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.json')) out.push(p);
  }
  return out;
}

const declared = new Set();
for (const f of walk(join(ROOT, '.ai'))) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/"required_skills"\s*:\s*\[([^\]]*)\]/g)) {
    for (const q of m[1].matchAll(/"([^"]+)"/g)) {
      declared.add(q[1]);
      if (!skillNames.has(q[1])) {
        err(`${relative(ROOT, f)} 的 required_skills 含 "${q[1]}"，但 .skills/ 下没有这个 skill`);
      }
    }
  }
}

// 每个 stack 至少有一个 skill 覆盖，否则 coder 对着空目录执行 Stage 0
for (const st of stackKeys) {
  const covered = [...skillStacks.values()].includes(st);
  if (!covered) warn(`stack "${st}" 没有对应 skill —— 该栈的 coder 会无 skill 可用`);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors, warns, skills: report }, null, 2));
} else {
  console.log('.skills 校验');
  for (const r of report) {
    console.log(`  ✓ ${r.skill.padEnd(10)} ${String(r.lines).padStart(3)} 行  stack=${r.stack}  refs=${r.refs}  v${r.version}`);
  }
  if (declared.size) console.log(`  required_skills 已声明：${[...declared].join(', ')}`);
  for (const w of warns) console.log(`  ! ${w}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  console.log(errors.length === 0 ? `  结果：${report.length} 个 skill 通过` : `  结果：${errors.length} 个错误，${warns.length} 个警告`);
}

process.exit(errors.length === 0 ? 0 : 1);
