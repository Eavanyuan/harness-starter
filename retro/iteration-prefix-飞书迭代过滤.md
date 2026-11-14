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

## 实测结论（2026-11-14 数据档开通后，OAuth 用户身份，全程只读）

- **迭代字段 key = `field_a7de08`**：MQL 的 SELECT 直接认中文名「迭代周期」并返回 key
  （`{"key":"field_a7de08","name":"迭代周期"}`）——中文名本身就是探针，比猜英文
  key 可靠。已写入 `runtime.feishu.iteration`。
- **真实 label 形态**：`IDMP-2.0.4.0` / `Cloud-20260930` / 空（dependabot 告警等无迭代）。
  空值筛掉的规则与实况吻合：12 张自己的单 → IDMP 保留 2 张（[DirectData] 系列），
  Cloud 线 2 张、无迭代 8 张全筛掉（IT4.log）。
- **写工具可见**：add_comment（报参数错=工具在）、update_field、get_workitem_brief
  均可调；真实写（评论/状态流转）留给第一张真单，transitionStatus 的可流转态返回
  形态届时一并核对。

## 验证

test:feishu-bug-source 43→49（MQL 带列/零残留、四向过滤、label 解析、变异恒真必红）；
test:task-loop 75/0（接线无回归）。证据 IT1/IT2。
