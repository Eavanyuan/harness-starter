# CR 代码审查记录 — ci-fail-trigger：CI 失败触发与归因工单（change，关联 task-loop）

> 产出：`code-reviewer`（独立会话正式 CR） · 2026-11-17
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。

- 审查范围：基线 `fd7cccb` → 未提交工作树。6 个修改文件（gitlab-triggers / session-pack / task-loop / task-loop.test.sh / RS-task-loop / FS）+ 2 个未跟踪新文件（`scripts/lib/ci-failures.mjs`、`docs/01-requirements/RS-ci-fail-trigger.md`）+ `.ai/tasks/ci-fail-trigger/` 建档（change/related/baseline 齐，stage=impl）。
- 关联 FS：`docs/02-features/task-loop/FS-任务循环执行器.md` §4.4/§6/§9/§10（本批实改）
- 关联 RS：`docs/01-requirements/RS-ci-fail-trigger.md`（新）、`RS-task-loop.md` US-1 增行
- **已加载的 skill**：`resolve-skills --diff` 命中 harness v1.1.0（5 文件：ci-failures / gitlab-triggers / session-pack / task-loop / task-loop.test.sh），Stage 0 已过（checklist.md 37 条、改动脚本全文与接线点、现有测试覆盖面）。

## 0 硬规则逐条核（harness skill 硬规则表 H1–H9）

| # | 规则 | 检测方式（本轮实跑/实查） | 结果 |
|---|---|---|---|
| H1 | 改 hooks/scripts 必须同批新增测试 | `git diff --name-only HEAD`：scripts/ 4 文件非空；test/ 命中 1 文件 +151 行（5k/5k-bis/5k-quin 三场景，含正向放行：基线绿全链转绿关账） | ✅ |
| H2 | 生成物禁止手改 | `npm run check:agents`（68 文件一致）、`check:hooks`（接线一致）实跑通过；本批未触 `.claude/`/`.zcode/`/`prompts/` | ✅ |
| H3 | 解析失败 fail-closed | 本批未改 `hooks/*.mjs`；新增 lib 解析路径无 `return 0` 伪装放行（空 trace → 空清单的下游问题见 🔴#1，非放行伪装） | ✅ 未命中 |
| H4 | 黑白名单只写 config | 无新增拦截清单字面量；`src\|app\|pkg\|cmd\|internal` 是识别标记不是受保护区 | ✅ 未命中 |
| H5 | skill Stage 0 ≤5 / ≤200 行 / ≤2 层 | `npm run check:skills` 实跑 4 skill 通过；本批未改 `.skills/` | ✅ |
| H6 | 新拦截规则须给合法绕过 | 无新增拦截规则；停机路径沿 OFF 哨兵 / `install --uninstall`（FS §10 已写） | ✅ 未命中 |
| H7 | 新 hook 双 CLI 接线 | 无新增 hook；check:hooks 通过 | ✅ 未命中 |
| H8 | 配置新键必须有消费者 | 未新增配置键（maxJobs/excerptPerJob 为函数默认参数，未入 harness.rules.json） | ✅ 未命中 |
| H9 | 断言可证伪 + 变异结果 | 5k 系列断言精确串与计数（`fingerprint==='ci:7001'`、`pending.length===2`、事件序列、退出码）；变异方式与红位已写进 FS §9 与 state.json。附注：变异红运行未留 `.ai/verify` 日志（CF1/CF2 均为绿套件）→ 见 仅记录#4 | ✅（附注） |

## 1 改动摘要

给 task-loop 补第三触发形态：无打回证据的 open MR 逐单拉详情判 `head_pipeline.failed` → CAS 认领 → 拉 failed jobs trace → `ci-failures.mjs` 多栈识别失败行（指纹剥行号/绝对前缀/runner 时间戳）→ 以目标分支最新流水为基线 `setDiff` 归因 → 引入项落 ack 与 CI 会话工单（`buildR1ProfileCI`），全为基线同款 → `inherited_only` 不修；新流水 → `ack_stale` 重认领；转绿 → sweep 关账。测试 104→107，文档四点同步。

## 2 阻断项 🔴

