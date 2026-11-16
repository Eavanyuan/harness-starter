# CR 代码审查记录 — task-loop-close（多源容错 + 关账半环 + 节拍收紧，未提交本地变更）

- 审查范围：本地未提交 diff（基线 `126667b`）。改 7 文件：`scripts/task-loop.mjs`、`scripts/lib/gitlab-triggers.mjs`、`scripts/install-task-loop.sh`、`harness.rules.json`、`test/task-loop.test.sh`、`docs/01-requirements/RS-task-loop.md`、`docs/02-features/task-loop/FS-任务循环执行器.md`；新增：`docs/01-requirements/RS-task-loop-close.md`、`.ai/tasks/task-loop-close/state.json`
- 关联 FS：`docs/02-features/task-loop/FS-任务循环执行器.md` §4.4/§4.7/§6/§8/§9/§10
- 关联 SR 报告：无（S 档 change 任务 `task-loop-close`，state 见 `.ai/tasks/task-loop-close/state.json`，rs/cr 合规）
- **已加载的 skill**：`harness v1.1.0`（`node scripts/resolve-skills.mjs --diff` 命中 4 个改动文件：install-task-loop.sh / gitlab-triggers.mjs / task-loop.mjs / task-loop.test.sh）。Stage 0 三项完成：`references/checklist.md` 39 条失效点通读、改动脚本全文 + 调用方（package.json / deploy 模板 / ledger 读取端）、`test/task-loop.test.sh` 通读

## 0 硬规则逐条核（harness H1–H9）

| # | 规则 | 检测命令 | 结果 |
|---|---|---|---|
| H1 | 改 `scripts/**` 必须同批新增测试场景 | `git diff --name-only` 含 3 个 scripts 文件；`test/task-loop.test.sh` 同批 +220 行（新增 5f/5f-bis/5g/5h/5i/5j，调整 10d/10f） | ✅ |
| H2 | 生成物禁止手改 | `npm run check:agents` → 0；`npm run check:hooks` → 0（本次实跑）；diff 无 `.claude/`、`.zcode/`、`prompts/` | ✅ |
| H3 | 解析失败必须 fail-closed | 代码读：空/缺 username 一律抛错（gitlab-triggers.mjs:23/55/85）；凭据文件非法行 exit 1；ack JSON 解析失败跳过且 FS §4.4 已登记该分支（非门禁路径）；硬故障 die(1) 不伪装放行 | ✅ |
| H4 | 黑白名单只写 harness.config.json | 本批未改 `hooks/**`，无新增字面量 | 未命中 |
| H5 | skill Stage 0 ≤5 项、≤200 行、≤2 层 | 本批未改 `.skills/**` | 未命中 |
| H6 | 新增拦截规则同批给合法绕过 | 本批无新增拦截规则（容错分流 + 本地 ack 生命周期，非门禁） | 未命中 |
| H7 | 新增 hook 双 CLI 接线 | 本批无新增 hook；wiring.test.sh 未动 | 未命中 |
| H8 | 配置新键必须有消费者 | 本批未新增配置键（`pollSeconds` 为既有键改值，消费者 task-loop.mjs 节流判定）；`npm run doctor` 全量未跑（见附），键-消费关系经 grep 确认 | ✅（按 grep；doctor 整体未跑） |
| H9 | 断言可证伪 + 变异结果 | 5f/5f-bis/5g/5h/5i/5j 均含正负向断言（如 5h：pack 含"建议甲"**且不含**"建议乙"；5f-bis：die 时**无**围栏行）；FS §9 声明三处新变异红位（1/3/1）——变异系作者声明，审阅未逐一复跑；另以独立复现脚本实证一处**套件测不到**的行为缺口（见 🔴#1） | ⚠️ 部分 |

## 1 改动摘要

本变更（task-loop-close，change tier 2）给 task-loop runner 补"关账半环"与运行品质：①源故障分流——临时故障（超时/断网/5xx 正则）跳过该源不 die 不落节流戳，硬故障仍整轮 die 且报错双通道同步 stdout；②轮次围栏 finish()——成轮必印一行对账摘要；③ack 生命周期 sweep——MR 触发消失关账（trigger_gone）、fingerprint 变化重认领（ack_stale）、纯动词零待修落 awaiting_rereview（claim_noop）；④认领即落会话工单 pack-<id>.md；⑤pollSeconds 7200→900 + wrapper exec 2>&1。测试同批 +6 场景，套件 100 通过。

