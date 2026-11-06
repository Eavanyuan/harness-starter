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
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { loadRules, route } from './lib/review-rules.mjs';
import { renderDecisionCard, renderMrCard, renderPipelineCard, sendCard } from './lib/notify.mjs';
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

async function handle(cfg, req, res) {
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  // 健康检查要能回答"入站还通不通"，不只是"进程还在不在"。
  // 长连接放弃重连时进程照样活着、这里照样能 200——只报 ok 等于把故障藏起来。
  if (req.method === 'GET' && req.url === '/healthz') {
    const rt = cfg.runtime || {};
    const wsStats = rt.feishuWs && rt.feishuWs.stats;
    return json(200, {
      ok: true,
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
    const out = await handleFeishuEvent(cfg, body, {
      transport: 'http',
      token: body.token || req.headers['x-feishu-request-token'],
    });
    return json(out.status, out.body);
  }

  return json(404, { error: '未知路径' });
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
  const server = http.createServer((req, res) => {
    handle(cfg, req, res).catch((e) => {
      console.error(`[broker] 处理失败：${e.message}`);
      try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch { /* 已应答 */ }
    });
  });
  return new Promise((resolve) => {
    server.listen(cfg.port, cfg.host, () => {
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
      resolve({ server, port: server.address().port, cfg, mode, feishuWs });
    });
  });
}
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  // 用 Promise.resolve 包一层：startServer 的配置校验是同步 throw，
  // 直接 startServer().catch 接不住，会被当成未捕获异常（exit 1），
  // 让人分不清"配置错"和"崩了"。
  Promise.resolve()
    .then(() => startServer())
    .then(({ server, port, mode, feishuWs }) => {
      console.log(`PORT ${port}`); // --port 0 时测试从这里拿实际端口
      console.log(`FEISHU_MODE ${mode}`); // 测试与运维都靠这行确认"入站到底怎么接的"
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
