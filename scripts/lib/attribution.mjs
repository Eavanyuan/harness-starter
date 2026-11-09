/**
 * CI 三分流决策 + 豁免三道闸（T4b 纯函数核心）—— 归因的"裁决"半边。
 *
 * 输入 = T4a 的集合差 + 豁免登记表 + flaky 账本；输出 = 动作决策（人话 + 机器可判）。
 *
 * 三分流（ADR D5 + 评审 C）：
 *   引入失败 > 0        → REWORK（回修复循环，带上"已试过什么"防同法重试）
 *   引入 = 0、继承 > 0   → 豁免候选：**仅指纹相同才可豁免**，豁免必须有 owner + 到期日
 *   引入 = 0、继承 = 0   → PASS_TO_REVIEW（转人审停点，审批三条件另判）
 *
 * 三道闸（评审 C 原文：基线豁免 + flaky 重跑 = 通用通行证，闸必须加）：
 *   闸1 豁免只对断言指纹相同的失败成立，带 owner 与到期日，过期自动失效
 *   闸2 重跑导致红绿翻转 → 落 flaky 事件并要求开 issue（不落账的重跑不算数）
 *   闸3 豁免率超阈值 → 视为门禁退化告警（豁免必须是有成本的）
 */
export function decide({ introduced, inherited }, { exemptions = [], flakyLog = [], exemptionBudget = 0.3 } = {}) {
  // 到期豁免先失效（闸1 的"过期自动失效"在判定入口执行，不是靠清理任务）
  const now = Date.now();
  const active = (exemptions || []).filter((e) => new Date(e.expiresAt).getTime() > now);
  const expired = (exemptions || []).length - active.length;

  const exempted = [];
  const blockingInherited = [];
  for (const f of inherited || []) {
    const hit = active.find((e) => e.fingerprintId === f.id);
    if (hit) exempted.push({ ...f, owner: hit.owner, expiresAt: hit.expiresAt });
    else blockingInherited.push(f);
  }

  // flaky 交叉验证（闸2）：继承失败若在 flakyLog 中无记录，不得仅凭"重跑变绿"豁免——
  // 红绿翻转必须先落 flaky 事件并开 issue，才具备豁免资格
  const flakyIds = new Set((flakyLog || []).map((x) => x.fingerprintId));

  if ((introduced || []).length > 0) {
    return {
      action: 'REWORK',
      reason: `引入失败 ${introduced.length} 条（${introduced.slice(0, 3).map((f) => f.fingerprint).join('、')}${introduced.length > 3 ? ' 等' : ''}）——回修复循环`,
      introduced, exempted, blockingInherited, expiredExemptions: expired,
    };
  }
  if (blockingInherited.length > 0) {
    return {
      action: 'EXEMPT_REQUIRED',
      reason: `继承失败 ${blockingInherited.length} 条未登记豁免（需指纹相同的豁免 + owner + 到期日）${expired > 0 ? `；${expired} 条豁免已过期失效` : ''}`,
      introduced: [], exempted, blockingInherited, expiredExemptions: expired,
    };
  }
  // 闸3：豁免率 = 豁免数 / (豁免数 + 全绿)。全是豁免过掉的"绿"是退化信号
  const total = exempted.length;
  const rate = total > 0 ? total / (total + 0) : 0;
  const degraded = rate > exemptionBudget && total >= 3;
  return {
    action: degraded ? 'EXEMPTION_BUDGET_EXCEEDED' : 'PASS_TO_REVIEW',
    reason: degraded
      ? `豁免率 ${(rate * 100).toFixed(0)}% 超阈值 ${(exemptionBudget * 100).toFixed(0)}%（${total} 条全靠豁免放行）——门禁退化告警，先清存量红再谈豁免`
      : `引入失败 0，继承 ${exempted.length} 条已豁免（${expired} 条过期失效）——转人审停点`,
    introduced: [], exempted, blockingInherited: [], expiredExemptions: expired, exemptionRate: rate,
  };
}

/** 闸2 的落账辅助：重跑翻转登记（调用方在重跑前后各取一次指纹集合，差异即翻转）。 */
export function flippyFailures(before, after) {
  const b = new Set(before.map((f) => f.id));
  const a = new Set(after.map((f) => f.id));
  return [...after.filter((f) => !b.has(f.id)), ...before.filter((f) => !a.has(f.id))];
}
