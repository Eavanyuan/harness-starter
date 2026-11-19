# 架构体检 A —— 自洽性与逻辑混乱审计

> 审计者：独立审阅会话（2026-11-19）。只读仓库 + /tmp 实验，未改任何被审文件。
> 判据标准：材料未给显式验收清单，按任务六项必查面自拟核对清单（门禁矛盾 / 状态机 / 双源真相 / AGENTS 一致性 / hooks 与 task-loop 交互 / 术语），每条发现须有 file:line 或当轮实测输出。
> 分级：🔴 概念冲突（两套机制/规则对同一事实给出矛盾裁决）｜🟡 不一致（口径漂移、无牙规则、失配）｜🟢 轻微（分层与观感）。

## 结论速览

- 🔴 ×3：retro 豁免双标准、提交身份规则自违、时间戳纯声明且自相矛盾。
- 🟡 ×5：账目五态无转换表且三处口径不一、scripts/lib 五模块无消费者（其一被 FS 写成在跑）、no_doc_reason 无牙、architect agent 未接线、术语一词三义。
- 🟢 ×4（含两条正面结论）。
- 总体自洽度：**5.5 / 10**。核心机制（判据库单源、CAS 认领、证据链头格式）内部高度自洽且有大量防漂移设计；但「规则文本承诺的机制」与「代码实际判定的口径」存在系统性脱节——五处 🟡 全是同一病根（规则先写、判据后补、无人回写），其中 retro 豁免一处已连咬三次仍未修。

---

## 🔴 概念冲突

### R1. retro 豁免：同一份 state，两条门禁规则给出相反裁决（已连咬三次，坑还在）

**位置**：`hooks/lib/verify.mjs:751`（checkStage 认 `waived_by`）、`scripts/ci-verify.mjs:166`（waived/deferred 必须记名——门禁自己要求这个字段存在）、`hooks/lib/verify.mjs:840-880`（checkRetroLanding 不读它）。

**证据**：
- 机制 A：`checkStage` 对非相邻跳阶只要求 `waived_by` 具名即放行（verify.mjs:751-757）；`ci-verify.mjs:166` 进一步把「`gate === 'waived' || 'deferred'` 且 `waived_by` 为空」判 fail——**门禁体系认可并强制 retro 站写 deferred+具名豁免这种形态**。
- 机制 B：`checkRetroLanding`（verify.mjs:840）对 `stage=done` 只认两条豁免：`isAbandoned`（:842）与 `created_at < retroCheckFromDate`（:845）——**不看 stage_history 里 retro 站的 deferred/waived_by**。
- 实测（/tmp 构造，2026-11-19）：

```
state = { stage:'done', created_at:'2026-11-18…', stage_history:[…, {stage:'retro', gate:'deferred',
         waived_by:'S 档：纯阈值变更无新教训；CR 已记录'}, {stage:'done', gate:'pass'}] }
checkStage(state)       → []            （豁免被认可）
checkRetroLanding(state)→ [{rule:'retro', reason:'stage=done 但找不到 retro 落盘…'}]  （豁免被拒绝）
```

- 受害实录：`.ai/tasks/poll-30m/state.json`、`.ai/tasks/review-verdict-comment/state.json`、`.ai/tasks/draft-skip/state.json` 三份的 retro 站全部是 `gate:'deferred'` + 具名 `waived_by`，最终全靠补写 retro 文件了事；`retro/draft-skip-2026-11-18.md` 教训 4 自述「retro 豁免坑第三次（poll-30m、review-verdict-comment、draft-skip）：waived_by 形式 ci-verify 不认——系统性修复应立项，不再逐个补」。
- 工具链已事实上选边：`scripts/lib/cli/close.mjs:67-76` 现在无条件自动生成 `retro/<slug>-收尾.md` 模板并记 `gate:'pass'`——工具按「retro 不可豁免」运作，但规则层仍接受 deferred 输入。

**影响**：任何 agent 按机制 A 的合法形态写 state（且 ci-verify:166 还要求它必须具名），都会在机制 B 处被拦；错误信息只说「找不到 retro 落盘」，不指向「豁免不被认」这个真因——第四次被咬只是时间问题。

