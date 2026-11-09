#!/usr/bin/env node
/**
 * harness-broker —— 通知自动化的薄事件桥（不碰任务状态，不执行 agent）。
 *
 *   GitLab webhook ──▶ 路由（review-rules）──▶ 飞书卡片（票拟找人）
 *   飞书卡片回调  ──▶ 决策回投（GitLab 文件 API 写 RS「开放问题」行，以批红人身份落账）
 *
 * 两段链路的方向不一样，别混：
 *   出站（推卡片）：broker → 飞书 webhook，只要出网。
 *   入站（收点半）：飞书 → broker。公网可达就用 HTTP 回调（`/webhook/feishu`）；
 *     GitLab/broker 都在内网时用**长连接**（FEISHU_MODE=ws），由 broker 主动向飞书
 *     网关建 WebSocket 把事件收下来——不需要公网 IP、不需要开放入站端口。
 *   两条入站路径共用同一个 handleFeishuEvent，回投行为不会因传输不同而分叉。
 *
 * 部署边界：
 *   - broker 自己不写 state.json、不跑 agent、不合 MR——一切变更走 GitLab API 的正式提交，
 *     git 仍是唯一序列化点（设计定案：中台只当秘书）。
 *   - 认证 fail-closed：设置了 GITLAB_WEBHOOK_SECRET 则 token 不匹配一律 403。
 *   - 通知 fail-open：飞书不可达记 stderr/events，不把 MR 事件打成 5xx。
 *
 * env：PORT / GITLAB_WEBHOOK_SECRET / GITLAB_URL / GITLAB_TOKEN / GITLAB_DEFAULT_BRANCH
 *      FEISHU_WEBHOOK_URL / FEISHU_NAME_MAP（{open_id:name}）/ HARNESS_RULES_ROOT（默认 cwd）
 *      FEISHU_MODE（http|ws，缺省按有没有 app 凭据自动选）/ FEISHU_APP_ID / FEISHU_APP_SECRET
 *      FEISHU_DOMAIN（缺省 open.feishu.cn，Lark 国际版填 open.larksuite.com）
 * 用法：node scripts/harness-broker.mjs [--port 8788]   # --port 0 时打印实际端口（测试用）
 */
import http from 'node:http';
import fsMod from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRules, route, RulesError } from './lib/review-rules.mjs';
import { parseDecisionRowsFromDiff, createSeenKeys } from './lib/decision-from-git.mjs';
import { renderDecisionCard, renderMrCard, renderPipelineCard, sendCard } from './lib/notify.mjs';
import { personSub, classify, createNotifyQueue, renderDigestCard } from './lib/subscriptions.mjs';
import { startFeishuWs } from './feishu-ws.mjs';
import { recordEvent } from '../hooks/lib/ledger.mjs';

const opts = () => ({
  port: Number(argFlag('--port') || process.env.PORT || 8788),
  // 默认只绑回环：本地试点不对外。真要接 GitLab/飞书的回调，必须显式给 HOST=0.0.0.0，
  // 并且同时配置两个校验 token —— 绑 0.0.0.0 而不配 token 等于把回投入口挂到公网。
  // 走长连接（FEISHU_MODE=ws）只是免掉「飞书 → broker」这条边（飞书在公网，进不来内网），
  // **GitLab → broker 的 webhook 仍然要打得到**：GitLab 在另一台机器上时绑回环就收不到事件。
  host: process.env.HOST || '127.0.0.1',
  secret: process.env.GITLAB_WEBHOOK_SECRET || '',
  feishuToken: process.env.FEISHU_VERIFY_TOKEN || '',
  feishuMode: (process.env.FEISHU_MODE || '').toLowerCase(),
  feishuAppId: process.env.FEISHU_APP_ID || '',
  feishuAppSecret: process.env.FEISHU_APP_SECRET || '',
  feishuDomain: process.env.FEISHU_DOMAIN || 'https://open.feishu.cn',
  gitlabUrl: (process.env.GITLAB_URL || '').replace(/\/+$/, ''),
  gitlabToken: process.env.GITLAB_TOKEN || '',
  feishuWebhook: process.env.FEISHU_WEBHOOK_URL || '',
  defaultBranch: process.env.GITLAB_DEFAULT_BRANCH || 'main',
  rulesRoot: process.env.HARNESS_RULES_ROOT || process.cwd(),
  nameMap: safeJson(process.env.FEISHU_NAME_MAP, {}),
});

