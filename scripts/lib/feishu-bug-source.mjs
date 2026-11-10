/**
 * 剖面 B 触发源（T6）—— 飞书缺陷单的 MQL 轮询与分级门槛。
 *
 * 触发判据（设计定案）：指派给我 + 状态未开始。认领后平台状态流转即天然去重
 * （流转后不再命中查询），跨机仲裁走 git CAS——本模块只管"找出该看的单"。
 *
 * 语法与字段全部来自 2026-11-10 对 taosdata_td 的实测（不是查文档抄的）：
 *
 *   1) FROM 必须两段式 `<空间>.<工作项类型>`。只写类型名会得到
 *      ErrMoqlSemanticError: semantic error ... project_name or project_key is missing in MQL。
 *   2) "指派给我"是 `current_status_operator`（当前负责人，multi-user），不是 `owner`
 *      ——`owner` 在该空间是"创建者"，用它会把别人提的单当成我的。
 *   3) 状态字段 `work_item_status` 是 _work_item_status 类型，只支持 IN / NOT IN / = / != / IS NULL，
 *      不支持 array_contains（会报 ErrMoqlOperatorNotSupported）；枚举值是英文 label：
 *      New / Processing / Releasing / Done / Canceled。中文"待处理"不存在，查它会报 attrValueLabel not found。
 *   4) 严重级是自定义字段（该空间为 field_6bff71「故障严重级别」，枚举只有 高/中/低），
 *      不是 `severity` 也不是 `priority`。字段 key 随空间不同，故由调用方注入。
 *
 * 结果解析：实测真实返回是 `{list:[{count}], session_id, data:{"1":[{moql_field_list:[{key,value_type,value}]}]}}`，
 * 与最初假设的"JSON 数组 / 管道表格"都不同。三种形态都解析，都失败显式报错（fail-closed，
 * 不把"读不懂"当"没有单子"）。
 */

/** 该空间实测的严重级字段 key；换空间用 FEISHU_SEVERITY_FIELD 覆盖。 */
export const DEFAULT_SEVERITY_FIELD = 'field_6bff71';
/** 该空间实测的"未开始"状态 label；换空间用 FEISHU_NEW_STATUS 覆盖。 */
export const DEFAULT_NEW_STATUS = 'New';

/**
 * 拼我的待处理缺陷查询。
 * projectKey 必填——空值拼出来的 MQL 会被服务端判 semantic error，那种错隔着网络根本看不出是"忘了传参数"，
 * 所以在本地就拦下。
 */
export function buildMyBugsMql({ projectKey, type = 'Defect', statuses = [DEFAULT_NEW_STATUS], severityKey = DEFAULT_SEVERITY_FIELD, limit = 20 } = {}) {
  if (!projectKey) {
    throw new Error('buildMyBugsMql 缺 projectKey：MQL 的 FROM 必须写成 `<空间>.<工作项类型>`，否则服务端报 semantic error。设 FEISHU_PROJECT_KEY（如 taosdata_td）');
  }
  if (!type) throw new Error('buildMyBugsMql 缺工作项类型名（该空间实测为 Defect；用 FEISHU_WORK_ITEM_TYPE 覆盖）');
  const inList = statuses.map((x) => `'${x}'`).join(', ');
  const statusClause = statuses.length === 1 ? `\`work_item_status\` = ${inList}` : `\`work_item_status\` IN (${inList})`;
  return [
    `SELECT \`work_item_id\`, \`name\`, \`${severityKey}\`, \`work_item_status\``,
    `FROM \`${projectKey}\`.\`${type}\``,
    `WHERE array_contains(\`current_status_operator\`, current_login_user()) AND ${statusClause}`,
    `LIMIT ${Math.min(Number(limit) || 20, 50)}`,
  ].join(' ');
}

/**
 * MQL 文本 → 单子数组。
 * 形态顺序：真实 data/1/moql_field_list → JSON 数组 → 管道表格；都失败抛错。
 */
export function parseMqlResult(text, opts = {}) {
  return parseMqlPage(text, opts).bugs;
}

/**
 * 同上，但把"这一页之外还有多少"一并带出来。
 *
 * 为什么不能只返数组：单次上限 50 条，`LIMIT n` 只是截断、不是分页。待办超过 n 张时，
 * 数组看着完全正常——只是少了人。这种"少了几张单"在报表上和"本来就没几张"长得一模一样，
 * 所以 count 必须能取到，由调用方决定是告警还是翻页。
 */
export function parseMqlPage(text, { severityKey = DEFAULT_SEVERITY_FIELD } = {}) {
  const t = String(text || '').trim();
  if (!t) throw new Error('MQL 结果为空字符串——fail-closed，不当作"没有单子"');

  if (t.startsWith('{')) {
    let j = null;
    try { j = JSON.parse(t); } catch { /* 落到后面的形态 */ }
    if (j) {
      const rows = extractMoqlRows(j);
      if (rows) {
        const count = Number(j?.list?.[0]?.count);
        return {
          bugs: rows.map((r) => fromMoqlRow(r, { severityKey })),
          count: Number.isFinite(count) ? count : null,
          sessionId: j?.session_id ?? null,
        };
      }
    }
  }
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) {
        const bugs = arr.filter((x) => x && x.work_item_id != null).map(normBug);
        return { bugs, count: bugs.length, sessionId: null };
      }
    } catch { /* 落到表格解析 */ }
  }
  // 管道表格：| work_item_id | name | ... 表头定位 + 数据行
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const header = lines.find((l) => l.startsWith('|') && /work_item_id/i.test(l));
  if (header) {
    const cols = header.split('|').map((c) => c.trim());
    const iId = cols.findIndex((c) => /work_item_id/i.test(c));
    const iName = cols.findIndex((c) => /^name$|名称/i.test(c));
    const iSev = cols.findIndex((c) => /severity|严重/i.test(c));
    const iSt = cols.findIndex((c) => /status|状态/i.test(c));
    const out = [];
    for (const l of lines) {
      if (!l.startsWith('|') || l === header || /^[\s|:-]+$/.test(l)) continue;
      const cells = l.split('|').map((c) => c.trim());
      if (iId >= 0 && cells[iId]) out.push(normBug({ work_item_id: cells[iId], name: iName >= 0 ? cells[iName] : '', severity: iSev >= 0 ? cells[iSev] : undefined, status: iSt >= 0 ? cells[iSt] : undefined }));
    }
    if (out.length) return { bugs: out, count: out.length, sessionId: null };
  }
  throw new Error(`MQL 结果无法解析（既非 data/moql_field_list、非 JSON 数组也非表格，前 80 字：${t.slice(0, 80)}）——fail-closed，不当作"没有单子"`);
}

