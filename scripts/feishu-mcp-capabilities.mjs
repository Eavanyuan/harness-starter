// 飞书项目 MCP 能力与工作项读取形态——证据采集脚本（只读）。
// 产出：docs/06-reference/feishu-mcp-capabilities.json
//
// 为什么需要它：RS-飞书任务接入.md 里有若干「实测」主张（工具数、哪些字段读得到、
// brief 传 fields 是否返回描述等）。这些结论若只存在于终端输出里，别人无法复核，
// 自己隔天也无从对证。本脚本把它们落成结构化证据，随文档入库。
//
// 不落盘的东西（有意）：
//   - 任何凭据、下载地址、下载签名（sign）
//   - 附件原件与附件解析出的正文（客户安全评估报告）
//   - 工作项描述/复现步骤的正文（只记长度与结构）
//   - 人员信息（只记角色名，不记成员）
//
// 用法：node scripts/feishu-mcp-capabilities.mjs [--work-item <id>] [--project-key <key>]
import { writeFileSync, mkdirSync } from 'node:fs';
import { ensureToken } from './lib/feishu-oauth.mjs';
import { connect } from './lib/feishu-project-mcp.mjs';

const DEFAULT_OUT = 'docs/06-reference/feishu-mcp-capabilities.json';
const ENDPOINT = 'https://project.feishu.cn/mcp_server/v1';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const outPath = arg('--out', DEFAULT_OUT);
const projectKey = arg('--project-key', 'taosdata_td');
const workItemId = arg('--work-item', '7176122491');

// 按 ID 判定类型需要知道它是 Defect 还是别的；这里固定用 Defect 做样本，写进证据里让人知道口径。
const WORK_ITEM_TYPE = 'Defect';
// 这些字段 key 是空间级的，只对当前空间有效——所以证据里同时记下字段名，换空间时按名重新解析。
const SAMPLE_FIELDS = {
  description: 'description',
  reporter_repro_steps: 'field_d3db94',
  attachment: 'field_702492',
  behavior_change_note: 'field_66a47a',
};

const REDACT = { sign: '<redacted>', download_url: '<redacted>', url: '<redacted>' };
const redact = (obj) => {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, k in REDACT ? REDACT[k] : redact(v)]));
  }
  return obj;
};

async function listTools(token) {
  let sessionId = null;
  const post = async (body) => {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) throw new Error('MCP 身份被拒（401）——token 过期，重新 login');
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    return text.trim() ? JSON.parse(text.startsWith('data:') ? text.split('data:').pop() : text) : null;
  };
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'harness-capability-probe', version: '1.0' } } });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = [];
  let cursor = null;
  let pages = 0;
  do {
    const j = await post({ jsonrpc: '2.0', id: 2 + pages, method: 'tools/list', params: cursor ? { cursor } : {} });
    if (j?.error) throw new Error(`tools/list 报错: ${JSON.stringify(j.error).slice(0, 200)}`);
    tools.push(...(j?.result?.tools || []));
    cursor = j?.result?.nextCursor;
    pages += 1;
  } while (cursor && pages < 10);
  return { tools, pages, truncated: !!cursor };
}

// 只读 = 名称以读取类动词开头。这是按命名的保守分类，用于给「哪些是写操作」一个可复核的清单。
const READ_VERB = /^(get|list|search|query|fetch|read|check|test)/i;
const WRITE_VERB = /^(add|create|update|delete|upload|transition|remove|push|set|batch|edit|publish|reset)/i;
const classify = (name) => (READ_VERB.test(name) ? 'read' : WRITE_VERB.test(name) ? 'write' : 'other');

// work_item_id 也进 SELECT：两个接口返回的 ID 类型不同（数字 vs 字符串），证据里要能对上，不能只写结论。
const mql = `SELECT \`work_item_id\`, ${Object.entries(SAMPLE_FIELDS).map(([, k]) => `\`${k}\``).join(', ')} FROM \`${projectKey}\`.\`${WORK_ITEM_TYPE}\` WHERE \`work_item_id\` = "${workItemId}"`;

