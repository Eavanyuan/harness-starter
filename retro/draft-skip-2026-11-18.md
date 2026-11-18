# Retro — draft-skip（2026-11-18）

## 一句话

Draft MR 整体退出修复链（配置可逆），实测对象 !1847 曾在 Draft 状态被执行器修了 5 轮——过滤上线当拍即关账止损。

## 教训

1. **执行腿要有"该不该修"的前置判断**：执行器对工单照单全收，Draft/范围外/他人 WIP 都不挑——"能修"和"该修"之间隔着一层策略，策略归 loop（触发层）不归执行器。
2. **判定要双层**：列表字段缺失是本实例实测常态（head_pipeline、work_in_progress 都遇到过），权威字段必须在详情层复核；列表层变异被详情层防御中和正是深度防御生效的证据。
3. **形态跟官方走**：Draft 的标题形态除 Draft:/WIP: 外还有现行官方 `(Draft)`/`[Draft]` 括号形态（CR 补），WIP: 是 <14 旧形态保留无害——兜底正则要按官方文档口径收，不凭印象。
4. **retro 豁免坑第三次**（poll-30m、review-verdict-comment、draft-skip）：waived_by 形式 ci-verify 不认——系统性修复（verify.mjs 认 deferred 豁免或 init 提示必须落文件）应立项，不再逐个补。

（补录说明：close 时按豁免未落文件，次日 fix-suggestions 的 CLOSE-GATE 被 retro 规则拦下——与前两次同款，本文件按其建议补齐。）
