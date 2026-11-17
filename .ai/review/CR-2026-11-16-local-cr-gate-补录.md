# CR 代码审查记录 — local-cr-gate 本地 CR→修复循环门禁（事后补审）

> 产出：独立补审会话（审阅者）· 2026-11-17
> **事后补审**：任务交付于 2026-11-16 09:44–09:46（aa877f9 + cb83964，作者 zwork），交付时无 CR——违反 AGENTS.md 硬规则 8（S 档必须 cr，规则 11-03 经 f556180 生效，早于任务 13 天）。本记录系 `.ai/review/CR-2026-11-17-两日提交审核.md` 🔴#2 的修复动作，非当时产物。
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。
> 鸡生蛋背景：该任务本身是造 CR 门禁的。当时的替代性核验 = retro 落盘（retro/local-cr-gate-本地CR门禁.md）+ test:ai-review 扩 2 例（34→36）+ CLOSE-GATE 全量绿（cb83964）。背景可记，不构成免审理由。
>
> 验证阶梯：本 CR 的证据以「审计者当轮自跑命令」为准（伪造成本最高的一档可用证据）。

- 审查范围：`git show aa877f9` 完整 diff（15 文件 +334/−12：agents 2、scripts 1、templates 1、test 1、state 1、verify 日志 2、retro 1、生成物三套 6）+ `git show cb83964`（state 收尾 + CLOSE-GATE 日志）。四个核心文件 `git log aa877f9..HEAD` 无后续改动，**本 CR 结论对 HEAD 直接生效**。
- 关联 FS：无（S 档，meta.no_doc_reason=「retro 即文档」）。
- **已加载的 skill**：`.skills/harness/SKILL.md` v1.1.0（H1–H9 作 §0；事后审计无工作区 diff，resolve-skills --diff 无从命中，按任务书命中栈加载——与两日审计同口径）。

## 0 硬规则逐条核（harness H1–H9）

| # | 规则 | 检测命令 / 方法 | 结果 |
|---|---|---|---|
| H1 | 改 `scripts/**` 同批带测试 | `git show aa877f9 --stat`：scripts/ai-review.mjs 与 test/ai-review.test.sh 同批（+2 断言）；自跑 `bash test/ai-review.test.sh` = 36 通过 0 失败 | ✅ |
| H2 | 生成物禁手改，只能改源+重建 | aa877f9 同批含 .claude/.zcode/prompts 三套投影；自跑 `npm run check:agents` = 68 个文件与源一致、`npm run check:hooks` = 接线一致；`git log aa877f9..HEAD -- <六个生成物>` 为空（无漂延） | ✅ |
| H3 | 解析失败必须 fail-closed | 逐处核 scripts/ai-review.mjs：规则缺失/RulesError→die(2)（:65,:72）；git diff 失败→die(2)（:65）；清单缺失→die(2)；模型调用/解析失败（含 120s 超时 :154）→die(2)（:204）；无凭据→die(2)（:206）；M3 空判据+--machine-only→die(2)（:181-183）。无 `return 0` 式伪装放行。唯一无 verdict 的 exit 0 = 路由未命中（:75-78），语义为「无对象可审」，其误读面记 🟡#1 | ✅ |
| H4 | 黑/白名单只在 harness.config.json | 本次新增代码无路径/命令字面量；cr 的 fallback_paths 原有的在 harness.rules.json 配置侧；M3 die 信息无字面量 | ✅ |
| H5 | skill Stage 0 ≤5 项/≤200 行/≤2 层 | 未动 `.skills/**` | N/A ✅ |
| H6 | 新增拦截同批给合法绕过 | M3 die(2) 信息自带两条出路（配 key 走完整审 / 加 machine_checks 后再用，:182）；push 门禁写明「记名 waive」退出（coder.agent.md:38）。 waive 的落点与格式未定义——并入 🟡#2 | ✅（带缺口） |
| H7 | 新 hook 接进两个 CLI | 未新增 hook；脚本经 package.json `test:ai-review` 接入 `npm run gate`，CI `.github/workflows/quality-gate.yml:73` 同跑 | N/A ✅ |
| H8 | 配置新键必须有消费者 | 未新增配置键（machine_checks 为既有键，M3 只消费不定义；`harness.rules.json` reviews.cr.machine_checks=[] 原值未动） | ✅ |
| H9 | 断言可证伪+变异结果 | 两断言结构可证伪：删 M3 块→第 1 断言红（cr+machine-only 得 0 而非 2）；rs 正例防误伤（第 2 断言）。**变异未留痕（提交说明/retro 均未记变异方式），本审未独立重放（只读纪律不脏树）** | ⚠️ 部分核 |

## 1 改动摘要

