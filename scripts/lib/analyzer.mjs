/**
 * 项目分析引擎 —— 存量项目自检：栈检测、依赖关系图、热点与风险。
 *
 * 零依赖：只做正则级解析与文件系统统计。它产出的是"可复核的事实视图"，
 * 不是"理解了代码"的声明——语义层面的架构判断仍归人（和 RA agent）。
 *
 * 输出契约（方案 §3，消费方按这个读，不要按实现细节读）：
 *   { schema_version, tool, name, root, fileCount, codeCount, buildRoots, stacks,
 *     warnings, evidence, dirStats, hotspots, godFiles, cycles, mermaid, topDirs,
 *     edges: [{from, to}], risks }
 *   - 结构变化必须升 schema_version，消费方遇到未知版本应报错而不是猜
 *   - evidence 记录"这个结论是怎么来的"，便于复核；不是置信度打分
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, extname, resolve } from 'node:path';

/** 分析报告的 JSON 契约版本。字段增删都要升这个数。
 *  v3：evidence 拆出 imports_external / imports_stdlib / unresolved_samples，
 *      新增 edges_truncated；edges 默认上限 5000（--full-edges 取消）。
 *  v2：加 modules / moduleGraph / tableLineage / evidence.java_bases。
 */
export const ANALYSIS_SCHEMA_VERSION = 3;
/** 分析器自身的元数据：方法决定可信度，写进报告让人知道"这是正则，不是索引"。 */
export const ANALYZER = { name: 'harness-analyzer', method: 'regex-import-scan', confidence: 'low' };
/** 构建清单 → 一个"构建根"。有清单才算项目，不以扩展名猜（方案 §3）。 */
export const BUILD_MANIFESTS = [
  'pom.xml', 'package.json', 'go.mod', 'pyproject.toml', 'requirements.txt',
  'setup.py', 'Cargo.toml', 'build.gradle', 'build.gradle.kts',
];

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '.ai', '.claude',
  '.zcode', 'prompts', '.venv', 'venv', '__pycache__', 'coverage', '.idea',
  '.vscode', 'vendor', '.gradle', '.next', '.output', '.turbo',
]);
const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.java', '.py', '.go', '.rs', '.vue', '.php', '.rb']);
const JS_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.vue']);
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.jar', '.woff', '.woff2', '.ttf', '.mp4', '.mp3', '.wasm', '.class', '.so', '.dylib']);

/**
 * 解析目标项目根 .gitignore 的**目录级子集**（“分析可信”批第 0 项，TDasset 实测立项：
 * .worktrees/ 在项目自己的 .gitignore 里写着，分析器硬编码等于重复猜项目已经声明过的话）。
 * 项目说"这不是源码"，探测就当它不存在——比枚举工具目录名可靠，对新工具零改动生效。
 *
 * 诚实边界（有意只实现子集）：只做目录判定、只读根级 .gitignore、不支持 ** 与嵌套文件；
 * 支持：末尾 /、路径锚定（模式含 / 时只匹配根起全路径）、取消否定 !（后匹配者优先，同 git）。
 * 生态级忽略（node_modules/pkg/mod）仍由 IGNORE_DIRS 承担——项目忘了写 .gitignore 也该排。
 */
export function loadGitignoreDirRules(root) {
  const p = join(root, '.gitignore');
  if (!existsSync(p)) return null;
  const rules = [];
  try {
    for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      let negated = false;
      let pat = line;
      if (pat.startsWith('!')) { negated = true; pat = pat.slice(1); }
      pat = pat.replace(/\/+$/, '');
      if (!pat || pat.includes('**')) continue;
      const anchored = pat.includes('/');
      const body = pat.split('/').map((seg) =>
        seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
      ).join('/');
      rules.push({ negated, re: new RegExp(anchored ? `^${body}$` : `^(.*/)?${body}$`) });
    }
  } catch { /* 坏 .gitignore 当作没有 */ }
  return rules;
}

/** 目录是否被 gitignore 规则排除（后匹配优先，同 git 语义的目录级近似）。 */
export function isGitIgnoredDir(rules, relPath) {
  let ignored = false;
  for (const r of rules) {
    if (r.re.test(relPath)) ignored = !r.negated;
  }
  return ignored;
}

/**
 * harness 自己装进项目的文件（`.harness-manifest.json` 的 files 列表）。
 * 它们不是项目代码：一个装了 harness 的项目如果被分析，hooks/*.mjs、scripts/*.mjs
 * 会顶到热点榜与"巨石文件"里，而报告读者以为那是业务代码（TDC 实测 codeCount 虚高）。
 * 用 manifest 而不是"猜目录名"：装到项目根还是 `tools/harness/` 都由 manifest 说了算。
 */
export function harnessInstalledFiles(root) {
  try {
    const m = JSON.parse(readFileSync(join(root, '.harness-manifest.json'), 'utf8'));
    return new Set((m.files || []).filter((f) => f && f.path).map((f) => f.path));
  } catch {
    return new Set(); // 没装过 harness（或 manifest 坏了）：不排除任何文件
  }
}

/** 递归收集文件（带忽略表 + 项目 .gitignore 目录级推导 + harness 安装物），返回相对路径列表。 */
export function walk(root) {
  const out = [];
  const giRules = loadGitignoreDirRules(root);
  const installed = harnessInstalledFiles(root);
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const relDir = relative(root, dir).split('\\').join('/');
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        const childRel = relDir ? `${relDir}/${e.name}` : e.name;
        if (giRules && isGitIgnoredDir(giRules, childRel)) continue;
        if (IGNORE_DIRS.has(e.name)) continue;
        // 测试夹具不是项目代码：harness 自己做进目标项目的 test/fixtures 会被
        // 误当成"多构建根"（里面就有 pom.xml / package.json），第二次 init 就会把配置改烂。
        if (e.name === 'fixtures' && /(^|\/)(tests?|__tests__)$/.test(relDir)) continue;
        // Go 模块缓存（pkg/mod，TDC-Go 实测踩到）：每个依赖里都有自己的 go.mod /
        // package.json / pom.xml，220 个第三方包全被当成构建根，真项目被噪声淹死。
        // 不能整目录忽略 pkg——Go 项目自己的 pkg/ 是常规源码目录；只掐 pkg/mod。
        if (e.name === 'mod' && /(^|\/)pkg$/.test(relDir)) continue;
        // 仓库内 agent 工作树与工具目录（TDasset 实测踩到）：.worktrees/ 里是整个项目的
        // 完整副本（sc-backend/sc-frontend 各一套），根清单全部翻倍；.wolf 是 agent 工具
        // 的自建目录（含自己的 package.json）。两者都不是项目本体。
        if (e.name === '.worktrees' || e.name === '.wolf') continue;
        visit(abs);
      } else if (e.isFile()) {
        const rel = relative(root, abs).split('\\').join('/');
        if (installed.has(rel)) continue; // harness 安装物（见 harnessInstalledFiles）
        out.push(rel);
      }
    }
  };
  visit(root);
  return out;
}

