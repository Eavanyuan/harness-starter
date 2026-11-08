# CR-代码审查记录：Apse 借鉴教义落地

> 审查对象：`.ai/tasks/apse-doctrine/state.json`（任务 apse-doctrine，S 档）。本地会话自审。
> skill：harness（改动含 templates/**，命中 applies_to；Stage 0 于本会话完成）。

## §0 硬规则逐条核（harness skill H1–H8）

| # | 规则 | 结论 | 证据 |
|---|---|---|---|
| H1 | scripts/hooks 改动同批配测试 | ✅（不适用） | 本批零代码改动，仅 .skills/templates/retro/docs 文档 |
| H2 | 生成物禁手改 | ✅ | 未触 .claude/.zcode/prompts；check:agents/check:hooks 绿（A1.log） |
| H3 | 解析失败 fail-closed | ✅（不适用） | 无解析逻辑变更 |
| H4 | 黑/白名单只在 config | ✅（不适用） | 无判定逻辑变更 |
| H5 | skill 结构约束 | ✅ | check:skills 绿；改动在 references/（不受 SKILL.md 200 行限），第 37 条条目化与既有格式一致 |
| H6 | 新拦截给合法绕过 | ✅（不适用） | 无新拦截 |
| H7 | 新 hook 双 CLI 接线 | ✅（不适用） | 无新 hook |
| H8 | 新配置键有消费者 | ✅（不适用） | 未加配置键 |

## 改动摘要

外部复盘（TDengine Apse）两条经生产验证的教训沉淀进本仓库两个消费点：checklist 第 37 条「停机规则放在被停对象的里面」（含五条判据与自查方法）；CR 模板头部「验证阶梯」教义段（按伪造成本排序、模型评审是过滤器不是证据）。其余六项借鉴以带触发条件的候选形式记入 retro/，到条件出现再立项。

## 阻断项 🔴

无。

## 建议项 🟡 及处置

| # | 问题 | 处置 |
|---|---|---|
| 1 | checklist 引言「全部来自本仓库与同类项目」改为含外部样本，来源标记目前靠条目标题手写，无机器校验 | 不改（延后）：条目来源校验属预防性建设，等第二个外部条目出现再看是否值得 |
| 2 | retro/ 目录首次启用，无既有约定可循 | 不改：候选文件自含「触发条件」列即是对该目录用途的定义，后续自然沉淀 |

## 跨模块影响

CR 模板被 agents.test.sh 的结构断言消费（§0 存在性等）——gate 绿证明教义段（blockquote）未破坏断言。checklist.md 被 SKILL.md Stage 0 引用（条目数在注释里写过「17 个」——注释在 SKILL.md 正文，与 references 实际条数本就解耦，无断言依赖）。

## 结论

🔴 0、🟡 2 已表态。通过。gate 全链 exit 0（A1.log）。
