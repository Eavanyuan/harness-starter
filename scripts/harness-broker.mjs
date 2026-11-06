#!/usr/bin/env node
/**
 * harness-broker —— 通知自动化的薄事件桥（不碰任务状态，不执行 agent）。
 *
 *   GitLab webhook ──▶ 路由（review-rules）──▶ 飞书卡片（票拟找人）
 *   飞书卡片回调  ──▶ 决策回投（GitLab 文件 API 写 RS「开放问题」行，以批红人身份落账）
 *
 * 部署边界：
 *   - broker 自己不写 state.json、不跑 agent、不合 MR——一切变更走 GitLab API 的正式提交，
 *     git 仍是唯一序列化点（设计定案：中台只当秘书）。
 *   - 认证 fail-closed：设置了 GITLAB_WEBHOOK_SECRET 则 token 不匹配一律 403。
 *   - 通知 fail-open：飞书不可达记 stderr/events，不把 MR 事件打成 5xx。
 *
 * env：PORT / GITLAB_WEBHOOK_SECRET / GITLAB_URL / GITLAB_TOKEN / GITLAB_DEFAULT_BRANCH
 *      FEISHU_WEBHOOK_URL / FEISHU_NAME_MAP（{open_id:name}）/ HARNESS_RULES_ROOT（默认 cwd）
 * 用法：node scripts/harness-broker.mjs [--port 8788]   # --port 0 时打印实际端口（测试用）
 */
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { loadRules, route } from './lib/review-rules.mjs';
import { renderDecisionCard, renderMrCard, renderPipelineCard, sendCard } from './lib/notify.mjs';
import { recordEvent } from '../hooks/lib/ledger.mjs';