任务把「本地 CR→修复循环」落成三层：L0 机器判据（verify-run，既有）；L1 AI 语义审 = `node scripts/ai-review.mjs --type cr --base`，**risk_tier ≥ MEDIUM 必跑**（LOW 跳过，只走定向验证）；L2 CI 兜底（保留）。修复循环 ≤3 轮，第 3 轮仍红升级 human_decision；禁自审——判断只出自读 git diff+规则的隔离脚本。落地四件：coder.agent.md 步骤 7（分层触发/退出码/循环/禁自审）；orchestrator.agent.md C2（review 阶段必须调度 code-reviewer，:21）；ai-review.mjs M3（cr 类 machine_checks=[] 时 --machine-only 由空壳绿灯改 exit 2，:177-183）；CR 模板头注明 `.ai/review/`（正式 CR 记录）与 `.ai/reviews/`（脚本 verdict 缓存）的目录口径。

**分层事实纠正**（任务书转述有偏差，按代码为准）：不存在「低档送 ai-review 子代理、高档送独立 CR 会话」的二分——实况是 LOW 跳本地 CR、≥MEDIUM 跑 ai-review 脚本（L1），review 阶段一律调度 code-reviewer（C2）。门禁脚本路径为 `scripts/ai-review.mjs`（任务书写 `scripts/lib/ai-review.mjs`，该路径不存在；lib 下是 review-rules/review-checks 两个被动模块）。

## 2 阻断项 🔴

无。补审口径说明：交付时缺 CR 本身即两日审计 🔴#2，由本文件闭合（审计给的修复口径为「补录 CR **或** 登记豁免」，取前者）；现 HEAD 代码面未发现产出错误结果或可触发失败的问题，不升级待修。

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | agents/coder.agent.md:18,27,28 + scripts/ai-review.mjs:63,75-78 | **步骤 7 的「绿」与脚本两种 exit 0 有缝隙**：(a) 步骤 7 写「提交前必经」，但脚本取 `git diff base...HEAD`（:63）不含未提交变更——commit 前跑且 HEAD=base 时变更清单为空→走「未命中，无需审核」exit 0（:75-78），7b 的表把 exit 0 定义为「绿（可提交）」，与 7b 同时被 :41 退出条件要求的「verdict 存在」矛盾（该路径不落 verdict）；(b) exit 2 只有标签（:27「基础设施问题」）无处置指令，7c 只写 exit 1 的动作。coder 按字面读 7b 表即可能推着未审代码过门 | 7b 注明「先 commit 再跑」；脚本对空 diff 给可区分输出（或落「无需审核」verdict 供存在性校验）；7c 补一句「exit 2 → 停，升级 blocker，不得当绿」 | 修（下批 agent 定义变更时） |
| 2 | .ai/writes.json:2（自述「交接契约，不是运行时门禁」）；hooks/lib/verify.mjs:692-696（risk_tier 仅枚举校验）；全仓 grep 无 CI 消费方 | **risk_tier 自降档逃避 CR 无机器联动**：coder 会话改 state.json 的 meta.risk_tier=MEDIUM→LOW 即整体跳过步骤 7，guard_write 只按路径判（考卷区/生成物/凭据）拦不住，CI 不查「risk_tier≥MEDIUM ⇒ CR 证据存在」；旁挂模式下 verdict 还落在产品仓 `.ai/reviews/`，本仓 CI 根本看不到。缓解=state.json 入 git、MR 人审可见、L2 兜底——全是软的；本仓若加一条最小联动，本次违规本可在 close 时被拦 | verify:state 或 ci-verify 加最小检查：本仓任务 stage=done 且 risk_tier≥MEDIUM ⇒ `.ai/review/` 有对应 CR 记录（或 known_issues 记名豁免）；顺带给「记名 waive」定落点（如 state.known_issues 或 MR comment 引用） | 修（可随下批） |
| 3 | guides/审核与通知自动化.md:214,231 | M3 改了 `--machine-only` 的行为契约（cr 类从「可用」变 exit 2），指南仍把它写成通用合法降级出口（「内网审核禁用外部模型时」「CI job 里显式 --machine-only」），未提空判据类型的例外——按指南操作 cr 会撞 exit 2 且无人预告 | 指南补一句例外（machine_checks 为空的类型禁用，见 ai-review.mjs:181） | 修（两行） |
| 4 | agents/coder.agent.md:28-29；scripts/ai-review.mjs:251（verdict 文件名仅 `<type>-<commit>`，无轮次）；harness.rules.json runtime.budget.maxRounds=3 | **3 轮预算无审计痕迹**：轮次计数只在 coder 会话叙事里，verdict 不带轮次、state 无字段，「第 3 轮升级」既不可核也不可拦；且与 task-loop 的 budget.maxRounds=3（D7，任务级修复轮次）同名异义，读者易混 | verdict 文件名或 state.todos 加轮次字段；文档一句话区分两个「3 轮」口径 | 修（可随下批） |

