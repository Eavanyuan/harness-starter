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
 * 退出码：0 正常（含无事可做 / 未接入）；1 有触发但被安全闸拦、接入的源坏了、或某源临时不可达
 *   （临时不可达 = 跳过该源继续跑其余源，但不落节流戳——下一 tick 立即重试，不吃两小时节拍）；64 用法错。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, readdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { loadRules } from './lib/review-rules.mjs';
import { claim, release } from './lib/claim.mjs';
import { createBudget } from './lib/task-loop-core.mjs';
import { fetchTriggers, fetchCurrentUser, triggerFingerprint } from './lib/gitlab-triggers.mjs';
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

// die 双通道（2026-11-16）：plist 把 stderr 分流到 task-loop.err，只写 stderr 时 .out 里只剩
// "凭据已载入"然后无声退出（实测：剖面 A 超时连转 9 小时，.out 一片安静）。stdout 同步一行，
// 让 .out 永远能回答"这轮死在哪"。终端里会看到同文两行，代价可接受。
function die(code, msg) { const line = `[task-loop] ${msg}`; console.error(line); console.log(line); process.exit(code); }
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

// ---- 轮询节拍（可配置，2026-11-14）：OS 定时器只是心跳，真实节拍在这里 ----
// 为什么不只有 install --interval：那会把节拍烙进 launchd/systemd 单元，改一次重装一次。
// 配置跟仓库走（同 runtime.feishu 的理由）：改 harness.rules.json 的
// runtime.taskLoop.pollSeconds，下一拍即生效，不用碰定时器。
// 节流只对定时器触发（HARNESS_TIMER=1，由 deploy 模板注入）生效——手动 --once 是
// "我现在就要跑"，不受节拍限制。节流戳在**轮次成功后**才落：中途崩溃则下一心跳
// 立即重试，不会被自己的节拍吞掉。
const taskLoopCfg = (rules.runtime && rules.runtime.taskLoop && typeof rules.runtime.taskLoop === 'object') ? rules.runtime.taskLoop : {};
const pollSeconds = (() => {
  const fromEnv = Number(process.env.TASK_LOOP_INTERVAL);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv; // 临时覆盖（演练/排查）
  const fromCfg = Number(taskLoopCfg.pollSeconds);
  if (Number.isFinite(fromCfg) && fromCfg > 0) return fromCfg;
  return 180;
})();
const lastRunStamp = join(root, '.ai', 'locks', 'task-loop.last-run');
if (process.env.HARNESS_TIMER === '1') {
  if (existsSync(lastRunStamp)) {
    const ageSec = Math.floor((Date.now() - statSync(lastRunStamp).mtimeMs) / 1000);
    if (ageSec < pollSeconds) {
      console.log(`[task-loop] 距上一轮 ${ageSec}s < 节拍 ${pollSeconds}s（runtime.taskLoop.pollSeconds / env TASK_LOOP_INTERVAL）——本轮跳过`);
      process.exit(0);
    }
  }
}
// 节流戳语义（复审B澄清）：任何成功轮次（定时器或手动）都刷新——手动跑完定时器
// 不必立刻重跑同一轮；「手动不受节拍限制」指进入不受限，不是跑完不留痕。
function stampLastRun() {
  mkdirSync(join(root, '.ai', 'locks'), { recursive: true });
  writeFileSync(lastRunStamp, `${new Date().toISOString()} pollSeconds=${pollSeconds}\n`);
}

