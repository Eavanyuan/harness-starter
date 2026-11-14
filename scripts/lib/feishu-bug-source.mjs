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

/**
 * 该空间实测的严重级字段 key（内置兜底；正式来源是 harness.rules.json runtime.feishu.severity.field）。
 * 换空间改配置，不改这里——常量存在的唯一理由是"配置整个缺失时还能跑"。
 */
export const DEFAULT_SEVERITY_FIELD = 'field_6bff71';
/** 该空间实测的"未开始"状态 label（同上，兜底用）。 */
export const DEFAULT_NEW_STATUS = 'New';
/** 其余兜底值：语义稳定的部分（指派字段就是当前负责人，状态就是第一个待办态）。 */
export const DEFAULTS = {
  projectKey: '',
  workItemType: 'Defect',
  assigneeField: 'current_status_operator',
  newStatus: DEFAULT_NEW_STATUS,
  mqlLimit: 20,
  severityField: DEFAULT_SEVERITY_FIELD,
  severityMap: { 高: 'P1', 中: 'P2', 低: 'P3' },
  issuer: 'https://project.feishu.cn',
  // 迭代周期过滤（2026-11-14 TDasset 落地规则：迭代周期 label 以 IDMP 开头才算 TDasset 的 bug）。
  // 默认关（空串）：field+prefix 都配了才生效。field key 随空间变（同 severity），需数据档实测确认。
  iterationField: '',
  iterationPrefix: '',
};

/**
 * 三处来源合成一份配置：内置兜底 < harness.rules.json 的 runtime.feishu < 环境变量。
 *
 * 为什么是这个顺序：配置是"这个仓库接哪个空间"的**事实**，该随代码 review；
 * 环境变量是"这一次临时换个空间"的**动作**（CI 指向假端点、临时查别的项目），
 * 所以 env 压过配置；而内置兜底只在两者都没给时兜住——它不该赢，否则配置形同虚设。
 *
 * 空字符串按"没配"处理：`FEISHU_PROJECT_KEY= node ...` 这种写法（导出空值）很常见，
 * 若当成有效值，MQL 会拼出单段表名再吃一句 semantic error——报错点离原因隔了一层网络。
 */
export function resolveFeishuConfig({ rules = null, env = process.env } = {}) {
  const c = (rules?.runtime?.feishu && typeof rules.runtime.feishu === 'object') ? rules.runtime.feishu : {};
  const sev = (c.severity && typeof c.severity === 'object') ? c.severity : {};
  const iter = (c.iteration && typeof c.iteration === 'object') ? c.iteration : {};
  // 全部候选都是空值时返回 ''，不能返回 undefined——外层要 String() 它，
  // String(undefined) 是字符串 "undefined"，会被拼成 `undefined`.`Defect` 这种表名。
  // 这种错不会报 semantic error，它只是"查询成功、零行"，与"今天没活"无法区分。
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && String(v).trim() !== '') ?? '';
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const map = (sev.map && typeof sev.map === 'object' && !Array.isArray(sev.map)) ? sev.map : null;
  // 任务类型可以多个：同一空间里"缺陷"和"需求"是两种工作项，MQL 的表名不同，必须分别查。
  // 来源优先级 env（单个，逗号分隔）> taskTypes 数组 > 旧的 workItemType 字符串 > 内置兜底。
  const rawTypes = pick(env.FEISHU_WORK_ITEM_TYPE, c.taskTypes, c.workItemType);
  const taskTypes = (Array.isArray(rawTypes) ? rawTypes : String(rawTypes ?? '').split(','))
    .map((t) => String(t).trim())
    .filter(Boolean);
  const types = taskTypes.length ? taskTypes : [DEFAULTS.workItemType];
  return {
    projectKey: String(pick(env.FEISHU_PROJECT_KEY, c.projectKey, DEFAULTS.projectKey)),
    taskTypes: types,
    // 兼容单类型调用方（buildMyBugsMql 一次查一种）：第一个就是主类型
    workItemType: types[0],
    assigneeField: String(pick(env.FEISHU_ASSIGNEE_FIELD, c.assigneeField, DEFAULTS.assigneeField)),
    newStatus: String(pick(env.FEISHU_NEW_STATUS, c.newStatus, DEFAULTS.newStatus)),
    mqlLimit: Math.min(num(pick(env.FEISHU_MQL_LIMIT, c.mqlLimit), DEFAULTS.mqlLimit), 50),
    severityField: String(pick(env.FEISHU_SEVERITY_FIELD, sev.field, DEFAULTS.severityField)),
    severityMap: map ? { ...map } : { ...DEFAULTS.severityMap },
    issuer: String(pick(env.FEISHU_ISSUER, c.issuer, DEFAULTS.issuer)),
    // 迭代过滤：field 与 prefix 任一为空即整体关闭（宁可不过滤，不半开半关）。
    // field 必须显式配：迭代字段的 key 随空间变（与 severity 同理，不猜内置默认）。
    iterationField: String(pick(env.FEISHU_ITERATION_FIELD, iter.field, '')),
    iterationPrefix: String(pick(env.FEISHU_ITERATION_PREFIX, iter.prefix, '')),
  };
}

