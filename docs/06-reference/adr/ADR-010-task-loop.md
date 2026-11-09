# ADR-010：task-loop 本地循环执行器的七项架构裁决

> 关联：`docs/01-requirements/RS-task-loop.md` · 会话定稿 v2（2026-11-09 技术评审后）。

## 1 背景

MR 打回修复与 bug 自动接单两场景需要跨小时的循环（等 CI、等人审、失败换法重试）。评审确认：仓库全域无锁原语（flock/O_EXCL 零命中）、`--related` 字符集不含冒号、`runtime.spawn_*` 零消费者、escalate/aging 零存量——以下裁决在此基础上做出。

## 2 裁决（候选对比）

### D1 触发拓扑：拉不推（vs broker 派活 / 中央调度器）

| 候选 | 否决理由 |
|---|---|
| broker 推送到开发机 | 笔记本 NAT/休眠，推不可达；新增入站攻击面 |
| 中央 tick/worker（Apse 拓扑） | 常驻调度器成为第二状态源，与"git 唯一序列化点"冲突 |
| **本地 runner 轮询（采纳）** | 开发机访问 GitLab 是刚需，拉模型零入站；轮询是零成本 API 调用不进 agent |

### D2 跨机互斥：git 引用 CAS（vs 本地锁 / GitLab label）

本地锁跨机器无效；label/assignee 的 PUT 不是 CAS（两个都成功，最后赢）。**采纳**：`git push origin <sha>:refs/heads/claims/<kind>-<id>`——非快进拒绝即认领失败，服务端原子（评审修正：自定义 `refs/claims/*` 命名空间 GitLab 会拒收，落 heads/ 斜杠分支）。认领落 claim 事件、带 TTL；僵尸认领按 blocked 升级——MR 被锁死比没人认领更坏。

### D3 停点定义：引入失败为 0 + 人审有效（vs 字面全绿）

主干存量红（实测连红两天）会让"全绿"永不可达，逼出两种坏行为：死循环或硬修别人的红。**采纳**：归因后"本 MR 引入的失败 = 0"（含 `step:doctor` 等非测试步骤类，指纹同套归一化），叠加人审三条件（approved_by 非空、approver ≠ author、审批晚于最后 push——新 commit 清空 approve 是实测行为）。

### D4 豁免与重跑：三道闸（vs 信任归因器）

"基线豁免 + flaky 重跑"组合在主干红时等于通用通行证。**采纳**：豁免仅对断言指纹相同失败生效 + owner + 到期日自动失效；重跑翻转必须落 `flaky:<套件>/<用例>` 事件并强制开 issue；豁免率进度量、超阈值视为门禁退化告警。豁免必须是有成本的。

### D5 CI 归因：merge-base 实跑（vs 读 main 上次日志）

main 的历史日志对应旧 commit 且可能就是存量红本身。**采纳**：基线在 merge-base 上实跑（gate 全量 4-8 分钟已计入工期），失败集合做差；flaky 先重跑一次、两次同错才当真。

### D6 spawn 配置：新键 `runtime.headless`（vs 复用 `runtime.spawn_*`）

`spawn_agents/shell/ask_user` 语义是宿主会话能力声明（给 orchestrator 自检），拿它当 runner 启动参数混淆"我是谁"与"怎么起进程"。**采纳**：新键 `runtime.headless`（CLI、模型档、权限模式）；headless 会话 **hook 必接线**（wiring 断言进 T3 验收——不接 hook 的 headless agent 是绕过全部写入门禁的 agent）。

### D7 预算：可观测才硬限（vs 全维度硬限）

agent 会话的 token 未必可观测，"token 预算"不写数据源就是装饰。**采纳**：活动墙钟 + 轮次为硬限；tokens 仅在可观测处（ai-review usage、CLI headless usage 输出）计入；等待 CI/人审不计墙钟（pause/resume 事件界定活动区间）；停机判断在 runner 层（checklist #37）。

## 3 代价与风险

- 基线实跑使每次归因多一次全量 gate（4-8 分钟）——已计入 T4a 工期，CI 资源由 K1 准入保证。
- 认领分支会积累在 `refs/heads/claims/` 下——TTL 过期即删，retro 观察增长速率。
- heads/claims 斜杠分支可能被人误 checkout——命名即文档，wiring/doctor 提示。

## 4 何时 revisit

- 飞书项目 OpenAPI 提供可靠 webhook 后，剖面 B 触发可从轮询升级事件（拉不推不变，只是轮询变通知）。
- GitLab 原生 MR approval rules 可用后（版本升级），人审三条件的机器校验从 API 比对升级为合并闸。
- tokens 全链路可观测后，预算升级三维硬限。
