#!/usr/bin/env node
/**
 * task-loop runner（T3 核心）—— 本地循环执行器：拉模型、kill switch、CAS 认领、预算、审批三条件。
 *
 * 定位（ADR-010）：每台开发机各跑一个，轮询触发（零 LLM），认领在 git 上 CAS，
 * 修复动作在独立 worktree 起无头会话（runtime.headless，hook 必接线），停机在本层判定。
 * v1 覆盖：剖面 A（MR 打回修复）的单轮骨架 + 全部安全闸；CI 归因循环（T4a/b）后续接入。
 *
 * 用法：
 *   node scripts/task-loop.mjs --once [--profile auto|a|b|both] [--dry-run] [--root <仓库>] [--mr <iid>] [--type <任务类型>]
 * 接入是**扩展条件**，不是启动前提：配了哪个源就轮询哪个，一个都没配就退出 0（不接 ≠ 坏）。
 * 凭据缺失按"未接入"处理（跳过 + 提示）；凭据在但被拒/过期按故障处理（exit 1）——两者不能混为一谈。
 * env：GITLAB_URL / GITLAB_TOKEN（剖面 A）；飞书走 runtime.feishu + $HOME/.harness/task-loop/feishu-oauth.json。
 * 定时器的凭据来自 0600 的 task-loop.env（HARNESS_ENV_FILE 可改路径）：**由本进程解析 KEY=VALUE**，
 * 不经 shell——文件是数据不是可执行代码（见 lib/env-file.mjs）。进程 env 优先于文件。
 * --dry-run 为影子周形态（零写入：不认领、不推、不起会话）。
 * 退出码：0 正常（含无事可做 / 未接入）；1 有触发但被安全闸拦，或接入的源坏了；64 用法错。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadRules } from './lib/review-rules.mjs';
import { claim, release } from './lib/claim.mjs';
import { createBudget } from './lib/task-loop-core.mjs';
import { fetchTriggers, fetchCurrentUser } from './lib/gitlab-triggers.mjs';
import { recordEvent } from '../hooks/lib/ledger.mjs';

const args = process.argv.slice(2);
// 旗标与键值分开解析：indexOf 不存在时返回 -1，args[0] 会被当成 profile 值（实测坑）
const opt = { once: args.includes('--once'), dryRun: args.includes('--dry-run'), profile: 'auto', types: [] };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--profile' && i + 1 < args.length) opt.profile = args[++i];
  else if (args[i] === '--mr' && i + 1 < args.length) opt.mr = args[++i];
  else if (args[i] === '--root' && i + 1 < args.length) opt.root = args[++i];
  // 任务类型可由用户指定：同一空间里「缺陷」「需求」是不同工作项，MQL 的表名不同，得分别查。
  // 可重复，也可逗号分隔；不给就用配置里的 taskTypes。
  else if (args[i] === '--type' && i + 1 < args.length) opt.types.push(...args[++i].split(',').map((s) => s.trim()).filter(Boolean));
  else if (args[i] === '--username' && i + 1 < args.length) opt.username = args[++i];
  else if (args[i] === '--report') opt.report = true;
  else if (args[i].startsWith('--')) continue; // 已处理的旗标
  else die(64, `未知参数：${args[i]}`);
}
const root = resolve(opt.root || process.cwd());

function die(code, msg) { console.error(`[task-loop] ${msg}`); process.exit(code); }
if (!opt.once && !opt.report) die(64, 'v1 只支持 --once / --report（常驻轮询经 deploy/task-loop 定时器触发）');
const PROFILES = ['auto', 'a', 'b', 'both'];
if (!PROFILES.includes(opt.profile)) die(64, `--profile 只认 ${PROFILES.join(' / ')}（当前 "${opt.profile}"）`);

// ---- 0600 凭据文件：本进程自己按 KEY=VALUE 解析，不交给 shell ----
// 上一版是 run-round.sh 里 `set -a; . task-loop.env`——那让凭据文件成为**可执行代码**：
// 谁能写它，谁就能以定时器身份跑任意命令。解析搬到这里之后，它只是数据。
// 非法行必须 exit 1：静默跳过会让"文件被手抖改坏"表现成"今天没有任务"。
const { loadTaskLoopEnv } = await import('./lib/env-file.mjs');
let envFile;
try { envFile = loadTaskLoopEnv(); } catch (e) { die(1, `凭据文件无法解析：${e.message}`); }
for (const w of envFile.warnings) console.error(`[task-loop] ${w}`);
if (envFile.missingExplicit) console.error(`[task-loop] 指定的凭据文件不存在：${envFile.file}（按未接入继续）`);
// 载入了几键写出来：排查"我配好了怎么没生效"时要能回答"这一轮到底读到了什么"
if (envFile.loaded.length) console.log(`[task-loop] 凭据文件已载入 ${envFile.loaded.length} 键：${envFile.file}`);

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

// ---- 触发轮询（剖面 A v1）：我名下的 open MR + 有他人未解决讨论 + 未被有效批红 = 打回待修 ----
// 判定逻辑在 scripts/lib/gitlab-triggers.mjs（纯函数、可被测试直接喂假数据）。
// 留在本文件里的上一版带 process.exit，测试 import 即执行——于是整段零覆盖：
// 把判定反转后 17 条断言零新增红。搬出去才有"改坏就变红"的可能。
const REMOTE = process.env.GIT_REMOTE || 'origin';

// ---- 认领账本：每个 claimed 必须有配对的终态，异常退出也要还回去 ----
// 上一版 claim 之后崩在 budget.start()，引用留在远端、release 从未被调用，
// 第二次运行认领被拒 → 静默 exit 0，这条 MR 从此永远不再处理。
const held = new Map();
function releaseAll(why) {
  for (const h of held.values()) {
    const ok = release({ cwd: root, remote: REMOTE, kind: h.kind, id: h.id });
    recordEvent('task-loop', ok ? 'released' : 'release_failed', { kind: h.kind, id: h.id, why });
  }
  held.clear();
}
for (const sig of ['uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => {
    releaseAll(sig);
    console.error(`[task-loop] ${sig}：${e?.message || e}——已释放持有的认领（不留孤儿引用）`);
    process.exit(1);
  });
}
process.on('exit', () => { if (held.size) releaseAll('exit'); });

// ---- 主流程 ----
// ---- 接哪个源：接入是扩展条件，不是启动前提 ----
// 配了哪个源就轮询哪个，一个都没配就退出 0（不接不算故障）。
// 显式 --profile a|b|both 视为"我就要跑这个"：缺配置直接 exit 1——意图形同断言，静默跳过是最糟的结果。
// GitLab 的 url/token 解析交给 lib/gitlab-config.mjs：doctor 读的是同一份，
// 否则"我配好了"在两个进程里指的不是同一件事。
const { resolveGitlabConfig } = await import('./lib/gitlab-config.mjs');
const gl = resolveGitlabConfig({ rules });
const GITLAB_URL = gl.url;
const GITLAB_TOKEN = gl.token;
let triggers = [];

const { resolveFeishuConfig } = await import('./lib/feishu-bug-source.mjs');
const { resolveEndpoint } = await import('./lib/feishu-project-mcp.mjs');
const { credentialPath } = await import('./lib/feishu-oauth.mjs');
const feishuCfg = resolveFeishuConfig({ rules });

const glReady = gl.configured;
const feishuSpace = !!feishuCfg.projectKey;
// 凭据"在场"与"可用"是两件事：不在场 = 没接入（跳过），在场但被拒 = 坏了（exit 1）。
const feishuCreds = existsSync(credentialPath()) || !!resolveEndpoint();
const feishuReady = feishuSpace && feishuCreds;

const explicit = opt.profile !== 'auto';
const wantGitlab = opt.profile === 'a' || opt.profile === 'both' || (!explicit && glReady);
const wantFeishu = opt.profile === 'b' || opt.profile === 'both' || (!explicit && feishuReady);

if (explicit && wantGitlab && !glReady) {
  die(1, `显式指定了剖面 A，但 GitLab 没接（缺 ${gl.missing.join(' / ')}）：`
    + '在 harness.rules.json 的 runtime.gitlab.url 填实例根地址（或 GITLAB_URL），'
    + `token 走 GITLAB_TOKEN 或 0600 文件 ${gl.tokenFile}（PAT，private-token 头只认 PAT）`);
}
if (explicit && wantFeishu && !feishuSpace) {
  die(1, '显式指定了剖面 B，但 runtime.feishu.projectKey 为空 —— MQL 的表名必须是 `<空间>.<工作项类型>`，缺空间名服务端只会回一句 semantic error');
}
if (explicit && wantFeishu && !feishuCreds) {
  die(1, '显式指定了剖面 B，但没有任何飞书凭据：先跑 node scripts/feishu-auth.mjs login（OAuth 用户身份，不需要空间管理员）；'
    + '或改用插件身份 FEISHU_MCP_URL（或 FEISHU_MCP_KEY + FEISHU_USER_KEY），但那需要空间管理员安装插件');
}
if (!wantGitlab && !wantFeishu) {
  const why = [];
  if (!feishuSpace) why.push('飞书：runtime.feishu.projectKey 为空');
  else if (!feishuCreds) why.push('飞书：空间已配但未登录（node scripts/feishu-auth.mjs login）');
  if (!GITLAB_URL) why.push('GitLab：runtime.gitlab.url 为空（或 GITLAB_URL）');
  if (!GITLAB_TOKEN) why.push(`GitLab：缺 token（GITLAB_TOKEN 或 0600 文件 ${gl.tokenFile}）`);
  recordEvent('task-loop', 'no_source', {});
  console.log('[task-loop] 未接入任何触发源，本轮结束（接入是扩展项，不接不算故障）');
  for (const w of why) console.log(`  · ${w}`);
  process.exit(0);
}

if (wantGitlab) {
  // username 不配：token 是谁就是谁。
  let username = opt.username || process.env.GITLAB_USERNAME || '';
  const fromConfig = !username;
  try {
    if (fromConfig) username = await fetchCurrentUser({ url: GITLAB_URL, token: GITLAB_TOKEN });
    triggers.push(...await fetchTriggers({ url: GITLAB_URL, token: GITLAB_TOKEN, username, mrFilter: opt.mr }));
    recordEvent('task-loop', 'gitlab_polled', { username, identity: fromConfig ? 'token' : 'override', triggers: triggers.length });
  } catch (e) {
    die(1, `剖面 A 触发轮询失败：${e.message}`);
  }
}

if (wantFeishu) {
  // 剖面 B：MQL 轮询指派给我的待处理工作项 → P0/P1 自动、P2 confirm_first（确认卡片走订阅 T2）
  const { connect, McpPermError, McpAuthError } = await import('./lib/feishu-project-mcp.mjs');
  const { buildMyBugsMql, parseMqlPage, gateBySeverity, filterByIterationPrefix } = await import('./lib/feishu-bug-source.mjs');
  const { ensureToken } = await import('./lib/feishu-oauth.mjs');

  // 空间身份来自配置（harness.rules.json runtime.feishu），env 只做临时覆盖。
  // 这样定时器装到别的机器上不用逐条渲染环境变量——install-task-loop.sh 漏注入一个变量
  // 就是一个静默失败，而配置文件跟着仓库走，不存在"漏注入"。
  const cfg = feishuCfg;

  // 身份优先级：OAuth（用户身份，只代表你自己，不需要空间管理员安装任何插件）→ mcpKey（插件身份，需空间安装）。
  // 走到这里说明凭据在场，因此 ensureToken 失败 ≠ 未接入，而是接入坏了：必须 exit 1。
  // 否则 token 过期后的每一轮都"安静地没有任务"，与"今天真没活"长得一模一样。
  let token = null;
  if (existsSync(credentialPath())) {
    try {
      token = await ensureToken();
      recordEvent('task-loop', 'feishu_auth', { mode: 'oauth' });
    } catch (e) {
      die(1, `剖面 B 凭据不可用（已登录但被拒/过期）：${e.message}\n  重新登录：node scripts/feishu-auth.mjs login`);
    }
  }
  const endpoint = resolveEndpoint() || `${cfg.issuer}/mcp_server/v1`;

  // 任务类型可由用户指定（--type 优先于 runtime.feishu.taskTypes）。逐个类型查：
  // MQL 的表名就是类型名，一个 MQL 只能查一种工作项，把「缺陷」和「需求」塞进同一句不可能。
  const types = opt.types.length ? opt.types : cfg.taskTypes;
  let confirmTotal = 0;
  try {
    const c = await connect(endpoint, { token });
    for (const itemType of types) {
      const mql = buildMyBugsMql({
        projectKey: cfg.projectKey,
        workItemType: itemType,
        assigneeField: cfg.assigneeField,
        statuses: [cfg.newStatus],
        severityField: cfg.severityField,
        iterationField: cfg.iterationField,
        limit: cfg.mqlLimit,
      });
      let raw;
      try {
        raw = await c.call('search_by_mql', { project_key: cfg.projectKey, mql });
      } catch (e) {
        // 类型名写错时服务端只回一句 "metadata error"，隔着网络看不出是自己把类型名填错了。
        // 这里补上上下文：这类错几乎都是 --type / taskTypes 指到了该空间不存在的工作项类型。
        if (/metadata/i.test(String(e.message || ''))) {
          die(1, `剖面 B 查「${itemType}」失败：${e.message}——该空间没有这个工作项类型名。`
            + `核对 runtime.feishu.taskTypes 或 --type（本空间实测类型名为 Defect；类型名以空间设置里显示的名称为准）`);
        }
        throw e;
      }
      const page = parseMqlPage(raw, { severityField: cfg.severityField, severityMap: cfg.severityMap, iterationField: cfg.iterationField || null });
      // 单次上限 50、LIMIT 只是截断不是分页：待办多于 LIMIT 时必须说出来，
      // 否则"少了 10 张单"和"本来就只有 10 张"在日志里一模一样。
      if (page.count != null && page.count > page.bugs.length) {
        console.warn(`[task-loop] 剖面 B ${itemType} 命中 ${page.count} 张，本轮只取回 ${page.bugs.length} 张（LIMIT 截断）——剩余需翻页或提高 runtime.feishu.mqlLimit，别当"没有更多"`);
        recordEvent('task-loop', 'profile_b_truncated', { itemType, count: page.count, taken: page.bugs.length });
      }
      // 产品线过滤（TDasset 落地规则 2026-11-14）：迭代周期 label 以 IDMP 开头才算本产品 bug。
      // 必须在分级门槛**之前**——非本线的单不占 P0/P1 自动接单额度，也不该出现在确认卡里。
      let lineBugs = page.bugs;
      if (cfg.iterationPrefix && cfg.iterationField) {
        const { matched, skipped } = filterByIterationPrefix(page.bugs, cfg.iterationPrefix);
        if (skipped.length) {
          console.log(`[task-loop] 迭代过滤：${itemType} 命中 ${page.bugs.length} 张，非 ${cfg.iterationPrefix} 迭代筛掉 ${skipped.length} 张（${skipped.map((b) => b.work_item_id).slice(0, 5).join('、')}${skipped.length > 5 ? ' 等' : ''}）`);
          recordEvent('task-loop', 'profile_b_iteration_filtered', { itemType, prefix: cfg.iterationPrefix, kept: matched.length, skipped: skipped.length });
        }
        lineBugs = matched;
      }
      const { auto, confirm, skip } = gateBySeverity(lineBugs, undefined, cfg.severityMap);
      recordEvent('task-loop', 'profile_b_polled', { itemType, auto: auto.length, confirm: confirm.length, skip: skip.length, status: cfg.newStatus, space: cfg.projectKey });
      triggers.push(...auto.map((b) => ({ kind: 'task', id: b.work_item_id, itemType, bug: b, unresolved: [] })));
      confirmTotal += confirm.length;
    }
    if (confirmTotal > 0) console.log(`[task-loop] ${confirmTotal} 张 P2 单待确认（confirm_first，卡片确认后 --task <单号> 启动）`);
  } catch (e) {
    if (e instanceof McpAuthError) die(1, `剖面 B 身份被拒：${e.message}`);
    if (e instanceof McpPermError) die(1, `剖面 B 数据档未授权：${e.message}（飞书后台给 MCP 应用勾选工作项读取范围；探测见 doctor-gates 套件）`);
    die(1, `剖面 B 触发轮询失败：${e.message}`);
  }
}

const ranSources = [wantGitlab ? 'gitlab' : null, wantFeishu ? 'feishu' : null].filter(Boolean).join('+');
if (triggers.length === 0) { console.log(`[task-loop] ${ranSources} 无待办触发，本轮结束`); process.exit(0); }

let blocked = 0;
for (const t of triggers) {
  recordEvent('task-loop', 'trigger_found', {
    kind: t.kind, id: t.id, unresolved: t.unresolved.length,
    review_state: t.reviewState, signal: t.signal,
  });

  if (opt.dryRun) {
    // 影子周素材：每个 tick 命中都落 shadow.jsonl（--report 出统计）——零写入指对外部系统，
    // 本文件是自己的观测积累（.ai/task-loop/ 域内），不违背 dry-run 语义
    mkdirSync(join(root, '.ai', 'task-loop'), { recursive: true });
    const sf = join(root, '.ai', 'task-loop', 'shadow.jsonl');
    writeFileSync(sf, `${JSON.stringify({ ts: new Date().toISOString(), kind: t.kind, id: t.id, summary: (t.mr?.title || '').slice(0, 60), unresolved: t.unresolved.length })}\n`, { flag: 'a' });
    recordEvent('task-loop', 'shadow_hit', { kind: t.kind, id: t.id });
    console.log(`[dry-run] 会认领 ${t.kind}-${t.id}${t.itemType ? `（${t.itemType}）` : ''} → worktree → headless(${headless.cli} ${headless.args.join(' ')} 权限=${headless.permission_mode}) → ${t.kind === 'mr' ? `修复 ${t.unresolved.length} 条未解决讨论` : '排期修复（缺陷/需求）'}`);
    continue;
  }

  const c = claim({ cwd: root, remote: REMOTE, kind: t.kind, id: t.id, ttlMs: rules.runtime?.budget?.claimTtlMs });
  if (!c.claimed) {
    if (c.reason === 'zombie') {
      recordEvent('task-loop', 'claim_zombie', { kind: t.kind, id: t.id, ageMs: c.ageMs });
      console.error(`[task-loop] ${t.kind}-${t.id} 认领已过期（${Math.round(c.ageMs / 3600_000)}h）——按 blocked 升级，不自动抢（ADR D2）`);
      blocked += 1;
    } else if (c.unreadable) {
      // 读不到认领时间 ≠ 判过"在世"：如实落账，否则"僵尸没被发现"在报表里看不见
      recordEvent('task-loop', 'claim_skip', { kind: t.kind, id: t.id, age_unreadable: true });
      console.error(`[task-loop] ${t.kind}-${t.id} 已有认领，但读不到其时间——按在世跳过（不猜是否过期）`);
    } else {
      recordEvent('task-loop', 'claim_skip', { kind: t.kind, id: t.id, ageMs: c.ageMs ?? null });
    }
    continue;
  }
  held.set(`${t.kind}-${t.id}`, { kind: t.kind, id: t.id });
  recordEvent('task-loop', 'claimed', { kind: t.kind, id: t.id, ref: c.ref });

  // 预算按**单任务**建：maxRounds 是"同一任务最多几轮修复"，不是"--once 里能处理几个任务"。
  // 上一版 import 了 createBudget 却从未调用，直接 budget.start() —— 真检测到触发就
  // ReferenceError；而 --dry-run 走不到该行，所以影子周验收全绿、单任务第一次真跑就崩。
  const budget = createBudget({
    maxRounds: rules.runtime?.budget?.maxRounds,
    maxActiveMs: rules.runtime?.budget?.maxActiveMs,
  });
  budget.start();
  try {
    // v1 修复动作占位：T5 接 headless 会话与 CI 归因循环；此处先落"确认意见"结构
    const ack = t.unresolved.flatMap((d) => d.notes.filter((n) => n.resolvable && !n.resolved).map((n) => ({ id: d.id, note: n.id, body: (n.body || '').slice(0, 120) })));
    mkdirSync(join(root, '.ai', 'task-loop'), { recursive: true });
    writeFileSync(join(root, '.ai', 'task-loop', `ack-${t.id}.json`), JSON.stringify({ trigger: `${t.kind}-${t.id}`, pending: ack, budget: budget.snapshot() }, null, 2));
    budget.spendRound();
    budget.pause();
    // 终态：本轮修复没做完（v1 占位），认领**继续持有**——但必须显式落账。
    // 只记 claimed 不记配对事件，孤儿引用在任何报表里都看不出来（crewAI 的 EventPairingError
    // 同一个道理：start 没有 end 就该当场报错，而不是等翻日志才发现）。
    recordEvent('task-loop', 'claim_held', { kind: t.kind, id: t.id, ref: c.ref, budget: budget.snapshot() });
    console.log(`[task-loop] ${t.kind}-${t.id} 已认领并落确认清单（${ack.length} 条待修意见，v1 占位——headless 修复在 T5 接入）`);
  } catch (e) {
    // 认领之后失败 → 当场释放，别把 MR 锁在一个没人干活的引用上（上次实测的泄漏路径）
    budget.pause();
    recordEvent('task-loop', 'task_failed', { kind: t.kind, id: t.id, error: String(e.message || e) });
    const ok = release({ cwd: root, remote: REMOTE, kind: t.kind, id: t.id });
    recordEvent('task-loop', ok ? 'released' : 'release_failed', { kind: t.kind, id: t.id, why: 'task_failed' });
    held.delete(`${t.kind}-${t.id}`);
    console.error(`[task-loop] ${t.kind}-${t.id} 处理失败：${e.message}——认领${ok ? '已释放' : '释放失败（残留由 TTL 兜底）'}`);
    blocked += 1;
    continue;
  }

  if (budget.exhausted()) {
    const snap = budget.snapshot();
    recordEvent('task-loop', 'budget_exhausted', snap);
    console.error(`[task-loop] 预算耗尽（轮次 ${snap.rounds}/${snap.maxRounds}），剩余触发转下轮`);
    blocked += 1;
    break;
  }
}
// 正常收尾仍持有的认领不释放（任务没做完，锁要留着），但清空账目避免 exit 钩子二次处理
held.clear();
process.exit(blocked > 0 ? 1 : 0);
