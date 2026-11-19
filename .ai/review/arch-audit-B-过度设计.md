# 架构体检 B：过度设计审计（arch-audit-B-过度设计）

- 日期：2026-11-19 · 范围：scripts/（21 文件 + lib 27 文件）、.ai/task-loop/、.ai/verify/、.ai/ledger/、.ai/tasks/（32 任务）、agents/、.skills/、harness.rules.json、deploy/、test/（28 套件）、.git/logs/HEAD（141 提交全量）
- 方法：消费者检索用全仓 grep import/调用点；使用频率用仓库账本（.ai/ledger/events.jsonl 逐行）+ git reflog 时间戳 + 产物目录清点；维护成本用文件数/套件数/证据刷新提交数。用户级账本 ~/.harness/task-loop 在工作区外不可读，涉及处降档标注。
- 判据三件套：**生产消费者数**（测试不算）/ **真实使用频率**（账本·git·产物可证）/ **维护成本**（每次 gate/每批提交要付的部分）。

## 总判：过度设计指数 7/10

核心链路（state 门禁、verify 证据链、claim CAS、轮次协议、CI-红触发）真实高频使用且有战果（4 个 MR 会话 17 轮、断连恢复实测）；但外围四族——通知 broker 族、审核自动化 L1 层、ADR-010 前瞻机制（影子周/预算硬限/豁免三道闸）、协议空壳族 + 零出场 agent + 154 份日志——按“多机多人多仓”设计、按“单人单机单目标仓”使用。28 个测试套件中约 9 个守护的是零生产事件路径。

## 🔴 应删（3 条）

| # | 对象 | 判据 | 处置 |
|---|---|---|---|
| R1 | `scripts/lib/attribution.mjs` | 消费者：生产 0，全仓唯一 import 是 test/task-loop.test.sh:1683；频率：0（2b3945a 11-09 引入起）；维护：CR-2026-11-17-两日提交审核:48 已判“读者会以为归因走 decide()，实际走 ci-failures.mjs:156 的 attributeCi”——死码承载活语义 | **删**（连同测试段）。1a5cc95 内联实现已永久取代。确定 |
| R2 | `scripts/lib/baseline.mjs` | 消费者：生产 0（唯一 import test:1660）；取代者：目标分支流水基线（1a5cc95，11-17）；ADR-010 D5“merge-base 实跑”设计已演进但 ADR 未回写 | **删** + ADR-010 D5 补一行实现演进注记。确定 |
| R3 | `scripts/lib/ci-watch.mjs` | 消费者：生产 0（唯一 import test:1750）；文件头 ：5 还写着“预算语义联动 budget.pause()”——死码里躺着活设计的说明书 | **删**。确定 |

## 🟡 应简化/冻结（7 条）

