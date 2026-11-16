# RS：MR 打回触发补动词证据（change，关联 task-loop）

> S 档 rs（变更任务）。变更意图与验收以最小篇幅落档；行为细节以 `FS-任务循环执行器.md` §4.4（本次同批更新）为准。

## 1 背景与痛点

2026-11-16 MR !1882（TDasset fix/document-scope-idor → main）实测：评审者用**普通评论**（non-resolvable）+ approve→unapprove + requested changes 动词表态，整条 MR 没有任何 resolvable 讨论。此时 `classifyMr` 判 `pending`、`fetchTriggers` 热路径粗筛更早把它 `continue` 掉——**MR 打回对 runner 完全不可见**。触发器预期的信号形态（他人未解决 diff 讨论）与真实评审习惯不匹配；旧文档「GitLab 没有 CHANGES_REQUESTED verb」的说法已过时（GitLab 16+ 有）。

## 2 用户故事

- **作为**：task-loop runner 的使用者（MR author）
- **我希望**：评审者无论用 diff 评论还是用「request changes」动词打回，runner 都能轮询到
- **以便**：打回不过夜，不依赖评审者记得用 resolvable 评论

**验收标准**

- Given 他人发出的 requested changes 动词晚于最后一次 push（无论有无 resolvable 讨论、无论此前是否批过又撤）When runner 轮询 Then 触发 `changes_requested`（`signal=review_verb`）
- Given 批红晚于打回动词 Then 判 `approved`（谁最后表态谁算数）
- Given 动词早于最后一次 push 且无未解决意见 Then 不触发（新 commit 已覆盖）
- Given 动词由本人发出 Then 不算打回证据（与「自留言不算」同口径）
- Given 触发成立且评审人写过建议性普通评论（non-resolvable）Then 评论进入触发 payload 的 `comments` 并落入 ack 待修清单（不双列 resolvable 讨论、不收本人与系统留言）——审核意见里的建议修改项纳入接单修复范围，即便评审人不逐条回复/resolve
- 存量行为不变：他人未解决 resolvable 讨论的触发路径、审批三条件、陈批判红、`pending` 形态全部保持

## 3 核心需求

| # | 需求 | 优先级 | 来源 |
|---|---|---|---|
| R-V1 | `classifyMr` 打回证据两路并列：他人未解决 resolvable 讨论，或他人晚于末次 push 的 requested changes 动词；批红须同时晚于末次 push **和**晚于动词才算「最后的话」 | P0 | US 验收 1/2 |
| R-V2 | `fetchTriggers` 热路径粗筛同步放行动词型 MR；无信号 MR 仍只打 discussions 一个接口 | P0 | US 验收 1 |
| R-V3 | `changesRequestedAt` 过滤本人动词 | P1 | US 验收 4 |
| R-V4 | `reviewCommentsByOthers`：建议性普通评论进触发 payload `comments` 并入 ack 待修清单（不双列/不收自发与系统留言） | P0 | US 验收 6（用户指令 2026-11-16） |

## 4 非功能约束

- 判不了先后（`/approvals` 降级无批红时间）→ 不给 approved，宁可多跑一轮（沿用 KI-3「判不了明说不判」哲学）
- 无新配置键（H8：配置键必须有消费者——本变更零配置）

## 5 范围外

- headless 会话逐条回复建议性评论与修复动作本身——T5 接入（本任务把评论送进 ack 清单与 payload，回答"要修什么"）
- 老版本 GitLab（无 requested changes 系统留言）上的普通评论表态——修复前即不可见，diff 讨论路径不受影响（KI-2）

## 6 术语表

- **动词（review verb）**：GitLab 16+ 评审动作产生的系统留言（approved / unapproved / requested changes），带 author 与 created_at
- **resolvable 讨论**：挂在 diff 行上、可标记 resolved 的讨论；普通评论 non-resolvable

## 7 开放问题

无。

**影响链**：`RS-task-loop.md` US-1 第一条验收行、`FS-任务循环执行器.md` §4.4 判定段 + §6 测试矩阵、`scripts/lib/gitlab-triggers.mjs`、`test/task-loop.test.sh`。
