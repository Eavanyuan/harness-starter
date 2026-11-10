/**
 * 剖面 B 触发源（T6）—— 飞书缺陷单的 MQL 轮询与分级门槛。
 *
 * 触发判据（设计定案）：指派给我 + 状态待处理。认领后平台状态流转即天然去重
 * （流转后不再命中查询），跨机仲裁走 git CAS——本模块只管"找出该看的单"。
 *
 * 结果解析防御：MQL 文本返回有两种可能形态（JSON 数组 / 管道表格），数据档未开通前
 * 无法确证真实形态——两种都解析，都失败显式报"无法解析"（fail-closed，不装没单子）。
 * 数据档授权后第一次实测若形态确认，删掉另一种（留 TODO 标记）。
 */
export function buildMyBugsMql({ type = '缺陷', statuses = ['待处理'], limit = 20 } = {}) {
  const inList = statuses.map((x) => `'${x}'`).join(', ');
  return `SELECT \`work_item_id\`, \`name\`, \`severity\`, \`status\` FROM \`${type}\` WHERE \`owner\` = current_login_user() AND \`status\` IN (${inList}) LIMIT ${limit}`;
}

/** MQL 文本 → 单子数组。JSON 数组优先，其次管道表格；都失败抛错（不返回空数组装没事）。 */
export function parseMqlResult(text) {
  const t = String(text || '').trim();
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.filter((x) => x && x.work_item_id != null).map(normBug);
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
    if (out.length) return out;
  }
  throw new Error(`MQL 结果无法解析（既非 JSON 数组也非表格，前 80 字：${t.slice(0, 80)}）——fail-closed，不当作"没有单子"`);
}

function normBug(b) {
  return {
    work_item_id: String(b.work_item_id),
    name: b.name || b.title || '',
    severity: normSeverity(b.severity),
    status: b.status || '',
  };
}

/** 严重级归一：P0/P1/P2 与中文"致命/严重/一般"两套词汇归到 P0-P2 档。 */
export function normSeverity(s) {
  const t = String(s || '').toUpperCase();
  if (/P0|致命|BLOCKER/.test(t)) return 'P0';
  if (/P1|严重|CRITICAL|HIGH/.test(t)) return 'P1';
  if (/P2|一般|MAJOR|MEDIUM/.test(t)) return 'P2';
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
