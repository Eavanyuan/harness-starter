/**
 * task-loop 纯函数核心（T3）—— 无顶层副作用，可被 runner 与测试安全 import。
 *
 * 为什么从 task-loop.mjs 拆出：runner 薄壳有 process.exit（kill switch 等），
 * export 混在里面的"纯函数"import 即执行整个脚本——测试挂、消费者遭殃。
 * 分层：本文件 = 判据（预算/审批/认领键）；task-loop.mjs = 编排（轮询/认领/落盘）。
 */

/**
 * 预算（ADR D7 口径）：活动墙钟 + 轮次为硬限，tokens 仅可观测处计。
 * start/resume 之间计时，pause 止计——等 CI 与人审不计墙钟（Apse 墙钟语义）。
 */
export function createBudget({ maxRounds = 3, maxActiveMs = 30 * 60_000, now = Date.now } = {}) {
  let activeMs = 0;
  let lastStart = null;
  let rounds = 0;
  return {
    start() { lastStart = now(); },
    pause() { if (lastStart != null) { activeMs += now() - lastStart; lastStart = null; } },
    resume() { if (lastStart == null) lastStart = now(); },
    spendRound() { rounds += 1; },
    exhausted() {
      const active = activeMs + (lastStart != null ? now() - lastStart : 0);
      return rounds >= maxRounds || active > maxActiveMs;
    },
    snapshot() { return { rounds, activeMs: activeMs + (lastStart != null ? now() - lastStart : 0), maxRounds }; },
  };
}

/**
 * 审批三条件（停点判据，ADR D3）：
 * approved_by 非空（新 commit 清空 approve 是实测行为）、approver ≠ author、
 * 审批晚于最后一次 push（陈批不算）。缺时间数据按"无法判定"拒绝——不猜（判不了的明说不判）。
 */
export function approvalValid({ approvers, author, lastPushAt, approvedAt }) {
  const names = (approvers || []).map((a) => a.username || a?.user?.username).filter(Boolean);
  if (names.length === 0) return { ok: false, reason: 'approved_by 为空——无人批红' };
  if (author && names.includes(author)) return { ok: false, reason: `approver 含 author 本人（${author}）——自批不算` };
  if (lastPushAt != null && approvedAt != null && !(new Date(approvedAt) > new Date(lastPushAt))) {
    return { ok: false, reason: '审批早于最后一次 push——新 commit 会清空 approve，此为陈批' };
  }
  if (lastPushAt != null && approvedAt == null) return { ok: false, reason: '无法判定审批时间（approvedAt 缺失）——按不通过处理' };
  return { ok: true, reason: `有效批红：${names.join('、')}` };
}
