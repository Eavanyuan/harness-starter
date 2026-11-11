/**
 * init —— 把模板仓库装进目标项目。
 *
 * 安全内核（方案 §6/§7 的 v1 子集；remove 侧的执行同样受这些约束）：
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
  readdirSync, readFileSync, writeFileSync, existsSync, lstatSync, mkdirSync, rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename, relative } from 'node:path';
import { walk, detectStacks, detectBuildRoots, suggestStacksConfig } from '../analyzer.mjs';
import { TEMPLATE, MANIFEST, die, assertWritableUnder, sha256, hashFileSync, writeAtomic, readManifest, preflight, printPreflight } from './shared.mjs';

const READ_ONLY_AGENTS = ['orchestrator', 'requirement-analyst', 'tech-selector', 'spec-reviewer'];

/** 随模板复制的目录与单文件。生成物（.claude/.zcode/prompts）不复制——目标侧自己 build。 */
const TEMPLATE_DIRS = ['agents', 'hooks', 'scripts', 'templates', '.skills', 'test', 'guides'];
const TEMPLATE_FILES = ['harness.config.json', 'harness.rules.json', 'AGENTS.md', '.ai/rules/verification.md', '.ai/state.example.json'];
/** build 产物（init 后由目标侧 build 生成；安装完成后展开成**文件清单**写入 manifest）。 */
const GENERATED = [
  '.claude/agents', '.claude/commands', '.claude/settings.json',
  '.zcode/agents', '.zcode/commands', '.zcode/config.json',
  'prompts/agents', 'prompts/commands', 'prompts/INDEX.md', '.ai/writes.json',
];
const SKIP_FILES = new Set(['.DS_Store']);

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
  // 声明了就必须在：`existsSync` 守卫原来是"有就拷、没有就算了"，
  // 于是发布包漏了某个数据文件时，init 一路绿灯装完，落地项目第一条命令才发现读不到配置。
  // 缺文件是**发布包残缺**，不是"这个项目不需要它"——在安装这一步就红，比在消费方红便宜。
  for (const f of TEMPLATE_FILES) {
    const abs = join(TEMPLATE, f);
    if (!existsSync(abs)) {
      die(`模板仓库不完整，缺少声明在 TEMPLATE_FILES 里的文件：${f}（检查 package.json 的 files 是否漏了它）`);
    }
    out.push({ rel: f, abs });
  }
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

export function cmdInit(target, opts) {
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
