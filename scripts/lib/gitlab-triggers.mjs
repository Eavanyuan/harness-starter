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

/** 最近一次"requested changes"系统留言（GitLab 16+ 有该 review verb；老版本为空）。 */
export function changesRequestedAt(discussions) {
  let last = null;
  for (const d of discussions || []) {
    for (const n of d.notes || []) {
      if (!n.system) continue;
      if (/requested changes/i.test(String(n.body || ''))) {
        if (!last || new Date(n.created_at) > new Date(last)) last = n.created_at;
      }
    }
  }
  return last;
}

/**
 * 单条 MR 的分流（纯函数）。返回 { reviewState, signal, triggered, unresolved, approval }。
 * reviewState：approved（已过停点，不动）| changes_requested（待修）| pending（无待修意见）
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

  if (approval.ok) return { reviewState: 'approved', signal: 'approval', triggered: false, unresolved, approval };
  if (unresolved.length === 0) return { reviewState: 'pending', signal: 'none', triggered: false, unresolved, approval };

  const crAt = changesRequestedAt(discussions);
  // 打回动词必须晚于最后一次 push 才算数：批之前的申请改动已被新 commit 覆盖
  const crFresh = crAt && (!lastPushAt || new Date(crAt) > new Date(lastPushAt));
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

  const mrs = await api('/merge_requests?scope=created_by_me&state=opened&per_page=20');
  const out = [];
  for (const mr of mrs) {
    if (mrFilter && String(mr.iid) !== String(mrFilter)) continue;
    const base = `/projects/${mr.project_id}/merge_requests/${mr.iid}`;
    const discs = await api(`${base}/discussions`);
    // 先粗判：无人未解决就不必再打审批与 commit 两个接口（20 条 MR 的轮询要省在热路径上）
    if (unresolvedByOthers(discs, username).length === 0) continue;
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
    out.push({ kind: 'mr', id: mr.iid, mr, unresolved: r.unresolved, reviewState: r.reviewState, signal: r.signal, approval: r.approval });
  }
  return out;
}