const token = await ensureToken();
const { tools, pages, truncated } = await listTools(token);
const counts = { read: 0, write: 0, other: 0 };
for (const t of tools) counts[classify(t.name)] += 1;

const { call } = await connect(ENDPOINT, { token, client: 'harness-capability-probe' });

// (1) brief 默认返回里有哪些键；传 fields 后是否出现描述/附件
const briefDefault = JSON.parse(await call('get_workitem_brief', { project_key: projectKey, work_item_id: workItemId }));
const briefWithFields = JSON.parse(await call('get_workitem_brief', {
  project_key: projectKey, work_item_id: workItemId, fields: [SAMPLE_FIELDS.description, SAMPLE_FIELDS.attachment],
}));
const attrOf = (b) => b.work_item_attribute || b;

// (2) MQL 能否取到这些字段；只记长度与结构，不记正文
const mqlRaw = JSON.parse(await call('search_by_mql', { project_key: projectKey, mql }));
const mqlFields = (mqlRaw?.data?.['1']?.[0]?.moql_field_list || []).map((f) => {
  const v = f.value || {};
  const kind = Object.keys(v)[0] || 'none';
  const inner = v[kind];
  const out = { key: f.key, name: f.name, value_type: f.value_type, value_kind: kind };
  // 只对文本类字段记长度；ID 类字段记的是类型，长度没有意义。
  if (kind === 'string_value' && typeof inner === 'string') out.text_length = inner.length;
  if (kind === 'key_label_value_list' && Array.isArray(inner)) {
    // 同 attachment：不落文件名（可能透露客户/项目信息），只落条数、扩展名与是否带地址。
    out.items = inner.map((it) => ({
      extension: (String(it.label ?? '').match(/\.([A-Za-z0-9]{1,8})$/)?.[1] || '').toLowerCase() || null,
      name_length: String(it.label ?? '').length,
      has_url: typeof it.key === 'string' && it.key.length > 20,
    }));
  }
  if (f.key === 'work_item_id') out.id_value_type = typeof inner;
  return out;
});

// (3) 字段配置：该类型一共有多少字段、描述类/附件类各有哪些（key 是空间级的，记下来只为说明它不稳定）
const cfg = JSON.parse(await call('list_workitem_field_config', { project_key: projectKey, work_item_type: WORK_ITEM_TYPE }));
const cfgList = cfg.list || [];
const byType = {};
for (const f of cfgList) (byType[f.field_type] ||= []).push(f.field_name);
const randomKey = (k) => /^field_[0-9a-f]{6}$/.test(k);

// (4) 附件：能否换取下载地址并下载成功。只记元数据；不保存文件内容，不落地址与签名。
let attachment = { attempted: false };
const att = mqlFields.find((f) => f.key === SAMPLE_FIELDS.attachment);
if (att?.items?.length) {
  const fileUrl = (mqlRaw?.data?.['1']?.[0]?.moql_field_list || []).find((f) => f.key === SAMPLE_FIELDS.attachment)?.value?.key_label_value_list?.[0]?.key;
  try {
    const dl = JSON.parse(await call('get_download_url', { project_key: projectKey, work_item_id: workItemId, file_url: fileUrl }));
    const res = await fetch(dl.download_url, { headers: { 'X-Meego-File-Sign': String(dl.sign) }, signal: AbortSignal.timeout(90_000) });
    const buf = Buffer.from(await res.arrayBuffer());
    // 下载成功才覆盖 attachment；任何一步失败都保留 error，不让半截结果冒充成功。
    attachment = {
      attempted: true,
      ok: true,
      extension: att.items.map((i) => i.extension).filter(Boolean)[0] || null,
      get_download_url: { required: ['project_key', 'work_item_id', 'file_url'], returns: Object.keys(dl), is_multipart: dl.is_multipart ?? null },
      http_status: res.status, content_type: res.headers.get('content-type'), bytes: buf.length,
      magic: buf.subarray(0, 5).toString('latin1'),
    };
  } catch (e) {
    attachment = { attempted: true, ok: false, error: String(e.message).slice(0, 160) };
  }
}

