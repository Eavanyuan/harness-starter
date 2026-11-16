/**
 * 剖面 A 触发源（T3）—— 从 GitLab 结构化信号判"哪条 MR 被打回待修"。
 *
 * 为什么独立成文件：runner 带 process.exit 与顶层副作用，import 即执行；判定逻辑留在
 * runner 里就只能"跑一遍看输出"，喂不进假数据。上一版正是如此——把 fetchTriggers 整段
 * 反转（有他人未解决 → 已解决且是我写的），17 条断言零新增红，等于这段零覆盖。
 *
 * GitLab 没有 GitHub 那种原生 CHANGES_REQUESTED review 状态，所以判定要两条信号同时成立：
 *   1. 存在他人（非本人）写的、未解决的 resolvable discussion —— "有意见待修"的硬证据
 *   2. 不存在晚于最后一次 push 的有效批红 —— 已批红说明已过停点；剩余未 resolve 的老意见
 *      是人事后没清理，据此自动改代码会把已通过的 MR 改红
 * 只看 1 会把"批了忘 resolve"误判成打回；只看 2 会把"批完又推了 commit"误判成通过。
 * 两条合起来，才是 RS US-1「CHANGES_REQUESTED 且存在未解决 discussions」的机器可判形态；
 * **判不了就明说不判**（缺审批时间 → approvalValid 直接返回不通过并给理由），不给默认值。
 */
import { approvalValid } from './task-loop-core.mjs';

/** 未解决的、由他人写的 resolvable 讨论（本人自己的留言不算打回证据）。 */
export function unresolvedByOthers(discussions, username) {
  // 空 username 不是"没有他人"而是"不知道谁是我"：`n.author.username !== ''` 对每条留言都成立，
  // 于是自己写的未解决留言全被当成他人的打回意见。实测同一条讨论：
  //   username="me" → 他人未解 0、triggered=false；username="" → 他人未解 1、triggered=true
  // 假触发会每轮把已批红的 MR 拉回来重做，且看起来一切正常。判不了就不判，直接抛。
  if (!username || !String(username).trim()) {
    throw new Error('unresolvedByOthers 缺 username：空值会把你自己的留言当成他人的打回证据（假触发）。用 GET /user 取 token 对应账号，或 GITLAB_USERNAME 显式指定');
  }
  return (discussions || []).filter((d) =>
    (d.notes || []).some((n) => n.resolvable && !n.resolved && n.author?.username !== username));
}

/**
 * 从系统留言还原审批现状。
 *
 * 为什么不用 /approvals 接口：它只给 approved_by 名单，**不给时间**，而"审批晚于最后一次
 * push"正是停点三条件里唯一能拦"陈批"的一条（新 commit 会清空 approve，是实测行为）。
 * 系统留言里的 "approved this merge request" 带 created_at，时间与人都齐。
 * 按时间顺序回放：approve 置位、unapprove 清零——最后一次表态说话。
 */
export function approvalFromDiscussions(discussions) {
  const events = [];
  for (const d of discussions || []) {
    for (const n of d.notes || []) {
      if (!n.system) continue;
      const body = String(n.body || '');
      if (/unapproved this merge request/i.test(body)) events.push({ at: n.created_at, kind: 'unapprove', who: n.author?.username });
      else if (/approved this merge request/i.test(body)) events.push({ at: n.created_at, kind: 'approve', who: n.author?.username });
    }
  }
  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  let approvers = [];
  let approvedAt = null;
  for (const e of events) {
    if (e.kind === 'approve') { approvers = [e.who].filter(Boolean); approvedAt = e.at; }
    else { approvers = []; approvedAt = null; }
  }
  return { approvers: approvers.map((username) => ({ username })), approvedAt, sawSystemNote: events.length > 0 };
}

/**
 * 最近一次"requested changes"系统留言（GitLab 16+ 有该 review verb；老版本为空）。
 * username 必填：本人发的动词不算打回证据，与 unresolvedByOthers / reviewCommentsByOthers
 * 同口径——判不了"谁是我"就抛，不静默混入（空值会把自发动词当成他人打回）。
 */
export function changesRequestedAt(discussions, username = null) {
  if (!username || !String(username).trim()) {
    throw new Error('changesRequestedAt 缺 username：空值会把你自己的 requested changes 当成他人的打回证据');
  }
  let last = null;
  for (const d of discussions || []) {
    for (const n of d.notes || []) {
      if (!n.system) continue;
      if (n.author?.username === username) continue;
      if (/requested changes/i.test(String(n.body || ''))) {
        if (!last || new Date(n.created_at) > new Date(last)) last = n.created_at;
      }
    }
  }
  return last;
}

