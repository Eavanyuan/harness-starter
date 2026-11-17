# FS-本地任务循环执行器（task-loop）

> 产出：`spec-writer` · 落点 `docs/02-features/task-loop/`　｜　需求：`docs/01-requirements/RS-task-loop.md`　｜　裁决：`docs/06-reference/adr/ADR-010-task-loop.md`
>
> 补记（2026-11-10）：本文件在 T1–T6 代码落地之后补写——原流程把代码跑在了 FS 评审前面，
> 而 `ci-verify` 不校验 stage 与 todo 的关系，所以门禁一路绿。补写不是事后凑文档：这里描述的是
> **已经跑起来的那套东西**，凡与代码不符之处，以本文档为准去改代码，回头再改本文档。
>
> §4 按**工作单元**（T0–T6）分节，而不是按机制分节：这样 FS 小节、WBS 的 `spec_ref`、`state.todos`
> 三者可以一一对齐，`ci-verify` 的双向覆盖检查（FS 有节无任务=漏做，任务指向不存在的节=悬空）才有意义。

## 1 概述

给"机器能自己走下去、但需要跨小时等人"的那部分流程装一个本地循环。两道缝：MR 被打回后修复意见过夜（US-1）、飞书 bug 指派后等人开跑（US-2）。执行器跑在**每个开发机本地**，定时器每 180s 触发一次单轮（`--once`），一轮只做一件事：拉触发 → CAS 认领 → 起无头会话 → 落账 → 退出。没有中央调度，没有入站端口。

使用者是提交者本人与 bug owner；管理者是 TL，通过账本（`.ai/ledger/events.jsonl`）与影子周报告看它做了什么。

## 2 需求追溯

| RS 条目 | 本文档小节 | 覆盖状态 |
|---|---|---|
| US-1 | §4.4 §4.7 | 完整 |
| US-2 | §4.8 | 完整 |
| US-3 | §4.3 | 完整 |
| US-4 | §4.5 §4.6 | 完整 |
| R-4（追溯锚） | §4.2 | 完整 |
| R-2（影子周） | §4.7 | 完整 |

> 剖面 B 的"代码侧完整、数据档待授权"这件事写在 §4.8 的失败分支里，不写成"部分覆盖"——
> 代码如果能为"权限未批"给出明确的降级与指引，它对这个需求就是完整的；含糊的"部分"只会让门禁无从判断。

## 3 方案要点

- 关联 ADR：`docs/06-reference/adr/ADR-010-task-loop.md`（D1 拉不推、D2 CAS 认领、D3 停点三条件、D4 失败指纹、D5 三分流、D6 `runtime.headless`、D7 预算口径）
- 关键取舍：**互斥只靠 git 一个共享点**。没有锁服务、没有数据库、没有入站 webhook——认领即"在远端建一个唯一内容的提交"，失败即非快进拒绝。少一个组件，就少一处跨机不一致。

## 4 详细设计

### 4.1 T0 仓库税与账实一致（契约套件）

- 输入：`.ai/tasks/task-loop/state.json`、`docs/02-features/task-loop/task-loop.wbs.md`、FS 自身
- 处理：`test/task-loop-contract.test.sh` 四条——① `artifacts` 里登记的文件真实存在；② 已有完成项时 `stage` 不得早于 `impl`；③ WBS 的 TODO 编号集合与 `state.todos` 相等；④ `stage_history` 每段都有 `gate`，`waived/deferred` 必须记名
- 输出：通过/失败；第 5 条是反向自检（把 `stage` 改回 `fs_review` 必须变红）
- 失败分支：任一条不一致即 `exit 1`；**不接受"改判据让绿"**，只能改账本或改代码

### 4.2 T1 追溯锚（外部单号 ↔ 任务）

- 输入：`init-harness.sh --related feishu:<id>`
- 处理：解析单号字符集 → 建档时写 `EXT-<id>` 行与 `meta.remote_id = {source:"feishu", id}`
- 输出：`state.json` 的 `meta.remote_id`；`ci-verify` 的 `checkTaskTraceability` 复核两侧一致
- 失败分支：非法单号 → 拒绝；`source` 与行内锚不一致 → 拦截；`feature` 类型不接受外部单号；路径逃逸字符 → 拒绝

### 4.3 T2 订阅三档投递

- 输入：事件 + 订阅表 + 事件紧急度（`mustAct`）
- 处理：`scripts/lib/subscriptions.mjs` 的 `classify()`——`card`（即推）/ `digest`（降档进摘要，带 `escalateAfter`）/ `ledger`（只入账）
- 输出：投递档位 + `subscription_matched` 事件；`harness-broker.mjs` 按档投递
- 失败分支：`mustAct` 对当事人**下限是 digest**，不得降到 ledger（订阅可延迟，不可吞消息）；发送失败 fail-open（记日志不阻断）；aging 到点升回 `card`；改个人档位走卡片自服务

### 4.4 T3 runner 核心（触发 / 认领 / 预算 / 停点）

**触发判定（剖面 A）**

