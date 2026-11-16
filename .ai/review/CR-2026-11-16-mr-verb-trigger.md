# CR 代码审查记录 — mr-verb-trigger：MR 打回触发补 requested changes 动词证据（本地独立审查）

- 审查范围：`git diff HEAD` —— scripts/lib/gitlab-triggers.mjs、scripts/task-loop.mjs、test/task-loop.test.sh、docs/01-requirements/RS-task-loop.md、docs/02-features/task-loop/FS-任务循环执行器.md；新文件 docs/01-requirements/RS-mr-verb-trigger.md、.ai/tasks/mr-verb-trigger/state.json；同批证据日志 .ai/verify/MV1.log、MV2.log（头部已核）
- 关联 FS：docs/02-features/task-loop/FS-任务循环执行器.md §4.4 / §9
- 关联 SR 报告：docs/01-requirements/RS-mr-verb-trigger.md（本任务新建）
- **已加载的 skill**：`resolve-skills --diff` 命中 harness v1.1.0 —— .skills/harness/SKILL.md（Stage 0 已完成）+ references/checklist.md + references/test-quality.md
- 审查日期：2026-11-16 · 审查方式：只读仓内文件；测试与变异在 /tmp 副本上跑（仓内零改动）

## 0 硬规则逐条核（harness skill H1–H9）

| # | 规则 | 检测方法（本 CR 实际执行） | 结果 |
|---|---|---|---|
| H1 | 改 `scripts/**` 同批新增测试场景 | diff 命中 scripts/ 2 文件；test/task-loop.test.sh 同批 +90 行（5c-bis/ter/quater 三节） | ✅ 字面满足；**但 task-loop.mjs:426 新增的 ack 合并分支无对应断言（见 🔴1）** |
| H2 | 生成物禁止手改 | 实跑 `npm run check:agents && npm run check:hooks` | ✅ 68 个文件与源一致；hook 接线与 manifest 一致（diff 未触 agents/hooks/生成物） |
| H3 | 解析失败 fail-closed | 检视新增三函数：unresolvedByOthers / reviewCommentsByOthers 空 username 均抛错；无 `return 0` 伪装放行 | ✅（changesRequestedAt 空 username 静默跳过过滤，当前调用图不可达，见 🟡2） |
| H4 | 名单/保护字面量只在配置 | diff 无黑名单/路径字面量新增 | ✅ 未命中 |
| H5 | skill Stage 0 ≤5 项 / ≤200 行 / ≤2 层 | 无 skill 文件改动 | 未命中 |
| H6 | 新拦截规则配「合法绕过」 | 本变更是触发规则非拦截规则；误触发出口存在：动词早于 push 自动失效（crFresh，gitlab-triggers.mjs:125）；老 GitLab 残余盲区已登记 KI-2 | ✅ |
| H7 | 新 hook 双 CLI 接线 | 无新增 hook | 未命中 |
| H8 | 配置键必须有消费者 | diff 未触 harness.config.json / harness.rules.json；RS §4「零新配置键」声明与 diff 一致 | ✅ |
| H9 | 断言可证伪 + 变异结果 | **实跑 8 组变异**（详见 §6 矩阵）：gitlab-triggers 相关 7 组全部落红、无一静默未生效；整体退回旧实现（m0）时恰好三条新用例全红、存量 86 条保持绿（「先红后绿」声明成立）；**M7 删掉 task-loop.mjs:426 后 89/89 仍全绿——变异存活 = ack 合并无断言** | ⚠️ gitlab-triggers 断言全部可证伪 ✅；task-loop ack 分支无断言可证伪 → 🔴1 |

## 1 改动摘要

两路变更：① `classifyMr` 打回证据从单路（他人未解决 resolvable 讨论）扩为两路并列——新增「他人晚于末次 push 的 requested changes 动词」（GitLab 16+），批红须同时晚于 push **和**晚于动词才算「最后的话」（gitlab-triggers.mjs:123-137）；`fetchTriggers` 热路径粗筛同步放行动词型 MR（:190），修复 MR !1882 形态（普通评论 + 撤批 + 动词、零 resolvable）打回不可见的事故。② 新增 `reviewCommentsByOthers`（:86-104）把评审人建议性普通评论（non-resolvable）送进触发 payload `comments`，runner 侧并入 ack 待修清单（task-loop.mjs:425-427）。同批更新 RS/FS 影响链文档与三节测试。变更意图与 RS-mr-verb-trigger.md 一致。

## 2 阻断项 🔴

