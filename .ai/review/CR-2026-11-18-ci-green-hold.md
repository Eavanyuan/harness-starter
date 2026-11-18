# CR 代码审查记录 — ci-green-hold（CI 转绿≠完成：绿保持转等评审）

> 产出：code-reviewer 独立会话复核 · 本地未提交变更正式 CR
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。

- 审查范围：`af63986`...工作树未提交变更（5 文件，+112/−16；git status 全量核对：docs×2、scripts×2、test×1，另有 .ai/tasks/ci-green-hold/ 与 .ai/verify/CG1.log 未跟踪）
- 关联 FS：`docs/02-features/task-loop/FS-任务循环执行器.md` §4.4（第三形态段）/ §9（测试矩阵新行）
- 关联 RS：`docs/01-requirements/RS-task-loop.md` US-1 新增行（:26）
- 关联 SR 报告：无（S 档，adr/fs_review/wbs 均 deferred 且 waived_by 有理由）
- **已加载的 skill**：`node scripts/resolve-skills.mjs --diff` → harness v1.1.0（命中 `scripts/lib/gitlab-triggers.mjs`、`scripts/task-loop.mjs`、`test/task-loop.test.sh`）；H1–H9 逐条核见 §0
- 关联任务：`.ai/tasks/ci-green-hold/state.json`（change tier 2，--related ci-fail-trigger --baseline af63986 ✓ 基线为 HEAD 祖先，`git merge-base --is-ancestor` 实测）

## 0 硬规则逐条核（harness v1.1.0 硬规则表）

