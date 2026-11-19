#!/usr/bin/env node
/**
 * gate-parallel —— 把 `npm run gate` 的 34 段从串行（&&）改成有界并发。
 *
 * 为什么可以并行：34 段之间没有数据依赖，27 个测试套件全部用 mktemp 自建夹具、
 * 无固定端口、无共享输出路径（审计见 CR-2026-11-19-gate-parallel.md §1）。
 * 实测 4 路 138.2s / 0 失败 / git status 前后无差异（串行 382.9s，2.77×）。
 *
 * 为什么不无脑并行：perf-checks 的判据输入是**墙钟**——sleep 1.0s 实测 ~1005ms，
 * 断言落在基线的 50~150% 区间。并发争抢会把它推到 1.3s，直接把"🟡 超五成"冲成
 * "🔴 超一倍"。那是判据被环境打坏，不是代码变慢。所以时间敏感段单独排队、独占跑。
 *
 * 失败必须传出来（这是本文件存在的第一性理由）：串行的 `a && b && c` 只会告诉你
 * "最后失败了"；这里逐段记退出码，任一段非 0 即整体 exit 1，并把每段输出留在
 * 独立日志里。gate-regressions 那次"中段判定被后续命令覆盖"的教训——判据自己的
 * 执行器不能吞失败。
 *
 * 用法：
 *   npm run gate                 # 并发（默认按 CPU 自适应，上限 6）
 *   npm run gate:serial          # 旧的串行链，排查偶发红时用
 *   node scripts/gate-parallel.mjs --jobs=2
 *   GATE_PARALLEL_CMDS=$'true\nexit 1' node scripts/gate-parallel.mjs   # 供自测注入
 */
import { readFileSync, mkdirSync, openSync, closeSync, readFileSync as rf } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---- 段清单 ----
// 优先级：GATE_PARALLEL_CMDS（自测注入）> package.json scripts.gate:serial > scripts.gate
// 用 gate:serial 而不是 gate：gate 会指向本文件，读它等于自己调自己。
// 判断用 `in process.env` 而不是真假值：自测要能注入**空清单**（验证 exit 2）。
let steps = '';
if ('GATE_PARALLEL_CMDS' in process.env) {
  steps = process.env.GATE_PARALLEL_CMDS;
} else {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const s = pkg.scripts || {};
  steps = s['gate:serial'] || s.gate || '';
}
// 生产格式是 `a && b && c`；自测注入用换行更易读，两者都认。
// （命令内部含裸换行的多行 shell 目前没有；真出现时要改用数组而不是字符串。）
const all = steps.split(/&&|\n/).map((x) => x.trim()).filter(Boolean);
if (!all.length) {
  console.error('[gate] 段清单为空（package.json scripts.gate:serial 缺失）');
  process.exit(2);
}

// 时间敏感段：判据输入是墙钟，必须独占。目前只有 perf-checks 一处，
// 用白名单而不是黑名单——新增时间敏感套件时，忘了登记只会让它变慢，不会让它假红。
// （若用"默认串行、例外并行"，忘了登记会让并行收益归零，同样安全。这里取收益优先。）
const isSerial = (cmd) => /test:perf-checks/.test(cmd);

const parallel = all.filter((c) => !isSerial(c));
const serial = all.filter(isSerial);

// ---- 并发度 ----
const argJobs = Number((process.argv.find((a) => a.startsWith('--jobs=')) || '').split('=')[1]);
const cores = cpus()?.length || 2;
const JOBS = Number.isFinite(argJobs) && argJobs > 0
  ? argJobs
  : Math.min(6, Math.max(2, cores - 1));

const LOGDIR = mkdtempSync(join(tmpdir(), 'harness-gate-'));
mkdirSync(LOGDIR, { recursive: true });

// ---- 跑一段 ----
function runOne(cmd, idx) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const logPath = join(LOGDIR, `${String(idx).padStart(2, '0')}.log`);
    const fd = openSync(logPath, 'w');
    const child = spawn(cmd, { cwd: ROOT, shell: true, stdio: ['ignore', fd, fd], env: process.env });
    child.on('close', (code, signal) => {
      closeSync(fd);
      resolve({ cmd, code: code ?? (signal ? 1 : 0), ms: Date.now() - t0, logPath });
    });
    child.on('error', (e) => {
      try { closeSync(fd); } catch { /* 已关 */ }
      resolve({ cmd, code: 1, ms: Date.now() - t0, logPath, error: e.message });
    });
  });
}

function mark(ok) { return ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'; }

async function pool(items, n, fn) {
  const queue = items.map((_, i) => i);
  const results = new Array(items.length);
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = queue.shift();
      if (i === undefined) return;
      const r = await fn(items[i], i);
      results[i] = r;
      done += 1;
      console.log(`  ${mark(r.code === 0)} [${String(done).padStart(2)}/${items.length}] ${String(Math.round(r.ms / 1000)).padStart(4)}s  ${r.cmd}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, worker));
  return results;
}

async function main() {
  const t0 = Date.now();
  console.log(`[gate] ${all.length} 段：并发 ${parallel.length}（${JOBS} 路） + 串行 ${serial.length}（时间敏感）`);

  const pRes = await pool(parallel, JOBS, (cmd, i) => runOne(cmd, i));
  let offset = parallel.length;
  const sRes = [];
  for (const cmd of serial) {
    const r = await runOne(cmd, offset++);
    sRes.push(r);
    console.log(`  ${mark(r.code === 0)} [串行] ${String(Math.round(r.ms / 1000)).padStart(4)}s  ${r.cmd}`);
  }

  const results = [...pRes, ...sRes];
  const failed = results.filter((r) => r.code !== 0);
  const total = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('');
  if (!failed.length) {
    console.log(`[gate] 全绿：${results.length} 段，${total}s`);
    // 成功时也留目录：断言数、单段耗时都只在各段日志里，丢了就得重跑 107s。
    console.log(`[gate] 每段日志：${LOGDIR}`);
    process.exit(0);
  }

  // 失败时把每段日志尾部打出来：并发下"哪段红了"必须一眼可见，
  // 否则人只会看到一堆交错的输出，然后重跑一次看运气。
  console.log(`[gate] ${failed.length} 段失败（共 ${results.length} 段，${total}s）：`);
  for (const f of failed) {
    console.log(`\n──── ${mark(false)} ${f.cmd}  (exit ${f.code}) ────`);
    try {
      const tail = rf(f.logPath, 'utf8').trimEnd().split('\n').slice(-25);
      console.log(tail.join('\n'));
    } catch {
      console.log(`（日志读取失败：${f.logPath}）`);
    }
  }
  console.log(`\n[gate] 完整日志：${LOGDIR}`);
  console.log(`[gate] 排查偶发红：npm run gate:serial（串行能排除并发干扰）`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`[gate] 执行器自身故障：${e.stack || e.message}`);
  process.exit(2);
});