| # | 位置 | 问题 | 依据 | 建议 |
|---|---|---|---|---|
| 1 | `scripts/task-loop.mjs:426-427`；证据链：`.ai/tasks/mr-verb-trigger/state.json:147`（KI-1）、`state.json:89`（MV1 audit）、`docs/02-features/task-loop/FS-任务循环执行器.md:237`（§9 矩阵行）、`docs/01-requirements/RS-mr-verb-trigger.md:21/31`（验收 6 / R-V4 P0 后半） | **ack 合并分支零测试覆盖，且证据链声称已测。** 变异 M7 实测：把 `fromComments` 整行替换为 `const fromComments = []` 后 `bash test/task-loop.test.sh` 仍 89/89 全绿——删除该行为没有任何断言会红（T1 形态：改了逻辑、无断言）。而 state.json KI-1 写「fixed：MV1 建议性评论进 ack（**5c-quater 断言**）」、MV1 audit/feature_complete 写「进 payload comments **与 ack**」、FS §9 断言列写「进 payload `comments` **与 ack**」——5c-quater 的 ok2 只断言 payload（`out[0].comments.length === 1`），从头到尾没有一条用例断言 ack 文件/消息包含 `source:'comment'` 条目。RS R-V4 是 P0，其后半（并入 ack 待修清单）实际未验证；MR !1882 事故形态（unresolved=0、comments=1）走 runner → `ack-${id}.json` 的端到端路径零覆盖（5d/5e 的 fixture 均为 resolvable 形态，comments 恒为空） | H1（scripts 改动须同批测试）、H9/T7（变异存活=断言不存在）、test-quality T1；checklist #30「规则写了但没有用例」+ 本仓证据链纪律（声称的验证必须真实存在） | 补一条端到端用例（仿 5d：假 GitLab 返回「普通评论+动词」fixture，断言 ack 文件含 `source:'comment'` 条目与「N 条待修意见」计数），或最小化在 5c-quater 里 spawn runner 断言 ack 落盘；同批更正 state.json KI-1/MV1 audit 的断言归属描述，重跑 gate 后再审 |

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | `test/task-loop.test.sh`（diff 首行：old mode 100755 → new mode 100644） | 测试文件丢执行位。已核全部调用方（package.json test:task-loop、.github/workflows/quality-gate.yml:101、WBS 文档）均为 `bash test/...` 调用，无功能影响 | 恢复 755，与仓内混合现状的其他可执行测试一致 | 修（一行 `chmod`） |
| 2 | `scripts/lib/gitlab-triggers.mjs:68` | `changesRequestedAt` 收到空 username 时静默不过滤自发动词（`username = null` 默认值 + truthy 判断），与同文件 `unresolvedByOthers` / `reviewCommentsByOthers` 的「空值即抛」fail-closed 口径不一致。当前调用图不可达（两处调用方上游都会先经 `unresolvedByOthers` 抛错），但它是导出函数，未来单独调用会反向判定 | 空/空白 username 时抛错，与另两函数同口径 | 延后（不可达路径，随 🔴1 的同批测试顺手收紧） |
| 3 | `scripts/lib/gitlab-triggers.mjs:93-94` | comments 去重口径是「线程含**任一** resolvable note 即整线程跳过」，比 FS §4.4 所述「已在 unresolved 的讨论不双列」更宽：resolvable 线程被 resolve 后评审人追加的普通评论、以及线程内 non-resolvable 回复，既不进 unresolved 也不进 comments，会漏出待修清单（推测依赖 GitLab discussions API 中线程回复的 resolvable 取值，该外部形状本次未实测） | FS §4.4 边界注明该口径；或用真实 MR 后续数据复核一次线程内回复形状后再决定是否细化 | 延后（低概率形态；先在文档写明） |
| 4 | `scripts/task-loop.mjs:334/336` | dry-run 文案与 shadow.jsonl 统计仍只数 `t.unresolved.length`：动词型触发（!1882 形态）dry-run 会打「修复 0 条未解决讨论」、shadow 记 `unresolved: 0`，与 ack 实际待修（建议性评论）不一致——ack 文件本身是对的，展示面漏改 | dry-run 文案与 shadow 统计改为 `unresolved.length + (comments?.length ?? 0)` 或分别列示 | 修（展示层两行；不影响判定） |

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| `scripts/task-loop.mjs:225`（runner 调 fetchTriggers） | 已适配 | payload 新增 `comments` 为增量字段；runner 用 `t.comments || []` 防御（:426），feishu 触发源无该字段不受影响（:308 构造无 comments） |
| shadow 写入 / dry-run 文案（task-loop.mjs:325/334/336） | 漏适配 | 只数 unresolved，见 🟡4 |
| 全仓其他调用方 | 无 | grep 全仓：`fetchTriggers`/`classifyMr`/`changesRequestedAt`/`reviewCommentsByOthers` 仅 gitlab-triggers.mjs 自身、task-loop.mjs:225、test/task-loop.test.sh 引用（.zwork/ 为产物，非源码） |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入（SQL/命令/模板） | ✅ 评论正文仅经 `JSON.stringify` 落 ack 文件、`slice(0,120)` 进控制台；无 eval/拼接执行 |
| 越权（横向/纵向） | ✅ 不适用——runner 沿用既有 token 只读拉取，无新增写操作 |
| 敏感信息进日志 | ✅ 无新增凭据打印；ack 文件含 MR 评论正文（业务数据，预期落点 `.ai/task-loop/`） |
| 依赖变更 | ✅ 零依赖变更 |

