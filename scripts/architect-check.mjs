#!/usr/bin/env node
/**
 * architect-check —— 架构 fitness functions（第一层：机器判据，零成本每次跑）。
 *
 * 五条可度量判据（与 architect.agent.md 审查五维对齐）：
 *   F1 模块边界：resource 层不做业务编排（resource 文件里出现 service 调用过多）
 *   F2 依赖方向：service→service 互调计数（新引入的循环/跨域调用需 ADR 裁决）
 *   F3 复杂度预算：单文件行数（≤2000 黄牌 / ≤3000 红牌，可配置）
 *   F4 配置面：config+rules 键总数（增长超阈值黄牌）
 *   F5 测试时长：上次 verify-run 日志的 wall-clock vs 基线（如有）
 *
 * 退出码：0 全绿；1 有红（F3 红牌级超限）；2 基础设施故障。
 * 黄牌不判红——它们是"architect agent 需要关注"的信号，不是阻断。
 *
 * 用法：node scripts/architect-check.mjs [--root <仓库>] [--json] [--strict] [--include-external]
 *
 * --include-external：连 harness.config.json 里指向仓库外的 projects 一起扫。
 *   默认跳过——外部仓库的存量债会污染本仓库的红黄统计（详见 project 域注释）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv.includes('--root')
  ? resolve(process.argv[process.argv.indexOf('--root') + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_MODE = process.argv.includes('--json');
const STRICT = process.argv.includes('--strict');
// 外部 project（dir 以 .. 开头）默认不扫：它们的存量债不该由本仓库门禁背书。
const INCLUDE_EXTERNAL = process.argv.includes('--include-external');

function die(msg, code = 2) { console.error(`[architect] ${msg}`); process.exit(code); }
function out(line) { if (!JSON_MODE) console.log(line); }

// ---- 配置（可被 harness.config.json architecture 节覆盖） ----
let config = {};
try { config = JSON.parse(readFileSync(join(ROOT, 'harness.config.json'), 'utf8')); } catch { /* 模板态 */ }
const arch = config.architecture || {};
const LIMITS = {
  testFileLineRed: arch.testFileLineRed ?? 8000, // 测试文件天然长，独立红线
  fileLineYellow: arch.fileLineYellow ?? 2000,
  fileLineRed: arch.fileLineRed ?? 3000,
  configKeyGrowthYellow: arch.configKeyGrowthYellow ?? 15, // 较上次 +15 键黄牌
  serviceToServiceMax: arch.serviceToServiceMax ?? 5,     // 单文件 import 其它 Service 上限
};

const findings = [];
function flag(severity, dimension, file, detail) {
  findings.push({ severity, dimension, file, detail });
  const mark = severity === 'red' ? '🔴' : severity === 'yellow' ? '🟡' : '🟢';
  out(`  ${mark} ${dimension} | ${file} | ${detail}`);
}

// ---- project 域：本仓库 vs 外部仓库 ----
// `projects[].dir` 允许指向仓库外（如 ../TDasset），本意是"顺带体检另一个仓库"。
// 但默认不该跑：它把外部仓库的存量债算进本仓库的红黄统计，本地一条也修不了，
// 而 --strict 只拦新增 → 存量永远红、永远免除。实测代价 58.4s / 全量 15.2%。
// 语义澄清：--root 是"根"不是"白名单"——带 --root . 也不会自动排除外部 project，
// 所以 test:architect 表面限定了范围、实际照样全扫，这是名字在骗人。
const isOutside = (dir) => {
  const rel = relative(ROOT, resolve(ROOT, dir));
  return rel.startsWith('..') || isAbsolute(rel);
};
const allProjects = Array.isArray(config.projects) ? config.projects : [];
const projects = INCLUDE_EXTERNAL
  ? allProjects
  : allProjects.filter((p) => !isOutside(p.dir || p.id || '.'));