| # | 位置 | 问题 | 依据 | 建议 |
|---|---|---|---|---|
| 1 | `scripts/lib/ci-failures.mjs:107`（trace 拉取 catch 静默留空）、`:78-92`（extractCiFailures）；`scripts/task-loop.mjs:534-539、579-584` | **"提取为空"被当成"全部继承"：trace 拉不到或日志形态不被识别 → `inherited_only` 错误终态。** `ciFetch.failures` 为空有两种成因：(a) trace 软失败（:107 catch 后 `trace=''`，注释自称"如实留空"但没有任何下游可见标记；GitLab trace 过期是常态）；(b) 日志真没有可识别失败行（Gradle 形态、无 `[ERROR]` 前缀的编译错、未支持栈）。两种都得到 introduced=inherited=0 → ack 空 → noop → `state:'inherited_only'`，控制台输出"失败全为基线同款（0 条）——本 MR 无引入项不修"，pack 不落。 | RS 验收标准对基线侧要求"取不到 → 明说 baselineKnown:false（保守，不静默）"，trace 侧没有对等的"明说"；本轮探针实证：Gradle 标准失败输出 `extractCiFailures`=0；空 mine+红基线 → 0 引入/0 继承。影响：真红的 MR 被判"不修"，CI 红静默过夜（恰是 RS §1 要消灭的痛点）；且认领后每轮 claim_skip、归因不重跑，该流水线指纹 `ci:<id>` 不变即一直挂到出新流水或关账。`maxJobs=5` 截断（:102）放大此面：前 5 个 failed job 提不出失败行而第 6 个有时同样落入空清单。测试无"trace 拉不到"与"未识别栈"负向用例。 | 在 byJob 层记录 `traceOk`/提取计数，task-loop 侧把"failedJobs>0 而 failures 空"按**无法归因**处理：不进 inherited_only——落独立事件（如 `ci_opaque`）并至少落带 job 链接的工单（或释放认领下轮重试），口径与"基线取不到明说"对齐。 |
| 2 | `scripts/lib/gitlab-triggers.mjs:204`（`detail = await optional(base)`）；`scripts/task-loop.mjs:361、371-381`（gitlabViewComplete → sweep 关账） | **CI 触发的"在场"判据挂在会被吞错的调用上：详情拉取瞬断 → sweep 误关账。** 详情接口 5xx/瞬断 → `optional` 返回 null → 该 MR 的 CI 触发本轮缺席，而 `fetchTriggers` 整体成功 → `gitlabViewComplete=true` → sweep 判"触发消失"：删 ack/pack、释放认领、budget/TTL 清零。同文件 discussions（:197）用的是抛错的 `api()`，失败走 `source_soft_fail` 保账——"本轮看不见 ≠ 消失"的纪律在 CI 分支被绕开。 | task-loop.mjs:358-371 注释自己点名此危害（"断连→恢复循环可反复绕过 maxRounds 升级"）；既有 `optional` 调用（commit/approvals）都不影响触发的在场，detail 是第一个。影响：内网 GitLab 瞬断一次即误关账——认领被他机抢走、正被读的 pack 被删、900s 节拍下反复关账-重认领-重归因抖动。测试无"详情失败 → ack 原样保留"负向用例。 | detail 改 `api()`（与 discussions 同口径，失败整源 soft-fail、不动账）；或 optional 失败时让 `fetchTriggers` 返回"本轮视角不完整"标记，task-loop 侧视同 softFail。注意 MR 刚被关导致的 404 应按"MR 消失"单独分类，别升级成整轮 die。 |

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | `scripts/lib/ci-failures.mjs:49-50`、`:27-31`、`:42`（JEST） | **识别器稳定性三处，同根因（指纹漏收/不稳 → 跨流水归因失真）**：(a) `stripRunnerPrefix` 在 `normalizeLine` **之前**跑——时间戳被 ANSI 包裹时前缀剥不掉、JAVAC 锚定 `^\[ERROR\]` 也不命中，整行漏收（探针实证：`\u001b[90m2026-…Z\u001b[0m 01O [ERROR]…` → null）；(b) `normalizeCodePath` 只认正斜杠——Windows 反斜杠绝对路径退化为整串，同文件跨 job 不同指纹、去重与基线比对双失效（探针实证 `C:\…` vs `D:\…` 不同指纹）；(c) JEST 分支把 `(12 ms)` 耗时尾缀收进指纹（探针实证 12ms/15ms 两个身份），继承必被计成引入。 | 先 normalizeLine 再剥前缀；路径分割加 `\\`；jest 剥尾部 `\(\d+ ?ms\)`。三处各补一条 5k-quin 断言（现 quin 无 ANSI/反斜杠/jest 耗时用例）。 | 修 |
| 2 | `scripts/task-loop.mjs:514-521` | **基线状态口径：非 failed 一律当"绿"。** `latest.status` 为 running/pending/canceled/skipped 时 `failures:[]` → 全引入。结果清单虽与 unknown 路径相同（都全引入、都偏保守），但 `baselineKnown=true`、`baselineStatus='running'`，与 RS"取不到 → 明说 baselineKnown:false"的口径不一致（running 还没出结果 = 取不到）；canceled 基线时把继承红列入引入清单，工单会话按单去修——正是 RS 承诺不做的"污染 MR"。 | 只认 success/failed 为已知基线，其余走 unknown 分支（baselineKnown:false）；或取 ref 上最近一条**已完结**流水。 | 修 |
| 3 | `scripts/lib/ci-failures.mjs:102`（slice maxJobs）、`:96`（jobs per_page=100 无翻页） | **截断无标记**：failed jobs 超 5、或流水线 jobs 超 100 时静默丢，`failedJobs`/`failures` 不体现"还有 N 个没看"。对照剖面 B 的 LIMIT 截断有告警 + `profile_b_truncated` 落账。 | 返回截断计数（failed 总数/取到数），pack 与事件带出来；至少在注释/RS 声明视角边界（同 MR 列表 per_page=100 的 KI-3 写法）。 | 修 |
| 4 | `scripts/lib/session-pack.mjs:108` | **CI 工单 prompt 里 `<N>` 字面量**：`PROTOCOL_COMMON` 内含 `round-<N>.md`，CI 工单直接原样嵌入（会印出"round-<N>.md"）；B 剖面（:76）用了 `.replace('<N>','1')`。 | 一行修复：`PROTOCOL_COMMON.replace('<N>','1')`；A 剖面（:38）同病是存量，可顺手。 | 修 |

