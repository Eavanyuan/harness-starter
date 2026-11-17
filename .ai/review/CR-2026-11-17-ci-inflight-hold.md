# CR 代码审查记录 — ci-inflight-hold（在途保持 / 跨流水轮次上限 / 轮次锁 / trace 落盘）

> 产出：code-reviewer（正式 CR）· 2026-11-17
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。

- 审查范围：`ab02da5...工作树`（未提交变更：`scripts/task-loop.mjs`、`scripts/lib/gitlab-triggers.mjs`、`scripts/lib/ci-failures.mjs`、`test/task-loop.test.sh`、`docs/02-features/task-loop/FS-任务循环执行器.md`；新增 `.ai/tasks/ci-inflight-hold/`、`docs/01-requirements/RS-ci-inflight-hold.md`）
- 关联 FS：`docs/02-features/task-loop/FS-任务循环执行器.md` §4.4/§6/§9（同批更新）
- 关联 RS：`docs/01-requirements/RS-ci-inflight-hold.md`（本次核对基线）
- **已加载的 skill**：`harness v1.1.0`（`resolve-skills --diff` 命中 4/5 改动文件；Stage 0 三项已读：checklist.md、被改脚本全文及调用方、对应测试文件）
- 评审者自跑证据：`.ai/verify/CR-IH.log`（全套件）、`.ai/verify/CR-IH-MUT.log`（三处变异）、/tmp 复现实验两条（见 🔴#1 与 🟡#2）

## 0 硬规则逐条核（harness skill H1–H9）

| # | 规则 | 检测命令（本审实际执行） | 结果 |
|---|---|---|---|
| H1 | scripts 改动同批带测试 | `git diff --name-only ab02da5`：3 个 scripts 文件 + `test/task-loop.test.sh`（+141 行，5m/5m-bis/5n/5k-ter） | ✅ |
| H2 | 生成物禁手改 | `git status`：无 `.claude/`、`.zcode/`、`prompts/` 变更；agents/hooks.manifest 未动，无需重建 | ✅ |
| H3 | 解析失败 fail-closed | 无 `hooks/*.mjs` 改动 | 未命中 |
| H4 | 黑白名单只在配置 | 无保护区字面量新增（INFLIGHT 状态集是行为枚举，非名单） | 未命中 |
| H5 | skill 体型约束 | 无 skill 文件改动 | 未命中 |
| H6 | 新增拦截须给绕过法 | 锁跳过按 RS §4 是「保险不是门禁」（fail-open 明示）；但手动绕过（`rm .ai/locks/task-loop.round`）未在任何文档出现 | ✅（补文档见仅记录 #5） |
| H7 | hook 双 CLI 接线 | 无新 hook | 未命中 |
| H8 | 新配置键须有消费者 | 无新键：复用 `runtime.budget.maxRounds`、`runtime.taskLoop.pollSeconds` | ✅ |
| H9 | 断言可证伪 + 变异 | 三处变异各精确 1 红（评审者复现：`CR-IH-MUT.log`）；作者侧变异主张无日志留存（见仅记录 #7） | ✅（评审者补证） |

## 1 改动摘要

定时执行器上线首小时三起实测事故的机制修复：(1) 非终态流水进 inflight 集合，sweep 对其保持账目（18:14 !1847 running 被当「已合并」误关账）；(2) `ack.ci.rounds` 跨流水携带，超 `maxRounds` → `needs_human`+`ci_escalated`+删旧工单（!1896 13→16 越修越坏无上限）；(3) `.ai/locks/task-loop.round` 本地轮次排他锁（30min 孤儿接管、退出自清）；(4) opaque 归因时失败 job trace 尾部 400 行落 `.ai/task-loop/traces/<id>/`。测试 111→116。

## 2 阻断项 🔴

