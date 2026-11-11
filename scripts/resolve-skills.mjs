#!/usr/bin/env node
// 按改动文件路径解析该加载哪些 skill。
//
// 存在的理由：`applies_to` 如果只写在文档里、靠模型自己判断"我该读哪份"，
// 它就是个装饰字段——模型会跳过，或者读一份不相关的。这里把选择变成一次命令。
//
// 用法：
//   node scripts/resolve-skills.mjs backend/src/main/java/demo/Foo.java
//   node scripts/resolve-skills.mjs --diff              # 取 git 改动文件
//   node scripts/resolve-skills.mjs --diff --json
//
// 退出码：0 无论是否命中（无命中是正常情况）；1 仅在参数或配置错误时。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRe } from '../hooks/lib/glob.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, '.skills');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const USE_DIFF = argv.includes('--diff');
const files = argv.filter((a) => !a.startsWith('--'));

function die(msg) {
  console.error(`[resolve-skills] ${msg}`);
  process.exit(1);
}

// glob 语义见 hooks/lib/glob.mjs（此前这里有第二份实现，`a/**/b` 与 verify 判定不同）。

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
      fm[cur].push(item[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (v.trim() === '') {
      fm[k] = [];
      cur = k;
    } else {
      fm[k] = v.trim().replace(/^["']|["']$/g, '');
      cur = null;
    }
  }
  return fm;
}

if (!existsSync(SKILLS_DIR)) die('.skills/ 不存在');

const skills = [];
for (const dir of readdirSync(SKILLS_DIR).sort()) {
  const entry = join(SKILLS_DIR, dir, 'SKILL.md');
  const p = join(SKILLS_DIR, dir);
  if (!statSync(p).isDirectory() || !existsSync(entry)) continue;
  const fm = parseFrontmatter(readFileSync(entry, 'utf8')) || {};
  const applies = Array.isArray(fm.applies_to) ? fm.applies_to : fm.applies_to ? [fm.applies_to] : [];
  const refs = Array.isArray(fm.references) ? fm.references : fm.references ? [fm.references] : [];
  skills.push({
    name: fm.name || dir,
    stack: fm.stack || null,
    version: fm.version || null,
    entry: `.skills/${dir}/SKILL.md`,
    stage0: String(fm.stage0) === 'true',
    matchers: applies.map((g) => ({ glob: g, re: globToRe(g) })),
    reads: refs.map((r) => `.skills/${dir}/${r}`),
  });
}

let targets = files;
if (USE_DIFF) {
  // 用 status 而不是 diff HEAD：新仓库还没有首个提交时，diff HEAD 会 fatal，
  // 而那种失败很容易被当成"没有改动"静默放行——这正是要避免的失效模式。
  let out;
  try {
    out = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
  } catch {
    die('无法读取 git 改动（不是 git 仓库）；请显式传文件路径');
  }
  targets = out
    .split('\n')
    .map((s) => s.replace(/\s+$/, ''))
    .filter(Boolean)
    .map((s) => {
      const p = s.slice(3);
      // 重命名形态：R  old -> new，取新路径
      const arrow = p.indexOf(' -> ');
      return arrow === -1 ? p : p.slice(arrow + 4);
    })
    .map((p) => p.replace(/^"|"$/g, ''));
}

if (targets.length === 0) {
  if (JSON_OUT) console.log(JSON.stringify({ files: [], skills: [] }, null, 2));
  else console.log('没有改动文件，无需加载 skill。');
  process.exit(0);
}

const hits = new Map();
for (const f of targets) {
  for (const s of skills) {
    if (s.matchers.some((m) => m.re.test(f))) {
      if (!hits.has(s.name)) hits.set(s.name, { ...s, files: [] });
      hits.get(s.name).files.push(f);
    }
  }
}

const result = [...hits.values()];

if (JSON_OUT) {
  console.log(JSON.stringify({ files: targets, skills: result.map(({ matchers, ...r }) => r) }, null, 2));
} else {
  console.log(`改动文件 ${targets.length} 个，命中 ${result.length} 个 skill：\n`);
  for (const s of result) {
    console.log(`  ${s.name}  v${s.version}  (stack=${s.stack})`);
    console.log(`    入口  ${s.entry}${s.stage0 ? '   ← Stage 0 强制，逐项完成后才可改代码' : ''}`);
    for (const r of s.reads) console.log(`    参考  ${r}`);
    const shown = s.files.slice(0, 5).join(', ');
    console.log(`    命中  ${shown}${s.files.length > 5 ? ` 等 ${s.files.length} 个` : ''}\n`);
  }
  if (result.length === 0) {
    console.log('  无命中：本次改动不落在任何 skill 的 applies_to 范围内。');
    console.log('  如果这不对，说明有栈缺 skill —— 见 .skills/README.md「30 分钟加一个栈」。');
  }
}