/**
 * 构建根 = 构建清单所在目录（相对路径）。嵌套目录各自成根。
 *
 * 为什么取清单的**完整目录**而不是首段：`services/api/pom.xml` 与
 * `services/web/pom.xml` 按首段都会归并成 `services`，两个服务被静默合并成一个根，
 * 上层就以为这是单栈项目——这是上一版真实存在的漏检。
 */
export function detectBuildRoots(root, files, opts = {}) {
  const roots = new Map();
  for (const f of files) {
    const base = f.split('/').pop();
    if (!BUILD_MANIFESTS.includes(base)) continue;
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
    if (!roots.has(dir)) roots.set(dir, new Set());
    roots.get(dir).add(base);
  }

  // Maven Reactor / npm workspaces 折叠（TDC 实测立项：35 个"构建根"其实是一个
  // 聚合器的子模块，同属一次 `mvn test`）：聚合 pom `<modules>` 声明的目录、
  // workspaces 圈进的目录不算独立构建根——分开报只会制造"多主栈"假象。
  // foldParent 同时留给模块级聚合找"单元"（见 moduleUnits）。
  const foldParent = new Map();
  for (const f of files) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
    if (f.endsWith('pom.xml')) {
      let text = '';
      try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
        foldParent.set(dir === '.' ? m[1] : `${dir}/${m[1]}`, dir);
      }
    } else if (f.endsWith('package.json')) {
      const pkg = readPkg(dir === '.' ? root : join(root, dir));
      const ws = pkg.workspaces && pkg.workspaces.packages ? pkg.workspaces.packages : pkg.workspaces;
      if (!Array.isArray(ws)) continue;
      for (const g of ws) {
        const stem = g.replace(/\/+$/, '').replace(/\*$/, '');
        for (const cand of roots.keys()) {
          if (cand !== dir && stem && cand.startsWith(stem)) foldParent.set(cand, dir);
        }
      }
    }
  }
  if (opts.foldTree) opts.foldTree.foldParent = foldParent;

  return [...roots.entries()]
    .filter(([dir, set]) => {
      if (foldParent.has(dir)) return false; // 被聚合器声明 = 同一构建的组成部分，不是独立根
      // 只有 harness 自己的工具入口（package.json + harness.tooling）不构成构建根
      if (!(set.size === 1 && set.has('package.json'))) return true;
      return !readPkg(dir === '.' ? root : join(root, dir)).tooling;
    })
    .map(([dir, set]) => {
      // 同一个构建根里混着工具入口时也要剔掉：TDC 根有 harness 装的 package.json +
      // 项目自己的 pom.xml，报告里写成"构建根 .（package.json+pom.xml）"，读的人会
      // 以为这是个 Node 项目，而"识别的栈"那行写着 Java/Maven——两处自相矛盾。
      const base = dir === '.' ? root : join(root, dir);
      const manifests = [...set].filter((m) => !(m === 'package.json' && readPkg(base).tooling)).sort();
      return { dir, manifests: manifests.length ? manifests : [...set].sort() };
    })
    .sort((a, b) => (a.dir === '.' ? -1 : b.dir === '.' ? 1 : a.dir.localeCompare(b.dir)));
}

/**
 * 模块单元：每个文件归到"被折叠链上最靠近根的那一级"。
 * tdc-billing/billing → tdc-billing（被 tdc-billing 声明，tdc-billing 再被根声明）；
 * 未被折叠的根自成单元。聚合单元**不是**折叠后的构建根——那会把 reactor 仓折成
 * 1 个模块、模块视图变平凡；tdc-mgmt、tdc-oss 这层才是"跨 4 模块改动"的任务语言。
 */