const evidence = {
  captured_at: new Date().toISOString(),
  endpoint: ENDPOINT,
  scope: { project_key: projectKey, work_item_type: WORK_ITEM_TYPE, sample_work_item_id: workItemId },
  note: '只读采集。字段 key（field_xxxxxx）是空间级的，换空间需按 field_name 重新解析。不含凭据、下载地址、签名、附件内容与描述正文。',
  tools: {
    total: tools.length, pages, truncated, by_class: counts,
    classification_rule: 'read: 名称以 get/list/search/query/fetch/read/check/test 开头；write: add/create/update/delete/upload/transition/remove/push/set/batch/edit/publish/reset；其余 other。按命名分类，非官方标注。',
    names: tools.map((t) => ({ name: t.name, class: classify(t.name), required: t.inputSchema?.required || [] })),
  },
  doc_reading: {
    question: '能否读取飞书云文档/多维表格正文',
    result: '无对应工具',
    matching: tools.filter((t) => /doc|wiki|sheet|bitable|drive|file_content|read_file/i.test(t.name)).map((t) => t.name),
  },
  work_item_read: {
    get_workitem_brief: {
      default_keys: Object.keys(attrOf(briefDefault)),
      default_has_description: 'description' in attrOf(briefDefault),
      default_has_attachment: SAMPLE_FIELDS.attachment in attrOf(briefDefault),
      with_fields_param: {
        requested: [SAMPLE_FIELDS.description, SAMPLE_FIELDS.attachment],
        returned_keys: Object.keys(attrOf(briefWithFields)),
        description_returned: SAMPLE_FIELDS.description in attrOf(briefWithFields),
        attachment_returned: SAMPLE_FIELDS.attachment in attrOf(briefWithFields),
      },
      id_type: typeof attrOf(briefDefault).work_item_id,
      type_shape: attrOf(briefDefault).work_item_type && typeof attrOf(briefDefault).work_item_type === 'object' ? 'object{key,name}' : typeof attrOf(briefDefault).work_item_type,
    },
    search_by_mql: {
      rows: mqlRaw?.data?.['1']?.length ?? 0,
      fields: mqlFields,
      id_type: mqlFields.find((f) => f.key === 'work_item_id')?.id_value_type ?? null,
    },
    field_config: {
      total_fields: cfgList.length,
      by_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { count: v.length, names: v }])),
      random_key_count: cfgList.filter((f) => randomKey(f.field_key)).length,
      sample_field_keys: SAMPLE_FIELDS,
    },
  },
  attachment,
  local_pdf_parser: { pypdf: 'present on the capture machine (verified separately); not a harness dependency yet' },
};

mkdirSync(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
writeFileSync(outPath, JSON.stringify(redact(evidence), null, 2) + '\n');
console.log(`[capabilities] 已写入 ${outPath}`);
console.log(`  工具 ${evidence.tools.total} 个（只读 ${counts.read} / 写 ${counts.write} / 其它 ${counts.other}），分页 ${pages}${truncated ? '（有截断）' : ''}`);
console.log(`  brief 默认含描述: ${evidence.work_item_read.get_workitem_brief.default_has_description}；传 fields 后含描述: ${evidence.work_item_read.get_workitem_brief.with_fields_param.description_returned}`);
console.log(`  MQL 返回 ${evidence.work_item_read.search_by_mql.rows} 行、${mqlFields.length} 个字段`);
console.log(`  字段配置 ${cfgList.length} 个，其中随机 key ${evidence.work_item_read.field_config.random_key_count} 个`);
console.log(`  附件: ${attachment.attempted ? (attachment.error ? '失败 ' + attachment.error : `${attachment.http_status} ${attachment.content_type} ${attachment.bytes} 字节`) : '未尝试'}`);
