# perf-early：性能问题更早发现的四个卡点（2026-11-19）

> 任务：`.ai/tasks/perf-early/state.json`（S 档 feature）。
> 背景：性能在 harness 流程里原本不可见——verify-run 日志有时间戳但没人消费。
> 五卡点方案（编码/CR/CI/合入/生产）中 P0+P1 四项本轮落地。

## 落地清单

| 卡点 | 位置 | 机制 | 实测结果 |
|---|---|---|---|
| 1 编码/CR | review-checks `perf_anti_patterns` | N+1/循环内IO/嵌套循环/无界collect 四类正则，yellow 候选 | 正例 4/4 命中，负例 0 误报 |
| 2 verify-run | `.ai/perf/baseline.json` 比对 | 首跑记基线；≥150% 🟡 / ≥200% 🔴 / ≤50% ✅ | 四档全部按预期归档 |
| 3 CI/gate | architect-check **F5** | 最近 5 次均值 vs 前 5 次，增长 >30% 🟡 | **首跑抓到真信号：+54%（41s→64s）** |
| 4 合入前 | doctor §7 + config `performance.*` | 最近 5 次最慢 vs testSuiteMaxMs（300s）⚠️ 不阻断 | 预算内 ✓ |

## F5 首跑就抓到的真问题

验证链耗时增长 54%——不是假警报：TDasset 全量检查（28 🔴 文件扫描）+ 测试链变长是真实趋势。这正是"渐进腐化直到有人喊疼"的反面：现在每次 gate 都有数字。

## 顺带修掉的存量 bug（坑 #48）

`test:architect`（`--root .`）自诞生就崩：`argv[2 + indexOf('--root')]` off-by-one（值在 argv[3]，读了 argv[4]）。**从未被发现的原因：test:architect 不在 gate 聚合里**——测试写了 ≠ 测试在跑。已修并补进 gate。

## 方法论沉淀

- **数据已在，只差消费**：started/finished 头存在数月，四卡点里两个是"让已有数据被看见"——最便宜的可见性优先。
- **提醒不阻断**（与 fitness functions 同律）：性能超线是 ⚠️/🟡 不是 ❌——先可见再行动，存量债不挡新开发。
- **基于耗时的测试要容抖动**（坑 #49）：秒级时间戳 ±1s，用例参数必须在 [min,max] 区间内确定归档。