export function moduleUnits(files, foldParent) {
  const manifestDirs = [];
  for (const f of files) {
    if (!BUILD_MANIFESTS.includes(f.split('/').pop())) continue;
    manifestDirs.push(f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.');
  }
  const unitOfDir = new Map();
  const resolveUnit = (dir) => {
    if (unitOfDir.has(dir)) return unitOfDir.get(dir);
    let unit = dir;
    let cur = dir;
    for (let guard = 0; guard < 32; guard++) {
      const parent = foldParent.get(cur);
      if (!parent) break;
      unit = cur;
      cur = parent;
    }
    unitOfDir.set(dir, unit);
    return unit;
  };
  const fileToUnit = new Map();
  for (const f of files) {
    let best = '';
    for (const d of manifestDirs) {
      // 根目录也必须显式匹配（`d === '.'`）：`f.startsWith('./')` 恒为假，漏掉这一支
      // 会让单模块项目的 modules 恒为空——而那正是最常见的项目形态
      // （java-small 与 harness 自举实测：modules=[]、报告 4.5 节整段消失且无告警）。
      const inDir = d === '.' || f === d || f.startsWith(d + '/');
      if (inDir && d.length > best.length) best = d;
    }
    fileToUnit.set(f, best ? resolveUnit(best) : null);
  }
  return fileToUnit;
}

/** 只生成命令的栈（方案 §3：v1 只为 Java + TS/Vue 生成，其余标记 unsupported）。 */
function supported(id, lang, dir, cmds) {
  return { id, lang, dir, supported: true, ...cmds };
}

/** 识别到但不生成命令：不发明命令，给一句"常见写法是什么、你自己确认"。 */
function unsupported(id, lang, dir, srcGlob, hint) {
  return {
    id, lang, dir, supported: false, srcGlob,
    lint: '', test: '', testOne: '',
    note: `v1 不生成命令（${hint}）；手填 harness.config.json 的 stacks.${id} 后才算接上`,
  };
}

function readPkg(base) {
  try {
    const p = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
    return {
      deps: { ...(p.dependencies || {}), ...(p.devDependencies || {}) },
      scripts: p.scripts || {},
      // harness-cli 自己装进项目的 package.json 只是工具脚本入口，不是项目构建清单。
      // 不认这个标记，第二次 init 就会把 Java 项目重新识别成 Node 栈，配置也被改烂。
      tooling: Boolean(p.harness && p.harness.tooling === true),
    };
  } catch {
    return { deps: {}, scripts: {}, tooling: false };
  }
}

/**
 * Node 系命令从 package.json 推导（scripts → 依赖里的测试运行器 → lockfile 定包管理器），
 * 推不出来就留空并给警告——不发明命令。此前硬编码 npm run lint / test:unit，
 * 项目用 test / vitest / pnpm 时配置一落地就指向不存在的命令（评审 P2）。
 */
function nodeCommands(base, { deps, scripts }) {
  const pm = existsSync(join(base, 'pnpm-lock.yaml')) ? 'pnpm'
    : existsSync(join(base, 'yarn.lock')) ? 'yarn' : 'npm';
  const exec = pm === 'npm' ? 'npx' : `${pm} exec`;
  const run = (s) => (scripts[s] ? `${pm} run ${s}` : '');
  const lint = run('lint');
  const test = run('test:unit') || run('test');
  const runner = ['vitest', 'jest'].find((d) => d in deps) || null;
  const testOne = runner === 'vitest' ? `${exec} vitest run <file>`
    : runner === 'jest' ? `${exec} jest <file>`
    : '';
  const warnings = [];
  if (!test) warnings.push('package.json 无 test/test:unit 脚本，依赖里也没有 vitest/jest —— stacks.test 留空，verify 证据链没有可跑的命令，需手填');
  if (!lint) warnings.push('package.json 无 lint 脚本 —— stacks.lint 留空（确认项目确实不做 lint，或手填）');
  if (test && !testOne) warnings.push('识别不到测试运行器（vitest/jest 都不在依赖里）—— stacks.testOne 需手填');
  return { lint, test, testOne, warnings };
}

/** 单个构建根内的栈识别。 */
function stacksAt(root, files, dir) {
  const base = dir === '.' ? root : join(root, dir);
  const has = (p) => existsSync(join(base, p));
  const prefix = dir === '.' ? '' : dir + '/';
  const inDir = files.filter((f) => prefix === '' || f.startsWith(prefix));
  // 构建清单只在**本目录直属**才成立：pom.xml 用 existsSync 是对的（绝对路径），
  // 但 Gradle 是"扫描文件后缀"，用递归集会把 services/api/build.gradle 算成根目录的栈——
  // 一个只有 package.json 的前端仓库因此被判成 Java/Gradle，生成 `./gradlew test`
  // 这种跑空命令，还会与真实后端撞 id。
  const direct = inDir.filter((f) => !f.slice(prefix.length).includes('/'));
  const stacks = [];

  if (has('package.json')) {
    const { deps, scripts, tooling } = readPkg(base);
    const feHints = ['react', 'vue', 'svelte', 'next', 'nuxt', 'angular', '@angular/core'];
    const beHints = ['express', 'koa', '@nestjs/core', 'fastify', 'hapi'];
    const isFe = feHints.some((h) => h in deps);
    const isBe = beHints.some((h) => h in deps) || !isFe;
    if (!tooling && isFe) {
      stacks.push(supported('frontend', 'TypeScript/JavaScript', dir, {
        srcGlob: '**/*.{ts,tsx,vue,js,jsx}',
        ...nodeCommands(base, { deps, scripts }),
      }));
    }
    if (!tooling && isBe) {
      stacks.push(supported('backend-node', 'Node.js', dir, {
        srcGlob: '**/*.js',
        ...nodeCommands(base, { deps, scripts }),
      }));
    }
  }
  if (has('pom.xml')) {
    stacks.push(supported('backend', 'Java/Maven', dir, {
      srcGlob: '**/*.java', lint: 'mvn -q compile', test: 'mvn -q test', testOne: 'mvn -q test -Dtest=<name>',
    }));
  } else if (direct.some((f) => f.endsWith('.gradle') || f.endsWith('.gradle.kts'))) {
    stacks.push(supported('backend', 'Java/Gradle', dir, {
      srcGlob: '**/*.java', lint: './gradlew compileJava', test: './gradlew test', testOne: './gradlew test --tests <class>',
    }));
  }
  if (has('go.mod')) {
    stacks.push(unsupported('backend-go', 'Go', dir, '**/*.go', 'Go 项目的测试命令随模块布局而异，常见是 go test ./...'));
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    stacks.push(unsupported('backend-py', 'Python', dir, '**/*.py', 'Python 的 lint/test 随工具链而异：pytest / ruff / poetry run …'));
  }
  if (has('Cargo.toml')) {
    stacks.push(unsupported('backend-rust', 'Rust', dir, '**/*.rs', 'Rust 常见是 cargo test / cargo clippy'));
  }
  return stacks;
}

/**
 * 栈检测：以清单文件为准，不以扩展名猜测为准。
 * opts.dir 指定只探测某个构建根（多栈项目里选主栈）；缺省探测所有构建根。
 */
export function detectStacks(root, files, opts = {}) {
  const dirs = opts.dir ? [opts.dir] : detectBuildRoots(root, files).map((r) => r.dir);
  const out = [];
  for (const dir of dirs) out.push(...stacksAt(root, files, dir));
  return out;
}

function countLines(abs) {
  try {
    return readFileSync(abs, 'utf8').split('\n').length;
  } catch {
    return 0;
  }
}

/** JS/TS 相对导入 → 文件（尽力解析，解析失败不计边）。 */
function resolveJs(spec, fromRel, root) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(join(root, fromRel)), spec);
  const rel = () => relative(root, base).split('\\').join('/');
  // 带 extension 的 import（./lib/verify.mjs）先精确匹配——补后缀循环永远碰不到它
  // （实测：harness 自身的 .mjs 相对 import 全被记成 unresolved）。必须 isFile：
  // import './lib' 指向目录时要落到下方 index 解析。
  try {
    if (statSync(base).isFile()) return rel();
  } catch { /* 不存在则走补后缀 */ }
  for (const e of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue']) {
    if (existsSync(base + e)) return rel() + e;
  }
  for (const e of ['.ts', '.tsx', '.js', '.jsx']) {
    if (existsSync(join(base, 'index' + e))) return rel() + '/index' + e;
  }
  return null;
}

