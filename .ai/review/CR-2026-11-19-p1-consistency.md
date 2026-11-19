# CR 代码审查记录 — p1-consistency：retro 豁免对齐 + 提交身份机器可判

- 审查范围：本地未提交变更（基线 `3f28e82` → 工作区）。行为改动 `hooks/lib/verify.mjs`（+26/-3）；配套 `.ai/tasks/p1-consistency/`（新增，untracked）、`.ai/verify/PC1.log`、`.ai/verify/PC2.log`（M）。
- 关联任务：`.ai/tasks/p1-consistency/state.json`（change tier 2，`related_task=task-loop`，`baseline=3f28e82`，S 档，stage=impl）。
- **已加载的 skill**：`harness v1.1.0`（`node scripts/resolve-skills.mjs --diff` 命中 `hooks/lib/verify.mjs`，唯一命中）。
- 审查标准：AGENTS.md 硬规则 + harness SKILL.md H1–H9 + 任务自述验收主张（gate 全绿 / 单测三形态 / 豁免与 :647 同构 / 三连咬根治 / A2 机器可判）。
- 审查方式：全部主张当轮独立复跑或对源核读；作者自述仅作主张清单，不作证据。

## 0 硬规则逐条核（harness H1–H9，改 hooks/** 全适用）

| # | 规则 | 检测命令/查法 | 结果 |
|---|---|---|---|
| H1 | 改 `hooks/**` 必须同批新增测试场景 | `git diff --name-only HEAD \| grep -E '^(hooks\|scripts)/'` → 命中 1；`git diff --name-only HEAD \| grep -c '^test/'` → **0**（untracked 亦无） | 🔴（见 🔴2） |
| H2 | 生成物禁止手改 | `npm run check:agents && npm run check:hooks` 在 gate 链前段通过（本次 gate 唯一红点在 ci-verify，见 🔴1） | ✅ |
| H3 | 解析失败 fail-closed | 本次未新增 state 解析路径；新增的两处 catch 为"判不了不判"，属仓内既有声明口径，非 `return 0` 伪装放行 | ✅ |
| H4 | 名单/受保护区字面量只进 config | `'yyuan@taosdata.com'`、`'2026-11-19'` 硬编码于 verify.mjs:1002-1004 | 🟡（见 🟡3） |
| H5 | skill 结构约束 | 未改 skill | 未命中 |
| H6 | 新拦截规则同批给出合法绕过 | 身份校验合法绕过=显式 `GIT_AUTHOR_*/GIT_COMMITTER_*`（fail 文案已指明）；retro 豁免本身即 H6 语义的"合法绕过"落地 | ✅ |
| H7 | 新增 hook 双 CLI 接线 | 未新增 hook；两个消费者 `hooks/guard_state.mjs:118-119`、`scripts/ci-verify.mjs:121-122` 直接调导出函数，自动继承 | ✅（未命中） |
| H8 | 配置键必须有消费者 | 未新增配置键（正因如此才有 🟡3） | 未命中 |
| H9 | 新断言可证伪 + 变异结果 | 无测试即无变异检验——并入 🔴2 | 🔴 |

## 1 改动摘要

两条门禁判定修正，对应架构体检 A1/A2：① `checkRetroLanding`（verify.mjs:911）补认 `stage_history` 中 retro 条目 `gate=deferred + waived_by 非空字符串` 的豁免——此前同一份 state 在跳阶判定（认豁免）与 retro 落盘判定（不认）之间口径分裂，造成"三连咬"；② `checkStageExit`（verify.mjs:1002-1015）对 created≥2026-11-19 的任务，用 `git log --format=%ae -1 -- .ai/tasks/<slug>` 校验最后提交作者=本人邮箱，判不了 catch 跳过。意图成立、方向正确；阻断项均在配套证据与流程，不在判定逻辑本身。

## 2 阻断项 🔴