| # | 位置 | 问题 | 依据 | 建议 |
|---|---|---|---|---|
| 1 | `scripts/task-loop.mjs:168-171` | exit handler 无条件 `rmSync(roundLockPath)`，且注册在「跳过路径」之前：**未获得锁的进程退出时会删掉持有者的活锁**。时序：A 轮超 180s 心跳仍在跑 → B 心跳见新鲜锁、打印跳过、exit(0) 时把 A 的锁删了 → C 心跳见无锁照常起跑 → 与 A 并发 sweep/ack 写盘——恰是锁要消灭的场景，且**轮次越长（越需要锁）越必然触发**。评审者已实证：预置他人锁 → 跳过路径跑完 → 锁文件消失（/tmp 实验 EXP1，输出「锁被跳过的进程误删」）。测试 5n 第一检查只 grep 跳过文案、未断言「跳过后锁仍在」，故 116 绿测不出 | 需求 RS C-3「新 tick 跳过」语义被破坏；锁在真实慢轮场景必然失效 | `acquireRoundLock` 返回是否持有（`let lockOwned`），exit handler 仅在 `lockOwned` 时清理；5n 补断言：跳过路径跑完后锁文件仍存在 |

🔴 数量：1。

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | `scripts/lib/gitlab-triggers.mjs:198,221` + `scripts/task-loop.mjs:415` | inflight 完备性三处残余缺口：① `hp` 为 null（推送→流水创建之间的秒级窗口）不进 inflight → sweep 按「已合并/已批红」关账 + rounds 清零；② `canceled/skipped` 不在 INFLIGHT 也不在 RS 验收的终态清单（「success/failed/合并/关闭 才走关账」）却会关账，理由行撒谎；③ 未来 GitLab 新增状态字串默认落「关账」侧，与注释「success/failed 之外一律算在途」不符。三者影响同事故类：误关账 + 轮次计数清零（上限可被偶然绕过） | 未知状态（∉ 已知终态 ∪ INFLIGHT）保守按在途处理；canceled/skipped 的关账口径写进 RS/FS 明示（或同样保持） | 修（低成本，可并入本任务） |
| 2 | `scripts/task-loop.mjs:152-159` | `.ai/locks` 目录不存在时（fresh clone 首跑——目录要等 `stampLastRun` 在成功轮末尾才建）`openSync` ENOENT → `return true` 静默无锁。已实证（/tmp 实验 EXP2）。RS「判不了就放行」针对的是异常态，ENOENT 是「没地方放锁」的一行修复；5n 预建目录把这条路径测没了 | `acquireRoundLock` 开头 `mkdirSync(join(root,'.ai','locks'),{recursive:true})`；5n 补一条无目录首跑断言 | 修 |
| 3 | `scripts/task-loop.mjs:162-165` | 孤儿接管 TOCTOU：两进程同时判 >30min，双双 `rmSync`+`write`，后写者 EEXIST 落入 `catch { return true }`——「接管失败」被当「接管成功」，两进程并行。窗口极窄（rm→write 间）且属「保险」口径，但 catch 兜底方向反了 | 接管分支 EEXIST 时重试一次 acquire（stat 新锁 age 新鲜即返回 false） | 延后可（登记残余风险） |
| 4 | `test/task-loop.test.sh`（5n 第一检查，约 1125 行） | 新鲜锁检查未做 HOME 隔离（第二检查做了且注释写明 10d 教训）。当前安全纯因锁检查位于源解析之前、跳过路径提前 exit——顺序一挪，该检查就会读本机真实飞书凭据 | 第一检查同样 `HOME=$TMP/...`（一行） | 修 |

