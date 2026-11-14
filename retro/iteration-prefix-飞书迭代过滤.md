# iteration-prefix：飞书 bug 按迭代周期前缀过滤（2026-11-14）

> 任务：`.ai/tasks/iteration-prefix/state.json`（S 档 feature）。
> 需求来源：TDasset 落地规则（用户 2026-11-14 会话指令）——"迭代周期是 IDMP 开头才是
> TDasset 的 bug"。同一空间（taosdata_td）里混着多条产品线的单，不按迭代过滤会把别的
> 产品线的缺陷也自动接过来修。

## 判据与实现

- 配置驱动：`harness.rules.json` 的 `runtime.feishu.iteration = { field, prefix }`，
  env `FEISHU_ITERATION_FIELD/PREFIX` 临时覆盖；field 与 prefix 任一为空即整体关闭
  （未配置空间零行为变化，回归 IT1/IT2 双绿证明）。
- **迭代字段只进 MQL 的 SELECT、不进 WHERE**：该字段支持哪些算子未实测，客户端前缀
  过滤是唯一敢保证的形态——与这个模块"字段语法以实测为准，不抄文档猜"的既定纪律一致。
- 解析链：moql 的 key_label_value 取 label（同状态字段先例）→ `bug.iteration` →
  `filterByIterationPrefix` 大小写不敏感前缀匹配；**迭代为空/缺失 → 筛掉**（规则是
  "IDMP 开头**才是**"，无迭代不是本产品的单）。
- 过滤位置在**分级门槛之前**：非本线的单不占 P0/P1 自动接单额度，也不进 P2 确认卡；
  筛掉动作落账 `profile_b_iteration_filtered`（kept/skipped + 单号），可观测。

## 待实测（数据档开通后）

迭代字段的 key（样例里假设 `sprint`）需按 2026-11-10 的同套办法在 taosdata_td 实测
一次（search_by_mql 的 SELECT 带字段探 key，或工作项详情接口读字段表），确认后填进
`runtime.feishu.iteration.field`。此项已登记进落地评估报告的待实测清单。

## 验证

test:feishu-bug-source 43→49（MQL 带列/零残留、四向过滤、label 解析、变异恒真必红）；
test:task-loop 75/0（接线无回归）。证据 IT1/IT2。