- 输入：`GET /merge_requests?scope=created_by_me&state=opened` → 逐条 `discussions`，必要时补 `repository/commits/<sha>` 与 `approvals`
- 处理：`scripts/lib/gitlab-triggers.mjs` 的 `classifyMr()`。`unresolvedByOthers()` 取"他人写的、`resolvable && !resolved`"；`approvalFromDiscussions()` 回放系统留言里的 `approved/unapproved this merge request` 得到**审批人与审批时间**
- 输出：`{kind:'mr', id, mr, unresolved, comments, reviewState, signal}`；`comments` 为评审人建议性普通评论（2026-11-16 变更 mr-verb-trigger：审核意见里的建议修改项纳入接单修复范围，不双列 resolvable、不收自发与系统留言），随触发进 ack 待修清单
- 第三形态（2026-11-17 ci-fail-trigger）：无打回证据的 MR 逐单拉**详情**判 `head_pipeline.status==='failed'` → `signal:'ci_pipeline'`（列表接口实测不带 head_pipeline；详情是在场判据——瞬断 rethrow 走整源软失败保账，仅 404=该单刚被关跳过）。认领后拉 failed jobs 的 trace，`lib/ci-failures.mjs` 多栈识别（javac/surefire/pytest/jest/go/✗；先剥 ANSI 再剥 runner 时间戳前缀；路径归一到源码根标记起、反斜杠归一——同文件跨 job 同指纹；jest 剥耗时尾缀），以**目标分支最新流水**为基线做 `setDiff` 归因（只认 success/failed 为已知基线，running/canceled/取不到 → `baselineKnown:false` 明说）:引入项进 ack 待修清单与 CI 工单（`buildR1ProfileCI`），基线同款明示不修；**failed job 存在但提取为空，或视角不完整（trace 拉取失败/失败 job 被截断/jobs 翻页截断）且可见部分零引入 → 同为无法归因（`ci_opaque` + job 级工单），不判 inherited_only**；全部同款 → `state:'inherited_only'` + `claim_noop(why)`；视角截断（失败 job 5/总数、jobs 翻页、trace 拉取失败数）记入 `ack.ci` 并在工单可见；ack 的 `fingerprint='ci:<流水id>'`（新流水即重认领重归因），`ci_attributed` 落账。**在途保持与轮次上限（2026-11-17 ci-inflight-hold）**：非终态流水（终态白名单只认 success/failed：running/pending/canceled/未知字串/无流水的秒级窗口一律在途）进 inflight 集合——sweep 对其不关账不重认领（实测事故：执行器推送→流水 running→被当"已合并"误关账）；`ack.ci.rounds` 跨流水累计（sweep 携带），超 `maxRounds` → `needs_human` + `ci_escalated` + 删旧工单不出新工单（防越修越坏无限循环，实测 round1 13→round2 16）；opaque 时失败 job 的 trace 尾部 400 行落 `.ai/task-loop/traces/<id>/`（会话读文件不读凭据）。**本地轮次互斥**：`.ai/locks/task-loop.round` 排他锁（新轮跳过、>30min 孤儿接管、退出自清）——launchd 180s 心跳下轮次超过心跳时防并发写账
- 失败分支：HTTP 非 2xx → 抛错，runner `exit 1` 并打印失败的 path；`/approvals` 404（老版本 GitLab）→ 降级为"有名单无时间"，此时 `approvalValid` 明确返回"无法判定审批时间"→ 按不通过处理（不猜）

> 打回证据三路并列，任一成立且无"更晚的批红"即触发：**他人未解决 resolvable 讨论**、**他人晚于最后一次 push 的 requested changes 动词**，或**他人晚于最后一次 push 的"要求改动"结论评论**（2026-11-17 review-verdict-comment，MR !1916 R2 实测：复审者不再按按钮、以普通评论给出 Request Changes 结论——动词停留在上一轮早于新推送、又无 resolvable 线程，两路全盲）。判据**行首结论锚定**：只认作为一行开头（允许 markdown 标题/加粗/R\d 轮次/「(复审|审查|评审)结论：」标签前缀）的 request(ed) changes/要求改动/打回待修；引用行（>）、疑问句、同行含 LGTM/无需修改/可以合入/approve 的不认（CR 一审 🔴：任意位置子串命中会把引用收尾/提问当新结论，最坏把已批 MR 拉回重做）。工单只带**活评审**：晚于最后一次 push 的评论（推送前的旧结论已被上一轮修复核销，混入会让执行器重做已核销项）。剩余风险：commit 接口瞬断致 lastPushAt 缺失时结论评论按"全部活着"处理（与动词同模式，宁可多跑）；判据双向残面——已知漏报词形（needs changes/请修改/英文 Conclusion:/R2: 冒号速记/「复审：」无结论字），已知残存误报（行首"Request Changes 的点都已核销"类否定句、问号不在行尾）；真实高频出现时扩 LINE_VERDICT 前缀集并补 quin 形态（GitLab 16+；本人发的动词不算，与自留言同口径）。批红要成为"最后的话"必须同时晚于最后一次 push 和晚于打回动词——只看讨论会把"普通评论 + 动词"的真实打回判 pending（2026-11-16 MR !1882 实测，零 resolvable 讨论时打回完全不可见）；只看批红时间会把"a 批过、b 随后要求改动"误判已过停点。批红无时间（`/approvals` 降级）时判不了先后 → 不给 approved，宁可多跑一轮。动词早于最后一次 push 且无未解决意见 → `pending`（新 commit 已覆盖）。

**CAS 认领与 TTL**

- 输入：`claim({cwd, remote, kind, id, ttlMs})`
- 处理：`git commit-tree <空树>` 造**内容唯一**的提交（消息含 host/pid/毫秒），`git push <remote> <sha>:refs/heads/claims/<kind>-<id>`
- 输出：`{claimed:true, ref, sha}` 或 `{claimed:false, reason:'taken'|'zombie', ageMs}`
- 失败分支：非快进/已存在 → 读远端认领时间判僵尸：先 `git show`，本机没有该对象就 `git fetch --depth=1 <ref>` 再读（**跨机必须能读**），仍读不到 → `taken` + `unreadable:true`；过期 → `zombie` 且**不自动抢**，按 blocked 升级给人

> 实测坑：两个竞争者用**同一个 sha** push 同一个 ref，第二次是 no-op 成功——两边都以为自己认领了。

**预算与停点**

- 输入：`runtime.budget.{maxRounds,maxActiveMs,claimTtlMs}`；审批人名单、MR author、最后一次 push 时间、审批时间
- 处理：`createBudget()` **按单任务建**（`maxRounds` 是单任务修复轮次，不是一次 `--once` 处理几个任务）；`approvalValid()` 判"`approved_by` 非空 且 approver ≠ author 且 审批晚于最后一次 push"
- 输出：`{rounds, activeMs}` 快照入 `ack-<id>.json` 与账本；`{ok, reason}`
- 失败分支：等待 CI/人审不计墙钟（`pause/resume` 界定活动区间）；缺审批时间 → `ok:false` + `无法判定审批时间`（判不了就明说不判）；自批/陈批 → 拒绝；认领后任何异常 → `task_failed` + `released`，不留孤儿引用

**轮次围栏与多源容错（2026-11-16 变更 task-loop-close）**

- 输入：各源轮询结果与失败异常（`e.message` + `e.cause.code/message`）
- 处理：临时故障（超时/断网/5xx/429，正则含 `fetch failed`/`ECONN*`/`HTTP 429`/`HTTP 5xx`）→ 跳过该源继续其余源，`source_soft_fail` 落账，**不落节流戳**（exit 1，下一 tick 立即重试）；硬故障（401/403/路径错）→ `die(1)` 整轮停（未成轮，不印围栏——不无声由 die 双通道保证）。成轮必印一行**围栏**：`轮次结束：触发 N / 认领 N / 待复核 N / 跳过 N / 关账 N / 内容更新 N｜耗时｜exit`，走 stdout
- 输出：`.out` 里永远能回答"这轮干了什么/死在哪"——未接入/无触发/正常收尾/软失败四个出口都走 `finish()` 印围栏；硬故障 `die(1)` 是未成轮不印围栏，但 die 双通道（stderr+stdout 同步）保证不无声（配合 wrapper `2>&1`）
- 失败分支：临时故障不 die（单源故障不致盲另一源——2026-11-16 实测：内网 GitLab 断连 9 小时，旧版每 tick 超时 die(1)，剖面 B 全程失明）；不落戳避免"临时故障吃两小时节拍"

