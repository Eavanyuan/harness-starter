/**
 * 飞书项目回写同步 —— 状态流转（2026-11-15 重写）。
 *
 * 三个实测教训（2026-11-14/15 首次真实接单踩出来的）：
 *   1. 状态流转的专用工具是 `transition_state {project_key, work_item_id, transition_id}`，
 *      transition_id 从 get_transitable_states 取。**不是** update_field——它的 fields 是
 *      业务字段数组，状态不归它管，传错参数它静默返回空（{"mcp_result":""}），状态纹丝不动。
 *   2. 回读不能用 get_workitem_brief：实测其响应里 status 字段读不出（undefined），
 *      每次都误判"未确认"→触发兜底评论刷屏。可靠回读是 search_by_mql 查 work_item_status。
 *   3. **绝不自动评论**（2026-11-15 用户指令）：接单只改状态；上一版的"评论兜底"
 *      在流转失败时谎报"状态已流转"并堆评论，全部移除。失败就如实报失败。
 */

/** MQL 回读工作项状态（label，如 New/Processing）。 */
export async function readStatusViaMql({ call, projectKey, workItemId }) {
  const raw = await call('search_by_mql', {
    project_key: projectKey,
    mql: `SELECT \`work_item_status\` FROM \`${projectKey}\`.\`Defect\` WHERE \`work_item_id\` = ${String(workItemId).replace(/[^0-9]/g, '')}`,
  });
  let rows = null;
  try {
    const j = JSON.parse(raw);
    rows = j?.data?.['1'] || Object.values(j?.data || {}).find(Array.isArray);
  } catch { /* 落到文本匹配 */ }
  if (rows && rows[0]?.moql_field_list?.[0]?.value) {
    const v = rows[0].moql_field_list[0].value;
    const lbl = v.key_label_value_list?.map((x) => x.label).join(',') || v.key_label_value?.label;
    if (lbl) return lbl;
  }
  const m = String(raw).match(/"state_name"\s*:\s*"([^"]+)"/) || String(raw).match(/New|Processing|Releasing|Done|Canceled/);
  return m ? (m[1] || m[0]) : null;
}

/**
 * 状态流转：get_transitable_states 找目标态的 transition_id → transition_state → MQL 回读确认。
 * 幂等出口：当前态已是目标态 → {ok:true, via:'already'}（重复接单/重试不报错）。
 * 失败如实返回 {ok:false, reason}——**不做任何评论兜底**。
 */
export async function transitionStatus({ call, projectKey, workItemId, workItemType = 'Defect', toStatus = 'Processing' }) {
  const current = await readStatusViaMql({ call, projectKey, workItemId });
  if (current === toStatus) return { ok: true, via: 'already', current };

  const raw = await call('get_transitable_states', { project_key: projectKey, work_item_id: String(workItemId), work_item_type: workItemType });
  let transitions = [];
  try {
    const j = JSON.parse(raw);
    transitions = Array.isArray(j?.transition) ? j.transition : [];
  } catch { /* 下面按文本兜底 */ }
  let transitionId = null;
  if (transitions.length) {
    const hit = transitions.find((t) => t.state_name === toStatus || t.state_key === toStatus);
    transitionId = hit?.id != null ? String(hit.id) : null;
  } else {
    // 文本兜底：{"id":21912443,"state_key":"In Progress","state_name":"Processing"...}
    const re = new RegExp(`"id"\\s*:\\s*(\\d+)[^}]*?"state_name"\\s*:\\s*"${toStatus}"`);
    const m = String(raw).match(re) || String(raw).match(new RegExp(`"state_name"\\s*:\\s*"${toStatus}"[^}]*?"id"\\s*:\\s*(\\d+)`));
    transitionId = m ? m[1] : null;
  }
  if (!transitionId) {
    return { ok: false, current, reason: `目标状态「${toStatus}」不在可流转列表（当前 ${current}）——流程配置或状态名不对，不硬转` };
  }

  await call('transition_state', { project_key: projectKey, work_item_id: String(workItemId), transition_id: transitionId });

  const after = await readStatusViaMql({ call, projectKey, workItemId });
  if (after !== toStatus) {
    return { ok: false, current: after, reason: `已调 transition_state(${transitionId}) 但回读仍为「${after}」——流转未生效，如实报失败不兜底` };
  }
  return { ok: true, via: 'transition_state', from: current, to: after };
}

/**
 * 接单（2026-11-15 定稿语义）：**只把 New→Processing，零评论**。
 * 之前版本"评论预告 + 状态流转 + 评论兜底"三件套经实测全部作废：评论堆屏（用户明确
 * 不要），流转走错工具静默失败。现在接单 = 一次 transition_state + MQL 回读确认，仅此而已。
 */
export async function acknowledgeBug({ call, projectKey, workItemId, workItemType = 'Defect' } = {}) {
  const tr = await transitionStatus({ call, projectKey, workItemId, workItemType, toStatus: 'Processing' });
  return { ok: tr.ok, transition: tr };
}