### 仅记录（不阻断）

1. RS-ci-fail-trigger.md 头部写"行为细节以 FS §4.4/**§4.7**（本次同批更新）为准"，实际本批未动 §4.7（diff 只及 §4.4/§6/§9/§10）；改引 §4.4 或真补 §4.7 的 buildR1ProfileCI 行。
2. excerpt 过滤器（ci-failures.mjs:109）缺 `✕`（U+2715，与 ✗ U+2717 不同字符）：jest 失败行进得了清单进不了摘录；小改可随 🟡#1。
3. 基线拉取失败按 unknown 处理（task-loop.mjs:523-525）连 401/403 硬错也吞：PAT 权限不足时会长期降级"全引入"且每轮只落一行 stderr——FS §10 已声明需 pipelines 读权限，可考虑 doctor 加探测。
4. FS §9 变异主张（关 CI 分支→2 红、归因恒无基线→3 红、路径不归一→1 红）与用例结构吻合（5k/5k-bis/5k-quin 对应得上），但未留红日志；按验证纪律第 1 条属"已声明未留档"，建议变异也过 `verify-run.sh` 留档。
5. MR 标题/日志摘录原文嵌进修复会话 prompt：prompt injection 面与既有剖面 A（评论原文入 prompt）同级，非本批新增风险等级，沿既有接受面。

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| `scripts/task-loop.mjs`（ci-failures 唯一消费方） | 受影响（新增，即审查对象） | :509-517 动态 import；dry-run/shadow 分支已适配 ci 信号（:414） |
| sweep（task-loop.mjs:382 `triggerFingerprint(cur)`） | 兼容 | ci 分支产出 `ci:<id>`（gitlab-triggers:238），与打回路径的 `d..n..,c..`/`empty` 不同生成域，不会互相误判 stale（核过 :236-247） |
| session-pack 消费方 | 不变 | buildR1ProfileCI 为新增导出；readSessionArtifacts/A/B 剖面未动 |
| 既有 104 用例 | 无回归 | 本轮实跑 107/107 绿；test diff 纯新增（+151 行） |
| hooks/.claude/.zcode/prompts | 零改动 | check:agents / check:hooks 通过 |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入（SQL/命令/模板） | 无：识别全在正则/字符串层，无 eval/shell 拼接；trace 文本仅落本地 pack 展示（每行截 200 字符） |
| 越权 | 无新增：private-token 头只读端点（jobs/trace/pipelines?ref），无写操作 |
| 敏感信息进日志 | 干净：ci_attributed/ack/pack 不含 token；摘录含内网路径与 .ai/task-loop 同域（本地） |
| 依赖变更 | 无 |