## 4 跨模块影响（调用方实检索）

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| 生成物三套（.claude/.zcode/prompts 的 coder、orchestrator） | 否 | aa877f9 同批提交；自跑 check:agents 68 一致；`git log aa877f9..HEAD --` 六文件为空 |
| orchestrator C2 点名的 code-reviewer 子 agent | 可调度 | agents/code-reviewer.agent.md 在库（11 agent 之一） |
| templates/CR 模板的消费方 | 否 | agents/code-reviewer.agent.md:16（引用模板）；scripts/reviews/cr.md:3（同源条款绑定的是 §0 硬规则表，本次未改 §0，只加目录口径行，无需同步） |
| `--machine-only` 既有用户 | cr 类受影响 | rs/adr/fs 的 machine_checks 非空不受影响（测试 §6 第 2 断言自跑绿）；文档消费方未同步→🟡#3 |
| review-router / harness-broker（与 ai-review 共读 harness.rules.json） | 否 | reviews.cr.machine_checks=[] 为原值，M3 只在 ai-review.mjs 消费侧加判，规则文件未动 |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入（SQL/命令/模板） | ✅ 无新增拼接面；模型输出经字段白名单清洗（severity/message 校验，非法条目剔除并留痕） |
| 越权 | ✅ 不适用面（本地脚本）；guard_write 路径面不受本次影响（软门禁边界见 🟡#2，非本次引入） |
| 敏感信息进日志/入库 | ✅ verdict 只记模型名与 token 计数（:251-259）；API key 只走 env，不落盘不进日志 |
| 依赖变更 | 无 |
| 考卷区写入授权 | ✅ templates/ 编辑有放行条：hooks/write-allowlist.txt:25，7642f87（2026-11-11）续期至 11-25，覆盖 aa877f9 编辑时点（11-16）；同批测试由 test:agents 承担 |

## 6 测试覆盖（本审自跑）

| 项 | 结果 |
|---|---|
| `bash test/ai-review.test.sh` @HEAD | **36 通过，0 失败**（任务书预期 36；含 M3 两断言：cr+--machine-only→exit 2 负向 / rs+--machine-only→exit 0 正向防误伤） |
| `npm run check:agents` @HEAD | 68 个文件与源一致（生成物无漂移） |
| `npm run check:hooks` @HEAD | .claude/settings.json 与 .zcode/config.json 接线一致 |
| 3 轮循环 / risk_tier 分层 / 禁自审 | 无机器断言（prose 层）——与 🟡#2、🟡#4 同根 |
| M3 变异红 | 未独立重放（只读纪律不脏树）；可证伪性由断言结构论证（§0 H9） |

## 7 结论

- 🔴 数量：**0**（交付时缺 CR = 两日审计 🔴#2，由本补录闭合；现 HEAD 代码无必须修项，不升级待修）
- 🟡 已全部表态：是（4 条：步骤 7 退出码缝隙 / risk_tier 无机器联动 / 指南未同步 / 3 轮无痕——均为门禁强化与文档同步，不阻断）
- 建议：**approve（补审放行）**。代码面 M3 fail-closed 方向正确（六类失败路径全 die(2)，失败绝不产出「通过」），生成物同批重建无漂移，测试与一致性检查当轮自跑全绿。四个核心文件自 aa877f9 无后续改动，结论对 HEAD 直接生效。

## 附：审阅范围与未覆盖

**已核对**：aa877f9 全 diff 逐文件（含生成物投影与源一致性）、cb83964 state 收尾合规性（verify 对象/ooda_stage=audit/audit 四项/ci+retro 阶段补齐）、三份 verify 日志标准头（cmd/started/finished/exit_code/commit/task 齐全，CLOSE-GATE 戳 aa877f9 盖住最终树）、harness.rules.json 的 cr 定义（machine_checks=[]）、ai-review.mjs 全文失败路径逐处、writes 契约与 guard 面自述、write-allowlist 放行条时效、模板消费方与 --machine-only 文档消费方全仓检索、三条命令自跑真退出码。

**未覆盖及原因**：M3 变异红未重放（只读纪律不脏树，建议父 agent 挑 M3 块删除复跑 `bash test/ai-review.test.sh` 验证第 1 断言变红）；ai-review 真实模型端到端未跑（无凭据，与既往 CR 同口径）；`npm run gate` 全量未在本次重跑（两日审计 🔴#1 的 poll-30m 问题不在本任务范围，且 d32cdec 后状态可能已变，不代其下结论）；retro/local-cr-gate 文件内容与 diff 事实一致性已抽读（无矛盾），未逐句考据。
