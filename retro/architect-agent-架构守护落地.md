# architect-agent：架构守护三层落地（2026-11-18）

> 任务：`.ai/tasks/architect-agent/state.json`（S 档 feature）。
> 需求源：用户设计讨论——"用 harness-starter 保证宿主项目架构自洽，是否需要架构 agent"。

## 方案定稿：三层混合（不是全时段流水线 agent）

| 层 | 形态 | 触发时机 | 成本 |
|---|---|---|---|
| 第一层 | `scripts/architect-check.mjs`（机器指标） | 每次 gate（报告模式）/ PR CI（--strict） | 零 |
| 第二层 | `agents/architect.agent.md`（判断 agent） | M/L 档 adr 阶段 + change_tier=3 + 周期检查 | 按需 |
| 第三层 | `.ai/review/architecture/health-*.md`（健康报告） | 每周或每 N 个合入 | 低频 |

### 第一层 fitness functions（已实现）
五条可度量判据：F1 模块边界（resource 层 service 调用>10）、F2 依赖方向（单文件 import 其它 Service>5）、F3 复杂度预算（主源码>3000 红/>2000 黄，测试独立>8000 红）、F4 配置面（键增长>15 黄）、F5 预留（测试时长基线）。

**双模式**：默认报告（exit 0，存量债不阻断 gate）；`--strict` 严格（exit 1，PR/CI 拦新增违规）。

### 第二层 architect agent（已定义）
11 agent → 12 agent。触发式不是全时段：adr 阶段/change_tier=3/fitness 报警时被 orchestrator 调度。
管五维：模块边界、依赖方向、复杂度预算、ADR 一致性、简单性趋势。
不管：代码写法（code-reviewer）、技术选型（tech-selector）、RS/FS 一致性（spec-reviewer）。

### 第三层 周期健康报告（模板就位）
`.ai/review/architecture/` 目录 + README + architect agent 的报告格式定义。

## TDasset 首跑数据（方案价值的直接证明）

主源码 🔴23 个文件超 3000 行（TOP：ElementService 12879、AttributeService 10648、ImportAndExportDataService 7898）。
测试 🔴5 个超 8000 行（TOP：ElementServiceUnitTest 22101、AttributeServiceUnitTest 20149）。
黄牌 28 个（2000-3000 行）。

这些数字在 harness-starter 落地前**没有任何机制能看到**——每个文件都是"过了门禁"逐步长到这个规模的。fitness function 的第一个价值不是阻断，是**让不可见的渐变变成可见的数字**。

## 验证
- `npm run architect`（报告模式 exit 0 ✓）
- `node scripts/architect-check.mjs --strict`（严格模式 exit 1 ✓）
- `npm run gate`（architect 进 gate 不阻断 ✓）
- `npm run check:agents`（12 个 agent 一致 ✓）
