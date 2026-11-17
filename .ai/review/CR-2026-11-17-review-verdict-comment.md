# CR 代码审查记录 — review-verdict-comment（第三路打回证据：评审结论评论）

> 产出：code-reviewer（独立复核，非实现者自述）· 2026-11-17
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。

- 审查范围：工作树未提交变更 vs 基线 `d078333`（`scripts/lib/gitlab-triggers.mjs` +48 / `test/task-loop.test.sh` +84 / RS US-1 / FS §4.4·§9 / `.ai/verify/RV1.log`；任务 `.ai/tasks/review-verdict-comment/`，change tier 2，关联 task-loop）
- 关联 FS：`docs/02-features/task-loop/FS-任务循环执行器.md` §4.4 / §9
- **已加载的 skill**：`node scripts/resolve-skills.mjs --diff` → **harness v1.1.0**（命中 `scripts/lib/gitlab-triggers.mjs`, `test/task-loop.test.sh`）；Stage 0 三项（checklist / 被改文件全文与调用方 / 对应测试）已读
- 独立核验：`bash test/task-loop.test.sh` 真跑 → **120 通过 0 失败**（13:53:57Z–13:54:10Z 本轮复跑）；两种变异在 /tmp 全量副本上复跑均红；正则误报/漏报面用 node 探针逐条实测（见 §2/§3）

## 0 硬规则逐条核（harness v1.1.0，H1–H9）

| # | 规则 | 检测命令 | 结果 |
|---|---|---|---|
| H1 | 改 `scripts/**` 必须同批新增测试 | diff 里 `test/task-loop.test.sh` +84（5c-quin 六断言 + 5d-quin 端到端） | ✅ |
| H2 | 生成物禁手改 | diff 无 `.claude/` `.zcode/` `prompts/`；无 agent/hook 改动，check:agents/check:hooks 不适用 | ✅ |
| H3 | 解析失败 fail-closed | `reviewVerdictCommentAt` 空 username 抛错（gitlab-triggers.mjs:126-128，同 changesRequestedAt 口径）；正则不命中返回 null=不触发 | ✅ |
| H4 | 名单只写 harness.config.json | 无新增字面量名单（VERDICT_RE 是触发判据不是保护区名单） | 未命中 |
| H5 | skill 体量 | 无 skill 改动（check:skills 不适用） | 未命中 |
| H6 | 新拦截规则同批给合法绕过 | 触发侧规则：不含结论词即不触发，FS §4.4 写明"感谢与提问不算"——**该声称与实测不符（提问句命中），见 🔴1** | 🟡 |
| H7 | 新 hook 双 CLI 接线 | 无 hook 改动（wiring.test 不适用） | 未命中 |
| H8 | 配置键有消费者 | 无配置键新增 | 未命中 |
| H9 | 断言可证伪 + 变异结果 | 本轮复跑：去 vcFresh 信号 → 118/2 红（5c-quin、5d-quin）；去活评论过滤 → 119/1 红（5d-quin）。红性成立 | ✅ |

## 1 改动摘要

闭合 MR !1916 R2 实测盲区：复审者以普通评论发出 Request Changes 结论（动词停留上一轮、无 resolvable 线程）时两路既有信号全盲、19:46 被 sweep 当"触发消失"关账。新增 `reviewVerdictCommentAt`（他人非系统评论含结论词，取最晚）作第三路证据 `vcFresh`（须晚于 lastPushAt），批红须同时晚于动词与结论评论才是"最后的话"；粗筛放行该形态；工单只带晚于 lastPushAt 的活评审评论（R1 旧结论不再混入）。时序组合（动词/评论 × 推送 × 批红九宫格）经代码走查 + 测试核对**完备正确**，未见组合漏洞；粗筛与 CI/inflight 互斥正确（有评审信号的 MR 不查 CI 详情、但仍在触发集不被 sweep 关账，同动词路径既有形态）。

## 2 阻断项 🔴