**ack 生命周期（关账半环）**

- 输入：本地 `ack-*.json` 与本轮触发集；`triggerFingerprint(t)`（待修项 id 排序投影，不取 body——改错别字不算新意见）
- 处理：认领时 ack 新增 `state`（`working`/`awaiting_rereview`）与 `fingerprint` 字段；每轮 sweep（非 dry-run，且**仅当本轮 GitLab 真实轮询成功且未用 `--mr` 收窄**——软失败/过滤/剖面演练轮里"不在触发集"是视角问题不是事实变化，误关账会释放认领、清零 budget/TTL）：MR 不再触发（合并/批红/关闭）→ 释放认领 + 删 ack 与工单 + `trigger_gone`（关账）；fingerprint 变化（评审新写了东西）→ 重置 ack 重认领（`ack_stale`）；旧格式 ack 无 fingerprint → 一次性重认领迁移（`ack_migrated`，无基准可比对且 pending 可能已过期，重建优于补写）；纯动词零待修 → `claim_noop` + `awaiting_rereview`，认领保留防重复触发空转；同时用 `session-pack` 落 `pack-<id>.md` 会话工单（交互接手即读，headless 自动执行仍留 T5）
- 输出："修完了"在账面上可见（关账计数进围栏行）；待修内容不再挂着旧清单干活；人接手从翻 ack JSON 变成读一份现成工单
- 失败分支：飞书单的关账需按单号反查状态（MQL 单查），本批不做（KI-1 登记）；ack 解析失败跳过不崩（脏文件不阻断轮次）

### 4.5 T4a 失败指纹与基线实跑

- 输入：套件 stdout（含 ANSI 色码与 `(期望 x，实际 y)` 尾巴）
- 处理：`failureFingerprint()` 剥色码、剥尾部参数括号、全角括号归一、截断；`runBaseline()` 在 merge-base 上开 worktree 实跑全量
- 输出：`{introduced, inherited, resolved}` 集合差；基线失败清单
- 失败分支：worktree 清理失败**抛出而不是吞掉**；基线不注入 `HARNESS_LEDGER=off`（有套件断言验账本写入，环境差异≠引入失败）；成功行/计数行不产生身份

### 4.6 T4b 三分流决策与豁免三道闸

- 输入：集合差 + 豁免登记表（指纹 / owner / 到期日）+ flaky 账本 + 本轮全绿数
- 处理：`decide()`——引入>0 → `REWORK`；引入=0 且继承未豁免 → `EXEMPT_REQUIRED`；都过了 → `PASS_TO_REVIEW`
- 输出：动作 + 人话理由 + `exemptionRate`
- 失败分支：闸1 豁免只对指纹相同且未过期的成立（到期在**判定入口**失效，不靠清理任务）；闸2 红绿翻转必须先落 flaky 事件；闸3 豁免率超阈值 → `EXEMPTION_BUDGET_EXCEEDED`。**分母只能由调用方给**，给不出则 `exemptionRate:null` 且不下退化结论（不允许用恒等 1 的"率"充数）

### 4.7 T5 会话打包 / CI 盯梢 / 定时器 / 影子周

- 输入：MR 或 bug 上下文、历轮日志、失败指纹；CI pipeline 状态
- 处理：`session-pack.mjs` 组 R1/Rn prompt；**runner 认领时直接落盘 `pack-<id>.md`**（2026-11-16 task-loop-close：认领即出工单，含接手方式/建档指令/预期产物；空清单终态不落包）；CI 失败工单 `buildR1ProfileCI`（2026-11-17 ci-fail-trigger：引入清单/基线同款/job 链接/日志摘录；无法归因时 `opaque` 标注"先开 job 链接人工定位"）；`ci-watch.mjs` 零 LLM 轮询终态；`install-task-loop.sh` 渲染 launchd/systemd 单元（默认 180s）；`--dry-run` 累积 `shadow.jsonl`，`--report` 出统计
- 输出：`acks.json`/`todo.json`/`round-N.md`；终态或 `timeout`；影子周报告（唯一触发 N / 重复命中 / 按天分布）
- 失败分支：产物缺件 fail-closed（不拿部分产物当完成）；CI 盯梢超时返回 `timeout` 交上层升级（不判红）；安装前校验目标仓库 hook 接线，无接线 `exit 69`；**凭据不进 plist / unit**（见下）
- 定时器的执行体不是 `node`，而是 `$HOME/.harness/task-loop/run-round.sh`（0700）：它把同目录 `task-loop.env`（0600）的**路径**交给 runner（`HARNESS_ENV_FILE`），再 `exec node`。plist / unit 只写"用 `/bin/bash` 跑这个脚本"，**不含任何秘密**。理由不是洁癖——这两个文件会被 `launchctl print` / `systemctl cat` 原样打印到终端，也经常被"贴配置求助"带出去；旧版安装器直接把 `GITLAB_TOKEN` 渲染进去，等于把口令落在一个随时会被展示的文件里。副作用是换 token 只改 `task-loop.env`，不用重装（重装会丢 launchd 的已加载状态）。
  - **凭据文件是数据，不是脚本**：runner 自己按 `KEY=VALUE` 解析（`scripts/lib/env-file.mjs`），**不经 shell**。旧版包装脚本写的是 `set -a; . task-loop.env; set +a`，那让凭据文件变成可执行代码——谁能写它，谁就能以定时器身份执行任意命令。0600 只挡住"别人读"，挡不住"同用户的其他进程写"（编辑器、安装脚本、`>>` 都写得进去）。改成数据后：注释 / 空行 / `export ` 前缀照旧，`$(...)` / 反引号 / `;` 只是普通字符，**认不出的行报错并带行号**（不猜、不执行、不回显原文——那一行可能正是被拼坏的凭据）。
  - 优先级 **进程 env > 文件**：文件是"这台机器平时用哪个凭据"，env 是"这次临时指到别处"。反过来的话临时覆盖会被文件吃掉，症状是"我明明指过去了，怎么还在连老实例"。定时器环境下进程 env 是空的，所以定时器以文件为准。
  - 文件权限在 runtime 也会被查（644/640 告警并给 `chmod 600`），不只在 `--status` 里——`cp` / `rsync` 保留不了 0600，而"能读这个文件"就是"能拿到 token"。
  - `--no-activate` 只写文件不 `launchctl load` / `systemctl enable`：测试要验证落盘与权限，但不该在跑测试的机器上注册一个真定时器。
  - `--status` 顺带查凭据文件权限：`cp` / `rsync` 都保留不了 0600，被改宽是常事，报出来并给 `chmod 600`。
  - 重装时**只更新本次提供的键**，其余行原样保留——否则"换个 url"会把上次配好的 token 清掉；用户手加的 `HARNESS_*` 也不该被抹掉。
  - 旧版写过明文 token 的 plist / unit 会被检测并提示：重写文件不会让已落盘的 token 失效，写过就当泄露，去 GitLab 撤销重建。