/** 真实形态取行：{data:{"1":[{moql_field_list:[...]}]}}。取不到返回 null（交给后续形态）。 */
function extractMoqlRows(j) {
  const bucket = j?.data;
  if (!bucket || typeof bucket !== 'object') return null;
  const first = Array.isArray(bucket['1']) ? bucket['1'] : Object.values(bucket).find((v) => Array.isArray(v));
  if (!Array.isArray(first)) return null;
  return first.filter((r) => Array.isArray(r?.moql_field_list));
}

/** 一行 moql_field_list → 扁平 {key: 标量}，再映射到规范字段。 */
function fromMoqlRow(row, { severityKey }) {
  const flat = {};
  for (const f of row.moql_field_list) {
    if (!f || !f.key) continue;
    flat[f.key] = unwrapMoqlValue(f.value);
  }
  return normBug({
    work_item_id: flat.work_item_id,
    name: flat.name,
    severity: flat[severityKey],
    status: flat.work_item_status ?? flat.status,
    priority: flat.priority,
  });
}

/**
 * 值解包。实测四种 value_type：
 *   long_value: 123              → 123
 *   string_value: 'x'            → 'x'
 *   key_label_value: {key,label} → label（枚举单选，如 故障严重级别=中）
 *   key_label_value_list: [{key,label}] → 逗号拼接的 label（状态）
 * 未知类型取首个标量，取不到返回 undefined——不猜。
 *
 * 注意 label 优先于 key：状态的 key 是内部标识（"Not started"），label 才是 MQL 里能当条件用的
 * 枚举值（"New"）。取反了会出现"用 'New' 查出结果、解析回来却是 'Not started'"的自相矛盾。
 */
export function unwrapMoqlValue(raw) {
  if (raw == null) return undefined;
  if (typeof raw !== 'object') return raw;
  const inner = Object.values(raw)[0];
  if (inner == null) return undefined;
  if (Array.isArray(inner)) {
    return inner.map((x) => (x && typeof x === 'object' ? (x.label ?? x.key) : x))
      .filter((x) => x !== undefined && x !== '').join(',');
  }
  if (typeof inner === 'object') return inner.label ?? inner.key ?? unwrapMoqlValue(inner);
  return inner;
}

function normBug(b) {
  return {
    work_item_id: b.work_item_id == null ? '' : String(b.work_item_id),
    name: b.name || b.title || '',
    severity: normSeverity(b.severity),
    priority: b.priority == null ? '' : String(b.priority),
    status: b.status || '',
  };
}

/**
 * 严重级归一。三套词汇并存，都得认：
 *   P 档（priority 字段 / 英文工具的写法）：P0-P3
 *   中文轻重（故障严重级别：高/中/低）
 *   英文轻重（Blocker/Critical/Major/Minor）
 * 无命中一律 P3——但 P3 意味着"不接"，所以调用方要能看出这是"缺值"而不是"判低"。
 */
export function normSeverity(s) {
  const t = String(s || '').trim().toUpperCase();
  if (!t) return 'P3';
  if (/P0|致命|BLOCKER/.test(t)) return 'P0';
  if (/P1|严重|CRITICAL|HIGH/.test(t)) return 'P1';
  if (/P2|一般|MAJOR|MEDIUM/.test(t)) return 'P2';
  if (/P3|轻微|MINOR|LOW|TRIVIAL/.test(t)) return 'P3';
  // 中文单字轻重必须精确匹配：'高' 若用子串匹配会误吞 '高优先级' 这类复合词。
  if (t === '高') return 'P1';
  if (t === '中') return 'P2';
  if (t === '低') return 'P3';
  return 'P3';
}

/**
 * 分级门槛（订阅 T2 的 auto_pick 镜像）：P0/P1 自动、P2 confirm_first、P3 默认不接。
 * autoPick: [{ severity: ['P0','P1'], action: 'auto' }, { severity: ['P2'], action: 'confirm_first' }]
 */
export function gateBySeverity(bugs, autoPick = [{ severity: ['P0', 'P1'], action: 'auto' }, { severity: ['P2'], action: 'confirm_first' }]) {
  const auto = [];
  const confirm = [];
  const skip = [];
  for (const b of bugs) {
    // 门槛层再归一一次：调用方可能传未经 parseMqlResult 的裸对象（实测踩过）
    const sev = normSeverity(b.severity);
    const rule = autoPick.find((r) => (r.severity || []).includes(sev));
    if (!rule || rule.action === 'skip') skip.push(b);
    else if (rule.action === 'auto') auto.push(b);
    else confirm.push(b);
  }
  return { auto, confirm, skip };
}
