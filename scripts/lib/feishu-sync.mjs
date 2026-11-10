/**
 * 飞书项目回写同步（T6）—— 状态流转 / 评论 / 字段写后读回。
 *
 * schema 依据 2026-11-10 从活通道 tools/list 捞取的 inputSchema（数据档未开通前
 * 只有目录可见，但 schema 是全的）：
 *   get_transitable_states: {project_key, work_item_id, work_item_type?, user_key?}
 *   update_field: {work_item_id, ...字段与角色操作混合结构}
 *   add_comment: {project_key, work_item_id, content(markdown)}
 *
 * 读回验证是硬步骤（Apse/演练教训：平台字段静默丢弃——API 返回成功、回读为空，
 * 只能靠 GET 一次比对发现；读不回来就评论兜底，绝不静默）。
 */

/**
 * 状态流转：先查可流转态（目标不在列表=当前流不允许，显式报错不硬转），
 * 再 update_field 写状态，最后回读确认。
 */
export async function transitionStatus({ call, projectKey, workItemId, workItemType = '缺陷', toStatus }) {
  const statesText = await call('get_transitable_states', { project_key: projectKey, work_item_id: String(workItemId), work_item_type: workItemType });
  // 可流转态返回形态未实测（数据档未开）：宽松匹配状态名，匹配不到按"无法判定"报错
  const hit = new RegExp(String(toStatus)).test(statesText);
  if (!hit) {
    return { ok: false, reason: `目标状态「${toStatus}」不在可流转列表（返回：${statesText.slice(0, 80)}）——流程配置或状态名不对，不硬转` };
  }
  await call('update_field', { project_key: projectKey, work_item_id: String(workItemId), field_key: 'status', value: toStatus });
  return readbackOrComment({ call, projectKey, workItemId, expect: { status: toStatus }, fallbackNote: `状态已流转为「${toStatus}」（回读未确认，以此评论为凭）` });
}

/**
 * 写后读回：写字段 → get_workitem_brief 回读 → 逐字段比对。
 * 任一字段读不回（静默丢弃形态）→ add_comment 兜底留凭并标记 degraded。
 */
export async function readbackOrComment({ call, projectKey, workItemId, expect, fallbackNote }) {
  const degraded = [];
  try {
    const brief = await call('get_workitem_brief', { project_key: projectKey, work_item_id: String(workItemId), fields: Object.keys(expect) });
    for (const [k, v] of Object.entries(expect)) {
      const ok = new RegExp(String(v)).test(brief);
      if (!ok) degraded.push(k);
    }
  } catch {
    degraded.push('(brief 读取失败，整体无法确认)');
  }
  if (degraded.length === 0) return { ok: true, degraded: [] };
  // 兜底：评论留凭。评论也失败才彻底失败——那时上层按 blocked 升级
  try {
    await call('add_comment', { project_key: projectKey, work_item_id: String(workItemId), content: `⚠ ${fallbackNote}（未确认字段：${degraded.join('、')}）` });
    return { ok: true, degraded, via: 'comment-fallback' };
  } catch (e) {
    return { ok: false, degraded, reason: `写后读回失败且评论兜底也失败：${e.message}` };
  }
}

/** 接单三连：状态流转 + 评论附 MR 预告。任何一步失败返回 {ok:false}，上层释放 CAS 升级。 */
export async function acknowledgeBug({ call, projectKey, workItemId, note }) {
  const commented = await call('add_comment', { project_key: projectKey, work_item_id: String(workItemId), content: note }).then(() => true, (e) => { throw new Error(`评论失败：${e.message}`); });
  const tr = await transitionStatus({ call, projectKey, workItemId, toStatus: '处理中' });
  return { ok: commented && tr.ok, transition: tr };
}
