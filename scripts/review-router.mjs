#!/usr/bin/env node
/**
 * review-router —— MR 变更文件 → 该跑哪些审核。零 LLM。
 *
 * 用法（CI 里取 diff；本地可用文件清单）：
 *   node scripts/review-router.mjs --base origin/main...
 *   node scripts/review-router.mjs --files <清单文件>（每行一个路径）
 *
 * stdout：路由结果 JSON（review job 的驱动输入）；stderr：人读摘要。
 * 退出码：0 正常（含"无需审核"）；2 规则缺失/非法（fail-closed，绝不输出空结果装作没事）。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadRules, route } from './lib/review-rules.mjs';

function usage() {
  console.error('用法: node scripts/review-router.mjs --base <git-ref> | --files <清单文件> [--root <目录>]');
  process.exit(64);
}

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--') || i + 1 >= args.length) usage();
  opt[args[i].slice(2)] = args[i + 1];
}
const root = opt.root || process.cwd();
if (!opt.base && !opt.files) usage();

let files;
if (opt.files) {
  files = readFileSync(opt.files, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
} else {
  try {
    files = execFileSync('git', ['-C', root, 'diff', '--name-only', `${opt.base}...HEAD`], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    // git 失败 = 拿不到变更事实 = 无法路由，必须红（checklist §2：失败不许退化成「没有变化」）
    console.error(`[router] git diff 失败：${e.message}`);
    process.exit(2);
  }
}

let rules;
try {
  rules = loadRules(root);
} catch (e) {
  console.error(`[router] ${e.message}`);
  process.exit(2);
}

const result = route(rules, root, files);

console.log(JSON.stringify(result, null, 2));
const names = result.reviews.map((r) => `${r.id}(${r.files.length} 文件, via ${r.via})`).join('、');
if (result.trivial) console.error(`[router] ${files.length} 个变更全是噪声文件，无审核触发（含 evidence：ci-verify 也跳过）`);
else console.error(`[router] ${files.length} 个变更 → ${result.reviews.length} 类审核：${names || '仅 evidence 之外无命中'}`);
