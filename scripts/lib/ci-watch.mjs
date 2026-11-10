/**
 * CI 盯梢（T5）—— 零 LLM 的 pipeline 状态轮询。
 *
 * 会话在等 CI 期间不存在（省 token + 会话撑不起等待），盯梢是纯 API 轮询；
 * 预算语义联动（ADR D7）：等待期间 runner 调 budget.pause()——等待不占活动墙钟。
 *
 * 判定：取 MR 最新 pipeline 的终态。超时不是失败也不是通过——返回 'timeout' 交上层
 * 按"无法判定"升级（判不了的明说不判）；flaky 重试不在这一层（T4b 的 flippyFailures 管）。
 */
export async function watchPipeline({
  listPipelines,
  timeoutMs = 45 * 60_000,
  intervalMs = 30_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  startedAt = Date.now(),
}) {
  const deadline = startedAt + timeoutMs;
  for (;;) {
    const pipes = await listPipelines();
    const latest = Array.isArray(pipes) && pipes[0];
    if (latest && ['success', 'failed', 'canceled', 'skipped'].includes(latest.status)) {
      return { status: latest.status, sha: latest.sha, waitedMs: Date.now() - startedAt };
    }
    if (Date.now() >= deadline) {
      return { status: 'timeout', sha: latest?.sha, waitedMs: Date.now() - startedAt };
    }
    await sleep(Math.min(intervalMs, Math.max(deadline - Date.now(), 0)));
  }
}