/**
 * 评审人的建议性评论（非系统、非本人）——接单后的修复范围输入。
 *
 * 为什么需要（2026-11-16 MR !1882 实测 + 用户指令）：评审人常用普通评论写
 * 「建议修改项」（non-resolvable），这类评论既不进 unresolved（没有 resolvable 标志），
 * 也永远不会被 resolve。若只把 resolvable 讨论当待修清单，动词型触发的 ack 会是空的，
 * 修复会话拿不到「要修什么」——审核意见里的建议项必须纳入接单修复范围。
 * 已在 unresolved 里的讨论（他人未解决 resolvable）不重复列：那是另一路证据，双列会在 ack 里回两条。
 */
export function reviewCommentsByOthers(discussions, username) {
  if (!username || !String(username).trim()) {
    throw new Error('reviewCommentsByOthers 缺 username：空值会把你自己的评论当成待修意见');
  }
  const out = [];
  for (const d of discussions || []) {
    for (const n of d.notes || []) {
      if (n.system) continue;                    // 系统留言不是评审意见
      if (n.author?.username === username) continue; // 自发不算
      if (n.resolvable) continue;                // resolvable note 由 unresolved 承担，不双列；
                                                // 但同线程里后续的普通回复（non-resolvable）
                                                // 也是建议项，按 note 级过滤而不是整线程跳过
      out.push({ id: d.id, note: n.id, body: String(n.body || ''), createdAt: n.created_at, author: n.author?.username });
    }
  }
  return out;
}

/**
 * 单条 MR 的分流（纯函数）。返回 { reviewState, signal, triggered, unresolved, approval }。
 * reviewState：approved（已过停点，不动）| changes_requested（待修）| pending（无待修意见）
 *
 * 打回证据两路并列，任一成立且无更新的批红即触发：
 *   1. 他人未解决的 resolvable 讨论（diff 意见）
 *   2. 他人晚于最后一次 push 的 requested changes 动词（GitLab 16+）。
 * 2026-11-16 MR !1882 实测：评审者用普通评论 + approve→unapprove + 动词表态，整条 MR
 * 零 resolvable 讨论——只认证据 1 会把真实打回判 pending，MR 对 runner 不可见。
 */
export function classifyMr({ mr, discussions, username, lastPushAt = null, approvers = null }) {
  const unresolved = unresolvedByOthers(discussions, username);
  const ap = approvalFromDiscussions(discussions);
  const effectiveApprovers = (approvers && approvers.length) ? approvers : ap.approvers;
  const approval = approvalValid({
    approvers: effectiveApprovers,
    author: mr?.author?.username || username,
    lastPushAt,
    approvedAt: ap.approvedAt,
  });
  const crAt = changesRequestedAt(discussions, username);
  // 打回动词必须晚于最后一次 push 才算数：批之前的申请改动已被新 commit 覆盖
  const crFresh = crAt && (!lastPushAt || new Date(crAt) > new Date(lastPushAt));
  // 批红要成为"最后的话"必须晚于打回动词：评审者 a 批过、评审者 b 随后要求改动，
  // 停点仍是待修（批红时间早于动词 → 不算已过停点）。批红无时间（approvals 降级）时
  // 判不了先后 → 不给 approved，宁可多跑一轮。
  const approvalLastWord = approval.ok && (!crAt || (ap.approvedAt && new Date(ap.approvedAt) > new Date(crAt)));

  if (approvalLastWord) return { reviewState: 'approved', signal: 'approval', triggered: false, unresolved, approval };
  if (unresolved.length === 0 && !crFresh) return { reviewState: 'pending', signal: 'none', triggered: false, unresolved, approval };

  return {
    reviewState: 'changes_requested',
    signal: crFresh ? 'review_verb' : 'unresolved_discussions',
    triggered: true,
    unresolved,
    approval,
  };
}

/**
 * 拉一轮触发。返回 [{ kind:'mr', id, mr, unresolved, reviewState, signal }]。
 * 只对"有他人未解决意见"的 MR 追加两次接口调用（审批兜底、末次 push 时间），没意见的直接跳过。
 */
/**
 * token 是谁，我就算谁。
 *
 * `username` 以前靠人配 GITLAB_USERNAME，而 install-task-loop.sh 从来没有注入过它——
 * 于是定时器里恒为空串，判定「他人未解决意见」时每一条自己写的留言都成了他人意见。
 * 这个值本来就不该被配置：它不描述偏好，它描述事实，而事实的唯一权威是 token 本身。
 * 取不到就抛，绝不返回空串（空串在下游等价于「把自己当成别人」）。
 */
