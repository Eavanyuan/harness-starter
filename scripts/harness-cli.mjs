#!/usr/bin/env node
/**
 * harness-cli —— 把本仓库作为模板装进目标项目（harness-builder v1）。
 * 方案：docs/plans/2026-10-30-harness-builder-final.md
 *
 * 子命令：
 *   check <target>                运行时前提探测（node / bash / git / 构建根）
 *   detect <target> [--json]      栈 / CI 平台 / 多构建根探测摘要（只读）
 *   analyze <target> [--out dir] [--in-project]   机械探测事实视图（只读，报告默认落项目外）
 *   init <target> [--dry-run] [--agents read-only|full] [--stack-dir <dir>]
 *   remove <target> [--dry-run] [--yes] [--force]
 *
 * 安全内核（方案 §6/§7 的 v1 子集）：
 *   - --dry-run 三态预览（create / skip / conflict），不落一个字节
 *   - 目标已存在的文件一律 skip / 标 conflict，永不覆盖
 *   - 写入路径必须落在 target 内（resolve 后前缀校验），拒绝穿越 symlink；
 *     analyze 的 --out 用 realpath 判定，symlink 指向项目内部同样拒绝
 *   - 写入是原子的（临时文件 + rename），manifest 先落 pending 再落 complete：
 *     中途崩溃留下的是"可卸载的半装现场"，不是无主文件
 *   - manifest 合并语义：重跑 init 不会丢掉先前的归属记录（包括这次 plan 里不再出现的
 *     条件生成项，如 package.json / .gitignore / CI workflow），否则 remove 直接失效
 *   - 生成物归属由**生成器声明**（build-*.mjs --manifest），不按目录扫描认领：
 *     扫出来的文件里有用户自己的 .claude/commands/*.md，认领了就等于 remove 时删用户的活
 *   - manifest.foreign 记录"安装前就存在、不是我们建的"文件，remove 永不删
 *   - build 覆盖安装前已存在的文件时，原内容备份到 .ai/backup/<ts>/ 并点名（覆盖可恢复）
 *   - remove 只按 manifest 逐个删文件，绝不 glob 批量删目录；只删 hash 证明未被改动的文件，
 *     改过的（含无 hash 的旧版条目）点名保留，--force 才删；目录仅在变空后回收，
 *     且永不触碰 .git / .ai/tasks / .ai/verify / .ai/ledger / .ai/backup（用户数据与证据）
 *
 * 诚实边界：v1 没有独立的 staging 区与 plan diff——init 的 --dry-run 是预览，
 * 真装直接落盘（原子 + 冲突拒写）。完整 adopt 流水线（staging → diff → apply）在 v1.5。
 */
import {
  readdirSync, readFileSync, writeFileSync, existsSync, statSync, lstatSync,
  mkdirSync, rmSync, rmdirSync, renameSync, realpathSync, readlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname, relative, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk, detectStacks, detectBuildRoots, analyze, renderMap, suggestStacksConfig } from './lib/analyzer.mjs';
// 门禁判据必须与 hook / CI 同源（verify.mjs）：resume 若自己判一遍，
// 就会出现"resume 说能推进、hook 落盘时拦下"的两套口径。
import {
  validateTodos,
  migrate,
  checkStageExit,
  checkTaskTraceability,
  checkStage,
  checkStageTodoClosure,
  checkCompleteness,
  missingDeclarations,
  docKinds,
  declaredPathOf,
  stageGate,
  artifactIndex,
  STAGE_NEXT,
  formatFailures,
} from '../hooks/lib/verify.mjs';

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = '.harness-manifest.json';
const READ_ONLY_AGENTS = ['orchestrator', 'requirement-analyst', 'tech-selector', 'spec-reviewer'];

/** 随模板复制的目录与单文件。生成物（.claude/.zcode/prompts）不复制——目标侧自己 build。 */
const TEMPLATE_DIRS = ['agents', 'hooks', 'scripts', 'templates', '.skills', 'test', 'guides'];
const TEMPLATE_FILES = ['harness.config.json', 'AGENTS.md', '.ai/rules/verification.md', '.ai/state.example.json'];
/** build 产物（init 后由目标侧 build 生成；安装完成后展开成**文件清单**写入 manifest）。 */
const GENERATED = [
  '.claude/agents', '.claude/commands', '.claude/settings.json',
  '.zcode/agents', '.zcode/commands', '.zcode/config.json',
  'prompts/agents', 'prompts/commands', 'prompts/INDEX.md', '.ai/writes.json',
];
/** remove 永不触碰：用户数据、证据、备份、版本库。 */
const NEVER_REMOVE = ['.git', '.ai/tasks', '.ai/verify', '.ai/ledger', '.ai/locks', '.ai/backup', 'node_modules'];
const SKIP_FILES = new Set(['.DS_Store']);

function die(msg, code = 1) {
  console.error(`[harness] ${msg}`);
  process.exit(code);
}

function usage() {
  console.log(`用法:
  node scripts/harness-cli.mjs check <target>
  node scripts/harness-cli.mjs detect <target> [--json]
  node scripts/harness-cli.mjs analyze <target> [--out <dir>] [--in-project]
  node scripts/harness-cli.mjs init <target> [--dry-run] [--agents read-only|full] [--stack-dir <dir>]
  node scripts/harness-cli.mjs remove <target> [--dry-run] [--yes] [--force]
  node scripts/harness-cli.mjs resume <target> [<slug>]
      按三档列出待决事项，并生成/刷新 .ai/tasks/<slug>/DECISIONS.md（可留存的决策单）。

  node scripts/harness-cli.mjs resume <target> <slug> --from DECISIONS.md --by <决策人>
      读回决策单里填好的「回填：」行。--from 的路径先按当前目录、再按 .ai/tasks/<slug>/ 解析。

  node scripts/harness-cli.mjs resume <target> <slug> --accept-suggested [--except D2,D7] --by <决策人>
      批量接受第三节「按建议默认」的项（只作用于 blocker 显式标了 default_ok 的）。

  node scripts/harness-cli.mjs resume <target> <slug> --decide <id>=<编号> [--resolve <id>=<怎么解决的>] --by <决策人> [--advance]
      逐条回填。--decide 的值必须是选项编号（多选逗号分隔），自由文本会被拒绝。

  node scripts/harness-cli.mjs review-packet <target> [<slug>] [--first]
      输出可直接贴进 PR 的评审包（markdown）。不给 slug 列出全部任务的待补数。
      首版给「缺什么」，改版给「哪几节被动过」+「该谁签」。不写任何文件。
      有机器可判的待补项时退出码 1。「--first」强制按首版口径出包（历史里已有上一版时用）。`);
  process.exit(64);
}

/**
 * target 解析与安全校验：拒绝与模板目录互相嵌套（防自复制 / 递归拷贝）。
 *
 * allowSelf：只读或"操作自己进度"的动词要放过 target==模板根这种情形——
 * 装进项目之后 CLI 就住在项目里，`resume .` 是最常用的形态；把"禁止自复制"
 * 的安全规则套到 resume 上，等于让工具在自己的项目里失效（真实项目踩过）。
 * 会往 target 里成批写文件的 init/remove 保持严格。
 */
function safeTarget(raw, allowSelf = false) {
  if (!raw) usage();
  const abs = resolve(raw);
  if (allowSelf && abs === resolve(TEMPLATE)) return abs;
  const relToTemplate = relative(TEMPLATE, abs);
  const relFromTemplate = relative(abs, TEMPLATE);
  const overlaps = (r) => r === '' || (!r.startsWith('..') && !isAbsolute(r));
  if (overlaps(relToTemplate) || overlaps(relFromTemplate)) {
    die(`目标目录与 harness 模板互相嵌套：${abs}（选一个模板之外的目录）`);
  }
  return abs;
}

/** 写入前校验：路径必须在 target 内，且相对路径上不得有 symlink（防穿越逃逸）。 */
function assertWritableUnder(target, rel) {
  const abs = resolve(target, rel);
  const relBack = relative(target, abs);
  if (relBack === '' || relBack.startsWith('..') || isAbsolute(relBack)) {
    die(`写入路径逃逸出目标目录：${rel}`);
  }
  let cur = target;
  for (const part of relBack.split('/')) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch { continue; } // 尚不存在 = 将创建，无 symlink 问题
    if (st.isSymbolicLink()) die(`路径上存在 symlink，拒绝写入：${relative(target, cur) || cur}`);
  }
  return abs;
}

/**
 * 宽松 realpath：路径还不存在时，解析最近存在的祖先，再拼回剩余段。
 * 用它判"这个路径最终落在哪"——纯词法比较挡不住 `ln -s target/leak /tmp/rep` 这类绕过。
 * 悬挂 symlink（目标还不存在）必须用 lstat + readlink 手动跟，否则会把链接名
 * 当成普通路径段，判定就漏过去了。
 */