### 4.8 T6 剖面 B（飞书 bug）

- 输入：`search_by_mql` 返回的"指派给我、状态未开始的缺陷"
- **配置分三类，各有各的落点**（这是本节最重要的一条，其余都是它的展开）：
  | 类别 | 落点 | 进 git | 理由 |
  |---|---|---|---|
  | 空间身份：`projectKey` / `taskTypes` / `assigneeField` / `newStatus` / `mqlLimit` / `issuer` / `severity.{field,map}` | `harness.rules.json` 的 `runtime.feishu` | 是 | 这是"这个仓库接哪个空间"的**事实**，该跟着代码一起 review；也是定时器能装到别的机器上的前提——环境变量要安装器逐条渲染，漏一个就是一次静默失败（`install-task-loop.sh` 历史上只注入了 `FEISHU_MCP_URL`，`FEISHU_PROJECT_KEY` 从未被注入过） |
  | 用户凭据：`client_id`/`client_secret`/`access_token`/`refresh_token` | `$HOME/.harness/task-loop/feishu-oauth.json`（0600） | **否** | token 等于长期口令，进仓库就是泄露。它已经是配置文件，只是不能放在仓库里 |
  | 临时覆盖 | `FEISHU_PROJECT_KEY` / `FEISHU_WORK_ITEM_TYPE` / `FEISHU_ASSIGNEE_FIELD` / `FEISHU_SEVERITY_FIELD` / `FEISHU_NEW_STATUS` / `FEISHU_MQL_LIMIT` / `FEISHU_ISSUER` / `FEISHU_OAUTH_FILE` | 否 | 一次性动作（临时查别的空间、CI 指向假端点）。优先级 **env > 配置 > 内置兜底**；空字符串按"没配"处理 |
- **数据契约（2026-11-10 对 `taosdata_td` 实测，非文档抄录）**：MQL 的每一处写法都由服务端逐条否决过，三条里只有第一条会报错：
  | 事项 | 正确写法 | 写错的后果 |
  |---|---|---|
  | 表名 | ``FROM `空间`.`工作项类型` `` 两段式 | 单段 → `ErrMoqlSemanticError` + "project_name or project_key is missing"（唯一会报错的一条；空间名本身不存在则报 `ProjectNotFound`） |
  | 指派 | `array_contains(`current_status_operator`, current_login_user())` | 用 `owner` → 静默取到"我创建的"而不是"指派给我的"（该空间 `owner` 是创建者） |
  | 状态 | `` `work_item_status` = 'New' ``（枚举为英文 label：`New`/`Processing`/`Releasing`/`Done`/`Canceled`） | 用中文"待处理" → `attrValueLabel not found`；用 `array_contains` → `operator not supported`（该字段只支持 `IN`/`=`/`!=`/`IS NULL`） |
  | 严重级 | 自定义字段 key（该空间 `field_6bff71`「故障严重级别」，枚举仅 高/中/低） | 写 `severity` → 字段不存在；或换空间没换 key → 读不到值，全部判 P3 被静默丢弃 |
  上述状态与严重级两项不会让查询失败，只会让结果为"空"或"全被过滤"——所以必须有离线 fixture 断言，见 §4.8 末条。
- **严重级词表也在配置里**（`severity.map`），不在代码里。平台严重级是自定义字段，词表随空间变（这一个是 高/中/低，下一个可能是 致命/严重/一般，或 S1/S2/S3），写死在代码里等于"配置化只做了一半"。归一发生在**解析时**：`parseMqlPage` 把平台词映射成 P 档，之后 `gateBySeverity` 只看 P 档。反过来做（解析时用内置词表先归一、gate 时再查配置）会让配置永远不生效——那时手上只有 `P1`，词表里没有 `P1` 这个键。
- **响应形态（实测）**：`{list:[{count}], session_id, data:{"1":[{moql_field_list:[{key, value_type, value}]}]}}`；值有四型 `long_value`/`string_value`/`key_label_value`/`key_label_value_list`。原设计假设的"JSON 数组 / 管道表格"两种形态都不存在，保留为兜底但不作为主路径。**枚举解包取 `label` 不取 `key`**：状态的 key 是 `Not started`、label 才是能当条件用的 `New`，取反会出现"用 `New` 查出来、解析成 `Not started`"的自相矛盾。
- **身份两条路，优先 OAuth**：`mcpKey`/`userKey` 是**插件身份**，开放平台按"空间是否安装该插件"判权限——没有空间管理权限的人取不到任何数据，这不是代码能修的缺陷。`project.feishu.cn/mcp_server/v1` 同时支持标准 MCP OAuth，用户身份凭证代表"用户本人"，数据边界是本人可见范围，**不需要空间管理员**。故：有 OAuth 凭据用它；没有且配了插件凭据才退回插件身份；两者皆无则报错并把两条路都写进提示。
- 授权形态：device code（`verification_uri_complete` + `user_code` + 轮询），不用回调——runner 跑在 launchd/systemd 里可能无可开浏览器的会话，device code 在任意设备点一次同意即可。
- 凭据落点：`$HOME/.harness/task-loop/feishu-oauth.json`，目录 0700 / 文件 0600，`FEISHU_OAUTH_FILE` 可覆盖；过期前 2 分钟自动 `refresh_token`，刷新结果回写（否则每次调用都刷一次）。
- 处理：`parseMqlResult()`（真实 `moql_field_list` 形态为主，JSON 数组与 Markdown 表格为兜底）→ `gateBySeverity()`（P0/P1 或中文"高"=auto，"中"=confirm_first，"低"或缺值=skip）→ 接单三连（评论 / 状态流转 / 读回）
- 输出：`{auto, confirm, skip}`；auto 进本轮触发
- 配置读取：`resolveFeishuConfig({ rules, env })` 合成一份配置（内置兜底 < `runtime.feishu` < 环境变量），runner 与测试共用同一个入口——测试若自己拼参数，测的就不是生产那条路。
- 失败分支：身份被拒（HTTP 401 / `invalid_token`）→ `McpAuthError`，提示重新 login（重试无用）；MCP 权限不足 → `McpPermError`，`exit 1` 并打印"去飞书后台勾工作项读取范围"；MQL 报 `semantic error` → 缺空间名（本地已在发请求前拦下，见 `buildMyBugsMql` 的入参校验）；`ProjectNotFound` → 空间名写错（配置里 `runtime.feishu.projectKey`）；token 响应认不出 → 抛错，**绝不返回空 token**（那会让上层以为"通了但没数据"）；解析不出行 → 抛错，**不返回空数组**（"读不懂"与"没有单子"必须可区分）；目标状态不在 `get_transitable_states` 里 → 拒绝硬转；读回不一致 → 评论兜底留凭，兜底也失败才判红
- 判据：`test/feishu-bug-source.test.sh`（43 条，离线；fixture 抓自真实空间）。六组断言：MQL 形状（两段式表名 / `current_status_operator` / 状态用 `=`）、真实响应解析（含"取 label 不取 key"）、严重级归一（高→P1、中→P2、低/缺值→P3）、截断可见（命中数 > 取回数必须可判）、**配置驱动**（配置读到值 / env 覆盖 / 空串不覆盖 / 缺配置兜底 / 改词表真的改变去向 / 指派字段可配 / 多任务类型各生成不同表名 / 空 `projectKey` 解析成空串而不是字符串 `"undefined"`）、fail-closed。末组是变异检验：把 `current_status_operator` 改回 `owner`、把状态改回中文"待处理"、把严重级字段 key 配错，三处都必须让断言变红——否则上面几组只是"看起来在判"。
- 配置体检：`doctor` 检查 `runtime.feishu` 五个必填项非空、`severity.map` 的值必须落在 P0–P3、以及**该词表是否真有代码消费**（配了没人读 = 换空间时改了配置行为一点没变，比没配更难查）。

