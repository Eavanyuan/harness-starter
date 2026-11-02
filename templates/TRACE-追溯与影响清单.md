# TRACE-追溯与影响清单

> change / bugfix 任务的 CR 附件。审核者按行逐项核对，不看"已同步"声明。
> feature 任务不需要填；机器可判的部分（baseline / change_tier / affected_ids / 回归 TODO）
> 已由 guard_state 与 ci-verify 强制，这里补的是人审侧的影响分析。

## 1 任务标识

| 字段 | 值 |
|---|---|
| 任务 slug / 任务类型 | （如 `chg-user4-copy` / change） |
| 关联任务（related_task） | （原任务 slug；bugfix 填发现来源；完成态机器复核其 state 仍存在） |
| 需求基线（baseline） | （git commit hash，机器验证在仓库历史中存在；仅 change） |
| 变更档位（change_tier） | （1=文案展示 / 2=局部行为 / 3=契约跨栈；仅 change） |

## 2 影响链（逐行一条，不许合并）

| RS 条目 | FS 小节 | TODO | 测试场景 | verify 证据 | 状态 |
|---|---|---|---|---|---|
| （如 US-4） | （如 FS-登录 §3.2） | （如 T1） | （如回归 FooTest#bar） | （.ai/verify/T1.log） | 已更新 / 不受影响 |

> "不受影响"也要写明，并给一句理由——没写理由的"不受影响"等于没查。

## 3 明确不受影响的模块

| 模块 | 为什么不受影响 |
|---|---|
| | |

## 4 bugfix 专用：复现与回归

| 项 | 值 |
|---|---|
| 实际行为 / 预期行为 | |
| 复现步骤 | |
| 回归测试 TODO（kind=regression） | |
| 红灯日志（red_log_path，exit_code≠0，已入库） | |
| 邻近回归面检查结论 | |

## 5 CR 复核项（人审，机器判不了）

- [ ] change_tier 与实际 diff 相符（触及 API/迁移/权限 → 必须是档位 3）
- [ ] 影响链里没有"只改文档没改实现"或"只改实现没改文档"的半吊子行
- [ ] 红灯日志是真的：git log 核对其提交早于修复 commit（机器只验 exit_code≠0，不验真伪）
