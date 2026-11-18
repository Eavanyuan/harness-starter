# deploy-skill：24 retro + 17 CR 经验蒸馏为通用部署能力（2026-11-18）

> 任务：`.ai/tasks/deploy-skill/state.json`（S 档 feature）。
> 需求源：用户指令——"这些经验要变成可以在其他项目落地的通用性能力"。

## 做了什么

审计发现 24 个 retro + 17 个 CR 的经验**零条**进了 skill——全锁在这个工作实例里，换项目全丢。本轮蒸馏为三个可交付资产：

1. **`.skills/deployment/SKILL.md`**：部署全流程 skill（能力选配矩阵 + 五步部署 + 硬规则 D1-D6 + Stage 0）
2. **`.skills/deployment/references/pitfall-checklist.md`**：47 条已知坑（🔴 21 条 / 🟡 26 条），按部署阶段分组（init/凭据/轮询/CR/架构/通用），每条标注来源
3. **`.skills/deployment/references/issue-tracker-interface.md`**：6 能力接口抽象（拉单/产品线过滤/优先级分级/状态流转/评论/防重），飞书为第一实现，新 tracker 按接口接入

## 经验分类学（蒸馏方法论）

| 经验类型 | 处理方式 | 示例 |
|---|---|---|
| **通用原则**（不依赖任何 tracker/语言） | 直接进 pitfall-checklist 通用节 | #42 门核对象必须与操作对象一致、#43 失败必须真失败 |
| **可泛化模式**（依赖 tracker 类型但不依赖具体产品） | 进 issue-tracker-interface.md | C1-C6 六能力、优先级归一、产品线过滤 |
| **飞书特有**（换 tracker 就不适用） | 标注"飞书特有经验，新 tracker 可跳过" | transition_state vs update_field、MQL 语法、@人格式 |
| **TDasset 特有**（换项目就不适用） | 不进 skill（保留在 retro 里） | IDOR 具体修法、IDMP 迭代前缀值 |

## 验证
check:skills 5/5（含新 deployment skill）✓