/** 入站模式：显式声明优先；没声明就看有没有 app 凭据——有凭据才可能建长连接，否则只能等回调。 */
const feishuModeOf = (cfg) => cfg.feishuMode || (cfg.feishuAppId && cfg.feishuAppSecret ? 'ws' : 'http');
function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}
function safeJson(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

/**
 * 永久性错误：同一份请求重投一万次也是同样结果（RS 里没有这行、动作不认识）。
 * 与之相对的是瞬时错误（GitLab 5xx、网络断），那种必须让飞书重投。
 * 两者用同一 4xx 应答的后果：一次 GitLab 抖动 = 这条批红静默消失，
 * 而飞书那边显示"已送达"，人以为批过了。
 */
class PermanentError extends Error {}

function tokenOk(provided, expect) {
  if (!expect) return true; // 未设密钥 = 不开认证（内网/试点），日志会提示
  const a = createHash('sha256').update(String(provided)).digest();
  const b = createHash('sha256').update(expect).digest();
  return timingSafeEqual(a, b);
}

async function gl(cfg, path, init = {}) {
  const res = await fetch(`${cfg.gitlabUrl}/api/v4${path}`, {
    ...init,
    headers: { 'private-token': cfg.gitlabToken, 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitLab ${path} HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/**
 * 启动时探一次 GitLab 令牌，把"能收事件但落不了账"提前喊出来。
 *
 * 真实踩到的坑：GITLAB_TOKEN 填了 OAuth access token（而不是 PAT），broker 用
 * `private-token` 头调 API 一律 401。症状极隐蔽——webhook 收得到、200 也回得去、
 * 飞书卡片照发，只有账本里一堆 decision_landed_failed，人以为"批过了"。
 * 这里只报警不退：推卡片不依赖它，但决策落账一定会全挂，必须让人现在就知道。
 */
async function probeGitlab(cfg) {
  if (!cfg.gitlabUrl || !cfg.gitlabToken) return;
  try {
    const res = await fetch(`${cfg.gitlabUrl}/api/v4/user`, {
      headers: { 'private-token': cfg.gitlabToken }, signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      console.error(`[broker] GITLAB_TOKEN 不可用（HTTP ${res.status}）：private-token 头只认 PAT，OAuth access token 不行。` +
        '推卡片不受影响，但所有决策都会记成 decision_landed_failed —— 现在换令牌还来得及。');
      return;
    }
    if (!res.ok) { console.error(`[broker] GitLab 探测异常：HTTP ${res.status}（${cfg.gitlabUrl}）`); return; }
    const u = await res.json();
    console.error(`[broker] GitLab 身份 ${u.username}（${cfg.gitlabUrl}）`);
  } catch (e) {
    console.error(`[broker] 连不上 GitLab（${cfg.gitlabUrl}）：${e.message} —— 决策落账会全部失败`);
  }
}

/** MR 变更文件。分页取全：只取首页 100 条时，改动多的 MR 会被静默少判（少判=少审）。 */
async function mrFiles(cfg, projectId, iid) {
  try {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const diffs = await gl(cfg, `/projects/${projectId}/merge_requests/${iid}/diffs?per_page=100&page=${page}`);
      out.push(...diffs.map((d) => d.new_path).filter(Boolean));
      if (diffs.length < 100) break; // 最后一页
    }
    return out;
  } catch { return null; }
}

/** 决策回投：把结论写进 RS 文档「开放问题」表里匹配 OP 行的状态列。返回提交说明。 */
async function resolveDecision(cfg, v, operatorName) {
  const enc = encodeURIComponent(v.rs_path);
  const file = await gl(cfg, `/projects/${v.project_id}/repository/files/${enc}?ref=${encodeURIComponent(v.branch)}`);
  const text = Buffer.from(file.content, 'base64').toString('utf8');
  const stamp = `${v.choice}（${operatorName} @ ${new Date().toISOString().slice(0, 16).replace('T', ' ')} 卡片批红）`;
  // blocker_id 来自卡片 value（即调用方输入），直接拼进正则会被元字符改变语义
  const esc = String(v.blocker_id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\|\\s*${esc}\\b[^\\n]*)$`, 'm');
  if (!re.test(text)) throw new PermanentError(`未在 ${v.rs_path} 找到开放问题行 ${v.blocker_id}（账实不符，拒绝盲写）`);
  const updated = text.replace(re, (row) => row.replace(/\|[^|]*\|?$/, `| 已裁决：${stamp} |`));
  await gl(cfg, `/projects/${v.project_id}/repository/files/${enc}`, {
    method: 'PUT',
    body: JSON.stringify({
      branch: v.branch, content: updated, encoding: 'text',
      commit_message: `harness: 决策回投 ${v.task}/${v.blocker_id} = ${v.choice}（by ${operatorName}）`,
    }),
  });
  return `已回投 ${v.rs_path}#${v.blocker_id} → ${v.choice}`;
}

/**
 * 飞书入站事件的唯一处理入口 —— HTTP 回调与长连接共用，避免两条路径的回投行为分叉。
 *
 * 鉴权分两种载体，强度对等、都不是"省略鉴权"：
 *   - http：body.token / x-feishu-request-token 对比 FEISHU_VERIFY_TOKEN。回调地址是
 *     匿名可达的，只能靠 token 认人；没配 token 直接 503，不降级成无认证。
 *   - ws：连接是用 AppID/AppSecret 换来的、只有飞书网关能往上推帧，通道本身就是凭据。
 *     这里再要求 verify token 只会把人挡在门外（长连接场景下飞书不发这个字段）。
 * 两条路都记 via 字段，账本上能分清一单是从哪条链路落下来的。
 */
async function handleFeishuEvent(cfg, body, { transport, token } = {}) {
  const json = (status, payload) => ({ status, body: payload });

  // 飞书登记回调地址时会先打一次 url_verification，要求原样回显 challenge。
  // 不回显 = 地址根本配不上，后面那些按钮永远点不出来（原实现直接 400 未知动作）。
  // 长连接没有"登记地址"这一步，所以这个分支只对 http 有意义。
  if (body.type === 'url_verification' && typeof body.challenge === 'string') {
    return json(200, { challenge: body.challenge });
  }

  if (transport === 'http') {
    if (!cfg.feishuToken) {
      recordEvent('broker', 'decision_rejected', { reason: 'no_verify_token' });
      return json(503, { error: '未配置 FEISHU_VERIFY_TOKEN：回投路径拒绝服务（写仓库的入口不接受匿名调用）' });
    }
    if (!tokenOk(token, cfg.feishuToken)) {
      recordEvent('broker', 'decision_rejected', { reason: 'bad_token' });
      return json(403, { error: '飞书回调校验失败' });
    }
  }

  const v = body.action?.value;
  if (!v || v.k !== 'decision') return json(400, { error: '未知卡片动作' });
  const operator = body.operator?.open_id || 'unknown';
  const operatorName = cfg.nameMap[operator] || operator;
  try {
    const note = await resolveDecision(cfg, v, operatorName);
    recordEvent('broker', 'decision_written_back', { task: v.task, blocker: v.blocker_id, choice: v.choice, by: operatorName, via: transport });
    return json(200, { code: 0, toast: note });
  } catch (e) {
    // 回投失败必须显式红，不能静默"看起来批过了"。
    // 更要紧的是分清能不能靠重投救：账实不符重投无用（422），GitLab 抖动值得重试（502）。
    // 飞书只看非 2xx / 长连接应答 code≠200 决定重投，所以状态码本身就是"要不要再来一次"的开关。
    const permanent = e instanceof PermanentError;
    recordEvent('broker', 'decision_writeback_failed', {
      task: v.task, blocker: v.blocker_id, error: String(e.message), via: transport, retryable: !permanent,
    });
    return json(permanent ? 422 : 502, { error: e.message });
  }
}

/** 幂等键：同一个 commit 里的同一个 OP 只落一次账（force push / 分支更新会重放 push）。 */
const seenGitDecisions = createSeenKeys();

/**
 * 方案 D：从 push 事件里读「人在 GitLab 上做的批红」。
 *
 * 为什么需要它：飞书按钮回传要求「飞书 → broker」这条边存在，而内网里这条边最贵
 * （长连接要能出站且代理放行 WS，反代要域名+证书+验签）。把决策动作挪到 GitLab 上，
 * 只用「GitLab → broker」这条内网天然可达的边，飞书侧连回调都不用配。
 *
 * 只认三件事，多一个都算误判：
 *   - 默认分支（feature 分支上的改动还没生效，不能当结论）
 *   - markdown 文件（RS 文档）
 *   - 状态列被改成「已裁决：X」的**新增行**（`+` 行；`-` 行是作废的旧值）
 *
 * 这里 broker **不写仓库**——commit 本身就是账。所以这个函数没有"失败重试"的概念，
 * 读不到 diff 就记一条 failed 走人，不会造成账实不符。
 */
/**
 * 订阅三档投递（T2）：对"卡片级事件"按订阅分类——card 即推、digest 入 aging 队列、ledger 只入账。
 * 观测 fail-open：发送失败不抛（记 stderr），降档/升级决策全部落 subscription_matched 事件。
 */
async function deliver(cfg, evt) {
  const sub = personSub(cfg.rulesCache, cfg.subscriberKey || 'default');
  const d = classify(evt, sub);
  recordEvent('broker', 'subscription_matched', { type: evt.type, tier: d.tier, reason: d.reason, audience: cfg.subscriberKey || 'default' });
  if (d.tier === 'ledger' || !cfg.feishuWebhook) return d;
  if (d.tier === 'card') {
    try { await sendCard(cfg.feishuWebhook, evt.payload); } catch (e) { console.error(`[broker] 卡片发送失败（fail-open）：${e.message}`); }
    return d;
  }
  // digest：降档入队；到 escalateAt 仍未处理由 aging 巡检升回 card（延迟不吞）
  cfg.notifyQueue?.add(evt, { tier: 'digest', escalateAfterMs: d.escalateAfterMs });
  return d;
}

async function handleGitDecisions(cfg, body, rules) {
  const gd = (rules.notify && rules.notify.git_decision) || {};
  if (gd.enabled === false) return { landed: [], skipped: 'disabled' };
  const commits = Array.isArray(body.commits) ? body.commits.slice(0, 10) : [];
  const allow = Array.isArray(gd.approvers)
    ? gd.approvers.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
    : [];
  const landed = [];
  const picked = new Map(); // blocker -> 本次 push 里"真正生效"的那次改动（跨 commit 去重）

  for (const c of commits) {
    const sha = c.id || c.sha || '';
    const touched = [...(c.added || []), ...(c.modified || [])].filter((p) => /\.md$/i.test(p));
    if (!sha || !touched.length) continue;
    let diffs;
    try {
      diffs = await gl(cfg, `/projects/${body.project.id}/repository/commits/${sha}/diff?per_page=100`);
    } catch (e) {
      // 读不到 diff ≠ 这次没有决策。必须显式记，否则"批过了但没落账"永远查不出来。
      recordEvent('broker', 'decision_landed_failed', { commit: sha.slice(0, 8), error: String(e.message) });
      continue;
    }
    // 身份取 commit author（Git 服务器记的），不是请求体里声明的 user——
    // 这是这条路比飞书回投更可靠的地方：客户端伪造不了 author。
    const by = {
      name: (c.author && c.author.name) || body.user_name || '',
      email: String((c.author && c.author.email) || body.user_email || '').toLowerCase(),
    };
    // approvers 为空 = 不设名单，依赖 GitLab 分支保护（能 push 到默认分支的人本就有权）。
    // 配了名单就是 fail-closed：名单外的人改了也只记 rejected，不落账。
    const allowed = allow.length === 0 || allow.includes(by.email);
    for (const d of diffs) {
      for (const row of parseDecisionRowsFromDiff(d.diff)) {
        // 一次 push 里同一个 OP 可能被投多次：MR 合并时 push 既有原提交、又有合并提交，
        // 而合并提交的 diff 相对第一父就是整条分支的净变更，会把原提交的结论再投影一遍。
        // 全收的后果是"一次批红落两条账，还记成两个人批的"（实测见 L2）。
        // 只在前者基础上更新，规则：
        //   - 同结论的后一次出现 = 同一批变更的重复投影 → 忽略（保留真正动手那个人的身份）
        //   - 不同结论 = 同一 push 内改判 → 后者覆盖前者（最终状态才是账该记的）
        const prev = picked.get(row.blocker_id);
        if (!prev || prev.row.choice !== row.choice) {
          picked.set(row.blocker_id, { row, sha, file: d.new_path, by, allowed });
        }
      }
    }
  }

  for (const [blocker, v] of picked) {
    const key = `${v.sha}:${blocker}`;
    if (seenGitDecisions.has(key)) continue;
    seenGitDecisions.add(key);
    if (!v.allowed) {
      recordEvent('broker', 'decision_rejected', {
        reason: 'author_not_approver', blocker, by: v.by.name, email: v.by.email, via: 'git', commit: v.sha.slice(0, 8),
      });
      continue;
    }
    recordEvent('broker', 'decision_landed', {
      blocker, choice: v.row.choice, by: v.by.name, email: v.by.email, via: 'git', commit: v.sha.slice(0, 8), file: v.file,
    });
    landed.push({ blocker_id: blocker, choice: v.row.choice, file: v.file, commit: v.sha.slice(0, 8) });
  }
  return { landed };
}

async function handle(cfg, req, res) {
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  // 健康检查要能回答"入站还通不通"，不只是"进程还在不在"。
  // 长连接放弃重连时进程照样活着、这里照样能 200——只报 ok 等于把故障藏起来。
  if (req.method === 'GET' && req.url === '/healthz') {
    const rt = cfg.runtime || {};
    const wsStats = rt.feishuWs && rt.feishuWs.stats;
    return json(200, {
      ok: true,
      // 绑定面写进 healthz：判断"是不是只有本机能连"不用再去翻启动日志。
      bind: rt.bind || null,
      feishu: wsStats
        ? { mode: 'ws', connected: !!wsStats.connected, connections: wsStats.connections, events: wsStats.events, duplicates: wsStats.duplicates, failures: wsStats.failures, lastError: wsStats.lastError }
        : { mode: rt.mode || 'http', connected: null },
    });
  }

  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
    if (Buffer.concat(chunks).length > 2 * 1024 * 1024) return json(413, { error: 'body 过大' });
  }
  const body = safeJson(Buffer.concat(chunks).toString('utf8') || '{}', {});
  if (!body || typeof body !== 'object') return json(400, { error: 'body 不是 JSON' });

  if (req.url === '/webhook/gitlab') {
    if (!tokenOk(req.headers['x-gitlab-token'], cfg.secret)) return json(403, { error: 'webhook token 不匹配' });
    const rules = loadRules(cfg.rulesRoot); // 缺/坏 → 抛给外层 500：路由没有规则 = fail-closed
    cfg.rulesCache = rules; // deliver() 按当前规则分类（订阅改了即生效，无需重启）
    const cardEvents = rules.notify?.card_events || [];
    const roles = rules.notify?.roles || {};
    const attr = body.object_attributes || {};

    // 方案 D：人直接在 GitLab 上改 RS 做决策 → 只走「GitLab → broker」这条内网边，
    // 飞书只负责找人、不承担回传。放在 MR 分支之前：同一批变更常常也带 MR 更新，
    // 但决策必须按 push 的 diff 读才准（MR diff 是相对目标分支的整体差异，分不清哪次提交做的）。
    const onDefaultBranch = !body.ref || body.ref === `refs/heads/${cfg.defaultBranch}`;
    if (body.object_kind === 'push' && onDefaultBranch && Array.isArray(body.commits) && body.commits.length > 0) {
      const { landed, skipped } = await handleGitDecisions(cfg, body, rules);
      if (skipped) return json(200, { ok: true, landed: [], skipped });
      if (landed.length === 0) recordEvent('broker', 'digest', { kind: 'push', action: 'no_decision' });
      return json(200, { ok: true, landed });
    }

    if (body.object_kind === 'merge_request' && ['open', 'reopen', 'update'].includes(attr.action)) {
      const files = await mrFiles(cfg, body.project?.id, attr.iid);
      // 三个入口共读 route()，口径也必须一致：router / ai-review 是 exit 2 + 一行人话。
      // 这里不接住就会落到外层 catch → HTTP 500，而 GitLab 把 5xx 当投递失败会反复重投，
      // 且这一次连 mr_routed 都不记：卡片没发、账没有，只剩对方日志里一串 500。
      // 所以接住，但**不许装没事**——卡片上写明配置坏了，账本单记一条，人看得见。
      let routed = null;
      let configError = null;
      if (files) {
        try {
          routed = route(rules, cfg.rulesRoot, files);
        } catch (e) {
          if (!(e instanceof RulesError)) throw e;
          configError = e.message;
          recordEvent('broker', 'mr_route_config_error', { iid: attr.iid, error: e.message });
        }
      }
      const reviews = (routed?.reviews || []).map((r) => ({ ...r, role_display: roles[r.approval_role] || r.approval_role }));
      const degraded = files == null || configError != null;
      const uncovered = (routed && routed.uncovered) || [];
      const cardP = renderMrCard({
        mr: { iid: attr.iid, title: attr.title, url: attr.url },
        author: body.user?.name || attr.author?.name, ref: attr.source_branch,
        reviews, degraded, uncovered: uncovered.length,
        degraded_reason: configError
          ? `harness.config.json 有问题，自动路由失败 —— 请修配置后重跑 CR：${configError}`
          : (files == null ? '' : null),
      });
      // 订阅三档（T2）：card 即推 / digest 降档入队（aging 到点升回 card）/ ledger 只入账。
      // 无订阅配置 = mode:all → card（现状行为，向后兼容）。
      await deliver(cfg, {
        type: 'mr_open', mr: attr.iid, author: body.user?.name || attr.author?.name, project: body.project?.path,
        payload: cardP,
      });
      recordEvent('broker', 'mr_routed', {
        iid: attr.iid, reviews: reviews.map((r) => r.id), degraded, config_error: configError, uncovered,
      });
      return json(200, { ok: true, reviews: reviews.map((r) => r.id), degraded, config_error: configError });
    }

    if (body.object_kind === 'pipeline' && attr.status === 'failed') {
      await deliver(cfg, {
        type: 'pipeline_failed', project: body.project?.path, ref: attr.ref, author: body.user?.name,
        payload: renderPipelineCard({
          project: body.project?.name || body.project?.path, ref: attr.ref, sha: attr.sha, url: attr.commit?.url, author: body.user?.name,
        }),
      });
      recordEvent('broker', 'pipeline_failed_notified', { project: body.project?.path, ref: attr.ref });
      return json(200, { ok: true });
    }

    recordEvent('broker', 'digest', { kind: body.object_kind, action: attr.action || attr.status || '' }); // digest_events：不推卡片只记账
    return json(200, { ok: true, digest: true });
  }

  if (req.url === '/webhook/feishu') {
    const out = await handleFeishuEvent(cfg, body, {
      transport: 'http',
      token: body.token || req.headers['x-feishu-request-token'],
    });
    return json(out.status, out.body);
  }

  return json(404, { error: '未知路径' });
}

/**
 * 把实际绑定地址翻译成"别人到底能不能打进来"。
 *
 * 这条日志存在的理由：排查"宿主 curl 得到 200、GitLab 却报 internal error"花了一整轮，
 * 差别只在 broker 绑在回环上——GitLab 在容器里，`host.docker.internal` 是宿主在 docker
 * 网桥上的地址（192.168.65.254），不是 127.0.0.1。配置没错，错在没人告诉我"它在回环上"。
 * 启动横幅说清楚一句，比事后翻三次日志便宜。
 */
function describeBind(addr) {
  if (!addr) return '未知（listen 回调里也拿不到地址）';
  const { address: host, port } = addr;
  const shown = host.includes(':') ? `[${host}]` : host;
  if (host === '127.0.0.1' || host === '::1') return `${shown}:${port}（仅本机回环）`;
  if (host === '0.0.0.0') return `${shown}:${port}（所有 IPv4 网卡）`;
  if (host === '::') return `${shown}:${port}（所有网卡，IPv6 + IPv4 双栈）`;
  return `${shown}:${port}（指定网卡）`;
}

export function startServer(userCfg = {}) {
  const cfg = { ...opts(), ...userCfg };
  const mode = feishuModeOf(cfg);
  if (mode !== 'ws' && mode !== 'http') {
    throw new Error(`FEISHU_MODE=${cfg.feishuMode} 不认识（只支持 http / ws）——不猜，直接拒`);
  }
  // fail-closed：声明走长连接却没给凭据，必须拒绝启动。悄悄退回 http 模式的后果是
  // 服务看着活着、卡片也发得出去，但按钮回调永远进不来 —— 闭环断在没人看得见的地方。
  if (mode === 'ws' && (!cfg.feishuAppId || !cfg.feishuAppSecret)) {
    throw new Error('FEISHU_MODE=ws 需要 FEISHU_APP_ID / FEISHU_APP_SECRET（长连接是用应用凭据换来的）');
  }
  if (!cfg.secret) console.error('[broker] 未设 GITLAB_WEBHOOK_SECRET：webhook 认证关闭（仅限内网试点）');
  if (mode === 'http' && !cfg.feishuToken) console.error('[broker] 未设 FEISHU_VERIFY_TOKEN：决策回投将被拒绝（503），只发卡片不落账');
  if (mode === 'ws' && !cfg.feishuToken) console.error('[broker] 长连接模式下 FEISHU_VERIFY_TOKEN 不需要：通道身份由应用凭据保证');
  const openToWorld = cfg.host && cfg.host !== '127.0.0.1' && cfg.host !== 'localhost';
  if (openToWorld && (!cfg.secret || (mode === 'http' && !cfg.feishuToken))) {
    console.error(`[broker] HOST=${cfg.host} 表示对外监听，但两个校验 token 没配齐——任何人打进来都能触发卡片/回投`);
  }
  // 运维读状态的地方：healthz 从这里拿"入站到底通不通"。
  cfg.runtime = { mode, feishuWs: null };
  // 订阅三档（T2）：aging 队列落部署侧 ledger 目录（通知域内部状态，不是任务状态）；
  // 巡检周期 env 可调（测试用 200ms 级），digest 整点摘要同理。
  cfg.notifyQueue = createNotifyQueue({
    file: join((process.env.HARNESS_LEDGER_DIR || cfg.rulesRoot), 'notify-queue.json'),
    writeFileSyncImpl: fsMod.writeFileSync,
    readFileSyncImpl: fsMod.readFileSync,
    existsSyncImpl: fsMod.existsSync,
  });
  const agingInterval = Number(process.env.AGING_INTERVAL_MS || 300_000);
  const digestInterval = Number(process.env.DIGEST_INTERVAL_MS || 3_600_000);
  const server = http.createServer((req, res) => {
    handle(cfg, req, res).catch((e) => {
      console.error(`[broker] 处理失败：${e.message}`);
      try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch { /* 已应答 */ }
    });
  });
  return new Promise((resolve) => {
    server.listen(cfg.port, cfg.host, () => {
      // 记的是**实际**绑定结果（server.address()），不是 env 里的愿望——
      // HOST 写成 `::`/`0.0.0.0`/主机名时，真正的监听面只有这里知道。
      cfg.runtime.bind = describeBind(server.address());
      let feishuWs = null;
      if (mode === 'ws') {
        feishuWs = startFeishuWs({
          appId: cfg.feishuAppId,
          appSecret: cfg.feishuAppSecret,
          domain: cfg.feishuDomain,
          onEvent: async (evt) => {
            const out = await handleFeishuEvent(cfg, { action: evt.action, operator: evt.operator }, { transport: 'ws' });
            // 5xx 让应答码变 500，飞书会重投（真的是我们的问题，值得重试）；
            // 4xx 是账实不符/未知动作，重投一万次也一样，改成 toast 把原因回给点按钮的人。
            if (out.status >= 500) throw new Error(out.body?.error || `处理失败 HTTP ${out.status}`);
            if (out.status !== 200) return { toast: { type: 'error', content: out.body?.error || '处理失败' } };
            return out.body;
          },
        });
        cfg.runtime.feishuWs = feishuWs;
      }
      probeGitlab(cfg); // 不 await：令牌问题只影响落账，不能把服务启动卡住
      // aging 巡检：到 escalateAt 仍未投递的 digest → 升回 card（延迟不吞的铁律在这里执行）。
      // 摘要整点：未升级的 digest 打包一张卡，不逐条推（防轰炸的另一面）。
      const agingTimer = setInterval(async () => {
        try {
          for (const e of cfg.notifyQueue.due()) {
            if (cfg.feishuWebhook) {
              try { await sendCard(cfg.feishuWebhook, e.evt.payload); } catch (err) { console.error(`[broker] aging 升级发送失败：${err.message}`); continue; }
            }
            cfg.notifyQueue.markSent(e.id, 'aging-card');
            recordEvent('broker', 'aging_escalated', { type: e.evt.type, id: e.id });
          }
          const pending = cfg.notifyQueue.pending();
          if (pending.length && cfg.feishuWebhook && Date.now() % digestInterval < agingInterval) {
            try { await sendCard(cfg.feishuWebhook, renderDigestCard(pending)); } catch (err) { console.error(`[broker] 摘要发送失败：${err.message}`); }
            pending.forEach((e) => cfg.notifyQueue.markSent(e.id, 'digest-hourly'));
            recordEvent('broker', 'digest_flushed', { count: pending.length });
          }
        } catch (e) { console.error(`[broker] aging 巡检异常（不中断服务）：${e.message}`); }
      }, agingInterval);
      agingTimer.unref?.();
      resolve({ server, port: server.address().port, cfg, mode, feishuWs });
    });
  });
}
// pathToFileURL(resolve(...))：argv[1] 相对路径时手拼 `file://<路径>` 永不相等 → 主模块判定
// 失败、broker 静默退出 0——文件头与 guides 写的启动命令恰是相对路径（P1-10，第五轮审查）。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  // 用 Promise.resolve 包一层：startServer 的配置校验是同步 throw，
  // 直接 startServer().catch 接不住，会被当成未捕获异常（exit 1），
  // 让人分不清"配置错"和"崩了"。
  Promise.resolve()
    .then(() => startServer())
    .then(({ server, port, cfg, mode, feishuWs }) => {
      console.log(`PORT ${port}`); // --port 0 时测试从这里拿实际端口
      console.log(`FEISHU_MODE ${mode}`); // 测试与运维都靠这行确认"入站到底怎么接的"
      console.log(`[broker] 监听 ${cfg.runtime.bind}`);
      if (/仅本机回环/.test(cfg.runtime.bind)) {
        console.log('[broker] 只绑回环：宿主机 curl 通，但容器里的 GitLab（host.docker.internal）打不进来——接它们要 HOST=0.0.0.0');
      }
      const stop = () => {
        if (feishuWs) feishuWs.stop();
        server.close(() => process.exit(0));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((e) => {
      console.error(`[broker] 启动失败：${e.message}`);
      process.exit(64);
    });
}