## 6 测试覆盖

新增行为 vs 用例（全部实跑验证）：

| 新增行为 | 对应测试 | 变异证据（/tmp 副本实跑） |
|---|---|---|
| classifyMr 两路并列 + 批红须晚于动词（L1-L5 五形态） | 5c-bis（test:209-234） | m1（approvalLastWord→approval.ok）红；m3（去本人过滤）红；m6（第三分支退回）红 |
| fetchTriggers 粗筛放行动词型 + 无信号省 API | 5c-ter（test:236-262） | m2（粗筛去动词）红；m6 红 |
| reviewCommentsByOthers 收/不收/不双列/空 username 抛错 | 5c-quater ok1+threw（test:264-299） | m4（双列）红；m5（收自发）红 |
| payload.comments 携带（端到端 fetchTriggers） | 5c-quater ok2 | m0（整体退回旧实现）红 |
| **fromComments → ack 待修清单（task-loop.mjs:426）** | **无** | **m7（删除该行）存活：89/89 仍全绿** → 🔴1 |
| 存量五形态不回归 | 5c | m0（退回旧实现）下仍绿 ✅ |

变异矩阵汇总（m0=整体退回旧实现，m1-m6=单点变异，m7=删 ack 合并；`red_checks`=落红的 check 数）：

| 变异 | 内容 | 结果 | state.json 声明 |
|---|---|---|---|
| m1 | approvalLastWord 退回 approval.ok | 红 2（5c-bis + 5c-quater） | 声明「批红不看先后=1」——**实测 2，声明少计**（保守方向偏差；修 🔴1 时顺手更正 audit 数字） |
| m2 | 粗筛去动词条件 | 红 1（5c-ter） | =1 ✅ |
| m3 | 动词去本人过滤 | 红 1（5c-bis） | =1 ✅ |
| m4 | 评论双列 | 红 2（5c-quater + 5d） | =2 ✅ |
| m5 | 评论收自发 | 红 1（5c-quater） | =1 ✅ |
| m6 | pending 分支退回 | 红 2（5c-bis + 5c-ter） | =2 ✅ |
| m0 | 整体退回旧实现 | 红 3（恰为三条新用例），存量 86 全绿 | 「先在旧实现上红，修后绿」声明 ✅ 成立 |
| m7 | 删 task-loop.mjs fromComments | **0 红（存活）** | ——（证明 ack 无断言，🔴1） |

已验证（实跑并看到结果）：`bash test/task-loop.test.sh` 89/89、exit 0；`npm run check:agents` / `check:hooks` / `verify:state` 全过（verify:state 的 3 条 `!` 告警均为存量他任务与仓外未跟踪文件，非本 diff 引入）；MV1/MV2.log 头部含 verify-run 标准头（`# commit: unknown` 系 verify-run.sh:76 注明的工作流常态）。

未验证：`npm run gate` 全量（任务自身 CLOSE-GATE todo 尚 pending，归任务收尾而非本 CR）；`check:skills`（无 skill 改动，未跑）；真实 GitLab 行为（全部结论基于假 fetchImpl/本地假服务器）；🟡3 的前提（GitLab 线程内回复的 resolvable API 形状）未实测。

文档一致性核对（要求 ③）：RS-mr-verb-trigger 六条验收逐条对代码——验收 1/2/3/4/5 前半、存量不变均有实现+用例 ✅；验收 5 后半（ack）与 R-V4 后半为 🔴1；FS §4.4 判定段/输出行、RS-task-loop US-1 追加行与代码行为一致 ✅；FS §9「建议性评论」行的断言列声称 ack 覆盖（失真，🔴1）。