// ---- F3: 单文件行数（跨全部 projects 源码） ----
out('== F3 复杂度预算 ==');
if (!INCLUDE_EXTERNAL && allProjects.length > projects.length) {
  // 用 id(dir) 而不是纯 dir：backend 与 frontend 可能指向同一个外部仓库，
  // 只打 dir 会出现 "../TDasset, ../TDasset"，看不出跳过了几个 project。
  const skipped = allProjects
    .filter((p) => isOutside(p.dir || p.id || '.'))
    .map((p) => (p.id && p.dir ? `${p.id}(${p.dir})` : p.dir || p.id));
  out(`  ⏭ 跳过 ${skipped.length} 个仓库外 project：${skipped.join(', ')}（外部仓库的存量债不归本仓库门禁管；需要时加 --include-external）`);
}
for (const proj of projects) {
  const srcDir = join(ROOT, proj.dir || proj.id || '.');
  if (!existsSync(srcDir)) continue;
  const srcGlob = proj.srcGlob || '**/*.java';
  const ext = srcGlob.includes('*.java') ? 'java' : srcGlob.includes('*.ts') ? 'ts' : 'vue';
  try {
    const files = execFileSync('find', [srcDir, '-name', `*.${ext}`, '-not', '-path', '*/target/*', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.zwork/*'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const f of files) {
      try {
        const lines = readFileSync(f, 'utf8').split('\n').length;
        const isTest = f.includes('/test/') || f.includes('/__tests__/');
        const redLine = isTest ? LIMITS.testFileLineRed : LIMITS.fileLineRed;
        if (lines >= redLine) flag('red', 'F3', relative(ROOT, f), `${lines} 行 ≥ ${isTest ? '测试' : ''}红线 ${redLine}`);
        else if (!isTest && lines >= LIMITS.fileLineYellow) flag('yellow', 'F3', relative(ROOT, f), `${lines} 行 ≥ 黄线 ${LIMITS.fileLineYellow}`);
      } catch { /* 读不了的跳过 */ }
    }
  } catch { /* find 失败跳过 */ }
}
out(`  （黄线 ${LIMITS.fileLineYellow}，红线 ${LIMITS.fileLineRed}）`);

// ---- F4: 配置面键总数 ----
out('== F4 配置面 ==');
function countKeys(obj, prefix = '') {
  let count = 0;
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith('$')) continue; // $comment 不算
    count++;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) count += countKeys(v);
  }
  return count;
}
let configKeys = 0;
try { configKeys = countKeys(JSON.parse(readFileSync(join(ROOT, 'harness.config.json'), 'utf8'))); } catch {}
let rulesKeys = 0;
try { rulesKeys = countKeys(JSON.parse(readFileSync(join(ROOT, 'harness.rules.json'), 'utf8'))); } catch {}
const totalKeys = configKeys + rulesKeys;
out(`  配置键总数：${totalKeys}（config ${configKeys} + rules ${rulesKeys}）`);
// 基线比对（如有 architecture.lastKeyCount）
if (arch.lastKeyCount && totalKeys - arch.lastKeyCount > LIMITS.configKeyGrowthYellow) {
  flag('yellow', 'F4', 'harness.config+rules', `${totalKeys} 键，较上次 ${arch.lastKeyCount} 增长 ${totalKeys - arch.lastKeyCount}（> ${LIMITS.configKeyGrowthYellow}）`);
}

