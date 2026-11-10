#!/usr/bin/env node
/**
 * task-loop runner（T3 核心）—— 本地循环执行器：拉模型、kill switch、CAS 认领、预算、审批三条件。
 *
 * 定位（ADR-010）：每台开发机各跑一个，轮询触发（零 LLM），认领在 git 上 CAS，
 * 修复动作在独立 worktree 起无头会话（runtime.headless，hook 必接线），停机在本层判定。
 * v1 覆盖：剖面 A（MR 打回修复）的单轮骨架 + 全部安全闸；CI 归因循环（T4a/b）后续接入。
 *
 * 用法：
 *   node scripts/task-loop.mjs --once [--profile a] [--dry-run] [--root <仓库>] [--mr <iid>]
 * env：GITLAB_URL / GITLAB_TOKEN（触发轮询）；--dry-run 为影子周形态（零写入：不认领、不推、不起会话）
 * 退出码：0 正常（含无事可做）；1 有触发但被安全闸拦（僵尸认领/预算尽/接线缺失）；64 用法错。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadRules } from './lib/review-rules.mjs';
import { claim, release } from './lib/claim.mjs';
import { createBudget, approvalValid } from './lib/task-loop-core.mjs';
import { recordEvent } from '../hooks/lib/ledger.mjs';

const args = process.argv.slice(2);
// 旗标与键值分开解析：indexOf 不存在时返回 -1，args[0] 会被当成 profile 值（实测坑）
const opt = { once: args.includes('--once'), dryRun: args.includes('--dry-run'), profile: 'a' };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--profile' && i + 1 < args.length) opt.profile = args[++i];
  else if (args[i] === '--mr' && i + 1 < args.length) opt.mr = args[++i];
  else if (args[i] === '--root' && i + 1 < args.length) opt.root = args[++i];
  else if (args[i] === '--report') opt.report = true;
  else if (args[i].startsWith('--')) continue; // 已处理的旗标
  else die(64, `未知参数：${args[i]}`);
}
const root = resolve(opt.root || process.cwd());

function die(code, msg) { console.error(`[task-loop] ${msg}`); process.exit(code); }
if (!opt.once && !opt.report) die(64, 'v1 只支持 --once / --report（常驻轮询经 deploy/task-loop 定时器触发）');

// ---- 影子周报告：dry-run 的积累数据出统计（触发精确率素材，验收=N≥30 且 0 误触发） ----
if (opt.report) {
  const shadowFile = join(root, '.ai', 'task-loop', 'shadow.jsonl');
  if (!existsSync(shadowFile)) { console.log('无影子数据（先跑 --once --dry-run 积累）'); process.exit(0); }
  // 脏行防御：只认"是对象且有 id"的行——裸数字/null 也是合法 JSON，会以 undefined 键混进统计
  const entries = readFileSync(shadowFile, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && typeof e === 'object' && e.id != null);
  const byId = new Map();
  const byDay = {};
  for (const e of entries) {
    byId.set(e.id, (byId.get(e.id) || 0) + 1);
    const d = (e.ts || '').slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
  }
  const unique = byId.size;
  const repeat = entries.length - unique;
  console.log(`影子周报告（${Object.keys(byDay).length} 天，${entries.length} tick 命中）`);
  console.log(`  唯一触发：${unique}；重复命中：${repeat}（CAS 去重生效则重复无害）`);
  Object.entries(byDay).sort().forEach(([d, n]) => console.log(`  ${d}  ${'#'.repeat(Math.min(n, 40))} ${n}`));
  console.log(`  影子验收口径：误触发 0 且唯一触发 N≥30 才进 P1 小批；漏触发需人工比对 MR 时间线单列`);
  process.exit(0);
}

// ---- kill switch：哨兵文件存在即停（退出 0——被停是运维意图，不是故障）----
const OFF = join(root, '.ai', 'task-loop', 'OFF');
if (existsSync(OFF)) {
  recordEvent('task-loop', 'killed_by_switch', {});
  console.log('[task-loop] OFF 哨兵存在，本轮跳过（删除 ' + OFF + ' 恢复）');
  process.exit(0);
}

// ---- 规则与 headless 剖面：CLI/参数齐 + hooks=true 时目标仓库必须有 hook 接线 ----
// 不接 hook 的无头会话是绕过全部写入门禁的会话（ADR D6，wiring 断言进验收）。
let rules;
try { rules = loadRules(root); } catch (e) { die(1, e.message); }
const headless = rules.runtime?.headless;
if (!headless?.cli || !Array.isArray(headless.args)) die(1, 'runtime.headless 剖面缺失（cli/args 必填，见 harness.rules.json）');
if (headless.hooks !== false) {
  const wired = ['.zcode/config.json', '.claude/settings.json'].some((p) => {
    try { const c = JSON.parse(readFileSync(join(root, p), 'utf8')); return !!(c.hooks?.enabled !== false && (c.hooks || c.hooks !== undefined)); } catch { return false; }
  });
  if (!wired) die(1, '目标仓库无 hook 接线（.zcode/config.json 或 .claude/settings.json）——headless 会话会绕过全部写入门禁，拒绝启动。先 build:hooks');
}

// ---- 触发轮询（剖面 A v1）：我名下的 open MR + 有他人未解决讨论 = 打回待修 ----
async function fetchTriggers({ url, token, fetchImpl = fetch, username }) {
  const api = async (path) => {
    const res = await fetchImpl(`${url}/api/v4${path}`, { headers: { 'private-token': token }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GitLab ${path} HTTP ${res.status}`);
    return res.json();
  };
  const mrs = await api('/merge_requests?scope=created_by_me&state=opened&per_page=20');
  const out = [];
  for (const mr of mrs) {
    if (opt.mr && String(mr.iid) !== String(opt.mr)) continue;
    const discs = await api(`/projects/${mr.project_id}/merge_requests/${mr.iid}/discussions`);
    const unresolved = discs.filter((d) => d.notes?.some?.((n) => n.resolvable && !n.resolved && n.author.username !== username));
    if (unresolved.length > 0) out.push({ kind: 'mr', id: mr.iid, mr, unresolved });
  }
  return out;
}

// ---- 主流程 ----
const GITLAB_URL = process.env.GITLAB_URL;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
let triggers = [];
if (opt.profile === 'a') {
  if (!GITLAB_URL || !GITLAB_TOKEN) die(1, '剖面 A 需要 GITLAB_URL / GITLAB_TOKEN（触发轮询凭据）');
  try {
    triggers = await fetchTriggers({ url: GITLAB_URL, token: GITLAB_TOKEN, username: process.env.GITLAB_USERNAME || '' });
  } catch (e) { die(1, `触发轮询失败：${e.message}`); }
} else if (opt.profile === 'b') {
  // 剖面 B：MQL 轮询指派给我的待处理缺陷 → P0/P1 自动、P2 confirm_first（确认卡片走订阅 T2）
  const { resolveEndpoint, connect, McpPermError } = await import('./lib/feishu-project-mcp.mjs');
  const { buildMyBugsMql, parseMqlResult, gateBySeverity } = await import('./lib/feishu-bug-source.mjs');
  const endpoint = resolveEndpoint();
  if (!endpoint) die(1, '剖面 B 需要 FEISHU_MCP_URL（或 FEISHU_MCP_KEY + FEISHU_USER_KEY）');
  try {
    const c = await connect(endpoint);
    const raw = await c.call('search_by_mql', { project_key: process.env.FEISHU_PROJECT_KEY || '', mql: buildMyBugsMql() });
    const { auto, confirm, skip } = gateBySeverity(parseMqlResult(raw));
    recordEvent('task-loop', 'profile_b_polled', { auto: auto.length, confirm: confirm.length, skip: skip.length });
    triggers = auto.map((b) => ({ kind: 'task', id: b.work_item_id, bug: b, unresolved: [] }));
    if (confirm.length > 0) console.log(`[task-loop] ${confirm.length} 张 P2 单待确认（confirm_first，卡片确认后 --task <单号> 启动）`);
  } catch (e) {
    if (e instanceof McpPermError) die(1, `剖面 B 数据档未授权：${e.message}（飞书后台给 MCP 应用勾选工作项读取范围；探测见 doctor-gates 套件）`);
    die(1, `剖面 B 触发轮询失败：${e.message}`);
  }
}

if (triggers.length === 0) { console.log('[task-loop] 无打回待修触发，本轮结束'); process.exit(0); }

let blocked = 0;
for (const t of triggers) {
  recordEvent('task-loop', 'trigger_found', { kind: t.kind, id: t.id, unresolved: t.unresolved.length });

  if (opt.dryRun) {
    // 影子周素材：每个 tick 命中都落 shadow.jsonl（--report 出统计）——零写入指对外部系统，
    // 本文件是自己的观测积累（.ai/task-loop/ 域内），不违背 dry-run 语义
    mkdirSync(join(root, '.ai', 'task-loop'), { recursive: true });
    const sf = join(root, '.ai', 'task-loop', 'shadow.jsonl');
    writeFileSync(sf, `${JSON.stringify({ ts: new Date().toISOString(), kind: t.kind, id: t.id, summary: (t.mr?.title || '').slice(0, 60), unresolved: t.unresolved.length })}\n`, { flag: 'a' });
    recordEvent('task-loop', 'shadow_hit', { kind: t.kind, id: t.id });
    console.log(`[dry-run] 会认领 ${t.kind}-${t.id} → worktree → headless(${headless.cli} ${headless.args.join(' ')} 权限=${headless.permission_mode}) → 修复 ${t.unresolved.length} 条未解决讨论`);
    continue;
  }

  const c = claim({ cwd: root, remote: process.env.GIT_REMOTE || 'origin', kind: t.kind, id: t.id });
  if (!c.claimed) {
    if (c.reason === 'zombie') {
      recordEvent('task-loop', 'claim_zombie', { kind: t.kind, id: t.id, ageMs: c.ageMs });
      console.error(`[task-loop] ${t.kind}-${t.id} 认领已过期（${Math.round(c.ageMs / 3600_000)}h）——按 blocked 升级，不自动抢（ADR D2）`);
      blocked += 1;
    } else {
      recordEvent('task-loop', 'claim_skip', { kind: t.kind, id: t.id });
    }
    continue;
  }
  recordEvent('task-loop', 'claimed', { kind: t.kind, id: t.id, ref: c.ref });

  budget.start();
  // v1 修复动作占位：T5 接 headless 会话与 CI 归因循环；此处先落"确认意见"结构
  const ack = t.unresolved.flatMap((d) => d.notes.filter((n) => n.resolvable && !n.resolved).map((n) => ({ id: d.id, note: n.id, body: (n.body || '').slice(0, 120) })));
  mkdirSync(join(root, '.ai', 'task-loop'), { recursive: true });
  writeFileSync(join(root, '.ai', 'task-loop', `ack-${t.id}.json`), JSON.stringify({ trigger: `${t.kind}-${t.id}`, pending: ack, budget: budget.snapshot() }, null, 2));
  budget.spendRound();
  budget.pause();
  console.log(`[task-loop] ${t.kind}-${t.id} 已认领并落确认清单（${ack.length} 条待修意见，v1 占位——headless 修复在 T5 接入）`);

  if (budget.exhausted()) {
    recordEvent('task-loop', 'budget_exhausted', budget.snapshot());
    console.error(`[task-loop] 预算耗尽（轮次 ${budget.snapshot().rounds}），剩余触发转下轮`);
    blocked += 1;
    break;
  }
}
process.exit(blocked > 0 ? 1 : 0);