🟡 数量：4，处置已逐条表态（修 3 / 延后 1）。

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| `fetchTriggers` 其它消费方 | 否 | grep 全仓：仅 `task-loop.mjs:271` 与测试 5c/5d 直接调用；数组挂属性不破坏既有用法（116 绿含这两组） |
| spread 丢失链 | 已覆盖全路径 | `triggers.push(...fetched)` 丢属性后 `fetched.inflight` 于 :273 单独捕获；软失败/`--mr`/profile-b 三路径下 sweep 由 `gitlabViewComplete`（:397）整体跳过，空 Set 无害 |
| `byJob` 消费方 | 否 | `session-pack.mjs:88` 签名只收 `failedJobs/excerpts`——tail 不进工单；tail 唯一落点 :617-624 traces 目录 |
| ack 新字段（`ci.rounds`/`ci.projectId`） | 否，向后兼容 | 旧 ack 无 `rounds` → sweep :432 `?? 1` 走 ack_migrated 重认领；ack 消费方仅 sweep 与工单构建 |
| 轮次锁 × 节流戳同目录 | 否 | `.ai/locks/` 内两文件互不读写对方；整目录已 gitignore |
| carryRounds id 口径 | 一致 | sweep :432 `String(id)`（key.slice(3) 字符串）↔ 认领 :579 `String(t.id)`（数字转字符串），两侧显式归一；5m-bis 断言 1→2→4 实证 |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入（命令/路径） | ✅ trace 文件名 `[^A-Za-z0-9._-]+`→`_`、40 字符截断（:618-619）；内容写文件不经 shell |
| 越权 | 不涉及（本地文件 + 既有 API 面） |
| 敏感信息进日志 | ⚠ traces 为原始 CI 日志尾部 400 行，若构建回显密钥则落本地明文——与既有 excerpt 同类暴露、仅放大；`.gitignore` 已含 `.ai/task-loop/` 不会入库（见仅记录 #2） |
| 凭据 | ✅ token 不落 ack/事件/工单（核对 :605-612 与 byJob 字段） |
| 依赖变更 | 无 |

## 6 测试覆盖

- 评审者真跑：**116 通过 0 失败**（`.ai/verify/CR-IH.log`，2026-11-17；作者侧 IH1/IH2 同为 116，主张与日志一致）。
- 变异（评审者复现，`.ai/verify/CR-IH-MUT.log`）：去在途保持→1 红；新鲜锁不跳过→1 红；上限放开→1 红。三个新行为真被钉住。
| 新增行为 | 测试 | 备注 |
|---|---|---|
| running 保持账目、success 才关账（5m） | ✅ 钉住 | 断言 ack 存在 +「流水在跑」文案 + 无 trigger_gone + 第三轮关账 1 |
| rounds 跨流水累计与上限（5m-bis） | ✅ 钉住 | 1→2 自然链 + preset 3→4 升级断言（state/rounds/ci_escalated/无工单） |
| 锁三态（5n） | ⚠ 部分钉住 | 新鲜跳过/孤儿接管/自清有断言；**未钉「跳过后锁仍在」**（🔴#1 因此漏网）；首跑无目录路径未测（🟡#2） |
| opaque 落 traces（5k-ter 扩展） | ✅ 钉住（存在性） | 只断言文件存在，未断言内容含尾部 |
| needs_human 下一轮语义 | 未测（推演成立） | 同流水下轮 fingerprint 未变→sweep 不动→claim CAS 拒绝→claim_skip，needs_human 保持；升级+opaque 组合（traces 因 continue 跳过）无测试（仅记录 #3） |

## 7 结论

- 🔴 数量：1（锁误删，`task-loop.mjs:168`）
- 🟡 已全部表态：是（修 3 / 延后 1）
- 建议：**request changes** —— 🔴#1 是五行内修复（lockOwned 门卫 + 5n 一条断言），修完即可转 approve；🟡#1（inflight 残余缺口）建议同批处理，其余可延后。

## 审阅范围与未覆盖

- 已核：五文件 diff 逐行、sweep/认领循环全路径、inflight 传递链与三盲径、carryRounds 口径、needs_human 后续轮次语义（推演）、锁三态与两处缺陷（实证）、traces 落点与体积、`.gitignore` 覆盖、RS/FS/state.json 同步（ci_escalated 进 §6 事件表、§9 验收行、meta.affected_ids 一致、todos verify 均为对象且 ooda=audit）、套件真跑与三处变异。
- 未覆盖：① `.ai/review/CR-2026-11-16-未提交代码与CR流程验证.md`、`tdasset-fix-review.md`、`.ai/verify/CR2D.log`——其它任务的未跟踪产物，不在本次范围；② launchd 双进程**实机**并发（锁分析基于代码推演 + 单机复现实验，未起两个真定时器对拍）；③ 多机 carryRounds 竞争仅静态推演（认领 CAS 仲裁下成立）；④ `.ai/task-loop/OFF` 哨兵为开发期置位，套件用独立 `--root` 不受影响（已核测试头隔离 `HARNESS_ENV_FILE`/`HARNESS_LEDGER_DIR`）。