| # | 位置 | 问题 | 依据 | 建议 |
|---|---|---|---|---|
| 1 | `.ai/tasks/p1-consistency/state.json` todos[].id（PC1/PC2）+ `.ai/verify/PC1.log`、`PC2.log` | **todo id 跨任务撞名，覆盖了存量任务 poll-config 的验证证据，`npm run gate` 实测红。** `.ai/verify/<id>.log` 是全局命名空间；poll-config（done，S 档，11-14）的 PC2 日志正是 `.ai/verify/PC2.log`（HEAD 版头部 `# task: poll-config`，`cmd: npm run gate`）。本任务 verify-run 用同名 id 落盘覆盖后，poll-config 的 S 档折叠检查（checkStageExit 要求日志 `# task:` 头=poll-config，verify.mjs:931-960）失去证据 → CI 口径 `✗ poll-config: (task) [exit] 找不到任何 cmd 含 npm run gate 的 verify 日志`。**本 CR 当轮实测 `npm run gate` exit≠0**——与 todo audit"npm run gate 全绿"的直接矛盾可解释：verify-run 先将命令输出收进 mktemp 临时文件、命令结束后才组装落盘（scripts/verify-run.sh:118 `${CMD[@]} > $OUT`），作者两次跑 gate 时旧证据尚在（真绿），覆盖落盘发生在 gate 之后；此后任何一次 gate/CI 都会红。若带此状态提交推送，CI 必挂。 | `git show HEAD:.ai/verify/PC2.log` 头 6 行；poll-config state todos PC2 `verify.log_path=.ai/verify/PC2.log`；本 CR 实测 `node scripts/ci-verify.mjs` 输出 ✗ poll-config；verify-run.sh:31-33 注释明记此坑"实测踩过一次" | ① 本任务 todo id 改全局唯一名（如 `PC1R`/`PC2I`，verify-run 报错信息也建议"任务名下加前缀"）；② `git checkout -- .ai/verify/PC1.log .ai/verify/PC2.log` 还原 poll-config 证据；③ state.json 的 `verify.log_path` 同步改名并重跑 `bash scripts/verify-run.sh <新id> --task p1-consistency -- npm run gate`；④ 复跑 `node scripts/ci-verify.mjs` 确认 poll-config 红点消失 |
| 2 | `test/`（整目录零改动）；`.ai/tasks/p1-consistency/state.json` todos[].audit.tests | **H1 违规：改 `hooks/**` 无同批测试，且 audit 的"单测三形态"主张无任何痕迹。** 两条新判定（retro 豁免、身份校验）在 test/ 下无用例；audit.tests 写"单测三形态（豁免放行/无豁免拦/有文件放行）"，但 PC1.log 的 cmd 是裸 `npm run gate`，工作区无单测文件、无执行痕迹——按"主张≠证据"记未核实。豁免分支在当前仓内**零踩达**（见 §6），gate 全绿对它无验证力；身份校验仅 happy path 被 p0-stability/perf-early 踩到（本 CR 实测两任务最后提交均=yyuan，过）。负向路径（非 yyuan 拦、gate=pass+waived_by 不放行）当前完全无机器验证。 | H1 检测命令实测：hooks 命中 1、test/ 计数 0；SKILL.md H1 原文"没有测试的门禁改动一律不合" | 在 `test/retro-check.test.sh` 补三形态：deferred+waived_by 放行 / gate=pass+waived_by 非空**不**放行 / waived_by 非字符串（数字、true）不豁免；身份校验补正负向（fixture git 仓：yyuan 过 / 非 yyuan 拦 / created<2026-11-19 不查 / 目录无提交放行）。按 H9 附变异说明（改坏哪一行哪个用例红） |

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | verify.mjs:1004（`git log -1`） | **身份校验覆盖面与 A2 主张不符**：只查"最后一条"且只扫 `.ai/tasks/<slug>` 路径。A2 的历史痛点提交（如 45dbc58 收尾、557d8b9/577d8b9 feat 类）中，凡不触碰任务目录的代码提交不在扫描范围；触碰过的也会被任何后续本人提交（如 close 时的 state 提交）掩盖——本地 hook 查"翻转前最后一条"、CI 查"close 提交"，两道合盖仅最后两条。PC2 audit"zwork@local 提交将在此后任务被 CI 拦截"主张过强。 | 改全量口径：`git log --format=%ae -- .ai/tasks/<slug>` 的作者**集合** ⊆ {yyuan@taosdata.com}。新任务目录按规则 9 本就该全部本人，无误拦面；实现增量一行 | 修（同批或紧随） |
| 2 | verify.mjs:906-910 注释；对照 :646-653 | **"与 :647 hasWaiver 同构"不成立**：verify.mjs 无 `hasWaiver` 函数；改前 :647 实为 `everySkippedNamed` 内联判定（属 `checkStage` 跳阶检查，**不在 checkStageExit**），且只查 `typeof waived_by==='string' && trim()`，无 `gate==='deferred'` 条件。新代码更严（多要 gate）→ 矛盾数据（gate=pass 且 waived_by 非空）下两处判定分叉：跳阶被认、retro 豁免不被认。方向保守无绕过风险，但注释指向的函数、位置与"同构"自述三处失实，误导后来者。 | 改注释指向 `everySkippedNamed`（checkStage）；口径二选一统一（建议后续让 everySkippedNamed 也要求 gate=deferred，属行为变更另立任务） | 修注释（口径统一另立） |
| 3 | verify.mjs:1002-1004 | 门控日期 `'2026-11-19'` 与身份基线 `'yyuan@taosdata.com'` 硬编码。日期常量有 `S_FOLD_FROM` 先例可容忍；邮箱是"身份白名单"性质，与 `gates.retroCheckFromDate` 已配置化的既有模式（harness.config.json:284）不一致，换人/协作需改门禁源码。 | 移入 `harness.config.json` 的 `gates`（如 `identityCheckFromDate` + `identityEmails`），代码读配置——与 H4 精神和 H8 消费者检查闭环 | 延后可（下批配置化） |
| 4 | `hooks/write-allowlist.txt`（hooks/lib/verify.mjs 条目） | 考卷区放行条存在但理由是"SCHEMA_VERSION/migrate 迁移链（方案 §9）｜2026-11-25"（10-30 批），不覆盖本批内容（retro 豁免+身份校验）；本批也未加新行（开发期 OFF 置位）。路径匹配即机器放行，但"加的人负责解释原因"的审计语义已脱节。 | 由人补一条本批放行条（或引用会话授权记录追认），使授权链与实际改动对得上 | 修（一行追认） |

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| `hooks/guard_state.mjs:118-119`（本地落盘前 hook） | 是，自动继承两判定；retro 豁免使"deferred 任务 close"从被拦变放行（本意）；身份校验在 stage 翻 done 的写入时查"已提交历史的最后一条"（close 提交尚未发生） | 当轮读源 |
| `scripts/ci-verify.mjs:121-122`（CI，全任务扫描） | 是；**poll-config 因证据被覆盖在 CI 口径翻红（🔴1）**；存量 done+≥11-19 任务（p0-stability、perf-early）身份检查实测过，不追溯、不翻案 | 当轮实测 ci-verify 输出 + git log 逐任务核对 |
| 生成物（.claude/.zcode/prompts） | 否——未动 hooks.manifest.json 与 agents/*.agent.md，无需 build:*；check:agents/check:hooks 实测通过 | gate 链前段通过 |
| 存量 done 任务 | 豁免零影响：deferred 且无 retro 文件的存量任务仅 ai-review-notify（11-06）、drill-gaps-fix（11-08），均早于 retroCheckFromDate=2026-11-11 不查；≥11-11 的 8 个 deferred 任务全部有 retro 文件或声明（当轮逐任务扫描） | python 扫描 .ai/tasks/*/state.json × retro/ 目录 |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 命令行注入 | 无面：`execFileSync('git', [argv])` 无 shell；路径参数以字面量 `'.ai/tasks/'` 前缀锚定，不可能被解析为选项；`meta.task` 含空格/元字符仅得不存在路径 → git 报错 → catch 跳过（fail-open，与仓内"判不了不判"口径一致，已声明） |
| 越权 | 新增面=state 作者可把 `meta.task` 指向其他任务目录（`../<slug>`）使校验对象错位——但 state 本身就是被审对象，自我作弊成本等价于直接改 created_at，不新增等级 |
| 敏感信息进日志 | 失败 reason 含作者邮箱（身份基线，非凭据），无泄露面 |
| 依赖变更 | 无 |

