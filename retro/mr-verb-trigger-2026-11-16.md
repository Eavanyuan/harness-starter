# Retro：mr-verb-trigger（2026-11-16）

## 事故形态

MR !1882 被 yqli 以「普通评论 + approve→unapprove + requested changes」打回，task-loop runner 两小时一轮照跑却零触发——**不是没轮询到，是轮询到了但判定看不见**。触发器预期的信号形态（他人未解决 resolvable diff 讨论）与真实评审习惯不匹配：评审人把意见写在普通评论里，整条 MR 零 resolvable，`classifyMr` 判 `pending`，`fetchTriggers` 的热路径粗筛甚至更早 `continue` 掉。

## 三条教训

1. **对外部系统行为的假设必须用 live 数据校验一次**。触发器写完时 17 条断言全绿——全绿只证明「在假想的信号形态下判定正确」，没证明「真实评审长这样」。信号形态假设错了，断言越严越是自嗨。此后接外部系统的判定逻辑，合入前拿一条真实事件跑一遍 `fetchTriggers`（本次修复的实跑复验就是这个动作的常态化）。
2. **声明与断言要一一对应（CR R1）**：`fromComments→ack` 合并写进了文档和 state 的「已验」，但没有任何断言能红——删掉那行套件照样全绿。「文档说验过」而「变异杀不死」= 没验。CR 用变异一击命中，九处变异登记进 MV1 audit。
3. **自引用证据的生成顺序**：`npm run gate` 会校验本任务所有 verify 日志，包括 gate 自己的那份——日志还没生成就先判「不存在」。解法是自举顺序：gate 日志先由 verify-run 生成（此刻 state 里该 todo 还不存在/pending 被跳过），生成后才把 todo 写进 state（CLOSE-GATE 模式，local-cr-gate 同款）。

## 流程侧

- change 流程（--related task-loop --baseline）走通：影响链四件（RS US-1 验收行、FS §4.4、FS §6 矩阵、代码+测试）同批落。
- S 档收尾三件套实测：rs 一段话（模板章节补齐才过完备性）、CR 两轮（独立审阅者 + §0 硬规则表 + 变异）、CLOSE-GATE 日志（S 档折叠 ci 的仓内等价物）。
- 遗留：KI-2（老版本 GitLab 无动词系统留言时普通评论表态仍不可见）acknowledged——那是修复前就存在的形态，diff 讨论路径不受影响；KI-1 已闭环（建议性评论进 ack）。
