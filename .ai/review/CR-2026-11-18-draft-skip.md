# CR 代码审查记录 — draft-skip（Draft MR 不列入修复执行腿，未提交变更）

- 审查范围：`92e72ae`（baseline）→ 工作区未提交（6 文件：`scripts/lib/gitlab-triggers.mjs`、`scripts/task-loop.mjs`、`test/task-loop.test.sh`、`harness.rules.json`、`docs/01-requirements/RS-task-loop.md`、`docs/02-features/task-loop/FS-任务循环执行器.md`；另有 `.ai/tasks/draft-skip/state.json`、`.ai/verify/DS1.log`）
- 关联 FS：`docs/02-features/task-loop/FS-任务循环执行器.md` §4.4/§8/§9（新增行实测落在 L67/L229/L256）
- 关联 SR 报告：RS-task-loop US-1（L26 新增 Draft 验收行）
- **已加载的 skill**：`harness v1.1.0`（`node scripts/resolve-skills.mjs --diff` 命中 `scripts/lib/gitlab-triggers.mjs`、`scripts/task-loop.mjs`、`test/task-loop.test.sh`；H1–H9 已通读）
- 审查人复跑：`bash test/task-loop.test.sh` → **122 通过，0 失败**（2026-11-18 审查机裸跑；入库依据仍以 `.ai/verify/DS1.log` 标准头日志为准）

## 0 硬规则逐条核（harness skill，必填）

| # | 规则 | 检测命令 / 查法 | 结果 |
|---|---|---|---|
| H1 | 改 `scripts/**` 同批带测试 | `git diff --name-only HEAD`：scripts 2 件非空 → test/ 变更须非空 | ✅ `test/task-loop.test.sh` +69 行（5r 单元 + 5r 端到端），120→122 |
| H2 | 生成物禁止手改 | `git status`：未触 `.claude/`、`.zcode/`、`prompts/` | ✅ 未命中（改动仅上述 6 文件 + .ai/ 两处；源未动无漂移，无需重建） |
| H3 | 解析失败 fail-closed | 无 hook/解析器改动 | 未命中。注：`isDraftMr` 缺字段返回 false（按非 draft 走原行为）——过滤器 fail-open 方向=维持改动前行为，可接受，见 §3 备注 |
| H4 | 名单/保护区只写配置 | 无新增路径字面量；`skipDrafts` 是行为开关，落 `harness.rules.json` runtime 段（L190） | ✅ |
| H5 | skill 结构约束 | 未改 `.skills/**` | 未命中 |
| H6 | 新规则同批给合法绕过 | `runtime.taskLoop.skipDrafts=false` 整体恢复，RS/FS §8/state 注三处有档 | ✅ |
| H7 | 新 hook 双 CLI 接线 | 无新 hook | 未命中 |
| H8 | 配置新键有消费者 | `npm run doctor` 通过（审查机实跑）；键清单只到 `runtime` 顶层（`scripts/doctor.mjs:176-193` 静态清单），子键 doctor 无法证伪——直读代码确认消费者：`scripts/task-loop.mjs:281` | ✅（以直读为准） |
| H9 | 断言可证伪 + 变异结果 | 交付说明含变异矩阵（isDraftMr 恒假→2 红、sweep 退化→1 红、列表层→被详情层中和）；与测试结构交叉核对自洽，**评审未复跑变异**（需改源码，超只读审查边界）。但详情层防线/开关恢复/省 API 三条旁路无 committed canary——删掉后 0 红 | ⚠️ 部分 → 🟡#2 |

## 1 改动摘要

用户指令「draft 类型的 MR 暂时不列入修复执行腿」（背景：!1847 为 Draft，执行器昨夜在其上跑了 5 轮修复）。实现：`isDraftMr`（`work_in_progress` 权威 + `Draft:/WIP:` 标题前缀兜底，`gitlab-triggers.mjs:217`）+ `fetchTriggers` 双层过滤（列表层 `:249` 在 discussions 拉取**之前**=省整串 API；详情层 `:273` 兜列表缺字段，仅挂无评审信号分支）+ `drafts` 集合透传（数组属性 spread 丢失同款处理，`task-loop.mjs:283`）+ sweep draft 关账分支（`why=draft`，先于 inflight 保持，`task-loop.mjs:427`）+ `skipDrafts` 开关（默认 true，`!== false` 读法）+ 轮询提示行（`:287`）。RS/FS 同批更新。

## 2 阻断项 🔴