// ---- 轮次围栏（2026-11-16）：每轮恰好一行结束摘要——"载入凭据后无声退出"必须不可能 ----
// 背景：plist 的 stdout/stderr 分流 + 源失败 die(1) 只写 stderr，.out 里 9 小时只见"已载入"。
// 围栏行永远走 stdout，无论本轮成败都能对账（触发/认领/关账计数 + 耗时 + exit 码）。
const ROUND_START = Date.now();
const stats = { claimed: 0, noop: 0, skip: 0, gone: 0, stale: 0, pack: 0, escalated: 0 };
const softFail = []; // {source}：临时不可达（超时/断网/5xx）——跳过该源、不落戳、exit 1 下 tick 重试
function finish({ code, stamp }) {
  const parts = [`触发 ${triggers.length}`, `认领 ${stats.claimed}`, `待复核 ${stats.noop}`, `跳过 ${stats.skip}`, `关账 ${stats.gone}`, `内容更新 ${stats.stale}`];
  if (stats.pack) parts.push(`会话包 ${stats.pack}`);
  if (softFail.length) parts.push(`源故障 ${softFail.map((f) => f.source).join('+')}（跳过该源，下 tick 重试）`);
  if (stats.escalated) parts.push(`升级 ${stats.escalated}`);
  console.log(`[task-loop] 轮次结束：${parts.join(' / ')}｜耗时 ${((Date.now() - ROUND_START) / 1000).toFixed(1)}s｜exit ${code}${stamp ? '' : '（不落节流戳，下一 tick 立即重试）'}`);
  if (stamp) stampLastRun();
  process.exit(code);
}
// ---- 本地轮次互斥（2026-11-17 ci-inflight-hold）----
// launchd 心跳 180s，而一轮可跑 10s+；轮次一旦超过心跳就会并发第二份进程。认领有 CAS 仲裁，
// 但 sweep/ack 写盘没有。排他文件锁：新轮直接跳过；超过 30min 的锁视为孤儿可接管
// （持有进程已死，锁内容是 host/pid/时间）。
const ROUND_LOCK_MAX_AGE_MS = 30 * 60_000;
const roundLockPath = join(root, '.ai', 'locks', 'task-loop.round');
let roundLockOwned = false; // 🔴 CR：只有持有者能在退出时删锁——跳过的进程删掉别人的活锁=锁自毁
function acquireRoundLock() {
  mkdirSync(join(root, '.ai', 'locks'), { recursive: true }); // fresh clone 首跑没有 locks 目录（CR 🟡#2：ENOENT 不是"判不了"是"没地方放"）
  const write = () => { const fd = openSync(roundLockPath, 'wx'); writeSync(fd, `${hostname()}-${process.pid}-${new Date().toISOString()}\n`); closeSync(fd); };
  try { write(); roundLockOwned = true; return true; } catch (e) {
    if (e.code !== 'EEXIST') return true; // 判不了锁就不过度保守（锁是保险不是门禁）
    try {
      const age = Date.now() - statSync(roundLockPath).mtimeMs;
      if (age < ROUND_LOCK_MAX_AGE_MS) return false;
      rmSync(roundLockPath, { force: true }); // 孤儿锁接管（>30min：一轮不该跑这么久，budget 兜底）
      try { write(); roundLockOwned = true; return true; }
      catch (e2) {
        // 接管竞态（CR 🟡#3）：别人先一步重建了锁——看新锁年龄，新鲜=有活人，退出
        if (e2.code === 'EEXIST') { try { return (Date.now() - statSync(roundLockPath).mtimeMs) >= ROUND_LOCK_MAX_AGE_MS; } catch { return false; } }
        throw e2;
      }
    } catch { return true; }
  }
}
process.on('exit', () => { if (roundLockOwned) { try { rmSync(roundLockPath, { force: true }); } catch { /* 最后一道，不抛 */ } } });
if (!acquireRoundLock()) {
  console.log('[task-loop] 上一轮仍在进行（轮次锁 < 30min）——本轮跳过，CAS 认领已防重复认领');
  process.exit(0); // 不持有锁：exit 钩子不动锁文件（CR 🔴：跳过者删持有者的锁=放并发进来）
}

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
// 在途集合（流水 running/pending 的我的 MR）：轮询时捕获，sweep 据此不关账不重认领
let gitlabInflight = new Set();
// Draft 集合（2026-11-18 draft-skip）：不触发、不认领；已认领的 Draft 在 sweep 关账（ready 后自动纳入）
let gitlabDrafts = new Set();
let draftSkipped = 0;
// 飞书 MCP 调用引用（2026-11-14 接单三连接线）：声明必须在轮询块**外**——第一版声明在
// wantFeishu 块里，认领后的 ack 段读不到，uncaughtException 把整轮掀了（实测，fail-safe 释放了认领）。
let feishuCall = null;

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
  finish({ code: 0, stamp: true });
}