## 2 阻断项 🔴

| # | 位置 | 问题 | 依据 | 建议 |
|---|---|---|---|---|
| 1 | `scripts/task-loop.mjs:353-381`（sweep，`const active = new Map(triggers.map(...))` :360；`if (!cur)` 分支 :367-374） | sweep 把「不在**本轮**触发集」当成「触发已消失」。三种真实路径下 MR 根本没进本轮 triggers，却被全部误关账（释放认领 + 删 ack + `trigger_gone` 落账）：① GitLab 软失败（:254 softFail 后 triggers 无 MR 项）；② `--mr <iid>` 手动过滤（fetchTriggers 只留一条）；③ `--profile b` 演练（wantGitlab=false）。**已实测复现**（审阅脚本，2026-11-16）：R1 服务正常 → exit 0、ack-61.json 落盘、认领建立；R2 服务断连（fetch failed → 软失败）→ exit 1、ack-61.json **被删**、`trigger_gone` **落账**、认领**被释放**——MR 实际未合并/批红。影响：(a) 账本出现假"关账"，恰污染本变更要建立的「修完了账面可见」信号；(b) 认领被释放后另一台 runner 可抢走；(c) 每次「断连→恢复」循环 budget rounds 与 claim TTL 全部清零，maxRounds=3 的升级保护可被网络抖动反复绕过；(d) awaiting_rereview/working 状态丢失。触发场景正是本变更的动机事故（RS §1 痛点 1：GitLab 断连 9 小时——该窗口内每 tick 误关全部 MR ack） | 实测复现输出 + 代码路径；测试缺口：5g 只测「健康轮询返回空集」的关账，未测「源失败 + 存量 ack」 | sweep 的 MR 分支仅在本轮 GitLab **真实轮询成功且未被收窄**时执行（如 `wantGitlab && !softFail.includes('gitlab') && !opt.mr`）；同批补负向用例：软失败/`--mr` 过滤时存量 ack 与认领必须原样保留 |

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | `scripts/task-loop.mjs:250`（剖面 A 正则）、`:343`（剖面 B 正则） | 临时正则漏 `HTTP 429`（限流）：GitLab API 限流时 fetchTriggers 抛 `GitLab … HTTP 429`，判为硬故障 → die(1) → 剖面 B 还没轮询就被拖死——正是本变更要消灭的「单源故障致盲」形态。另两处正则不对称：A 有 `HTTP 5\d\d`，B 没有（B 侧 HTTP 状态错全部 die） | 补 `HTTP 429`（有 Retry-After 更好）；B 侧对齐或注明 MCP 层无 HTTP 状态码 | 修 |
| 2 | `docs/02-features/task-loop/FS-任务循环执行器.md:90`（§4.4）、`docs/01-requirements/RS-task-loop.md:24` | 文档说「每轮**无论成败**必印一行围栏／每轮必印」，与实现和测试相反：die 路径不印围栏（task-loop.mjs:48 die 不经 finish；test/task-loop.test.sh:509-511 明确断言 die 时 `nofence-ok`；state TC2 audit 也写明「die 出口不印围栏（die=未成轮）」）。RS-task-loop-close.md:24 的措辞（枚举"无事可做/未接入/软失败"）才是与实现一致的口径 | 把 FS §4.4 与 RS-task-loop US-1 行的措辞对齐 RS-close：「成轮必印；硬故障 die=未成轮，不无声由 die 双通道保证」 | 修（文档两行） |
| 3 | `scripts/install-task-loop.sh`、`test/task-loop.test.sh` | 两文件丢失执行位：git 视角 755→644（diff 头可见），工作区实际 0600（`ls -l` 核实）。现有调用方均 `bash x.sh`（package.json:60、FS §10），不破功能，但属计划外变更，且伤及后续直接执行与仓库一致性 | 提交前 `chmod 755` 两个文件 | 修 |
| 4 | `scripts/task-loop.mjs:519` | pack 的 `changedFiles` 恒为 `[]`，session-pack 渲染成「本次变更涉及的文件：-（无）」——对真 MR 是假信息，接手的交互会话可能据此认为无文件要动 | 拉 MR diffs 填充；至少在工单里如实标注「未取变更文件清单，接手后自行 diff 基线」 | 修（至少文案） |
| 5 | `scripts/task-loop.mjs:521` | 剖面 B 工单把产品路由「IDMP 缺陷 → idmp 仓库」硬编码进通用 harness 脚本——harness-starter 是脚手架，其它仓库复用时会带上不相关的指路 | 挪进 `harness.rules.json` runtime.feishu（如 repoHint 字段），脚本只读配置 | 修 |
| 6 | `scripts/task-loop.mjs:377`（`a.fingerprint &&` 守卫） | 旧 ack（无 fingerprint 字段）永不走 ack_stale：升级部署后，存量 working ack（正是 RS §1 痛点 3 提到的 live ack-1882 这类动机实例）在评审新增意见时**不会重认领**，要等 MR 消失才关账——变更动机的后半句对存量实例不成立。FS §10 已把该行为写成兼容口径，不算违约，但与动机冲突 | sweep 首次读到无 fingerprint 且触发仍在的 ack 时顺手补写 fingerprint（一次性迁移，低风险） | 延后（下批；先在 FS §10 补一句后果说明） |

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| `fetchTriggers`（唯一调用方 task-loop.mjs） | 否——签名未变，本批只新增 `triggerFingerprint` 导出 | `grep -rl fetchTriggers`：gitlab-triggers.mjs（定义）、task-loop.mjs、test/task-loop.test.sh |
| `triggerFingerprint` 新导出 | 否——消费者仅 task-loop.mjs（sweep 对比 + ack 落账），e2e 经 5g/5h/5i 覆盖 | 同上 grep |
| ledger 读取端（ledger-report.mjs / notify.mjs / hooks/session_start.mjs） | 否——均为通用聚合，无事件类型枚举，新类型（trigger_gone/ack_stale/claim_noop/source_soft_fail）追加型落账 | `grep -c 'claim_held\|trigger_gone' scripts/ledger-report.mjs` = 0 |
| 已装定时器（wrapper 2>&1） | 需重装才得 stderr 合流——FS §10 已写明，runner 侧 die 双通道兜底旧安装 | install-task-loop.sh write_wrapper；test 10d 结构断言过 |
| `pollSeconds=900` 的下游 | 所有装定时器的目标仓节拍收紧 8 倍（API 量 +8 倍，注释声明成本可忽略；RS §1 痛点 4 支撑） | harness.rules.json:188；消费者 task-loop.mjs 节流判定 |
| ack 新增 `state`/`fingerprint` 字段 | 否——无其它读取端（`grep awaiting_rereview\|pack-` 仅 task-loop.mjs 命中） | grep 实测 |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入（SQL/命令/模板） | ✅ pack 经 writeFileSync 字符串拼接落盘，不经 shell；凭据文件仍按 KEY=VALUE 数据解析（不 source，10d 结构断言保持） |
| 越权（横向/纵向） | ✅ 不适用：本地 runner；凭据传递路径未变，wrapper 未引入 source |
| 敏感信息进日志 | ✅ source_soft_fail/die 只落错误消息（slice 160），无 token；gitlab_polled 仅 username。提示：工单含评审评论原文（既有 session-pack 设计，非本批扩大），交互会话读工单时评论内容属不可信输入 |
| 依赖变更 | ✅ 零新依赖（动态 import 均为仓内模块） |