边界核对（要求 ④）：空 username（3c + 5c-quater threw，🟡2 为导出函数例外）；/approvals 降级（无批红时间 → approvalValid task-loop-core.mjs:42 判不过 → 不给 approved，动词在场时正确落 changes_requested；lastPushAt 为 null 且降级有名单时新守卫恰好兜住，检视确认）；动词早于 push（L3 + crFresh）；评论与 unresolved 双列（线程级跳过，🟡3 为口径过宽边界）。

范围外备忘（非本 diff，仅记录）：未跟踪文件 `tdasset-fix-review.md`、`.ai/review/CR-2026-11-16-未提交代码与CR流程验证.md`、`.ai/verify/CR2D.log` 不在本次审查范围；ci-verify 已提示 tdasset-fix-review.md 未声明进任何 TODO。

## 7 结论

- 🔴 数量：1（ack 合并零覆盖 + 证据链声称已测）
- 🟡 已全部表态：是（修 ×2 / 延后 ×2，理由见 §3）
- 建议：**打回，修改后重审**。gitlab-triggers.mjs 的判定改动本身质量高（边界齐全、文档同步、七组变异全红）；阻断点集中在 task-loop.mjs 的 ack 合并无断言与 state/FS 的证据失真——补一条端到端用例 + 更正 state 描述 + 重跑 gate 即可重审。approve 权在人。

## 一轮处置（orchestrator 2026-11-16）

| 项 | 处置 | 验证 |
|---|---|---|
| 🔴1 fromComments→ack 零覆盖 | 新增 5d-bis 端到端：动词型触发（零 resolvable、1 条建议性评论）→ runner 落 ack-13.json 必含 source=comment 该条 | 变异：fromComments 置空 → 5d-bis 红（实测 1 红）；恢复后 90/90 绿 |
| 🟡1 test/task-loop.test.sh 丢执行位 | chmod 755 恢复 | ls -l 确认 -rwxr-xr-x |
| 🟡2 changesRequestedAt 空 username 静默 | 改为抛错，与 unresolvedByOthers / reviewCommentsByOthers 同口径 | 5c-quater 断言 threwVerb；变异：移除 throw → 红（实测 1 红） |
| 🟡3 评论去重按整线程跳过 | 改 note 级过滤：resolvable note 不双列，但同线程普通回复（non-resolvable）也收 | 5c-quater 断言 rc5（resolvable 线程内普通回复进清单）；变异：退回整线程跳过 → 红（实测 1 红） |
| 🟡4 dry-run/shadow 只数 unresolved | shadow.jsonl 增 comments 字段；dry-run 文案改"修复 N 条未解决讨论 + M 条建议评论" | 5d-bis 断言 msg-ok（"1 条待修意见"） |

一轮 verdict：打回（🔴1）→ 二轮复核待出。

## 二轮复核（reviewer 2026-11-16）

**verdict：可交付。** 五项处置全部闭环。套件 `bash test/task-loop.test.sh` 90/90、exit 0（仓内实跑）；四组变异均在 /tmp 副本实测（仓内零改动），红数与处置表声明一致。

- 🔴1 ✅ 5d-bis 端到端真实断言 ack 落评论：spawn 真实 runner → 断言 ack-13.json `pending[0].source='comment'` + 计数 1 + 文案「1 条待修意见」；变异实测 fromComments 置空 → 恰 1 红（5d-bis），未变异 90/90。state KI-1 / MV1 audit / FS §9 断言归属已更正为 5d-bis，与实测一致。
- 🟡1 ✅ test/task-loop.test.sh 执行位 755（-rwxr-xr-x；git diff --summary 无 mode 行）。
- 🟡2 ✅ changesRequestedAt 空/空白 username 抛错（与另两函数同口径）；5c-quater threwVerb 断言；变异移除 throw → 1 红。
- 🟡3 ✅ 去重改 note 级（resolvable note 不双列、同线程普通回复也收）；5c-quater rc5 断言；变异退回整线程跳过 → 1 红；FS §9 已写明 note 级口径。
- 🟡4 ✅（附遗留）dry-run 文案与 shadow.jsonl 实测含 comments：「修复 0 条未解决讨论 + 1 条建议评论」、shadow 记 unresolved:0 + comments:1（/tmp 直接行为验证）。

遗留（不阻断，建议 CLOSE-GATE 顺手处理）：① 🟡4 展示面无测试守护——变异退回旧文案并删 shadow comments 字段后套件仍 90/90 全绿；处置表所记验证（msg-ok）实为认领路径断言，归属错位；建议补一行 dry-run/shadow 断言。② MV1 audit「批红不看先后=1」实测为 2（5c-bis + 5c-quater；少计，保守方向偏差，未更正）。