if (wantGitlab) {
  // username 不配：token 是谁就是谁。
  let username = opt.username || process.env.GITLAB_USERNAME || '';
  const fromConfig = !username;
  try {
    if (fromConfig) username = await fetchCurrentUser({ url: GITLAB_URL, token: GITLAB_TOKEN });
    const fetched = await fetchTriggers({ url: GITLAB_URL, token: GITLAB_TOKEN, username, mrFilter: opt.mr, skipDrafts: taskLoopCfg.skipDrafts !== false, fixSuggestions: taskLoopCfg.fixSuggestions !== false });
    triggers.push(...fetched);
    if (fetched.inflight instanceof Set) gitlabInflight = fetched.inflight; // 数组属性经 spread 丢失，单独捕获
    if (fetched.drafts instanceof Set) { gitlabDrafts = fetched.drafts; draftSkipped = fetched.drafts.size; }
    // 详情 404（CR 二审 🟡#2′）：MR 在列表里但详情已 404 = 刚被关/合并的竞态，跳过是正常路径，
    // 但持续 404 不许无痕——落账一行，报表里看得见。
    if (draftSkipped > 0) console.log(`[task-loop] ${draftSkipped} 条 Draft MR 未列入（runtime.taskLoop.skipDrafts，ready 后自动纳入）`);
    if (taskLoopCfg.fixSuggestions === false) console.log('[task-loop] fixSuggestions=false——仅修阻断项（建议性评论已退出触发与修复范围）');
    if (fetched.skipped404) {
      recordEvent('task-loop', 'mr_detail_404', { count: fetched.skipped404 });
      console.log(`[task-loop] ${fetched.skipped404} 条 MR 详情 404（刚被关/合并的竞态，跳过；若持续出现查 token 权限）`);
    }
    recordEvent('task-loop', 'gitlab_polled', { username, identity: fromConfig ? 'token' : 'override', triggers: triggers.length });
  } catch (e) {
    // 2026-11-16 实测：内网 GitLab 不可达时这里超时 die(1)，把还没轮询的剖面 B 一起拖死——
    // 单源故障不该致盲所有源。临时故障（超时/断网/5xx）= 跳过该源继续，不落戳下 tick 重试；
    // 凭据/配置类硬故障（401/403/404…）才整轮 die（接入坏了必须有人看见）。
    const txt = `${e?.message || e} ${e?.cause?.code || ''} ${e?.cause?.message || ''}`;
    const temporary = /timeout|aborted|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNABORTED|HTTP 429|HTTP 5\d\d/i.test(txt);
    if (!temporary) die(1, `剖面 A 触发轮询失败：${e?.message || e}`);
    recordEvent('task-loop', 'source_soft_fail', { source: 'gitlab', error: String(e?.message || e).slice(0, 160) });
    console.log(`[task-loop] 剖面 A 临时不可达（${e?.message || e}）——本轮跳过该源，其余源继续`);
    softFail.push({ source: 'gitlab' });
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
    // 提为模块级引用（声明见 triggers 旁）：轮询段用完不弃——认领后的接单三连
    // （评论 + New→Processing）复用同一条连接与身份，避免二次握手与身份不一致。
    feishuCall = c.call;
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
    // 与剖面 A 同口径：网络类临时故障跳过该源，不拖死剖面 A（2026-11-16）；429/5xx 同为临时（CR 🟡#1）。
    const txt = `${e?.message || e} ${e?.cause?.code || ''} ${e?.cause?.message || ''}`;
    const temporary = /timeout|aborted|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNABORTED|HTTP 429|HTTP 5\d\d/i.test(txt);
    if (!temporary) die(1, `剖面 B 触发轮询失败：${e?.message || e}`);
    recordEvent('task-loop', 'source_soft_fail', { source: 'feishu', error: String(e?.message || e).slice(0, 160) });
    console.log(`[task-loop] 剖面 B 临时不可达（${e?.message || e}）——本轮跳过该源，其余源继续`);
    softFail.push({ source: 'feishu' });
  }
}

const ranSources = [wantGitlab ? 'gitlab' : null, wantFeishu ? 'feishu' : null].filter(Boolean).join('+');
// 跨流水轮次携带（ci-inflight-hold）：sweep 重置 ack 时记下"这是第几轮"，claim 循环据此判升级
const carryRounds = new Map();