const opts = () => ({
  port: Number(argFlag('--port') || process.env.PORT || 8788),
  // 默认只绑回环：本地试点不对外。真要接 GitLab/飞书的回调，必须显式给 HOST=0.0.0.0，
  // 并且同时配置两个校验 token —— 绑 0.0.0.0 而不配 token 等于把回投入口挂到公网。
  host: process.env.HOST || '127.0.0.1',
  secret: process.env.GITLAB_WEBHOOK_SECRET || '',
  feishuToken: process.env.FEISHU_VERIFY_TOKEN || '',
  gitlabUrl: (process.env.GITLAB_URL || '').replace(/\/+$/, ''),
  gitlabToken: process.env.GITLAB_TOKEN || '',
  feishuWebhook: process.env.FEISHU_WEBHOOK_URL || '',
  defaultBranch: process.env.GITLAB_DEFAULT_BRANCH || 'main',
  rulesRoot: process.env.HARNESS_RULES_ROOT || process.cwd(),
  nameMap: safeJson(process.env.FEISHU_NAME_MAP, {}),
});
function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}
function safeJson(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

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
  if (!re.test(text)) throw new Error(`未在 ${v.rs_path} 找到开放问题行 ${v.blocker_id}（账实不符，拒绝盲写）`);
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

async function handle(cfg, req, res) {
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/healthz') return json(200, { ok: true });

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
    const cardEvents = rules.notify?.card_events || [];
    const roles = rules.notify?.roles || {};
    const attr = body.object_attributes || {};

    if (body.object_kind === 'merge_request' && ['open', 'reopen', 'update'].includes(attr.action)) {
      const files = await mrFiles(cfg, body.project?.id, attr.iid);
      const routed = files ? route(rules, cfg.rulesRoot, files) : null;
      const reviews = (routed?.reviews || []).map((r) => ({ ...r, role_display: roles[r.approval_role] || r.approval_role }));
      const cardP = renderMrCard({
        mr: { iid: attr.iid, title: attr.title, url: attr.url },
        author: body.user?.name || attr.author?.name, ref: attr.source_branch,
        reviews, degraded: files == null,
      });
      if (cardEvents.includes('mr_open') && cfg.feishuWebhook) {
        try { await sendCard(cfg.feishuWebhook, cardP); } catch (e) { console.error(`[broker] 飞书发送失败（fail-open）：${e.message}`); }
      }
      recordEvent('broker', 'mr_routed', { iid: attr.iid, reviews: reviews.map((r) => r.id), degraded: files == null, sent: cardEvents.includes('mr_open') && !!cfg.feishuWebhook });
      return json(200, { ok: true, reviews: reviews.map((r) => r.id) });
    }

    if (body.object_kind === 'pipeline' && attr.status === 'failed') {
      if (cardEvents.includes('pipeline_failed') && cfg.feishuWebhook) {
        try {
          await sendCard(cfg.feishuWebhook, renderPipelineCard({
            project: body.project?.name || body.project?.path, ref: attr.ref, sha: attr.sha, url: attr.commit?.url, author: body.user?.name,
          }));
        } catch (e) { console.error(`[broker] 飞书发送失败（fail-open）：${e.message}`); }
      }
      recordEvent('broker', 'pipeline_failed_notified', { project: body.project?.path, ref: attr.ref });
      return json(200, { ok: true });
    }

    recordEvent('broker', 'digest', { kind: body.object_kind, action: attr.action || attr.status || '' }); // digest_events：不推卡片只记账
    return json(200, { ok: true, digest: true });
  }

  if (req.url === '/webhook/feishu') {
    // 飞书登记回调地址时会先打一次 url_verification，要求原样回显 challenge。
    // 不回显 = 地址根本配不上，后面那些按钮永远点不出来（原实现直接 400 未知动作）。
    if (body.type === 'url_verification' && typeof body.challenge === 'string') {
      return json(200, { challenge: body.challenge });
    }
    // 回投是全系统唯一会写仓库的路径。读路径可以试点裸奔，写路径不行：
    // 未配置校验 token 时**拒绝服务**，而不是"降级为无认证"——
    // 因为 operator.open_id 是调用方给的，不验签就等于允许任何人以任意人的名义批红。
    if (!cfg.feishuToken) {
      recordEvent('broker', 'decision_rejected', { reason: 'no_verify_token' });
      return json(503, { error: '未配置 FEISHU_VERIFY_TOKEN：回投路径拒绝服务（写仓库的入口不接受匿名调用）' });
    }
    const provided = body.token || req.headers['x-feishu-request-token'];
    if (!tokenOk(provided, cfg.feishuToken)) {
      recordEvent('broker', 'decision_rejected', { reason: 'bad_token' });
      return json(403, { error: '飞书回调校验失败' });
    }
    const v = body.action?.value;
    if (!v || v.k !== 'decision') return json(400, { error: '未知卡片动作' });
    const operator = body.operator?.open_id || 'unknown';
    const operatorName = cfg.nameMap[operator] || operator;
    try {
      const note = await resolveDecision(cfg, v, operatorName);
      recordEvent('broker', 'decision_written_back', { task: v.task, blocker: v.blocker_id, choice: v.choice, by: operatorName });
      return json(200, { code: 0, toast: note });
    } catch (e) {
      // 回投失败必须显式红，不能静默"看起来批过了"
      recordEvent('broker', 'decision_writeback_failed', { task: v.task, blocker: v.blocker_id, error: String(e.message) });
      return json(422, { error: e.message });
    }
  }

  return json(404, { error: '未知路径' });
}

export function startServer(userCfg = {}) {
  const cfg = { ...opts(), ...userCfg };
  if (!cfg.secret) console.error('[broker] 未设 GITLAB_WEBHOOK_SECRET：webhook 认证关闭（仅限内网试点）');
  if (!cfg.feishuToken) console.error('[broker] 未设 FEISHU_VERIFY_TOKEN：决策回投将被拒绝（503），只发卡片不落账');
  const openToWorld = cfg.host && cfg.host !== '127.0.0.1' && cfg.host !== 'localhost';
  if (openToWorld && (!cfg.secret || !cfg.feishuToken)) {
    console.error(`[broker] HOST=${cfg.host} 表示对外监听，但两个校验 token 没配齐——任何人打进来都能触发卡片/回投`);
  }
  const server = http.createServer((req, res) => {
    handle(cfg, req, res).catch((e) => {
      console.error(`[broker] 处理失败：${e.message}`);
      try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch { /* 已应答 */ }
    });
  });
  return new Promise((resolve) => {
    server.listen(cfg.port, cfg.host, () => resolve({ server, port: server.address().port, cfg }));
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  startServer().then(({ server, port }) => {
    console.log(`PORT ${port}`); // --port 0 时测试从这里拿实际端口
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