/**
 * 拼我的待处理缺陷查询。
 * projectKey 必填——空值拼出来的 MQL 会被服务端判 semantic error，那种错隔着网络根本看不出是"忘了传参数"，
 * 所以在本地就拦下。
 */
export function buildMyBugsMql({
  projectKey,
  workItemType = DEFAULTS.workItemType,
  type,                        // 旧名保留：配置化之前调用方传的是 type
  assigneeField = DEFAULTS.assigneeField,
  statuses = [DEFAULTS.newStatus],
  severityField = DEFAULTS.severityField,
  iterationField = '',         // 配了才带出（供解析后按前缀过滤；MQL 算子支持不实测不猜）
  limit = DEFAULTS.mqlLimit,
} = {}) {
  const itemType = workItemType || type;
  if (!projectKey) {
    throw new Error('buildMyBugsMql 缺 projectKey：MQL 的 FROM 必须写成 `<空间>.<工作项类型>`，否则服务端报 semantic error。配在 harness.rules.json 的 runtime.feishu.projectKey（或 FEISHU_PROJECT_KEY 临时覆盖）');
  }
  if (!itemType) throw new Error('buildMyBugsMql 缺工作项类型名：配 runtime.feishu.workItemType（如 Defect）');
  const inList = statuses.map((x) => `'${x}'`).join(', ');
  const statusClause = statuses.length === 1 ? `\`work_item_status\` = ${inList}` : `\`work_item_status\` IN (${inList})`;
  // 迭代字段只进 SELECT，不进 WHERE：该字段支持哪些算子未实测，客户端前缀过滤是唯一
  // 敢保证的形态（宁多拉几行再節，不把整条查询押在没验过的算子上）。
  const iterCol = iterationField ? `, \`${iterationField}\`` : '';
  return [
    `SELECT \`work_item_id\`, \`name\`, \`${severityField}\`${iterCol}, \`work_item_status\``,
    `FROM \`${projectKey}\`.\`${itemType}\``,
    `WHERE array_contains(\`${assigneeField}\`, current_login_user()) AND ${statusClause}`,
    `LIMIT ${Math.min(Number(limit) || DEFAULTS.mqlLimit, 50)}`,
  ].join(' ');
}

/**
 * 迭代周期前缀过滤（TDasset 落地规则 2026-11-14）：迭代 label 以指定前缀开头才算本产品线的 bug。
 * prefix 为空 → 不过滤（全部 matched），供未配置空间零行为变化。
 * 迭代为空/缺失 → skipped（不是本产品线的单；与用户规则一致：迭代是 IDMP 开头**才是**）。
 * 大小写不敏感（IDMP/idmp 同认）：label 里大小写拼写不稳定是常态，严判大小写只会漏单。
 */
