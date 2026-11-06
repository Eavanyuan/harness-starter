# RS-审核与通知自动化

> 任务：`.ai/tasks/ai-review-notify/state.json`（S 档，feature）。
> 来源：会话讨论定案——"审核自动化 ≈ 通知自动化 > 执行自动化"，先落前两者。

## 1 背景与痛点

流程里所有审核点（RS/ADR/FS/CR）靠人记得发起：实测两次 CR 未按 skill 规则审直到被提醒；
忘 `/task` 的事后修账成本比事前拦高一个量级；决策停点（D 类、🔴 处置）靠人恰好在场盯着会话。
本仓库产物是脚手架，落地到的团队用 GitLab——MR 是"个人纪律"与"团队纪律"的分界线，
因此**以 MR 变更为统一触发点，用「改了什么文件」机器路由出该跑哪些审核**。

## 2 用户故事

### US-1 审核自动路由

- **作为**：技术负责人
- **我希望**：MR 的变更文件能自动路由出该跑哪些审核（rs/adr/fs/cr/证据链）
- **以便**：审核到场不依赖任何人的记性，也不依赖人打标签

**验收标准**

- Given 一个只改了 `docs/01-requirements/**` 的 MR When 跑 `review-router` Then 输出且仅输出 `rs` 审核（JSON 可解析，含命中原因）
- Given 变更只含噪声文件（`package-lock.json`、`.ai/ledger/**`）When 路由 Then 所有审核标记 skipped，不触发任何 AI 调用
- Given 规则文件缺失或非法 When 路由 Then 退出码 2（fail-closed），不是空结果退出 0

### US-2 AI 审核（模式 B：预打包单发）

- **作为**：流水线维护者
- **我希望**：审核把「清单 prompt + 受限上下文」打包成一次 API 调用，机器判据（模板完整、引用存在）先跑且零 token
- **以便**：token 成本跑前可算、判据确定性优先于语义猜测

**验收标准**

- Given RS 文档缺「开放问题」章节 When 跑 `ai-review --type rs`（无模型 key）Then 机器判据产出 🔴，退出码 1，全程 0 次 API 调用
- Given 模型返回非法 JSON 重试一次仍失败 When 审核 Then 退出码 2（fail-closed），不产出"通过"结论
- Given 审核完成 When 查看 `.ai/ledger/events.jsonl` Then 有一条含 type/model/token 用量的记录（计量落账）
- Given `--dry-run` When 审核 Then 打印打包统计（文件数/字符数）且 mock 模型服务收到 0 次请求

### US-3 决策通知（票拟找人）

- **作为**：被 @ 的决策角色
- **我希望**：决策停点与审核结论渲染成飞书交互卡片（选项即票拟），点选后以我的身份落账回投
- **以便**：人只做批红，不做盯梢；每一步有账

**验收标准**

- Given 一个含选项的决策事件 When `notify` 渲染 Then 产出结构合法的飞书卡片 JSON（msg_type=interactive，每个选项一个 button，value 携带回投所需上下文）
- Given broker 收到 MR webhook（token 校验通过）When 处理 Then 飞书侧（mock）收到含命中审核类型与批红角色的卡片
- Given broker 收到卡片回调 When 处理 Then GitLab 侧（mock）收到一次带 `resolved_by` 的文件更新请求；webhook token 不匹配 Then 403

## 3 核心需求

| 编号 | 需求 | 优先级 | 来源 |
|---|---|---|---|
| R-1 | `harness.rules.json`：审核路由（路径模式/机器判据/模型档/批红角色）与通知路由的机器可执行规则，代码不写路径字面量 | P0 | 规则数据化 |
| R-2 | `scripts/review-router.mjs`：变更文件 → 审核类型集合，零 LLM，噪声跳过，fail-closed | P0 | US-1 |
| R-3 | `scripts/ai-review.mjs`：L0 机器判据 + L1 预打包单发（文件数/行数封顶）+ 结构化 JSON 结论 + 🔴→非0退码 + token 计量 + `--dry-run` | P0 | US-2 |
| R-4 | `scripts/lib/notify.mjs` + `scripts/harness-broker.mjs`：卡片渲染/发送 + GitLab webhook 入 + 飞书回调决策回投 | P0 | US-3 |
| R-5 | 三份审核清单 prompt（rs/adr/cr）+ GitLab CI 接线样例文档 | P1 | 落地配套 |
| R-6 | 新文件随 harness-cli 传播（TEMPLATE_FILES 登记），测试进 gate 与 CI workflow | P0 | 脚手架一致性 |

## 4 非功能约束

- 零 npm 依赖（node ≥18 自带 fetch/http）；所有外部端点经 env 配置，测试全部走本地 mock，不打真网。
- fail-closed：规则缺失/模型失败/解析失败一律非 0 且不产出"通过"；通知发送失败不阻塞审核本体（观测 fail-open，与 ledger 同边界）。
- 不改 hooks 判定口径、不改考卷区；token 计量复用 `hooks/lib/ledger.mjs` 的 events.jsonl 格式（HARNESS_LEDGER_DIR 可重定向）。

## 5 范围外

- 不部署 broker 服务（交付可运行脚本 + 接线文档，部署由落地团队决定）。
- 飞书真实回调联调、open_id 映射治理（留 env 接口）。
- prompt 前缀缓存调优、L3 增量复审的跨 MR 复用（本次只做单 MR 内不变文件跳过）。
- 自动合入、执行自动化派发（讨论已定：不在本期）。

## 6 术语表

- **模式 B**：预打包上下文单发 API（对比 agent 自由漫游）；**票拟/批红**：agent 出建议选项 / 角色点选定夺。
- **机器判据（L0）**：脚本可判定项（章节存在、引用存在），零 token；**AI 判据**：语义项（写得对不对）。

## 7 开放问题

| 编号 | 问题 | 状态 |
|---|---|---|
| OP-1 | 决策回投的持久落点：v1 写 RS 文档「开放问题」行（无 schema 风险）；blockers 正式进 state.json 需 guard_state 认可的字段设计，留正式立项 | 已定 v1 方案 |
| OP-2 | 飞书角色 → open_id 映射的治理（谁能改、怎么审计），落地团队自管 | 开放 |