| # | 位置 | 问题 | 依据 | 建议 |
|---|---|---|---|---|
| 1 | `scripts/lib/gitlab-triggers.mjs:129`（VERDICT_RE），:135 全文子串 test | 结论词正则在**任意位置**子串命中，把"引用旧结论的回复/提问"当成新结论。本轮 node 探针实测（均命中→计为他人结论评论）：①「关于 R1 的 Request Changes：6 条均已核销，无需再改」②「> R1 审查结论：Request Changes⏎以上均已处理，LGTM」（quote 引用行）③「这些就是当时 request changes 的点吗？」。端到端：批红 13:00 + 引用式收尾评论 13:40 → `classifyMr` 返回 `changes_requested/review_comment/triggered=true`——**已批准的 MR 被拉回自动重做**，且该评论晚于批红会顶掉 approvalLastWord（:161-164），评审不再表态就循环到轮次上限 | RS US-1（RS-task-loop.md:20）措辞是"『要求改动』**结论**评论"——引用≠结论，实现超出要求口径；FS §4.4（FS:70）声称"从严匹配……感谢与提问不算"——代码恰恰命中提问，文档与实现不符。场景真实且是本流水线常态：RS US-1 强制作者逐条回复"已确认+修复方案"，评审者回应引用 R1 原文；CR 模板（templates/CR-代码审查记录.md §7 结论区）本身含 "Request Changes" 字样，任何第三方回复粘贴模板文字即触发 | 位置锚定：结论词须出现在行首/标题位（允许 `#`、`R\d+`、`审查/复审结论[:：]` 前缀），引用行（`>` 前缀）不计；或同 body 含"已核销/LGTM/已批/无需再改"类否定线索时不计。注意保住 !1916 实测两条形态——"R2 复审结论：Request Changes…"与"## 审查结论：Request Changes…"都有行首锚点，锚定后仍命中；补"引用回复不触发"反向用例进 5c-quin |

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | `scripts/task-loop.mjs:427-434`（sweep `!cur` → trigger_gone）| 纯评论/动词触发（零 resolvable）的 MR，执行器推修复后三信号全灭 → 按"已合并/已批红/已关闭"关账，实际在等复审；inflight 只保护到流水终态。R3 到来会重触发重认领，环能续上，但关账理由失真、awaiting_rereview 态丢失、budget/TTL 每轮清零。动词路径 2026-11-16 起同形（继承），本变更把该形态扩大到评论触发 | MR 仍 open 且 ack 处 awaiting_rereview 时落"等复审"事件而非 trigger_gone，或关账前单查 MR state 复核 | 修（可与 🔴1 同批，也可独立小改） |
| 2 | `scripts/lib/gitlab-triggers.mjs:266`（commit 走 `optional()` 无痕吞错）| lastPushAt 拉不到时 vcFresh/crFresh 恒真 + 活评论保留全部（:157、:272）→ 瞬断一轮即陈旧结论整体复活、全量进工单。方向本身对（宁可多跑，与 crFresh 同模式，父任务问"是对的方向吗"——是）；但与同文件 CI 详情路径"瞬断 rethrow 软失败保账"（:243-247）哲学不一致 | optional 失败时在 payload 落 `degraded` 标记，或按整源软失败处理（本轮视角不完整 → sweep 不动账） | 延后（先登记，下次动 gitlab-triggers 时统一） |
| 3 | `docs/02-features/task-loop/FS-任务循环执行器.md:70` | 文档失配：①"结论词从严匹配 request(ed) changes/要求改动/打回待修"漏列代码里 `审查结论[:：]request｜复审结论[:：]request` 两个前缀分支；②"从严"与 🔴1 的任意位置命中矛盾；③实测漏报面（requesting changes / changes requested / needs changes / 请修改 / 需要改动 / 打回不带待修 均不命中——node 探针）是明示取舍可接受，但应进 §9 剩余风险点名，且 RS:20"零 resolvable 讨论时**后者**是唯一证据"在三路并列后指代不明 | 修 🔴1 时同步改 FS §4.4 口径与 RS 指代；漏报清单补进 §9 | 修（随 🔴1） |

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| `scripts/task-loop.mjs`（唯一消费者：sweep 指纹 / ack / buildR1ProfileA） | 是——`comments` 从全量变活评论，`triggerFingerprint`（gitlab-triggers.mjs:300+）投影随之收窄：作者自己推送会让旧评论退出活集 → 指纹变化 → sweep 走 ack_stale 重认领（task-loop.mjs:435-446）。行为可接受（重认领后 pending 为当前实况，0 条时落 awaiting_rereview/claim_held），但"待修内容有更新"的日志理由在"内容因自己推送而变少"时失真 | grep 全仓 `reviewVerdictCommentAt/review_comment` 仅 gitlab-triggers.mjs 与 task-loop.test.sh；task-loop.mjs:435/635/662-666 消费 `t.comments` |
| CI 形态 / inflight 互斥 | 否——有评审信号的 MR 在粗筛分支内不查 CI 详情、不进 inflight，但仍在触发集，sweep `!cur` 不成立不关账（task-loop.mjs:427）；无信号 MR 照旧走 CI 详情 + inflight | gitlab-triggers.mjs:234-265 控制流走查 |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入（SQL / 命令 / 模板） | ✅ 正则对 body 只读，无 eval/拼接 |
| 越权 | ✅ n/a（读侧判定） |
| 敏感信息进日志 | ✅ ack/dry-run 只落 body 截断 120 / 摘要（既有行为） |
| 依赖变更 | ✅ 无 |