function realpathLoose(p) {
  let cur = resolve(p);
  const rest = [];
  for (let guard = 0; guard < 32; guard++) {
    if (existsSync(cur)) break;
    let st = null;
    try { st = lstatSync(cur); } catch { st = null; }
    if (st && st.isSymbolicLink()) {
      const linkTarget = readlinkSync(cur);
      cur = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(cur), linkTarget);
      continue;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(basename(cur));
    cur = parent;
  }
  const base = existsSync(cur) ? realpathSync(cur) : cur;
  return rest.length ? join(base, ...rest) : base;
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** 文件内容 hash；读不了返回 null——remove 对 null 按"无法证明未改动"保护，不盲删。 */
function hashFileSync(abs) {
  try { return sha256(readFileSync(abs, 'utf8')); } catch { return null; }
}

/** 原子写：先写临时文件再 rename。中途崩溃不会留下被截断的目标文件。 */
function writeAtomic(abs, content) {
  const tmp = `${abs}.harness-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, abs);
}

function listTemplateFiles() {
  const out = [];
  const visit = (dir, top) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_FILES.has(e.name) || e.name === '.idea') continue;
      const abs = join(dir, e.name);
      const rel = `${top}/${e.name}`;
      if (e.isDirectory()) visit(abs, rel);
      else if (e.isFile()) out.push({ rel, abs });
    }
  };
  for (const d of TEMPLATE_DIRS) if (existsSync(join(TEMPLATE, d))) visit(join(TEMPLATE, d), d);
  for (const f of TEMPLATE_FILES) if (existsSync(join(TEMPLATE, f))) out.push({ rel: f, abs: join(TEMPLATE, f) });
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

function listFilesUnder(target, rel) {
  const abs = join(target, rel);
  if (!existsSync(abs)) return [];
  if (!lstatSync(abs).isDirectory()) return [rel];
  const out = [];
  const visit = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs2 = join(dir, e.name);
      const rel2 = `${prefix}/${e.name}`;
      if (e.isDirectory()) visit(abs2, rel2);
      else if (e.isFile()) out.push(rel2);
    }
  };
  visit(abs, rel);
  return out;
}

/**
 * 生成物目录在 build 之前的快照：rel → 原内容（读不了记为 null）。
 *
 * 用途有两个，都绕不开"先有内容"这个前提：
 *   - 判定"哪些文件是用户的"（preGen 里有、生成器清单里没有 → 外来，remove 永不删）
 *   - 判定"哪些文件被 build 覆盖了"（hash 变了 → 把原内容备份出去，让覆盖可恢复）
 * 只在 build 之后扫目录做不到：那时原内容已经没了。
 */
function snapshotFiles(target, dirs) {
  const snap = new Map();
  for (const d of dirs) {
    for (const rel of listFilesUnder(target, d)) {
      try { snap.set(rel, readFileSync(join(target, rel), 'utf8')); } catch { snap.set(rel, null); }
    }
  }
  return snap;
}

/**
 * 路径上是否有 symlink（返回第一段的相对路径，无则 null）。
 * remove 用它做"跳过并说明"：用户把 .claude/commands 链到 dotfiles 仓库是合法用法，
 * 直接 die 会把整场卸载打断在半途（已删的删了、剩下的没动、manifest 还在）。
 */
function symlinkInPath(target, rel) {
  const abs = resolve(target, rel);
  const relBack = relative(target, abs);
  if (relBack === '' || relBack.startsWith('..') || isAbsolute(relBack)) return '(越界)';
  let cur = target;
  for (const part of relBack.split('/')) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch { continue; }
    if (st.isSymbolicLink()) return relative(target, cur) || cur;
  }
  return null;
}

/** 读生成器回报的文件清单（--manifest 产物）；拿不到返回 null，由调用方退回扫描口径。 */
function readBuildManifest(abs) {
  try {
    const j = JSON.parse(readFileSync(abs, 'utf8'));
    if (!j || !Array.isArray(j.files)) return null;
    return j.files.filter((p) => typeof p === 'string' && p);
  } catch {
    return null;
  }
}

/* ------------------------------ preflight ------------------------------ */

/** 运行时前提（方案 §0.1）：Node ≥18 与 bash 是硬依赖，git 缺失只降级。 */
function preflight(target) {
  const major = Number(process.versions.node.split('.')[0]);
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  const git = spawnSync('git', ['-C', target, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  return {
    node: { ok: major >= 18, version: process.version },
    bash: { ok: bash.status === 0 },
    git: { ok: String(git.stdout).trim() === 'true' },
  };
}

function printPreflight(pf) {
  console.log(`[harness] 运行时前提`);
  console.log(`  node ${pf.node.version}${pf.node.ok ? '（≥18 ✓）' : '（<18 ✗ —— hook 与脚本全是 .mjs，跑不起来）'}`);
  console.log(`  bash ${pf.bash.ok ? '✓' : '✗ —— init-harness.sh / test/*.sh 需要 bash（Windows 原生请走 WSL）'}`);
  console.log(`  git  ${pf.git.ok ? '✓' : '✗ —— change 基线校验与漂移检测会降级（不阻塞）'}`);
}

/** 构建根清单 + 每个根上的栈。id 撞车说明两个同类服务，v1 装不进 backend/frontend 两槽。 */
function survey(target) {
  const files = existsSync(target) ? walk(target) : [];
  const roots = detectBuildRoots(target, files);
  const perRoot = roots.map((r) => ({ ...r, stacks: detectStacks(target, files, { dir: r.dir }) }));
  const stacks = perRoot.flatMap((r) => r.stacks);
  const ids = stacks.map((s) => s.id);
  const duplicateIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  return { files, roots, perRoot, stacks, duplicateIds };
}

/**
 * v1 能装下的布局：至多两个构建根、栈 id 不撞车（对应 config 的 backend/frontend 两槽）。
 * 装不下就要求 --stack-dir 选主栈，其余标 unsupported —— 不猜、不静默合并。
 */
function needsStackDir(sv) {
  return sv.roots.length > 2 || sv.duplicateIds.length > 0;
}

/* ------------------------------- check ------------------------------- */

function cmdCheck(target) {
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

/* ------------------------------- detect ------------------------------- */

function cmdDetect(target, json) {
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

/* ------------------------------- analyze ------------------------------- */

function cmdAnalyze(target, outRaw, inProject, maxEdges) {
  if (!existsSync(target)) die(`目标不存在：${target}`);
  const out = outRaw ? resolve(outRaw) : join(dirname(target), `${basename(target)}-harness-report`);
  if (!inProject) {
    // 词法判定 + realpath 判定：只做前者的话，`ln -s <target>/leak /tmp/rep` 就能把报告写进目标项目。
    const targetReal = realpathSync(target);
    const outReal = realpathLoose(out);
    if (isInside(out, target) || isInside(outReal, targetReal)) {
      die(`--out 落在目标项目内：${out}${outReal !== out ? `（经 symlink 解析为 ${outReal}）` : ''}（报告默认写到项目外；确要放进去加 --in-project）`);
    }
  }
  mkdirSync(out, { recursive: true });
  const report = analyze(target, Number.isFinite(maxEdges) ? { maxEdges } : {});
  writeAtomic(join(out, 'analysis.json'), JSON.stringify(report, null, 2) + '\n');
  writeAtomic(join(out, 'PROJECT-MAP.md'), renderMap(report));
  console.log(`[harness] analyze 完成（只读，未改动目标目录）：`);
  console.log(`  ${join(out, 'analysis.json')}`);
  console.log(`  ${join(out, 'PROJECT-MAP.md')}`);
  for (const w of report.warnings) console.log(`  ! ${w}`);
  for (const r of report.risks) console.log(`  ! ${r}`);
  if (report.edges_truncated) {
    console.log(`  ! 明细边已截断：${report.edges_truncated.kept}/${report.edges_truncated.total}（结论字段按全量算；要全量加 --full-edges）`);
  }
}

/* -------------------------------- init -------------------------------- */

function projectName(target) {
  return basename(target).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'harness-project';
}

/**
 * 用探测结果适配配置：项目名、stacks 回填。模板值只是兜底——直接把模板配置抄进
 * 目标项目，等于让新项目继承 backend/ + mvn 与 frontend/ + pnpm 这套假路径。
 */
function adaptConfig(content, target, stackDir) {
  const cfg = JSON.parse(content);
  const notes = [];
  cfg.project = { ...(cfg.project || {}), name: projectName(target) };

  const files = existsSync(target) ? walk(target) : [];
  if (stackDir && !detectBuildRoots(target, files).some((r) => r.dir === stackDir)) {
    notes.push(`--stack-dir ${stackDir} 下没有构建清单（可用：${detectBuildRoots(target, files).map((r) => r.dir).join('、') || '无'}）——stacks 未回填`);
  }
  const stacks = detectStacks(target, files, stackDir ? { dir: stackDir } : {});
  const supported = stacks.filter((s) => s.supported);
  const unsupported = stacks.filter((s) => !s.supported);
  // 一律用探测结果覆盖：把模板的 backend/ + mvn、frontend/ + pnpm 抄进一个 Go 项目，
  // 比"空配置"更糟——那些命令会跑空，还看着像配好了。
  // v2：产出 projects 数组（同 id 多条、跨语言混合），替代 v1 的 stacks 双槽对象。
  // 老项目用 stacks 对象的不破坏——消费侧 allStacks 兼容两种形态。
  const projects = suggestStacksConfig(supported);
  if (projects.length > 0) {
    cfg.projects = projects;
    delete cfg.stacks; // 新项目用数组，不保留旧键
  } else {
    cfg.projects = [];
    delete cfg.stacks;
  }
  if (supported.length) {
    notes.push(`projects 按探测回填 ${projects.length} 条：${projects.map((s) => `${s.id}(${s.dir})`).join('、')}（命令在目标项目里可跑，不是模板占位值）`);
  } else {
    notes.push('未探测到受支持的构建清单（v1 生成命令的栈：Java/Maven、Java/Gradle、TS/Vue）：projects 留空待手填——doctor 会一直红到填完，这是刻意的');
  }
  for (const u of unsupported) notes.push(`${u.lang}（${u.dir}）：v1 不生成命令，projects 里该栈需手填（工具不猜命令）`);
  return { cfg, notes };
}

function cmdInit(target, opts) {
  const pf = preflight(target);
  printPreflight(pf);
  const notes = [];
  // 目标不存在：全新项目是合法入口（方案支持"从零建 harness"），但必须明说——
  // 拼错路径时静默建出一整套文件比报错更糟。旧实现在这里直接 ENOENT 崩在 manifest 写入上，
  // 前面还打了"计划：create 73"，看起来像在干活。
  if (existsSync(target)) {
    if (!lstatSync(target).isDirectory()) die(`目标不是目录：${target}`, 64);
  } else if (opts.dryRun) {
    notes.push('目标目录不存在：真装会创建它（拼错路径请先核对）');
  } else {
    mkdirSync(target, { recursive: true });
    notes.push(`目标目录不存在，已创建：${target}`);
  }
  if (!pf.node.ok) {
    if (!opts.dryRun) die(`Node ${pf.node.version} < 18：全部 hook 与脚本是 .mjs 硬依赖。先升级 Node，或只做只读探测（detect / analyze）。`, 69);
    notes.push('前提不满足：Node < 18 —— 真装会被拒绝，这里只出预览');
  }
  if (!pf.bash.ok) {
    if (!opts.dryRun) die('bash 缺失：init-harness.sh 与 test/*.sh 需要 bash（Windows 原生请走 WSL）。', 69);
    notes.push('前提不满足：bash 缺失 —— 真装会被拒绝，这里只出预览');
  }
  if (!pf.git.ok) notes.push('当前目录不是 git 仓库：change 的 --baseline 校验与漂移检测会降级（不阻塞安装）');

  const templateFiles = listTemplateFiles();
  if (templateFiles.length === 0) die('模板文件为空——模板仓库损坏');
  if (opts.agentsMode !== 'read-only' && opts.agentsMode !== 'full') die(`--agents 只接受 read-only|full，收到：${opts.agentsMode}`, 64);
  if (opts.stackDir && (opts.stackDir.startsWith('/') || opts.stackDir.includes('..'))) die(`--stack-dir 必须是目标内的相对路径，收到：${opts.stackDir}`, 64);

  const prev = readManifest(target);
  if (prev && prev.corrupt) die(`${MANIFEST} 无法解析——先人工核对再装（不覆盖损坏的归属记录）`);

  const plan = []; // {rel, action: create|merge|skip-same|conflict, content}
  for (const { rel, abs } of templateFiles) {
    let content = readFileSync(abs, 'utf8');
    let cfgNotes = [];
    if (rel === 'harness.config.json') {
      const adapted = adaptConfig(content, target, opts.stackDir);
      cfgNotes = adapted.notes;
      let cfg = adapted.cfg;
      if (opts.agentsMode === 'read-only') {
        cfg = { ...cfg, agents: { ...(cfg.agents || {}), enabled: READ_ONLY_AGENTS } };
        cfgNotes.push(`--agents read-only：启用清单裁到 ${READ_ONLY_AGENTS.length} 个（第 1 周只读阶段）`);
      }
      content = JSON.stringify(cfg, null, 2) + '\n';
    }
    const dest = join(target, rel);
    let action;
    if (existsSync(dest)) {
      action = readFileSync(dest, 'utf8') === content ? 'skip-same' : 'conflict';
    } else {
      action = 'create';
    }
    // 配置没装上时不能报"已回填 stacks"——那会让人以为配置已经按项目适配过（假的绿灯）
    if (action !== 'conflict') notes.push(...cfgNotes);
    plan.push({ rel, action, content });
  }

  // package.json：目标没有 → 生成最小可跑 gate 的；已有 → **合并 scripts**（不覆盖已有键）。
  // 只提示不合并的话，`npm run gate` 在目标项目里根本不存在——门禁就成了纸面的。
  const pkgPath = join(target, 'package.json');
  if (!existsSync(pkgPath)) {
    const tpl = JSON.parse(readFileSync(join(TEMPLATE, 'package.json'), 'utf8'));
    // marker 让下一轮探测知道"这是工具入口，不是项目构建清单"（否则 Java 项目会被二次识别成 Node 栈）
    const harness = { tooling: true, note: '本文件是 harness 的工具脚本入口（build:agents / gate 等），不是项目构建清单；删除会让 npm run gate 不可用' };
    plan.push({ rel: 'package.json', action: 'create', content: JSON.stringify({ name: projectName(target), private: true, type: 'module', harness, scripts: tpl.scripts, engines: tpl.engines }, null, 2) + '\n' });
  } else {
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { pkg = null; }
    if (!pkg) {
      notes.push('package.json 已存在但不是合法 JSON：跳过 scripts 合并（先修好 JSON，再手工补 gate 等脚本）');
    } else {
      const tpl = JSON.parse(readFileSync(join(TEMPLATE, 'package.json'), 'utf8'));
      const scripts = pkg.scripts || {};
      const added = [];
      const kept = [];
      for (const [k, v] of Object.entries(tpl.scripts)) {
        if (!(k in scripts)) { scripts[k] = v; added.push(k); }
        else if (scripts[k] !== v) kept.push(k);
      }
      pkg.scripts = scripts;
      if (added.length) {
        plan.push({ rel: 'package.json', action: 'merge', content: JSON.stringify(pkg, null, 2) + '\n' });
        notes.push(`package.json 合并 scripts：新增 ${added.length} 个（${added.join(', ')}）——npm run gate 因此在目标项目里可跑`);
      } else {
        notes.push('package.json scripts 已齐（或全与模板不同）：未改动；确认含 gate / build:agents / build:hooks');
      }
      if (kept.length) notes.push(`package.json 里这些脚本键与模板不同，保留你的版本：${kept.join(', ')}`);
    }
  }
  if (!existsSync(join(target, '.gitignore'))) {
    plan.push({ rel: '.gitignore', action: 'create', content: readFileSync(join(TEMPLATE, '.gitignore'), 'utf8') });
  } else {
    notes.push('.gitignore 已存在（不覆盖）：确认含 .ai/locks/、.ai/ledger/、node_modules/、.DS_Store');
  }
  const hasGitlabCi = existsSync(join(target, '.gitlab-ci.yml'));
  const ghWorkflow = '.github/workflows/quality-gate.yml';
  if (!hasGitlabCi && !existsSync(join(target, ghWorkflow))) {
    plan.push({ rel: ghWorkflow, action: 'create', content: readFileSync(join(TEMPLATE, ghWorkflow), 'utf8') });
  } else if (hasGitlabCi) {
    notes.push('检测到 .gitlab-ci.yml：不生成 GitHub workflow，把 quality-gate 的步骤镜像进 GitLab CI');
  }

  const counts = { create: 0, merge: 0, 'skip-same': 0, conflict: 0 };
  for (const p of plan) counts[p.action]++;
  console.log(`\n[harness] init ${target}${opts.dryRun ? '（dry-run，不落盘）' : ''}`);
  console.log(`  计划：create ${counts.create} · merge(合并非破坏) ${counts.merge} · skip(相同) ${counts['skip-same']} · conflict(已存在且不同) ${counts.conflict}`);
  if (prev && !prev.corrupt) notes.push(`已有 ${MANIFEST}：本次按合并语义更新（先前 create 记录保留，remove 仍能覆盖旧文件）`);
  if (opts.dryRun) {
    const mark = { create: '+', merge: '~', conflict: '!', 'skip-same': '=' };
    for (const p of plan) console.log(`  ${mark[p.action] || '?'} ${p.rel}`);
    for (const n of notes) console.log(`  · ${n}`);
    return;
  }

  // manifest 合并：先前 create 的归属不能被这次重跑抹掉（抹掉 = remove 失效）。
  // 注意"这次 plan 里没有的旧条目"：package.json / .gitignore / CI workflow 是**条件生成**的，
  // 第二轮 init 时它们已存在、根本不会进 plan，只按 plan 重建 manifest 就等于把它们
  // 从归属记录里除名——remove 之后这三个文件留在原地，而输出还宣称"退出干净"。
  const prevFiles = new Map(((prev && prev.files) || []).map((f) => [f.path, f]));
  const files = plan.map((p) => {
    const old = prevFiles.get(p.rel);
    if (old && old.action === 'create') return { path: p.rel, action: 'create', sha256: old.sha256 ?? null };
    return { path: p.rel, action: p.action, sha256: p.action === 'conflict' ? null : sha256(p.content) };
    // action=merge 的文件是用户原有的（我们只追加 scripts），remove 不删它
  });
  const inPlan = new Set(plan.map((p) => p.rel));
  for (const old of prevFiles.values()) {
    if (inPlan.has(old.path) || old.action !== 'create') continue;
    files.push({ path: old.path, action: 'create', sha256: old.sha256 ?? null });
  }

  const manifest = {
    version: 4, // v4：generated 由生成器声明归属；新增 foreign（安装前就存在、永不删）
    status: 'pending',
    created_at: (prev && prev.created_at) || new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    updated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    template: { path: relative(target, TEMPLATE) || null, note: '以本仓库为模板（harness-builder v1）' },
    files,
    // 先沿用上次的生成物清单，build 完成后再换成生成器回报的准确清单
    generated: (prev && Array.isArray(prev.generated) ? prev.generated : []).filter((g) => typeof g === 'string'),
    foreign: (prev && Array.isArray(prev.foreign) ? prev.foreign : []).filter((p) => typeof p === 'string'),
    notes,
  };
  // 先落 pending：中途崩溃时 manifest 已在，remove 仍能按记录退出（不会留下无主文件）
  writeAtomic(assertWritableUnder(target, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');

  let created = 0;
  for (const p of plan) {
    if (p.action !== 'create' && p.action !== 'merge') continue;
    const abs = assertWritableUnder(target, p.rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeAtomic(abs, p.content);
    created++;
  }
  console.log(`  已写入 ${created} 个文件`);

  // build 之前快照生成物目录：build 会覆盖同名文件，原内容只有此刻还读得到。
  const preGen = snapshotFiles(target, GENERATED);

  // 接线收口：build/doctor 任何一步失败都记为 buildFailed，安装状态与退出码必须如实反映——
  // "没过 doctor 的安装"如果 exit 0，调用方会把坏现场当成功继续用（评审 P1）。
  let buildFailed = false;
  const buildList = []; // 生成器声明写出的文件（相对目标根的路径）
  const noReport = [];
  if (plan.some((p) => p.rel === 'harness.config.json' && p.action === 'conflict')) {
    buildFailed = true;
    notes.push('harness.config.json 已存在且不同（conflict）：未覆盖，跳过 build——先人工合并配置');
    console.log('  ! harness.config.json 冲突，跳过 build；合并后到目标仓库跑 npm run build:agents && npm run build:hooks');
  } else {
    mkdirSync(join(target, '.ai'), { recursive: true });
    const steps = [
      { script: 'scripts/build-agents.mjs', report: '.ai/.build-agents.files.json' },
      { script: 'scripts/build-hooks.mjs', report: '.ai/.build-hooks.files.json' },
      { script: 'scripts/doctor.mjs', report: null },
    ];
    for (const { script, report } of steps) {
      const argv = report ? [script, '--manifest', report] : [script];
      const r = spawnSync('node', argv, { cwd: target, encoding: 'utf8' });
      const tail = String(r.stdout || r.stderr).trim().split('\n').slice(-3).join('\n    ');
      console.log(`  $ node ${script} → exit ${r.status}\n    ${tail}`);
      if (r.status !== 0) {
        buildFailed = true;
        notes.push(`node ${script} 退出码 ${r.status}——看上方输出修`);
      }
      if (report) {
        const abs = join(target, report);
        const listed = readBuildManifest(abs);
        if (listed) buildList.push(...listed);
        else noReport.push(script);
        try { rmSync(abs, { force: true }); } catch { /* 回报文件删不掉不影响结论 */ }
      }
    }
  }

  // 归属：生成器说它写了什么，就记什么。**绝不按目录扫描认领**——扫出来的东西里
  // 有用户自己的 .claude/commands/deploy.md，记成我们的就等于 remove 时删用户的文件，
  // 而 hash 保护救不了它（hash 是对用户文件算的，天然"未改动"）。
  const declared = new Set(buildList.map((p) => p.split('\\').join('/')));
  if (noReport.length === 0 && declared.size > 0) {
    // 正常路径：归属以生成器声明为准
  } else {
    // 生成器没回报（旧版本脚本 / 回报文件写失败 / build 被跳过）→ 退回扫描，
    // 但同时说明这个口径分不清归属，remove 前必须人工看一眼。扫描结果仍算"我们的"，
    // 否则上次装好的文件会被误判成 user 的东西、remove 反而删不掉。
    for (const p of GENERATED.flatMap((g) => listFilesUnder(target, g))) declared.add(p);
    notes.push(`生成器未回报文件清单（${noReport.join('、') || 'build 未执行'}）：归属改用目录扫描推断，可能包含用户自己的文件——remove 前先核对 manifest.generated`);
  }
  manifest.generated = [...declared].filter((p) => existsSync(join(target, p))).sort()
    .map((p) => ({ path: p, sha256: hashFileSync(join(target, p)) }));

  // 外来文件：build 之前就存在、且不是生成器产出的东西。它们是用户的（手写命令、既有
  // settings.json 的旁支文件、旧版装的东西），remove 永不删。
  const foreign = new Set(manifest.foreign);
  for (const p of preGen.keys()) if (!declared.has(p)) foreign.add(p);
  manifest.foreign = [...foreign].filter((p) => !declared.has(p) && existsSync(join(target, p))).sort();

  // 被覆盖：build 之前存在、build 之后内容变了 → 原内容进备份区，让"覆盖"可恢复。
  // 这里必须点名，因为 .ai/writes.json、.claude/settings.json 被覆盖是全局性的，
  // 用户不看日志根本不会发现自己那份配置没了。
  const overwritten = [];
  for (const [p, before] of preGen) {
    if (before === null || !declared.has(p)) continue;
    const after = hashFileSync(join(target, p));
    if (after !== null && after !== sha256(before)) overwritten.push(p);
  }
  if (overwritten.length) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    for (const p of overwritten) {
      const dest = join(target, '.ai/backup', stamp, p);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, preGen.get(p));
    }
    notes.push(`build 覆盖了 ${overwritten.length} 个安装前已存在的文件（原内容已备份到 .ai/backup/${stamp}/）：${overwritten.join('、')}`);
  }

  manifest.status = buildFailed ? 'incomplete' : 'complete';
  manifest.updated_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  manifest.notes = notes;
  writeAtomic(assertWritableUnder(target, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');

  for (const n of notes) console.log(`  · ${n}`);
  if (buildFailed) {
    console.error('\n  ! 安装未完成（manifest.status=incomplete）：build/doctor 有失败，或 harness.config.json 冲突。');
    console.error('    修复后到目标仓库重跑 init（幂等，不会覆盖你的文件），或手工 npm run build:agents && npm run build:hooks。');
    process.exitCode = 1;
    return;
  }
  console.log('\n四周节奏（agents.enabled 已保证第 1 周的只读子集可一键配置）：');
  console.log('  1. 只读 agent（rs/adr/sr）+ 模板 + guard_state；2. CI 门禁 + 第一条来自真实事故的规则；');
  console.log('  3. coder（L1 只出草稿）+ 栈 skill；4. retro + 月度体检。');
}

/* ------------------------------- remove ------------------------------- */

function readManifest(target) {
  const p = join(target, MANIFEST);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { corrupt: true };
  }
}

function cmdRemove(target, opts) {
  const { dryRun, yes, force } = opts;
  const m = readManifest(target);
  if (!m) die(`没有 ${MANIFEST}——不知道装过什么，拒绝盲删（方案 §6：绝不 glob 批量删）`);
  if (m.corrupt) die(`manifest 无法解析（先人工核对再删）`);

  const notes = [];
  if (m.status === 'pending' || m.status === 'incomplete') notes.push(`manifest 状态是 ${m.status}：上次安装未完成，按现有记录清理（可能残留少量未记录文件，人工核对）`);

  // 外来文件：安装前就存在、不是本工具建的东西（v4 起记录）。它们可能还留在生成物目录里，
  // 但归属不是我们的——删了就是删用户的东西。
  const foreign = new Set(((m.foreign || []).filter((p) => typeof p === 'string')));
  if ((m.version || 0) < 4) notes.push('manifest 是旧版（无 foreign 记录）：只保护 hash 能证明未改过的文件；如担心误删用户既有文件，先重跑一次 init 再 remove');

  const victims = [];
  for (const f of m.files || []) {
    if (f.action !== 'create') continue; // skip/conflict 的文件不是我们写的，留下
    if (NEVER_REMOVE.some((n) => f.path === n || f.path.startsWith(n + '/'))) continue;
    if (f.path === MANIFEST) continue;
    victims.push({ path: f.path, sha256: f.sha256 || null });
  }
  for (const g of m.generated || []) {
    // v3 起生成物条目带安装时 hash（{path, sha256}）；旧版是裸路径字符串——
    // 无 hash 的条目在下方按"改过"保护，绝不盲删（评审 P1）。
    const e = typeof g === 'string' ? { path: g, sha256: null } : g;
    if (!e || typeof e.path !== 'string') continue;
    if (foreign.has(e.path)) continue;
    const abs = join(target, e.path);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      // 旧版 manifest（v1 早期）把目录当生成物：绝不递归删，否则连带用户自加的文件。
      notes.push(`manifest 里的 ${e.path} 是目录（旧版格式）：跳过，重跑 init 后 manifest 会升级成文件清单再清理`);
      continue;
    }
    if (NEVER_REMOVE.some((n) => e.path === n || e.path.startsWith(n + '/'))) continue;
    victims.push({ path: e.path, sha256: e.sha256 || null });
  }

  const existing = victims.filter((v) => existsSync(join(target, v.path)));
  // 判"安装后被改过"：hash 不符 = 改过。**没有 hash 可比对（旧版 manifest）或读失败，同样按改过保护**——
  // 宁可误保留让人 --force，不可把用户改过的文件静默删掉（评审 P1：sha256 为 null 曾被当成"没改过"直接删）。
  const modified = existing.filter((v) => {
    if (v.sha256 === null || v.sha256 === undefined) return true;
    try { return sha256(readFileSync(join(target, v.path), 'utf8')) !== v.sha256; } catch { return true; }
  });
  // 路径上有 symlink 的条目：跳过并说明，不中断整场卸载。
  // 把 .claude/commands 链到 dotfiles 仓库是合法用法；die 会删一半停下，
  // 而错误信息还写着"拒绝写入"（这里是删，不是写）。
  const linked = [];
  const removable = [];
  for (const v of existing) {
    const linkAt = symlinkInPath(target, v.path);
    if (linkAt) { linked.push({ path: v.path, at: linkAt }); continue; }
    removable.push(v);
  }

  console.log(`[harness] remove ${target}${dryRun ? '（dry-run）' : yes && (force || !modified.length) ? '' : '（预览）'}`);
  for (const v of existing) console.log(`  - ${v.path}${modified.some((x) => x.path === v.path) ? '  ! 安装后被改过' : ''}`);
  console.log(`  永不触碰：${NEVER_REMOVE.join('、')}；非本工具创建的文件一概不动（只删 manifest 列出的文件）`);
  if (foreign.size) console.log(`  用户既有文件（v4 foreign 记录，永不删）：${[...foreign].join('、')}`);
  // 按 symlink 根聚合：同一个链接下几十个文件不该刷几十行
  const byLink = new Map();
  for (const l of linked) byLink.set(l.at, (byLink.get(l.at) || 0) + 1);
  for (const [at, n] of byLink) {
    console.log(`  ! ${at}/ 是 symlink：其下 ${n} 个文件跳过不删（删到链接指向的外部内容不是卸载的意思）`);
  }
  for (const n of notes) console.log(`  · ${n}`);

  if (modified.length && !force) {
    console.log(`\n  ! ${modified.length} 个文件在安装后被修改过（或来自无 hash 的旧版 manifest）：${modified.map((v) => v.path).join('、')}`);
    console.log('    这些改动可能是你的活，盲目删会丢。确认要删就加 --force（或先自行备份）；');
    console.log('    旧版 manifest 的条目重跑一次 init 即可补上 hash，之后 remove 就能精确识别。');
    if (!dryRun) {
      // 明确非零退出：给了 --yes 却一个文件都没删，如果 exit 0，脚本会当成"卸载完成"。
      console.log('    本次未删除任何文件（exit 2）。');
      process.exitCode = 2;
    }
    return;
  }
  if (dryRun || !yes) return;

  let removed = 0;
  for (const v of removable) {
    const abs = assertWritableUnder(target, v.path);
    rmSync(abs, { force: true });
    removed++;
    // 只回收因此变空的目录：遇到非空立刻停，绝不递归删
    let dir = dirname(v.path);
    while (dir && dir !== '.' && dir !== '/') {
      const dAbs = join(target, dir);
      try {
        if (!statSync(dAbs).isDirectory() || readdirSync(dAbs).length > 0) break;
        rmdirSync(dAbs); // 目录必须 rmdirSync：rmSync 非递归删目录会 ERR_FS_EISDIR
      } catch { break; }
      dir = dirname(dir);
    }
  }
  rmSync(assertWritableUnder(target, MANIFEST), { force: true });
  // 有跳过项时不能说"干净"——那正是"把声明当门禁"的反面：输出必须与现场一致。
  if (linked.length) {
    console.log(`  已删除 ${removed} 项 + ${MANIFEST}；${linked.length} 项因 symlink 保留，请人工确认。`);
  } else {
    console.log(`  已删除 ${removed} 项 + ${MANIFEST}。退出干净，欢迎回来。`);
  }
}

/* ------------------------------- resume ------------------------------- */

/**
 * 任务恢复 —— 把"停在门禁上等人"的状态接回来。
 *
 * 为什么必须有这个动词：状态机停在 blocker 上是**正确**行为，但此前没有任何工具
 * 帮人从那里继续。真实项目（TDC 第一个任务）停在 adr、8 条决策等人裁决，
 * 用户回来后只能手工改 state.json —— 而手改正是门禁最该防的动作（漏 resolved_by、
 * 忘了重跑 gate、把 stage 直接推到下一阶段）。resume 把人肉操作变成一条可复查的命令。
 *
 * 三件事，且只做这三件：
 *   1. 报清现状：阶段、待决 blocker（带选项与建议）、可立即开工的 TODO；
 *   2. 回填决策：`--decide D1=<选择> --by <人>`（能力/环境类阻断用 `--resolve B1=<怎么解决的>`），
 *      缺 --by 一律拒绝（无记名决策 = 幽灵决策）；
 *   3. 重跑可机器判的门禁：决策齐备 → 该检查转 pass，无未决 blocker 且 TODO 校验通过 → 推进阶段。
 *
 * 不做的：不替你选（选项是人的事）、不改产物正文（ADR 表格的书面记录归人）、
 * 不跳过 gate（推进必须真的满足条件）。
 */
// 阶段链不自留一份：STAGE_NEXT 从 hooks/lib/verify.mjs 引入（单源）。
// 此前它长在这里，而 init-harness.sh 另造了 `stage:"intake"`——链上的判据和
// 建任务时写的值各说各话，新任务第一天就站在状态机之外。

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function listOpenTasks(tasksDir) {
  if (!existsSync(tasksDir)) return [];
  const out = [];
  for (const e of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(tasksDir, e.name, 'state.json');
    if (!existsSync(p)) continue;
    try {
      const st = JSON.parse(readFileSync(p, 'utf8'));
      out.push({ slug: e.name, state: st });
    } catch {
      out.push({ slug: e.name, state: null });
    }
  }
  return out;
}

/** 决策算不算"真回填"：三件缺一不可（选了什么、谁定的、什么时候）。 */
function decisionComplete(b) {
  return b.resolved === true && typeof b.decision === 'string' && b.decision.trim() !== '' && typeof b.resolved_by === 'string' && b.resolved_by.trim() !== '';
}

/**
 * options 归一化成 {id,label}，id 从 1 起、与打印顺序一致。
 *
 * 起因（TDC 第一个任务）：屏幕上印的是 `选项：磁盘/存储 · CPU · 内存 · …`，
 * 要输入的却是 `--decide "D1=磁盘/存储+CPU+内存"` —— 人得先在脑子里把 `·` 拆开、
 * 再用 `+` 拼成另一个串。显示格式和输入格式不同构，每一步都在制造出错机会。
 * 现在两边共用同一份编号：看到的 1/2/3 就是填回去的 1/2/3。
 */
function optionList(b) {
  const raw = Array.isArray(b.options) ? b.options : [];
  return raw.map((o, i) =>
    typeof o === 'string' ? { id: String(i + 1), label: o } : { id: String(o.id ?? i + 1), label: String(o.label ?? '') }
  );
}

/**
 * 分档：要人现在定 / 可以先干再定 / 按建议默认即可。
 * **只认显式字段，不猜**——从 recommendation 文本里推断"这条能不能缓"是语义判断，
 * 猜错了就是拿机器的臆测替代人的授权。没标就一律进"必须定"（宁可多问一句）。
 */
function triage(b) {
  if (b.defer_until || b.blocking === false) return 'defer';
  if (b.default_ok === true) return 'default';
  return 'block';
}

const TRIAGE_LABEL = {
  block: '一、必须现在决定',
  defer: '二、可以先干再定',
  default: '三、按建议默认即可（不同意才改）',
};

/**
 * 把人的写法解析成选项 id。
 * 接受：编号（`1,2` / `1 2` / `1、2`）、完整选项文本（整体匹配优先）。
 * 拒绝：既不是编号也不匹配任何选项的自由文本 —— 那会让选项表形同虚设（失效点 §16 枚举不闭合）。
 */
function parseDecision(b, raw) {
  const opts = optionList(b);
  const input = String(raw == null ? '' : raw).trim();
  if (!opts.length) return { ids: [], text: input, error: null };
  const byId = new Map(opts.map((o) => [o.id, o]));

  // 整体匹配优先：有些选项本身含 `+` / `/` / 空格（如「客户级默认 + 实例级覆盖」），
  // 先按分隔符切会把它碎掉。
  const whole = opts.find((o) => o.label === input);
  if (whole) return { ids: [whole.id], text: whole.label, error: null };

  const tokens = input.split(/[,，、\s+]+/).filter(Boolean);
  const ids = [];
  const unknown = [];
  for (const t of tokens) {
    if (byId.has(t)) ids.push(t);
    else {
      const hit = opts.find((o) => o.label === t);
      if (hit) ids.push(hit.id);
      else unknown.push(t);
    }
  }
  if (unknown.length) {
    return {
      error: `「${unknown.join('、')}」不是合法选项。合法写法：${opts.map((o) => `${o.id}. ${o.label}`).join(' ／ ')}`,
    };
  }
  if (ids.length === 0) return { error: '没有解析出任何选项' };
  const uniq = [...new Set(ids)];
  if (!b.multi && uniq.length > 1) {
    return { error: `这是单选（multi 未置 true），只能填一个；收到 ${uniq.length} 个：${uniq.join('、')}` };
  }
  return { ids: uniq, text: uniq.map((i) => byId.get(i).label).join(' + '), error: null };
}

/** application 记录：把解析结果写进 blocker。decision 存可读文本（旧字段兼容），
 *  decision_ids 存机器可判的编号（新判据只认这个）。 */
function applyDecision(b, ids, text, by) {
  b.resolved = true;
  b.resolved_at = nowIso();
  b.resolved_by = by;
  b.decision = text;
  b.decision_ids = ids;
}

/**
 * 渲染决策单。停点的信息本来就齐（问题/选项/建议/证据四要素都在 state.json 里），
 * 但 JSON 没人读、stdout 关掉就没。落成一份 markdown 才能留存、转发、隔天再定。
 */
function renderDecisionsMd(slug, state, target) {
  const deciders = (state.blockers || []).filter((b) => b.type === 'human_decision');
  const open = deciders.filter((b) => !decisionComplete(b));
  const groups = { block: [], defer: [], default: [] };
  for (const b of open) groups[triage(b)].push(b);

  const L = [];
  L.push(`# 待决事项 · ${slug}`);
  L.push('');
  L.push('<!-- harness:decisions v1 本文件由 `harness-cli resume` 生成，可自由编辑；填好的部分会被读回 state.json -->');
  L.push('');
  L.push(`生成于 ${nowIso()}｜阶段 \`${state.stage}\`${STAGE_NEXT[state.stage] ? `（下一阶段 \`${STAGE_NEXT[state.stage]}\`）` : ''}｜待决 ${open.length} 项`);
  L.push('');
  L.push('**怎么填**：在每条的 `回填：` 后面写选项编号，多选用逗号分隔（例：`1,3`）；单选写一个编号。');
  L.push('可以直接在编辑器里改、也可以发给同事一起看。填完运行：');
  L.push('');
  L.push('```');
  L.push(`node scripts/harness-cli.mjs resume . ${slug} --from DECISIONS.md --by <你的名字>`);
  L.push('```');
  L.push('');
  L.push('只想全按建议来：`--accept-suggested --by <你的名字>`（只作用于第三节，第一、二节仍逐条填）。');
  L.push('');

  if (!open.length) {
    L.push('_当前没有待决事项。_');
    L.push('');
    return L.join('\n');
  }

  for (const key of ['block', 'defer', 'default']) {
    const list = groups[key];
    if (!list.length) continue;
    L.push('---');
    L.push('');
    L.push(`## ${TRIAGE_LABEL[key]}（${list.length} 项）`);
    L.push('');
    const hint = {
      block: '这几条不填，下一阶段进不去。每条都给了建议和依凭，多数情况照建议填编号即可。',
      defer: '有前置条件，先把前置做完再回来定；现在不挡路。',
      default: '建议本身就是安全默认，同意就 `--accept-suggested` 一次批掉。',
    }[key];
    L.push(`> ${hint}`);
    L.push('');
    for (const b of list) {
      L.push(`### ${b.id} ${b.question || '(未写问题)'}`);
      L.push('');
      const opts = optionList(b);
      if (opts.length) {
        L.push(`- 选项${b.multi ? '（多选）' : '（单选）'}`);
        for (const o of opts) L.push(`  - [ ] \`${o.id}\` ${o.label}`);
      }
      if (b.recommendation) L.push(`- 建议：${b.recommendation}`);
      if (b.defer_until) L.push(`- 前置：${b.defer_until} 完成后再定`);
      const ev = (b.evidence || []).slice(0, 4);
      if (ev.length) {
        L.push('- 依凭');
        for (const e of ev) L.push(`  - ${e}`);
      }
      L.push(`- 回填：${'_'.repeat(16)}`);
      L.push('');
    }
  }

  const others = (state.blockers || []).filter((b) => b.type !== 'human_decision' && !b.resolved);
  if (others.length) {
    L.push('---');
    L.push('');
    L.push(`## 附：非决策类阻断（${others.length} 项，本文件填不了）`);
    L.push('');
    L.push('> 这类要补能力或换会话，不是"选一个"能解决的。');
    L.push('');
    for (const b of others) {
      L.push(`### ${b.id} ${b.question || ''}`);
      L.push('');
      if (b.remediation) {
        L.push(`- 补什么：${b.remediation.missing || '—'}｜谁：${b.remediation.who || '—'}｜重跑：${b.remediation.rerun || '—'}`);
      }
      L.push('');
    }
  }
  return L.join('\n');
}

/** 读回决策单。只认两处：`回填：<内容>` 与 `- [x] \`<编号>\`` —— 结构越小越不会解析错。 */
function parseDecisionsMd(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^#{2,4}\s+([A-Za-z]+-?\d+)\b\s*(.*)$/);
    if (h) {
      cur = { id: h[1], checks: [], fill: null };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const t = line.match(/^[\s>*-]*回填[：:]\s*(.*)$/);
    if (t) {
      const v = t[1].replace(/[_＿*]/g, '').trim();
      if (v) cur.fill = v;
      continue;
    }
    const c = line.match(/^\s*-\s*\[[xX]\]\s*`?([^`\s]+)`?/);
    if (c) cur.checks.push(c[1]);
  }
  return out.filter((x) => x.fill || x.checks.length);
}

/** adr 阶段唯一可机器判的检查：决策记录齐备。其余检查保持原样（判不了的不假装判）。 */
function recheckAdrHumanDecisions(state) {
  const checks = ((state.gate_result && state.gate_result.checks) || []).slice();
  const idx = checks.findIndex((c) => c && c.name === 'adr_human_decision_records');
  if (idx < 0) return null;
  const pending = (state.blockers || []).filter((b) => b.type === 'human_decision' && !decisionComplete(b));
  checks[idx] = pending.length
    ? { name: 'adr_human_decision_records', pass: false, detail: `${pending.map((b) => b.id).join('/')} 仍无人工决策记录（decision + resolved_by 都要有）` }
    : { name: 'adr_human_decision_records', pass: true, detail: '决策记录齐备' };
  state.gate_result = { ...(state.gate_result || {}), last_check: nowIso(), stage: state.stage, checks };
  return checks[idx].pass;
}

function cmdResume(target, slug, opts) {
  const tasksDir = join(target, '.ai/tasks');

  if (!slug) {
    const tasks = listOpenTasks(tasksDir);
    if (!tasks.length) die(`没有任务可恢复：${tasksDir} 下没有 state.json（先 bash scripts/init-harness.sh <slug> 建档）`, 64);
    console.log(`[harness] resume ${target} —— ${tasks.length} 个任务`);
    let pending = 0;
    for (const t of tasks) {
      if (!t.state) { console.log(`  ! ${t.slug}  state.json 无法解析`); pending += 1; continue; }
      const open = (t.state.todos || []).filter((x) => x.status !== 'completed' && x.status !== 'done').length;
      const blockers = (t.state.blockers || []).filter((b) => !b.resolved);
      if (t.state.stage !== 'done' && blockers.length) pending += 1;
      console.log(`  · ${t.slug}  stage=${t.state.stage || '?'}  未完成 TODO ${open}  未决 blocker ${blockers.length}`);
    }
    console.log(`\n逐条处理：node scripts/harness-cli.mjs resume ${target} <slug>`);
    return pending ? 3 : 0;
  }

  const statePath = join(tasksDir, slug, 'state.json');
  if (!existsSync(statePath)) die(`任务不存在：${statePath}`, 64);
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (e) {
    die(`${statePath} 不是合法 JSON：${e.message}（先修文件，resume 不会替你重写）`, 64);
  }
  state = migrate(state).state;

  const blockers = state.blockers || [];
  /** 决策单路径：固定放在任务目录里，与 state.json 同级、一起入库。 */
  const mdAbs = join(tasksDir, slug, 'DECISIONS.md');

  console.log(`[harness] resume ${slug}`);
  console.log(`  stage  ${state.stage}${STAGE_NEXT[state.stage] ? `（下一阶段 ${STAGE_NEXT[state.stage]}）` : ''}  ·  ${(state.todos || []).length} 个 TODO`);

  // ---- 产物索引（提示性，不参与判定） ----
  // artifacts 只回答"产物在哪"，不回答"产物够不够"（后者归 stage gate）。
  // 所以这里只列路径与存在性：缺了提示、形状怪了提示，都不改 exit code——
  // 把声明当门禁会给出"路径存在=产物合格"的假安全感（失效点 §15）。
  {
    const idx = artifactIndex(state, target);
    if (idx.entries.length || idx.odd.length) {
      const missing = idx.entries.filter((e) => e.exists === false);
      console.log(
        `  产物索引  ${idx.entries.filter((e) => e.exists === true).length}/${idx.entries.filter((e) => e.exists !== null).length} 存在` +
          (missing.length ? `（缺 ${missing.length}）` : '')
      );
      for (const e of idx.entries) {
        if (e.path === null) continue;
        console.log(`    ${e.exists ? '·' : '!'} ${e.key.padEnd(14)} ${e.path}`);
      }
      if (missing.length) console.log('    ! 缺的产物先按目录约定找（docs/0x-*/、.ai/tasks/<slug>/artifacts/），找到后把实际路径写回 artifacts');
      for (const o of idx.odd) {
        console.log(`    ! artifacts.${o.key} 是 ${o.type}，不是路径 —— 索引只收路径；说明性内容请放 meta.notes（本提示不改写你的 state）`);
      }
    }
  }

  // ---- 回填 ----
  // --decide 只作用于 human_decision（人拍的板）；
  // --resolve 作用于其余 blocker（能力缺失/环境问题），同样必须记名——
  // 否则"能力阻断"会变成一句谁也说不清什么时候消失的备注。
  const dirty = [];
  const record = (b, ids, text, kind) => {
    if (decisionComplete(b) && b.decision !== text) {
      die(
        `${b.id} 已有结论「${b.decision}」（${b.resolved_by}）。改结论请显式给出新的 --${kind} ${b.id}=<内容> 并说明理由，resume 不会静默改写已生效的记录`,
        64
      );
    }
    applyDecision(b, ids, text, opts.by);
    dirty.push(`${b.id}=${text}`);
  };
  const fill = (specs, kind) => {
    for (const spec of specs) {
      const eq = spec.indexOf('=');
      if (eq <= 0) die(`--${kind} 需要 <id>=<内容> 形式，收到：${spec}`, 64);
      const id = spec.slice(0, eq).trim();
      const value = spec.slice(eq + 1).trim();
      if (!value) die(`--${kind} ${id}= 没有给内容`, 64);
      const b = blockers.find((x) => x.id === id);
      if (!b) die(`没有 id 为 ${id} 的 blocker（现有：${blockers.map((x) => x.id).join('、') || '无'}）`, 64);
      if (kind === 'decide' && b.type !== 'human_decision') {
        die(`${id} 不是待裁决决策（type=${b.type}）——能力/环境类阻断用 --resolve ${id}=<怎么解决的>`, 64);
      }
      if (kind === 'resolve' && b.type === 'human_decision') {
        die(`${id} 是要人拍板的决策（type=human_decision）——用 --decide ${id}=<选择> 记录，别用 --resolve 混过去`, 64);
      }
      if (kind === 'decide') {
        // 决策必须落在选项表内：否则 options 只是装饰，机器无法判断"人到底选了啥"（§16）。
        const parsed = parseDecision(b, value);
        if (parsed.error) die(`${id} ${parsed.error}`, 64);
        record(b, parsed.ids, parsed.text, 'decide');
      } else {
        record(b, [], value, 'resolve');
      }
    }
  };
  fill(opts.decide, 'decide');
  fill(opts.resolve, 'resolve');

  // ---- 从决策单读回 ----
  // 载体从"一次 stdout"变成"一份可留存的文件"：能入库、能转发、能在手机上改、能隔天再填。
  if (opts.from) {
    const fromAbs = existsSync(opts.from)
      ? opts.from
      : existsSync(join(target, opts.from))
        ? join(target, opts.from)
        : join(target, '.ai/tasks', slug, opts.from);
    if (!existsSync(fromAbs)) die(`决策单不存在：${fromAbs}`, 64);
    const entries = parseDecisionsMd(readFileSync(fromAbs, 'utf8'));
    if (!entries.length) {
      die(`${fromAbs} 里没有任何已填的「回填：」或勾选项——先把它填了再读，空单读进来等于什么都没说`, 64);
    }
    for (const e of entries) {
      const b = blockers.find((x) => x.id === e.id);
      if (!b) {
        console.log(`  ! 决策单里的 ${e.id} 在 state 里不存在，跳过（单子过期了？重跑 resume 会重新生成）`);
        continue;
      }
      if (b.type !== 'human_decision') {
        console.log(`  ! ${e.id} 是非决策类阻断，决策单填不了它，跳过`);
        continue;
      }
      const raw = e.fill || e.checks.join(',');
      const parsed = parseDecision(b, raw);
      if (parsed.error) die(`${e.id} ${parsed.error}`, 64);
      record(b, parsed.ids, parsed.text, 'decide');
    }
  }

  // ---- 批量接受建议 ----
  // 只作用于第三节（default_ok=true）：有安全默认、且 blocker 作者显式授权过。
  // 第一、二节必须逐条填——批量批掉"需要你拍板"的事，等于把授权自己给自己。
  if (opts.acceptSuggested) {
    const except = new Set(opts.except || []);
    for (const b of blockers) {
      if (b.type !== 'human_decision' || decisionComplete(b)) continue;
      if (triage(b) !== 'default') continue;
      if (except.has(b.id)) continue;
      if (!b.recommendation) {
        console.log(`  ! ${b.id} 标了 default_ok 却没有 recommendation，无法按建议接受，留给你手填`);
        continue;
      }
      const parsed = parseDecision(b, b.recommendation);
      if (parsed.error || !parsed.ids.length) {
        // 建议文本映射不到选项，说明这条没有"机器可判的默认值"。
        // 以前这里退化成"记自由文本 + decision_ids: []"，于是批量接受成了绕过枚举校验的后门：
        // 前面 --decide 严、--accept-suggested 松，同一个字段两种口径（§16）。
        console.log(
          `  ! ${b.id} 的 recommendation 映射不到任何选项（${parsed.error || '没解析出编号'}）—— 这条留给你手填，不给假默认`
        );
        continue;
      }
      record(b, parsed.ids, parsed.text, 'decide');
    }
    if (!dirty.length) console.log('  （没有可批量接受的项：第三节为空，或都已定过）');
  }


  // ---- 报告待决项（回填之后重新算：刚回填的那几条不该再出现在"待裁决"里） ----
  // 分三档呈现，不按数组顺序平铺：8 条同权铺开的结果是"这么多，回头再说"，
  // 停点就失效了。人真正要先想的通常只有 2–3 条。
  const openNow = blockers.filter((b) => !b.resolved);
  const decisions = openNow.filter((b) => b.type === 'human_decision');
  const others = openNow.filter((b) => b.type !== 'human_decision');
  const groups = { block: [], defer: [], default: [] };
  for (const b of decisions) groups[triage(b)].push(b);

  if (decisions.length) {
    for (const key of ['block', 'defer', 'default']) {
      const list = groups[key];
      if (!list.length) continue;
      console.log(`\n  ${TRIAGE_LABEL[key]}（${list.length} 项）：`);
      for (const b of list) {
        console.log(`   ${b.id}  ${b.question}`);
        const opts = optionList(b);
        if (opts.length) console.log(`        ${b.multi ? '多选' : '单选'}：${opts.map((o) => `${o.id}. ${o.label}`).join('   ')}`);
        if (b.recommendation) console.log(`        建议：${b.recommendation}`);
        if (b.defer_until) console.log(`        前置：${b.defer_until} 完成后再定`);
        for (const e of (b.evidence || []).slice(0, 2)) console.log(`        依凭：${e}`);
      }
    }
    if (groups.default.length) {
      console.log(`\n  批量处理：node scripts/harness-cli.mjs resume <项目> ${slug} --accept-suggested --by <你的名字>${' '}`);
      console.log(`  逐条处理：填 ${relative(target, mdAbs) || mdAbs} 的「回填：」行，再 --from DECISIONS.md`);
    } else {
      console.log(`\n  逐条处理：填 ${relative(target, mdAbs) || mdAbs} 的「回填：」行，再 --from DECISIONS.md`);
    }
  }
  if (others.length) {
    console.log(`\n  非决策类阻断 ${others.length} 项（决策单填不了，需补能力或换会话后重跑）：`);
    for (const b of others) {
      console.log(`   ${b.id}  ${b.question}`);
      if (b.remediation) console.log(`        补什么：${b.remediation.missing || '—'}；谁：${b.remediation.who || '—'}；重跑：${b.remediation.rerun || '—'}`);
    }
  }

  // ---- 可开工清单：blocked_by 全部已解（决策解了 / TODO 完成） ----
  const resolvedIds = new Set(blockers.filter((b) => b.resolved).map((b) => b.id));
  const doneTodos = new Set((state.todos || []).filter((t) => t.status === 'completed' || t.status === 'done').map((t) => t.id));
  const readyNow = (state.todos || []).filter(
    (t) =>
      t.status !== 'completed' &&
      t.status !== 'done' &&
      (t.blocked_by || []).every((d) => resolvedIds.has(d) || doneTodos.has(d))
  );
  console.log(`\n  可立即开工：${readyNow.length ? readyNow.map((t) => `${t.id}(${t.stack})`).join(' ') : '无——依赖未解或已全部完成'}`);

  // ---- 机器可判的门禁 ----
  // 顺序有讲究：adr 的决策检查先按"回填后的 state"刷新，再算 gate 结论。
  // 反过来就会出现同一个进程里自相矛盾——刚把决策填完，报告里还是上一轮的 fail。
  if (state.stage === 'adr') recheckAdrHumanDecisions(state);

  const problems = [];
  // 收尾判据单独一列：它不是"校验失败"，而是"还没到推进的时候"。
  // impl 进行中本来就该有 pending/doing——把它算成失败会让每一次中途 resume 都报红，
  // 而报红多了人就学会无视（比不报更糟）。
  let closure = [];
  try {
    problems.push(...checkStage(state));
    problems.push(...validateTodos(state.todos || [], target, { mode: 'local' }));
    problems.push(...checkStageExit(state));
    problems.push(...checkTaskTraceability(state, target));
    closure = checkStageTodoClosure(state);
  } catch (e) {
    problems.push({ id: '(task)', rule: 'check', reason: `校验异常：${e.message}` });
  }

  // 门禁结论不能由"推进"这个动作代替：见 stageGate 的注释（P1-1 实测复现过
  // gate=fail 被推成 history.gate=pass）。
  const gate = stageGate(state);

  // 阻断只算"必须现在定"的档：defer_until / default_ok 的项本来就允许先干再定，
  // 把它们也算进阻塞，等于三档分诊白做——屏幕分了档，判定还按一档算。
  const stillOpen = (state.blockers || []).filter((b) => !b.resolved);
  const blockingNow = stillOpen.filter((b) => b.type !== 'human_decision' || triage(b) === 'block');
  const deferredNow = stillOpen.filter((b) => !blockingNow.includes(b));

  const gateReady = gate.evaluated && gate.failed.length === 0;
  const canAdvance =
    blockingNow.length === 0 && problems.length === 0 && closure.length === 0 && gateReady && !!STAGE_NEXT[state.stage];

  if (problems.length) {
    console.log(`\n  机器校验未通过（${problems.length} 项）：\n${formatFailures(problems)}`);
  }
  if (!gate.evaluated) {
    console.log(`\n  门禁未就绪：${gate.reason}`);
  } else if (gate.failed.length) {
    console.log(`\n  门禁未通过（${gate.failed.length} 项）：${gate.reason}。修完重跑该阶段门禁并把结果写回 gate_result.checks。`);
  }
  if (closure.length) {
    // 用判据原文而不是另写一句：同一件事两套措辞，迟早有一处说错。
    console.log(`\n  推进前还差（${closure.length} 项，不挡你看进度，只挡推进）：\n${formatFailures(closure)}`);
  }
  if (blockingNow.length) {
    // 决策与能力分开数：混在一行会让人以为"换个会话就能全解"。
    const dec = blockingNow.filter((b) => b.type === 'human_decision');
    const cap = blockingNow.filter((b) => b.type !== 'human_decision');
    const parts = [];
    if (dec.length) parts.push(`${dec.length} 项待决（${dec.map((b) => b.id).join('、')}）`);
    if (cap.length) parts.push(`${cap.length} 项要补能力（${cap.map((b) => b.id).join('、')}）`);
    console.log(`\n  仍卡在：${parts.join(' ＋ ')}。`);
  }
  if (deferredNow.length) {
    console.log(
      `  可稍后定：${deferredNow.length} 项（${deferredNow.map((b) => b.id).join('、')}）—— 不挡推进，但别忘了回来填。`
    );
  }

  // ---- 落盘 ----
  if (dirty.length) {
    const target2 = assertWritableUnder(target, `.ai/tasks/${slug}/state.json`);
    writeAtomic(target2, JSON.stringify(state, null, 2) + '\n');
    console.log(`\n  已回填：${dirty.join('、')}（决策人 ${opts.by}）`);
  }

  // ---- 刷新决策单（幂等） ----
  // 停完第一次跑 resume 就有单子可填，不用另学一个动词。
  // 但**绝不覆盖人已经填好还没应用的输入**——那是最贵的内容，冲掉一次人就不再用它了。
  const mdPending = (state.blockers || []).filter((b) => b.type === 'human_decision' && !decisionComplete(b));
  if (mdPending.length) {
    const next = renderDecisionsMd(slug, state, target);
    let prev = null;
    if (existsSync(mdAbs)) {
      try {
        prev = readFileSync(mdAbs, 'utf8');
      } catch {
        prev = null;
      }
    }
    const unfilled = prev
      ? parseDecisionsMd(prev).filter((e) => {
          const b = (state.blockers || []).find((x) => x.id === e.id);
          return b && b.type === 'human_decision' && !decisionComplete(b);
        })
      : [];
    if (unfilled.length && !opts.from) {
      console.log(
        `  ! ${relative(target, mdAbs)} 里有你填好但还没应用的 ${unfilled.length} 项（${unfilled.map((e) => e.id).join('、')}）——` +
          `先用 --from DECISIONS.md 读回来；本次没有覆盖你的填写`
      );
    } else if (prev !== next) {
      writeAtomic(assertWritableUnder(target, `.ai/tasks/${slug}/DECISIONS.md`), next);
      console.log(`  · 决策单：${relative(target, mdAbs)}`);
    }
  }

  // ---- 推进 ----
  if (opts.advance && !canAdvance) {
    const why = blockingNow.length
      ? `${blockingNow.length} 个必须现在定的 blocker 未解（${blockingNow.map((b) => b.id).join('、')}）`
      : problems.length
        ? `${problems.length} 项机器校验未过`
        : closure.length
          ? `本阶段还有 ${closure.length} 个 TODO 未收尾（${closure.map((c) => c.id).join('、')}）`
          : !gate.evaluated
          ? `门禁未评估：${gate.reason}`
          : gate.failed.length
            ? `门禁未通过：${gate.reason}`
            : '当前阶段没有下一阶段（已在 done）';
    die(`不能推进：${why}`, 3);
  }
  if (canAdvance && (opts.advance || dirty.length)) {
    const from = state.stage;
    const to = STAGE_NEXT[from];
    const hist = Array.isArray(state.stage_history) ? state.stage_history : [];
    const last = hist[hist.length - 1];
    if (last && last.stage === from && !last.exited_at) {
      last.exited_at = nowIso();
      // 这里的 gate 结论必须是**实际评估出来的**，不是"没报错就算过"。
      last.gate = problems.length || !gateReady ? 'fail' : 'pass';
    }
    hist.push({
      stage: to,
      entered_at: nowIso(),
      exited_at: null,
      gate: 'pending',
      waived_by: null,
      agent: 'harness-cli resume',
      model: null,
      skill_versions: {},
      note: `由 resume 推进（上一阶段 gate=${problems.length || !gateReady ? 'fail' : 'pass'}；阻塞项 0，另有 ${deferredNow.length} 项可稍后定）。下一阶段门禁需在此阶段内重新评估`,
    });
    state.stage_history = hist;
    state.stage = to;
    // 推进后把 gate_result 显式清成「本阶段尚未评估」。
    //
    // 原来的做法是"原样保留上一次检查"——听起来诚实，实际留下了更糟的东西：
    // 新阶段的 state 里躺着**上一阶段**的结论。ci-verify 只在 stage 对不上时报警，
    // 于是 `{stage: adr, checks:[{pass:false}]}` 跟着任务漂到 impl，没人知道 impl 到底评没评。
    // TDC 那份 state 就是这么来的（stage=impl，gate_result.stage=adr），最后靠人手清。
    //
    // 清成空 checks 而不是写 pass：工具不能替人补一次没跑过的检查，那正是 §15。
    // stageGate() 对空 checks 的判词是"尚未评估"，这才是真的状态。
    state.gate_result = {
      stage: to,
      last_check: null,
      checks: [],
      note: `由 resume 从 ${from} 推进；本阶段门禁尚未评估`,
    };
    writeAtomic(assertWritableUnder(target, `.ai/tasks/${slug}/state.json`), JSON.stringify(state, null, 2) + '\n');
    console.log(`\n  → 推进：${from} → ${to}。本阶段门禁已清空（未评估），下一步按 ${to} 的门禁准备产物并写回 gate_result。`);
    return 0;
  }

  if (canAdvance) console.log(`\n  条件已满足，加 --advance 推进到 ${STAGE_NEXT[state.stage]}。`);
  // "可稍后定"的项不再影响退出码：三档分诊的意义就是让第二节不挡路。
  // 但机器校验未过仍返回 3——那是失败，不是待办。
  return blockingNow.length || problems.length ? 3 : 0;
}

/* ----------------------------- review-packet ----------------------------- */

/**
 * 评审包 —— 给审核人「该看什么」，不是「改了什么」。
 *
 * 背景：PR 的 diff 对代码有用，对文档基本是噪声。一段需求被重写，diff 显示删 40 行
 * 加 45 行，审核人得自己脑补语义，于是评审退化成翻两页点批准。真正缺的是三件事：
 * 缺什么（首版）、哪几节被动过（改版）、该谁来签。
 *
 * 输出 markdown，可直接贴进 PR 描述。它不写 state、不落任何文件——生成物每次都能重算，
 * 没有"报告过期"这个状态要维护。
 */

/** 该谁签：审核人分离时，最贵的成本是"审核人不知道该看哪里"。 */
const DOC_REVIEWERS = {
  rs: '业务/产品 owner + 测试负责人（可测性）',
  fs: '技术负责人 + 实现方（能不能落地）+ 测试',
  wbs: '实现方 + 测试（各任务能否独立验证）',
};

/** git 单次调用；失败返回 null——非 git 仓库、无历史都属于"判不了"，不假装判。 */
function gitOut(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/** 定稿版本的 pin：git blob sha。它是可复现的事实（`git cat-file -p` 能验证），不是自造哈希。 */
function blobOf(repo, rel) {
  const sha = (gitOut(repo, ['hash-object', '--', rel]) || '').trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : '—';
}

function commitList(repo, rel, n = 3) {
  const out = gitOut(repo, ['log', `-n${n}`, '--date=short', '--format=%h|%an|%ad|%s', '--', rel]);
  return (out || '').trim() ? out.trim().split('\n') : [];
}

/**
 * 最近一次提交动过哪些小节。
 *
 * 只认"标题行有增删"是不够的：文档评审里最常见的改动是**在某一节里补内容**，
 * 标题一个字都没变。所以按 hunk 的新起始行号反查它落在哪一节——这才是审核人
 * 真正需要的"哪几节被动过"。
 *
 * 行号归节只在 sha === HEAD 时可靠（否则新文件的行号与那个 commit 对不上，
 * 会把改动算到隔壁小节）。对不上就退化成只报标题变化，不猜。
 */
function touchedSections(repo, rel, sha, text) {
  const diff = gitOut(repo, ['show', '--unified=0', '--format=', sha, '--', rel]);
  if (!diff) return [];

  const heads = [];
  text.split('\n').forEach((line, i) => {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) heads.push({ line: i + 1, title: m[1] });
  });
  const head = (gitOut(repo, ['rev-parse', 'HEAD']) || '').trim();
  const aligned = head.startsWith(sha);

  const sectionAt = (ln) => {
    let hit = null;
    for (const h of heads) {
      if (h.line <= ln) hit = h;
      else break;
    }
    return hit ? hit.title : '文首';
  };

  const out = new Set();
  for (const line of diff.split('\n')) {
    const mh = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?/.exec(line);
    if (mh) {
      if (!aligned) continue;
      const start = Number(mh[1]);
      const count = mh[2] === undefined ? 1 : Number(mh[2]);
      if (count === 0) out.add(sectionAt(Math.max(1, start)));
      for (let i = 0; i < count; i++) out.add(sectionAt(start + i));
      continue;
    }
    const mt = /^[+-]##\s+(.+?)\s*$/.exec(line);
    if (mt) out.add(mt[1]);
  }
  return [...out];
}

function cmdReviewPacket(target, slug, opts) {
  const tasksDir = join(target, '.ai/tasks');
  if (!existsSync(tasksDir)) die(`没有任务目录：${tasksDir}（先 bash scripts/init-harness.sh <slug>）`, 64);

  if (!slug) {
    const tasks = listOpenTasks(tasksDir);
    if (!tasks.length) die(`没有任务：${tasksDir} 下没有 state.json`, 64);
    console.log(`[harness] review-packet ${target} —— ${tasks.length} 个任务`);
    let pending = 0;
    for (const t of tasks) {
      if (!t.state) {
        console.log(`  ! ${t.slug}  state.json 无法解析`);
        continue;
      }
      let state;
      try {
        state = migrate(t.state).state;
      } catch (e) {
        console.log(`  ! ${t.slug}  ${e.message}`);
        continue;
      }
      const fails = checkCompleteness(state, target);
      const miss = missingDeclarations(state);
      if (fails.length) pending += 1;
      console.log(
        `  · ${t.slug.padEnd(30)} stage=${String(state.stage).padEnd(10)} 待补 ${fails.length}  未登记 ${miss.map((d) => d.label).join('/') || '—'}`
      );
    }
    console.log(`\n出完整评审包：node scripts/harness-cli.mjs review-packet ${target} <slug>`);
    return pending ? 1 : 0;
  }

  const statePath = join(tasksDir, slug, 'state.json');
  if (!existsSync(statePath)) die(`任务不存在：${statePath}`, 64);
  let state;
  try {
    state = migrate(JSON.parse(readFileSync(statePath, 'utf8'))).state;
  } catch (e) {
    die(`${statePath} 不是合法 JSON 或 schema 不可迁移：${e.message}`, 64);
  }

  const kinds = docKinds();
  const failures = checkCompleteness(state, target);
  const missing = missingDeclarations(state);
  const byDoc = new Map();
  for (const f of failures) {
    if (!byDoc.has(f.id)) byDoc.set(f.id, []);
    byDoc.get(f.id).push(f);
  }

  const rows = [];
  for (const k of kinds) {
    const p = declaredPathOf(state, k.key);
    const isPath = p && !/\s/.test(p) && !/[\u4e00-\u9fa5]/.test(p);
    if (!isPath) {
      rows.push({
        label: k.label,
        path: null,
        blob: '—',
        verdict: missing.some((m) => m.key === k.key) ? '**未登记**' : '未产出',
        first: null,
      });
      continue;
    }
    const exists = existsSync(resolve(target, p));
    const commits = exists ? commitList(target, p) : [];
    const fails = byDoc.get(k.label) || [];
    rows.push({
      label: k.label,
      path: p,
      blob: exists ? blobOf(target, p) : '—',
      verdict: exists ? (fails.length ? `✗ ${fails.length} 项待补` : '✓ 完备') : '**文件不存在**',
      // 首版判据不是 version 号（人编的），而是"这份文件在历史里有没有上一版"
      first: exists ? commits.length <= 1 : null,
      commits,
    });
  }
  const isFirst = opts.first || rows.every((r) => r.first !== false);

  const L = [];
  const push = (s = '') => L.push(s);
  push(`## 评审包 · ${slug}（${isFirst ? '首版' : '变更'}）`);
  push();
  push(
    `阶段 \`${state.stage}\`${STAGE_NEXT[state.stage] ? ` → \`${STAGE_NEXT[state.stage]}\`` : ''}` +
      ` · 档位 ${(state.meta && state.meta.flow_tier) || '?'} · 风险 ${(state.meta && state.meta.risk_tier) || '?'}`
  );
  push();
  push('### 产物与版本');
  push();
  push('| 产物 | 路径 | blob | 结论 |');
  push('|---|---|---|---|');
  for (const r of rows) push(`| ${r.label} | ${r.path ? '`' + r.path + '`' : '—'} | ${r.blob} | ${r.verdict} |`);

  push();
  push('### 待补（机器可判）');
  push();
  if (failures.length) {
    for (const f of failures) push(`- **${f.id}** \`[${f.rule}]\` ${f.reason}`);
  } else {
    push('无 —— 章节齐全、无占位符残留、覆盖闭合。');
    push('');
    push('> 这只说明「写全了」，不说明「写对了」。判内容归人。');
  }

  if (!isFirst) {
    push();
    push('### 本版改动');
    push();
    let any = false;
    for (const r of rows) {
      if (!r.commits || !r.commits.length) continue;
      any = true;
      const [sha, who, when, ...rest] = r.commits[0].split('|');
      push(`- \`${r.label}\` 最近一次：\`${sha}\` ${when} ${who} — ${rest.join('|')}`);
      const text = readFileSync(resolve(target, r.path), 'utf8');
      const secs = touchedSections(target, r.path, sha, text);
      if (secs.length) push(`  - 动过的小节：${secs.map((s) => `§${s}`).join('、')}`);
      const dirty = (gitOut(target, ['status', '--porcelain', '--', r.path]) || '').trim();
      if (dirty) push(`  - 未提交：\`${dirty.split('\n')[0]}\``);
    }
    if (!any) push('- 工作树里还没有可比较的历史（首版尚未入库）——按首版审。');
    push();
    push('> 行级 diff 不在这里复述（见 PR 页面）。这节只回答「哪几节被动过」，语义判断仍需人看。');
  }

  push();
  push('### 该谁签');
  push();
  for (const r of rows) {
    if (!r.path) continue;
    push(`- ${r.label}：${DOC_REVIEWERS[r.label.toLowerCase()] || '—'}`);
  }

  const openBlockers = (state.blockers || []).filter((b) => !b.resolved);
  if (openBlockers.length) {
    push();
    push('### 待决');
    push();
    for (const b of openBlockers) {
      const q = String(b.question || b.desc || b.what || b.reason || '').slice(0, 90);
      push(`- \`${b.id}\` [${b.type}] ${q}`);
    }
  }

  console.log(L.join('\n'));
  return failures.length ? 1 : 0;
}