const IMPORT_RE = {
  js: /(?:import[\s\S]*?from\s*|export[\s\S]*?from\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g,
  java: /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm,
  py: /^\s*(?:from\s+\.?([\w.]+)\s+import|import\s+([\w.]+))/gm,
};

/**
 * 文件级依赖图：edges.get(from) = Set(to)。
 * stats.unresolved 记录"看起来是内部引用但没解析到文件"的条数——它是这份图可信度的证据：
 * 未解析多，说明布局不常规（或用了别名），关系视图要打折看。
 */
export function buildGraph(root, files) {
  const code = files.filter((f) => CODE_EXTS.has(extname(f)));
  const nodes = new Map(code.map((f) => [f, { lines: countLines(join(root, f)) }]));
  // 仓库里真实存在的目录集合：Python 分支用它区分"内部包没解析到"与"外部包"。
  const pyDirs = new Set();
  for (const f of files) {
    const i = f.lastIndexOf('/');
    if (i > 0) pyDirs.add(f.slice(0, i));
  }
  const edges = new Map();
  const stats = { imports: 0, unresolved: 0, runtimeOnly: 0, stdlib: 0, unresolvedSamples: [] };

  // Java 第一遍（FQN 索引 + 基础包多数派，“分析可信”#1）：
  // 旧版按"简单类名"建索引 + com/org 前缀当内部候选，两处在真实仓库同时翻车——
  // TDC 1.1 万条、TDasset 2.9 万条第三方依赖被计成 unresolved；35 个模块的重名类
  // 互相错连出假环。正解：package 声明推出 FQN 做精确解析；基础包由**本仓 Java 文件
  // 的包前缀多数派**决定（org.apache.* 在别人的仓库里永远不该是"内部"）。
  // 只读文件头 4KB 取 package 行（license 头之后才是 package，4KB 内必有）；
  // 同 FQN 冲突（main/test 同包同名最常见）取 src/main 的。
  const javaFiles = code.filter((x) => x.endsWith('.java'));
  const javaPathSet = new Set(javaFiles); // 判"这个 FQN 在仓里到底有没有文件"
  const fqnToFile = new Map();
  const prefixCount = new Map();
  const PKG_RE = /^package\s+([\w.]+)\s*;/m;
  for (const jf of javaFiles) {
    let head = '';
    try { head = readFileSync(join(root, jf), 'utf8').slice(0, 4000); } catch { continue; }
    const pm = head.match(PKG_RE);
    if (!pm) continue;
    const fqn = `${pm[1]}.${jf.split('/').pop().replace('.java', '')}`;
    const prev = fqnToFile.get(fqn);
    if (!prev || (!prev.includes('/src/main/java/') && jf.includes('/src/main/java/'))) {
      fqnToFile.set(fqn, jf);
    }
    const segs = pm[1].split('.');
    const prefix = segs.slice(0, Math.min(2, segs.length)).join('.');
    prefixCount.set(prefix, (prefixCount.get(prefix) || 0) + 1);
  }
  const minShare = Math.max(1, Math.ceil(javaFiles.length * 0.1));
  let javaBases = [...prefixCount.entries()].filter(([, n]) => n >= minShare).map(([p]) => p);
  if (!javaBases.length && prefixCount.size) {
    javaBases = [[...prefixCount.entries()].sort((a, b) => b[1] - a[1])[0][0]];
  }
  stats.javaBases = javaBases; // 供报告复核：基础包是推导的，亮出来不假装

  // 未解析要留样本：只给一个数字（TDC 2895 条），人和 agent 都无法复核"到底漏了什么"，
  // 也就无法判断这份关系图该打几折。样本取前 10 条，够定位典型布局问题。
  // 第三参直接**传引用原文**而不是 true——传 true 只留下 "(空目标)"，样本等于没有。
  const noteUnresolved = (from, spec) => {
    stats.unresolved++;
    if (stats.unresolvedSamples.length < 10) stats.unresolvedSamples.push({ from, spec: String(spec) });
  };
  const addEdge = (from, to, spec) => {
    if (!to || to === from || !nodes.has(to)) {
      if (spec !== undefined && spec !== null) noteUnresolved(from, spec);
      return;
    }
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };

  // ── Go（#3）：import 按模块前缀解析到包目录内的文件 ──
  // go.mod 的 module 声明 = 内部路径前缀；import "MOD/pkg/x" 的目标 = 目录 pkg/x 下的所有 .go 文件。
  // 不做逐文件精确匹配（Go 是包级 import，不是类级），同一包内取第一个文件作为边的目标。
  const goModules = new Map(); // 构建根目录 → module 前缀
  for (const f of files) {
    if (!f.endsWith('go.mod')) continue;
    try {
      const m = readFileSync(join(root, f), 'utf8').match(/^module\s+(\S+)/m);
      if (m) {
        const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
        goModules.set(dir, m[1]);
      }
    } catch { /* 读不了当没有 */ }
  }
  const resolveGo = (spec) => {
    // 取**最长**的模块前缀：go-small 里根模块是 `tdc-go`、子模块是 `tdc-go/operator`，
    // 按 Map 顺序先命中根模块会把子模块的包解析到错误目录（结果看着像"有边"，其实是错的）。
    const hit = [...goModules.entries()]
      .filter(([, mod]) => spec === mod || spec.startsWith(mod + '/'))
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (!hit) return null;
    const [dir, mod] = hit;
    const rest = spec.slice(mod.length).replace(/^\//, '');
    const pkgPath = dir === '.' ? rest : `${dir}/${rest}`;
    // 包目录下第一个 .go 文件作为边的目标（Go 是包级 import，不是文件级）
    const pkgFile = code.find((c) => c.endsWith('.go') && c.startsWith(pkgPath + '/'));
    return pkgFile || null;
  };

  // ── MyBatis（#4）：mapper XML / 注解 SQL → 表名血缘 ──
  // 两种形态都收：XML namespace 指向 Java 接口 FQN，注解 SQL 在 Java 接口源码里。
  //
  // 只认**语句结构**，不认"文件里出现过 from"：整文件扫字符串会把 @Param("cpu")、
  // @Result(column="gauge")、被注释掉的 SQL 一起算成表名。TDC 实测 112 个"表"里
  // 25 个是列名/参数名（appid / disk / update_time / user / gateway…），占 22%。
  // 血缘的用途是 DB 变更影响面——错表名比没有表名更糟：它漏判真表、误判无关表，
  // 而报告看上去更"完整"了。
  //
  // 引导词分两类，原因是 MySQL 的 `on duplicate key update col` 里有 update 但没有表：
  //   · 写操作只在语句开头成立（`(?:^|;)` + m 标志）
  //   · from / join 可以在语句中间，但后面必须直接跟标识符（`from (select` 天然不匹配）
  // 标识符可能是「反引号包整段」或「反引号包每一段」：TDengine 的
  // `from monitor.`system`` 在只允许首段带引号时会被截成 monitor——
  // 于是"库名"冒充"表名"（TDC 实测 47 条语句都这样）。
  const SQL_IDENT = '`?[a-zA-Z_]\\w*`?(?:\\.`?[a-zA-Z_]\\w*`?)*';
  const TABLE_STMT_RES = [
    new RegExp(`(?:^|;)\\s*(?:insert|replace)\\s+into\\s+(${SQL_IDENT})`, 'gim'),
    new RegExp(`(?:^|;)\\s*update\\s+(${SQL_IDENT})`, 'gim'),
    new RegExp(`(?:^|;)\\s*delete\\s+from\\s+(${SQL_IDENT})`, 'gim'),
    new RegExp(`\\bfrom\\s+(${SQL_IDENT})`, 'gi'),
    new RegExp(`\\bjoin\\s+(${SQL_IDENT})`, 'gi'),
  ];
  const SQL_STOPWORDS = new Set([
    'select', 'where', 'set', 'values', 'dual', 'table', 'the', 'and', 'not', 'as',
    'on', 'is', 'from', 'join', 'left', 'right', 'inner', 'outer', 'update', 'insert',
  ]);
  const mapperToTables = new Map(); // Java 文件 → Set(表名)
  // CTE 名不是表：`WITH RECURSIVE ParentGroups AS (...) ... JOIN ParentGroups` 里
  // 的 ParentGroups 会被 join 规则当成表（TDC 实测），先收集再剔除。
  const cteNames = (sql) => {
    const out = new Set();
    for (const m of sql.matchAll(/\bwith\s+(?:recursive\s+)?([a-z_]\w*)\s*(?:\([^)]*\))?\s*as\s*\(/gi)) out.add(m[1].toLowerCase());
    for (const m of sql.matchAll(/,\s*([a-z_]\w*)\s*(?:\([^)]*\))?\s*as\s*\(/gi)) out.add(m[1].toLowerCase());
    return out;
  };
  const extractTables = (sql) => {
    const tables = new Set();
    const ctes = cteNames(sql);
    for (const re of TABLE_STMT_RES) {
      for (const m of sql.matchAll(re)) {
        const t = m[1].toLowerCase().replace(/`/g, '');
        if (t.length > 2 && !SQL_STOPWORDS.has(t) && !ctes.has(t)) tables.add(t);
      }
    }
    return tables;
  };
  // 注释里的 SQL 不算数：先剥块注释，再剥行注释（`[^:]` 避免把 http:// 当注释起点）。
  const stripJavaComments = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  // 只取 @Select/@Insert/@Update/@Delete 括号内的字面量（覆盖 `"a" + "b"` 与 `{"a","b"}`）。
  const ANNOT_SQL_RE = /@(?:Select|Insert|Update|Delete)\s*\(\s*(\{[^}]*\}|(?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)/g;
  const sqlLiterals = (chunk) => (chunk.match(/"(?:[^"\\]|\\.)*"/g) || []).map((s) => s.slice(1, -1)).join(' ');

  // XML mapper：只取 statement 元素内容，剥注释与标签。
  // 整份 XML 扫会把 <resultMap column=".."> / <if test=".."> 里的词一起算进去。
  // 放宽了原来的"路径含小写 mapper"：MyBatis 的约定是 `XxxMapper.xml`，用 /mapper/i
  // 才算覆盖大小写（`com/foo/Mapper/x.xml` 与 `resources/mapper/` 两种布局都在内）。
  const XML_STMT_RE = /<(select|insert|update|delete)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const f of files) {
    if (!f.endsWith('.xml') || !/mapper/i.test(f)) continue;
    let text;
    try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    const ns = text.match(/<mapper\s+namespace="([^"]+)"/);
    if (!ns) continue; // 不是 mapper XML（只是名字里带 mapper），不认
    const body = text.replace(/<!--[\s\S]*?-->/g, ' ');
    const tables = new Set();
    for (const m of body.matchAll(XML_STMT_RE)) {
      for (const t of extractTables(m[2])) tables.add(t);
    }
    if (tables.size) mapperToTables.set(fqnToFile.get(ns[1]) || f, tables);
  }
  // 注解 SQL：只扫注解括号里的字面量，不扫整文件字符串
  for (const f of code) {
    if (!f.endsWith('.java')) continue;
    let text;
    try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    const stripped = stripJavaComments(text);
    if (!/@(?:Select|Insert|Update|Delete)\s*\(/.test(stripped)) continue;
    const tables = new Set();
    for (const m of stripped.matchAll(ANNOT_SQL_RE)) {
      for (const t of extractTables(sqlLiterals(m[1]))) tables.add(t);
    }
    if (tables.size) {
      const prev = mapperToTables.get(f) || new Set();
      for (const t of tables) prev.add(t);
      mapperToTables.set(f, prev);
    }
  }
  const tableLineage = [...mapperToTables.entries()]
    .map(([file, tables]) => ({ mapper: file, tables: [...tables].sort() }))
    .sort((a, b) => b.tables.length - a.tables.length);

  for (const f of code) {
    let text;
    try {
      text = readFileSync(join(root, f), 'utf8');
    } catch {
      continue;
    }
    const ext = extname(f);
    if (JS_EXTS.has(ext)) {
      for (const m of text.matchAll(IMPORT_RE.js)) {
        const spec = m[1];
        stats.imports++;
        if (!spec.startsWith('.')) { stats.runtimeOnly++; continue; } // 包依赖不在文件图里
        addEdge(f, resolveJs(spec, f, root), spec);
      }
    } else if (ext === '.java') {
      for (const m of text.matchAll(IMPORT_RE.java)) {
        stats.imports++;
        const fqn = m[1];
        // 内部候选 = 命中基础包多数派；其余（含所有第三方）按包依赖记 runtimeOnly
        if (!javaBases.some((b) => fqn === b || fqn.startsWith(b + '.'))) { stats.runtimeOnly++; continue; }
        const target = fqnToFile.get(fqn);
        if (target) { addEdge(f, target, null); continue; }
        // 前缀命中但索引里没有，分两种（这个区分是 TDengine 官方驱动逼出来的）：
        //   · 包目录里**有**这个 .java，只是没建上索引 → 真未解析（布局/解析问题，要修）
        //   · 包目录里**没有**这个类 → 它根本不在这仓里，是第三方（TDC 的
        //     com.taosdata.jdbc.* 是官方 JDBC 驱动，与自家 com.taosdata 同前缀，
        //     旧版把它整批算成 unresolved，把关系图的可信度无谓地压低了）
        // 判据是 Java 的硬约定：包名必须对应目录。通配 import（com.x.*）与静态 import
        // （com.x.Y.method）同样落进"目录里没有"这一类，本来就是外部引用。
        if (javaPathSet.has(fqn.split('.').join('/') + '.java')) noteUnresolved(f, fqn);
        else stats.runtimeOnly++;
      }
    } else if (ext === '.py') {
      for (const m of text.matchAll(IMPORT_RE.py)) {
        const mod = m[1] || m[2];
        if (!mod) continue;
        stats.imports++;
        const rel = mod.split('.').join('/') + '.py';
        if (nodes.has(rel)) { addEdge(f, rel, null); continue; }
        if (nodes.has(rel.replace(/\/__init__\.py$/, '') + '/__init__.py')) {
          addEdge(f, rel.replace(/\/__init__\.py$/, '') + '/__init__.py', null);
          continue;
        }
        // 与 Java 同一原则：仓里连这个包目录都没有，就是外部依赖（requests / json），
        // 不是"没解析到的内部引用"。混在一起会让关系图的可信度被无谓压低。
        if (pyDirs.has(mod.split('.').join('/'))) noteUnresolved(f, mod);
        else stats.runtimeOnly++;
      }
    } else if (ext === '.go') {
      // 只解析 import 声明：`import "x"` / `import alias "x"` / `import ( ... )`。
      // 旧写法按"行首 + 引号"扫全文，函数体里的 `return "a/b"` 也会被当 import
      // （实测确实进了 imports_parsed）：口径被污染，字符串形如模块路径时还会造出假边。
      const specs = [];
      for (const blk of text.matchAll(/^[ \t]*import\s*(?:\(([\s\S]*?)^[ \t]*\)|((?:[\w.]+\s+|[._]\s+)?"[^"]+"))/gm)) {
        const body = blk[1] || blk[2] || '';
        for (const s of body.matchAll(/"([^"]+)"/g)) specs.push(s[1]);
      }
      for (const spec of specs) {
        stats.imports++;
        // 无 / 的是标准库（fmt、os）或单段包名：既不是内部依赖，也不是外部包。
        // 单列计数，否则"外部包 = 总 - 已解析 - 未解析"会把标准库算进外部依赖。
        if (!spec.includes('/')) { stats.stdlib++; continue; }
        const target = resolveGo(spec);
        if (target) addEdge(f, target, spec);
        else stats.runtimeOnly++;
      }
    }
  }
  return { nodes, edges, stats, tableLineage };
}

/** 回边检测：白灰黑 DFS，每个回边展开成一个环（限 5 个，够定位用）。 */
export function findCycles(nodes, edges) {
  const color = new Map();
  const stack = [];
  const cycles = [];
  const dfs = (n) => {
    color.set(n, 1);
    stack.push(n);
    for (const to of edges.get(n) || []) {
      if (!nodes.has(to)) continue;
      const c = color.get(to) || 0;
      if (c === 1 && cycles.length < 5) {
        cycles.push([...stack.slice(stack.indexOf(to)), to]);
      } else if (c === 0 && cycles.length < 5) {
        dfs(to);
      }
    }
    stack.pop();
    color.set(n, 2);
  };
  for (const n of nodes.keys()) {
    if ((color.get(n) || 0) === 0 && cycles.length < 5) dfs(n);
  }
  return cycles;
}

function dirOf(relPath, depth) {
  const parts = relPath.split('/');
  return parts.length <= depth ? parts[0] || '.' : parts.slice(0, depth).join('/');
}

export function analyze(root, opts = {}) {
  const files = walk(root);
  const foldTree = {};
  const buildRoots = detectBuildRoots(root, files, { foldTree });
  const stacks = detectStacks(root, files, opts.dir ? { dir: opts.dir } : {});
  const { nodes, edges, stats, tableLineage } = buildGraph(root, files);

  // 模块级聚合（“分析可信”#2）：文件级图是事实，模块级图是任务语言——
  // “跨 4 个模块的改动”按模块看影响面，比顶层目录贴近 Maven/Gradle 的真实边界。
  const unitOf = moduleUnits(files, foldTree.foldParent || new Map());
  const moduleFiles = new Map();
  for (const f of nodes.keys()) {
    const u = unitOf.get(f);
    if (u !== null && u !== undefined) moduleFiles.set(u, (moduleFiles.get(u) || 0) + 1);
  }
  const moduleEdges = new Map();
  for (const [from, tos] of edges) {
    const a = unitOf.get(from);
    for (const to of tos) {
      const b = unitOf.get(to);
      if (a && b && a !== b) moduleEdges.set(`${a}=>${b}`, (moduleEdges.get(`${a}=>${b}`) || 0) + 1);
    }
  }
  const moduleGraph = [...moduleEdges.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 20)
    .map(([k, weight]) => { const [from, to] = k.split('=>'); return { from, to, weight }; });

  // 目录结构：二级目录 × 代码文件数
  const dirStats = new Map();
  for (const f of nodes.keys()) {
    const d = dirOf(f, 2);
    dirStats.set(d, (dirStats.get(d) || 0) + 1);
  }

  // 热点：被引用最多（in-degree）；巨石文件
  const inDeg = new Map();
  for (const tos of edges.values()) {
    for (const to of tos) inDeg.set(to, (inDeg.get(to) || 0) + 1);
  }
  const hotspots = [...inDeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([f, n]) => ({ file: f, fanIn: n }));
  const godFiles = [...nodes.entries()].filter(([, m]) => m.lines > 500)
    .sort((a, b) => b[1].lines - a[1].lines).slice(0, 10)
    .map(([f, m]) => ({ file: f, lines: m.lines }));
  const cycles = findCycles(nodes, edges);

  // 关系视图：顶层目录间聚合边（mermaid），取度数前 12 个目录
  const dirEdges = new Map();
  for (const [from, tos] of edges) {
    for (const to of tos) {
      const a = dirOf(from, 1);
      const b = dirOf(to, 1);
      if (a === b) continue;
      const k = a + '=>' + b;
      dirEdges.set(k, (dirEdges.get(k) || 0) + 1);
    }
  }
  const dirDeg = new Map();
  for (const [k, n] of dirEdges) {
    const [a, b] = k.split('=>');
    dirDeg.set(a, (dirDeg.get(a) || 0) + n);
    dirDeg.set(b, (dirDeg.get(b) || 0) + n);
  }
  const topDirs = [...dirDeg.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map((e) => e[0]);
  const mermaid = [...dirEdges.entries()]
    .filter(([k]) => k.split('=>').every((d) => topDirs.includes(d)))
    .sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([k, n]) => { const [a, b] = k.split('=>'); return `  ${id(a)} -->|${n}| ${id(b)}`; });

  // 风险清单
  const risks = [];
  const testFiles = files.filter((f) => /(^|\/)(test|tests|__tests__|spec)\//.test(f) || /\.(test|spec)\.[jt]sx?$/.test(f) || /Test\.java$/.test(f) || /_test\.go$/.test(f) || /test_.*\.py$/.test(f));
  const unsupportedStacks = stacks.filter((s) => !s.supported);
  if (nodes.size === 0) risks.push('没有解析到代码文件——确认目录是否正确，或栈不在支持列表（js/ts/java/py/go/rs）');
  if (!testFiles.length && nodes.size > 0) risks.push('未发现测试文件/测试目录——接入 harness 前先补最小测试路径，否则 verify 证据链没有可跑的命令');
  if (cycles.length) risks.push(`发现 ${cycles.length}+ 处循环依赖（详见关系视图），变更影响评估要优先看这里`);
  if (godFiles.length) risks.push(`存在 ${godFiles.length} 个超 500 行的文件，热点文件拆分优先于加流程`);
  if (!buildRoots.length) risks.push('未识别到构建清单（package.json / pom.xml / go.mod / pyproject…），stacks 配置需要手填');
  if (unsupportedStacks.length) risks.push(`${unsupportedStacks.map((s) => s.lang).join('、')} 属于 v1 不生成命令的栈——stacks 需手填，工具不猜`);

  // warnings：不影响事实视图成立、但会改变解读方式的信息（与 risks 区分：risks 是接入建议）
  const warnings = [];
  if (buildRoots.length > 1) {
    warnings.push(`检测到 ${buildRoots.length} 个构建根（${buildRoots.map((r) => r.dir).join('、')}）——v1 的 stacks 只有 backend/frontend 两槽，用 --stack-dir 选主栈`);
  }
  if (stats.unresolved > 0) {
    warnings.push(`${stats.unresolved} 条内部 import 未能解析到文件（别名/动态加载/非常规布局），关系视图按低置信看`);
  }
  // 同 id 的 unsupported 栈聚合成一条（TDasset 实测：12 个 Go 根逐条刷屏，提示没人读得完）
  const notesById = new Map();
  for (const s of stacks) {
    if (!s.note) continue;
    if (!notesById.has(s.id)) notesById.set(s.id, { note: s.note, dirs: [] });
    notesById.get(s.id).dirs.push(s.dir);
  }
  for (const { note, dirs } of notesById.values()) {
    warnings.push(`${dirs.length > 1 ? `${dirs.length} 个构建根（${dirs.slice(0, 4).join('、')}${dirs.length > 4 ? ' 等' : ''}）` : dirs[0]}：${note}`);
  }

  // 明细边的导出上限（说明见 return 里 edges 那段）
  const maxEdges = Number.isFinite(opts.maxEdges) ? opts.maxEdges : 5000;
  const allEdges = [...edges.entries()].flatMap(([from, tos]) => [...tos].map((to) => ({ from, to })));

  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    tool: { name: 'harness-cli', analyzer: ANALYZER.name, method: ANALYZER.method, confidence: ANALYZER.confidence, generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') },
    name: opts.name || root.split('/').pop(),
    root,
    fileCount: files.length,
    codeCount: nodes.size,
    buildRoots,
    // 模块级视图（#2）：文件级图之上按构建模块聚合，每个模块的文件数与模块间边权。
    modules: [...moduleFiles.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([dir, files]) => ({ dir, files })),
    moduleGraph,
    stacks,
    warnings,
    evidence: {
      method: ANALYZER.method,
      // 四个口径互斥且相加等于 imports_parsed：resolved + unresolved + external + stdlib。
      // 旧版用减法推 resolved，"标准库"没有独立位置，只能被算进外部包。
      imports_parsed: stats.imports,
      imports_resolved: stats.imports - stats.unresolved - stats.runtimeOnly - stats.stdlib,
      imports_unresolved: stats.unresolved,
      imports_external: stats.runtimeOnly,
      imports_stdlib: stats.stdlib,
      // 未解析的前 10 条样本：没有样本，2895 这个数字既无法复核，也无法判断该打几折。
      unresolved_samples: stats.unresolvedSamples,
      edges: [...edges.values()].reduce((n, s) => n + s.size, 0),
      java_bases: stats.javaBases || [], // 基础包是多数派推导的——亮出来让人复核，不假装它是事实
      test_files: testFiles.length,
      binaries_skipped: files.filter((f) => BINARY_EXTS.has(extname(f))).length,
      // 装了 harness 的项目：按 manifest 排除的安装物数量。少了这一行，"代码文件数"
      // 会比项目真实规模大，而读者无从知道差在哪。
      harness_files_excluded: harnessInstalledFiles(root).size,
    },
    dirStats: [...dirStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25),
    hotspots,
    godFiles,
    // 表血缘（#4）：mapper 接口/XML → 读写的数据表。DB 迁移类任务的影响面直接可查。
    tableLineage,
    cycles,
    mermaid,
    topDirs,
    // 明细边默认最多 5000 条：TDC 是 8959 条 / 1.9MB，agent 直接 Read 会撑爆上下文，
    // 而结论（热点/环/模块图）都在全量图上算完了，明细只是给人手工追溯用。
    // 截断必须显式标记（edges_truncated），否则"少了几千条"就是伪造的事实视图。
    edges: allEdges.slice(0, maxEdges > 0 ? maxEdges : undefined),
    edges_truncated: maxEdges > 0 && allEdges.length > maxEdges
      ? { kept: maxEdges, total: allEdges.length, note: '要全量明细加 --full-edges；结论字段不受影响' }
      : null,
    risks,
  };
}

/** mermaid 节点 id 消毒。 */
function id(d) {
  return 'n_' + d.replace(/[^A-Za-z0-9]/g, '_');
}

/** 渲染 PROJECT-MAP.md。 */
export function renderMap(r) {
  const L = [];
  L.push('# PROJECT-MAP（harness 自检生成）', '',
    `> 由 \`scripts/harness-cli.mjs analyze\` 生成于 ${new Date().toISOString().slice(0, 10)}。`,
    `> 分析方式：${r.tool.method}（${r.tool.confidence} confidence）——机器统计的**事实视图**，不是架构结论；`,
    '> 语义判断归 requirement-analyst 与人。报告契约 `schema_version` =', `> ${r.schema_version}，字段变化会升版本。`, '');
  L.push('## 1 概览', '',
    `| 项 | 值 |`, `|---|---|`,
    `| 项目名 | ${r.name} |`,
    `| 文件数 / 代码文件数 | ${r.fileCount} / ${r.codeCount} |`,
    `| 构建根 | ${r.buildRoots.length ? r.buildRoots.map((b) => `${b.dir}（${b.manifests.join('+')}）`).join('、') : '（无）'} |`,
    `| 识别的栈 | ${r.stacks.length ? r.stacks.map((s) => `${s.lang}${s.supported ? '' : '（unsupported）'}`).join('、') : '（未识别）'} |`, '');
  if (r.warnings.length) {
    L.push('## 2 解读提示（warnings）', '');
    for (const w of r.warnings) L.push(`- ${w}`);
    L.push('');
  }
  if (r.stacks.length) {
    L.push('## 3 栈与命令', '', '| 栈 | 语言 | 目录 | 支持 | test |', '|---|---|---|---|---|');
    for (const s of r.stacks) L.push(`| ${s.id} | ${s.lang} | \`${s.dir}\` | ${s.supported ? '生成' : '需手填'} | ${s.test ? `\`${s.test}\`` : '—'} |`);
    for (const s of r.stacks) for (const w of s.warnings || []) L.push(`> ⚠ ${s.id}（${s.dir}）：${w}`);
    L.push('');
  }
  L.push('## 4 目录结构（按代码文件数）', '', '| 目录 | 文件数 |', '|---|---|');
  for (const [d, n] of r.dirStats) L.push(`| ${d} | ${n} |`);
  L.push('');
  if ((r.moduleGraph || []).length) {
    L.push('## 5 模块依赖（构建模块聚合，"跨 N 模块改动"的影响面视图）', '',
      '```mermaid', 'graph LR');
    for (const e of r.moduleGraph.slice(0, 20)) {
      L.push(`  ${id(e.from)} -->|${e.weight}| ${id(e.to)}`);
    }
    L.push('```', '',
      '| 模块 | 代码文件数 |', '|---|---|');
    for (const m of (r.modules || []).slice(0, 15)) L.push(`| ${m.dir} | ${m.files} |`);
    L.push('');
  }
  if (r.mermaid.length) {
    // 这一节是**顶层目录**间的边，不是上一节的模块边。原来标题写成"构建模块聚合"，
    // 两个图看起来在说同一件事，实际口径不同（目录 ≠ 构建模块）。
    L.push('## 6 代码关系视图（顶层目录聚合）', '', '```mermaid', 'graph LR');
    L.push(...r.mermaid);
    L.push('```', '');
  }
  if (r.hotspots.length) {
    L.push('## 7 热点（被引用最多，改动先看这里）', '', '| 文件 | 被引用 |', '|---|---|');
    for (const h of r.hotspots) L.push(`| ${h.file} | ${h.fanIn} |`);
    L.push('');
  }
  if (r.godFiles.length) {
    L.push('## 8 巨石文件（>500 行）', '', '| 文件 | 行数 |', '|---|---|');
    for (const g of r.godFiles) L.push(`| ${g.file} | ${g.lines} |`);
    L.push('');
  }
  if ((r.tableLineage || []).length) {
    L.push('## 9 数据表血缘（mapper → 表，DB 迁移/表变更的影响面）', '',
      '| Mapper | 表 |', '|---|---|');
    for (const t of r.tableLineage.slice(0, 15)) {
      L.push(`| ${t.mapper.split('/').pop()} | ${t.tables.join('、')} |`);
    }
    L.push('');
  }
  if (r.cycles.length) {
    L.push('## 10 循环依赖（前 5 处）', '');
    r.cycles.forEach((c, i) => L.push(`${i + 1}. ${c.join(' → ')}`));
    L.push('');
  }
  if (r.risks.length) {
    L.push('## 11 接入 harness 前的风险清单', '');
    for (const x of r.risks) L.push(`- ${x}`);
    L.push('');
  }
  L.push('## 12 证据（口径可复核）', '', '| 项 | 值 |', '|---|---|',
    `| 分析方式 | ${r.evidence.method} |`,
    `| 解析到 import | ${r.evidence.imports_parsed}（内部已解析 ${r.evidence.imports_resolved}，内部未解析 ${r.evidence.imports_unresolved}，外部包 ${r.evidence.imports_external ?? '?'}，标准库 ${r.evidence.imports_stdlib ?? 0}） |`,
    `| 文件级依赖边 | ${r.evidence.edges} |`,
    `| 测试文件 | ${r.evidence.test_files} |`,
    `| 按 manifest 排除的 harness 安装物 | ${r.evidence.harness_files_excluded ?? 0} |`, '');
  if ((r.evidence.unresolved_samples || []).length) {
    // 样本是给人复核用的：看到"都是 import com.xxx.*"就知道是通配 import 没解析，
    // 而不是布局坏了。没有样本时读者只能接受一个数字。
    L.push('### 12.1 未解析样本（前 10 条）', '', '| 文件 | 引用 |', '|---|---|');
    for (const s of r.evidence.unresolved_samples) L.push(`| ${s.from} | \`${s.spec}\` |`);
    L.push('');
  }
  L.push('## 13 建议 harness.config.json 的 stacks 段', '', '```json');
  L.push(JSON.stringify(suggestStacksConfig(r.stacks), null, 2));
  L.push('```', '');
  return L.join('\n');
}

/**
 * 只输出受支持的栈。v2 起输出**数组形态**（`projects`），兼容旧对象（`stacks`）：
 *
 *   v1（双槽对象）:  { "backend": { dir, srcGlob, lint, test, testOne } }
 *   v2（数组）:      [ { id, lang, dir, srcGlob, lint, test, testOne } ]
 *
 * 数组允许同 id 多条（不同构建根的 Go 服务各一条）、跨语言混合（Java + Go + Python 并列）。
 * 兼容层：读 config 时 stacks 和 projects 并存 → 合并处理（doctor/verify/check-skills 等）；
 * 写 config 时 init 产出数组（新项目），已有的对象形态不破坏（老项目无需迁移）。
 */
export function suggestStacksConfig(stacks) {
  return stacks
    .filter((s) => s.supported)
    .map((s) => ({ id: s.id, lang: s.lang, dir: s.dir, srcGlob: s.srcGlob, lint: s.lint, test: s.test, testOne: s.testOne }));
}

/**
 * 从 config（可能是对象或数组）提取全部栈条目为统一数组——所有消费方的唯一入口。
 * 对象形态（v1）按 key 生成 id；数组形态直接透传。返回 [] 表示未配置。
 */
export function allStacks(config) {
  if (!config) return [];
  const p = config.projects;
  if (Array.isArray(p)) return p;
  const s = config.stacks;
  if (!s || typeof s !== 'object') return [];
  return Object.entries(s).map(([id, v]) => ({ id, ...v }));
}
