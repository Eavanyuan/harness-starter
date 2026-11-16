# local-cr-gate：本地 CR→修复循环门禁（2026-11-16）

> 任务：`.ai/tasks/local-cr-gate/state.json`（S 档 feature）。
> 需求源：用户设计讨论——"写完代码在本地跑 CR→修复循环，减少 CI 被打回的可能"。

## 方案定稿（分层渐进 + 预算）

| 层 | 谁跑 | 触发条件 | 成本 |
|---|---|---|---|
| L0 机器判据 | coder 收尾必跑（= verify-run） | 所有任务 | 零 |
| **L1 AI 语义审** | **coder 收尾跑 ai-review --type cr --base** | risk_tier ≥ MEDIUM | 1 次模型调用 |
| L2 CI 兜底 | GitLab | 所有 MR | 已有 |

**循环预算 3 轮**：第 1-2 轮 CR 出红→修→重跑；第 3 轮仍红→升级 human_decision blocker。
**禁止自审**：coder 不得在本会话里"看看自己写的代码"——同上下文=盲区一致的白审；
CR 的判断来自 ai-review 脚本（读 git diff + 规则，会话上下文完全隔离）。

## 落地内容

1. **M3 修复**：`ai-review --type cr --machine-only` 空壳绿灯→exit 2 拒绝
   （cr 类型 machine_checks=[]，零检查产出 exit 0 "通过"会喂饱下游"verdict 存在"校验）
2. **coder.agent.md 步骤 7**：本地 CR→修复循环（按 risk_tier 分层；≤3 轮；禁自审；
   退出条件硬绑 CR verdict 存在且红=0 或记名 waive）
3. **orchestrator.agent.md C2**：review 阶段"必须调度 code-reviewer 子 agent"
   （不是自审，不是让 coder 自审）
4. **C1 目录口径**：`.ai/review/`（agent 正式 CR 记录，给人看）与 `.ai/reviews/`
   （ai-review 自动 verdict 缓存，给门禁读）——CR 模板头注明区别
5. 生成物已重建（check:agents 68 一致、check:hooks 一致）

## 验证

test:ai-review 34→36（M3 两断言：cr+machine-only exit 2 / rs+machine-only 仍可用）；
test:agents 通过（coder agent 变更后生成物一致）。