## 6 测试覆盖

| 新增行为 | 是否有对应测试 | 备注 |
|---|---|---|
| 多源容错：500→软失败、401→die 双通道 | ✅ 5f + 5f-bis | 缺 429 类非 5xx 临时故障（🟡#1） |
| 软失败不落节流戳（下 tick 重试） | ✅ 5f（nostamp-ok） | |
| 围栏行与计数 | ✅ 5f/5g/5h/5i 各自断言 | die 无围栏为有意行为（5f-bis） |
| 关账：触发消失→释放+删 ack+trigger_gone | ✅ 5g（健康空集） | **缺：源软失败/`--mr` 过滤 + 存量 ack 不动账**（🔴#1） |
| fingerprint 变化→ack_stale→重认领 | ✅ 5h（含 pack 首落/重落正负向断言） | |
| 空清单终态 awaiting_rereview/claim_noop | ✅ 5i（含"无 pack"负向断言） | |
| pack 内容完整性 | ⚠️ 部分 | changedFiles 恒空的"（无）"未被断言暴露（🟡#4） |
| pollSeconds=900 入库 / wrapper 2>&1 | ✅ 5j + 10d | |
| 旧 ack 无 fingerprint 只走关账分支 | ❌ 无专门用例 | FS §10 有口径；建议补（可随 🟡#6） |

