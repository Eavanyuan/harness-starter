#!/usr/bin/env node
/**
 * 飞书工作项接入 —— 读取、类型建议、摘要、确认后建档。
 * 需求：docs/01-requirements/RS-飞书任务接入.md
 *
 * 分两个阶段，中间隔着人的确认：
 *   读取（只读，无副作用）  把工作项里能读到的都读了，生成摘要与类型建议，落盘后结束。
 *   确认（有副作用）        人用 --confirm <类型> --by <名字> 确认后才建任务档案；
 *                          未答的待决问题写成 human_decision blocker，挡住后面的流程。
 *
 * 几条硬约束，都有执行者，不是靠自觉：
 *   · 对飞书只读：调用层只放行 READ_ONLY_TOOLS，白名单外的工具名直接报错，请求不发出。
 *   · 未确认不建档：读取阶段不碰 .ai/tasks，也不改飞书工作项。
 *   · 不冲掉人的编辑：摘要文件首行带生成标记，发现它被人改过就不覆盖（checklist §22）。
 *     人的补充材料写 NOTES.md，本模块只读不写。
 *   · 读不到就报读不到：每项内容都有明确状态，不静默过滤（checklist §36、§39）。
 *
 * 测试里所有对外依赖（飞书调用、下载、PDF 解析、文件读写、建档案）都从参数注入，
 * 不需要真实网络，也不占端口。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

export class IntakeError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
  }
}

/** 任务类型的合法取值。枚举闭合：枚举外的值显式报错，不静默当成某一种。 */
export const INTAKE_TYPES = Object.freeze(['feature', 'change', 'bugfix']);
export const TIERS = Object.freeze(['S', 'M', 'L', 'XL']);

/**
 * 本功能对飞书只读。调用层只放行这五个读取工具——这是约束的执行者：
 * 将来谁在这个模块里加了写调用，会在发出请求之前被这里拦下。
 */
export const READ_ONLY_TOOLS = Object.freeze([
  'get_workitem_brief',
  'list_workitem_field_config',
  'search_by_mql',
  'list_workitem_comments',
  'list_related_workitem',
  'get_download_url',
]);

export const GENERATED_MARK = '<!-- harness:feishu-intake v1 生成物，请勿编辑；要补充材料请写到同目录的 NOTES.md -->';
const NOTES_FILE = 'NOTES.md';
const DEFAULT_NO_CHANGE = ['无变化', '无', '否', '不涉及', '没有', 'none', 'n/a', 'na', 'no', '-'];

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const normName = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
/** 飞书把状态、类型这类值返回成 {key,name} 对象。只取人读的名字；键另存。 */
const labelOf = (v) => (v == null ? null : typeof v === 'string' ? v : (v.name ?? v.label ?? v.key ?? null));
const tail = (s, n = 320) => {
  const lines = String(s ?? '').trim().split('\n').filter(Boolean);
  return lines.slice(-6).join('\n').slice(-n);
};
const parseJson = (raw, what) => {
  if (raw != null && typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new IntakeError(`${what}的返回不是合法 JSON（前 80 字：${clip(String(raw), 80)}）`, 1);
  }
};