## 6 测试覆盖

| 新增行为 | 是否有对应测试 | 备注 |
|---|---|---|
| retro 豁免放行（deferred+waived_by） | **无** | 当前仓内零任务踩达此分支；gate 全绿对它无验证力 |
| 豁免不认非字符串/无 deferred 的 waived_by | **无** | 负向完全无验证（🔴2） |
| 身份校验：非 yyuan 拦 / 日期门控 / 无提交放行 | **无** | 仅 p0-stability、perf-early 两任务踩到 happy path（当轮实测过） |
| 既有行为回归 | 部分 | `npm run -s test:retro` 当轮实测 11 通过 0 失败——改动未破坏既有 retro 判定；test/ 其余套件因 gate 在 ci-verify 短路未跑，修复 🔴1 后需整链复跑 |

## 7 结论

- 🔴 数量：2（证据覆盖致 gate 实测红；H1 无同批测试）
- 🟡 已全部表态：是（4 条：1 修 / 1 修注释 / 1 延后 / 1 修追认）
- 建议：**request changes**。判定逻辑本身方向正确、对存量无翻案、注入面闭合，但 ① 当前工作区状态下 `npm run gate` 实测红（poll-config 证据被本任务取证动作覆盖），带此状态提交 CI 必挂；② 门禁改动无入库测试违反 H1，且 audit 中"单测三形态""gate 全绿"两条主张与工作区事实不符。两条 🔴 修复（改唯一 todo id + 还原/重取证 + 补测试）成本都很低，修复后可复审放行。approve 权在人。
