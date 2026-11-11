/**
 * harness-cli 共享层 —— 各子命令域模块（scripts/lib/cli/*.mjs）共用的常量与工具。
 *
 * 放这里的准入标准：被 ≥2 个域用到，或属于 CLI 表面（die / usage / safeTarget）。
 * 只服务单一子命令的助手留在各自的域模块里，别往这里堆。
 *
 * 注意 TEMPLATE 的层级：本文件在 scripts/lib/cli/ 下，比旧的单文件入口深两级，
 * 所以模板根是 '../../..'（旧入口是 '..'）。init 把 scripts/ 整目录拷进目标项目后，
 * 该相对层级在目标项目里同样成立。
 */
import {
  readdirSync, readFileSync, writeFileSync, existsSync, lstatSync, renameSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk, detectStacks, detectBuildRoots } from '../analyzer.mjs';
// 门禁判据必须与 hook / CI 同源（verify.mjs）：resume 若自己判一遍，
// 就会出现"resume 说能推进、hook 落盘时拦下"的两套口径。
import { isAbandoned } from '../../../hooks/lib/verify.mjs';

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MANIFEST = '.harness-manifest.json';

export function die(msg, code = 1) {
  console.error(`[harness] ${msg}`);
  process.exit(code);
}

export function usage() {
  console.log(`用法:
  node scripts/harness-cli.mjs check <target>
  node scripts/harness-cli.mjs detect <target> [--json]
  node scripts/harness-cli.mjs analyze <target> [--out <dir>] [--in-project]
  node scripts/harness-cli.mjs init <target> [--dry-run] [--agents read-only|full] [--stack-dir <dir>]
  node scripts/harness-cli.mjs remove <target> [--dry-run] [--yes] [--force]
  node scripts/harness-cli.mjs verify <target> [--mode ci|local] [--json] [--file <state.json>]
      统一验证入口：只读磁盘判「状态与证据链」，不依赖任何 CLI 的 hook 载荷。
      所以 cron / post-checkout / worker 的交付前检查都能用同一个判据。
      --mode 必须显式（默认 ci）：local 额外判 72h 新鲜度，ci 只认 git 里可复现的事实。
      --json 输出 {ok,mode,root,checked,problems,notices}，退出码 0 过 / 1 不过 / 2 无法判 / 64 用法错。
  node scripts/harness-cli.mjs resume <target> [<slug>]
      按三档列出待决事项，并生成/刷新 .ai/tasks/<slug>/DECISIONS.md（可留存的决策单）。

  node scripts/harness-cli.mjs runtime <target> --spawn_agents yes|no --shell yes|no --ask_user yes|no [--reset] [--by <名字>]
      把宿主会话的能力自检结论写回 harness.config.json（orchestrator 不再逐会话试错）。
      已知结论不许静默退回 unknown；重置必须 --reset --by 记名。

  node scripts/harness-cli.mjs resume <target> <slug> --from DECISIONS.md --by <决策人>
      读回决策单里填好的「回填：」行。--from 的路径先按当前目录、再按 .ai/tasks/<slug>/ 解析。

  node scripts/harness-cli.mjs resume <target> <slug> --accept-suggested [--except D2,D7] --by <决策人>
      批量接受第三节「按建议默认」的项（只作用于 blocker 显式标了 default_ok 的）。

  node scripts/harness-cli.mjs resume <target> <slug> --decide <id>=<编号> [--resolve <id>=<怎么解决的>] --by <决策人> [--advance]
      逐条回填。--decide 的值必须是选项编号（多选逗号分隔），自由文本会被拒绝。

  node scripts/harness-cli.mjs review-packet <target> [<slug>] [--first]
      输出可直接贴进 PR 的评审包（markdown）。不给 slug 列出全部任务的待补数。
      首版给「缺什么」，改版给「哪几节被动过」+「该谁签」。不写任何文件。
      有机器可判的待补项时退出码 1。「--first」强制按首版口径出包（历史里已有上一版时用）。

  node scripts/harness-cli.mjs abandon <target> <slug> --reason "<为什么不再续跑>" [--by <人>]
      封存：写入 meta.status=abandoned + meta.abandoned{at,by,reason,at_stage,open_todos}。
      **不再续跑 ≠ 工作没做**——对账补登记类任务（产物早已交付）也用它，理由里写清产物在哪。
      stage 保留不动：它是"任务死在哪一阶段"的证据，覆盖掉就答不出流程该不该减重。
      豁免"必须做完"的判据（TODO 收尾、产物登记），不豁免"做过就得有证据"。
      doctor 的停滞判据（gates.staleTaskDays，默认 3 天）就是用这条命令关掉的：
      一条命令能把红变绿，人才不会去学"忽略红灯"。
      退出码：0 成功 / 3 已完成或已封存 / 64 用法错（缺理由、理由太短、slug 不合法）。`);
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
export function safeTarget(raw, allowSelf = false) {
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
export function assertWritableUnder(target, rel) {
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

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** 文件内容 hash；读不了返回 null——remove 对 null 按"无法证明未改动"保护，不盲删。 */
export function hashFileSync(abs) {
  try { return sha256(readFileSync(abs, 'utf8')); } catch { return null; }
}

/** 原子写：先写临时文件再 rename。中途崩溃不会留下被截断的目标文件。 */
export function writeAtomic(abs, content) {
  const tmp = `${abs}.harness-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, abs);
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

export function readManifest(target) {
  const p = join(target, MANIFEST);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { corrupt: true };
  }
}

export function listOpenTasks(tasksDir) {
  if (!existsSync(tasksDir)) return [];
  const out = [];
  for (const e of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(tasksDir, e.name, 'state.json');
    if (!existsSync(p)) continue;
    try {
      const st = JSON.parse(readFileSync(p, 'utf8'));
      // 已封存的不算"待恢复"：resume 列出它是噪音，而噪音会让人不再读这份清单。
      if (isAbandoned(st)) continue;
      out.push({ slug: e.name, state: st });
    } catch {
      out.push({ slug: e.name, state: null });
    }
  }
  return out;
}

/* ------------------------------ preflight ------------------------------ */

/** 运行时前提（方案 §0.1）：Node ≥18 与 bash 是硬依赖，git 缺失只降级。 */
export function preflight(target) {
  const major = Number(process.versions.node.split('.')[0]);
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  const git = spawnSync('git', ['-C', target, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  return {
    node: { ok: major >= 18, version: process.version },
    bash: { ok: bash.status === 0 },
    git: { ok: String(git.stdout).trim() === 'true' },
  };
}

export function printPreflight(pf) {
  console.log(`[harness] 运行时前提`);
  console.log(`  node ${pf.node.version}${pf.node.ok ? '（≥18 ✓）' : '（<18 ✗ —— hook 与脚本全是 .mjs，跑不起来）'}`);
  console.log(`  bash ${pf.bash.ok ? '✓' : '✗ —— init-harness.sh / test/*.sh 需要 bash（Windows 原生请走 WSL）'}`);
  console.log(`  git  ${pf.git.ok ? '✓' : '✗ —— change 基线校验与漂移检测会降级（不阻塞）'}`);
}

/** 构建根清单 + 每个根上的栈。id 撞车说明两个同类服务，v1 装不进 backend/frontend 两槽。 */
export function survey(target) {
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
export function needsStackDir(sv) {
  return sv.roots.length > 2 || sv.duplicateIds.length > 0;
}

export { TEMPLATE, MANIFEST };
