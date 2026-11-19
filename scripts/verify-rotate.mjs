#!/usr/bin/env node
/**
 * verify-rotate —— 证据日志轮转（2026-11-19 p3-verify-rotation，体检 B Y6）。
 *
 * 问题：.ai/verify/ 只增不减（168 份/1.5MB），每任务 3-5 份、CLOSE-GATE 全量日志高度重复
 * （18 份 × 10-30KB）。git 里的证据链要求日志入库，但不能要求全量永久保留——
 * 老任务的全量 gate 输出对审计价值递减，摘要即可回溯。
 *
 * 策略（保守，不动近期）：
 *   - CLOSE-GATE-*.log：> keepDays（默认 7 天）→ 截取头部（# cmd/exit_code/commit/task）
 *     + 尾部 5 行（结果行），中间替换为一行截断标记。文件保留、证据链不断、体积降 ~90%。
 *   - 其他日志（各 todo 的验证命令输出）：不动（通常只有几 KB 且每个 todo 一份）。
 *   - 已 done 且所有 todo 的 verify 日志都已截断的任务：不删 state.json（它是事实源）。
 *
 * 用法：node scripts/verify-rotate.mjs [--dry-run] [--keep-days 7]
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const keepDaysIdx = args.indexOf('--keep-days');
const keepDaysRaw = keepDaysIdx >= 0 ? Number(args[keepDaysIdx + 1]) : 7;
const keepDays = Number.isFinite(keepDaysRaw) && keepDaysRaw >= 0 ? keepDaysRaw : 7; // 0 是合法值（falsy || 陷阱）
const dir = join(process.cwd(), '.ai', 'verify');

if (!readdirSync) { console.error('fs 不可用'); process.exit(1); }

let files;
try { files = readdirSync(dir).filter((f) => f.startsWith('CLOSE-GATE-') && f.endsWith('.log')); }
catch { console.log('无 .ai/verify 目录——跳过'); process.exit(0); }

const cutoff = Date.now() - keepDays * 86400_000;
let rotated = 0, skipped = 0, savedBytes = 0;

for (const f of files) {
  const p = join(dir, f);
  const stat = statSync(p);
  if (stat.mtimeMs > cutoff) { skipped++; continue; }
  const text = readFileSync(p, 'utf8');
  if (text.includes('<!-- rotated')) { skipped++; continue; } // 已轮转
  const original = stat.size; // 必须在 size check 前（TDZ）
  if (original < 4096) { skipped++; continue; } // 小文件轮转开销>收益
  const lines = text.split('\n');
  // 头部：# cmd 到 # ---- output 之前的元数据行
  const headEnd = lines.findIndex((l) => l.includes('output tail') || l.includes('----'));
  // 头尾行各截 200 字——单行超长（如堆栈/gate 全量输出的一行）不膨胀摘要
  const clip = (l) => l.length > 200 ? l.slice(0, 200) + '…' : l;
  const head = lines.slice(0, Math.max(headEnd + 1, 6)).map(clip).join('\n');
  // 尾部 5 行（含结果行）
  const tail = lines.slice(-5).map(clip).join('\n');
  const summary = `${head}\n<!-- rotated: ${new Date().toISOString()} | original ${original}B → summary | full output pruned (keep-days=${keepDays}) -->\n...\n${tail}\n`;
  if (!dryRun) writeFileSync(p, summary);
  savedBytes += original - Buffer.byteLength(summary);
  rotated++;
}

console.log(`verify-rotate：${rotated} 份 CLOSE-GATE 日志截断（省 ${Math.round(savedBytes/1024)}KB），${skipped} 份保留（${keepDays} 天内或已轮转）${dryRun ? '——dry-run 未写入' : ''}`);