**谁错了**：豁免通道是通用机制且被显式校验，retro 落盘判据（P1-②，11-11）是后来独立加的，加的时候没回看豁免通道——两条都对各自的输入负责，从未互相校准。以 close.mjs 的现行行为为准，仓库的真实意图是「retro 不豁免、只落文件」。

**修法（一句）**：在 `checkStage`/`ci-verify` 直接拒绝 retro 站的 `gate:'deferred'`（与 close.mjs 现行口径对齐），或让 `checkRetroLanding` 认 retro 站 deferred+具名为放行——两条路任选其一，消灭「一个字段两套裁决」。

### R2. AGENTS.md 规则 9「历史 zwork 提交不再新增」——规则落地后自己新增了 4 条

**位置**：`AGENTS.md:20`（规则 9）；git 历史。

**证据**：
- `d078333`（2026-11-17，two-day commit audit，身份规则即此提交加入）之后：`f4f23b2`、`45dbc58`、`557d8b9`（均 11-18）、`ad15bff`（11-19）四条提交 author 全是 `zwork <zwork@local>`（`git log --format="%h %ad %an" --date=short d078333..HEAD | grep zwork`）。
- 全仓身份分布：Yuan Yuan 79 / **zwork 53** / harness 11。这四条对应任务（architect-agent、deploy-skill、work-hours-window）均为 agent 驱动任务，无一走「显式 `GIT_AUTHOR_*` env 覆盖」。

**影响**：规则以「硬规则」身份写在每次会话都读的常驻文件里，却连着三天被每天违反——读者会学会「硬规则不硬」，进而怀疑其余八条的实际效力（狼来了效应作用于整个规则区）。

**修法（一句）**：把身份注入下沉为机制（如 `scripts/lib/cli/*` 的 close/runtime 出口统一以 env 代跑 git commit），或把规则 9 降级改写为「允许 zwork 身份、追溯只认 state.json+CR」——保机制或删规则，不留天天被违反的文本。

### R3. gate_result 与全部 stage 时间戳是纯声明：不校验格式、不校验单调性，且已自相矛盾到可证伪

**位置**：`hooks/lib/verify.mjs:795-810`（stageGate 只透传 `last_check`，不解析）；`scripts/ci-verify.mjs`（只判 `checks[].pass` 与 `gate.stage` 匹配）；31 份 state.json。

**证据**：
- `gate_result.last_check` 字面垃圾入库且 CI 全绿：`.ai/tasks/cr-gate-round2/state.json` 的 `last_check: "2026-11-11T05:2x"`（字面 `2x`）；`.ai/tasks/deferred-fixes/state.json` 的 `"2026-11-11"`（裸日期，无时间）。
- 时间倒挂 19 处（stage 进入早于任务创建；`created_at` 为 init-harness 机器写的秒级真值，stage 时间戳为手填的整十分钟计划值）：

| 任务 | created_at | 最早倒挂 stage | 差值 |
|---|---|---|---|
| ci-fail-trigger | 2026-11-17T06:26:18Z | rs 06:10:00 | −16 min |
| ci-green-hold | 2026-11-18T08:41:06Z | rs 07:20:00 | −81 min |
| fix-suggestions | 2026-11-18T07:41:36Z | rs 04:30:00 | −192 min |

（脚本核对全部 31 份 state 的 created_at × stage_history.entered_at，仅列存在倒挂者；「任务还没建，rs 已开跑 3 小时」是手填计划值的直接自认。）
- 同批任务的 stage_history 时间戳全是 `:00` 整分（poll-30m：13:20/13:25/13:25/13:25/13:25/13:45…），与 created_at 的秒级精度属两套时间轴。
- 声明型门禁的实际效力实测：`node scripts/ci-verify.mjs` 对上述全部任务 **exit 0**——机器只拦「自己承认 fail」的记录，格式垃圾与时间倒挂畅通。