### 4.9 接入是扩展条件（两条通道都可以不接，任务类型可选）

- **两条通道都是可选的**：GitLab（剖面 A）与飞书项目（剖面 B）各自独立接入，接了就轮询，一个都没接就 `exit 0`。`--profile` 默认 `auto`，按"配置是否在场"决定跑哪个；两个都配就都跑。
- **显式 `--profile a|b|both` 是一句断言**：指定了却缺配置 → `exit 1` 并点名缺什么。"我就要跑这个"与"顺便看看有没有"必须可区分——静默跳过会让"没接"和"接了但坏了"长得一样。
- **未接入 ≠ 接入坏了**，这是本层最容易混的一对：
  | 情形 | 判据 | 处置 |
  |---|---|---|
  | 凭据不在场（未登录 / 没填 token） | 文件不存在且无 env | 按未接入跳过，逐条说明缺什么，`exit 0` |
  | 凭据在场但被拒 / 过期 | `401` / `invalid_token` | 按故障处理，`exit 1`（否则 token 过期后每轮都"安静地没有任务"） |
  | 配置写了一半 | `url` 有、`token` 无（或反之） | 算未接入，但把缺的那一半写进提示 |
- **任务类型可由用户指定**：`--type 缺陷,需求`（可重复）优先于 `runtime.feishu.taskTypes`。一个 MQL 只能查一种工作项——表名就是类型名，把两种塞进同一句不可能，所以多类型 = 多条 MQL、结果合并。类型名写错时服务端只回 `ErrMetadataError: metadata error`（看不出是自己填错），runner 补一句上下文并点名"该空间没有这个工作项类型名"。
- **GitLab 的用户名不配置**：用 token 调 `GET /user` 取，token 是谁就是谁。空 `username` 会让判定**反向**（`n.author.username !== ''` 恒真 → 自己写的未解决留言全算"他人的打回意见"，实测同一讨论 `triggered` 由 `false` 变 `true`），所以 `unresolvedByOthers` 直接抛错而不是返回空数组。
- **runner 与 doctor 读同一份 GitLab 配置**（`scripts/lib/gitlab-config.mjs`）：`url` 空 = 不接（不算故障）；填成 `/api/v4` 整段 → 判红（代码会再拼一次路径，症状是每次 404、报错像"接口不存在"）。token 除 env 外还认 `$HOME/.harness/task-loop/gitlab-token`（0600）——给"不走定时器、直接 `node scripts/task-loop.mjs`"的场景留一个不必天天 `export` 的落点；定时器自己走 `task-loop.env`（见 §4.7），两者都不进 plist / unit。
- **`task-loop.env` 也由 doctor 读**（同一个 `loadTaskLoopEnv()`）：不读的话，装完定时器的机器上会同时成立两句话——「定时器在跑」与「doctor 说 GitLab 未接入」。同一个问题两个答案等于没有答案，这正是当初 doctor 只认 `HARNESS_GITLAB_*` 的翻版。doctor 会报出生效键数、被 env 覆盖的键数，文件解析不了则判红（定时器每轮都会在这里失败）。

## 5 接口契约

| 方法 | 路径 | 入参 | 出参 | 错误码 |
|---|---|---|---|---|
| GET | `/api/v4/merge_requests?scope=created_by_me&state=opened` | `private-token` | MR 数组（`iid`/`project_id`/`sha`/`author`） | 非 2xx → runner `exit 1` |
| GET | `/api/v4/projects/:pid/merge_requests/:iid/discussions` | 同上 | 讨论数组（`notes[]` 含 `resolvable`/`resolved`/`system`/`created_at`） | 同上 |
| GET | `/api/v4/projects/:pid/repository/commits/:sha` | 同上 | `committed_date` → `lastPushAt` | 404 → `lastPushAt=null`（按无法判定） |
| GET | `/api/v4/projects/:pid/merge_requests/:iid/approvals` | 同上 | `approved_by[]` | 404 → 降级（名单有、时间无） |
| MCP | `search_by_mql` / `get_transitable_states` / `transition_state` / `add_comment` / `get_workitem_brief` | 见 `scripts/lib/feishu-project-mcp.mjs` | 工作项 | `McpPermError` → `exit 1` + 后台指引 |

CLI 契约：`node scripts/task-loop.mjs --once [--profile auto|a|b|both] [--dry-run] [--root <仓库>] [--mr <iid>] [--type <工作项类型>] [--username <逃生口>]`，`--report` 出影子周统计。退出码：0 正常（含无事可做 / 未接入）/ 1 有触发但被安全闸拦、处理失败或**已接入的源坏了** / 64 用法错（含非法 `--profile`）。