## 6 测试覆盖

| 新增行为 | 是否有对应测试 | 备注 |
|---|---|---|
| CI 红触发端到端（认领→归因→工单；新流水 ack_stale 重认领；转绿关账删 ack/pack） | ✅ 5k | 断言含 ack 字段、事件序列、退出码 |
| 基线同款 → inherited_only + claim_noop(why) + 无工单 | ✅ 5k-bis | |
| 识别器六栈/噪声跳过/路径归一/去重/未知基线保守 | ✅ 5k-quin | ANSI/反斜杠/jest 耗时缺用例（🟡#1） |
| trace 拉不到（软失败）→ 不误判 inherited_only | ❌ 缺 | 🔴#1 |
| 未识别栈（Gradle 等）空提取 → 不误判"不修" | ❌ 缺 | 🔴#1 |
| 详情 optional 失败 → ack 原样保留（不误关账） | ❌ 缺 | 🔴#2 |
| 基线 running/canceled 口径 | ❌ 缺 | 🟡#2 |

## 7 结论

- 🔴 数量：**2**
- 🟡 已全部表态：是（4 建议均已给处置倾向；5 仅记录）
- 建议：**request changes**

两条 🔴 都在本次新增的 CI 触发链路上、真实场景可触发（trace 过期/未支持栈很常见；内网 GitLab 瞬断不罕见），且都违背本变更自己写下的口径——"取不到要明说，不静默"与"本轮看不见 ≠ 消失"。修复面小（全部落在新增代码内，不动存量打回/飞书路径），与 FS §10 的兼容性声明不冲突。修完 🔴 补对应负向用例后可二审。

---

### 审阅者验证记录（本轮实跑，2026-11-17）

- `bash test/task-loop.test.sh`：**107 通过 / 0 失败**（exit 0）——与作者 CF1/CF2 日志一致；审阅者直跑未过 `verify-run.sh` 包装，任务证据链以作者 CF1/CF2 为准。
- `node --check` ×4（ci-failures / gitlab-triggers / session-pack / task-loop）：全过。
- `npm run check:agents` / `check:hooks` / `check:skills`：全过。
- 识别器边界探针（只读 node -e，未改源码）：Gradle 标准失败输出 → 0 识别；Windows 反斜杠同文件 → 不同指纹；jest `(12 ms)` 尾缀 → 指纹不稳；ANSI 包裹时间戳 → 整行漏收；空 mine + 红基线 → 0 引入/0 继承（即 🔴#1 的落点）。
- 未覆盖：真实 GitLab 实例行为（列表接口缺 `head_pipeline`、trace 过期频率、ANSI 是否出现）本轮无法远端核实，按作者实测主张 + 测试夹具采信；变异三主张未独立复跑（需改源码，超出只读审阅权限），已按用例结构核对一致性。

---

## 二审（2026-11-17，独立会话 · code-reviewer）

> 范围：一审 6 处置逐项验收 + 两条 🔴 回归钉核验 + 新问题横查。规则同一审：🔴 = 0 方可 approve。
> Stage 0：`resolve-skills --diff` 命中 harness v1.1.0（同 5 文件），SKILL.md / checklist / test-quality 已读。

### 二审结论

**request changes（必须修 1 / 值得考虑 2 / 仅记录 5）。** 一审两条 🔴 修复到位、两条回归钉都真钉住、套件 109 全绿；但按同一口径横查发现一审 🔴#1 的根因在「视角不完整但非全空」的窄条件下仍会复现（新 🔴#1′）。修复面小，仍全部落在本批新增代码内。

### 逐项验收（一审 6 处置）