**影响**：证据链的头格式（exit_code/commit/tests/task）有严格的机器校验，而「什么时候评估的」完全靠自觉——两日审计靠时间戳做账时（cr-2day-audit 正是这类任务），输入本身不可信；`stage_gate` 的「过期结论不能顺延」判据（ci-verify #20）比较的是 stage 名，不是时间，绕过手段是手改 stage 名。

**修法（一句）**：给 `last_check/entered_at/exited_at` 加两道纯机器判据——ISO8601 正则 + `entered_at ≥ created_at` 单调性，解析失败按 stage 非法同款 fail（与 TODO_STATUSES 枚举闭合同一哲学，几行代码）。

---

## 🟡 不一致

### Y1. 账目五态：无转换表、FS 同文档两份清单、执行器 prompt 零状态、飞书账目永远无状态

**位置**：`scripts/task-loop.mjs:698`（working/awaiting_rereview/inherited_only 写入）、`:672`（needs_human）、`:473-474`（awaiting_review，sweep CI 绿）；`docs/02-features/task-loop/FS-任务循环执行器.md:69`（五态齐全）vs `:101`（仍只写两态「state（working/awaiting_rereview）」）；`scripts/lib/session-pack.mjs:15-25`（PROTOCOL_COMMON 无任何状态概念）。

**证据**：
- 状态机没有独立实现：五态的转换完全隐含在 sweep/claim/escalation 分支里，全仓不存在一张转换表（代码或文档皆无）；消费侧只有一个读取点 `a.state !== 'awaiting_review'`（task-loop.mjs:473）——`awaiting_rereview`/`inherited_only` 是**只写不读**的标签（grep 全 scripts/hooks，ledger-report/doctor/architect-check 均不读）。
- FS:69 说 awaiting_review「适用于**一切**已认领账目（含 awaiting_rereview/needs_human）」，但 sweep 对非 `mr-` 前缀直接 `continue`（task-loop.mjs:450）——现存两份飞书账目 `.ai/task-loop/ack-7167752069.json`、`ack-7167910546.json` 连 `state` 字段都没有（旧格式，永不迁移）。
- 升级文案与次日变更打架：task-loop.mjs:675「人工处置后推新流水或关 MR **即自动关账**」——ci-green-hold（11-18）后，推新流水若转绿是转 `awaiting_review` **保持**（FS:69/260：离开 opened 列表才关账），若仍红则按累计轮次直接再升级；两个分支都不「关账」。
- 执行器分层本身正确（账目归 runner，协议只管 todo/acks/resolves/round-N 四件产物），但 CI 转绿时 runner `rmSync pack-<id>.md`（工单撤销，:455）对**正在按 pack 干活的交互会话**没有任何通知通道——状态变了，唯一感知方式是下次碰巧再读 ack。

**影响**：五态 × 四路信号的语义层次本来就重（共享背景④），再叠加「文档两份清单、飞书侧永远两态、一条过期文案」，接手者无法从任何单一位置读到真实状态机。

**修法（一句）**：把五态转换画成一张表收进 FS §4.4 单点（删 :101 的两态旧清单），sweep 对 task-* 补写 state 字段，:675 文案改成「转绿转等评审、合并/关闭才关账」。

### Y2. scripts/lib 分层被五个零消费者模块架空，其中 ci-watch 被 FS 写成在跑