## 7 结论

- 🔴 数量：**1**（正确性：ack sweep 把"源失败/列表收窄"误判"触发消失"，实测复现，见 §2#1）
- 🟡 已全部表态：是（6 条：修 5 / 延后 1）
- 建议：**request changes**——修复 🔴#1（sweep 加"本轮该源真实轮询成功且未收窄"前置条件 + 补负向用例）后即可approve；🟡#1–#5 可同批顺手修，🟡#6 可下批

## 附：审查范围与未覆盖

**已核对**：7 改 2 新增全部通读；与 RS-task-loop-close.md 验收行、RS-task-loop.md US-1 新增两行、FS §4.4/§4.7/§6/§8/§9/§10 逐条对齐（结论：除 🟡#2 措辞外一致，含 §10 兼容口径、§9 变异声明、§8 pollSeconds 行）；state.json 流程合规（change + related + baseline 126667b，S 档 rs 在档，todos audit 四项齐填，verify 为对象且 TC1/TC3/TC5 日志在 `.ai/verify/` 存在）。

**实跑验证**：`bash test/task-loop.test.sh` → **100 通过 0 失败**；`node --check scripts/task-loop.mjs`、`node --check scripts/lib/gitlab-triggers.mjs` → 通过；`npm run check:agents` / `check:hooks` → 0；🔴#1 以独立复现脚本实证（健康认领→断连软失败→ack 被删 + trigger_gone 落账，脚本在 /tmp 已清理）。

**未覆盖及原因**：`npm run gate` / `npm run doctor` 全量未跑（时间预算；改动面已由定向检查覆盖）；FS §9 三处变异未逐一复跑（作者声明红位 + 对应用例断言存在，5f/5g/5i 分别钉死临时判定/sweep/noop 行为）；真实 GitLab/飞书端到端未跑（无凭据，属影子周准入范围）；`deploy/task-loop/` 模板未在本次 diff 内，未审。

---

# 二审（2026-11-17）：一审七条处置逐项验收 + 🔴#1 修复边界实跑

- 审查范围：一审 request changes 之后的处置批次（仍为工作区未提交变更，基线 `126667b`）。验收对象=一审 7 条处置主张；新发现按二审独立清单列。
- **已加载的 skill**：`harness v1.1.0`（`node scripts/resolve-skills.mjs --diff` 命中 5 个改动文件：install-task-loop.sh / feishu-bug-source.mjs / gitlab-triggers.mjs / task-loop.mjs / task-loop.test.sh）。Stage 0：checklist 39 条通读、task-loop.mjs 全文及其上下游（feishu-project-mcp connect 错误形态 / feishu-oauth credentialPath / session-pack 消费端）、test 5f–5j 段逐行。

## 二审 §0 硬规则复核（只核处置批次增量）

| # | 规则 | 结果 | 证据 |
|---|---|---|---|
| H1 | scripts 改动同批配测试 | ✅ | 5g-bis 新增（软失败轮不动账 + 认领不释放）、5h 改造为三轮含迁移幂等；套件 100→102 |
| H2 | 生成物未动 | ✅ | `git status` 无 `.claude/` `.zcode/` `prompts/` 条目 |
| H8 | 新配置键 repoHint 有消费者 | ✅ | harness.rules.json:185 → feishu-bug-source.mjs:96 → task-loop.mjs:530，链路闭合 |
| H9 | 新断言可证伪 | ⚠️ 部分 | 5g-bis/5h 可证伪（去掉 `!softFail` 合取项或迁移分支即红）；但 `!opt.mr`、`wantGitlab` 两合取项与 HTTP 429 正则无套件用例（见二审 🟡#2） |

