# RS-演练缺口修复

> 任务：`.ai/tasks/drill-gaps-fix/state.json`（S 档）。来源：本地 GitLab 全流程演练报告（B1/B2/B3/G1/G2）。

## 1 背景与痛点

真 GitLab 演练实证四个缺口：代码文件落在 cr 路由槽外时**静默缺席零提示**（MR !4 只路由到 evidence）；
无 runner、批准规则配不出时**无人检查门禁在不在线**（失败证据畅通进 MR、未批准可合并）；
FS 变更不被任何审核类型接住（规格审全靠人）；无模型 key 时"AI 审核"悄悄降级为机器判据而无口径说明。

## 2 用户故事

### US-1 缺席要可见

- **作为**：流程维护者
- **我希望**：diff 里的代码文件不属于任何审核槽时，router 明确报告并记账
- **以便**：静默缺席变成可见缺席，而不是"看起来有审核"

**验收标准**

- Given 配置了 projects=backend 的仓库 When 路由含 tools/x.mjs 的变更 Then stdout JSON 含该文件于 uncovered，stderr 有提示，账本记 uncovered_code 事件，退出码仍 0（可见不阻断）
- Given 未命中代码扩展名的文件（如 README2.md）落槽外 Then 不进 uncovered（不误报）

### US-2 门禁在场性可体检

- **作为**：落地执行者
- **我希望**：doctor 能检查 CI runner 与 MR 批准规则是否在场
- **以便**：落地时就知道 B1/B2 这类断点，而不是等事故发现

**验收标准**

- Given 未提供 GitLab 连接信息 When 跑 doctor Then 两项在场性检查以提醒形式列出（未检查 ≠ 通过）
- Given 提供连接且活跃 runner 为 0 When 跑 doctor Then 报阻塞并退出码非 0

## 3 核心需求

| 编号 | 需求 | 优先级 | 来源 |
|---|---|---|---|
| R-1 | route() 返回 uncovered；router 提示 + uncovered_code 入账；broker mr_routed 带 uncovered 计数 | P0 | G1/演练 MR!4 |
| R-2 | harness.rules.json 增 code_hints 扩展名清单（策略进数据不进代码） | P0 | G1 |
| R-3 | fs 审核类型：paths + fs_required_sections 机器判据（红）+ scripts/reviews/fs.md 清单 | P0 | B3/演练 MR!3 |
| R-4 | doctor 增门禁在场性两项（env 可选连接；未配=提醒，缺 runner=阻塞；approval 不支持=说明性提醒） | P0 | B1/B2 |
| R-5 | guides 写明无 key 降级口径与 API 驱动工作流姿势 | P1 | G2/F1 |

## 4 非功能约束

零依赖；不新增配置键（连接走 env，避免空转键）；可见化不新增阻断路径。

## 5 范围外

verdict 自动回投 MR（等 runner）；pre-receive 拦截；FS 语义审的 AI 分支（留有 key 环境）。

## 6 术语表

- **无槽可见化**：代码文件不属于任何审核槽时列入 uncovered 并记账——可见缺席，不新增阻断。
- **门禁在场性**：doctor 对 CI runner、MR 批准规则"在不在线"的体检；未检查 ≠ 通过。

## 7 开放问题

| 编号 | 问题 | 状态 |
|---|---|---|
| OP-1 | approval rules 不可用的 GitLab 上是否要在 doctor 报阻塞 | 已定：提醒不阻塞（版本能力差异不是配置错误） |
