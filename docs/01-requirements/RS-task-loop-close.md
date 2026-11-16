# RS：task-loop 关账半环与运行品质（change，关联 task-loop）

> S 档 rs（变更任务）。变更意图与验收以最小篇幅落档；行为细节以 `FS-任务循环执行器.md` §4.4/§4.7（本次同批更新）为准。

## 1 背景与痛点

task-loop 两次真实运行（2026-11-15 飞书两张 P1 单、2026-11-16 MR !1882 打回）验证了前半环（触发→分级→接单→CAS 认领），复盘发现四处实锭缺口：

1. **单源故障致盲所有源**：内网 GitLab 断连后，剖面 A 每 tick 超时 `die(1)`，尚未轮询的剖面 B 被一起拖死——2026-11-16 13:22 起实测连转 9 小时（`task-loop.err` 里 40+ 条 timeout），飞书侧全程失明。
2. **报错被 plist 分流藏住**：stderr 落 `task-loop.err`，`.out` 里只见"凭据已载入"然后无声退出；"载入后无声"在观测面上与"正常跳过"不可区分。
3. **ack 无生命周期**：MR 合并/批红后从触发集消失，ack 与远端认领挂到 25h TTL 僵尸升级，"修完了"账面不可见；评审新增意见不会重新认领（挂旧清单干活）；纯动词零待修的打回落"已落清单 0 条"的含混终态（live ack-1882 实例）。
4. **节拍 7200s 太慢**：P1 安全单从出现到接单最长等 2 小时。

## 2 用户故事

- **作为**：task-loop 的使用者
- **我希望**：单源临时故障不拖死另一源、每轮结束都有一行可对账的摘要、修完的 MR 自动关账、接手时有一份现成工单、P1 单 15 分钟内被接单
- **以便**：无人值守时循环的每一步在账面上可见，人只在有活干时被需要

**验收标准**

- Given 接入的某源临时不可达（超时/断网/5xx）When 轮询失败 Then 跳过该源继续其余源（不 die），不落节流戳、exit 1、下一 tick 立即重试；围栏行含 `源故障 <source>`
- Given 硬故障（401/403）Then 仍整轮 `die(1)`，且报错同步 stdout（die 双通道）——`.out` 不再只见"凭据已载入"
- Given 每轮结束（含无事可做/未接入/软失败）Then 必印一行围栏：`轮次结束：触发 N / 认领 N / 待复核 N / 跳过 N / 关账 N / 内容更新 N｜耗时｜exit`
- Given 已认领 MR 被合并/批红/关闭 When 触发集不再有它 Then 释放认领 + 删 ack + `trigger_gone`（关账）
- Given 评审新增意见（fingerprint 变化）Then `ack_stale` + 重认领 + ack/pack 更新；Given 纯动词零待修 Then `claim_noop` + `state:awaiting_rereview`，不落 pack（旧 pack 如存在同删）
- Given 认领且有待修内容 Then 落 `pack-<id>.md` 会话工单（意见原文 + 接手方式 + 建档指令 + 预期产物；变更文件清单未随轮询拉取，工单内如实标注）
- Given `runtime.taskLoop.pollSeconds` Then 为 900（P1 延迟上限 2h→15min）；wrapper `exec` 行带 `2>&1`

## 3 核心需求

| # | 需求 | 来源 |
|---|---|---|
| C-1 | 多源容错分流：临时/硬故障分类（正则覆盖 `e.message` + `e.cause.code/message`：timeout、`fetch failed`、`ECONN*`、`ENOTFOUND`、`EAI_AGAIN`、`HTTP 5xx` 为临时） | 痛点 1 |
| C-2 | 轮次围栏 + die 双通道 | 痛点 2 |
| C-3 | ack 生命周期：`triggerFingerprint`（待修项 id 排序投影，不取 body——改错别字不算新意见）、sweep 关账/重认领、空清单终态 | 痛点 3 |
| C-4 | 会话工单 `pack-<id>.md`（复用 session-pack R1；headless 自动执行仍留 T5，本批只到"等读工单"） | 痛点 3 |
| C-5 | 节拍 900s + wrapper `2>&1` | 痛点 4 |

## 4 非功能约束

- 向后兼容：旧 ack 无 `state`/`fingerprint` 字段 → 首次被 sweep 读到且触发仍在时**一次性重认领迁移**（`ack_migrated`，重建 ack 与工单，比补写诚实：旧 pending 无基准可比对）；新事件类型为追加型；`pollSeconds` 改配置即生效不用重装
- 观测不依赖重装：围栏行与软失败提示走 stdout，旧安装的定时器立即受益；wrapper `2>&1` 只惠及新装/重装（runner 侧 die 双通道兜底旧安装）
- 会话永不持凭据：pack 是纯文本工单，不含任何 token

## 5 范围外

- 飞书单（task-*）的 ack 关账：需按单号反查状态的单查 API，本批不做（KI-1）
- 定时器账本（用户级 `HARNESS_LEDGER_DIR`）与仓库账本的聚合报表（KI-2）
- headless 自动执行（T5 影子周准入）、CI 归因循环接线（T4b）

## 6 术语表

- **围栏行**：每轮恰好一行 stdout 结束摘要（计数 + 耗时 + exit），"载入凭据后无声退出"的解药
- **关账**：触发源消失时释放认领 + 删 ack + `trigger_gone` 落账的收尾动作
- **fingerprint**：待修内容的最小稳定投影（讨论/评论 id 排序串），变了 = 评审又写了新东西
- **空清单终态（awaiting_rereview）**：打回证据在但零待修内容——修复已推、等评审复看，认领保留防重复触发空转

## 7 开放问题

- 飞书关账接口形态：MQL 单查还是工作项详情 API，待真实"接单→修复→关单"全链第二次实跑时定
- 双账本聚合：`--report` 是否应同时读用户级与仓库级 ledger