// ---- ack 生命周期 sweep（2026-11-16 关账半环）：触发源消失/内容已变 → 清账或重认 ----
// 背景：认领落 ack 后若 MR 被合并/批红，触发集里不再有它——ack 与远端认领会一直挂到 TTL
// 僵尸升级，"修完了"在账面上看不出来。飞书单的关账需按单号反查状态（MQL 单查），本批不做（KI）。
// 🔴 CR 复审 #1："不在本轮触发集" ≠ "触发已消失"。GitLab 软失败（本轮没查到）、--mr 过滤
// （视角收窄）、--profile b（根本没查）三种路径下 MR 都不在 triggers 里，但它们活得好好的一一
// 误关账会释放认领（让别的机器抢走）、清零 budget/TTL（断连→恢复循环可反复绕过 maxRounds 升级）。
// 所以 sweep 只在本轮**真实轮询成功且未收窄**时才判"消失"；否则本轮不动账。
if (!opt.dryRun) {
  const gitlabViewComplete = wantGitlab && !softFail.some((f) => f.source === 'gitlab') && !opt.mr;
  const ackDir = join(root, '.ai', 'task-loop');
  let ackFiles = [];
  try { ackFiles = readdirSync(ackDir).filter((f) => /^ack-.+\.json$/.test(f)); } catch { /* 目录不存在/被文件占位：无账可清 */ }
  const active = new Map(triggers.map((t) => [`${t.kind}-${t.id}`, t]));
  // 在途集合（fetchTriggers.inflight）：执行器刚推的修复流水正跑着——不触发也不许关账。
  // 误关账实测形态：推送后 head_pipeline=running → 非 failed 不在触发集 → 被当"已合并/已批红"关掉。
  const inflight = gitlabInflight;
  for (const f of ackFiles) {
    let a = null;
    try { a = JSON.parse(readFileSync(join(ackDir, f), 'utf8')); } catch { continue; }
    const key = a.trigger;
    if (!key || !key.startsWith('mr-')) continue; // task 关账留待单查 API（KI-1）
    if (!gitlabViewComplete) continue; // 本轮看不见 ≠ 消失：软失败/过滤轮不动账
    const id = key.slice(3);
    const cur = active.get(key);
    if (!cur && gitlabDrafts.has(key)) {
      // Draft MR：用户指令暂不列入修复执行腿——关账（与合并/批红同等待遇），ready 后自动重新纳入
      const okRel = release({ cwd: root, remote: REMOTE, kind: 'mr', id });
      rmSync(join(ackDir, f));
      rmSync(join(ackDir, `pack-${id}.md`), { force: true });
      recordEvent('task-loop', 'trigger_gone', { kind: 'mr', id, released: okRel, why: 'draft' });
      stats.gone += 1;
      console.log(`[task-loop] ${key} 已转 Draft——关账（暂不列入修复执行腿，ready 后自动纳入）`);
      continue;
    }
    if (!cur && inflight.has(key)) {
      // 流水在跑（新推送待出结果）：既不关账也不判 stale——下一轮终态出来自然走对分支
      console.log(`[task-loop] ${key} 流水在跑（新推送待出结果）——账目保持，不动`);
      continue;
    }
    if (!cur) {
      // 触发消失：merged / approved / closed → 释放认领 + 删 ack（含工单）(关账)
      const okRel = release({ cwd: root, remote: REMOTE, kind: 'mr', id });
      rmSync(join(ackDir, f));
      rmSync(join(ackDir, `pack-${id}.md`), { force: true });
      recordEvent('task-loop', 'trigger_gone', { kind: 'mr', id, released: okRel });
      stats.gone += 1;
      console.log(`[task-loop] ${key} 不再触发（已合并/已批红/已关闭）——释放认领并清理 ack 与工单（关账）`);
    } else if (!a.fingerprint || a.fingerprint !== triggerFingerprint(cur)) {
      // 内容有更新（或旧格式 ack 无指纹、无法比对）：重置 ack，本轮 claim 循环会重新认领重写。
      // 旧格式选择重认领而非补写：无基准可比对，且 pending 清单本身可能已过期，重建才是对的（CR 🟡#6）。
      // 轮次携带：连续第 N 轮修复（跨流水累计），新 ack 会用它判预算外升级。
      if (a.fingerprint?.startsWith('ci:')) carryRounds.set(String(id), (a.ci?.rounds ?? 1) + 1);
      const why = a.fingerprint ? 'ack_stale' : 'ack_migrated';
      const okRel = release({ cwd: root, remote: REMOTE, kind: 'mr', id });
      rmSync(join(ackDir, f));
      recordEvent('task-loop', why, { kind: 'mr', id, released: okRel });
      stats.stale += 1;
      console.log(`[task-loop] ${key} ${a.fingerprint ? '待修内容有更新' : '旧格式 ack 迁移（一次性重认领）'}——重置 ack，本轮重新认领`);
    }
  }
}