## 6 测试覆盖

| 新增行为 | 是否有对应测试 | 备注 |
|---|---|---|
| push 后结论评论触发（signal=review_comment） | ✅ 5c-quin r2 | 真实时间线复刻（R1 07:56+动词 09:05+推送 10:16+R2 13:40） |
| 推送前覆盖不触发 / 无结论词不触发 / 本人排除 | ✅ 5c-quin stale/noise/selfC | |
| 批红 × 结论评论先后（双向） | ✅ 5c-quin appr/apprOld | |
| 粗筛放行 + 端到端 ack 只含 R2 活评审 | ✅ 5d-quin | 断言 `!/R1/.test(ack)` 与 pending=1 |
| **引用旧结论/提问不触发** | ❌ 缺 | 即 🔴1 的反向用例，修时必补 |
| 动词+评论+批红三元同场 | ❌ 缺 | 逻辑与两元同构，低优先 |
| lastPushAt=null（commit 瞬断）行为 | ❌ 缺 | 🟡2 场景，补 degraded 时一起 |
| 变异（H9） | ✅ 本轮复跑 | 去信号 → 2 项 check 红（交付称"4 红"为断言级计数：5c-quin 内 2 断言 + 端到端 1，若变异同时去掉 approvalLastWord 的 vc 子句则 4 断言——口径差异非虚报）；去活评论过滤 → 1 红，与交付一致 |

## 7 结论

- 🔴 数量：**1**（结论词正则误报面——引用/提问命中，可把已批 MR 拉回重做；违反 RS"结论评论"口径与 FS"提问不算"自述）
- 🟡 已全部表态：是（3 条：sweep 关账理由 / lastPushAt 瞬断 degraded / FS·RS 文档口径——后两条随 🔴1 同批）
- 建议：**request changes**。时序组合、粗筛、互斥、性能（粗筛每 MR 三趟全文正则，1800s 节拍下可忽略）与 120 绿套件、变异红性均核过没问题；唯独判据本身把"提到结论"当"给出结论"，与本流水线"作者逐条回复→评审引用回应"的强制工作流正面相撞，修一处正则锚定 + 补反向用例即可转 approve。


## 8 二审（2026-11-17 · 独立复核者，验一审 🔴1/🟡#3 处置）

**结论：approve**（一审预留的转 approve 条件「正则锚定 + 补反向用例」均已落地并独立复核）。

**验收一句话**：🔴1 已核销——判据改为行首结论锚定（gitlab-triggers.mjs:134-145），一审四个误报形态全部排除且最坏端到端场景（批红后引用式收尾）不再拉回重做，!1916 R2 真实原文仍触发，120 测试真跑全绿，反向钉经变异验证确实会红。

### 8.1 独立验证记录（本轮 node 探针 + 真跑，非采信交付自述）

