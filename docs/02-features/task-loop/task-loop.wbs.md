# WBS：task-loop

> 验收标准见 `RS-task-loop.md`（spec_ref 锚点）；裁决依据见 `ADR-010`。估时含"仓库税"（T0）。

| US | spec_ref | TODO | 内容 | 估时（天） |
|---|---|---|---|---|
| US-2 | rs#R-4 | T0 | 仓库税预算：本任务 RS/FS/WBS/CR 自身过门工时与被打回预期 | 0.5 |
| US-2 | rs#R-4 | T1 | 追溯门禁扩展：`--related` 字符集 + `feishu:<id>` 解析 + `remote_id` 锚 + doc_completeness 收 `EXT-<id>` + 模板与套件 | 1 |
| US-3 | rs#R-5 | T2 | 订阅三档 + broker 评估器 + aging 巡检 + digest 模板 + 批准下限 + 套件与文档 | 3.5-4 |
| US-1/2/4 | rs#R-1 | T3 | runner 核心：双剖面触发（A 用 GitLab 结构化信号）、git CAS 认领+TTL、worktree、`runtime.headless`（hook 必接线进验收）、pause/resume、预算（D7 口径）、kill switch、审批三条件校验 | 4-5 |
| US-4 | rs#R-6 | T4a | 失败指纹归一化（✗ 剥参 + 硬编码文案并轨 + `step:*`）+ merge-base 基线实跑 + 集合差 | 1-1.5 |
| US-4 | rs#R-7 | T4b | 三分流决策 + 豁免三道闸 + MR 附证 | 1-1.5 |
| US-1 | rs#R-2/R-8 | T5 | 剖面 A 影子周（零写入可证 + 触发/漏触发双列报告）→ 单任务 → 小批；**P1 准入 = runner 已装** | 3 |
| US-2 | rs#R-3 | T6 | 剖面 B：飞书事件源（权限未批走降级形态双测）+ 收尾回写读回 + doctor task-loop 前提在场性 | 3-4 |

依赖：T1/T2 无依赖可先行；T3 依赖 T1；T4b 依赖 T4a；T5 依赖 T3+T4 且 K1；T6 依赖 T3 且 K2（或降级）。
分期：P0 = T0-T4b；P1 = T5（准入：K1 runner，doctor 阻塞级为闸）；P2 = T6。
度量（入 ledger 报告）：触发→认领→attempt→红绿循环→停点→人审漏斗；豁免率、flaky 率、认领竞争率、漏触发率。
