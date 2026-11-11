# agents / 模板 / skills / state.json 架构审计

日期：2026-11-11 · 范围：agents/*.agent.md（11）、templates/（9）、.skills/（4+模板）、docs/、.ai/tasks/*/state.json（8）· 标准按任务四视角自拟

## 结论
骨架合理：11 个 agent 职责链清晰、writes 投影（.ai/writes.json）与 agents 声明一致、S 档裁剪规则在实例中被真实使用。但有 3 条必须修：两条僵尸任务违反自家 3 天规则、retro 门禁落点与实际产出对不上、S 档小任务仍要走 9 阶段。另有值得考虑 5 条、仅记录 4 条。

## 必须修

1. **僵尸任务违反自定 3 天规则**（正确性）
   位置：`.ai/tasks/harness-builder-hardening/state.json`、`.ai/tasks/harness-doc-gate/state.json`。
   前者 stage=impl、stage_history 空、T1 pending，最后 commit 5e3b5bf（11-02），今 11-11；后者 stage=impl、todos 全 completed 却 11-02 后无推进。orchestrator.agent.md:66 自定「状态最后更新早于分支最后 commit 超 3 天 → 视为僵尸，要求重建」，两个实例都已超 9 天，规则未被执行——说明该规则只写在 prompt 里、无机器判据（CI/verify:state 不查 mtime vs commit）。
   影响：`.ai/tasks/` 与 `ls .ai/tasks/` 的接手信号失真，新会话会尝试续跑僵尸。
   建议：把僵尸判定做成 `verify:state` 的机器检查（state mtime vs 分支 commit 时间），或在接手清单里显式标记这两个任务已死。

2. **retro 门禁的「retro 文档存在」与实际产出对不上**（正确性）
   位置：agents/orchestrator.agent.md:63（retro 门禁）vs `retro/` 目录。
   8 个任务 stage=done，`retro/` 只有 3 个文件且仅「2026-11-10-task-loop首次实跑发现.md」可对应任务 slug；其余 done 任务的 retro 文档找不到（不在 retro/、不在任务目录）。门禁判据「retro 文档存在」要么按了别的路径通过，要么靠 waived——无论哪种，判据与落盘位置没有闭合。
   影响：retro 阶段形同虚设，经验沉淀链断。
   建议：门禁判据固定为 `retro/<slug>*.md` 或 state.artifacts 里的显式路径，CI 可查。

3. **S 档流程对小任务仍过重**（状态机）
   位置：AGENTS.md 硬规则 8 + 实例。
   harness-gate-fix：5 文件 + 12 断言的 bugfix，走满 rs(裁)→…→done 共 9 条 stage_history；review-p2-fix 同样 9 条。ai-review-notify 的 stage_history 长 12 且出现 ci→retro 循环三轮——retro 完成后又被拉回 ci，说明收尾路径存在往复。门禁数量与改动规模不匹配，S 档每任务至少付出 rs+verify 包装+cr(§0)+ci+retro 五件套。
   影响：小改动落地成本高，团队会倾向绕过流程（config 自己也承认 deepseek/人工 commit 只有 CI 兜底）。
   建议：S 档把 ci/retro 合并为单条「收口」检查；查明 ai-review-notify 的 ci↔retro 循环是判据互锁还是误判。

## 值得考虑

1. `docs/04-testing/**` 只有 code-reviewer 可写（agents/code-reviewer.agent.md:6），test-engineer 反而不能写测试文档——缺陷模式回流文件与测试用例目录归属割裂。建议改挂 test-engineer 或双方共享声明。
2. 四个 agent 共写 `docs/02-features/**`（feature-decomposer / interaction-prototyper / spec-writer / spec-reviewer），writes 声明区分不了谁写的什么；好在文件名后缀（.wbs/.matrix/.review）可分。建议按子目录或后缀细分声明，CI diff 才有判断力。
3. state.json 的 `task_type` / `related_task` / `baseline` / `change_tier` 全部塞在 `meta` 里（8 个实例一致），顶层 schema 键反而空（id/type/status/ooda_stage 均为 null 或不存在）。追溯链校验（checkTaskTraceability）依赖的字段埋在自由 meta 里，schema 演进易碎。建议提升为顶层必填键。
4. harness-builder-hardening 用 `meta.note` 声明「对账补登记（非新任务）」——用 note 绕过正常任务生命周期来满足基建比对，属于字段滥用变体；这类补登记应有独立轻量通道（如 ledger 条目）而非伪任务。
5. 门禁大量依赖 prompt 自律而非机器判（orchestrator:60 承认「手写 checks 充数」风险、writes.json 自认非运行时门禁）。config 已坦诚，但 S 档裁剪后剩下的门禁里，建议优先把「verify 日志 mtime 晚于源码」这类可机器判的保留为唯一硬卡，纯自律项降为提示。

## 仅记录

- docs/00-planning、docs/04-testing 目录为空，与 templates 九套模板相比实际产出集中在 RS（5 份）与 docs/plans——FS/WBS/ADR/SR 模板仅 harness-doc-gate dogfood 过一次。
- .skills 四份 SKILL.md 均在 66–82 行、远低于 maxLines 200，结构合规。
- harness.config.json runtime 三项仍是 "unknown"，orchestrator 每会话重复自检的成本未消除。
- retro/ 文件命名混用「日期-主题」与任务 slug 两种风格。

## 审阅范围与未覆盖
核对了：11 份 agent 声明 vs .ai/writes.json 投影（一致）；harness.config.json gates/writeGuards 全文；8 份 state.json 的 stage/stage_history/todos/meta；git log 时间线；retro/、docs/ 各目录实况。未覆盖：hooks/hooks.manifest.json 与 scripts/*.mjs 的实现正确性（本轮架构视角未读）；generate 物（.claude/.zcode/prompts）与源的一致性未 diff；state.json 各任务的 verify 日志真实性未逐条抽验。
