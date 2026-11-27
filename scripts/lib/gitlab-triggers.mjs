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
/**
 * 评审结论评论（2026-11-17 review-verdict-comment，MR !1916 R2 实测盲区）：
 * 评审者复审后不（再）按 requested-changes 按钮——动词系统留言停留在上一轮、
 * 早于作者的新 push；结论以**普通评论**发出（"R2 复审结论：Request Changes…"）。
 * 此时无 resolvable 线程 + 动词过期 → 两路信号全盲。判据从严防误报：
 * 非系统、他人、明确的"要求改动"结论词；感谢/提问/LGTM/Approve 不算。
 */
export function reviewVerdictCommentAt(discussions, username) {
  if (!username || !String(username).trim()) {
    throw new Error('reviewVerdictCommentAt 缺 username：空值会把自己的结论评论当成他人的打回（同 changesRequestedAt 口径）');
  }
  // CR 一审 🔴：结论词不能任意位置子串命中——「关于 R1 的 Request Changes：均已核销，LGTM」
  // （引用旧结论的收尾）、「…request changes 的点吗？」（提问）都会被误判成新结论，最坏把
  // 已批准的 MR 拉回自动重做。判据收紧为**行首结论锚定**：只认作为一行开头（允许 markdown
  // 标题/加粗/RN 轮次/「复审结论：」标签前缀）的结论短语；引用行（> 开头）不认；疑问句不认；
  // 同行出现 LGTM/无需修改/可以合入/approve 的不认（结论与放行并存的行不当作打回）。
  const LINE_VERDICT = /^\s{0,3}(?:[#*_-]{1,4}\s*)*(?:\*\*|__)?(?:R\d+[.。]?\s*)?(?:(?:复审|审查|评审)?结论[:：]\s*)?(?:\*\*|__)?\s*(?:request(?:ed)?\s+changes|要求改动|打回待修)/i;
  const NOT_VERDICT = /\bLGTM\b|无需修改|可以合入|\bapprove\b|[?？]\s*$/i;
  let last = null;
  for (const d of discussions || []) {
    for (const n of d.notes || []) {
      if (n.system) continue;
      if (n.author?.username === username) continue;
      const body = String(n.body || '');
      const hit = body.split('\n').some((line) => {
        const l = line.trim();
        if (l.startsWith('>')) return false; // 引用行：引的是别人的旧结论
        return LINE_VERDICT.test(l) && !NOT_VERDICT.test(l);
      });
      if (!hit) continue;
      if (!last || new Date(n.created_at) > new Date(last)) last = n.created_at;
    }
  }
  return last;
}

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
  // 结论评论（!1916 R2 形态）：同样是"要求改动"的证据，同样要晚于最后一次 push
  const vcAt = reviewVerdictCommentAt(discussions, username);
  const vcFresh = vcAt && (!lastPushAt || new Date(vcAt) > new Date(lastPushAt));
  // 批红要成为"最后的话"必须晚于打回动词**与**结论评论：评审者 a 批过、评审者 b 随后以任一形态要求改动，
  // 停点仍是待修（批红时间早于任一 → 不算已过停点）。批红无时间（approvals 降级）时
  // 判不了先后 → 不给 approved，宁可多跑一轮。
  const approvalLastWord = approval.ok
    && (!crAt || (ap.approvedAt && new Date(ap.approvedAt) > new Date(crAt)))
    && (!vcAt || (ap.approvedAt && new Date(ap.approvedAt) > new Date(vcAt)));

  if (approvalLastWord) return { reviewState: 'approved', signal: 'approval', triggered: false, unresolved, approval };
  if (unresolved.length === 0 && !crFresh && !vcFresh) return { reviewState: 'pending', signal: 'none', triggered: false, unresolved, approval };

  return {
    reviewState: 'changes_requested',
    signal: crFresh ? 'review_verb' : (vcFresh ? 'review_comment' : 'unresolved_discussions'),
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

/**
 * 阻断项判定（2026-11-18 fix-suggestions，用户指令"可关闭只修阻塞问题"）：
 * 团队评审格式里阻断项带 🔴/阻断/必须修 标记（CR 模板与 yqli 实测评论同构）。
 * fixSuggestions=false 时：不带的建议性评论（🟡/建议）从修复范围剔除——
 * resolvable 打回线程天然是阻断（评审者开的必须解决项），系统留言不参与。
 */
export const BLOCKING_RE = /🔴|阻断|必须修|必须改/i;

/** 过滤建议性评论：返回剔除"非阻断建议"后的 discussions 副本（原数组不动）。 */
export function filterSuggestionNotes(discussions) {
  return (discussions || []).map((d) => ({
    ...d,
    notes: (d.notes || []).filter((n) => n.system || n.resolvable || BLOCKING_RE.test(String(n.body || ''))),
  }));
}

/** Draft 判定：work_in_progress 是权威字段；标题 Draft:/WIP: 前缀兜底（老版本/手工前缀）。 */
export function isDraftMr(mr) {
  // 前缀兜底：Draft:/WIP:（WIP: 是 GitLab<14 旧形态，保留无害）+ 现行官方括号形态 (Draft)/[Draft]/（草稿）
  // （CR 🟡#1：实例实测存在无 work_in_progress 字段的列表响应，兜底必须覆盖官方标题形态）
  const t = String(mr?.title || '');
  return mr?.work_in_progress === true || /^(draft|wip)\s*[:：（(]/i.test(t) || /^[（([]\s*(draft|wip)\s*[）)\]]/i.test(t);
}

export async function fetchTriggers({ url, token, username, fetchImpl = fetch, mrFilter, skipDrafts = true, fixSuggestions = true }) {
  const api = async (path) => {
    const res = await fetchImpl(`${url}/api/v4${path}`, {
      headers: { 'private-token': token },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitLab ${path} HTTP ${res.status}`);
    return res.json();
  };
  const optional = async (path) => { try { return await api(path); } catch { return null; } };
  // discussions 翻页（2026-11-26 review-with-ci，!1847 实测根因）：此前请求不带 per_page，GitLab 默认
  // 每页 20 条——该 MR 有 22 条，最新 2 条（含评审人打回评论）落在第二页，runner 每轮看到的都是
  // 「无评审意见、CI 红」。GitLab 用响应头 x-next-page 标下一页；取不全时**抛错**而不是返回部分：
  // 部分视角会让 sweep 把看不见的触发当「消失」关账（架构体检 🔴#1 同形态）。
  // 抛错后的去向由 task-loop 的剖面 A catch 分类，两类都让本轮 gitlabViewComplete=false（账目不动）：
  //   - HTTP 404/429/5xx、超时 → 源级软失败（跳过该源、其余源继续、下 tick 重试）；
  //   - 超过 DISCUSSIONS_MAX_PAGES、响应体不是数组 → 致命 die(1)：这不是运行时抖动而是数据/接口
  //     超出设计，需要人看见（调上限或清讨论）。**本函数不逐 MR 吞错**——吞掉 = 该 MR 从本轮
  //     视角消失 = 它的账目被当「触发消失」关掉，比整轮失败更糟。
  const DISCUSSIONS_MAX_PAGES = 10;
  const allDiscussions = async (path) => {
    const out = [];
    let page = 1;
    for (;;) {
      const res = await fetchImpl(`${url}/api/v4${path}?per_page=100&page=${page}`, {
        headers: { 'private-token': token },
        signal: AbortSignal.timeout(15_000),
      });
      // 非 2xx 一律抛错且信息含「HTTP <code>」，交由 runner 分类（404 多为 MR 刚被删/权限的竞态 → 软失败）。
      if (!res.ok) throw new Error(`GitLab ${path} page=${page} HTTP ${res.status}`);
      // 2xx 但不是数组（登录页 HTML、代理错误页、版本变更）——按空页处理等于「该 MR 没有任何讨论」，
      // 是最隐蔽的部分视角。res.json() 对非 JSON 会先抛 SyntaxError（信息里只有原文片段、不知道是哪个接口），
      // 所以解析也包进来：统一成一条带 path / content-type 的错误，带 content-type 便于定位是哪一层吐了非 JSON。
      const contentType = res.headers?.get?.('content-type') || '?';
      let rows;
      try {
        rows = await res.json();
      } catch (e) {
        throw new Error(`GitLab ${path} page=${page} 响应体不是合法 JSON（content-type=${contentType}）：${String(e?.message || e).slice(0, 80)}`);
      }
      if (!Array.isArray(rows)) {
        throw new Error(`GitLab ${path} page=${page} 响应体不是数组（${typeof rows}，content-type=${contentType}）`);
      }
      out.push(...rows);
      // 读不到下一页头 = 没有下一页（可选链）：老 GitLab / 代理 / 测试桩可能不带该头，
      // 此时按「已取完」处理而不是崩——崩会让整轮剖面 A 失败，为一个 MR 拖死全部。
      const next = Number(res.headers?.get?.('x-next-page'));
      if (!Number.isFinite(next) || next <= page) break;
      page = next;
      if (page > DISCUSSIONS_MAX_PAGES) {
        throw new Error(`discussions 超过 ${DISCUSSIONS_MAX_PAGES} 页仍未取完（${out.length} 条）——视角不完整，拒绝按部分结果判定：${path}`);
      }
    }
    return out;
  };

  // per_page=100（GitLab 单页上限）：列表无翻页，页大小就是 sweep 的视角边界——本人 open MR
  // 超过页大小会把最老的挤出列表，被 sweep 误判"触发消失"关账（CR 二审新发现，🔴#1 同类形态）。
  // 100 对单人已极难触顶；真触顶时的彻底解法是关账前单查 MR 状态复核（KI-3 登记）。
  const mrs = await api('/merge_requests?scope=created_by_me&state=opened&per_page=100');
  const out = [];
  out.skipped404 = 0; // 详情 404 计数（刚被关的竞态）：调用方据此落账，不无痕
  // Draft MR（2026-11-18 draft-skip，用户指令"暂时不列入修复执行腿"）：作者明示未就绪——
  // CI 红/评审意见都是预期噪声。整体不触发；已认领的由 sweep 按 drafts 集合关账（ready 后自动纳入）。
  out.drafts = new Set();
  // 在途集合（2026-11-17 ci-inflight-hold）：流水在跑/待跑的 MR。它们不是触发（没失败），
  // 但也绝不能被 sweep 当"触发消失"关账——执行器刚推的修复正跑着，此时关账=误报"已合并"。
  // 终态白名单只认 success/failed（CR 🟡#1）：其余一律在途——含 canceled/skipped（人停的，
  // 等新推送或人工处理，TTL 兜底）与未来未知状态字串（保守方向=保持账目，不误关）。
  out.inflight = new Set();
  // CI 绿集合（2026-11-18 ci-green-hold，用户指令"CI 转绿不代表完成"）：流水 success 且 MR
  // 仍 opened——CI 过关≠MR 完成，评审待修项是另一条轨道。sweep 据此把账目转"等评审"而非关账；
  // MR 合并/关闭后才真正关账（那时它离开 opened 列表，自然不在此集合）。
  out.ciGreen = new Set();
  const TERMINAL = new Set(['success', 'failed']);
  // CI 红触发（2026-11-17 ci-fail-trigger）：实测本实例列表接口**不带** head_pipeline
  // （8 条 open MR 全部空，详情接口才有），所以逐单拉一次详情。只看 failed——
  // running/pending 是未出结果，success/passed 不是失败，canceled 不当失败（人主动停的）。
  // CR 🔴#2：详情是 CI 触发的**在场判据**，不许 optional 吞错——瞬断必须 rethrow 走整源
  // 软失败（本轮视角不完整 → sweep 不动账）；只有 404（MR 恰好刚被关/合并）按"该单不在了"
  // 跳过，下一轮列表自然没有它。吞错会让"本轮看不见"伪装成"触发消失"→ sweep 误关账。
  // （2026-11-27 ci-trigger-masked）：从「无评审信号」分支抽出供两路共用——站桩评审信号
  // 曾把 CI 分支整个遮住（见下方回补注释）。
  const ciTrigger = async (mr) => {
    const base = `/projects/${mr.project_id}/merge_requests/${mr.iid}`;
    let detail = null;
    try {
      detail = await api(base);
    } catch (e) {
      if (/HTTP 404/.test(String(e?.message || e))) { out.skipped404 += 1; return null; }
      throw e;
    }
    if (skipDrafts && isDraftMr(detail)) { out.drafts.add(`mr-${mr.iid}`); return null; } // 列表缺字段的同款教训：详情的 work_in_progress 才权威
    const hp = detail?.head_pipeline;
    if (!hp || !TERMINAL.has(hp.status)) out.inflight.add(`mr-${mr.iid}`); // 无流水（推送→创建的秒级窗口）同样保持
    if (hp && hp.status === 'success') out.ciGreen.add(`mr-${mr.iid}`);
    if (hp && hp.status === 'failed') {
      return { kind: 'mr', id: mr.iid, mr: { ...mr, target_branch: detail?.target_branch || mr.target_branch }, unresolved: [], comments: [], reviewState: 'ci_failed', signal: 'ci_pipeline', ci: { pipelineId: hp.id, status: hp.status, webUrl: hp.web_url } };
    }
    return null;
  };
  for (const mr of mrs) {
    if (mrFilter && String(mr.iid) !== String(mrFilter)) continue;
    if (skipDrafts && isDraftMr(mr)) { out.drafts.add(`mr-${mr.iid}`); continue; }
    const base = `/projects/${mr.project_id}/merge_requests/${mr.iid}`;
    const rawDiscs = await allDiscussions(`${base}/discussions`);
    // fixSuggestions=false：建议性评论（非阻断）整体退出触发判定与修复范围——
    // 纯建议的结论评论不再触发（无活儿）。注意：保留 🔴 评论只影响『是否成为待修内容』，
    // 触发信号仍需三路之一（resolvable 线程/新鲜动词/带结论词的评论）——裸 🔴 评论不构成触发（CR 🟡#2）。
    const discs = fixSuggestions ? rawDiscs : filterSuggestionNotes(rawDiscs);
    // 先粗判：既无他人未解决意见、也无打回动词，就不必再打审批与 commit 两个接口（20 条 MR 的轮询要省在热路径上）。
    // 动词必须进粗筛：评审者用普通评论 + requested changes 表态时没有任何 resolvable 讨论
    // （2026-11-16 MR !1882 实测），只按未解决意见筛会把打回的 MR 在 classifyMr 之前就 continue 掉。
    const hasReviewSignal = unresolvedByOthers(discs, username).length > 0
      || !!changesRequestedAt(discs, username)
      || !!reviewVerdictCommentAt(discs, username); // 结论评论形态必须进粗筛，否则 classifyMr 之前就被 continue 掉（!1916 R2 实测）
    if (!hasReviewSignal) {
      // 第二路信号（2026-11-17 ci-fail-trigger）：CI 红。只看 failed 终态（见 ciTrigger 注释）。
      // API 成本：每轮 = 无打回证据的 open MR 数 × 1 次详情调用；评审信号站桩但触发已死的
      // MR 在下方回补处也补一次（节拍 1800s 下可忽略）。
      const t = await ciTrigger(mr);
      if (t) out.push(t);
      continue;
    }
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
    if (!r.triggered) {
      // 评审信号站桩但触发已死（动词早于最后 push=已被推送核销、意见已 resolve）≠ CI 路也不看——
      // 两路信号独立：站桩信号把 CI 分支整个遮住，会造成「评审已核销 + 流水失败终态」的 MR
      // 双路皆哑（!1847 2026-11-27 实测：R4 推送核销动词后 head pipeline failed 近两小时，
      // triggers 恒 0，无工单无修复）。评审路不响时补走 CI 路：归因层区分 introduced/inherited，
      // 基线同款仍会 inherited_only 不误修；活动词仍评审优先（上方已 push 并 continue）。
      const t = await ciTrigger(mr);
      if (t) out.push(t);
      continue;
    }
    // 只带"活评审"：晚于最后一次 push 的评论才是本轮回复审的意见（!1916 实测 R1 结论在推送前、
    // R2 在推送后——R1 已被 round-1 修复核销，混进工单会让执行器重做已核销项）
    const liveComments = reviewCommentsByOthers(discs, username).filter((c) => !lastPushAt || !c.createdAt || new Date(c.createdAt) > new Date(lastPushAt));
    // 建议性评论是修复范围的输入，跟触发证据一起进 payload（用户指令 2026-11-16：
    // 即便评审人不逐条回复/resolve，审核意见里的建议修改项也纳入接单修复范围）。
    out.push({ kind: 'mr', id: mr.iid, mr, unresolved: r.unresolved, comments: liveComments, reviewState: r.reviewState, signal: r.signal, approval: r.approval });
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
  // CI 形态（2026-11-17 ci-fail-trigger）：以失败流水为身份——新 commit/重跑产生新 pipeline
  // 即内容变化（重认领重归因）；同一条流水重复轮询不重认领。内容级的指纹去重在认领时做。
  if (t.ci) return `ci:${t.ci.pipelineId}`;
  const parts = [
    ...(t.unresolved || []).flatMap((d) => (d.notes || [])
      .filter((n) => n.resolvable && !n.resolved)
      .map((n) => `d${d.id}n${n.id}`)),
    ...(t.comments || []).map((c) => `c${c.id ?? c.note}`),
  ].sort();
  return parts.length ? parts.join(',') : 'empty';
}