## 1 一审七条处置验收

| 一审条目 | 验收结果 | 证据 |
|---|---|---|
| 🔴#1 sweep 前置守卫 | ✅ 落地，三条边界实测通过 | `scripts/task-loop.mjs:361`（`gitlabViewComplete = wantGitlab && 无 gitlab 软失败 && !opt.mr`）、`:371`（不过则 continue 不动账）；软失败边界=套件 5g-bis，`--mr` 与 `--profile b` 边界=本审 fixture 实跑（验法见 §2） |
| 🟡#1 两处正则补 429、B 侧补 5xx | ✅ 落地（无测试钉住，归入二审 🟡#2） | task-loop.mjs:250 与 :343 两正则逐字符一致，均含 `HTTP 429\|HTTP 5\d\d`；B 侧 `McpProtocolError("MCP HTTP 500")` 可命中 |
| 🟡#2 围栏措辞改「成轮必印」 | ⚠️ 部分落地——RS-task-loop.md:24 ✅、FS §4.4「输出」行(:91) ✅；**FS §4.4:90「处理」行仍留「每轮无论成败必印一行围栏」**，与 :91、RS US-1、5f-bis 断言三方相反（二审 🟡#3） | `git diff 126667b` 两行对照；test 5f-bis 明确断言 die 无围栏 |
| 🟡#3 两文件执行位 | ✅ 落地 | `ls -l` 双 `-rwxr-xr-x`；`git diff 126667b --summary` 对两文件零输出（无 mode change） |
| 🟡#4 pack 变更清单如实标注 | ✅ 落地 | task-loop.mjs:535：mr 类工单头部注「变更文件清单未随轮询拉取（省 API）……接手后先 git diff 基线自取」 |
| 🟡#5 repoHint 配置化 | ✅ 落地 | harness.rules.json:185 → feishu-bug-source.mjs:96（env `FEISHU_REPO_HINT` 可临时覆盖）→ task-loop.mjs:530（缺省打印「未配置 runtime.feishu.repoHint」指路而非硬编码路由）；FS §8 已登记该键 |
| 🟡#6 旧 ack 迁移当场实现 | ✅ 代码与测试落地；RS-close 文档未同步（二审 🟡#4） | task-loop.mjs:385（`why = a.fingerprint ? 'ack_stale' : 'ack_migrated'`→释放+删 ack+重认领）；5h 三轮：剥指纹模拟存量 ack → `ack_migrated` 且重认领、pack 重落含新意见 → 同内容再跑不动账（claimed 总数=2，幂等）；FS §4.4/§10 已写迁移口径 |

## 2 🔴#1 边界验法（实跑，非推演）

fixture（/tmp，用后已清理）：裸仓 + 工作克隆 + 假 GitLab（MR !71 他人未解决讨论）。
R1 `--once --profile a` → exit 0，认领 `claims/mr-71`、ack-71.json、pack-71.md 落盘。
R2 `--once --profile a --mr 999`（过滤轮，MR 71 不进触发集）→ exit 0，围栏「触发 0 / 关账 0 / 内容更新 0」，三件套原样保留。
R3 `--once --profile b`（wantGitlab=false；`FEISHU_MCP_URL` 指向已关闭端口 → 剖面 B ECONNREFUSED 软失败，围栏行含「源故障 feishu」证明进程到达 sweep 段而非中途 die）→ exit 1 不落戳，三件套原样保留。
三轮账本（HARNESS_LEDGER_DIR）全程无 `trigger_gone`/`ack_stale`/`ack_migrated`，`claimed` 恰 1 次。软失败边界另由套件 5g-bis 在 CI 可复跑地钉住。

## 3 二审新发现

### 必须修 🔴：0

