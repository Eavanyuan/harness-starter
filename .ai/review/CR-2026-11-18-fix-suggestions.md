# CR 代码审查记录 — fix-suggestions：task-loop 建议项修复开关（本地未提交变更）

> 产出：code-reviewer（独立复核）· 本地正式 CR
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。
> 两条路径要求均已满足：`node scripts/resolve-skills.mjs --diff` 已跑（命中 harness v1.1.0），按硬规则表逐条核见 §0。

- 审查范围：baseline `b6b911f`（= 当前 HEAD）工作区未提交 diff：6 文件 +117/−4；另 `.ai/tasks/fix-suggestions/`（state 合规：change tier 2、related task-loop、baseline 一致）与 `.ai/verify/FG1.log` 未跟踪
- 关联 FS：`docs/02-features/task-loop/FS-任务循环执行器.md` §4.4 / §8 / §9；RS：`docs/01-requirements/RS-task-loop.md` US-1 新增行
- 关联 SR 报告：无（S 档，state.meta.affected_ids 已列）
- **已加载的 skill**：harness v1.1.0（命中 `scripts/lib/gitlab-triggers.mjs`、`scripts/task-loop.mjs`、`test/task-loop.test.sh`；Stage 0 三项已读）

## 0 硬规则逐条核（harness v1.1.0）

| # | 规则 | 怎么查（本次实测） | 结果 |
|---|---|---|---|
| H1 | scripts 改动必须同批带测试 | diff 含 `scripts/` 2 文件；`test/task-loop.test.sh` +87/−0，新增 2 个检查（单元 + 端到端），存量断言零改动 | ✅ |
| H2 | 生成物禁手改 | diff 未触 `.claude/`、`.zcode/`、`prompts/`；`npm run check:agents`（68 文件一致）、`check:hooks` 过 | ✅ |
| H3 | 解析失败 fail-closed | 本次无 hook 改动、无 `=== null` 放行新增；`filterSuggestionNotes` 对空 discussions 以 `|| []` 兜底 | ✅（未命中改动面） |
| H4 | 黑/白名单字面量只进 config | `BLOCKING_RE` 是判定正则，与既有动词/结论词正则（:125 LINE_VERDICT 等）同类，非黑名单或受保护区 | ✅（未命中） |
| H5 | skill 结构约束 | `npm run check:skills` 过（harness 79 行） | ✅ |
| H6 | 新增拦截规则须给合法绕过 | 本变更是收窄开关非拦截；开关用法与默认值进 FS §8 配置表 | ✅ |
| H7 | 新 hook 双 CLI 接线 | 无 hook 改动 | 未命中 |
| H8 | 新配置键必须有消费者 | `scripts/task-loop.mjs:281` 消费 `runtime.taskLoop.fixSuggestions`；`npm run doctor`「配置键均有消费者」过（3 条提醒均为预存、与本变更无关） | ✅ |
| H9 | 新断言可证伪 + 变异 | 审阅者在 /tmp 副本实测变异：过滤退化（`notes: d.notes || []`，即不再剔除）→ **122 通过 / 2 失败**，红项恰为本次新增两条检查——与交付主张"过滤退化→2 红"一致 | ✅ |

## 1 改动摘要

把「建议性评审评论是否进修复范围」做成 `runtime.taskLoop.fixSuggestions` 配置开关（默认 true = 2026-11-16 以来行为）：置 false 时 `filterSuggestionNotes` 在触发判定前剔除不带 🔴/阻断/必须修 标记的建议性评论（system 留言与 resolvable 线程天然保留），纯建议的结论评论不再触发；runner 读配置并在关态打提示行。意图对齐用户指令"默认开启，可关闭只修阻塞问题"，RS/FS/配置三处口径一致。

## 2 阻断项 🔴