## 6 数据变更

| 变更 | 类型 | 迁移脚本 | down 脚本 | 破坏性 |
|---|---|---|---|---|
| `.ai/task-loop/{shadow.jsonl,ack-<id>.json,pack-<id>.md}` | 新增本地文件（ack 带 `state`/`fingerprint` 字段；pack 为会话工单） | 无（首次运行自建目录） | 删目录即可 | 否 |
| `.ai/ledger/events.jsonl` 新增事件类型 `trigger_found/claimed/claim_held/claim_noop/task_failed/released/release_failed/claim_zombie/claim_skip/ack_stale/ack_migrated/trigger_gone/source_soft_fail/ci_attributed/ci_opaque/mr_detail_404/ci_escalated/budget_exhausted/shadow_hit/profile_b_polled` | 追加型 | 无 | 无（只追加不改写） | 否 |
| `refs/heads/claims/<kind>-<id>` | 新增远端分支命名空间 | 无 | `git push origin :refs/heads/claims/<kind>-<id>` | 否（TTL 兜底） |
| `harness.rules.json` 新增 `runtime.budget`（`maxRounds`/`maxActiveMs`/`claimTtlMs`） | 新增配置段 | 无（缺省用代码默认值） | 删段即回默认 | 否 |
| `harness.rules.json` 新增 `runtime.gitlab`（`url`）；`runtime.feishu` 的 `workItemType` 换成 `taskTypes[]` | 新增配置段 + 字段替换 | 无（缺 `taskTypes` 时仍认 `workItemType`，缺 `url` 即视为未接入） | 删段即回"不接" | 否（旧值仍可读） |
| `$HOME/.harness/task-loop/gitlab-token`（0600，可选） | 新增凭据落点 | 无（读不到就回落到 env） | 删文件即可 | 否 |

## 7 交互与状态

- 状态矩阵：`ui_scope=NONE`，无 UI
- 关键交互（命令行可见的部分）：
  - `OFF` 哨兵存在 → 打印位置并 `exit 0`（被停是运维意图，不是故障）
  - `--profile auto`（默认）→ 接了就轮询、都没接就 `exit 0` 并列出缺项；显式 `a|b|both` 缺配置则 `exit 1`
  - `--type <类型>` → 本轮只查指定工作项类型（可逗号分隔或重复），覆盖 `runtime.feishu.taskTypes`
  - `--dry-run` → 每个 tick 命中追加 `shadow.jsonl`，不认领、不推、不起会话
  - `--report` → 输出"唯一触发 N / 重复命中 M / 按天分布 / 验收口径"
  - 认领成功 → `claimed`；本轮未完成 → `claim_held`（**显式配对**，孤儿引用才查得出来）；处理失败 → `task_failed` + `released`

## 8 配置项

| key | 默认值 | 说明 | 是否必填 |
|---|---|---|---|
| `runtime.headless.cli` | `claude` | 无头会话 CLI | 是 |
| `runtime.headless.args` | `["-p"]` | CLI 参数数组 | 是 |
| `runtime.headless.permission_mode` | `acceptEdits` | 权限模式（hook 在场时无需 bypass） | 否 |
| `runtime.headless.hooks` | `true` | `true` 时启动前校验目标仓库 hook 接线 | 否 |
| `runtime.budget.maxRounds` | `3` | **单任务**修复轮次上限 | 否 |
| `runtime.budget.maxActiveMs` | `1800000` | 活动墙钟上限；等 CI/人审不计 | 否 |
| `runtime.budget.claimTtlMs` | `86400000` | 认领存活期，过期按 blocked 升级 | 否 |
| `runtime.gitlab.url` | 空（= 不接） | GitLab 实例**根**地址（不是 `/api/v4`）。扩展项：空即跳过剖面 A，不算故障 | 否 |
| `GITLAB_URL` / `HARNESS_GITLAB_URL` | 无 | 临时指向别的实例（CI 指假服务器）；优先级 env > 配置 | 否 |
| `GITLAB_TOKEN` / `HARNESS_GITLAB_TOKEN` | 无 | PAT（`private-token` 头只认 PAT，OAuth access token 会 401） | 剖面 A 必填 |
| `$HOME/.harness/task-loop/gitlab-token` | 不存在 | token 落点（0600），给直接 `node scripts/task-loop.mjs` 的场景；定时器走 `task-loop.env` | 否 |
| `$HOME/.harness/task-loop/task-loop.env` | 安装时生成（0600） | 定时器的凭据来源（`K=V` 数据，**由 runner 解析，不 source**）。**plist / unit 里没有 token**，换 token 只改这个文件 | 装定时器时生成 |
| `HARNESS_ENV_FILE` | `$HOME/.harness/task-loop/task-loop.env` | 凭据文件路径（`run-round.sh` 会 export 它）。指到不存在的路径 = 该文件不生效，与"未接入"同判据 | 否 |
| `$HOME/.harness/task-loop/run-round.sh` | 安装时生成（0700） | 定时器真正的执行体：交出凭据**路径** → `exec node`（不注入值，不 source） | 装定时器时生成 |
| `GITLAB_USERNAME` / `--username` | 不配 | **不再需要**：默认用 token 调 `GET /user` 取。仅在拿不到 `/user` 时作逃生口；空值会让判定反向 | 否 |
| `runtime.taskLoop.pollSeconds` | `1800`（2026-11-17 定：与修复执行器 30 分钟节拍对齐；初版 7200→16 日 900→17 日 1800） | 轮询节拍（秒）。P1 接单延迟上限 30 分钟；源临时故障不落戳、下一 tick 立即重试（节拍只约束成功轮）。生效前提：定时器心跳 ≤ 节拍（默认 180s 满足） | 否 |
| `runtime.feishu.repoHint` | 空 | 工单（pack）里剖面 B 的目标仓库指引——产品路由是部署事实，随空间配置走，不硬编码进脚手架 | 否 |
| `FEISHU_REPO_HINT` | 无 | 覆盖 `runtime.feishu.repoHint` 的临时手段（切空间/演练） | 否 |
| `HARNESS_GITLAB_PROJECT` | 无 | doctor 门禁在场性检查的目标项目（`group/project`）；不配则只提醒"未检查" | 否 |
| `GIT_REMOTE` | `origin` | 认领 push 的目标远端 | 否 |
| `runtime.feishu.projectKey` | 无 | 剖面 B 接的飞书项目空间标识（如 `taosdata_td`）。缺了 MQL 就是单段表名 = 一句 `semantic error` | 剖面 B 必填 |
| `runtime.feishu.taskTypes` | `["Defect"]` | 要轮询的工作项类型名数组（该空间的"缺陷"叫 `Defect`，`issue` 是禁用的备份类型）。多类型 = 多条 MQL 分别查；`--type` 可临时覆盖 | 否 |
| `runtime.feishu.assigneeField` | `current_status_operator` | 指派判据字段。**不是 `owner`**——该空间的 `owner` 是创建者 | 否 |
| `runtime.feishu.newStatus` | `New` | 待办状态的 label（英文；中文"待处理"不存在于枚举） | 否 |
| `runtime.feishu.severity.field` | `field_6bff71` | 严重级自定义字段的 key（不是 `severity`/`priority`） | 否 |
| `runtime.feishu.severity.map` | `{"高":"P1","中":"P2","低":"P3"}` | 平台词表 → P 档；值必须落在 P0–P3，且**必须在解析时生效**（见 §4.8）。换空间只改这里 | 否 |
| `runtime.feishu.mqlLimit` | `20` | 单次取回上限（夹到 ≤50）。超出时告警 + 落账 `profile_b_truncated` | 否 |
| `runtime.feishu.issuer` | `https://project.feishu.cn` | MCP 端点域名（Lark 国际版另填） | 否 |
| `FEISHU_OAUTH_FILE` | `$HOME/.harness/task-loop/feishu-oauth.json` | 凭据落点（0600）。**凭据只在这里，不进仓库** | 否 |
| `FEISHU_PROJECT_KEY` / `FEISHU_WORK_ITEM_TYPE` / `FEISHU_ASSIGNEE_FIELD` / `FEISHU_SEVERITY_FIELD` / `FEISHU_NEW_STATUS` / `FEISHU_MQL_LIMIT` / `FEISHU_ISSUER` | 见上表 | 覆盖配置的临时手段（切空间、CI 指向假端点）。优先级 env > 配置 > 内置兜底；空串按"没配"处理 | 否 |
| `.ai/task-loop/OFF` | 不存在 | kill switch 哨兵 | 否 |