| 一审项 | 判定 | 一句话依据 |
|---|---|---|
| 🔴#1 空提取误判全继承 | ✅ 验收 | ci-failures.mjs:113-134 透明度字段齐（traceOk/byJob/failedJobTotal/jobsPageTruncated/traceFailures）；task-loop.mjs:533-548 opaque 分支落 `ci_opaque` 事件 + job 级 ack + 工单警示行（session-pack.mjs:95）；5k-ter（test:893-934）断 state=working / pending kind=job / ci.opaque / ci_opaque 事件 / 无 claim_noop——「删 opaque 分支」变异下四组断言全落空，必红。同根因窄条件残留一条，见下 🔴#1′ |
| 🔴#2 detail 挂在 optional 吞错上 | ✅ 验收 | gitlab-triggers.mjs:209-212 detail 改 `api()`、非 404 rethrow；task-loop.mjs:243-254 temporary 正则收编 HTTP 5xx → `source_soft_fail` → :361 `gitlabViewComplete=false` → sweep 不动账；5k-quad 断第二轮 exit 1 + ack/pack 原样 + 无 trigger_gone + 围栏「源故障 gitlab」——「退回 optional」变异必红（sweep 会判触发消失删账） |
| 🟡#1 识别器三处不稳 | ✅ 验收 | ci-failures.mjs:58 先 normalizeLine 再剥前缀、:33-35 反斜杠归一、:84-86 jest 剥 `(N ms)`；quin 补 ansi-timestamp / backslash / jest-duration 三断言（test:1003-1005）；excerpt 过滤器 ✕(U+2715) 顺手带进（一审仅记录#2） |
| 🟡#2 基线非 failed 一律当绿 | ✅ 验收 | task-loop.mjs:519-527 只认 success/failed，running/canceled/skipped/取不到 → baseline 保持 null → attributeCi 判 `baselineKnown:false`（ci-failures.mjs:142-144）。task-loop 侧无 running/canceled 基线 e2e 用例（仅记录#1） |
| 🟡#3 截断无标记 | ⚠️ 部分验收 | failedJobTotal/jobsPageTruncated/traceFailures 落 ack.ci（task-loop.mjs:542）+ 控制台提示行（:540）；但 FS §4.4（行 67）明写「**并在工单可见**」，buildR1ProfileCI（session-pack.mjs:88、102）没接这组数——见 🟡#1′ |
| 🟡#4 CI 工单 round-`<N>` 字面量 | ✅ 验收 | CI 工单（session-pack.mjs:108）与 A 剖面（:38）均 `.replace('<N>','1')`，B 剖面原有（:76） |
| 仅记录#1 FS §4.7 未动 | ✅ 已补 | FS:119 加 buildR1ProfileCI 行，RS 头部引用与实际一致 |

**二审实跑（审阅者）**：`bash test/task-loop.test.sh` → **109 通过 / 0 失败**（10.6s；直跑未过 verify-run.sh 包装，口径同一审——任务证据链以 CF1/CF2 为准，作者 15:26 复跑同为 109）；`node --check` ×4 全过。

### 新发现

#### 必须修（1）

**🔴#1′ 视角不完整 + 可见部分全为基线同款 → 仍落 inherited_only「不修」终态**（一审 🔴#1 同根因，窄条件残留）

- 位置：`scripts/task-loop.mjs:533`（opaque 只在「提取完全为空」触发）、`:552-555`（ack 空 → `state:'inherited_only'`）、`:595-597`（`claim_noop(why)`）；成因面在 `scripts/lib/ci-failures.mjs:102`（maxJobs=5 默认、无配置入口）、`:117`（trace 按单 job 失败）、`:132`（failedJobTotal 截断）。
- 问题：`opaque = failures.length===0 && failedJobs>0` 只覆盖「完全拉不到 / 全不识别」。当**部分** job 的 trace 拉取失败（traceFailures>0）、或 failed jobs 超过 maxJobs=5（failedJobTotal>failedJobs.length）、或 jobs 翻页截断，而**可见部分的失败恰好全为基线同款**时：failures 非空 → opaque=false → introduced=0 → ack 空 → `state:'inherited_only'` 判「不修」、工单不落。`:540` 的「归因视角不完整……以 job 链接为准」只进控制台——无事件（ci_attributed 不带截断计数，:544）、无工单（noop 不落包）；同流水指纹 `ci:<id>` 下后续轮 claim_skip，直到出新流水。
- 影响：拉不到/没看的那部分 job 里若真有引入失败，CI 红 MR 照旧静默过夜——恰是 RS §1 要消灭、一审 🔴#1 要堵的痛点；且违背本变更自己写下的口径（RS「取不到=明说保守」、FS §4.4「视角截断……并在工单可见」）。
- 依据：一审 🔴#1 依据已点名「maxJobs=5 截断放大此面」；本轮代码核对成立；5k-bis（完整视角全继承）与 5k-ter（完全拉不到）恰好都不落此区间，109 全绿即证无一用例钉住。
- 修复方向：把 opaque 判据从「提取为空」推广为「引入判定所依赖的视角不完整」——`introduced.length===0 && failedJobs>0 && (traceFailures>0 || failedJobTotal>failedJobs.length || jobsPageTruncated)` 也按无法归因处理（复用现有 opaque 机制：job 级工单/事件），或至少不落 inherited_only 终态；补一条混合视角用例（如 2 个 failed job：其一 trace 500、另一个 trace 只含基线同款失败 → 不得判「不修」）。