if (triggers.length === 0) {
  console.log(`[task-loop] ${ranSources} 无待办触发，本轮结束`);
  finish({ code: softFail.length ? 1 : 0, stamp: !softFail.length });
}

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
    writeFileSync(sf, `${JSON.stringify({ ts: new Date().toISOString(), kind: t.kind, id: t.id, summary: (t.mr?.title || '').slice(0, 60), unresolved: t.unresolved.length, comments: (t.comments || []).length })}\n`, { flag: 'a' });
    recordEvent('task-loop', 'shadow_hit', { kind: t.kind, id: t.id });
    console.log(`[dry-run] 会认领 ${t.kind}-${t.id}${t.itemType ? `（${t.itemType}）` : ''} → worktree → headless(${headless.cli} ${headless.args.join(' ')} 权限=${headless.permission_mode}) → ${t.kind === 'mr' ? (t.signal === 'ci_pipeline' ? `拉流水 ${t.ci.pipelineId} 日志归因（CI 红）→ 修引入项` : `修复 ${t.unresolved.length} 条未解决讨论 + ${(t.comments || []).length} 条建议评论`) : '排期修复（缺陷/需求）'}`);
    continue;
  }

  // ---- 信息完备性守门（2026-11-15 用户指令）：描述无法复现且无截图/日志 → 不接单，评论 @提交者追问 ----
  // 只对飞书单且真实轮次生效（dry-run 零写入）。只追问一次（feishu-ask 内部防重）。
  if (t.kind === 'task' && feishuCall && !opt.dryRun) {
    try {
      const { checkInfoOrAsk } = await import('./lib/feishu-ask.mjs');
      const check = await checkInfoOrAsk({ call: feishuCall, projectKey: feishuCfg.projectKey, workItemId: t.id, workItemType: t.itemType || 'Defect' });
      if (!check.ok) {
        recordEvent('task-loop', 'info_incomplete', { id: t.id, asked: !!check.asked, already_asked: !!check.already_asked, reason: String(check.reason || '').slice(0, 120) });
        if (check.asked) {
          console.log(`[task-loop] ${t.id} 信息不全 → 已评论 @提交者追问（不接单）：${check.reason}`);
        } else if (check.already_asked) {
          console.log(`[task-loop] ${t.id} 信息不全且已追问过 → 跳过（等提交者补充）`);
        } else {
          console.log(`[task-loop] ${t.id} 信息不全但追问失败 → 跳过本轮：${check.reason}`);
        }
        continue; // 不认领不流转，下一轮重新评估
      }
    } catch (e) {
      // 完备性检查自身故障 → 不拦（不因工具故障误判），照常走认领
      recordEvent('task-loop', 'info_check_error', { id: t.id, error: String(e.message).slice(0, 120) });
      console.error(`[task-loop] ${t.id} 完备性检查异常（不拦截）：${e.message}`);
    }
  }

  const c = claim({ cwd: root, remote: REMOTE, kind: t.kind, id: t.id, ttlMs: rules.runtime?.budget?.claimTtlMs });
  if (!c.claimed) {
    stats.skip += 1;
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
  stats.claimed += 1;
  recordEvent('task-loop', 'claimed', { kind: t.kind, id: t.id, ref: c.ref });

  // ---- 接单（2026-11-15 定稿）：只流转 New→Processing，零评论 ----
  // 语义演变：v1"评论+流转+评论兜底"经真实首跑作废——update_field 是错工具静默失败、
  // 兜底评论谎报"已流转"并刷屏（用户指令：不要添加评论）。现接单=transition_state+MQL
  // 回读确认，仅此而已；幂等（已是 Processing 直接 ok）。失败释放认领下一轮重试。
  if (t.kind === 'task' && feishuCall) {
    try {
      const { acknowledgeBug } = await import('./lib/feishu-sync.mjs');
      const ackRes = await acknowledgeBug({
        call: feishuCall,
        projectKey: feishuCfg.projectKey,
        workItemId: t.id,
        workItemType: t.itemType || 'Defect',
      });
      if (ackRes.ok) {
        recordEvent('task-loop', 'feishu_ack', { id: t.id, via: ackRes.transition?.via, from: ackRes.transition?.from, to: ackRes.transition?.to });
        console.log(`[task-loop] ${t.id} 已接单：状态 ${ackRes.transition?.from ?? '?'}→Processing（${ackRes.transition?.via === 'already' ? '此前已流转' : 'transition_state 已确认'}，无评论）`);
      } else {
        throw new Error(ackRes.transition?.reason || '接单未成功');
      }
    } catch (e) {
      recordEvent('task-loop', 'feishu_ack_failed', { id: t.id, error: String(e.message || e).slice(0, 160) });
      console.error(`[task-loop] ${t.id} 接单失败：${e.message}——释放认领，下一轮重试`);
      const okRel = release({ cwd: root, remote: REMOTE, kind: t.kind, id: t.id });
      if (okRel) held.delete(`${t.kind}-${t.id}`);
      recordEvent('task-loop', okRel ? 'released' : 'release_failed', { kind: t.kind, id: t.id, why: 'feishu_ack_failed' });
      blocked += 1;
      continue;
    }
  }

  // 预算按**单任务**建：maxRounds 是"同一任务最多几轮修复"，不是"--once 里能处理几个任务"。
  // 上一版 import 了 createBudget 却从未调用，直接 budget.start() —— 真检测到触发就
  // ReferenceError；而 --dry-run 走不到该行，所以影子周验收全绿、单任务第一次真跑就崩。
  const budget = createBudget({
    maxRounds: rules.runtime?.budget?.maxRounds,
    maxActiveMs: rules.runtime?.budget?.maxActiveMs,
  });
  budget.start();
  try {
    // 待修清单两路：①打回（他人未解决 resolvable 讨论 + 评审建议性评论，2026-11-16 用户指令：
    // 建议修改项也纳入修复范围——动词型触发往往零 resolvable，只靠讨论会得到空清单）；
    // ②CI 红（ci-fail-trigger 2026-11-17：认领后拉日志归因，引入项进清单，基线同款不修）。
    let ack;
    let ciInfo = null;
    let ciAttr = null;
    let ciFetch = null;
    // fingerprint 在 CI 分支与通用路径都要用（升级分支也落它）——先算，避免 TDZ
    const fingerprint = t.kind === 'mr' ? triggerFingerprint(t) : undefined;
    if (t.signal === 'ci_pipeline') {
      const { fetchPipelineFailures, fetchLatestPipelineForRef, attributeCi } = await import('./lib/ci-failures.mjs');
      ciFetch = await fetchPipelineFailures({ url: GITLAB_URL, token: GITLAB_TOKEN, projectId: t.mr.project_id, pipelineId: t.ci.pipelineId });
      // 归因基线 = 目标分支最新流水（远端 CI 结果，不本地双树实跑——重项目全量测试一轮几分钟起，
      // T4a 的 merge-base 双树留给需要本地复现的场景）。取不到基线明说 unknown，不猜。
      let baseline = null;
      try {
        const latest = await fetchLatestPipelineForRef({ url: GITLAB_URL, token: GITLAB_TOKEN, projectId: t.mr.project_id, ref: t.mr.target_branch || 'main' });
        // 基线口径（CR 🟡#2）：只有 success/failed 是"已完结的可判状态"——
        // running/pending 还没出结果、canceled/skipped 是人主动停的，都不当绿（否则继承红会被
        // 列进引入清单，修复会话按单去修基线存量——正是 RS 承诺不做的"污染 MR"）。
        if (latest && latest.status === 'failed') {
          const bf = await fetchPipelineFailures({ url: GITLAB_URL, token: GITLAB_TOKEN, projectId: t.mr.project_id, pipelineId: latest.id });
          baseline = { status: latest.status, pipelineId: latest.id, failures: bf.failures };
        } else if (latest && latest.status === 'success') {
          baseline = { status: latest.status, pipelineId: latest.id, failures: [] }; // 基线绿 → 全部按引入
        }
        // 其余状态（running/canceled/skipped/取不到）→ baseline 保持 null → unknown，明说不猜
      } catch (e) {
        console.error(`[task-loop] ${t.id} 基线流水拉取失败（按无法取基线处理）：${e?.message || e}`);
      }
      const rounds = carryRounds.get(String(t.id)) ?? 1; // 跨流水累计轮次（sweep 携带）；首轮=1
      ciAttr = attributeCi({ mine: ciFetch.failures, baseline });
      // CR 🔴#1：提取为空有两种成因（trace 拉不到 / 日志形态不被识别——Gradle 实测零识别），
      // 都不是"全部继承"。failedJobs>0 而 failures 空 = **无法归因**：job 本身就是活，落
      // job 级工单让人先打开链接定位——CI 红静默过夜（判"不修"）正是本变更要消灭的痛点。
      // CR 二审 🔴#1′：视野不完整（trace 拉取失败 / 失败 job 被 maxJobs 截断 / jobs 翻页截断）时，
      // "可见部分恰好全为基线同款"不等于"全部继承"——没看见的 job 里可能有引入项。
      // 与"提取完全为空"同走 opaque：宁可让人多看一眼 job，不让 CI 红静默过夜。
      const viewIncomplete = ((ciFetch.traceFailures ?? 0) > 0)
        || ((ciFetch.failedJobTotal ?? 0) > (ciFetch.failedJobs?.length ?? 0))
        || !!ciFetch.jobsPageTruncated;
      const opaque = (ciFetch.failedJobs?.length > 0)
        && (ciFetch.failures.length === 0 || (ciAttr.introduced.length === 0 && viewIncomplete));
      if (opaque) {
        recordEvent('task-loop', 'ci_opaque', { kind: t.kind, id: t.id, pipelineId: t.ci.pipelineId, failedJobs: ciFetch.failedJobs.length, traceFailures: ciFetch.traceFailures ?? 0 });
        ciAttr = { ...ciAttr, introduced: ciFetch.failedJobs.map((j) => ({ id: `job:${j.name}`, fingerprint: `job:${j.name}`, kind: 'job', suite: j.stage || 'job', body: `${j.webUrl || ''}` })), inherited: [] };
      }
      // 截断透明（CR 🟡#3）：没看全的失败 job 要说，不静默缩视角
      if ((ciFetch.failedJobTotal ?? 0) > (ciFetch.failedJobs?.length ?? 0) || ciFetch.jobsPageTruncated || (ciFetch.traceFailures ?? 0) > 0) {
        console.log(`[task-loop] ${t.id} 归因视角不完整：失败 job ${ciFetch.failedJobs.length}/${ciFetch.failedJobTotal}${ciFetch.jobsPageTruncated ? '（jobs 列表翻页截断）' : ''}${ciFetch.traceFailures ? `，trace 拉取失败 ${ciFetch.traceFailures} 个` : ''}——以 job 链接为准`);
      }
      ciInfo = { pipelineId: t.ci.pipelineId, pipelineUrl: t.ci.webUrl, projectId: t.mr.project_id, sha: t.mr.sha, rounds, baselineStatus: ciAttr.baselineStatus, baselinePipelineId: ciAttr.baselinePipelineId ?? null, introducedCount: ciAttr.introduced.length, inheritedCount: ciAttr.inherited.length, opaque, failedJobTotal: ciFetch.failedJobTotal ?? ciFetch.failedJobs?.length ?? 0, traceFailures: ciFetch.traceFailures ?? 0 };
      // 轮次上限（maxRounds 跨流水累计）：修一轮推一轮还红=可能越修越坏（实测 round1 13→round2 16）。
      // 超限不再出工单——升级给人，防"每 30 分钟推一个更坏的 commit"无限循环。
      if (rounds > (rules.runtime?.budget?.maxRounds ?? 3)) {
        stats.escalated = (stats.escalated || 0) + 1;
        recordEvent('task-loop', 'ci_escalated', { kind: t.kind, id: t.id, pipelineId: t.ci.pipelineId, rounds, introduced: ciAttr.introduced.length });
        mkdirSync(join(root, '.ai', 'task-loop'), { recursive: true });
        rmSync(join(root, '.ai', 'task-loop', `pack-${t.id}.md`), { force: true }); // 旧工单是过期指令（不再让人照着修）
        const pendingForHuman = ciAttr.introduced.map((f) => ({ source: 'ci', kind: f.kind, fingerprint: f.fingerprint, body: `[${f.suite}] ${f.body || f.fingerprint}` }));
        writeFileSync(join(root, '.ai', 'task-loop', `ack-${t.id}.json`), JSON.stringify({ trigger: `${t.kind}-${t.id}`, pending: pendingForHuman, state: 'needs_human', ...(fingerprint ? { fingerprint } : {}), ci: ciInfo, budget: budget.snapshot() }, null, 2));
        budget.spendRound(); budget.pause();
        held.delete(`${t.kind}-${t.id}`); // 有意持有（等人工），不计入异常释放清单
        console.log(`[task-loop] ${t.kind}-${t.id} 已修 ${rounds - 1} 轮仍红（第 ${rounds} 次归因）——停止自动修复升级给人：ack state=needs_human，无新工单；人工处置后推新流水或关 MR 即自动关账`);
        continue;
      }
      // opaque 落全量日志尾巴：执行器没有 GitLab 凭据，runner 代拉代存（会话读文件不读凭据）
      if (opaque) {
        const traceDir = join(root, '.ai', 'task-loop', 'traces', String(t.id));
        mkdirSync(traceDir, { recursive: true });
        for (const b of ciFetch.byJob || []) {
          const safe = String(b.job || 'job').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
          writeFileSync(join(traceDir, `${safe}.log`), `# ${b.webUrl || b.job}\n${b.tail || ''}\n`);
        }
      }
      ack = ciAttr.introduced.map((f) => ({ source: 'ci', kind: f.kind, fingerprint: f.fingerprint, body: `[${f.suite}] ${f.body || f.fingerprint}` }));
      recordEvent('task-loop', 'ci_attributed', { kind: t.kind, id: t.id, pipelineId: t.ci.pipelineId, introduced: ciAttr.introduced.length, inherited: ciAttr.inherited.length, baseline: ciAttr.baselineStatus, opaque });
    } else {
      const fromDiscussions = t.unresolved.flatMap((d) => d.notes.filter((n) => n.resolvable && !n.resolved).map((n) => ({ source: 'discussion', id: d.id, note: n.id, body: (n.body || '').slice(0, 120) })));
      const fromComments = (t.comments || []).map((c) => ({ source: 'comment', id: c.id, note: c.note, body: (c.body || '').slice(0, 120), author: c.author }));
      ack = [...fromDiscussions, ...fromComments];
    }
    // 空清单终态：打回但 0 条待修（意见全 resolved、动词是唯一证据）≠ 有活干；CI 全为基线同款同理（inherited_only）。
    // 认领保留（防下轮重复触发空转），但 state 落账：fingerprint 变（新评论/新流水）→ sweep 重置重认领；触发消失 → sweep 关账。
    const noop = t.kind === 'mr' && ack.length === 0;
    mkdirSync(join(root, '.ai', 'task-loop'), { recursive: true });
    writeFileSync(join(root, '.ai', 'task-loop', `ack-${t.id}.json`), JSON.stringify({ trigger: `${t.kind}-${t.id}`, pending: ack, state: noop ? (ciInfo ? 'inherited_only' : 'awaiting_rereview') : 'working', ...(fingerprint ? { fingerprint } : {}), ...(ciInfo ? { ci: ciInfo } : {}), budget: budget.snapshot() }, null, 2));
    budget.spendRound();
    budget.pause();
    // 会话包落盘（2026-11-16）：认领即出工单——交互会话接手 = 读 pack-<id>.md 开工，不必翻 ack JSON。
    // headless 自动执行仍留 T5（影子周准入）；这里先把"等人来发现"变成"等读一份现成工单"。
    if (!noop) {
      try {
        const { buildR1ProfileA, buildR1ProfileB, buildR1ProfileCI } = await import('./lib/session-pack.mjs');
        let pack;
        if (t.signal === 'ci_pipeline') {
          // CI 工单：引入清单 + 基线同款 + 失败 job 链接 + 日志摘录（定位锚）
          const excerpts = (ciFetch?.byJob || []).flatMap((b) => b.excerpt || []).slice(0, 20);
          const viewNote = {
            failedJobs: ciFetch?.failedJobs?.length ?? 0,
            failedJobTotal: ciFetch?.failedJobTotal ?? 0,
            jobsPageTruncated: !!ciFetch?.jobsPageTruncated,
            traceFailures: ciFetch?.traceFailures ?? 0,
          };
          pack = buildR1ProfileCI({ mr: t.mr, introduced: ciAttr.introduced, inherited: ciAttr.inherited, baselineStatus: ciAttr.baselineStatus, failedJobs: ciFetch?.failedJobs || [], excerpts, opaque: !!ciInfo?.opaque, viewNote });
        } else if (t.kind === 'mr') {
          const commentsForPack = [
            ...t.unresolved.flatMap((d) => d.notes.filter((n) => n.resolvable && !n.resolved).map((n) => ({ discussion_id: d.id, note_id: n.id, author: n.author?.username || '?', body: n.body }))),
            ...(t.comments || []).map((x) => ({ discussion_id: x.id, note_id: x.note, author: x.author, body: x.body })),
          ];
          pack = buildR1ProfileA({ mr: t.mr, comments: commentsForPack, changedFiles: [], headless });
        } else {
          pack = buildR1ProfileB({ bug: t.bug || { work_item_id: t.id, name: `（MQL 未取到标题，见单 ${t.id}）` }, repo: feishuCfg.repoHint || '（未配置 runtime.feishu.repoHint——按单据产品线确定目标仓库）', baseRef: 'main' });
        }
        writeFileSync(join(root, '.ai', 'task-loop', `pack-${t.id}.md`), `# 会话包 ${t.kind}-${t.id}（${new Date().toISOString()} 自动打包）\n\n`
          + '> 接手方式：交互会话读本文按 prompt 开工，产物按协议写回本目录。开工前若 .ai/tasks/ 里还没有对应档案，\n'
          + '> 先建档：飞书缺陷 `bash scripts/init-harness.sh <slug> S --type bugfix --related feishu:' + `${t.id}` + '`；MR 打回 `--type change --related <原任务> --baseline <commit>`。\n'
          + (t.kind === 'mr' && t.signal !== 'ci_pipeline' ? '> 注：变更文件清单未随轮询拉取（省 API）——工单里的"涉及文件"不可当全集，接手后先 git diff 基线自取。\n' : '')
          + '\n' + pack.prompt + '\n\n## 预期产物\n' + pack.artifacts.map((x) => `- ${x}`).join('\n') + '\n');
        stats.pack += 1;
        console.log(`[task-loop] 会话包已落盘：.ai/task-loop/pack-${t.id}.md（交互接手即读它）`);
      } catch (e) {
        console.error(`[task-loop] 会话包生成失败（不影响认领）：${e?.message || e}`);
      }
    }
    // 终态：本轮修复没做完（v1 占位），认领**继续持有**——但必须显式落账。
    // 只记 claimed 不记配对事件，孤儿引用在任何报表里都看不出来（crewAI 的 EventPairingError
    // 同一个道理：start 没有 end 就该当场报错，而不是等翻日志才发现）。
    if (noop) {
      stats.noop += 1;
      // 上一次 working 轮落过的旧工单一并清掉：内容已收敛到零待修，旧工单是过期指令（CR 二审残留）
      rmSync(join(root, '.ai', 'task-loop', `pack-${t.id}.md`), { force: true });
      recordEvent('task-loop', 'claim_noop', { kind: t.kind, id: t.id, ref: c.ref, fingerprint, budget: budget.snapshot(), ...(ciInfo ? { why: 'inherited_only' } : {}) });
      console.log(ciInfo
        ? `[task-loop] ${t.kind}-${t.id} 已认领但失败全为基线同款（${ciInfo.inheritedCount} 条，基线 ${ciInfo.baselineStatus}）——本 MR 无引入项不修；新流水或基线变化即重评`
        : `[task-loop] ${t.kind}-${t.id} 已认领但 0 条待修意见——修复已推、等 re-review；认领保留防重复触发（fingerprint 变化即重认领，触发消失即关账）`);
    } else {
      recordEvent('task-loop', 'claim_held', { kind: t.kind, id: t.id, ref: c.ref, fingerprint, budget: budget.snapshot(), ...(ciInfo ? { ci: ciInfo } : {}) });
      console.log(ciInfo
        ? `[task-loop] ${t.kind}-${t.id} 已认领：CI 失败 ${ciInfo.introducedCount} 条引入 / ${ciInfo.inheritedCount} 条基线同款（基线 ${ciInfo.baselineStatus}）——失败工单已落盘 .ai/task-loop/pack-${t.id}.md`
        : `[task-loop] ${t.kind}-${t.id} 已认领并落确认清单（${ack.length} 条待修意见，v1 占位——headless 修复在 T5 接入）`);
    }
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
finish({ code: blocked > 0 || softFail.length ? 1 : 0, stamp: !softFail.length });
