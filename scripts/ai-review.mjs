#!/usr/bin/env node
/**
 * ai-review —— 模式 B：预打包上下文 + 单次 API 调用的清单驱动审核。
 *
 * 分层省 token：L0 机器判据零 token 先跑（模板完整、引用存在）；L1 只打包受限上下文
 * （清单前缀静态可缓存 + 文件数/行数硬顶）；L5 输出强制 JSON 且条目封顶。
 *
 * 退出码：0=通过；1=存在 🔴（含机器判据 red）；2=基础设施失败（规则缺失/无凭据/
 * 模型不可用且机器判据无红/输出解析失败）——fail-closed：失败绝不产出"通过"。
 *
 * 用法：
 *   node scripts/ai-review.mjs --type rs --base origin/main...
 *   node scripts/ai-review.mjs --type cr --files <清单> [--out .ai/reviews] [--dry-run] [--machine-only]
 * env：AI_REVIEW_BASE_URL（OpenAI 兼容端点）/ AI_REVIEW_API_KEY / AI_REVIEW_MODEL
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadRules, route, RulesError } from './lib/review-rules.mjs';
import { runMachineChecks, CheckError } from './lib/review-checks.mjs';
import { recordEvent } from '../hooks/lib/ledger.mjs';

const OUT_PROTOCOL = `
## 输出协议（严格遵守）
只输出一个 JSON 对象，不要 markdown 代码围栏，不要多余文字：
{"summary": "<三句话以内>", "findings": [{"severity": "red|yellow", "rule": "<命中的清单条目编号>", "file": "<相关文件，没有则空串>", "line": 0, "message": "<事实描述>", "suggestion": "<怎么改>"}]}
- 只报真会出错的问题，不报风格偏好；命中即候选，最终由批红角色定夺。
- 没有问题就输出 {"summary": "...", "findings": []}，不要为了凑数编造。
`;

function die(code, msg) { console.error(`[ai-review] ${msg}`); process.exit(code); }
function usage() { console.error('用法: node scripts/ai-review.mjs --type <rs|adr|cr> (--base <ref> | --files <清单>) [--out <目录>] [--root <目录>] [--dry-run] [--machine-only]'); process.exit(64); }

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) usage();
  const key = args[i].slice(2);
  // 布尔旗标没有值：按键值对解析会把后续参数吞掉（--dry-run 落在末位时直接 usage 崩出）
  if (key === 'dry-run' || key === 'machine-only') { opt[key] = true; continue; }
  if (i + 1 >= args.length) usage();
  opt[key] = args[++i];
}
if (!opt.type) usage();
const root = opt.root || process.cwd();
const outDir = opt.out || join(root, '.ai', 'reviews');
const dryRun = 'dry-run' in opt;
const machineOnly = 'machine-only' in opt;

let rules;
try { rules = loadRules(root); } catch (e) { die(2, e.message); }
const rule = rules.reviews[opt.type];
if (!rule) die(2, `未知审核类型 ${opt.type}（可用：${Object.keys(rules.reviews).filter((k) => !rules.reviews[k].always).join(', ')}）`);
if (rule.always) die(2, `${opt.type} 是机器裁决型（runner=${rule.runner}），不走 AI`);

// ---- 变更文件（与 router 同一逻辑：route() 决定本类型命中哪些文件）----
let changedFiles;
if (opt.files) {
  changedFiles = readFileSync(opt.files, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
} else if (opt.base) {
  try {
    changedFiles = execFileSync('git', ['-C', root, 'diff', '--name-only', `${opt.base}...HEAD`], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (e) { die(2, `git diff 失败：${e.message}`); }
} else usage();

let routed;
try {
  routed = route(rules, root, changedFiles);
} catch (e) {
  if (e instanceof RulesError) die(2, e.message); // 如 harness.config.json 解析失败：fail-closed，不空跑
  throw e;
}
const mine = routed.reviews.find((r) => r.id === opt.type);
if (!mine || mine.files.length === 0) {
  console.log(`[ai-review] 本次变更未命中 ${opt.type}（${changedFiles.length} 个变更），无需审核`);
  process.exit(0);
}
const files = mine.files;

// ---- L0 机器判据（零 token，先跑）----
let machineFindings;
try {
  machineFindings = runMachineChecks(rule.machine_checks, root, files);
} catch (e) {
  if (e instanceof CheckError) die(2, e.message);
  throw e;
}

// ---- L1 打包：静态清单前缀 + 受限文件上下文 ----
const checklistPath = join(root, rule.checklist);
let checklist;
try { checklist = readFileSync(checklistPath, 'utf8'); } catch { die(2, `清单文件缺失：${rule.checklist}（规则声明了但仓库没有 = 配置坏）`); }
const maxFiles = rules.bundle?.max_files ?? 12;
const maxLines = rules.bundle?.max_lines_per_file ?? 600;

const shaOf = (s) => createHash('sha256').update(s).digest('hex');
// 缓存键 = 审核类型 + 规则源内容哈希（harness.rules.json 原文 + 本类型清单文件，sha256 前 12 位）。
// 旧键只认类型 + 文件 sha：清单/规则更新后，未改动的文件原样沿用上轮结论——上一版清单
// 放过的 🔴 会混进新 verdict（P2）。规则一变 → 键变 → 缓存整体失效重建；宁可多调一次模型。
const rulesSha = shaOf(readFileSync(join(root, 'harness.rules.json'), 'utf8') + '\n' + checklist).slice(0, 12);
const cachePath = join(outDir, `.cache-${opt.type}-${rulesSha}.json`);
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

const bundled = [];
const carried = [];
for (const f of files) {
  let content = null;
  try { content = readFileSync(join(root, f), 'utf8'); } catch { /* 删除的文件只带文件名 */ }
  const sha = shaOf(content ?? f);
  if (cache[f] && cache[f].sha === sha) { carried.push(...(cache[f].findings || []).map((x) => ({ ...x, carried: true }))); continue; }
  bundled.push({ file: f, content });
}
let overCap = null;
if (bundled.length > maxFiles) { overCap = bundled.length; bundled.length = maxFiles; }