| # | 对象 | 判据 | 处置 |
|---|---|---|---|
| Y1 | **broker 通知族**：harness-broker.mjs + lib/{feishu-ws 挂靠、decision-from-git、subscriptions、notify、ws-client、feishu-frame} | 消费者：生产成功事件 0——账本全量仅 1 条 broker 事件（11-06 decision_writeback_failed，目标 URL 是无效相对路径，疑似演练残留）；订阅三档 persons={}（harness.rules.json）零订阅者；K2：目标 GitLab 无 runner（tda-server-落地可行性评估.md:61），GitLab 边物理不可达。频率：CI 每 PR 跑，生产 0。维护：~7 文件 + 28 套件中 6 个（notify-broker/feishu-ws/feishu-oauth/feishu-bug-source/feishu-sync/feishu-ask）主要守护它 | **冻结**（代码+测试保留、停新特性；TDC 装 runner 后解冻）。高置信 |
| Y2 | **审核自动化 L1**：review-router.mjs + ai-review.mjs cr 档 | router 生产调用点 0（全仓 grep：仅自身头注释与测试）；ai-review 账本仅 3 次（11-06 rs、11-08 fs×2 机器拦截），local-cr-gate（11-16 aa877f9）后 ≥5 个 MEDIUM 任务关闭而 cr 档事件为 0——“必跑”只写在 coder.agent.md 散文，无 hook 强制。维护：2 文件 + 2 套件 + 规则文件 + 指南口径 | **降级二选一**：把 ai-review cr 档做进 close/gate 的机械步骤，或从 agent 散文撤回承诺。router 冻结至 GitLab CI 接线。确定（账本逐行核对） |
| Y3 | **影子周**：shadow.jsonl/--dry-run/--report（task-loop.mjs:325/334/336） | 消费者：0；频率：0——find 全仓无 shadow.jsonl，git 无影子周报告提交。维护已实际发生：mr-verb-trigger CR-2026-11-16:40 因展示面漏改返工 | **降级**为一次性演练说明，或删统计代码只留 dry-run 文案。确定 |
| Y4 | **预算硬限**（D7：task-loop-core.mjs:13-26 + runtime.budget） | 接线在用（task-loop.mjs:603-608/664-666/769），但旗舰会话 1847 实跑 **7 轮 > maxRounds=3**，且 ：435 注释自认“误关账释放认领即清零 budget——断连→恢复循环可反复绕过 maxRounds”；账本无 budget 事件类型。另与 local-cr-gate 的“3 轮预算”同名异义（CR 补录 🟡4 点名混淆） | **降级**：硬限改口径为观测+告警；绕过路径要么堵要么写进 ADR 风险节。高置信（用户级账本未读，若其中有 budget 事件串则退回“保留”） |
| Y5 | **resolves-*.json 协议族** + pack 低频 + 双存放位 | resolves 3/3 份内容全为 `[]`（1847/1916/1935）——关账决议族从未携带过一条决议，真实关账走 acks/ack+结评；pack 仅 1/4 会话落盘（pack-1896.md，11-16“认领即落盘”规则后）；session-1896/ 与顶层 round-1-1896.md 并存——同一会话两套存放位 | 协议**收敛为 4 族**（round/todo/acks/ack），resolves 并入 acks 终态字段；session 子目录口径统一。确定 |
| Y6 | **.ai/verify 日志策略**（154 份永久入库） | ci-verify 的 CI 口径要求日志入库（设计要求，非意外），但重复度：CLOSE-GATE-* 17 份 gate 全量、REVIEW-FIX-2..12 13 份连续修复轮、CG/CF/TL/RV/DOCGATE 系列多为证据刷新重跑——reflog ≥8 笔提交纯为“源码变了证据过期”重跑（DOCGATE-V1/T0/DFG×2/M1/DF/RV6/RV7） | **降级**：gate 全量留摘要+断言计数，全量日志滚动保留最近 K 份；修复轮合并为一份滚动文件。高置信 |
| Y7 | **agents 5/12 零出场**：spec-writer / interaction-prototyper / test-engineer / retro-ledger / architect | 32 任务 state.json 的 stage_history.agent 全量 grep，只出现过 orchestrator/coder/code-reviewer/requirement-analyst(5)/tech-selector(2)/spec-reviewer(2)/feature-decomposer(2)/ci-verify；上述 5 个 141 提交零出场（architect 11-17 落地可给观察期）。M 档全链仅 task-loop 等 2-3 任务走过 | **用户纠正（2026-11-19）**：agents 保留完整流程定义全集，不按项目用量裁剪——Y7 此条判定作废，12 个 agent 全留 |

## 🟢 合理但闲置（3 条）

| # | 对象 | 判据 | 处置 |
|---|---|---|---|
| G1 | architect-check.mjs + fitness functions | 消费者：gate 第 2 环（package.json architect），每次本地 gate 都跑；闲置面在 CI（quality-gate.yml 无此步，PR 不拦）。F5 趋势在 .ai/perf 积累 | 保留；可选挪进 CI |
| G2 | lib/analyzer.mjs（962 行） | 消费者 5：build-agents:16、doctor:67、cli/analyze、cli/init、cli/shared | 保留（拆分是代码健康议题，非过度设计） |
| G3 | .skills 的 backend/frontend/e2e | 旁挂模式（2026-11-14）指向 ../TDasset；task-loop 真实轮次确在修 tda-server（round-1-1935 有 mvn 53/53、vitest 22/22 痕迹），但 skill 在 headless 轮是否被加载无直接记录 | 保留（观察期）；deployment skill 消费记录未验 |

## 必查面逐项结论

**① 零消费者 lib 夏核**：三 lib 死码成立（证据见 R1-R3）。同类排查：analyzer 活（5 消费者）、architect-check 活（gate）、harness-cli 活（bin/init/doctor/close）；broker 族 7 文件全部“接线活、生产死”（Y1）；review-router 零生产调用（Y2）。CR-2026-11-17“harness-broker/subscriptions 非死代码”的判断在**测试接线**意义上成立，在**生产事件**意义上不成立——两个口径都成立，结论取决于把测试绿灯算不算消费。

**② ADR-010 大设计 vs 实际子集**（账本+产物可证）：三分流✅真实跑（profile_b_polled 13 次带 auto/confirm/skip 计数）；CI-红触发✅（11-17 trigger_found ×2 ci_failed → 修复轮）；claim-CAS✅（mr-7、task-7167752069、rounds 实证）；审批三条件△接线（gitlab-triggers:16 import approvalValid）但账本零留痕，关账实际靠人复审评论（acks-1916）；豁免三道闸❌决定部件在死码 attribution 里，账本零 waive/flipy 事件；预算硬限△被自身注释承认可绕（Y4）；影子周❌零数据（Y3）。**剖面 A（MR 修复）端到端跑通；剖面 B（飞书 bug 自动接单）半活**——auto 档真实触发过，一次以 uncaughtException 释放收场（11-14 ledger），闭环成功零次（低置信：用户级账本未读）。