// ---- F1: resource 层业务编排（Java 项目） ----
out('== F1 模块边界 ==');
for (const proj of projects) {
  const resourceDir = join(ROOT, proj.dir || '.', 'src/main/java');
  if (!existsSync(resourceDir)) continue;
  try {
    const files = execFileSync('rg', ['-l', 'service\\.', resourceDir, '--glob', '*/resource/*.java'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
    for (const f of files) {
      try {
        const content = readFileSync(f, 'utf8');
        const serviceCalls = (content.match(/Service\s+\w+|service\.\w+\(/g) || []).length;
        if (serviceCalls > 10) flag('yellow', 'F1', relative(ROOT, f), `resource 文件 ${serviceCalls} 处 service 引用（>10，疑似业务编排越层）`);
      } catch { /* 读不了的跳过 */ }
    }
  } catch { /* rg 无匹配退出码 1，正常 */ }
}

// ---- F2: service→service 互调（Java） ----
out('== F2 依赖方向 ==');
for (const proj of projects) {
  const serviceDir = join(ROOT, proj.dir || '.', 'src/main/java');
  if (!existsSync(serviceDir)) continue;
  try {
    const files = execFileSync('rg', ['-l', 'import.*Service;', serviceDir, '--glob', '*/service/*.java'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
    for (const f of files) {
      try {
        const content = readFileSync(f, 'utf8');
        const imports = (content.match(/import\s+\S*\.(\w+Service);/g) || []);
        const crossImports = imports.filter(i => {
          const m = i.match(/\.(\w+Service);/);
          const imported = m ? m[1] : '';
          const selfName = relative(ROOT, f).split('/').pop()?.replace('.java', '') || '';
          return imported !== selfName;
        });
        if (crossImports.length > LIMITS.serviceToServiceMax) {
          flag('yellow', 'F2', relative(ROOT, f), `import ${crossImports.length} 个其它 Service（> ${LIMITS.serviceToServiceMax}，检查是否有循环/跨域依赖）`);
        }
      } catch { /* 读不了的跳过 */ }
    }
  } catch { /* rg 无匹配退出码 1，正常 */ }
}

// ---- F5: verify-run 耗时趋势（P1 卡点 3，2026-11-19）----
// 从 .ai/verify/*.log 的 started/finished 头提取每次验证耗时，
// 最近 5 次均值 vs 更早 5 次均值：增长 > 30% → 🟡（性能/复杂度腐化信号）。
out('== F5 验证耗时趋势 ==');
try {
  const verifyDir = join(ROOT, '.ai/verify');
  if (existsSync(verifyDir)) {
    const logs = readdirSync(verifyDir)
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const p = join(verifyDir, f);
        try {
          const text = readFileSync(p, 'utf8');
          const s = text.match(/^# started: (.+)$/m);
          const e = text.match(/^# finished: (.+)$/m);
          if (!s || !e) return null;
          const dur = new Date(e[1]) - new Date(s[1]);
          const mtime = statSync(p).mtimeMs;
          return Number.isFinite(dur) && dur >= 0 ? { file: f, dur, mtime } : null;
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtime - b.mtime);
    // 排除基建类日志（close-gate 等固定开销），只看任务验证日志——不，全算：
    // 趋势要的是整体信号。样本 ≥ 8（前后各 4）才说话。
    if (logs.length >= 8) {
      const recent = logs.slice(-5);
      const earlier = logs.slice(-10, -5);
      const avg = arr => arr.reduce((x, r) => x + r.dur, 0) / arr.length;
      const recentAvg = Math.round(avg(recent));
      const earlierAvg = Math.round(avg(earlier));
      if (earlierAvg > 0) {
        const growth = Math.round((recentAvg / earlierAvg - 1) * 100);
        if (growth >= 30) {
          flag('yellow', 'F5', '.ai/verify/', `最近 5 次验证均值 ${recentAvg}ms 较前 5 次均值 ${earlierAvg}ms 增长 ${growth}%（>30%——验证链变慢，性能/复杂度腐化信号）`);
        } else if (growth <= -30) {
          out(`  🟢 验证耗时改善 ${-growth}%（${earlierAvg}ms → ${recentAvg}ms）`);
        } else {
          out(`  验证耗时稳定（${earlierAvg}ms → ${recentAvg}ms，${growth >= 0 ? '+' : ''}${growth}%）`);
        }
      }
    } else {
      out(`  样本 ${logs.length} < 8，趋势待积累`);
    }
  } else {
    out('  无 .ai/verify/ 目录，跳过');
  }
} catch (e) {
  out(`  F5 读取失败：${e.message}（不阻断）`);
}

// ---- 汇总 ----
const red = findings.filter(f => f.severity === 'red');
const yellow = findings.filter(f => f.severity === 'yellow');

if (JSON_MODE) {
  console.log(JSON.stringify({ ok: red.length === 0, red: red.length, yellow: yellow.length, findings }, null, 2));
} else {
  out('');
  out(`结果：🔴 ${red.length} | 🟡 ${yellow.length} | 🟢 ${findings.filter(f=>f.severity==='green').length}`);
  if (red.length) {
    out('');
    out('🔴 阻断项（需拆分/重构后才能合入）：');
    for (const f of red) out(`  ${f.file}: ${f.detail}`);
  }
  if (yellow.length) {
    out('');
    out('🟡 建议项（architect agent 周期检查时关注，不阻断）：');
    for (const f of yellow) out(`  ${f.file}: ${f.detail}`);
  }
  if (red.length === 0 && yellow.length === 0) out('  全绿——架构指标在预算内。');
  if (!STRICT && red.length > 0) out('');
  if (!STRICT && red.length > 0) out(`  （报告模式：${red.length} 🔴 不阻断——存量债。PR/CI 侧用 --strict 拦新增违规）`);
}

// strict 模式（PR/CI 用）：任何红即 exit 1。默认模式（doctor/报告用）：只报告不阻断——
// 存量债不该挡新开发，新增违规由 PR 侧 --strict 拦。
process.exit(STRICT && red.length > 0 ? 1 : 0);
