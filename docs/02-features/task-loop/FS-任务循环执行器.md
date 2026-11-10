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
- 输出：`{kind:'mr', id, mr, unresolved, reviewState, signal}`
- 失败分支：HTTP 非 2xx → 抛错，runner `exit 1` 并打印失败的 path；`/approvals` 404（老版本 GitLab）→ 降级为"有名单无时间"，此时 `approvalValid` 明确返回"无法判定审批时间"→ 按不通过处理（不猜）

> 两条件必须同时成立：**有他人未解决意见 且 无晚于最后一次 push 的有效批红**。只看前一条会把"批了忘 resolve"误判成打回；只看后一条会把"批完又推了 commit"误判成通过。GitLab 没有 GitHub 的 `CHANGES_REQUESTED` review verb，有则用（`signal=review_verb`），无则用讨论证据（`signal=unresolved_discussions`）。

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
- 处理：`session-pack.mjs` 组 R1/Rn prompt；`ci-watch.mjs` 零 LLM 轮询终态；`install-task-loop.sh` 渲染 launchd/systemd 单元（默认 180s）；`--dry-run` 累积 `shadow.jsonl`，`--report` 出统计
- 输出：`acks.json`/`todo.json`/`round-N.md`；终态或 `timeout`；影子周报告（唯一触发 N / 重复命中 / 按天分布）
- 失败分支：产物缺件 fail-closed（不拿部分产物当完成）；CI 盯梢超时返回 `timeout` 交上层升级（不判红）；安装前校验目标仓库 hook 接线，无接线 `exit 69`；凭据只渲染进用户级 0600 配置，绝不进仓库

### 4.8 T6 剖面 B（飞书 bug）

- 输入：`search_by_mql` 返回的"指派给我、状态未开始的缺陷"
- **配置分三类，各有各的落点**（这是本节最重要的一条，其余都是它的展开）：
  | 类别 | 落点 | 进 git | 理由 |
  |---|---|---|---|
  | 空间身份：`projectKey` / `workItemType` / `assigneeField` / `newStatus` / `mqlLimit` / `issuer` / `severity.{field,map}` | `harness.rules.json` 的 `runtime.feishu` | 是 | 这是"这个仓库接哪个空间"的**事实**，该跟着代码一起 review；也是定时器能装到别的机器上的前提——环境变量要安装器逐条渲染，漏一个就是一次静默失败（`install-task-loop.sh` 历史上只注入了 `FEISHU_MCP_URL`，`FEISHU_PROJECT_KEY` 从未被注入过） |
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
- 判据：`test/feishu-bug-source.test.sh`（41 条，离线；fixture 抓自真实空间）。六组断言：MQL 形状（两段式表名 / `current_status_operator` / 状态用 `=`）、真实响应解析（含"取 label 不取 key"）、严重级归一（高→P1、中→P2、低/缺值→P3）、截断可见（命中数 > 取回数必须可判）、**配置驱动**（配置读到值 / env 覆盖 / 空串不覆盖 / 缺配置兜底 / 改词表真的改变去向 / 指派字段可配）、fail-closed。末组是变异检验：把 `current_status_operator` 改回 `owner`、把状态改回中文"待处理"、把严重级字段 key 配错，三处都必须让断言变红——否则上面几组只是"看起来在判"。
- 配置体检：`doctor` 检查 `runtime.feishu` 五个必填项非空、`severity.map` 的值必须落在 P0–P3、以及**该词表是否真有代码消费**（配了没人读 = 换空间时改了配置行为一点没变，比没配更难查）。

## 5 接口契约

| 方法 | 路径 | 入参 | 出参 | 错误码 |
|---|---|---|---|---|
| GET | `/api/v4/merge_requests?scope=created_by_me&state=opened` | `private-token` | MR 数组（`iid`/`project_id`/`sha`/`author`） | 非 2xx → runner `exit 1` |
| GET | `/api/v4/projects/:pid/merge_requests/:iid/discussions` | 同上 | 讨论数组（`notes[]` 含 `resolvable`/`resolved`/`system`/`created_at`） | 同上 |
| GET | `/api/v4/projects/:pid/repository/commits/:sha` | 同上 | `committed_date` → `lastPushAt` | 404 → `lastPushAt=null`（按无法判定） |
| GET | `/api/v4/projects/:pid/merge_requests/:iid/approvals` | 同上 | `approved_by[]` | 404 → 降级（名单有、时间无） |
| MCP | `search_by_mql` / `get_transitable_states` / `update_field` / `add_comment` / `get_workitem_brief` | 见 `scripts/lib/feishu-project-mcp.mjs` | 工作项 | `McpPermError` → `exit 1` + 后台指引 |

CLI 契约：`node scripts/task-loop.mjs --once [--profile a|b] [--dry-run] [--root <仓库>] [--mr <iid>]`，`--report` 出影子周统计。退出码：0 正常（含无事可做）/ 1 有触发但被安全闸拦或处理失败 / 64 用法错。

## 6 数据变更

