# ack-hotfix：接单=只流转状态（2026-11-15）

> 任务：`.ai/tasks/ack-hotfix/state.json`（S 档 bugfix，related ack-wiring）。
> 起因：真实首跑暴露三缺陷——评论刷屏、状态根本没改、兜底评论谎报"已流转"。

## 三个根因与修法

1. **用错工具**：状态流转的专用工具是 `transition_state{project_key, work_item_id,
   transition_id}`（id 从 get_transitable_states 取）；旧代码用 `update_field{field_key:'status'}`
   ——它只管业务字段（fields 数组），传状态静默返回空，状态纹丝不动。
2. **回读用错接口**：get_workitem_brief 的 status 实测读不出（undefined）→ 每次误判
   "未确认"→触发兜底评论。可靠回读 = search_by_mql 查 work_item_status。
3. **兜底评论撒谎**：流转失败时评论"状态已流转（以此评论为凭）"——伪证据 + 刷屏。
   全部移除（用户指令：接单不要添加评论）。新语义：**接单 = 一次 transition_state +
   MQL 回读确认，零评论**；幂等（已是 Processing → ok/already）；失败如实失败。

## 实况

- 两张 P1 IDMP 单已流转 Processing（7167910546 探针期、7167752069 修复后路径各一）。
  其中 7167752069 为人工触发——此后约定：**工作项写操作只走定时任务**（用户指令），
  正好以定时器验证全链。
- 账本昨夜 22:47 后停记为瞬态（修复后探针写入正常），非持续故障。
- 昨夜的重复接单（同单两次）来自崩溃释放认领后重试——新语义下评论幂等成本为零
  （transition 本身幂等），不再刷屏。

## 验证

AH0 红灯日志（新测试打旧代码 5 红）；feishu-sync 8/0（transition_state 调序/幂等/
拒硬转/零评论）；task-loop §12 同步三路重写后 86/0。