## 9 测试要点

| 场景 | 断言 | 边界 |
|---|---|---|
| kill switch | 哨兵在 → 退出 0 且提示可恢复位置 | 哨兵是文件不是目录 |
| hook 接线闸 | 无接线 → `exit 1` 且理由点明"绕过全部写入门禁" | `.claude/settings.json` 等价 |
| CAS 双竞争 | 先者胜、后者 `taken` | 同 sha push 同 ref 是 no-op（必须内容唯一） |
| 跨机僵尸 | **两个独立克隆**，B 无对象 → 仍判出 `zombie` 且带 `ageMs` | fixture 先断言"B 本地没有该对象"，否则测不到跨机路径 |
| 触发五形态 | 无意见 / 打回 / 已批红跳过 / 陈批仍打回 / 自留言不算 | 批红时间与 push 时间的先后 |
| 结论评论形态（2026-11-17） | push 后的 Request Changes 结论评论触发（signal=review_comment）/推送前的被覆盖不触发/本人不算/批红晚于结论评论才算最后的话；端到端 ack 只含活评审（R2），旧 R1 不进清单。**误报形态四连钉**：引用收尾（mid-line）、提问句、> 引用行、结论与 LGTM 并存——都不触发；九形态真值表全过 | !1916 R2 实测形态；变异：去信号→断言级红、活评论不过滤→1 红 |
| 动词五形态（2026-11-16） | live 打回（普通评论+撤批+动词，零 resolvable）/ 批红晚于动词不算打回 / 动词早于 push 已覆盖 / 自发动词不算 / 他批后另人动词仍打回 | 动词与 push、动词与批红两组先后关系；fetchTriggers 粗筛同步放行（无信号 MR 仍省 API） |
| 建议性评论（2026-11-16） | 普通评论进 payload `comments` 与 ack；自发/系统留言不进；resolvable note 不双列但同线程普通回复也收（note 级过滤）；空 username 两处抛错；动词型端到端：零 resolvable 时 ack 落 1 条评论（删 fromComments 合并即红） | 评论是 non-resolvable，永远不会被 resolve——只列 resolvable 会得到空待修清单 |
| 未接入 | 一个源都没配 → 退出 0 且逐条说明缺什么 | 显式 `--profile` 时必须 `exit 1`（"我就要跑这个"不许静默跳过） |
| username 派生 | 不配 `GITLAB_USERNAME` 时问 `/user`，自己写的留言不算打回 | 空值在 `unresolvedByOthers` 与 `classifyMr` 两处都抛错（否则判定反向） |
| GitLab 地址形状 | 空/空白 = 不接；`/api/v4`、缺协议、带 API 段 → 判红 | 代码自己会拼 `/api/v4`，配置再带一次就是每次 404 |
| 多任务类型 | `taskTypes` 两项 → 两条 MQL，表名各不相同；`--type` 可覆盖 | 一个 MQL 只能查一种工作项 |
| 真触发端到端 | 假 GitLab → `claimed` → `claim_held`，退出 0 | `--dry-run` 走不到这条路 |
| 认领后异常 | `task_failed` + `released`，远端引用被删，退出 1 | 不得静默 `exit 0` |
| 源临时故障（2026-11-16） | 500/断网 → 不 die、围栏行含 `源故障 gitlab`、不落节流戳（exit 1 下 tick 重试）；401 硬故障仍 die 且报错同步 stdout（die 双通道） | 单源故障不致盲另一源；`.out` 不再只见"凭据已载入" |
| 在途/轮次上限/锁（2026-11-17） | running/无流水窗口/canceled 均保持账目（终态白名单 success/failed，未知字串保守在途）+ success 才关账；rounds 1→2→4 累计，超 3 → needs_human+ci_escalated+无工单；新鲜锁跳过、孤儿锁接管、退出自清；opaque 落 traces 目录 | 变异：去在途保持→1 红、上限放开→1 红、锁失效→1 红；事故形态来自 18:14 误关账实录 |
| CI 红全链（2026-11-17） | 无打回证据+head_pipeline failed → 认领→拉日志→归因（基线绿=2 引入）→工单含失败指纹与日志摘录；同因跨 job 一条指纹；基线同款 → inherited_only+claim_noop(why)+无工单；新流水 → ack_stale 重认领；转绿 → 关账删 ack 与工单。识别器单元：六栈/噪声跳过/路径归一/去重/未知基线保守 | 形态来自 MR !1896 实测（列表无 head_pipeline、runner 前缀、跨 job 前缀不同）；变异五处：关 CI 分支→2 红、归因恒无基线→3 红、路径不归一→1 红、opaque 退回只认完全空→ter2 红、404 无痕→ter3 红；另钉详情瞬断软失败保账（5k-quad）、trace 拉不到/零识别栈→opaque（5k-ter/ter3）|
| 关账半环（2026-11-16） | 触发消失 → 释放认领 + 删 ack 与工单 + `trigger_gone`，围栏计 `关账 1`；fingerprint 变化 → `ack_stale` + 重认领 + ack/pack 更新；纯动词零待修 → `claim_noop` + `state:awaiting_rereview` + 不落 pack；**软失败/`--mr` 过滤轮存量 ack 原样保留**（本轮看不见 ≠ 消失） | 变异验证：临时判定恒假/关 sweep/noop 恒假 → 各自变红（1/3/1）；CR 复审补的负向用例：断连轮不动账 |
| 预算 | 轮次第 N 轮才耗尽；100s 等待不计墙钟；活动 1100ms/上限 1000ms 才耗尽 | `resume()` 记的是"此刻"，时钟顺序反了测不到 |
| 三分流 + 三道闸 | 五形态 + 过期/指纹不同/豁免率 60% 告警 + 7% 不误报 + 分母缺失不猜 | 分母由调用方给 |
| 影子周统计 | 3×#42+1×#43 → 唯一 2；脏行（裸数字/null）不污染 | 按天分布 + 验收口径印出 |
| 定时器安装 | `--print` 无残留占位符；无接线仓库 `exit 69` | 结构判据：`deploy/task-loop/*.template` 里禁止出现 `__*TOKEN/SECRET/PASSWORD/KEY*__` 占位符 |
| 凭据不外泄 | 传假 token 后 `--print` 输出、plist、unit **都不含它** | 明文配置会被 `launchctl print` / `systemctl cat` 原样打出来 |
| 落盘权限 | `task-loop.env` 0600 / `run-round.sh` 0700 / 目录 0700 / plist 0600 | 用 `stat` 不用 `ls -l \| cut`（macOS 带 ACL 时列会错位） |
| wrapper 是唯一入口 | `env -i` 干净环境跑 `run-round.sh` 仍能取到凭据并进入 runner | 必须显式给假 `HOME`：node 的 `os.homedir()` 在 HOME 缺失时回落 passwd 真实家目录，会读到本机真凭据并对外发请求 |
| 凭据文件是数据不是代码 | 文件里写裸命令 → **runner 报错 exit 1 并给行号**，`pwn*` 文件一个都没被创建；`$(...)` / 反引号原样保留不求值 | 判据是"文件没被执行"，不是"报错文案好看"；wrapper 里 `set -a; . file; set +a` 这种一行式也算 source（结构断言查非注释行的 `.` / `source`） |
| 凭据文件优先级 | 进程 env 非空 → 文件不覆盖；env 为空串 → 文件补上；`loaded` / `shadowed` 分开记 | 反过来会让"临时指到别处"失效，症状是"我明明指过去了" |
| doctor 与定时器同一份凭据 | `HARNESS_ENV_FILE` 指过去后 doctor 报出生效键数、不再说"未检查"；文件写成非 `K=V` → doctor 判红 | 否则"定时器在跑"与"未接入"同时成立 |
| 重装幂等 | 未提供的键保留、提供的键更新、手加的键不被抹掉、权限仍 0600 | 整体重写会把上次配好的 token 清掉 |
| 权限漂移 | `--status` 对 644 报"过宽"并给 `chmod 600` | `cp` / `rsync` 都保留不了 0600 |
| 旧版泄露 | 旧 plist 含明文 token → 重装时提示撤销重建 | 重写文件不会让已落盘的 token 失效 |

