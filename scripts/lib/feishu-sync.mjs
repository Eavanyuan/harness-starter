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
 *
 * 状态名与类型名用英文 label（2026-11-14 接线时修正）：该空间 MQL/枚举只认
 * New/Processing/Releasing/Done/Canceled（中文「处理中」会匹配不上可流转列表，
 * fail-closed 全部失败——实测前的坑）；工作项类型同理是 Defect 不是「缺陷」。
 */
export async function transitionStatus({ call, projectKey, workItemId, workItemType = 'Defect', toStatus }) {
  const statesText = await call('get_transitable_states', { project_key: projectKey, work_item_id: String(workItemId), work_item_type: workItemType });
  // 可流转态返回形态未实测：宽松匹配状态名，匹配不到按"无法判定"报错
  const hit = new RegExp(String(toStatus)).test(statesText);
  if (!hit) {
    return { ok: false, reason: `目标状态「${toStatus}」不在可流转列表（返回：${String(statesText).slice(0, 120)}）——流程配置或状态名不对，不硬转` };
  }
  await call('update_field', { project_key: projectKey, work_item_id: String(workItemId), work_item_type: workItemType, field_key: 'status', value: toStatus });
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

/**
 * 接单三连：评论附接单预告 + 状态流转 New→Processing。任何一步失败返回 {ok:false}，上层释放 CAS 升级。
 * 状态变更/评论显示的身份 = 凭据本人（OAuth 用户 token）。dry-run 不调它。
 */
export async function acknowledgeBug({ call, projectKey, workItemId, workItemType = 'Defect', note }) {
  const commented = await call('add_comment', { project_key: projectKey, work_item_id: String(workItemId), content: note }).then(() => true, (e) => { throw new Error(`评论失败：${e.message}`); });
  const tr = await transitionStatus({ call, projectKey, workItemId, workItemType, toStatus: 'Processing' });
  return { ok: commented && tr.ok, transition: tr };
}