#### 值得考虑（2）

**🟡#1′ CI 工单不含截断/trace 失败计数，与 FS §4.4 自述不符**
- 位置：`scripts/lib/session-pack.mjs:88、102`（buildR1ProfileCI 未接 failedJobTotal/traceFailures）；`scripts/task-loop.mjs:567`（调用处只传 seen 的 failedJobs）；`docs/02-features/task-loop/FS-任务循环执行器.md:67`。
- 问题：非 opaque 场景（有引入项、落工单）时，工单「失败的 job」只列前 5 个、无「共 N 个」、无 trace 拉取失败提示——接工单的人正是要开 job 链接的人，却看不到视角边界。
- 建议：把这组数传进 buildR1ProfileCI，在 job 清单处印「失败 job 共 N（此处列前 M）」与「trace 拉取失败 K 个」。

**🟡#2′ 404 跳过分支零观测、零测试钉**
- 位置：`scripts/lib/gitlab-triggers.mjs:211`（continue，无日志无事件）；test/ 无 404 详情用例。
- 问题：正常成因（单刚被关/合并的列表→详情竞态）**不构成新盲区**——下一轮列表自然没有它，已认领的由 sweep 正常关账，行为正确；但持续性 404（非「刚关」成因）会让该 MR 每轮被静默跳过且无任何痕迹。另：此分支无防回归——「删 404 continue 改一律 rethrow」的变异套件仍绿，而真实行为会退化为 MR 刚关即整轮 die(1)（HTTP 404 不在 task-loop.mjs:250 的 temporary 正则里）。
- 建议：404 跳过打一行 console/事件；补一条 404 详情用例（断言：跳过该单、不 die、其余源继续）。

#### 仅记录（5）

1. 一审 🟡#2 的 task-loop 侧口径（running/canceled 基线 → unknown）无 e2e 用例，仅 quin 的 attributeCi(null) 单元覆盖；「退回非 failed 一律当绿」变异套件仍绿。
2. 5k-ter 只钉「trace 拉不到」变体；「trace 在但零识别」（Gradle 形态）同走 opaque 分支但无独立用例——「opaque 附加 traceFailures>0 条件」变异套件仍绿。
3. 新增 2 处变异（opaque 退化 / detail 退回 optional）未留 RED 日志（.ai/verify 只有 CF1-CF3 绿跑）——一审仅记录#4 的建议对修复轮仍适用；本轮按断言结构做了分析性核验（只读权限未复跑变异）。
4. state.json todos 仍记「104→107 + 旧变异口径」，109 与新变异未回写，关账前需同步。
5. 工单 jobs 行 `${j.stage}/${j.name} ${j.webUrl}`：webUrl 空时尾随空格，纯排版。

### 二审范围与未覆盖

- 核对：4 个脚本 diff 全读并读上下游（sweep/软失败接线/认领-跳过路径）、5k 系列 5 用例断言逐条、套件直跑 109/0、`node --check` ×4、文档四处（RS US-1、FS §4.4/§4.7/§6/§9/§10）与实现对照、作者 CF1-CF3 日志交叉核对。
- 未核：check:agents / check:hooks / check:skills 未复跑（本轮 diff 未触生成物与 .skills/，一审已过）；变异未独立复跑（需改源码，超出只读权限）；真实 GitLab 行为（trace 过期是否逐 job 发生、详情 404 形态、>100 job 流水线）仍按作者实测主张与测试夹具采信。