/* -------------------------------- main -------------------------------- */

const args = process.argv.slice(2);
const cmd = args[0];
// 每个动词显式声明自己接受的 flag：拼错/不支持的 flag 直接 usage，
// 不能让它被当成 positional 静默吞掉（--stack-dir svc-a 就曾这样把目录当参数丢掉）。
const VALUE_FLAGS = { analyze: ['--out', '--max-edges'], init: ['--agents', '--stack-dir'], resume: ['--by', '--from', '--except'] };
const BOOL_FLAGS = { detect: ['--json'], analyze: ['--in-project', '--full-edges'], init: ['--dry-run'], remove: ['--dry-run', '--yes', '--force'], resume: ['--advance', '--accept-suggested'], 'review-packet': ['--first'] };
const valueFlags = new Set(VALUE_FLAGS[cmd] || []);
const boolFlags = new Set(BOOL_FLAGS[cmd] || []);
const flags = new Set();
const values = {};
const positional = [];
/** --decide / --resolve 都可重复（一次给多条），因此单独收集，不能走"一个 flag 一个值"的 values。 */
const decides = [];
const resolves = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--decide' || a === '--resolve') {
    if (cmd !== 'resume') { console.error(`[harness] ${a} 只用于 resume`); usage(); }
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) { console.error(`[harness] ${a} 需要 <id>=<内容>`); usage(); }
    (a === '--decide' ? decides : resolves).push(v);
  } else if (valueFlags.has(a)) {
    // 下一个 token 是另一个 flag 说明这个开关漏了值：`init t --stack-dir --dry-run`
    // 会把 --dry-run 当成目录名吞掉，dry-run 于是静默失效——与拼错 flag 同型。
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) {
      console.error(`[harness] ${a} 需要一个值`);
      usage();
    }
    values[a] = v;
  } else if (a.startsWith('--')) {
    if (!boolFlags.has(a)) { console.error(`[harness] 未知或不适用当前子命令的 flag：${a}`); usage(); }
    flags.add(a);
  } else positional.push(a);
}