export function filterByIterationPrefix(bugs, prefix = '') {
  const p = String(prefix || '').trim();
  if (!p) return { matched: [...bugs], skipped: [] };
  const matched = [];
  const skipped = [];
  for (const b of bugs) {
    const iter = String(b?.iteration ?? '').trim();
    if (iter && iter.toLowerCase().startsWith(p.toLowerCase())) matched.push(b);
    else skipped.push(b);
  }
  return { matched, skipped };
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
 *
 * severityMap 必须在这里传：归一发生在**解析时**，一解析完 platform 的词（高/中/低）就变成 P 档了，
 * 等到 gate 阶段再传词表已经晚了——那时手上只有 P1，词表里没有 P1 这个键，配置等于空转。
 */
export function parseMqlPage(text, { severityField = null, severityKey = null, severityMap = null, iterationField = null } = {}) {
  const sevField = severityField || severityKey || DEFAULT_SEVERITY_FIELD;
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
          bugs: rows.map((r) => fromMoqlRow(r, { severityField: sevField, severityMap, iterationField })),
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
        const bugs = arr.filter((x) => x && x.work_item_id != null).map((b) => normBug(b, severityMap));
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
      if (iId >= 0 && cells[iId]) out.push(normBug({ work_item_id: cells[iId], name: iName >= 0 ? cells[iName] : '', severity: iSev >= 0 ? cells[iSev] : undefined, status: iSt >= 0 ? cells[iSt] : undefined }, severityMap));
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
function fromMoqlRow(row, { severityField, severityMap = null, iterationField = null }) {
  const flat = {};
  for (const f of row.moql_field_list) {
    if (!f || !f.key) continue;
    flat[f.key] = unwrapMoqlValue(f.value);
  }
  return normBug({
    work_item_id: flat.work_item_id,
    name: flat.name,
    severity: flat[severityField],
    status: flat.work_item_status ?? flat.status,
    priority: flat.priority,
    iteration: iterationField ? flat[iterationField] : flat.iteration,
  }, severityMap);
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

function normBug(b, severityMap = null) {
  return {
    work_item_id: b.work_item_id == null ? '' : String(b.work_item_id),
    name: b.name || b.title || '',
    severity: normSeverity(b.severity, severityMap),
    priority: b.priority == null ? '' : String(b.priority),
    status: b.status || '',
    iteration: b.iteration == null ? '' : String(b.iteration),
  };
}

/**
 * 严重级归一。**先查配置的词表，再走内置词表**。
 *
 * 配置优先的原因：平台的严重级是自定义字段，词表随空间变（这一个是 高/中/低，下一个可能是
 * 致命/严重/一般/轻微，或者 S1/S2/S3）。词表写死在代码里，换个空间就得改代码——那等于
 * 把"配置"这件事只做了一半。内置词表只负责兜底，保证配置缺失时不崩。
 *
 * 内置覆盖三套：P 档（P0-P3）、中文轻重、英文轻重。无命中一律 P3——但 P3 意味着"不接"，
 * 所以调用方要能看出这是"缺值"而不是"判低"。
 */
export function normSeverity(s, map = null) {
  const raw = String(s == null ? '' : s).trim();
  if (!raw) return 'P3';
  if (map && typeof map === 'object') {
    if (map[raw] !== undefined) return String(map[raw]);
    const upper = raw.toUpperCase();
    for (const [k, v] of Object.entries(map)) {
      if (String(k).toUpperCase() === upper) return String(v);
    }
  }
  const t = raw.toUpperCase();
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
 * severityMap: runtime.feishu.severity.map，透传给 normSeverity（配置优先于内置词表）。
 */
export function gateBySeverity(bugs, autoPick = [{ severity: ['P0', 'P1'], action: 'auto' }, { severity: ['P2'], action: 'confirm_first' }], severityMap = null) {
  const auto = [];
  const confirm = [];
  const skip = [];
  for (const b of bugs) {
    // 门槛层再归一一次：调用方可能传未经 parseMqlResult 的裸对象（实测踩过）
    const sev = normSeverity(b.severity, severityMap);
    const rule = autoPick.find((r) => (r.severity || []).includes(sev));
    if (!rule || rule.action === 'skip') skip.push(b);
    else if (rule.action === 'auto') auto.push(b);
    else confirm.push(b);
  }
  return { auto, confirm, skip };
}
