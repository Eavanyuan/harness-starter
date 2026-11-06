/**
 * 通知渲染与发送 —— 票拟找人。纯渲染无 IO（可测），发送只有 sendCard 一个网络点。
 *
 * 设计边界（与 ledger 同款）：发送失败只记 stderr 不抛——通知是观测面，
 * 不能绑架审核/回投主流程（fail-open）；但卡片 value 必须自带回投所需全部上下文，
 * 点了按钮就能落账，不需要 broker 再去查任何东西。
 *
 * CLI：node scripts/lib/notify.mjs --event <event.json> [--webhook <url>]
 *   无 --webhook 时只渲染打印（dry），有则发送并记录 events.jsonl。
 */
import { readFileSync } from 'node:fs';
import { recordEvent } from '../../hooks/lib/ledger.mjs';

const md = (content) => ({ tag: 'markdown', content });
const btn = (text, value, primary = false) => ({
  tag: 'button', text: { tag: 'plain_text', content: text }, type: primary ? 'primary' : 'default', value,
});
const card = (template, title, elements) => ({
  msg_type: 'interactive',
  card: { config: { wide_screen_mode: true }, header: { template, title: { tag: 'plain_text', content: title } }, elements },
});

/** 决策卡片：每个选项一个按钮（票拟），value 携带回投全上下文（批红可落账）。 */
export function renderDecisionCard(evt) {
  if (!evt || !evt.question || !Array.isArray(evt.options) || evt.options.length === 0) {
    throw new Error('决策事件缺 question/options');
  }
  const opts = evt.options.slice(0, 4);
  return card('red', `⛔ 决策待批：${evt.task || '未命名任务'}`, [
    md(`**问题**：${evt.question}\n**批红角色**：${evt.role || '未指定'}\n${evt.context ? `\n${evt.context}\n` : ''}\n**票拟选项**（点选即以你的身份落账）：`),
    { tag: 'action', actions: opts.map((o, i) => btn(o.label || o.key, { k: 'decision', task: evt.task, rs_path: evt.rs_path, project_id: evt.project_id, branch: evt.branch, blocker_id: evt.blocker_id, choice: o.key }, i === 0)) },
    md('<font color="grey">本卡片由 harness-broker 投递；点选后结论写入任务文档「开放问题」，可追溯。</font>'),
  ]);
}

/** MR 卡片：命中的审核类型 + 批红角色 + 证据链说明。审核结论（review_blocked）复用本卡。 */
export function renderMrCard(evt) {
  const lines = (evt.reviews || []).map((r) => `- **${r.title}**（${r.id}）→ 批红：${r.role_display || r.approval_role}`);
  const counts = evt.findings ? `\n**结论**：🔴 ${evt.findings.red} ｜ 🟡 ${evt.findings.yellow} —— 🔴 未处置不可合入` : '';
  return card(evt.findings && evt.findings.red > 0 ? 'red' : 'blue', `🤖 MR !${evt.mr.iid}：${evt.mr.title}`, [
    md(`**作者**：${evt.author || '-'}　**分支**：${evt.ref || '-'}\n\n**自动审核路由**：\n${lines.join('\n') || '- （未命中 AI 审核，仅证据链机器校验）'}${counts}${evt.degraded ? '\n\n<font color="orange">⚠ GitLab diff 接口不可用，路由降级为仅证据链校验</font>' : ''}`),
    { tag: 'action', actions: [btn('去处理', { k: 'open', url: evt.mr.url })] },
    md('<font color="grey">AI 审核是票拟不是判决；🔴 处置与 approve 归批红角色。</font>'),
  ]);
}

/** 流水线失败卡片：找作者，不找全员（防通知疲劳）。 */
export function renderPipelineCard(evt) {
  return card('orange', `🔴 流水线失败：${evt.project || '-'}`, [
    md(`**分支**：${evt.ref || '-'}　**提交**：${(evt.sha || '').slice(0, 8)}\n**第一责任人**：${evt.author || '-'}${evt.url ? `\n[查看流水线](${evt.url})` : ''}`),
    md('<font color="grey">CI 红不通知全员；连续失败找值班运维（roles.sre）。</font>'),
  ]);
}

export async function sendCard(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  return true;
}

/** ---- CLI ---- */
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const a = process.argv.slice(2);
  const evIdx = a.indexOf('--event');
  const whIdx = a.indexOf('--webhook');
  if (evIdx === -1) { console.error('用法: node scripts/lib/notify.mjs --event <event.json> [--webhook <url>]'); process.exit(64); }
  const evt = JSON.parse(readFileSync(a[evIdx + 1], 'utf8'));
  const payload = evt.kind === 'decision' ? renderDecisionCard(evt)
    : evt.kind === 'pipeline' ? renderPipelineCard(evt)
    : renderMrCard(evt);
  const webhook = whIdx !== -1 ? a[whIdx + 1] : null;
  if (!webhook) {
    console.log(JSON.stringify(payload, null, 2));
    recordEvent('notify', 'card_rendered', { kind: evt.kind, task: evt.task || evt.mr?.iid || '' });
  } else {
    try {
      await sendCard(webhook, payload);
      console.log('[notify] 卡片已发送');
      recordEvent('notify', 'card_sent', { kind: evt.kind, task: evt.task || evt.mr?.iid || '' });
    } catch (e) {
      console.error(`[notify] 发送失败（不阻塞主流程）：${e.message}`);
      recordEvent('notify', 'card_send_failed', { kind: evt.kind, error: String(e.message) });
      process.exit(1);
    }
  }
}