| 项 | 方法 | 结果 |
|---|---|---|
| 应命中九形态 | node 探针逐条打 `reviewVerdictCommentAt`：R2 实际原文（ack-1916.json 全文多行）/「## 审查结论：Request Changes」R1 重建/「R2 结论：Request Changes」/小写「结论：request changes」/全角空格 U+3000 前缀（trim 会剥）/多行仅末行是结论/裸 requested changes/**复审结论：要求改动**/「- 打回待修」 | 9/9 命中 |
| 误报五形态 | 同上：一审①引用收尾②> 引用行③提问④结论与 LGTM 并存⑤「Request Changes 的点吗？」 | 5/5 排除 |
| 收紧漏报面（按设计排除，记录不阻断） | 「Conclusion: Request Changes」英文标签/「R2: Request Changes」冒号速记/「复审：Request Changes」无「结论」字标签/同行含 approve 被否定词挤掉 | 4 形态不命中，见 8.2-值得考虑 |
| 残存误报面（同上） | 「Request Changes 的点都已核销」（行首旧结论+核销陈述）/「**Request Changes？**」（问号不在行尾） | 2 形态仍命中，见 8.2-值得考虑 |
| 端到端 E1（一审最坏场景） | 批红 13:00 + 引用式收尾 13:40 → `approved/approval/triggered=false` | ✅ 不再拉回重做 |
| 端到端 E2/E3 | 批红 13:00 + R2 真结论 13:40 → changes_requested/review_comment；!1916 复刻（零 resolvable 零动词、R2 晚于 push）→ 触发 | ✅ 真打回仍可见 |
| 测试套件 | `bash test/task-loop.test.sh` 本轮真跑 | **120 通过 0 失败**（RV1.log 14:09Z 亦 exit 0、标准头在） |
| 变异红性（本批新钉） | /tmp 全量副本把判据退回一审前「全文子串」→ 五个误报形态全部复活（即 5c-quin 四钉必红） | ✅ 钉会咬，非摆设 |
| 真实形态未被挤掉（③） | R2 代：ack-1916.json 原文「## R2 复审结论：Request Changes（R1 主面已核销…）」命中；R1 代：原文档案已被 R2 轮覆盖、不在 git 历史，**未能核到原文**，以 5c-quin 重建形态「## 审查结论：Request Changes（1 阻断 + 6 建议）」代验命中 | ✅（R1 见 8.3 未覆盖） |
| 🟡#3 文档同步 | FS §4.4（FS:70）行首锚定口径+排除项+lastPushAt 剩余风险已写；FS §9（FS:254）误报四连钉+九形态已记；RS:20 已改「判据为行首结论锚定——引用/提问/LGTM 并存行不算」 | ✅ 口径一致 |

### 8.2 新发现

- **值得考虑（1 条，文档完整性）**：FS §9 剩余风险未点名判据的双向残面——①一审 🟡#3 明确要求的旧词面漏报清单（requesting changes / changes requested / needs changes / 请修改 / 需要改动 / 打回不带待修）没进 §9；②本轮收紧新增的漏报形态（英文 `Conclusion:` 标签、`R2:` 冒号速记、`复审：` 无「结论」字）与残存误报形态（行首旧结论+「都已核销」陈述、问号不在行尾的加粗问句）也无记录。位置 `docs/02-features/task-loop/FS-任务循环执行器.md` §9:254。建议：§9 补一行「判据残面」清单，把上述六漏报两误报一次点名，后来者误改判据前有对照。
- 仅记录：一审建议的「已核销 类否定线索不算结论」**不可照抄**——R2 真实原文结论行内就含「R1 主面已核销」（ack-1916.json），把「已核销」加进 NOT_VERDICT 会把真实打回挤掉；实现只排除 LGTM/无需修改/可以合入/approve 是对该建议的正确裁剪，此处留档防止后人补刀。
- 仅记录：5d-quin 的 R1 mock 仍是旧速记体「R1: Request Changes（6 建议）」（新判据下不命中）；该测试里 R1 靠时间过滤（早于 push）出局、断言不依赖其命中，行为正确，但作为「R1 代形态样本」会误导后来读者。
- 仅记录：一审 🟡#1（纯评论触发 MR 被 sweep 按 trigger_gone 关账、理由失真）本批未修——处置口径允许延后，仍开放，建议下次动 task-loop.mjs 时带上。

### 8.3 审阅范围与未覆盖

- 核对了：🔴1 处置的实现与规格逐项对照（行首锚定/标题/加粗/R\d 轮次/结论标签前缀、> 引用、疑问句、四否定词）；20 形态探针 + 3 端到端；测试套件真跑；变异红性；R2 真实原文命中；FS/RS 口径同步。
- 未核到：yqli R1 代结论评论**原文**（pack/ack-1916 被 R2 轮覆盖、无 git 历史），以测试重建形态代验；🟡#2（lastPushAt 瞬断 degraded）维持延后口径未复验；未重跑 doctor/wiring（本批无 hook/配置改动，不适用）。