> 判据有效性用**变异**检验：已做过的十六处（反转触发判定 / 拿掉 `createBudget` / 短路 `release` / 僵尸退回单机 `git show` / 豁免率退回恒等 1 / 去掉空 username 守卫 / 不查 `/user` 只留空串 / `pick()` 退回 `undefined` / 去掉 GitLab 地址里的 `/api/v4` 判据 / wrapper 改回 `set -a; . file` / 非法行改成静默跳过 / 文件强行覆盖 env / doctor 不读凭据文件 / 临时故障判定恒假退回 die / 关掉 ack sweep / noop 终态恒假）分别产生新增红（1 / 2+1 / 1 / 4 / 1 / 3 / 1）。绿不算证据，能变红才算。

## 10 兼容与回滚

- 旧数据怎么办：`harness.rules.json` 缺 `runtime.budget` 时走代码默认值（`3` / `30min` / `24h`），老仓库不改配置也能起
- 旧客户端怎么办：无客户端；`refs/heads/claims/*` 是人可能误 checkout 的斜杠分支，命名即文档，doctor 与 wiring 套件提示
- 出问题怎么回滚：`touch .ai/task-loop/OFF` 立即停（下次 tick 即生效）；`bash scripts/install-task-loop.sh <repo> --uninstall` 卸定时器；认领残留 `git push origin :refs/heads/claims/<kind>-<id>` 或等 TTL
- ci-fail-trigger 变更的兼容口径：CI 触发是**新增形态**，存量打回/飞书路径不变；旧 ack 无 `ci` 字段照常关账；归因基线需要 pipelines?ref 读取权限（PAT 默认有）；`ci:<流水id>` 指纹与旧 ack 的 `empty`/内容指纹不同空间，不会互相误判 stale
- task-loop-close 变更的兼容口径：`pollSeconds` 改配置即生效（不用重装）；**wrapper 的 `2>&1` 与围栏行需重装（或手改 `run-round.sh`）才对已装定时器生效**——不重装也不损失功能，只是旧安装的报错仍只落 `.err`（`die` 双通道已在 runner 侧兼容）；旧 ack 无 `fingerprint` 字段 → 首次被 sweep 读到且触发仍在时**一次性重认领迁移**（`ack_migrated`，重建 ack 与工单——比补写更诚实：旧 pending 清单无基准可比对，可能已过期）；新事件类型为追加型，旧消费者不受影响
- 已知残留（如实记，未修）：① `test/wiring.test.sh` 的 `find -newer` 在秒级粒度下有假通过窗口；② GitHub Actions Node 20 deprecation 警告；③ 真实 GitLab 若既无审批系统留言又无 `/approvals` 权限，审批状态只能判"无法判定"——按不通过处理，不猜，但会多跑一轮
