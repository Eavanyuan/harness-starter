# ack-wiring：接单即流转飞书状态（2026-11-14）

> 任务：`.ai/tasks/ack-wiring/state.json`（S 档 feature）。回答"开始修 bug 时会改任务状态吗"——现在会了。

## 行为（真实轮次，dry-run 仍零写入）

认领 CAS 成功 → 接单三连（复用轮询段的 MCP 连接与 OAuth 身份，状态变更显示为凭据本人）：
1. `add_comment`：【自动接单】开始修复 + MR 预告 + 认领引用
2. `get_transitable_states` → `update_field`：**New → Processing**（英文 label）
3. 写后回读验证；读不回 → 评论兜底留凭（degraded 落账）

失败契约：接单失败（评论发不出/状态转不动）→ **释放认领**升级下一轮重试——接单是对提交人的
对外承诺，承诺不出去就不占锁；事件 `feishu_ack`/`feishu_ack_failed` 全落账。

## 修掉的两个坑（接线前预判 + 只读探针证实）

- 状态名：代码里原是中文「处理中」，空间枚举是英文（New/Processing/Releasing/Done/Canceled）
  ——transitionStatus fail-closed 会全失败；改 `Processing`。
- 类型名：`work_item_type` 原默认「缺陷」，实际类型名是 `Defect`；透传 t.itemType。
- 探针副产物：New 的可流转列表里还有 **ReProducing（复现中）**——信息不全追问/复现阶段
  可考虑用它（带 confirm_form 字段，接线时再实测）。

## 语义闭环

从此：接单 → New→Processing（提交人可见 + 查询天然去重）；修复合入 → Releasing/Done
（由合并事件触发，阶段 2）；追问挂起 → 状态不动（保持 New，单开着等补充）。