| # | 规则 | 检测命令 / 判据 | 结果 |
|---|---|---|---|
| H1 | scripts 改动同批必须有测试 | `git diff --name-only HEAD`：scripts 两件 + `test/task-loop.test.sh`（check 计数 124→125，`git show af63986:…` 对比实测） | ✅ |
| H2 | 生成物禁手改 | `npm run check:agents && check:hooks`：68 文件与源一致 / 两套 CLI 接线一致（本轮实跑） | ✅ |
| H3 | 解析失败 fail-closed | 未命中（本批未改 hooks/**；MR 详情失败仍 rethrow 走整源软失败，仅 404 白名单不变，gitlab-triggers.mjs:290-294） | 未命中 |
| H4 | 黑白名单只写在 config | 未命中（无 hooks 改动、无新字面量） | 未命中 |
| H5 | skill 结构约束 | `npm run check:skills`：4 skill 通过（本轮实跑） | ✅ |
| H6 | 新拦截规则须附合法绕过 | 未命中（无新门禁规则；sweep 行为变更非拦截口径） | 未命中 |
| H7 | 新 hook 双 CLI 接线 | 未命中（无新 hook；wiring 用例含于套件，125 全绿） | 未命中 |
| H8 | 配置键必须有消费者 | 未命中（未新增配置键；ciGreen 是透传集合非配置） | 未命中 |
| H9 | 断言可证伪 + 变异结果 | 变异 A（整段移除绿保持分支）→ **3 红**（5k/5m/5t 各 1，122/125，本轮实测）；变异 B（仅去幂等守卫）→ **125 仍全绿**（本轮实测，缺口见 🟡#1） | ✅（一条覆盖缺口单列 🟡#1） |

## 1 改动摘要与重点核对结论

用户概念修正「CI 转绿不代表完成，审核描述有需要修复的项，两回事」。`fetchTriggers` 在**无评审信号**分支新增 `ciGreen` 集合（`head_pipeline.status==='success'` 且 MR 仍 opened，gitlab-triggers.mjs:268/303，与 inflight/drafts 同款 Set 透传）；`task-loop.mjs` sweep 在 drafts（:432）→inflight（:442）之后、trigger_gone（:461）之前插入绿保持分支（:447-460）：对在账 MR 转 `state='awaiting_review'`、撤工单、保留认领/轮次/fingerprint、`ci_green_hold` 落账，幂等由 state 守卫（:451）保证。5k/5m 按新语义改写（转绿=保持 + phase4 离开列表才关账），5t 新增「绿保持→评审结论→stale→重认领转评审工单」链路。测试 124→125。

父 agent 点名的六个核对面，逐条结论：

1. **顺序与互斥**：✓ Draft 优先于绿保持——fetchTriggers 详情级 Draft 判定（:300）`continue` 在 hp 检查（:302-303）之前，Draft MR 构造上不进 ciGreen；sweep 分支序 drafts→inflight→ciGreen→关账，Draft 恒先命中（why=draft 关账）。✓ Inflight 与绿保持不相交——inflight 要求非终态（:302），ciGreen 要求 `success`（终态白名单内），集合互斥，sweep 顺序只是双保险。
2. **绿保持幂等**：代码正确（:451 的 state 守卫包住 writeFileSync/recordEvent/console.log/stats.hold，重复绿轮零副作用）；**但无测试钉死**——变异 B 后 125 全绿，见 🟡#1。
3. **fingerprint 保留旧 `ci:<id>` 的后果**：✓ 绿后新红 = 新推送新流水新 id → 触发 ci 信号 → 指纹 `ci:<新id>` ≠ `ci:<绿id>` → ack_stale 重认领重归因（5k phase3 已钉）；✓ 绿后评审出手 → 评审形指纹失配 → 重认领转评审工单（5t 已钉）。残余：**同流水号** success→failed 回红不重认领（指纹不变 → sweep 不 stale → 认领已持有即 skip）——仅记录 #1。
4. **评审形→CI 形反向流转**：机制成立——threads 已 resolve / 动词被新 push 覆盖 → hasReviewSignal=false → 详情报 failed → ci 触发 → 指纹失配（:469）→ stale → CI 工单。副作用：轮次从 1 重计（carryRounds 只认 `ci:` 前缀旧指纹，:473）——仅记录 #2。
5. **awaiting_review 与 awaiting_rereview 并存**：两态均为「无工单的被动态」，仓库内无其他消费者按 state 分流（grep 全 scripts+hooks：仅 sweep 自身与测试引用）；关账路径一致且都可达——离开列表关账（5k/5m phase4）、转 Draft 关账（draft 分支在绿保持之前）、新信号 stale 重认领（5t）。注意绿保持会把 awaiting_rereview/needs_human/inherited_only 一并翻成 awaiting_review，宽于 RS「CI-form 账目」措辞——🟡#2。
6. **围栏计数**：finish 恒一行，「等评审 N」只在发生转换的轮出现（stats.hold 幂等增量，task-loop.mjs:146）；无断言（test 内 7 处「等评审」均为注释）——并入 🟡#1。

## 2 阻断项 🔴

无（0 条）。正确性/安全性/性能三层逐项过：绿保持分支错误路径闭合（rmSync 带 force、ack 原地重写保留 fingerprint/ci/budget）；无新注入面；每轮新增成本为 Set.add 与 O(ack 数) 判断。

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | test/task-loop.test.sh:1114-1131 / 1421-1429 / 1540-1560（5k/5m/5t 的绿 phase 均只跑一轮 sweep） | 幂等与围栏计数无断言钉死：变异 B（去 task-loop.mjs:451 幂等守卫）后 125 仍全绿——「重复绿轮不重复落账/不刷屏/『等评审 N』只计一次」的回归不可见，而「幂等不刷账本不刷屏」正是 CG1 audit quality_clean 的明文主张 | 5m phase3 后原地再 run() 一轮，断言 events.jsonl 中 `ci_green_hold` 恰 1 次、无第二条保持日志、围栏无 `等评审 1` 重复 | 修（约 4 行断言，下批顺手）/ 不阻断 |
| 2 | RS-task-loop.md:26（「CI-form 账目」）vs scripts/task-loop.mjs:447 | 代码作用域宽于文档口径：绿保持对一切 `state≠awaiting_review` 的 MR 在账生效（含 awaiting_rereview、needs_human、inherited_only、评审形 working），非仅 CI 形。行为本身合理（绿=CI 轨道完成，统一转等评审；needs_human 被新绿解除后若再红，carryRounds 仍从 ack.ci.rounds 续计，闭环），但按 RS 阅读会以为 awaiting_rereview 不受影响 | FS §4.4 补一句「任何在账形态转绿均转等评审（含 awaiting_rereview/needs_human）」，或将排除清单写进 RS | 修（文档一句）/ 不阻断 |

仅记录（不展开）：

1. 同流水号 success→failed（如 manual job 在 success 后跑失败）不触发重认领——fingerprint 不变；真实新红通常=新流水新 id（5k phase3 已钉该路径）。频率低，接受。
2. 评审形→CI 形反向流转成立但无测试钉；且轮次重置为 1（:473 只认 `ci:` 前缀）——轨道交替会重置「越修越坏」上限，与 ci-inflight-hold 的跨流水累计初衷有出入。
3. Draft MR 带活评审信号、且列表响应缺 work_in_progress 字段时，详情级 Draft 判定不会执行（详情只在无信号分支拉取，gitlab-triggers.mjs:277-303）→ 仍可能触发认领。draft-skip 遗留边角，非本批引入。
4. 作者 audit 称「变异：绿保持分支退化→2 红」；整段移除实测 **3 红**（5k/5m/5t）——方向成立、计数不吻合，疑变异形状不同（H9 判据不受影响）。

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| `fetchTriggers` 运行时消费者（仅 task-loop.mjs） | 只增不改：`out.ciGreen` 为新增 Set 属性，数组 spread 语义不变；runner 单独捕获（task-loop.mjs:288，与 inflight/drafts 同款） | grep 全仓：fetchTriggers 消费者=runner+测试 |
| ack `state` 消费者 | 无新增分流：grep awaiting_review/awaiting_rereview/needs_human 全 scripts+hooks，仅 sweep 自身与测试引用 | 本轮 grep 实测 |
| hooks / 生成物 / CI | 未触碰：git status 无 .claude/.zcode/prompts/hooks 改动；check:agents/check:hooks 全绿 | 本轮实跑 |
| 飞书剖面 B / dry-run / `--mr` 过滤轮 | 不经此分支：sweep 仅处理 `mr-` 前缀账目；`gitlabViewComplete=false`（软失败/过滤）时绿保持与关账同样不动账（task-loop.mjs:428-431） | 代码路径核对 |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入（SQL / 命令 / 模板） | 无新增面：纯集合判断+文件写；id 来自 API iid，用于固定模板路径 `pack-<id>.md`（与 draft 关账同款既有模式） |
| 越权（横向 / 纵向） | 无权限面变化；token 获取/传递路径未改 |
| 敏感信息进日志 | 无：ci_green_hold 落账仅 kind/id；console 文案无凭据 |
| 依赖变更 | 无 |

## 6 测试覆盖

| 新增行为 | 是否有对应测试 | 备注 |
|---|---|---|
| 转绿且仍 opened → awaiting_review + 撤工单 + ci_green_hold、无 trigger_gone | ✓ 5k phase2 / 5m phase3 / 5t phase2 | |
| 离开 opened 列表（合并/关闭）才真关账 | ✓ 5k / 5m phase4（列表返回 `[]`） | |
| 绿后评审出手 → stale → 重认领转评审工单（残余 🔴 进清单） | ✓ 5t phase3（ack state=working、pending=1 含「残余 🔴」、pack 含「残余」、ack_stale 先于 claimed） | |
| 幂等（重复绿轮零副作用） | ✗ | 🟡#1（变异 B 证明未钉死） |
| 围栏「等评审 N」 | ✗ | 并入 🟡#1 |
| 评审形→CI 形反向流转 | ✗ | 机制核对成立（§1.4），仅记录 #2 |

## 7 结论

- 🔴 数量：0
- 🟡 已全部表态：是（#1 下批补断言 / #2 补一句文档口径，均不阻断）
- 建议：**approve**

证据（本轮独立取得，非转述作者）：

- `bash scripts/verify-run.sh --task ci-green-hold CG1-CR -- bash test/task-loop.test.sh` → **125 通过 0 失败**，exit_code 0（.ai/verify/CG1-CR.log）
- 变异 A（移除绿保持分支整段）：122/125，3 红 → H9 可证伪 ✅
- 变异 B（仅去幂等守卫 task-loop.mjs:451）：125 全绿 → 🟡#1
- `npm run check:agents && check:hooks && check:skills` 全绿
- 基线 af63986 为 HEAD 祖先；check 计数 124→125 实数对比

剩余风险：`.ai/task-loop/OFF` 哨兵仍在位（开发期置）——合入后须删除，否则循环不恢复运行。
