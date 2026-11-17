# RS-ci-fail-trigger：CI 失败触发与归因工单（change，关联 task-loop）

> S 档 rs（变更任务）。行为细节以 `FS-任务循环执行器.md` §4.4/§4.7（本次同批更新）为准。

## 1 背景与痛点

用户问："对我提交的 PR，能发现 CI 失败、找到 CI 日志、定位修改吗？"——实测（2026-11-17，git.tdengine.net）答案是**当时不能**：

1. 触发判定只认打回（他人未解决讨论 / requested-changes 动词），CI 红不是触发形态；
2. 实例的 MR **列表接口不带 `head_pipeline`**（8 条 open MR 全空，详情接口才有）——任何只看列表的机制天然失明；
3. T4a/T4b 的指纹与三分流是已测纯函数，但从没接到 runner 上；CI 日志（job trace）没有任何拉取路径。

活样本：rd-app/idmp MR !1896（element access scope 修复）pipeline 80351 红——两个 job 同因 javac 编译错（`cannot find symbol` ×7 + `FileResource.java` 字段 `elementAccessScopeService` 重复定义，疑似 62c3b5b478 部分撤回残留），日志带 runner 时间戳前缀，同一文件在不同 job 的绝对路径前缀不同。

## 2 用户故事

- **作为**：MR author（提交者）
- **我希望**：我提的 PR 一旦 CI 红，本地循环自动发现、拉取失败 job 日志、区分"本 MR 引入"与"目标分支基线同款"，并给修复会话一份带失败指纹与日志摘录的工单
- **以便**：CI 红不过夜，且不在自己的 MR 里修基线存量红（改了反而污染 MR）

**验收标准**

- Given 我的 open MR 无打回证据且 `head_pipeline.status=failed`（详情接口）When 轮询 Then 触发 `ci_pipeline` 信号并 CAS 认领
- Given 认领成立 Then 拉 failed jobs 的 trace，多栈识别失败行（javac/surefire/pytest/jest/go/本仓库 ✗），跨 job 按指纹去重（同文件不同绝对前缀同指纹）
- Given 目标分支最新流水 Then 作归因基线：绿 → 全部按引入；红 → 复用 T4a `setDiff` 分引入/继承/顺手修好；取不到 → 明说 `baselineKnown:false`（保守全引入，不静默）
- Given 引入项非空 Then ack（`state:working`、`fingerprint:ci:<流水id>`、`ci` 字段）+ CI 失败工单（引入清单 + 基线同款 + job 链接 + 日志摘录）+ `ci_attributed` 落账
- Given 全部为基线同款 Then `state:inherited_only` + `claim_noop(why)`，不落工单、不在本 MR 修
- Given failed job 存在但失败行提取为空（trace 拉不到 / 日志形态不被识别），**或视角不完整（部分 trace 失败/失败 job 截断）且可见部分零引入** Then **不判"不修"**：`ci_opaque` 落账 + job 级工单（打开链接人工定位）——空提取与半盲视角都 ≠ 全继承（CR 一审 🔴#1 + 二审 🔴#1′）
- Given MR 详情 404（刚被关/合并的竞态）Then 跳过该单但落 `mr_detail_404` 观测（持续 404 不无痕）
- Given 基线流水非 success/failed（running/canceled/skipped/取不到）Then `baselineKnown:false` 明说，失败仍全列——running 不是绿（CR 一审 🟡#2）
- Given 详情拉取瞬断 Then 整源软失败保账（在场判据不许吞错，404=该单刚被关才跳过）——"本轮看不见 ≠ 消失"（CR 一审 🔴#2）
- Given 推新 commit → 新流水红 Then fingerprint 变化 → `ack_stale` 重认领重归因；修好转绿 Then 触发消失 → sweep 关账（ack 与工单同删）

## 3 核心需求

| # | 需求 | 来源 |
|---|---|---|
| C-1 | 触发第三形态：`ci_pipeline`（逐单拉详情判 `head_pipeline`——列表接口实测缺失） | 痛点 1/2 |
| C-2 | `lib/ci-failures.mjs`：runner 前缀剥离、路径归一（源码根标记起）、六栈失败行识别、trace 拉取与跨 job 去重、基线取用 `setDiff` | 痛点 3 |
| C-3 | 会话工单 `buildR1ProfileCI`：只修引入项，基线同款明示"不在本 MR 修" | 用户故事 |

## 4 非功能约束

- API 成本：每轮 = 无打回证据的 open MR × 1 次详情调用；认领时 = failed jobs × trace + 基线流水一次（900s 节拍下可忽略）
- 自动执行修复仍留 T5（headless 影子周准入）——本批交付"定位到工单"，修改由交互会话按工单执行
- 失败行是身份不是全文：指纹剥行号/列号/绝对前缀，摘录限 8 行/job

## 5 范围外

- T4b 豁免三道闸的 state 持久化（inherited_only 是其简化前形态）
- 本地 merge-base 双树实跑（T4a 原设计，重项目全量测试一轮几分钟起，留需要本地复现的场景）
- 定时拉全量 trace 的日志归档

## 6 术语表

- **引入（introduced）**：MR 流水有、目标分支基线没有的失败——本 MR 造成的，要修
- **基线同款（inherited）**：两边指纹相同的失败——目标分支存量红，不在本 MR 修（污染 MR）
- **ci fingerprint**：`ci:<pipelineId>`——新流水即内容变化（重认领重归因）；行级指纹去重在认领时做
- **inherited_only**：CI 红但零引入项的终态——等基线修复或 MR 转绿

## 7 开放问题

- 基线取"目标分支最新流水"而非 merge-base 点的流水：极端情况下最新流水晚于 MR 基点、包含别人的新红，会把真引入误判继承（方向是漏修而非误修，下一拍新流水会重评）；需要精确时再接 T4a 双树
- 视角截断三处已透明化（maxJobs=5 / jobs per_page=100 / trace 拉取失败计数进 ack.ci 与工单），但**不自动翻页/补拉**——超限真实出现时再实现（同剖面 B LIMIT 截断口径）
- `head_pipeline` 是 MR 当前 head 的流水；pipeline 重跑（同 sha 新流水）会因 fingerprint 变化触发重认领——多一次归因调用，结果可能相同（可接受）