| 变更 | 类型 | 迁移脚本 | down 脚本 | 破坏性 |
|---|---|---|---|---|
| `.ai/task-loop/{shadow.jsonl,ack-<id>.json}` | 新增本地文件 | 无（首次运行自建目录） | 删目录即可 | 否 |
| `.ai/ledger/events.jsonl` 新增事件类型 `trigger_found/claimed/claim_held/task_failed/released/release_failed/claim_zombie/claim_skip/budget_exhausted/shadow_hit/profile_b_polled` | 追加型 | 无 | 无（只追加不改写） | 否 |
| `refs/heads/claims/<kind>-<id>` | 新增远端分支命名空间 | 无 | `git push origin :refs/heads/claims/<kind>-<id>` | 否（TTL 兜底） |
| `harness.rules.json` 新增 `runtime.budget`（`maxRounds`/`maxActiveMs`/`claimTtlMs`） | 新增配置段 | 无（缺省用代码默认值） | 删段即回默认 | 否 |

## 7 交互与状态

- 状态矩阵：`ui_scope=NONE`，无 UI
- 关键交互（命令行可见的部分）：
  - `OFF` 哨兵存在 → 打印位置并 `exit 0`（被停是运维意图，不是故障）
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
| `GITLAB_URL` / `GITLAB_TOKEN` | 无 | 剖面 A 凭据；缺失即 `exit 1` | 剖面 A 必填 |
| `GITLAB_USERNAME` | 空串 | 判"他人留言"用；为空则任何人的未解决意见都算他人 | 建议填 |
| `GIT_REMOTE` | `origin` | 认领 push 的目标远端 | 否 |
| `runtime.feishu.projectKey` | 无 | 剖面 B 接的飞书项目空间标识（如 `taosdata_td`）。缺了 MQL 就是单段表名 = 一句 `semantic error` | 剖面 B 必填 |
| `runtime.feishu.workItemType` | `Defect` | 工作项类型名（该空间的"缺陷"叫 `Defect`，`issue` 是禁用的备份类型） | 否 |
| `runtime.feishu.assigneeField` | `current_status_operator` | 指派判据字段。**不是 `owner`**——该空间的 `owner` 是创建者 | 否 |
| `runtime.feishu.newStatus` | `New` | 待办状态的 label（英文；中文"待处理"不存在于枚举） | 否 |
| `runtime.feishu.severity.field` | `field_6bff71` | 严重级自定义字段的 key（不是 `severity`/`priority`） | 否 |
| `runtime.feishu.severity.map` | `{"高":"P1","中":"P2","低":"P3"}` | 平台词表 → P 档；值必须落在 P0–P3，且**必须在解析时生效**（见 §4.8）。换空间只改这里 | 否 |
| `runtime.feishu.mqlLimit` | `20` | 单次取回上限（夹到 ≤50）。超出时告警 + 落账 `profile_b_truncated` | 否 |
| `runtime.feishu.issuer` | `https://project.feishu.cn` | MCP 端点域名（Lark 国际版另填） | 否 |
| `GITLAB_URL` / `GITLAB_TOKEN` | 无 | 剖面 A 凭据；缺失即 `exit 1` | 剖面 A 必填 |
| `GITLAB_USERNAME` | 空串 | 判"他人留言"用；为空则任何人的未解决意见都算他人 | 建议填 |
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
| 真触发端到端 | 假 GitLab → `claimed` → `claim_held`，退出 0 | `--dry-run` 走不到这条路 |
| 认领后异常 | `task_failed` + `released`，远端引用被删，退出 1 | 不得静默 `exit 0` |
| 预算 | 轮次第 N 轮才耗尽；100s 等待不计墙钟；活动 1100ms/上限 1000ms 才耗尽 | `resume()` 记的是"此刻"，时钟顺序反了测不到 |
| 三分流 + 三道闸 | 五形态 + 过期/指纹不同/豁免率 60% 告警 + 7% 不误报 + 分母缺失不猜 | 分母由调用方给 |
| 影子周统计 | 3×#42+1×#43 → 唯一 2；脏行（裸数字/null）不污染 | 按天分布 + 验收口径印出 |
| 定时器安装 | `--print` 无残留占位符；无接线仓库 `exit 69` | 凭据不进仓库 |

> 判据有效性用**变异**检验：已做过的五处（反转触发判定 / 拿掉 `createBudget` / 短路 `release` / 僵尸退回单机 `git show` / 豁免率退回恒等 1）分别产生 6 / 4 / 1 / 1 / 1 条新增红。绿不算证据，能变红才算。

## 10 兼容与回滚

- 旧数据怎么办：`harness.rules.json` 缺 `runtime.budget` 时走代码默认值（`3` / `30min` / `24h`），老仓库不改配置也能起
- 旧客户端怎么办：无客户端；`refs/heads/claims/*` 是人可能误 checkout 的斜杠分支，命名即文档，doctor 与 wiring 套件提示
- 出问题怎么回滚：`touch .ai/task-loop/OFF` 立即停（下次 tick 即生效）；`bash scripts/install-task-loop.sh <repo> --uninstall` 卸定时器；认领残留 `git push origin :refs/heads/claims/<kind>-<id>` 或等 TTL
- 已知残留（如实记，未修）：① `test/wiring.test.sh` 的 `find -newer` 在秒级粒度下有假通过窗口；② GitHub Actions Node 20 deprecation 警告；③ 真实 GitLab 若既无审批系统留言又无 `/approvals` 权限，审批状态只能判"无法判定"——按不通过处理，不猜，但会多跑一轮