switch (cmd) {
  case 'check': process.exit(cmdCheck(safeTarget(positional[0], true))); break;
  case 'detect': cmdDetect(safeTarget(positional[0], true), flags.has('--json')); break;
  case 'analyze': cmdAnalyze(safeTarget(positional[0], true), values['--out'], flags.has('--in-project'), flags.has('--full-edges') ? 0 : (values['--max-edges'] !== undefined ? Number(values['--max-edges']) : undefined)); break;
  case 'init': cmdInit(safeTarget(positional[0]), { dryRun: flags.has('--dry-run'), agentsMode: values['--agents'] || 'full', stackDir: values['--stack-dir'] || null }); break;
  case 'remove': cmdRemove(safeTarget(positional[0]), { dryRun: flags.has('--dry-run'), yes: flags.has('--yes'), force: flags.has('--force') }); break;
  case 'resume': {
    // 决策必须记名：无记名决策事后无法追责，也无法区分"人拍的板"和"模型自己认的"。
    const writing = decides.length || resolves.length || values['--from'] || flags.has('--accept-suggested');
    if (writing && !values['--by']) {
      console.error('[harness] 回填决策/阻断必须带 --by <决策人>：无记名记录等于没有记录');
      usage();
    }
    if (writing && !values['--by'].trim()) {
      console.error('[harness] --by 不能为空');
      usage();
    }
    process.exit(
      cmdResume(safeTarget(positional[0], true), positional[1] || null, {
        decide: decides,
        resolve: resolves,
        by: (values['--by'] || '').trim(),
        advance: flags.has('--advance'),
        from: values['--from'] || null,
        acceptSuggested: flags.has('--accept-suggested'),
        except: (values['--except'] || '').split(',').map((s) => s.trim()).filter(Boolean),
      })
    );
    break;
  }
  case 'review-packet': {
    process.exit(cmdReviewPacket(safeTarget(positional[0], true), positional[1] || null, { first: flags.has('--first') }));
    break;
  }
  default: usage();
}