无。

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | `scripts/lib/gitlab-triggers.mjs:222`（BLOCKING_RE）；FS §4.4、RS US-1 新增行、state.json `known_issues`（空） | off 模式的漏报面未按 harness skill「交付」第 4 项登记剩余风险：实质阻断但表述不带 🔴/阻断/必须修 的评论（如"必须改""不能合入""P0"）会被当建议剔除。RS 以标记为口径，实现与规格一致，但"谁会被误伤、什么形态漏"这一承诺性说明缺位——下一位操作者关掉开关前看不到代价 | 本批补一行：FS §4.4 或 state.json known_issues 写明"off 态以标记为机器判据，无标记的实质阻断表述会漏；正式 CR 结论行按模板通常带 🔴 计数，非正式评审需自担"。可选顺带把 `必须改` 纳入 RE（`/🔴\|阻断\|必须修\|必须改/`，成本一个字符类） | 修 |
| 2 | `gitlab-triggers.mjs:271-273`（过滤位置）+ `:125-150`（reviewVerdictCommentAt）+ `:152-177`（classifyMr） | 代码注释"混排评论里的 🔴 项保留（阻断仍在）"（:272）略超实现：🔴 标记的**普通评论自身不构成触发信号**（触发只认 resolvable / 系统动词 / 结论评论三路，纯评论在任何模式都只随车进 `comments`）。具体形态：off 态、MR 无 resolvable 线程、无新鲜系统动词、结论评论本身不带标记（如"复审结论：Request Changes，X 必须改"——"必须改"不命中 RE）→ 结论评论被剔、vcAt=null → 整条 MR 判 pending 不触发，**即使别处还有带 🔴 的普通评论也一起失去搭车通道**（on 态同 MR 会触发并全部修复）。影响：off 模式下该形态的真阻断 MR 不接单 | 方向（二选一，点到为止）：① off 态把"他人普通评论命中 BLOCKING_RE"升为与 vcAt 并列的触发证据；② 至少随 🟡#1 一并登记该形态为 KI。不阻断本批：默认 true 不受影响、off 是显式选配、正式 CR 结论行大概率带标记 | 延后（登记部分随 🟡#1 同批做） |

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| `scripts/task-loop.mjs`（`fetchTriggers` 唯一调用方） | 默认态不受影响：`fixSuggestions ? rawDiscs : filter(...)`（:273）在 true 分支返回**同一对象引用**，零路径变化；存量 122 用例零改动全绿即证 | 代码 + 复跑 124/0 |
| 新导出 `filterSuggestionNotes` / `BLOCKING_RE` | 仅测试消费，无既有代码引用 | 全仓 grep（scripts/hooks 无其他命中） |
| `harness.rules.json` 消费链 | doctor 全绿；键入库 true 与文档默认值一致 | §0 H8 |
| sweep 关账（`task-loop.mjs:411-462`） | 翻转配置的语义已推演收敛：true→false 时混合账走 `ack_stale` 重认领（指纹变小，重建为只剩阻断项）、纯建议账走 `trigger_gone` 关账（建议已出范围，方向正确）；在途流水仍被 `inflight` 集合保护不误关 | 代码路径逐行读 |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入（SQL / 命令 / 模板） | 无：纯正则判定字符串，无拼接执行 |
| 越权（横向 / 纵向） | 无新权限面：只读轮询路径未变 |
| 敏感信息进日志 | 提示行（`task-loop.mjs:288`）仅含布尔态文案；token 获取路径未动（:281 仅追加一个布尔参数） |
| 依赖变更 | 无 |

## 6 测试覆盖

| 新增行为 | 是否有对应测试 | 备注 |
|---|---|---|
| 过滤纯函数（🔴 保留 / 🟡 剔除 / resolvable、system 保留 / 原数组不动） | ✅ 5s 单元四断言 | `test/task-loop.test.sh:264-292` |
| fetchImpl 三态（纯建议关=不触发 / 阻断开=留 / 阻断关=留） | ✅ | `:295-300` |
| 端到端 false 态（ack 只剩 🔴、🟡 剔除、提示行可见） | ✅ | `:303-352` |
| 默认 true 回归 | ✅ | 存量 122 用例零改动；审阅者复跑 `bash test/task-loop.test.sh` = **124 通过 / 0 失败**（开发方 `FG1.log` 标准头完整、同结果；审阅者裸跑日志在 /tmp 不入库，入库证据仍为 FG1.log） |
| 变异 | ✅ | 见 §0 H9，审阅者复现 |
| 缺口 | — | 🟡#2 形态（无标记结论评论 + 别处 🔴 纯评论）无测试；resolvable 线程内 non-resolvable 回复被剔除无直接测试（该行为语义正确：回复属建议、线程触发由线程首帖承担，且对 GitLab 两种 resolvable 取值形态均成立） |

任务指定五项重点的核对结论：
1. **BLOCKING_RE 漏报面**：存在且未登记 → 🟡#1/#2；以标记为机器口径本身可接受（RS 即如此定义），缺的是把代价写明。
2. **过滤位置在触发判定前的副作用**：动词（`changesRequestedAt`）与批红回放（`approvalFromDiscussions`）只读 `n.system` 留言，filter 无条件保留 `n.system`（:228），**均不受影响**（单测 system-kept 在）；结论评论被剔后 `approvalLastWord` 走向可能由"待修"变"approved"，但两种结果同为不触发，方向正确（无活儿不占账）。
3. **false 态建议评论不进 fingerprint**：正确——指纹是"待修内容投影"（:330-337），建议已出范围则其增删不应重认领；配置两方向翻转均收敛（见 §4 sweep 行）。
4. **skipDrafts/fixSuggestions 叠加**：正交——前者在 MR 层（:268/:295）后者在 note 层（:273），无共享状态；双开关同构 `!== false`、双默认 true，配置表并列成对。
5. **默认 true 无行为变化的验证充分性**：充分——true 分支同一对象引用、提示行仅 `=== false` 打印（:288）、存量 122 用例零改动全绿，代码路径与测试两侧都封死了。

## 7 结论

- 🔴 数量：0
- 🟡 已全部表态：是（修 1、延后 1）
- 建议：**approve**（🟡#1 的剩余风险登记一行，建议随本批顺手补上再合入；🟡#2 登记后延后）