---

## 三审（2026-11-17，独立会话 · 审阅者 · 终审）

> 范围：二审三处置（🔴#1′ / 🟡#1′ / 🟡#2′）逐项验收 + 回归钉 5k-ter2/5k-ter3 钉住核验 + 四项边界 + 套件真跑。规则同一/二审：🔴 = 0 方可 approve；approve 权在人。
> Stage 0：`resolve-skills --diff` 命中 harness v1.1.0（同 5 文件），SKILL.md / checklist（39 条）/ test-quality 已读。

### 三审结论

**approve（必须修 0 / 值得考虑 1 / 仅记录 4）。** 二审三处置全部落地且与约定公式逐字一致；两条新回归钉真钉住（变异方向分析性核验）；套件 111/0 与作者 CF1/CF2 留档一致；RS/FS 文档与 state.json todos 均已同步到修复轮口径。终审未发现新的必须修。

### 逐项验收（二审三处置）

| 二审项 | 判定 | 依据 |
|---|---|---|
| 🔴#1′ opaque 扩为「视角不完整」 | ✅ 验收 | `scripts/task-loop.mjs:543-545` viewIncomplete 三条件（traceFailures>0 / failedJobTotal>failedJobs.length / jobsPageTruncated）、`:546-547` `opaque = failedJobs>0 && (failures 空 || (introduced 0 && viewIncomplete))`——与二审约定公式逐字一致；opaque 分支仍落 `ci_opaque` 事件 + job 级 introduced + 工单（:548-551） |
| 🟡#1′ 工单带 viewNote | ✅ 验收 | `scripts/lib/session-pack.mjs:104` 警示行（失败 job X/Y、jobs 翻页截断、trace 拉取失败 K 个——「清单不是全集，以 job 链接为准」）；`scripts/task-loop.mjs:581-587` 四参数传齐；与 opaque 行（session-pack.mjs:95）互不串档——opaque 工单两行都有、非 opaque 工单只有 viewNote 行 |
| 🟡#2′ skipped404 + mr_detail_404 | ✅ 验收 | `scripts/lib/gitlab-triggers.mjs:191` 计数初始化、`:212` 仅 HTTP 404 计数后 continue（其余 rethrow，保持一审 🔴#2 的在场判据口径）；runner `scripts/task-loop.mjs:247-250` 每轮一条聚合事件 + 一行控制台 |

### 回归钉核验（③）

- **5k-ter2（test/task-loop.test.sh:987-1035）真钉住**：夹具正是 🔴#1′ 半盲条件——job-a trace 可见且全为基线同款、job-b trace 500；断言 `state==='working'` + `ci.opaque===true` + 有 `ci_opaque` 无 `claim_noop` + pack 含「视角不完整」与「job-b」。变异 M4（opaque 退化回「只认提取完全为空」）：failures 非空 → opaque=false → introduced=0 → `inherited_only` + `claim_noop`，≥3 组断言同时落空，必红。
- **5k-ter3（test:1037-1086）两相位真钉住**：相位 1 Gradle 形态零识别（failures 空 + failedJobs=1）走 opaque 第一支，断言 `pending[0].kind==='job'` + pack「自动归因失败」+ `ci_opaque` 事件；相位 2 详情 404，断言 exit 0 + 输出含 404 + `mr_detail_404` 事件。变异 M5（404 无痕）：事件与输出双断言落空必红；「404 改一律 rethrow」变体则 HTTP 404 不在 temporary 正则（task-loop.mjs:253-256）→ die(1)，r2 退出码断言必红。
- 计数 109→111 与两新 check 一致；作者 CF1/CF2（verify-run.sh 包装、exit 0、各 111 通过）与本轮直跑一致。

### 边界核验（④）

1. **failures 非空且 introduced>0 → working + 工单警示行、不 opaque**：:546-547 两支均不命中 → ack 非空 → `state:'working'`（:566-569）；pack 只渲染 viewNote 警示行（session-pack.mjs:104），opaque 行（:95）不出现。✅（代码层核过；e2e 钉缺 → 仅记录#2）
2. **opaque pending 为 job 级 → sweep 指纹仍 ci:&lt;id&gt;**：ack 顶层 fingerprint 取 `triggerFingerprint(t)`（:567），ci 分支恒 `ci:<pipelineId>`（gitlab-triggers.mjs:250-251），pending 的 `job:<name>` 不进指纹——同流水 claim_skip 不重跑归因、新流水 `ack_stale` 重认领重归因，与 RS 术语表一致。✅
3. **404 观测每轮至多一条**：lib 内 continue 无逐单输出，runner 侧 `if (fetched.skipped404)` 按轮聚合计数单行单事件（:247-250），多单 404 不刷屏。✅