export async function fetchCurrentUser({ url, token, fetchImpl = fetch }) {
  const res = await fetchImpl(`${url}/api/v4/user`, {
    headers: { 'private-token': token },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`GitLab 拒绝了 GITLAB_TOKEN（HTTP ${res.status}）：private-token 头只认 PAT，OAuth access token 不行；令牌过期也会是这个状态`);
  }
  if (!res.ok) throw new Error(`GitLab /user HTTP ${res.status}`);
  const j = await res.json().catch(() => null);
  const username = j?.username;
  if (!username) throw new Error('GitLab /user 没返回 username——判不了「谁是我」，拒绝继续（空值会把你的留言当成他人的打回）');
  return String(username);
}

export async function fetchTriggers({ url, token, username, fetchImpl = fetch, mrFilter }) {
  const api = async (path) => {
    const res = await fetchImpl(`${url}/api/v4${path}`, {
      headers: { 'private-token': token },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitLab ${path} HTTP ${res.status}`);
    return res.json();
  };
  const optional = async (path) => { try { return await api(path); } catch { return null; } };

  // per_page=100（GitLab 单页上限）：列表无翻页，页大小就是 sweep 的视角边界——本人 open MR
  // 超过页大小会把最老的挤出列表，被 sweep 误判"触发消失"关账（CR 二审新发现，🔴#1 同类形态）。
  // 100 对单人已极难触顶；真触顶时的彻底解法是关账前单查 MR 状态复核（KI-3 登记）。
  const mrs = await api('/merge_requests?scope=created_by_me&state=opened&per_page=100');
  const out = [];
  for (const mr of mrs) {
    if (mrFilter && String(mr.iid) !== String(mrFilter)) continue;
    const base = `/projects/${mr.project_id}/merge_requests/${mr.iid}`;
    const discs = await api(`${base}/discussions`);
    // 先粗判：既无他人未解决意见、也无打回动词，就不必再打审批与 commit 两个接口（20 条 MR 的轮询要省在热路径上）。
    // 动词必须进粗筛：评审者用普通评论 + requested changes 表态时没有任何 resolvable 讨论
    // （2026-11-16 MR !1882 实测），只按未解决意见筛会把打回的 MR 在 classifyMr 之前就 continue 掉。
    if (unresolvedByOthers(discs, username).length === 0 && !changesRequestedAt(discs, username)) continue;
    const commit = await optional(`/projects/${mr.project_id}/repository/commits/${mr.sha}`);
    const lastPushAt = commit?.committed_date || commit?.created_at || null;
    // 审批兜底：目标 GitLab 老版本没有审批系统留言时，至少取到 approved_by 名单（时间仍缺 → 判不了）
    const ap = approvalFromDiscussions(discs);
    let approvers = null;
    if (!ap.sawSystemNote) {
      const raw = await optional(`${base}/approvals`);
      approvers = (raw?.approved_by || []).map((x) => ({ username: x.user?.username })).filter((x) => x.username);
    }
    const r = classifyMr({ mr, discussions: discs, username, lastPushAt, approvers });
    if (!r.triggered) continue;
    // 建议性评论是修复范围的输入，跟触发证据一起进 payload（用户指令 2026-11-16：
    // 即便评审人不逐条回复/resolve，审核意见里的建议修改项也纳入接单修复范围）。
    out.push({ kind: 'mr', id: mr.iid, mr, unresolved: r.unresolved, comments: reviewCommentsByOthers(discs, username), reviewState: r.reviewState, signal: r.signal, approval: r.approval });
  }
  return out;
}

/**
 * 触发内容指纹（2026-11-16 关账半环）：待修内容的最小稳定投影。
 * 用途：ack 里记下它，下一轮 sweep 对比——相同=内容没变（等 re-review/等修复，不动）；
 * 不同=评审又写了新东西（新讨论/新评论），重置 ack 重新认领。只取 id 不取 body：
 * body 改写（改错别字）不算新意见，避免无关编辑触发重认领。
 */
export function triggerFingerprint(t) {
  const parts = [
    ...(t.unresolved || []).flatMap((d) => (d.notes || [])
      .filter((n) => n.resolvable && !n.resolved)
      .map((n) => `d${d.id}n${n.id}`)),
    ...(t.comments || []).map((c) => `c${c.id ?? c.note}`),
  ].sort();
  return parts.length ? parts.join(',') : 'empty';
}
