# CR 代码审查记录 — ci-trigger-masked：站桩评审信号不得遮蔽 CI 红

- 审查范围：本地未提交 diff（基线 35a6291，任务 `ci-trigger-masked`，S 档 bugfix，来源任务 `ci-fail-trigger`）
- 关联 RS：`docs/01-requirements/RS-ci-fail-trigger.md`（US-1 验收行同批修正）
- **已加载的 skill**：`resolve-skills --diff` 命中 harness（H1–H9）与 deployment（坑清单 #57 同批入库）
- 验证阶梯：真实事件复现（!1847 实测 + `fetchTriggers` 活体探针）→ 回归三态先红后绿 → 变异一击 → CTM1/CTM2 证据日志 → CLOSE-GATE 全量

## 0 硬规则逐条核（harness skill H1–H9）

| # | 规则 | 检测命令 / 方式 | 结果 |
|---|---|---|---|
| H1 | 改 scripts/** 必须同批有测试 | scripts 改 1 个，test/task-loop.test.sh 同批新增 5c-quater 三态回归（先红后绿） | ✅ |
| H2 | 生成物禁止手改 | 未触碰 `.claude/`、`.zcode/`、`prompts/`；gate 的 check:agents/check:hooks 覆盖 | ✅ |
| H3 | 解析失败必须 fail-closed | `ciTrigger` 抽出后 404→skip404、其余错误 rethrow 整源软失败的语义逐字保留；未新增任何 optional 吞错 | ✅ |
| H4 | 保护名单不进代码 | 本批未新增名单字面量 | 不适用 |
| H5 | skill 结构 | 未动 Stage 0；`npm run check:skills` 在 gate 覆盖 | ✅ |
| H6 | 新增拦截规则须带合法绕过 | 未新增拦截（回补让"有评审信号的 MR"补走 CI，是放宽触发可见性） | 不适用 |
| H7 | hook 双 CLI 接线 | 未动 hooks | 不适用 |
| H8 | 配置键有消费者 | 无新配置键 | 不适用 |
| H9 | 断言可证伪 + 变异 | 变异：评审路回补 `await ciTrigger(mr)` → `null`，套件 155→154 通过（1 失败，红在钉住用例"dead-verb-failed→ci-trigger"）；修复后 155/0 | ✅ |

deployment skill 附注：本缺陷的元教训入库为坑清单 **#57**（互斥信号路会让站桩信号遮蔽另一路；组合态回归用例是唯一能抓住遮蔽的形态），计数五处同步、行序校验过。

## 1 改动摘要

`fetchTriggers` 的两路信号（评审 / CI 红）此前互斥：MR 上只要有站桩评审信号（他人 requested-changes 动词等），CI 分支整个被跳过；而评审触发有自己的死亡条件（动词早于最后 push = 已被推送核销）。两条件叠加 = 「评审已核销 + 流水失败终态」的 MR 双路皆哑——!1847 实测：R4 推送（b07be28328）核销动词后，新 head pipeline 90239（e2e-test zh/en + api-test-coverage-merge 失败）挂了近两小时，task-loop 每拍 `gitlab_polled triggers: 0`，无工单无修复。修复：把 CI 分支抽成 `ciTrigger(mr)` 助手供两路共用——无评审信号走主管；评审路 classifyMr 不触发时**回补**同判（归因层区分 introduced/inherited，基线同款 inherited_only 不误修；流水 running → inflight 保账）；活动词仍评审优先不双触发。

## 2 阻断项 🔴

| # | 位置 | 问题 | 依据 | 处置 |
|---|---|---|---|---|
| （本轮无新增阻断——被修的正是上一轮独立发现的缺陷本身） | | | | |

缺陷定级：🔴（CI 红不过夜的承诺在「评审核销后新流水又红」这一常见形态下完全失效；且全程静默——idle 日志只说"无 working 工单"，无人能从日志看出遮蔽）。

## 3 建议项 🟡

| # | 问题 | 处置 |
|---|---|---|
| 1 | RS US-1 验收行把「无打回证据」写进前置条件——验收行本身把缺陷固化成了规格 | 同批修正验收行（站桩但触发不成立时同样判），FS 第三形态段与变异矩阵行同步 |
| 2 | 排障过程中发现的测试夹具写法陷阱：fake discussions 多包一层 `notes` 时，粗筛看不到任何评审信号、用例反而全绿（本轮实际踩中，靠逐分支插桩才定位） | 已在回归用例的 fake 中按 GitLab 真实形态单层展开；教训并入 #57 的"组合态用例"条目 |

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| scripts/task-loop.mjs（认领/归因/sweep） | 兼容：新增的 ci_pipeline 触发走既有归因路径 | 套件 155/0 含归因/inherited_only/needs_human 全部既有用例 |
| sweep 关账 | 更安全：站桩+running 的 MR 现在进 inflight 集合，不再可能被误判"触发消失" | 三态用例第 2 态钉住 |
| 活动词评审优先序 | 不变：活动词仍出 review_verb 且只有一条 | 三态用例第 3 态钉住 |
| 真实 !1847 | 已接上 | 修复后 `fetchTriggers`（真实凭据、mrFilter=1847）→ `triggers: 1, signal: ci_pipeline, pipelineId 90239` |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入 | 无新拼接面：详情 URL 与原 CI 分支逐字一致 |
| 越权 | 只读 GitLab GET（MR 列表/讨论/详情），token 走既有 env-file 通道 |
| 敏感信息 | 无凭据落盘；trace 拉取仍由 runner 代存（执行器无凭据） |
| 依赖变更 | 无 |

## 6 测试覆盖

- 回归三态：死动词+failed → ci_pipeline（核）；死动词+running → inflight 保账；活动词+failed → 评审优先且单条
- 全套件 155/0（含既有 动词五形态/结论评论九形态/inherited_only/needs_human 升级/ci_green_hold 等无回归）
- 变异：去回补 → 154/1，红在钉住用例
- 活体验证：真实 GitLab + !1847 数据，修复前 `triggers: 0`（复现）→ 修复后 `triggers: 1`（接上）

## 7 结论与遗留

🟡 0 未表态，🔴 0 未修 → **通过**。遗留两点如实交底：①E01（公共事业节点找不到）根因仍未知——回补后 1847 会被接住开工单，但归因若判 introduced，修复腿面对的还是那个没查明的 e2e 失败，可能按 maxRounds 升级给人（那是设计内行为，不是本修复的缺陷）；②评审优先序意味着活动词 + CI 红并存时先修评审项、CI 红等下一轮（与既有设计一致，未改）。