无。

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | `gitlab-triggers.mjs:217-219`（isDraftMr 兜底）、`:273`（详情层复核仅挂无评审信号分支） | 兜底正则缺 GitLab 官方现行前缀形态 `(Draft)`/`[Draft]`（官方文档：Add `[Draft]`, `Draft:` or `(Draft)` to the beginning of the title；`WIP:` 自 GitLab 14.0 起移除），而详情层复核只在 CI 路径（`!hasReviewSignal` 块内）存在——打回/结论评论路径不拉详情、无 draft 复核。三条件叠加（列表缺 `work_in_progress` + 括号/方括号标题 + 存在打回信号）时 draft MR 仍会被认领修复=旧行为漏网；本实例列表接口已实测缺过字段（head_pipeline），该组合非纯理论 | 正则补 `^\((draft\|wip)\)` 与 `^\[(draft\|wip)\]`（一行改动），或把详情层复核提到两路共用位置（成本：触发路径每单多一次详情调用） | 修（小） |
| 2 | `test/task-loop.test.sh:264-330` | 新增行为只有主路径有 canary，旁路全绿：① 删详情层 `:273` → 套件仍 122 绿（e2e phase 2 列表层带字段先命中，作者变异矩阵也只证明了反向）；② `skipDrafts=false` 恢复路径破坏 → 0 红；③ 列表层省 API（不打 discussions）无断言 | 补一组小用例：a) fetchTriggers 单元——列表项无 `work_in_progress`、无前缀、无评审信号，详情返回 `work_in_progress:true` → 断言 `out.drafts` 含该 MR 且无触发（钉死详情层）；b) `skipDrafts:false` 时 draft MR 照常进触发集；c) mock 记录请求路径，断言 draft 分支未打 `/discussions` | 修（小） |
| 3 | `task-loop.mjs:427-435`（draft 关账）× `:455`（carryRounds 只在指纹变化分支携带） | draft 关账删 ack 后，ready 重新纳入时轮次从 1 重计；`needs_human` 态转 Draft 同样被清档（分支不区分 ack state）。maxRounds 升级保护（防越修越坏）会被 draft→ready 循环重置——每人工翻一次可再推 maxRounds 轮。人工门控下可接受，但与该保护意图相悖 | `trigger_gone(why=draft)` 落账时带 rounds，重新认领作下限种子；或至少在 FS §4.4 写明「ready 即重计轮次」是有意语义 | 延后（先补文档语义，机制后续小批） |

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| `scripts/task-loop.mjs`（唯一运行时调用方） | 受影响（即本变更本体）：`fetchTriggers` 新签名参数有默认值，不传=跳过 draft | `:26` import、`:281` 调用；全仓 grep `fetchTriggers\|isDraftMr` 仅 task-loop.mjs 与 test 引用 |
| `test/task-loop.test.sh` 既有 fetchTriggers 用例（:236/:438 两组） | 不受影响（fixture 无 draft 形态，122 全绿实跑确认） | 套件实跑 122/0 |
| hooks / 生成物 / 其他 scripts | 不受影响 | `git status` 仅 6 文件；`.claude/`、`.zcode/`、`prompts/`、`hooks/` 未触 |
| ack/pack 消费者（会话包读写） | 不受影响：drafts 是数组附加属性，与 inflight 同款「spread 丢失单独捕获」处理 | `task-loop.mjs:283` |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入（SQL / 命令 / 模板） | 无新面：MR title 只进正则判定，不进 shell/模板；配置键为布尔 |
| 越权（横向 / 纵向） | 无：沿用既有 token，无权限扩张 |
| 敏感信息进日志 | 无：token 用法未动；提示行只打条数 |
| 依赖变更 | 无 |

## 6 测试覆盖

| 新增行为 | 是否有对应测试 | 备注 |
|---|---|---|
| isDraftMr 判定（wip 字段 / Draft:/WIP: 前缀命中、普通标题、mid-title "drafts" 不误伤） | ✅ 5r 单元 | 🟡#1 的括号/方括号形态不在用例里 |
| 全链：认领 → 转 Draft 关账（why=draft + 删 ack + 提示行）→ ready 自动重纳入 | ✅ 5r 端到端（三 phase 假 GitLab 服务器） | mock 列表带 `work_in_progress:true`，故只钉死列表层 |
| 详情层兜列表缺字段 | ❌ 无 committed canary | 🟡#2 |
| skipDrafts=false 整体恢复 | ❌ 仅文档 | 🟡#2 |
| 列表层省 API（draft 不打 discussions） | ❌（代码序已核：`:249` 先于 `:252` discussions 拉取，打回/结论评论路径同样在列表层拦截即省） | 🟡#2 |
| 变异检验 | 作者报 3 组（恒假→2 红 / sweep 退化→1 红 / 列表层被详情层中和） | 评审交叉核对与测试结构自洽，未复跑（只读边界）；DS1.log 有标准头 |

## 7 结论

- 🔴 数量：0
- 🟡 已全部表态：是（#1 修、#2 修、#3 延后并补文档语义）
- 建议：**approve**（可交付）——判定权威字段用对了、双层过滤方向正确、关账路径与 inflight/软失败/`--mr` 轮的互斥（`gitlabViewComplete`，`task-loop.mjs:411`）闭合、开关可逆且三处有档、122 全绿审查机复跑属实；三条 🟡 均为旁路加固与 canary 补钉，不阻断本变更。approve 权在人。

### 审阅范围与未覆盖

- 已核：全部 6 文件 diff 逐行；两个源文件全文上下游（sweep 顺序、soft-fail/--mr 互斥、needs_human 交互）；FS/RS 新增行与实现一致；doctor 实跑；测试套件真跑 122；GitLab 官方文档核对 Draft 前缀形态（现行 `Draft:`/`(Draft)`/`[Draft]`，`WIP:` 已于 14.0 移除——见 docs.gitlab.com/user/project/merge_requests/drafts）。
- 未核：变异矩阵未复跑（需改源码，超出只读审查权限——建议父 agent 按作者矩阵复跑一轮）；真实 GitLab 实例上列表接口是否带 `work_in_progress` 未实测（代码按不信任处理，方向正确）；launchd/systemd 定时器形态下的长期行为未观察。