**③ 流程重量 vs 规模**：poll-30m（一个配置值 900→1800）= 2 笔提交（reflog 间隔 **85 秒**）+ state.json 233 行（8 阶段）+ CR 79 行含 §0 九行硬规则表 + retro + 2 份 gate 日志 ≈ **330 行流程产物 ： 7 行实质变更（≈47:1）**；draft-skip 同构（提交间隔 158 秒，state 声称 100 分钟）。stage 时间戳是手填计划值，与 git 机器事实差 30 倍——仪式是叙事不是时间。retro 豁免坑三连咬（poll-30m/review-verdict-comment/draft-skip，fix-suggestions 收尾提交自认"waiver trap, third occurrence"）是流程元素互不认知的维护税。可自动化点已部分落地（harness-cli close 一键收尾，11-16）但两批提交的手工形态延续到 11-18。单人仓证据：141 提交、22 份 CR、26 份 retro 全部出自一人会话；"code-reviewer 一轮 approve”实为同体自审。

**④ 文件族冗余**：6 族实际=4 族真用（round 17 份/todo 6/acks 3 有实料/ack 2）、1 族空壳（resolves 3/3 空）、1 族低频（pack 1/4）；外加 session-1896/ 双存放位（Y5）。.ai/verify 154 份的永久入库价值与重复度见 Y6。

**⑤ skills/agents vs 实际栈**：本仓自身栈 1 个（harness），skills 5 目录中 3 个服务旁挂外部仓（G3），deployment 未验；agents 5/12 零出场（Y7）；三 CLI 投影（.claude/.zcode/prompts，68 文件）每批必付 check 成本，deepseek 路径账本零会话痕迹。

## 矛盾与隐藏假设

1. **数据 vs 数据**：state stage 时间戳（poll-30m 42 分钟）vs git 提交间隔（85 秒）——手填计划值冒充时间事实，差 30 倍。
2. **数据 vs 假设**：AGENTS.md 规则 4/8 承诺“审查必走 skill+CR、跳 cr 等于交付未审代码”，实际 ai-review cr 档 0 次运行、local-cr-gate 任务自己漏 CR（CR-2026-11-17 两日审核 R2 抓到）——纸面重量 > 执行重量。
3. **假设 vs 假设**：设计假设多机多人多仓（claims 跨机互斥、订阅三档多人、三 CLI 目标），使用现实单人单机单目标仓。
4. **时间维度**：ADR-010 D5（merge-base 实跑）是 11-09 设计，11-17 ci-fail-trigger 已改目标分支流水基线——演进痕迹未回写 ADR，非真矛盾。

## 所缺证据（得到后结论会怎样变）

- **~/.harness/task-loop 用户级账本**：若 budget/pause-resume/claim 事件成串，Y4 从“降级”退“保留”，②中剖面 B 或已闭环。
- **TDC GitLab runner 状态（K2）**：若已装且 broker 在跑，Y1 整条翻案。
- **headless 轮的 skill 加载记录**：G3 从低置信升确定。
- **deployment skill 的命中记录**：Y7/G3 边界修正。

## Top 5 发现

1. 🔴 三死码 lib 夏核成立，且豁免三道闸（D4）的决定性部件就在死码里——该机制从未在真实轮次放过一笔（账本零 waive 事件）。
2. 🔴 resolves 族 3/3 全空 + pack 1/4 落盘 + session 双存放位：执行器协议 6 族实际 4 族在用。
3. 🟡 broker 通知族 7 文件 + 6 测试套件接线齐全、生产成功事件 0、订阅者 0、GitLab 边物理不可达（无 runner）——最大的“测试绿灯型闲置”。
4. 🟡 流程税实测：1 行配置变更 ≈ 47:1 的流程产物比；两批提交间隔 85/158 秒戳穿 42/100 分钟的手填时间戳；豁免坑三连咬。
5. 🟡 ADR-010 七裁决约一半子集（影子周/预算硬限/豁免三道闸）从未走过真实路径，预算硬限还被自身注释承认可绕（1847 跑 7 轮 > 3）。

**过度设计指数：7/10**——核心链实用、外围四族设计超前使用 1-2 个数量级。

>（落盘说明：分析师子代理环境无写文件工具，本文件由主会话代存，内容与交付原文一致。）
