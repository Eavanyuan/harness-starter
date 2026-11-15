/**
 * 信息完备性检查与追问（2026-11-15）——接单前的守门。
 *
 * 用户规则：拉到 bug 后，无截图、无日志、描述无法复现 → 不接单，直接评论 @提交者
 * 要求提供截图、日志文件或详细复现步骤。只追问一次（防每轮轮询刷屏）。
 *
 * 两层守门（2026-11-15 用户澄清后拆分）：
 *   第一层（本模块，task-loop 拉单时）：描述空洞到无法着手 → 不接单，评论 @提交者。
 *   第二层（修复会话中，docs/06-reference/bug-fix-workflow.md）：照描述实际尝试
 *   复现但错误未出现 → 不修，评论说明试了什么复现不了。
 * 本模块只做第一层（预筛）。判据：描述<30字/空，且无截图指标无日志指标 → 不接。
 *
 * @ 格式（MCP add_comment schema 实测）：先 search_user_info 拿 lark_user_id，
 * 评论中写 `@名字<!-- mention:{"id":"<lark_user_id>","cn_name":"<名字>","blockType":"AT_USER_BLOCK"} -->`。
 * 防重：list_workitem_comments 找标记 [自动追问]——已追问过不再发。
 */

const ASK_MARKER = '[自动追问]';

/** 判断描述是否含足够复现信息（启发式；返回 {complete, missing[]}）。 */
export function assessDescription(text) {
  const t = String(text || '').trim();
  const missing = [];
  if (!t || t.length < 30) {
    return { complete: false, missing: ['描述过短或为空（少于 30 字），无法判断问题内容'] };
  }
  const hasSteps = /步骤|复现|reproduc|steps|observed|expected|操作|现象|重现|how to/i.test(t);
  const hasEnv = /版本|version|环境|IDMP|build|deploy|环境|v\d+\.\d+/i.test(t);
  const hasScreenshot = /img|image|截图|screenshot|attachment|file_token|\.png|\.jpg|\.jpeg|\.gif/i.test(t);
  const hasLog = /日志|log|error|stack|trace|exception|报错/i.test(t);

  if (!hasSteps) missing.push('缺少复现步骤或操作路径（如何触发这个问题）');
  if (!hasScreenshot) missing.push('缺少截图（界面问题需要看到实际状态）');
  if (!hasLog) missing.push('缺少日志或错误信息（后端问题需要 log/stack trace）');

  // 三项全缺 → 不接单；缺一两项但描述够长且有步骤/环境线索 → 可接（修的时候再要也行）
  const complete = missing.length < 3;
  return { complete, missing };
}

/**
 * 检查 bug 信息完备性；不全则评论 @提交者追问（只追一次）。
 * 返回 {ok: true} = 信息够，可接单；{ok: false, asked: bool, reason} = 不接单。
 */
export async function checkInfoOrAsk({ call, projectKey, workItemId, workItemType = 'Defect' }) {
  // 1) 取描述与提交者
  let brief, desc, creator;
  try {
    brief = JSON.parse(await call('get_workitem_brief', { project_key: projectKey, work_item_id: String(workItemId) }));
    desc = String(brief?.work_item_fields?.find((f) => f.key === 'description')?.value || '');
    creator = brief?.work_item_attribute?.create_by;
  } catch {
    // brief 拿不到就不拦——不因为工具故障误判"信息不全"
    return { ok: true, note: 'brief 不可读，跳过完备性检查' };
  }

  // 2) 启发式判定
  const { complete, missing } = assessDescription(desc);
  if (complete) return { ok: true };

  // 3) 不全 → 检查是否已追问过（防刷屏）
  try {
    const comments = await call('list_workitem_comments', { project_key: projectKey, work_item_id: String(workItemId), page_num: 1 });
    if (String(comments).includes(ASK_MARKER)) {
      return { ok: false, asked: false, already_asked: true, reason: '信息不全且已追问过，等提交者补充' };
    }
  } catch {
    // 评论列表读不到 → 硬拦？不——宁可多发一次也不漏问。但如果 add_comment 也失败就不硬崩。
  }

  // 4) 拿提交者 lark_user_id（@用）
  let mention = '';
  let creatorName = (creator?.name || '提交者').trim();
  if (creator?.key) {
    try {
      const users = JSON.parse(await call('search_user_info', { user_keys: [String(creator.key)] }));
      const u = Array.isArray(users) ? users[0] : null;
      if (u?.lark_user_id) {
        mention = `@${u.name_cn || creatorName}<!-- mention:{"id":"lark_user_id_${u.lark_user_id}","cn_name":"${u.name_cn || creatorName}","blockType":"AT_USER_BLOCK"} -->`;
        creatorName = u.name_cn || creatorName;
      }
    } catch { /* @拼不上就纯文字提醒，不因 @ 失败不追问 */ }
  }
  if (!mention) mention = `@${creatorName}`;

  // 5) 发追问评论
  const content = `${ASK_MARKER} ${mention} 本单信息不全，暂不接单处理。缺失项：\n${missing.map((m) => `- ${m}`).join('\n')}\n\n请补充以下任一项后我们会继续处理：\n- 截图（界面问题）\n- 日志文件或错误堆栈（后端问题）\n- 详细复现步骤（操作路径 + 预期 vs 实际）\n\n（本评论由自动流程发送，补充后无需回复——下一轮轮询自动重新评估）`;
  try {
    await call('add_comment', { project_key: projectKey, work_item_id: String(workItemId), content });
    return { ok: false, asked: true, reason: `信息不全（${missing.length} 项缺失），已评论 @${creatorName} 追问` };
  } catch (e) {
    return { ok: false, asked: false, error: `追问评论发送失败：${String(e.message).slice(0, 100)}`, reason: `信息不全但评论失败：${missing.join('、')}` };
  }
}
