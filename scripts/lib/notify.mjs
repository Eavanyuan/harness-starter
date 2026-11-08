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
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordEvent } from '../../hooks/lib/ledger.mjs';

const md = (content) => ({ tag: 'markdown', content });
/**
 * 按钮。`url` 是飞书 1.0 卡片自身的跳转字段——点了直接开链接，**不需要任何回调**。
 * 之前「去处理」只把链接塞进 value（`{k:'open', url}`），那等于要求 broker 先收到
 * 回调再替用户跳一次：没配回调就点不动，配了也会被 `k !== 'decision'` 打回 400。
 */
const btn = (text, value, primary = false, url = '') => ({
  tag: 'button', text: { tag: 'plain_text', content: text }, type: primary ? 'primary' : 'default',
  ...(url ? { url } : {}), value,
});
const card = (template, title, elements) => ({
  msg_type: 'interactive',
  card: { config: { wide_screen_mode: true }, header: { template, title: { tag: 'plain_text', content: title } }, elements },
});

/** GitLab 文件编辑页直达链接：`<base>/-/edit/<ref>/<path>`（path 保留斜杠，不能整段 encode）。 */
export function editUrlOf(evt) {
  if (evt && evt.edit_url) return evt.edit_url;
  const base = evt && evt.edit_base;
  if (!base || !evt.rs_path) return '';
  return `${String(base).replace(/\/+$/, '')}/-/edit/${evt.branch || 'main'}/${evt.rs_path}`;
}

/**
 * 决策卡片：两种投递形态，按「有没有回调通道」选。
 *
 * - **callback 模式**（默认）：每个选项一个按钮，value 携带回投全上下文。
 *   要求「飞书 → broker」这条边存在（长连接或公网回调）。
 * - **link 模式**（给了 edit_base / edit_url）：只放一个跳转按钮，结论由人在 GitLab
 *   上改 RS 提交（harness-broker 从 push 事件读，见 `decision-from-git.mjs`）。
 *   这里**故意不做成"N 个按钮都跳同一页"**——那会让人以为点了 A 就批了 A，
 *   实际只是打开了文档，账上什么都没有。
 */
export function renderDecisionCard(evt) {
  if (!evt || !evt.question || !Array.isArray(evt.options) || evt.options.length === 0) {
    throw new Error('决策事件缺 question/options');
  }
  const opts = evt.options.slice(0, 4);
  const task = evt.task || '未命名任务';
  const editUrl = editUrlOf(evt);

  if (editUrl) {
    const keys = opts.map((o) => o.label || o.key).join(' ｜ ');
    return card('red', `⛔ 决策待批：${task}`, [
      md(`**问题**：${evt.question}\n**批红角色**：${evt.role || '未指定'}\n**可选**：${keys}\n${evt.context ? `\n${evt.context}\n` : ''}\n**怎么批**：点下面的按钮打开 RS 文档，把「开放问题」里 **${evt.blocker_id}** 那行的状态改成 \`已裁决：<你选的>\`，提交即可。`),
      { tag: 'action', actions: [btn('去 GitLab 裁决', { k: 'guide', blocker_id: evt.blocker_id }, true, editUrl)] },
      md('<font color="grey">结论从 git 提交里读（批红身份由 Git 服务器记，比按钮传的 open_id 更可信）；不需要在飞书里点选。</font>'),
    ]);
  }

  return card('red', `⛔ 决策待批：${task}`, [
    md(`**问题**：${evt.question}\n**批红角色**：${evt.role || '未指定'}\n${evt.context ? `\n${evt.context}\n` : ''}\n**票拟选项**（点选即以你的身份落账）：`),
    { tag: 'action', actions: opts.map((o, i) => btn(o.label || o.key, { k: 'decision', task: evt.task, rs_path: evt.rs_path, project_id: evt.project_id, branch: evt.branch, blocker_id: evt.blocker_id, choice: o.key }, i === 0)) },
    md('<font color="grey">本卡片由 harness-broker 投递；点选后结论写入任务文档「开放问题」，可追溯。</font>'),
  ]);
}

/** MR 卡片：命中的审核类型 + 批红角色 + 证据链说明。审核结论（review_blocked）复用本卡。 */
export function renderMrCard(evt) {
  const lines = (evt.reviews || []).map((r) => `- **${r.title}**（${r.id}）→ 批红：${r.role_display || r.approval_role}`);
  const counts = evt.findings ? `\n**结论**：🔴 ${evt.findings.red} ｜ 🟡 ${evt.findings.yellow} —— 🔴 未处置不可合入` : '';
  // 降级不能只说"降级了"，要说**为什么**：diff 接口挂了和配置写坏了，处理人完全不同。
  const why = evt.degraded
    ? `\n\n<font color="orange">⚠ ${evt.degraded_reason || 'GitLab diff 接口不可用，路由降级为仅证据链校验'}</font>`
    : '';
  return card(evt.findings && evt.findings.red > 0 ? 'red' : 'blue', `🤖 MR !${evt.mr.iid}：${evt.mr.title}`, [
    md(`**作者**：${evt.author || '-'}　**分支**：${evt.ref || '-'}\n\n**自动审核路由**：\n${lines.join('\n') || '- （未命中 AI 审核，仅证据链机器校验）'}${counts}${why}`),
    { tag: 'action', actions: [btn('去处理', { k: 'open', url: evt.mr.url }, true, evt.mr.url)] },
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
// 两处都要折算：argv[1] 可能是相对路径（文档示例就是 `node scripts/lib/notify.mjs`），
// 也可能落在软链目录里（macOS 的 /tmp → /private/tmp、/var → /private/var）。
// Node 加载模块时会把软链解成真实路径写进 import.meta.url，而 argv[1] 原样保留，
// 于是两边永远对不上 —— 主模块判定失败、CLI 静默空转退出 0，什么也不打印。
// 实测：仓库放到软链路径下时，`node <abs>/scripts/lib/notify.mjs --event x.json` 输出为空但 exit 0。
// （P1-10 第五轮只修了相对路径，这一轮补软链）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (isMain) {
  const a = process.argv.slice(2);
  const evIdx = a.indexOf('--event');
  const whIdx = a.indexOf('--webhook');
  if (evIdx === -1) { console.error('用法: node scripts/lib/notify.mjs --event <event.json> [--webhook <url>]'); process.exit(64); }
  const evt = JSON.parse(readFileSync(a[evIdx + 1], 'utf8'));
  // 投递形态：有回调通道（长连接/公网回调）就用按钮回投；纯内网走 link，让人去 GitLab 改。
  // 用 env 显式声明而不是靠"猜有没有配 FEISHU_APP_ID"——这类隐式回退在运维眼里等于随机行为。
  if ((process.env.HARNESS_DECISION_MODE || 'callback') === 'link' && !evt.edit_url && !evt.edit_base && process.env.GITLAB_URL) {
    evt.edit_base = process.env.GITLAB_URL;
  }
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