### 值得考虑 🟡（4 条，均不阻断交付）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 1 | `scripts/lib/gitlab-triggers.mjs:186` + `scripts/task-loop.mjs:367-374` | `per_page=20` 且无翻页：本人 open MR >20 条时，最老的 MR 掉出第一页 → 该轮 gitlabViewComplete 为真但视野截断，存量 ack 会被误判「消失」走关账（释放认领+删 ack/pack+budget 清零）——🔴#1 的同类形态，守卫三条件都拦不住 | 取回条数==20（或响应 `x-total-items`>20）时视为视野不完整，本轮跳过 sweep 的关账分支（与 B 侧 `profile_b_truncated` 告警同思路，一行守卫即可） |
| 2 | `test/task-loop.test.sh`（5g-bis 段后）、`scripts/task-loop.mjs:250/:343/:361` | 处置修复的负向用例缺口：`gitlabViewComplete` 三个合取项只有 `!softFail` 被 5g-bis 钉住，`!opt.mr` 与 `wantGitlab` 套件全文无用例（`--mr` 零出现；`--profile b` 用例只测凭据缺失提示）；429→软失败同样零用例（`grep 429` 无命中）。本审 fixture 已实证当前行为正确，但这些边界被未来重构改坏时无红灯 | 补 5g-ter（`--mr` 过滤轮不动账，成本≈5g-bis）+ 一条 429 用例（5f 服务器改状态码即可） |
| 3 | `docs/02-features/task-loop/FS-任务循环执行器.md:90` | 「处理」行残留「每轮无论成败必印一行**围栏**」，紧接其后的「输出」行(:91)与 RS-task-loop.md:24、5f-bis 断言均写「die=未成轮不印」——🟡#2 处置漏改半行，同一小节内部自相矛盾 | 把 :90 的「每轮无论成败必印」改为「成轮必印」（与 :91 对齐） |
| 4 | `docs/01-requirements/RS-task-loop-close.md:42`（§4），§2 亦缺 | §4 仍写「旧 ack 无 state/fingerprint 字段 → sweep **只走关账分支不误重置**」——与已实现的一次性迁移相反（task-loop.mjs:385、FS §4.4/§10、5h 用例四处均为迁移口径）；§2 验收标准也没补 ack_migrated 行。🟡#6 从「延后」升级为「当场实现」时，本变更自己的 RS 没同步 | §4 该句改为迁移口径一句 + §2 补一行 Given 旧格式 ack Then ack_migrated 一次性重认领 |

### 仅记录

- ack_stale/ack_migrated 重置后若本轮重认领落成 noop（指纹变 `empty`），旧 pack 不重写也不删（task-loop.mjs:519 `if (!noop)`），残留过期工单；触发路径窄（指纹项全部被 resolve/删除且 MR 仍被动词触发），下批顺手清或 noop 时同删 pack。
- `FEISHU_REPO_HINT` env 覆盖代码支持（feishu-bug-source.mjs:96）但未列入 FS §8「临时覆盖」变量行。
- 仓库根有未跟踪文件 `tdasset-fix-review.md`，与本变更无关，入库前注意清理。

## 4 二审结论

- 二审 🔴：**0**；新发现 🟡 4 条（视野截断 1 / 测试缺口 1 / 文档两行 2）、仅记录 3 条。
- 一审七条处置：5 条完整落地，🟡#2 部分落地（漏 FS:90 半行）、🟡#6 代码落地但 RS-close 未同步——均为文案/文档级残留，不构成行为风险。
- 建议：**approve**。🟡#3、🟡#4 是两处两行内的文案修正，建议提交前顺手改掉；🟡#1、🟡#2 可随下批。

## 附：二审审阅范围与未覆盖

**已核对**：处置批次全部主张（§1 表七行，每行落到文件:行号）；🔴#1 三条边界中两条由本审独立 fixture 实证（§2）；`bash test/task-loop.test.sh` 本机实跑 **102 通过 0 失败**（2026-11-17）；`git diff 126667b --summary` 核执行位；5g/5g-bis/5h/5i 断言逐行读（含正负向与幂等计数）。

**未覆盖及原因**：`npm run gate` / `doctor` 全量未跑（沿一审口径，处置批次改动面已由定向核对覆盖）；FS §9 声明的变异红位未逐条复跑（静态核对断言存在性；二审 🟡#2 正是以「哪些变异无红灯」为据）；真实 GitLab/飞书端到端未跑（无凭据）；`deploy/task-loop/` 模板不在本批 diff，未审。