/** 给调用通道套上只读闸。返回包装后的 call 与实际调用过的工具名清单。 */
export function readOnlyCall(call) {
  if (typeof call !== 'function') throw new IntakeError('没有提供飞书调用通道（call）', 1);
  const seen = [];
  const wrapped = async (name, args) => {
    if (!READ_ONLY_TOOLS.includes(name)) {
      throw new IntakeError(`拒绝调用「${name}」：本功能对飞书只读，只允许 ${READ_ONLY_TOOLS.join('、')}`, 1);
    }
    seen.push(name);
    return call(name, args);
  };
  return { call: wrapped, seen };
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/**
 * 配置形状逐层校验。能解析的坏配置比不能解析的更危险——后者会报错，前者只会安静地少读几个字段。
 * 返回归一后的配置；任何一项不对就报错并列出错在哪。
 */
export function validateIntakeCfg(raw) {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bad = [];
  const isNameList = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim() !== '');
  if (typeof cfg.dir !== 'string' || !cfg.dir.trim()) bad.push('dir（存放目录，相对仓库根）');
  else if (cfg.dir.split(/[\\/]/).includes('..')) bad.push('dir（不许指向仓库外）');
  if (!cfg.fields || typeof cfg.fields !== 'object' || Array.isArray(cfg.fields) || !Object.keys(cfg.fields).length) {
    bad.push('fields（要读取的字段，按用途列出中文名）');
  } else {
    for (const [k, v] of Object.entries(cfg.fields)) if (!isNameList(v)) bad.push(`fields.${k}（要是非空的名称数组）`);
  }
  if (!isNameList(cfg.attachmentFields)) bad.push('attachmentFields（附件字段的中文名）');
  if (!cfg.typeMap || typeof cfg.typeMap !== 'object' || Array.isArray(cfg.typeMap) || !Object.keys(cfg.typeMap).length) {
    bad.push('typeMap（飞书类型名到任务类型的映射表）');
  } else {
    for (const [k, v] of Object.entries(cfg.typeMap)) {
      if (!['feature', 'bugfix', 'ask'].includes(k)) bad.push(`typeMap.${k}（只能是 feature、bugfix、ask）`);
      else if (!isNameList(v)) bad.push(`typeMap.${k}（要是非空的名称数组）`);
    }
  }
  if (cfg.minDescriptionLength != null && !(Number.isFinite(Number(cfg.minDescriptionLength)) && Number(cfg.minDescriptionLength) >= 0)) {
    bad.push('minDescriptionLength（非负数字）');
  }
  if (cfg.noChangeMarkers != null && !(Array.isArray(cfg.noChangeMarkers) && cfg.noChangeMarkers.every((x) => typeof x === 'string'))) {
    bad.push('noChangeMarkers（字符串数组）');
  }
  if (bad.length) {
    throw new IntakeError(`runtime.feishu.intake 配置不对，缺或错的键：${bad.join('、')}（对照 docs/01-requirements/RS-飞书任务接入.md 的核心需求一节）`, 1);
  }
  return {
    dir: cfg.dir,
    fields: cfg.fields,
    attachmentFields: cfg.attachmentFields,
    typeMap: cfg.typeMap,
    noChangeMarkers: Array.isArray(cfg.noChangeMarkers) && cfg.noChangeMarkers.length ? cfg.noChangeMarkers : DEFAULT_NO_CHANGE,
    minDescriptionLength: cfg.minDescriptionLength == null ? 20 : Number(cfg.minDescriptionLength),
  };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 工作项 ID 或链接 → { workItemId }。认不出就报错，不猜。 */
export function parseWorkItemRef(raw) {
  const s = String(raw ?? '').trim();
  if (/^\d{1,20}$/.test(s)) return { workItemId: s };
  if (/^https?:\/\//i.test(s)) {
    // 链接形态没有逐个实测过，所以只认三种明确的写法，都取不到就让人给数字 ID。
    const patterns = [/work_item[\/=_-](\d{4,})/i, /[?&]work_item_id=(\d{4,})/i, /\/(\d{6,})(?:[?#].*)?$/];
    for (const re of patterns) {
      const m = s.match(re);
      if (m) return { workItemId: m[1] };
    }
  }
  throw new IntakeError(`认不出工作项：${clip(s, 80) || '（空）'}。请给工作项数字 ID（例 7176122491），或含数字 ID 的工作项链接`, 64);
}

/**
 * 按字段中文名，在该工作项类型的字段表里找出 key。
 * 字段 key 是空间级的随机标识，换空间就变，所以只能运行时按名字解析。
 * 解析不到的进 missing——可能是该类型没有这个字段，也可能是配置里的名字写错，两种都报出来，由人看。
 */
export function resolveFieldKeys(fieldConfig, wanted) {
  const list = Array.isArray(fieldConfig) ? fieldConfig : [];
  const byName = new Map(list.map((f) => [normName(f?.field_name), f?.field_key]));
  const resolved = {};
  const missing = [];
  for (const [role, names] of Object.entries(wanted || {})) {
    const hit = [].concat(names).map(normName).find((n) => byName.has(n));
    if (hit) resolved[role] = byName.get(hit);
    else missing.push(`${role}（配置的名称：${[].concat(names).join(' / ')}）`);
  }
  return { resolved, missing };
}

/**
 * 从文本里提取链接。只认主机名末段是字母后缀的地址——
 * 实测复现步骤里有「2.0.3.3-http://2.0.3.3」这种版本号写法，它不是链接，不该被列成「未读取的文档」。
 * 描述里内嵌的图片单独处理（会被下载），这里跳过。
 */
const URL_RE = /https?:\/\/[^\s"'<>()[\]{}`，。；、！？）》】]+/gi;
const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};
export function extractLinks(text) {
  const out = [];
  const body = String(text ?? '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  for (const m of body.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');   // 只裁尾部的标点，不裁头部
    const host = hostOf(url);
    if (!/^[^\s.]+(\.[^\s.]+)*\.[a-z]{2,}$/i.test(host)) continue;
    const feishuHost = /(^|\.)(feishu\.cn|larksuite\.com)$/.test(host);
    const isDoc = feishuHost && /\/(docx?|wiki|sheets?|base|bitable|file|mindnote|minutes)\b/i.test(url);
    out.push({ url, kind: isDoc ? 'feishu_doc' : 'other' });
  }
  return out;
}
/** 描述等富文本里内嵌的图片地址（markdown 图片写法）。 */
export const extractEmbeddedImages = (text) =>
  [...String(text ?? '').matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);

function matchType(typeName, typeMap) {
  const n = normName(typeName);
  for (const [bucket, names] of Object.entries(typeMap || {})) {
    if (names.map(normName).includes(n)) return bucket;
  }
  return null;
}

/** 「用户行为变更说明」字段的三态：写了变更 / 没写变更 / 这个类型没有该字段（或没读到）。 */
function behaviorChangeState(field, markers) {
  if (!field || field.status === 'missing') return 'absent';
  if (field.status === 'failed') return 'unknown';
  const t = String(field.text ?? '').trim();
  if (!t) return 'no_change';
  return markers.map(normName).includes(normName(t)) ? 'no_change' : 'changed';
}

/**
 * 规则版类型建议。每条建议必须带依据；规则判断不了就明说，不给一个没依据的类型。
 * 产出的问题已是 human_decision blocker 的形状（五字段齐），建档时原样写进档案，
 * 用现成的 resume 回答——不另造一套回答机制。
 */
export function classify(item, cfg) {
  const evidence = [];
  let suggested = null;
  let confidence = 'low';
  const field = (role) => (item.fields || []).find((f) => f.role === role);
  const typeName = String(item.type?.name ?? '');

  // 1) 飞书类型名 → 任务类型（配置表）
  const bucket = matchType(typeName, cfg.typeMap);
  if (bucket === 'feature' || bucket === 'bugfix') {
    suggested = bucket;
    confidence = 'high';
    evidence.push(`飞书工作项类型「${typeName}」按配置表对应 ${suggested}`);
  } else {
    evidence.push(`飞书工作项类型「${typeName || '未知'}」${bucket === 'ask' ? '在配置表里是「需人确认」' : '不在配置表里'}——规则给不出类型建议`);
  }

  // 2) 看得出验收条件吗：描述长度
  const desc = field('description');
  const descLen = desc && desc.status === 'read' ? String(desc.text ?? '').trim().length : 0;
  const min = Number(cfg.minDescriptionLength);
  if (descLen < min) {
    confidence = 'low';
    const why = desc && desc.status !== 'read' ? `描述字段没有读到（状态：${desc.status}）` : `描述只有 ${descLen} 字，少于 ${min}`;
    evidence.push(`${why}——看不出验收条件`);
  } else {
    evidence.push(`描述 ${descLen} 字`);
  }

  // 3) 行为变更：决定是不是 change 的唯一线索
  const bcField = field('behaviorChange');
  const bc = behaviorChangeState(bcField, cfg.noChangeMarkers);
  let bcEvidence = '';
  if (bc === 'changed') {
    bcEvidence = `「${bcField.name}」写了内容：${clip(bcField.text, 60)}`;
  } else if (bc === 'no_change') {
    bcEvidence = `「${bcField.name}」为${String(bcField.text ?? '').trim() ? `「${clip(bcField.text, 30)}」` : '空'}`;
  } else if (bc === 'unknown') {
    bcEvidence = `「${bcField.name}」没有读到，无法从字段判断是否属于行为变更`;
  } else {
    bcEvidence = '这个工作项类型没有「用户行为变更说明」字段，无法从字段判断是否属于行为变更';
  }
  evidence.push(bcEvidence);

  // 4) 读不到的材料
  const unreadDocs = (item.links || []).filter((l) => l.kind === 'feishu_doc');
  const badAttachments = (item.attachments || []).filter((a) => a.status === 'download_failed' || a.status === 'parse_failed');
  const readFailed = (item.unread || []).filter((u) => u.kind === 'read_failed');

  // ---- 组装待决问题 ----
  let n = 0;
  const questions = [];
  const blocker = (question, options, extra) => {
    n += 1;
    return {
      id: `FI-${n}`,
      type: 'human_decision',
      question,
      options: options.map((label, i) => ({ id: String(i + 1), label })),
      multi: false,
      ...extra,
    };
  };

  if (bucket === null || bucket === 'ask') {
    questions.push(blocker(
      '这个工作项应该按哪种任务类型处理？规则从飞书类型名判断不了。',
      ['feature：新功能、新能力', 'change：改已交付功能的行为', 'bugfix：修缺陷、改错误行为'],
      { evidence: [`飞书工作项类型「${typeName || '未知'}」${bcEvidence}`] },
    ));
  }
  if (descLen < min) {
    const hasNotes = item.notesLength > 0;
    questions.push(blocker(
      `验收条件不清楚：${desc && desc.status !== 'read' ? '描述字段没有读到' : `描述只有 ${descLen} 字`}。怎么处理？`,
      ['我来补充验收标准（写进 NOTES.md 后重跑）', '按现有描述和补充材料继续'],
      { recommendation: hasNotes ? '按现有描述和补充材料继续' : '我来补充验收标准（写进 NOTES.md 后重跑）',
        evidence: [`描述长度 ${descLen}，阈值 ${min}`, hasNotes ? `人已在 NOTES.md 补充 ${item.notesLength} 字` : 'NOTES.md 里没有补充材料'] },
    ));
  }
  if (bc === 'changed') {
    questions.push(blocker(
      `「用户行为变更说明」写了内容（${clip(bcField.text, 60)}）。这是对已交付功能的改动吗？`,
      ['是，按 change 处理', `不是，按 ${suggested || '我选的类型'} 处理`],
      { evidence: [bcEvidence, 'change 与 bugfix 的流程要求不同：change 必须锚定需求基线'] },
    ));
  }
  if (unreadDocs.length || badAttachments.length || readFailed.length) {
    const parts = [];
    if (unreadDocs.length) parts.push(`未读取的飞书文档链接 ${unreadDocs.length} 个`);
    if (badAttachments.length) parts.push(`下载或解析失败的附件 ${badAttachments.length} 个`);
    if (readFailed.length) parts.push(`读取失败的项 ${readFailed.length} 个`);
    questions.push(blocker(
      `有 ${parts.join('、')}。这些材料对完成任务是否关键？`,
      ['关键：我来提供内容（写进 NOTES.md 后重跑）', '不关键：跳过这些材料继续'],
      // 给保守的推荐：缺材料就动手正是这个功能要防的误判，所以默认按「关键」处理。
      { recommendation: '关键：我来提供内容（写进 NOTES.md 后重跑）', evidence: [parts.join('、'), '默认按「关键」：宁可多要一次材料，不缺着料确认'] },
    ));
  }

  return { suggested, confidence, evidence, questions, behaviorChange: bc };
}

/** 摘要。首行是生成标记——覆盖前会检查它，用来发现「这个文件被人改过」。 */
export function renderSummary({ item, classification, suggestedTier, generatedAt, targetLabel = '' }) {
  const L = [];
  const field = (role) => item.fields.find((f) => f.role === role);
  const statusLabel = { read: '已读', empty: '空', missing: '该类型没有', failed: '读取失败' };
  L.push(GENERATED_MARK);
  L.push(`# 飞书工作项接入摘要 · ${item.name || item.id}`);
  L.push('');
  L.push(`生成于 ${generatedAt}｜来源：飞书项目 \`${item.projectKey}\` 的工作项 \`${item.id}\`（类型：${item.type?.name || '?'}，状态：${item.status || '?'}）${item.sourceUrl ? ` ${item.sourceUrl}` : ''}`);
  L.push(`负责人：${item.owners.length ? item.owners.map((o) => `${o.role} ${o.members.join('、')}`).join(' ／ ') : (item.ownersState === 'unknown' ? '返回的形态不认识，没有取到' : '返回里没有角色成员，没有取到')}`);
  L.push('这是生成物，不要直接编辑；要补充材料请写到同目录的 `NOTES.md`，然后重跑一次。');
  L.push('');
  L.push('## 一、需求摘要');
  L.push('');
  const desc = field('description');
  if (desc && desc.status === 'read' && String(desc.text ?? '').trim()) {
    const t = String(desc.text).trim();
    L.push(t.length > 600 ? t.slice(0, 600) + `\n\n（以上是描述字段的前 600 字，全文 ${t.length} 字在 item.json）` : t);
  } else {
    L.push(`_描述没有读到（状态：${desc ? statusLabel[desc.status] : '未配置'}）——无法给出需求摘要。_`);
  }
  L.push('');
  if (item.notesLength) {
    const t = item.notes.trim();
    L.push(`人补充的材料（NOTES.md，${item.notesLength} 字）：`);
    L.push('');
    L.push(t.length > 600 ? t.slice(0, 600) + '\n\n（以上截取前 600 字，全文见 NOTES.md）' : t);
  } else {
    L.push('人补充的材料（NOTES.md）：无。');
  }
  L.push('');
  L.push('## 二、已读取');
  L.push('');
  L.push('| 内容 | 状态 | 说明 |');
  L.push('|---|---|---|');
  for (const f of item.fields) {
    if (f.role.startsWith('attachment_')) continue;
    L.push(`| ${f.name} | ${statusLabel[f.status] || f.status} | ${f.status === 'read' ? `${String(f.text ?? '').length} 字` : f.error || '—'} |`);
  }
  L.push(`| 评论 | ${item.commentStatus} | ${item.comments.length} 条 |`);
  L.push(`| 关联工作项 | ${item.related.length ? '已读' : (item.fieldsReadable ? (item.relatedFieldCount ? '读取失败' : '—') : '没法查')} | ${item.related.length ? item.related.map((r) => `${r.field}「${r.name}」`).join('；') : (item.fieldsReadable ? (item.relatedFieldCount ? '见下方失败原因' : '这个工作项类型没有关联类的字段') : '字段表没读到，不知道有哪些关联字段')} |`);
  if (item.attachments.length) {
    L.push('');
    L.push('附件：');
    for (const a of item.attachments) {
      const origin = { field: '附件字段', comment: '评论附件', embedded: '描述内嵌图片' }[a.origin] || a.origin;
      const st = { parsed: '已解析', downloaded: '已下载', download_failed: '下载失败', parse_failed: '未解析' }[a.status] || a.status;
      L.push(`- ${a.name}（${origin}）— ${st}${a.bytes ? `，${a.bytes} 字节` : ''}${a.contentType ? `（${a.contentType}）` : ''}${a.textLength ? `，提取 ${a.textLength} 字` : ''}${a.error ? `：${a.error}` : ''}${a.origin === 'comment' ? '（评论附件这一路没有实测过）' : ''}`);
    }
  }
  L.push('');
  L.push('## 三、没有读取到的');
  L.push('');
  const unreadDocs = item.links.filter((l) => l.kind === 'feishu_doc');
  const others = item.links.filter((l) => l.kind !== 'feishu_doc');
  if (!unreadDocs.length && !others.length && !item.unread.length) L.push('无。');
  if (unreadDocs.length) {
    L.push(`未读取的飞书文档链接 ${unreadDocs.length} 个（当前飞书项目接口没有读取文档正文的能力）：`);
    for (const l of unreadDocs) L.push(`- ${l.url}`);
  }
  if (others.length) {
    L.push(`未抓取的外部链接 ${others.length} 个：`);
    for (const l of others) L.push(`- ${l.url}`);
  }
  for (const u of item.unread) L.push(`- ${u.what}：${u.reason}`);
  L.push('');
  L.push('## 四、任务类型建议');
  L.push('');
  L.push(`建议：${classification.suggested || '无建议（规则判断不了，需要你来定）'}　把握：${classification.confidence === 'high' ? '高' : '低'}`);
  L.push('');
  L.push('依据：');
  for (const e of classification.evidence) L.push(`- ${e}`);
  const impact = field('impact');
  L.push('');
  L.push(`影响范围：${impact && impact.status === 'read' && String(impact.text ?? '').trim() ? clip(impact.text, 200) : '无法从字段判断，需要人评估'}`);
  L.push('');
  L.push(`## 五、需要你决定的事（${classification.questions.length} 项）`);
  L.push('');
  if (!classification.questions.length) L.push('无。');
  classification.questions.forEach((q, i) => {
    L.push(`${i + 1}. ${q.question}`);
    L.push(`   - 选项：${q.options.map((o) => `${o.id}. ${o.label}`).join(' ／ ')}`);
    L.push(`   - 建议：${q.recommendation || '需要你来定'}`);
    for (const e of q.evidence || []) L.push(`   - 依凭：${e}`);
  });
  L.push('');
  L.push('## 六、下一步');
  L.push('');
  L.push('确认类型并建档。确认之前不会创建任何任务，也不改飞书工作项。');
  L.push(targetLabel ? `在仓库目录 ${targetLabel} 下运行：` : '在 harness 仓库根目录下运行：');
  L.push('');
  L.push('```');
  L.push(`node scripts/harness-cli.mjs feishu ${targetLabel ? targetLabel + ' ' : ''}${item.id} --confirm <${INTAKE_TYPES.join('|')}> --by <你的名字>`);
  L.push('```');
  L.push('');
  L.push(`类型是 change 时另需 --baseline <需求基线的 commit>；档位默认取建议值 \`${suggestedTier}\`，可用 --tier S|M|L|XL 改。`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// 阶段一：读取（只读）
// ---------------------------------------------------------------------------

function defaultIo(root) {
  return {
    root,
    exists: (p) => existsSync(p),
    readText: (p) => readFileSync(p, 'utf8'),
    write: (p, data) => writeFileSync(p, data),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    download: async (url, headers) => {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      return { ok: r.ok, status: r.status, contentType: r.headers.get('content-type'), data: Buffer.from(await r.arrayBuffer()) };
    },
    extractPdf: (p) => extractPdfText(p),
  };
}

/** 用本机的 pypdf 提取 PDF 文本。解析器不在或解析失败都不算致命——附件保留原件，标「未解析」。 */
function extractPdfText(path) {
  const code = 'import pypdf,sys\nr=pypdf.PdfReader(sys.argv[1])\nsys.stdout.write("\\n".join((pg.extract_text() or "") for pg in r.pages))';
  const r = spawnSync('python3', ['-c', code, path], { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) {
    const why = String((r.stderr || '') + (r.error ? ` ${r.error.message}` : '')).trim().split('\n').filter(Boolean).pop();
    return { ok: false, error: clip(why || '解析器没有正常结束', 140) };
  }
  return { ok: true, text: r.stdout };
}

/** 值会被拼进查询语句的反引号里，先确认它不含那些字符。 */
function assertSafeIdent(v, what) {
  if (typeof v !== 'string' || !v || /[`"\\]/.test(v)) {
    throw new IntakeError(`${what}含有不能用于查询的字符：${clip(v, 40)}`, 1);
  }
  return v;
}

/**
 * 读取工作项并生成摘要。只读：不碰任务档案，不改飞书。
 * 返回 { item, classification, suggestedTier, dir, calls }；calls 是实际调用过的工具名，供核对只读约束。
 */
export async function runIntake({ ref, projectKey, cfg, call, io, root, targetLabel = '', now = () => new Date() }) {
  const gate = readOnlyCall(call);
  const c = gate.call;
  const io_ = io || defaultIo(root);
  if (!io_?.root) throw new IntakeError('没有提供仓库根目录（root）——读取结果不知道落在哪', 1);
  const { workItemId } = parseWorkItemRef(ref);
  assertSafeIdent(projectKey, 'runtime.feishu.projectKey');
  const dir = join(io_.root, cfg.dir, workItemId);
  const unread = [];
  const miss = (what, reason) => unread.push({ what, reason, kind: 'field_missing' });
  const fail = (what, reason) => unread.push({ what, reason, kind: 'read_failed' });

  // 1) 工作项概况：拿类型名与更新时间。连工作项都取不到就没有后续。
  const briefRaw = await c('get_workitem_brief', { project_key: projectKey, work_item_id: workItemId });
  let brief;
  try {
    brief = parseJson(briefRaw, 'get_workitem_brief');
  } catch (e) {
    throw new IntakeError(`取不到工作项 ${workItemId}：${e.message}`, 1);
  }
  const attr = brief?.work_item_attribute || brief || {};
  const typeName = attr.work_item_type?.name ?? (typeof attr.work_item_type === 'string' ? attr.work_item_type : null);
  if (!typeName) throw new IntakeError(`工作项 ${workItemId} 的返回里没有类型名——无法确定该查哪张字段表`, 1);
  assertSafeIdent(typeName, '工作项类型名');

  // 2) 字段表：按这个工作项类型的字段表，把配置里的中文名解析成 key
  let fieldList = [];
  let fieldsFailed = null;
  try {
    const fc = parseJson(await c('list_workitem_field_config', { project_key: projectKey, work_item_type: typeName }), 'list_workitem_field_config');
    fieldList = Array.isArray(fc?.list) ? fc.list : [];
    if (!fieldList.length) fieldsFailed = '返回的字段表是空的';
  } catch (e) {
    fieldsFailed = e.message;
  }
  if (fieldsFailed) fail('字段表', `读取失败：${fieldsFailed}`);

  const wanted = { ...cfg.fields };
  cfg.attachmentFields.forEach((name, i) => { wanted[`attachment_${i}`] = [name]; });
  const { resolved, missing } = resolveFieldKeys(fieldList, wanted);
  for (const m of missing) {
    const isAttachment = /^attachment_/.test(m);
    miss(isAttachment ? '附件字段' : `字段 ${m}`, `这个工作项类型（${typeName}）的 ${fieldList.length} 个字段里没有这个名称的字段——可能是该类型没有，也可能配置里的名称写错`);
  }
  const nameOf = (key) => fieldList.find((f) => f.field_key === key)?.field_name || key;

  // 3) 取字段值
  let mqlError = null;
  let row = null;
  if (!fieldsFailed) {
    const keys = Object.values(resolved);
    if (!keys.length) mqlError = '没有任何可取的字段';
    else {
      try {
        const mql = `SELECT \`work_item_id\`, ${keys.map((k) => `\`${k}\``).join(', ')} FROM \`${projectKey}\`.\`${typeName}\` WHERE \`work_item_id\` = "${workItemId}"`;
        const j = parseJson(await c('search_by_mql', { project_key: projectKey, mql }), 'search_by_mql');
        const rows = j?.data?.['1'];
        if (!Array.isArray(rows) || !rows.length) throw new Error('查询返回 0 行');
        row = rows[0];
      } catch (e) {
        mqlError = e.message;
      }
    }
  }
  if (mqlError) fail('描述类字段与附件字段的取值', `查询失败：${mqlError}`);
  if (fieldsFailed && !mqlError) fail('描述类字段与附件字段的取值', '字段表没读到，没法查询');

  const valueOf = (key) => {
    for (const f of row?.moql_field_list || []) {
      if (f.key !== key) continue;
      const v = f.value || {};
      const kind = Object.keys(v)[0];
      return kind ? v[kind] : null;
    }
    return undefined;
  };

  const fields = [];
  for (const role of Object.keys(cfg.fields)) {
    const names = [].concat(cfg.fields[role]).join(' / ');
    if (!(role in resolved)) {
      fields.push({ role, key: null, name: names, status: 'missing', text: '' });
      continue;
    }
    const key = resolved[role];
    const base = { role, key, name: nameOf(key) };
    if (mqlError || fieldsFailed) {
      fields.push({ ...base, status: 'failed', text: '', error: clip(mqlError || fieldsFailed, 120) });
      continue;
    }
    const v = valueOf(key);
    const text = v == null ? '' : String(v);
    fields.push(text.trim() ? { ...base, status: 'read', text } : { ...base, status: 'empty', text: '' });
  }

  // 4) 评论（评论附件走 file_url 字段）
  let comments = [];
  let commentStatus = '已读';
  try {
    const raw = parseJson(await c('list_workitem_comments', { project_key: projectKey, work_item_id: workItemId }), 'list_workitem_comments');
    // 实测形态是 {comments: [...], pagination}。两种都不是就报出来——不把「形态不认识」当成「没有评论」。
    if (Array.isArray(raw)) comments = raw;
    else if (Array.isArray(raw?.comments)) comments = raw.comments;
    else throw new Error(`返回的形态不认识（${raw && typeof raw === 'object' ? Object.keys(raw).join(',') || '空对象' : typeof raw}）`);
  } catch (e) {
    commentStatus = '读取失败';
    fail('评论', `读取失败：${e.message}`);
  }

  // 关联工作项。这个接口必须指定「哪个字段是关联字段」，所以按该类型的字段表里关联类的字段逐个查。
  // 实测：缺陷类型里关联类字段是迭代周期、引入的版本、修复的版本（不是父单或重复单）。
  const relatedFields = fieldList.filter((f) => /^workitem_related/i.test(String(f?.field_type || '')));
  const related = [];
  for (const f of relatedFields) {
    try {
      const j = parseJson(await c('list_related_workitem', { project_key: projectKey, work_item_id: workItemId, relation_field_key: f.field_key }), 'list_related_workitem');
      const list = Array.isArray(j) ? j : (Array.isArray(j?.list) ? j.list : null);
      if (!list) throw new Error(`返回的形态不认识（${j && typeof j === 'object' ? Object.keys(j).join(',') || '空对象' : typeof j}）`);
      for (const it of list) related.push({ field: f.field_name, id: String(it?.id ?? ''), name: String(it?.name ?? ''), typeKey: it?.work_item_type_key ?? null });
    } catch (e) {
      fail(`关联工作项（字段「${f.field_name}」）`, `读取失败：${e.message}`);
    }
  }

  // 5) 附件：字段附件、评论附件、描述里内嵌的图片，三种来源走同一下载流程
  const sources = [];
  for (const [role, key] of Object.entries(resolved)) {
    if (!role.startsWith('attachment_')) continue;
    const v = valueOf(key);
    // 实测：附件字段的值本身就是数组 [{key: 下载地址, label: 文件名}]，不是再包一层。
    // 兼容包一层的写法；两种都不是就报出来——不把「形态不认识」当成「没有附件」。
    let items = [];
    if (Array.isArray(v)) items = v;
    else if (Array.isArray(v?.key_label_value_list)) items = v.key_label_value_list;
    else if (v != null) fail('附件字段', `返回的形态不认识（${Object.keys(v).join(',') || typeof v}）——没有当作「没有附件」，请核对接口`);
    for (const it of items) sources.push({ name: String(it?.label || '附件'), url: String(it?.key || ''), origin: 'field' });
  }
  for (const cm of comments) {
    if (cm?.file_url) sources.push({ name: `评论附件（${clip(String(cm.content ?? '').trim(), 20)}）`, url: String(cm.file_url), origin: 'comment' });
  }
  for (const f of fields) {
    if (f.status === 'read') for (const u of extractEmbeddedImages(f.text)) sources.push({ name: `${f.name}里的内嵌图片`, url: u, origin: 'embedded' });
  }

  const attachments = [];
  let seq = 0;
  for (const s of sources) {
    const a = { name: s.name, origin: s.origin, status: 'download_failed', bytes: 0 };
    if (!s.url) {
      attachments.push({ ...a, error: '没有附件地址' });
      continue;
    }
    seq += 1;
    try {
      const dl = parseJson(await c('get_download_url', { project_key: projectKey, work_item_id: workItemId, file_url: s.url }), 'get_download_url');
      if (!dl?.download_url) throw new Error(`没有返回下载地址（返回的键：${Object.keys(dl || {}).join(',') || '无'}）`);
      const got = await io_.download(dl.download_url, { 'X-Meego-File-Sign': String(dl.sign) });
      if (!got.ok) throw new Error(`下载失败：HTTP ${got.status}`);
      io_.mkdir(join(dir, 'attachments'));
      const safe = `${seq}-${s.name.replace(/[^\w.\u4e00-\u9fa5-]+/g, '_').slice(0, 60)}`;
      const path = join(dir, 'attachments', safe);
      io_.write(path, got.data);
      a.bytes = got.data.length;
      a.contentType = got.contentType ?? null;
      a.file = relative(join(io_.root, cfg.dir, workItemId), path);
      const isPdf = /\.pdf$/i.test(s.name) || /pdf/i.test(got.contentType || '');
      const isText = /^(text\/|application\/(json|xml|yaml|x-yaml))/i.test(got.contentType || '') || /\.(txt|md|csv|json|ya?ml|xml|log)$/i.test(s.name);
      if (isPdf) {
        const t = await io_.extractPdf(path);
        if (t.ok) {
          io_.write(`${path}.txt`, t.text);
          attachments.push({ ...a, status: 'parsed', textLength: t.text.length });
        } else attachments.push({ ...a, status: 'parse_failed', error: t.error });
      } else if (isText) {
        const t = got.data.toString('utf8');
        io_.write(`${path}.txt`, t);
        attachments.push({ ...a, status: 'parsed', textLength: t.length });
      } else {
        attachments.push({ ...a, status: 'downloaded', error: '未解析：不是文本或 PDF，内容不识别' });
      }
    } catch (e) {
      attachments.push({ ...a, error: clip(e.message, 160) });
    }
  }

  // 6) 链接：列出来并标注读取状态，不抓取
  const links = [];
  const seen = new Set();
  const texts = [...fields.filter((f) => f.status === 'read').map((f) => f.text), ...comments.map((cm) => String(cm?.content ?? ''))];
  for (const t of texts) {
    for (const l of extractLinks(t)) {
      if (seen.has(l.url)) continue;
      seen.add(l.url);
      links.push({ ...l, status: 'not_read', reason: l.kind === 'feishu_doc' ? '未读取：当前飞书项目接口没有读取文档正文的能力' : '未读取：不抓取外部网页' });
    }
  }

  // 7) 人补充的材料：只读，不写
  const notesPath = join(dir, NOTES_FILE);
  const notes = io_.exists(notesPath) ? io_.readText(notesPath) : '';

  // 8) 归一结构 + 规则建议
  // 负责人：形态不认识（不是数组，或有角色却取不出成员名）时报出来，不过滤成「没有取到」就算了。
  const rawRoles = attr.role_members;
  const owners = (Array.isArray(rawRoles) ? rawRoles : [])
    .map((r) => ({ role: r?.name ?? r?.key ?? '?', members: (Array.isArray(r?.members) ? r.members : []).map((m) => m?.name).filter((x) => typeof x === 'string') }))
    .filter((r) => r.members.length);
  const ownersState = !Array.isArray(rawRoles) ? (rawRoles == null ? 'absent' : 'unknown')
    : (owners.length === 0 && rawRoles.length > 0 ? 'unknown' : 'read');
  if (ownersState === 'unknown') fail('负责人', '返回的形态不认识，没有取到');

  const item = {
    id: workItemId,
    projectKey,
    type: { key: attr.work_item_type?.key ?? null, name: typeName },
    name: String(attr.work_item_name ?? '').trim(),
    status: labelOf(attr.work_item_status),
    statusKey: attr.work_item_status?.key ?? null,
    owners,
    ownersState,
    // 输入是链接时原样记下，当作可点的来源；是数字 ID 时不编造地址——链接形态没有逐一实测过。
    sourceUrl: /^https?:\/\//i.test(String(ref).trim()) ? String(ref).trim() : null,
    updatedAt: attr.update_time ?? null,
    fields,
    attachments,
    comments: comments.map((cm) => ({ id: cm?.comment_id ?? null, text: String(cm?.content ?? ''), hasFile: !!cm?.file_url })),
    commentStatus,
    related,
    relatedFieldCount: relatedFields.length,
    fieldsReadable: !fieldsFailed,
    links,
    unread,
    notes,
    notesLength: notes.trim().length,
    generatedAt: now().toISOString(),
  };
  const classification = classify(item, cfg);
  const totalText = fields.filter((f) => f.status === 'read').reduce((n, f) => n + String(f.text ?? '').length, 0);
  const suggestedTier = (classification.suggested === 'change' || totalText > 2000 || attachments.length > 3 || classification.questions.length > 2) ? 'M' : 'S';

  // 9) 落盘。摘要带生成标记：已存在的文件首行没有标记，说明人改过，不覆盖。
  const summaryPath = join(dir, 'summary.md');
  if (io_.exists(summaryPath) && !io_.readText(summaryPath).startsWith(GENERATED_MARK)) {
    throw new IntakeError(`${summaryPath} 不像生成的文件（首行没有生成标记）——为了不冲掉你的编辑，本次没有覆盖。请把你的内容移到同目录的 ${NOTES_FILE}，再删掉 summary.md 重跑`, 1);
  }
  io_.mkdir(dir);
  io_.write(summaryPath, renderSummary({ item, classification, suggestedTier, generatedAt: item.generatedAt, targetLabel }));
  io_.write(join(dir, 'item.json'), JSON.stringify({ ...item, classification, suggestedTier }, null, 2) + '\n');

  return { item, classification, suggestedTier, dir, summaryPath, calls: gate.seen };
}

// ---------------------------------------------------------------------------
// 阶段二：确认后建档（有副作用）
// ---------------------------------------------------------------------------

/**
 * 人确认类型后建任务档案。未答的待决问题写成 human_decision blocker。
 * 任一前置不满足就拒绝，且不留任何文件（校验全部在建档之前）。
 */
export async function confirmIntake({ ref, type, by, slug: slugOpt, tier: tierOpt, baseline, projectKey, cfg, call, io, root, spawn }) {
  if (!INTAKE_TYPES.includes(type)) {
    throw new IntakeError(`--confirm 只接受 ${INTAKE_TYPES.join('|')}，收到：${JSON.stringify(type)}`, 64);
  }
  const who = String(by ?? '').trim();
  if (!who) throw new IntakeError('确认必须记名：--by <你的名字>（没有记名的确认等于没有确认）', 64);
  const io_ = io || defaultIo(root);
  if (!io_?.root) throw new IntakeError('没有提供仓库根目录（root）——档案不知道建在哪', 1);
  const { workItemId } = parseWorkItemRef(ref);
  const dir = join(io_.root, cfg.dir, workItemId);

  const itemPath = join(dir, 'item.json');
  if (!io_.exists(itemPath)) {
    throw new IntakeError(`没有工作项 ${workItemId} 的读取结果。先读一次：node scripts/harness-cli.mjs feishu ${workItemId}`, 64);
  }
  let saved;
  try {
    saved = JSON.parse(io_.readText(itemPath));
  } catch (e) {
    throw new IntakeError(`${itemPath} 不是合法 JSON：${e.message}`, 1);
  }
  if (saved.id !== workItemId) throw new IntakeError(`${itemPath} 记录的是工作项 ${saved.id}，与要确认的 ${workItemId} 不一致`, 1);

  const tier = tierOpt || saved.suggestedTier;
  if (!TIERS.includes(tier)) throw new IntakeError(`档位只接受 ${TIERS.join('|')}，收到：${JSON.stringify(tierOpt)}`, 64);
  const slug = slugOpt || `feishu-${workItemId}`;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    throw new IntakeError(`任务名只允许小写字母、数字、连字符（字母或数字开头，不超过 64 位），收到：${slug}`, 64);
  }
  if (type === 'change' && !baseline) {
    throw new IntakeError('--confirm change 必须带 --baseline <需求基线的 commit>：变更要锚定它改的是哪一版已交付的需求', 64);
  }

  // 摘要是基于读取那一刻的工作项生成的。之后工作项若有更新，摘要可能已经过期，不能照着它确认。
  const gate = readOnlyCall(call);
  const brief = parseJson(await gate.call('get_workitem_brief', { project_key: projectKey, work_item_id: workItemId }), 'get_workitem_brief');
  const attr = brief?.work_item_attribute || brief || {};
  const nowUpdated = attr.update_time ?? null;
  if (saved.updatedAt && nowUpdated && String(nowUpdated) !== String(saved.updatedAt)) {
    throw new IntakeError(`工作项在读取之后有更新（读取时 ${saved.updatedAt}，现在 ${nowUpdated}）——摘要可能已过期。先重跑读取，看过新摘要再确认`, 1);
  }

  const statePath = join(io_.root, '.ai', 'tasks', slug, 'state.json');
  if (io_.exists(statePath)) {
    throw new IntakeError(`任务 ${slug} 已经存在，不覆盖已有任务。要另建一个请用 --slug <名字>`, 1);
  }

  // ---- 以上全部通过才开始有副作用 ----
  const args = ['scripts/init-harness.sh', slug, tier, '--type', type];
  if (type !== 'feature') args.push('--related', `feishu:${workItemId}`);
  if (type === 'change') args.push('--baseline', baseline);
  const run = spawn || ((cmd, a, o) => spawnSync(cmd, a, { ...o, encoding: 'utf8' }));
  const r = run('bash', args, { cwd: io_.root });
  if (r.status !== 0) {
    throw new IntakeError(`建档失败（${args.join(' ')}）：\n${tail(r.stderr || r.stdout, 400)}`, r.status || 1);
  }

  // 待决问题写成阻断；feature 建档脚本不接受来源参数，来源在这里补上
  const state = JSON.parse(io_.readText(statePath));
  state.blockers = saved.classification?.questions || [];
  // 确认要记名：名字只用来校验非空等于没记。确认人与时间落进档案。
  state.meta.confirmed_by = who;
  state.meta.confirmed_at = new Date().toISOString();
  if (type === 'feature') {
    state.meta.related_task = `feishu:${workItemId}`;
    state.meta.remote_id = { source: 'feishu', id: workItemId };
  }
  io_.write(statePath, JSON.stringify(state, null, 2) + '\n');

  // 工具写下的状态必须能过自己的门禁。用结构化输出，不刮人读的文本。
  // 退出码含义：0 过 / 1 不过 / 2 无法判 / 64 用法错。其余（崩溃、被杀）与「结构化输出解析不了」
  // 一律算「没跑成」——不能因为没有看到红项就报成通过。
  const v = run('node', ['scripts/ci-verify.mjs', '--json'], { cwd: io_.root });
  let verdict = null;
  try {
    const text = String(v.stdout || '');
    verdict = JSON.parse(text.slice(text.indexOf('{')));   // stdout 前面有一行提示文字
  } catch {
    verdict = null;
  }
  const ran = (v.status === 0 || v.status === 1) && verdict != null && Array.isArray(verdict.problems);
  // 只认真正点名这个新任务的问题。仓库里别的任务红不红不归这里管，单独报出来。
  const mine = ran && verdict ? verdict.problems.map(String).filter((p) => p.startsWith(`${slug}:`)) : [];
  return {
    slug, tier, type, workItemId, statePath, blockers: state.blockers.length,
    checkRan: ran,                       // 校验跑成了没有
    verified: ran && mine.length === 0,   // 新档案自己没有问题
    repoClean: ran && v.status === 0,     // 整个仓库校验全绿
    verifyLines: ran ? mine : [`仓库校验没有跑成（退出码 ${v.status}）：${tail(v.stderr || v.stdout, 200)}`],
    calls: gate.seen,
  };
}