### 三审实跑（审阅者）

- `bash test/task-loop.test.sh` → **111 通过 / 0 失败**（exit 0），与 CF1/CF2 留档一致（口径同一/二审：任务证据链以作者 verify-run.sh 包装日志为准）。
- `node --check` ×4 全过；`npm run check:agents`（68 文件一致）/ `check:hooks`（接线一致）/ `check:skills`（4 skill）实跑全过——本轮 diff 未触生成物与 .skills/，属顺手复核。
- 公开事实核对（本轮 web 查证）：GitLab pipeline jobs 端点按 **id 降序（最新在前）** 返回（docs.gitlab.com/ee/api/jobs.html："Jobs are returned by ID in descending order"）——用于仅记录#1 的可达性评估。

### 新发现

#### 必须修（0）

无。

#### 值得考虑（1）

**🟡#1″ FS §9 测试矩阵行未随修复轮更新**
- 位置：`docs/02-features/task-loop/FS-任务循环执行器.md:263`（「CI 红全链」行）；对照 `.ai/tasks/ci-fail-trigger/state.json` CF2 audit.tests。
- 问题：该行仍是修复轮前口径——无 ter/ter2/ter3/quad 场景描述，变异仍记三处；而 state.json 已记「task-loop 104→111 … 变异五处全红」。同一任务两份判据记录不一致，读 §9 会低估钉子覆盖。
- 建议：§9 CI 行补一句修复轮场景（无法归因三态 → opaque job 级工单 + ci_opaque；详情瞬断软失败保账；404 → mr_detail_404 观测）并把变异口径对齐为五处。

#### 仅记录（4）

1. **`failedJobs=0 && jobsPageTruncated` 窄角**（task-loop.mjs:546）：失败 job 全落在返回页之外时 opaque 门（`failedJobs>0`）不命中 → failures 空 → introduced=0 → `inherited_only`「不修」，与 RS 验收行「视角不完整且可见部分零引入 → 不判不修」的字面口径有偏差。可达性极低——jobs 端点 id 降序（最新在前），需 ≥100 个比失败 job 更新的 job（大规模 retry/手动补跑）才触达；该轮控制台仍有「归因视角不完整」行（:553 条件含 jobsPageTruncated）。修法一行：failures 空时 opaque 第一支补 `|| ciFetch.jobsPageTruncated`。
2. 「introduced>0 + 视角不完整 → working + 工单警示行（非 opaque 行）」组合无 e2e 钉：5k 系列要么全视角（5k）、要么 opaque 档（ter2）；该组合本轮仅代码层核过（task-loop.mjs:546-547 / session-pack.mjs:104）。
3. 变异 M4/M5 仍未留 RED 日志（`.ai/verify/` 只有 CF1–CF3 绿跑）——一审仅记录#4 / 二审仅记录#3 对本批仍适用；本轮以断言结构做分析性核验（只读权限未复跑变异）。
4. 二审仅记录#5（工单 jobs 行 webUrl 空时尾随空格，session-pack.mjs:91）仍在，纯排版。

### 三审范围与未覆盖

- 核对：三处置代码落点与上下游（opaque 后续流 / ack-pending 结构 / sweep 指纹 / 工单渲染路径）、5k 系列六场景夹具与断言逐条、RS 两条新增验收行与 FS §4.4（:67）/ 事件表（:192）、RS-task-loop US-1（:26）、state.json todos（111 与五处变异已回写——二审仅记录#4 已清）、CF1–CF3 日志头与尾部计数、套件直跑 111/0、`node --check` ×4、check:agents / check:hooks / check:skills。
- 未核：变异未独立复跑（需改源码，超出只读审阅权限）；真实 GitLab 行为（trace 过期是否逐 job 发生、详情 404 形态、>100 job 流水线、jobs 端点排序在私有化老版本上的表现）仍按作者实测主张与测试夹具采信。