**位置**：`scripts/lib/attribution.mjs`（75 行）、`baseline.mjs`（59）、`ci-watch.mjs`（29）、`fingerprint.mjs`（70）、`scripts/lib/cli/decisions.mjs`——grep 全仓（scripts/*.mjs、hooks/**、deploy/**）零生产 import，仅 `test/task-loop.test.sh` 引用。

**证据**：
- 「scripts=入口、lib=被引用的库」的分层原则下，这五个模块是死代码或「已设计未接线」的暂存——但仓库没有任何标记区分两者。
- 归因存在**两套并行实现**：生产的 `ci-failures.mjs:156 attributeCi`（task-loop.mjs 实际调用）与只有测试的 `attribution.mjs:16 decide`（T4b 三分流+豁免三道闸）；`fingerprint.mjs:62 setDiff` 与 ci-failures 内的指纹逻辑同题材。
- `FS-任务循环执行器.md:122`（§4.6 处理）把「`ci-watch.mjs` 零 LLM 轮询终态」与 buildR1ProfileCI、install-task-loop 等在跑部件并列陈述——读起来像都已接线，实际 watchPipeline 无人调用。

**影响**：下一位读者会以为改 attribution.mjs 就能改归因行为（改了没效）；FS 的「处理」段混入未接线部件，整段的可信度被稀释。

**修法（一句）**：五个模块要么在文件头与 FS 标注「已设计未接线（T4a/T5）」，要么挪进 test/ 或删除——分层原则成立的前提是 lib 里没有「永远没人 import 的库」。

### Y3. no_doc_reason 是无牙规则：写了白写

**位置**：`AGENTS.md:19`（规则 8：「跳 rs 需在 `meta.no_doc_reason` 写明理由」）；`scripts/ci-verify.mjs:134`（全仓唯一出现点，且只在提示文案里）；`hooks/lib/doc_completeness.mjs`（602 行，grep `no_doc_reason` = 0 命中）。

**证据**（实测）：ack-hotfix、architect-agent、deploy-skill 等任务的 meta.no_doc_reason **已填**（如「S 档 bugfix：retro/ack-hotfix-接单流转修复.md 即文档」），`node scripts/ci-verify.mjs` 仍对它们输出与未填任务一字不差的提示：「…S 档**可写** meta.no_doc_reason 说明为什么不需要文档」——字段不抑制提示、不参与判定、无格式校验。

**影响**：规则 8 的「跳 rs 需写明理由」零机器判据——跳 rs 且不写理由的任务与写了的走完全相同的门禁结果；提示文案还在持续误导人以为这个字段有作用。

**修法（一句）**：missingDeclarations 的 notice 至少区分「已写理由/未写」，或把「S 档 done、缺 RS 声明、无 no_doc_reason」升为 problem——三行代码让规则 8 长牙。

### Y4. architect agent「三层落地」只落了一层：源文件存在但调度面未接线

**位置**：`agents/architect.agent.md`（f4f23b2，2026-11-18「architect agent 落地」）；`harness.config.json` `agents.enabled`（11 项，无 architect）；`.claude/agents/`、`.zcode/agents/`（实测无 architect.md）；`.ai/writes.json`（无 architect 条目）。

**证据**：agent 文件自称「在架构决策点（ADR 阶段/change_tier=3）**被调用**」「orchestrator 调度你做架构决策审查」——但 enabled 清单不含它，build-agents.mjs 不生成它，orchestrator 的 agent 宇宙里根本没有这个名字；实际生效的只有脚本层 `scripts/architect-check.mjs`（fitness functions）。AGENTS.md:8「11 个 agent 分工」与 agents/ 目录 12 个源文件并存。

**影响**：commit 语义与 README 口径（11 agent）让人以为架构守护有人值守，实际是「指标脚本 + 一份没人能调度的规格」；`.ai/writes.json` 声明的写入域投影也缺这块。

**修法（一句）**：把 architect 加进 enabled 并 `npm run build:agents`，或在 agent 文件头与提交说明注明「规格先行、未启用」——别让「落地」一词覆盖两种状态。

### Y5. 术语一词三义，RS 术语表只覆盖设计期词汇

**位置**：`docs/01-requirements/RS-task-loop.md:90`（§6 术语表，仅定义 认领/停点/豁免/证据包 四个设计期词）。

**证据**（全仓计数，scripts+docs+AGENTS）：
- **「ack」≥3 义**：`ack-<id>.json` 账目（task-loop.mjs:672/698 写）、`acks-<id>.json` 执行器逐条确认清单（session-pack.mjs:20，同一目录近名共存——实测 `.ai/task-loop/` 下同时存在 `ack-7167752069.json` 与 `acks-1847.json`）、`acknowledgeBug` 飞书接单（task-loop.mjs:579）。
- **「账本」≥3 义**：`.ai/ledger` 拦截/事件观测账本（hooks/lib/ledger.mjs）、task-loop 的「认领账本」（task-loop.mjs:219，held Map）、attribution 的「flaky 账本」（attribution.mjs:4）；另有「账目」专指 ack-*.json（FS:69 等 9 处）——共享背景③的「账本三作用域致 PAT 误诊」正是这个词承担过多语义的账单。
- **pack 一物三名**：会话包（5）/ 工单（38）/ 会话工单（3）——pack-1896.md 的标题写「会话包」，代码注释叫「工单」，FS:101 叫「会话工单」。
- **「豁免」3 义**：stage `waived_by` 豁免（verify.mjs:751）、CI 归因 exemption（RS §6 有定义，attribution.mjs 实现为死代码）、retro 豁免（无机制，见 R1）。

**影响**：术语不统一不是修辞问题——R1 的三次被咬里，「豁免」正是被默认为跨机制通用才踩坑；新会话接手时「读 ack」到底读哪个文件靠猜。

**修法（一句）**：RS §6 补五条运行期定义（账目/工单/认领/接单/账本 各一句），代码注释统一「账目」= ack-*.json、「工单」= pack-*.md，执行器产物目录内改名避免 ack/acks 近名共存。

---

## 🟢 轻微

- **G1** AGENTS.md 硬规则编号 1-5、7-9 跳过 6（考古实测：初始版 `git show 2e8642c:AGENTS.md` 即 5 条，后加的三条直接编号 7/8/9）——读者会找一条不存在的规则 6。修法：重排为 1-8。
- **G2（正面结论）** ⑤ hooks 门禁与 task-loop 写盘**无自拦**：实测 guard_state/guard_write/guard_command 对 `.ai/task-loop/` 写入全放行（exit=0）；runner 本体走 node fs 不经 hook；headless 执行器按协议写 todo/acks/round-N 也不被拦。这是协调好的留白，但 writeGuards.note 未写明此依赖——后人「顺手」把 `.ai/task-loop/**` 加进 protected 会无声拦死执行器。修法：在 writeGuards.note 补一句依赖说明。
- **G3（正面结论）** ③之 skipDrafts/fixSuggestions 默认值三处一致：代码 `!== false`→true（task-loop.mjs:318、gitlab-triggers.mjs:240）、`harness.rules.json:196-198`、FS §8 表 :231-232——无冲突，记录在案。
- **G4** 六个 done 任务 gate_result 为空（poll-config/ack-wiring/gate-channel-fix/iteration-prefix/stale-task-gate/review-p2-fix），stageGate 只发 notice——声明型门禁的既知边界（ci-verify 注释自认「机器判不了根本没评估」），归 R3 一并处置即可，不单列。

---

## 审阅范围与未覆盖

**逐项核对了**：六项必查面全部覆盖——①retro 豁免双标（R1，/tmp 实测复现）、gate_result/时间戳声明效力（R3，31 份 state 全量扫描 + verify:state 实跑 exit 0）、no_doc_reason（Y3，实跑对比）；②五态转换与三处口径（Y1，全仓 grep 消费者 + 现存 ack 文件核对）；③配置默认值三处（G3 一致）与 lib 分层（Y2，逐模块 grep importer）；④AGENTS.md 编号/agent 数/身份规则（R2、G1、Y4，git 考古）；⑤hooks 与 task-loop 交互（G2，三 hook 实测）；⑥术语（Y5，计数 + 三处近名文件实测）。

**依据的标准**：仓库自身声明（AGENTS.md 硬规则、verification.md、FS/RS）+ 任务给定的分级（🔴🟡🟢）；「谁错了」按「机制时间序 + 工具链现行行为」推断（R1 标注了推断依据）。

**没核到/未覆盖**：
- 28 个测试套件未全量跑（gate 约 35 项，只跑了 verify:state 与零散单测命令）；测试断言质量未抽查。
- `scripts/harness-broker.mjs`、feishu-ws 等通知链与订阅三档的运行时行为未实测（无凭据环境）；`deploy/` 模板渲染正确性未验。
- TDasset 侧挂仓（harness.config.json projects 指向 ../TDasset）不在本仓范围，projects.srcGlob 对 TDasset 的实际覆盖未验。
- `.zwork/artifacts/` 下的历史草稿未逐一比对（仅用于交叉印证 retro 三咬记录）。