const staticPrefix = `你是「${rule.title}」审核员，按下述清单逐条核，只输出协议 JSON。\n\n# 审核清单\n${checklist}\n${OUT_PROTOCOL}`;
const dynParts = [];
for (const b of bundled) {
  let body = b.content == null ? '（文件在本次变更中被删除，仅提供路径）' : b.content;
  const lines = body.split('\n');
  if (lines.length > maxLines) body = `${lines.slice(0, maxLines).join('\n')}\n…（超出 ${maxLines} 行截断）`;
  dynParts.push(`## 文件：${b.file}\n\`\`\`\n${body}\n\`\`\``);
}
const dynamicBundle = `# 待审变更文件（共 ${files.length}，本轮打包 ${bundled.length}，未变更沿用上轮结论 ${carried.length} 条）\n\n${dynParts.join('\n\n')}`;

if (dryRun) {
  console.log(JSON.stringify({
    type: opt.type, files_total: files.length, files_in_bundle: bundled.length,
    findings_carried: carried.length, machine_findings: machineFindings.length,
    bundle_chars: staticPrefix.length + dynamicBundle.length,
  }, null, 2));
  process.exit(0);
}

// ---- 模型调用（单发；非法 JSON 重试一次，仍败则 fail-closed）----
const tier = rules.model_tiers?.[rule.model_tier] || {};
const model = process.env.AI_REVIEW_MODEL || tier.model;
const baseUrl = (process.env.AI_REVIEW_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const apiKey = process.env.AI_REVIEW_API_KEY;

let commit = 'nogit';
try { commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* 本地无 git 也允许跑，commit 记 nogit */ }

async function callModel(messages) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`模型端点 HTTP ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  const usage = data.usage || {};
  return { content, tokensIn: usage.prompt_tokens ?? null, tokensOut: usage.completion_tokens ?? null };
}
const parseJsonLoose = (s) => {
  if (typeof s !== 'string') throw new Error('模型无内容返回');
  const t = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(t);
};

let ai = { summary: '', findings: [] };
let tokensIn = null, tokensOut = null, modelNote = model || 'none';
const canCall = apiKey && model;
const machineRed = machineFindings.some((f) => f.severity === 'red');

// 顺序即策略：先判"本轮根本不该调模型"的三种情况，再调。
// 原来把 canCall 放最前，于是 --machine-only 在配了 key 的机器上照调不误——而有 key 的 CI
// 正是这个开关唯一存在的理由（RS US-2 与指南 §四 都把它当"合法降级出口"写）。
// 同理：L0 已经出 🔴 时再调模型，结论不可能改变，只多一笔 token。
if (machineOnly) {
  modelNote = 'none（--machine-only，只跑机器判据）';
} else if (machineRed) {
  modelNote = 'none（机器判据已阻断，未调模型）';
} else if (bundled.length === 0) {
  modelNote = 'none（全部文件与上轮一致，沿用结论，不重复调模型）';
} else if (canCall) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const extra = attempt === 0 ? [] : [{ role: 'user', content: '上一条输出不是合法 JSON。重新只输出协议要求的 JSON 对象。' }];
      const r = await callModel([{ role: 'system', content: staticPrefix }, { role: 'user', content: dynamicBundle }, ...extra]);
      tokensIn = r.tokensIn; tokensOut = r.tokensOut;
      const parsed = parseJsonLoose(r.content);
      if (!Array.isArray(parsed.findings)) throw new Error('findings 不是数组');
      ai.summary = typeof parsed.summary === 'string' ? parsed.summary : '';
      ai.findings = parsed.findings;
      lastErr = null;
      break;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) die(2, `模型调用/解析失败：${lastErr.message}`);
} else {
  die(2, '缺 AI_REVIEW_API_KEY 或模型名（rules.model_tiers / AI_REVIEW_MODEL），且机器判据无红 —— 得不出结论，拒绝空跑');
}

// ---- 结论合并：机器 + 沿用 + AI；非法条目剔除并留痕；红优先截断 ----
const valid = [];
let dropped = 0;
for (const f of ai.findings) {
  if (f && (f.severity === 'red' || f.severity === 'yellow') && typeof f.message === 'string' && f.message) valid.push({ severity: f.severity, rule: String(f.rule ?? 'ai'), file: String(f.file ?? ''), line: Number(f.line) || 0, message: f.message, suggestion: String(f.suggestion ?? ''), source: 'ai' });
  else dropped += 1;
}
if (overCap) valid.push({ severity: 'yellow', rule: 'bundle_cap', file: '', line: 0, message: `变更文件 ${overCap} 个超出打包上限 ${maxFiles}，本轮仅审前 ${maxFiles} 个——请拆 MR 或人工补审`, source: 'system' });
if (dropped) valid.push({ severity: 'yellow', rule: 'ai_output', file: '', line: 0, message: `${dropped} 条模型输出缺必需字段（severity/message），已剔除`, source: 'system' });

const all = [...machineFindings.map((f) => ({ ...f, source: 'machine' })), ...carried.map((f) => ({ ...f, source: 'carried' })), ...valid]
  .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1));
const capped = all.slice(0, rule.max_findings ?? 10);
const red = capped.filter((f) => f.severity === 'red');
const yellow = capped.filter((f) => f.severity !== 'red');

// ---- 产物：verdict 文件 + token 计量入账 + 缓存 ----
mkdirSync(outDir, { recursive: true });
const sev = (s) => (s === 'red' ? '🔴' : '🟡');
const row = (f, i) => `| ${i + 1} | ${f.rule} | ${f.file || '-'} | ${f.message}${f.suggestion ? `（建议：${f.suggestion}）` : ''} | ${f.source} |`;
const verdict = `# AI 审核：${rule.title}（${opt.type}）

# type: ${opt.type}
# base: ${opt.base || opt.files}
# commit: ${commit}
# model: ${modelNote}
# tokens: in=${tokensIn ?? '-'} out=${tokensOut ?? '-'}
# findings: red=${red.length} yellow=${yellow.length}

机器判据 ${machineFindings.length} 条（零 token）｜AI 判据 ${valid.length - (overCap ? 1 : 0) - (dropped ? 1 : 0)} 条｜沿用上轮 ${carried.length} 条${all.length > capped.length ? `｜已按上限 ${rule.max_findings} 截断 ${all.length - capped.length} 条` : ''}

## 摘要
${ai.summary || '（机器判据主导，模型未出摘要）'}

## 🔴 阻断项（处置后由 ${rules.notify?.roles?.[rule.approval_role] || rule.approval_role} 批红）
${red.length ? `| # | 规则 | 文件 | 说明 | 来源 |\n|---|---|---|---|---|\n${red.map(row).join('\n')}` : '无'}

## 🟡 建议项（不阻断）
${yellow.length ? `| # | 规则 | 文件 | 说明 | 来源 |\n|---|---|---|---|---|\n${yellow.map(row).join('\n')}` : '无'}

> 本报告是票拟不是判决：🔴 处置与否由 ${rules.notify?.roles?.[rule.approval_role] || rule.approval_role} 在 MR 定夺并 approve。
`;
const verdictPath = join(outDir, `${opt.type}-${commit}.md`);
writeFileSync(verdictPath, verdict);

const byFile = {};
for (const f of valid) if (f.file) (byFile[f.file] ||= []).push({ severity: f.severity, rule: f.rule, file: f.file, message: f.message });
for (const b of bundled) cache[b.file] = { sha: shaOf(b.content ?? b.file), findings: byFile[b.file] || [] };
writeFileSync(cachePath, JSON.stringify(cache, null, 2));

recordEvent('ai-review', 'run', { type: opt.type, commit, model: modelNote, tokens_in: tokensIn, tokens_out: tokensOut, red: red.length, yellow: yellow.length, files_total: files.length, files_bundled: bundled.length });

console.log(`[ai-review] ${red.length ? '🔴 阻断' : '通过'}：${verdictPath}（red=${red.length} yellow=${yellow.length}）`);
process.exit(red.length > 0 ? 1 : 0);
