<!-- generated: do not edit -->
# Agent 索引（prompt-only 形态）

> 无 subagent 能力的 CLI，按此表取对应 prompt 文件，粘贴或经脚本注入上下文。
> 表格顺序 = 建议启用顺序，不是字母序。

| 别名 | 入口 | agent | 何时使用 | 写什么 |
|---|---|---|---|---|
| /task | `prompts/agents/orchestrator.md` | 编排器 | 全流程编排状态机。任务启动时使用，驱动至 retro 完成。 | .ai/tasks/** |
| /rs | `prompts/agents/requirement-analyst.md` | 需求分析 | 把原始需求结构化为 RS 草稿与开放问题清单。收到新需求/工单时使用。 | docs/01-requirements/** |
| /wbs | `prompts/agents/feature-decomposer.md` | 功能拆分 | 将 RS 拆解为带依赖与风险级的 WBS/TODO 骨架。需求评审通过后使用。 | docs/02-features/**<br>.ai/tasks/** |
| /adr | `prompts/agents/tech-selector.md` | 技术选型 / ADR | 对多方案决策点产出 ADR 草稿（候选对比 + 项目内先例证据）。涉及技术选型时使用。 | docs/06-reference/adr/** |
| /fs | `prompts/agents/spec-writer.md` | 规格撰写 | 按 FS 模板起草功能规格（含契约、迁移、i18n 清单）。WBS 与 ADR 完成后使用。 | docs/02-features/** |
| /proto | `prompts/agents/interaction-prototyper.md` | 交互原型 | 生成低保真线框与交互状态矩阵（按 ui_scope 分级）。FS 撰写期并行使用。 | prototypes/**<br>docs/02-features/** |
| /sr | `prompts/agents/spec-reviewer.md` | 规格审核 | 五项交叉一致性审核 FS（RS↔FS↔代码↔既有FS），输出分级意见。FS 完成后、编码前强制使用。 | docs/02-features/** |
| /impl | `prompts/agents/coder.md` | 编码 | 按 TODO 与实现契约（FS/ADR/矩阵）编码。SR 审核通过后由编排器调用。 | backend/**<br>frontend/**<br>.ai/verify/** |
| /test | `prompts/agents/test-engineer.md` | 测试工程 | 编排单测/边界值/定向验证/E2E，产出验证证据。各栈实现完成后使用。 | **/*.spec.*<br>**/*Test.java<br>.ai/verify/** |
| /cr | `prompts/agents/code-reviewer.md` | 代码审查 | 提交前 checklist 审查 + MR comment 闭环。MR 创建后使用。 | docs/04-testing/**<br>.ai/review/** |
| /retro | `prompts/agents/retro-ledger.md` | 复盘沉淀 | 任务关闭后复盘并沉淀经验为 skill 修订。release 完成后使用。 | retro/** |

## 建议启用顺序

1. `orchestrator` + 三个只读（requirement-analyst / tech-selector / spec-reviewer）
2. 加写文档类（feature-decomposer / spec-writer / interaction-prototyper / retro-ledger）
3. 最后加写码类（coder / test-engineer / code-reviewer），且只在 L2 信任级别启用

跳过顺序直接上 coder，是这套体系最常见的失败方式：门禁还没有，代码已经在改。
