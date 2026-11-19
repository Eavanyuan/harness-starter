# 架构体检 D —— 稳定性风险审计（task-loop 执行链）

- 日期：2026-11-19｜审阅者：独立复审（只读审计 + /tmp 实验）
- 对象：task-loop 本地循环执行器全链（launchd 定时器 → run-round.sh → task-loop.mjs → claims CAS → AutoClaw 定时会话执行器 → sweep 关账）及运行态数据
- 分层口径：🔴 单点/必现（结构上无兜底，条件一到必然发生）｜🟡 条件触发（特定条件才发生或已有部分缓解）｜🟢 有兜底（已有机制接住，仅记录观察）
- 事实来源：仓库代码（行号可原地复核）、`~/.harness/task-loop/{events.jsonl,task-loop.out,task-loop.err}`（2026-11-14→11-19 实跑账本）、`git ls-remote origin`、/tmp 只读实验。所有实测均标注；推测性判断明说。

---

## 一、结论

**暂不能按"无人值守自愈循环"交付，按"单机有人盯的开发机辅助循环"可用。** 必须修 4 条（全属正确性/可见性层）：claims 认领依赖 GitHub 单点且断连时整轮掀翻、循环失明无任何告警通道、凭据被拒每拍硬死、task 类认领关账未实现（远端已挂 4 天僵尸实证）。故障路径的静默性是系统性短板：39 小时 334 次无退避重试、OFF 误留 90 拍、隔夜 9.6–12.9h 静默窗口，全部只在本机日志可见。正常路径的防误判设计（fail-safe 认领、误关账收口、锁归属）质量高，11-17 事故群均有 retro 修复。**稳定性评分：5/10**（正常路径 7：判定谨慎、事故均有修复；故障路径 2：无告警、无退避、单点放大；数据耐久 5：关键记忆仅存本机；恢复路径 4：幽灵认领静默 24h 后永久 blocked）。

## 二、必须修（🔴 单点/必现，4 条）

### D1. claims CAS 走 GitHub origin，与触发源（内网 GitLab）构成双远端单点；断连时整轮掀翻

- **位置**：`scripts/task-loop.mjs:217`（`REMOTE = origin`）、`scripts/lib/claim.mjs:44-48`（push 认领）、`:553`（claim 调用不在 try 内）
- **触发条件**：github.com 不可达 / origin 推送凭据过期 / GitHub 侧限流任一。`git remote -v`：origin=github.com/Eavinyuan/harness-starter，而触发轮询全部走 git.tdengine.net。
- **现后果**：**/tmp 实测**（实验 t1）：远端不可达时 `claim()` 直接抛 `Command failed: git push`，错误文本不匹配 claim.mjs:55 的 rejected 正则 → 重抛 → task-loop.mjs:553 无 try 包裹 → uncaughtException（:230）→ exit 1。**每一拍整轮死，剖面 A/B 全盲**——GitLab 软失败有精细的"跳过该源"分类（:326），git push 失败连这个分类都进不了。release() 同样走 origin（claim.mjs:70），失败静默返回 false。
- **兜底现状**：无。soft-fail 正则只覆盖 GitLab/飞书的 HTTP 形态，git 子进程错误完全不在分类体系里。
- **修复方向**：claim/release 的 git push 失败按该触发的 soft-fail 处理（跳过该触发、不落戳、不掀整轮）；或评估 claims 落 GitLab 同域 refs，消除对第二家远端的强依赖。

### D2. 循环失明无告警通道：所有健康事件只落本机 jsonl，broker 体系不消费

- **位置**：`harness.rules.json` notify.card_events（仅 mr_open/pipeline_failed/review_blocked/decision_open）；`scripts/harness-broker.mjs:348`（事件源=GitLab webhook）；broker 全文无 events.jsonl/task-loop 消费（grep 为空）
- **触发条件**：D1、D3、D4、OFF 误留、定时器死亡、env 文件损坏——任一发生。
- **现后果**：账本实证：334 条 source_soft_fail（331 条 GitLab 超时）、90 条 killed_by_switch、无一条离开本机。`killed_by_switch` 每拍落一条（task-loop.mjs:93）成了账本噪声而非告警。飞书卡片通道**存在**（broker + notify.mjs + subscriptions 三档），但只服务 GitLab 决策事件——循环自身的死活没有任何人/任何通道知道，唯一检测手段是人翻 task-loop.out。
- **兜底现状**：无。doctor.mjs 不查定时器在场（grep 无 launchd/plist 检查项）；`install-task-loop.sh --status` 是手动命令。
- **修复方向**：把 loop 健康事件接入既有 broker（连续 N 拍 soft-fail / exit≠0 连续 N 拍 / OFF 龄期超 X 小时 / zombie 出现 → card 或 digest）。基础设施是现成的，缺的只是接线与阈值。

### D3. PAT 轮换 / 凭据被拒 = 每拍 die(1) 硬死，且靠 D2 的缺失保持不可见

- **位置**：`scripts/lib/gitlab-triggers.mjs:204-208`（401/403 抛错）；`scripts/task-loop.mjs:326`（temporary 正则不含 401 → die(1)）；`:353`（飞书 OAuth 过期同形态 die(1)）
- **触发条件**：GitLab PAT 轮换/过期、飞书 refresh_token 过期（如循环停超过刷新窗口——11-17~11-18 的 OFF 时段叠周末即可能命中）。
- **现后果**：每 180s 心跳一次 die(1)，.out 每拍一行报错（die 双通道保证了日志可见，:47-49），但无任何主动通知。症状与"配置坏了等人修"完全一致——设计上有意区分"未接入(exit 0)"与"接入坏了(exit 1)"，区分只写在日志里。
- **兜底现状**：日志可见性有（轮次围栏 + die 双通道）；升级通道无。
- **修复方向**：连续同类硬错计数器，达阈值经 D2 的通道告警一次（去重），不必改 die 语义。

### D4. task 类认领关账未实现（KI-1），僵尸认领无处置路径——远端现有 4 天实证

- **位置**：`scripts/task-loop.mjs:450`（`!key.startsWith('mr-') → continue`，注释自认 KI-1）；claim.mjs:60-66（僵尸不自动抢，ADR D2 有意）；claimTtlMs=86400000（harness.rules.json runtime.budget）
- **触发条件**：飞书单认领后单据状态流转/关闭（关账永不发生），或任何认领滞留超 24h。
- **现后果**：**现网实证**：`git ls-remote origin` 显示 `claims/task-7167752069`、`claims/task-7167910546` 自 11-15 挂在 GitHub 至今（4 天），本地 `ack-7167752069.json`/`ack-7167910546.json` 同步滞留。这两单一旦重新进入触发集（回 New+IDMP 迭代），每拍 claim_zombie → blocked → exit 1 + 仅日志（claim_zombie 事件类型现网 0 条——纯因当前未触发，非机制不存在）。**blocked 没有任何升级出口**：无告警（D2）、无 runbook、无自动处置，需人工 `git push origin --delete refs/heads/claims/task-<id>`，而这条命令没有任何地方提示。
- **兜底现状**：TTL 判定存在（防误抢，方向正确）；处置与可见性为零。
- **修复方向**：① zombie 首次出现时在日志/事件里带出处置命令并接 D2 告警；② task 关账按单号反查状态（KI-1 原计划），或至少给 task ack 加 TTL 提示。

## 三、值得考虑（🟡 条件触发，9 条）

### D5. 网络故障重试无退避、无熔断——39 小时 334 次实测

- **位置**：`scripts/task-loop.mjs:508`（soft-fail 不落节流戳 → 下一心跳立即重试）；心跳=plist StartInterval 180s 固定，pollSeconds=1800 只约束成功轮
- **触发/后果**：账本实测 2026-11-16T14:57Z→11-18T06:09Z 连续 39h，334 次软失败（峰值 19/h=每拍必试，均值 12.8/h），且**每拍仍全量轮询飞书**（feishu_auth 393 次≈每拍）——GitLab 断网放大为双源轮询成本+日志噪声（out 3241 行/5 天）。注：任务简报称"2 小时 2400 次"，账本口径不可复现（ledger 每拍记 1 条；若按 tick 内多次 API 超时计可能更高），此处以实测数为准。
- **兜底现状**：单源软失败不拖死另一源的设计有效（11-16 实测剖面 B 全程存活）。缺的只是退避。
- **建议**：连续 soft-fail 后指数拉长该源重试间隔（内存计数即可，不必持久化），或 3 连败后跳 N 拍。

### D6. kill switch OFF 误留无检测——11-17~11-18 实证 5 段共 90 拍

- **位置**：`scripts/task-loop.mjs:91-96`；检测面缺失（同 D2/D7）
- **实证**：events.jsonl killed_by_switch 聚成 5 个连续簇：11-17 06:24–07:57Z（32 拍）、08:41–09:05Z、10:20–11:08Z、22:46–23:13Z、11-18 07:41–09:06Z（24 拍）——事故日反复开关、次日仍误留约 1.5h。OFF 期间每拍落一条事件，账本里它与真实故障不可区分。
- **兜底现状**：无 OFF 龄期检查；`--status` 仅手动显示当前态。
- **建议**：OFF 创建时间入事件（mtime 可得），超 4h 走 D2 告警；OFF 时每拍落事件改为首拍+每小时一条。

### D7. launchd 定时器无看门狗：死亡/plist 损坏/休眠静默窗口均不可检测

- **位置**：`deploy/task-loop/launchd.plist.template`（无 KeepAlive；StartInterval=180）；`scripts/doctor.mjs`（无定时器在场检查）；`.ai/locks/task-loop.last-run` 有戳无消费者查龄期
- **触发/后果**：launchctl unload / OS 升级清 LaunchAgents / plist 写坏 → 循环静默消失，账面上与"今天没任务"不可区分；休眠窗口实测——events.jsonl 四个隔夜缺口 9.59/10.0/10.33/12.87h（11-14→11-18，activeHours 上线前）。 plist 注释自述"休眠唤醒=下个 tick 补上"，唤醒后确实补一拍，但沉睡期间打回/CI 红无人处理且无感知。
- **兜底现状**：RunAtLoad=true（重启即恢复）✅；定时器死亡后的发现手段为零。
- **建议**：doctor 增加「last-run 龄期 > 3×pollSeconds 报红」与「launchd loaded 状态」两项；或按 D2 定期自报心跳。

### D8. SIGTERM 不执行 exit 钩子：轮次锁与持有认领的清理全押在不会被调用的路径上

- **位置**：`scripts/task-loop.mjs:198`（锁删除）、`:237`（held 认领释放）均挂 `process.on('exit')`
- **实测**（/tmp 实验 t2）：SIGTERM 与 SIGKILL 下 `process.on('exit')` 均 **NOT-RUN**（Node 默认信号终止不触发 exit 钩子）。
- **触发/后果**：launchctl unload / 注销 / 重启恰好命中轮次中段（轮次通常 7-10s，窗口小但存在）→ `.ai/locks/task-loop.round` 残留 → 后续 30min 内每拍"上一轮仍在进行"跳过（ROUND_LOCK_MAX_AGE_MS=30min 孤儿接管兜底存在，故 🟡 非 🔴）；held 认领不释放 → TTL 24h 兜底。
- **建议**：补 `process.on('SIGTERM')` 显式走清理后 exit；顺带把锁孤儿接管阈值对齐轮次实际时长（maxActiveMs=30min 恰好同值，语义耦合但未显式声明）。

### D9. 执行器（AutoClaw 定时会话）被杀后 worktree 残留无自动清理——/tmp/tl-main 实证

- **位置**：协议面 `scripts/lib/session-pack.mjs:17`（"你在一个独立的 worktree 里工作"）；仓库内无任何 worktree 巡检/清理代码（grep 仅 baseline.mjs 清自己的）
- **实证**：`/tmp/tl-main` 是 TDasset 仓的 worktree（`.git` → `TDasset/.git/worktrees/tl-main`），11-17 17:17 创建（首日执行器运行时段）至今未清；`/tmp` 另有 40+ 个 `tl-*` 测试日志。round-1-1896 记录"已按清理流程移除"=清理靠会话自觉，2700s 被杀/进程挂即跳过。
- **后果**：产品仓 worktree 注册表污染、磁盘残留、后续同名 worktree add 冲突；/tmp 周期清理删掉目录后留下 prunable 注册项。
- **兜底现状**：无。
- **建议**：执行器入口（读 pack 的会话开头）先 `git worktree prune` + 检测 `tl-*` 陈旧目录；或 runner 的 sweep 顺带报告陈旧 worktree。
- **注**：overlap=skip 空转、2700s 杀进程策略在 AutoClaw 应用配置内，仓库不可核——见"未覆盖"。

### D10. 本地/远端账面不一致无对账：幽灵认领静默 24h（exit 0）后永久 blocked

- **位置**：`scripts/task-loop.mjs:556-566`（claim_skip → stats.skip，非 blocked）；`.ai/task-loop/` 整目录 gitignore（.gitignore:32）
- **触发/后果（⑥ 灾备直接作答）**：
  - **本地删/机器丢，远端在**：fresh clone 后 MR 再触发 → 认领被幽灵 ref 挡下 → `claim_skip(reason=taken)` → **exit 0 且照常落节流戳**——完全静默长达 24h（TTL），之后转 zombie → 永久 blocked 仅日志（回到 D4）。恢复全靠人知道要去删 ref。
  - **远端删，本地在**：MR 仍红 → 重认领成功 → ack 被无条件重写（:698）→ **budget 轮次历史清零**——carryRounds 只在 sweep stale 路径且仅 `fingerprint 以 ci: 开头`时携带（:495），重认领路径不携带。maxRounds=3 的"防越修越坏"预算在认领丢失/换机场景被重置。
- **兜底现状**：TTL 是唯一自愈机制，且以 24h 盲期+永久 blocked 为代价。
- **建议**：轮次启动时做一次「远端 claims vs 本地 acks」差异对账（ls-remote + readdir，秒级），差异打印处置命令；重认领路径从旧 ack 继承 budget.rounds。

### D11. sweep 关账先删本地账、后问远端成败——release 失败制造 D10 形态的幽灵认领

- **位置**：`scripts/task-loop.mjs:456-459/485-488/497-500`（`const okRel = release(...)` 后**无条件** `rmSync(ack)` + `rmSync(pack)`）
- **触发/后果**：关账时 origin 推送失败（D1 同因）→ 本地账已删、远端认领仍持 → 该 MR 进入 D10 的幽灵态。事件里 `released:false` 有记录（trigger_gone detail），但无消费者、无重试。
- **建议**：release 失败时保留 ack 文件（下轮 sweep 重试关账），本地清理移到 release 成功分支。

### D12. task-loop.env 非法行 → 每拍 exit 1：设计上正确的选择，配上 D2 就是"每拍报错但无人知"

- **位置**：`scripts/lib/env-file.mjs:48-52`（非法行抛错，不回显内容——安全考量正确）；`scripts/task-loop.mjs:60`（die(1)）
- **触发/后果**：手抖改坏/编辑器另存截断 → 每拍 die(1)，.out 每拍一行"凭据文件无法解析"。防"表现成今天没任务"的目标达成，但发现仍靠人看日志。
- **建议**：归入 D2 告警面即可，解析行为不必改。

### D13. run-round.sh 硬编码 AutoClaw2.app 内嵌 node 路径

- **位置**：`~/.harness/task-loop/run-round.sh`（`exec /Applications/AutoClaw2.app/.../vendor/node/bin/node`，install-task-loop.sh write_wrapper 按安装时 `command -v node` 固化）
- **触发/后果**：AutoClaw2 升级/移动/卸载 → 每拍 bash 127，循环死。.out 有痕迹、无人知（D2）。**可恢复**（重跑 install 脚本重生 wrapper），但无检测。
- **建议**：wrapper 加 node 不存在时的明确报错行（bash 即可），或 doctor 检查 wrapper 可执行性。

### D14. 评审腿（review 触发）的轮次预算随指纹变化清零

- **位置**：`scripts/task-loop.mjs:495`（仅 `ci:` 前缀携带 rounds）；ci-fail 腿已由 carryRounds 修复（retro ci-inflight-hold 教训 3）
- **触发/后果**：MR 修复期间新评审评论落地 → 指纹变 → sweep 重置 ack → 重认领 → budget 全新。评审意见反复编辑的场景下 maxRounds 失效，与"每 30 分钟推一个更坏的 commit"的原始担忧同形。
- **建议**：carryRounds 对非 ci 指纹同样携带（键从 `ci.rounds` 换成 ack 通用字段）。

## 四、仅记录（🟢 已有兜底 / 观察，8 条）

1. **误关账三路径已收口**（11-17 实锤 17:43 释放→17:58 重认领 13→16 引入项，events.jsonl 09:43:38Z/09:58:56Z）：sweep 仅视野完整才判消失（:438,:451）、inflight 白名单按 TERMINAL 集合（gitlab-triggers.mjs:302，未知状态保守在途）、无流水秒级窗口也保持（:302 注释）。retro/ci-inflight-hold-2026-11-17.md 三教训全落地。
2. **认领孤儿三层兜底**：uncaughtException/unhandledRejection 双信号 releaseAll（:230-236）+ exit 钩子 + TTL；历史泄漏路径（claim 后崩在 budget）已修。
3. **轮次锁健壮性**：fresh clone 无 locks 目录已处理（:181）；锁自毁 bug（跳过者删持有者锁）已修（roundLockOwned 归属，:196-203）；接管竞态看新锁年龄（:191-194）。锁 fail-open（判不了不过度保守）是有意设计。
4. **die 双通道 + 轮次围栏行**（:47-49,:163-171）："载入凭据后无声退出 9 小时"的坑已修，.out 永远能对账。
5. **MR 详情 404 已不无痕**（:372-376 skipped404 落账）——简报所说"已修"核实无误。
6. ack/pack 为 writeFileSync 直写非原子（:698 等），执行器读到半截 JSON 的窗口毫秒级且执行器主读自己的 todo/acks——影响可忽略。
7. 运行态日志无轮转：out 3241 行/err 2209 行/5 天（err 大半是 launchd 下 bash 的 getcwd TCC 噪声 ×2/拍）；events.jsonl 287KB/5 天。按当前速率年 MB 级，暂不构成风险。
8. 心跳 180s vs 真实节拍 1800s：9/10 拍为毫秒级空转（env 解析+OFF 检查后退出），设计使然，成本可忽略；代价是 plist 与 rules 的节拍语义分离需要文档支撑（已有注释）。

**数据耐久性盘点（② 必查面作答）**：不可重建的唯一副本=round-N 会话日志（跨会话唯一记忆通道，session-pack.mjs:10/22）、events.jsonl 取证账本、shadow.jsonl 统计——全在本机（gitignored `.ai/task-loop/` + `~/.harness/task-loop/`）；可重建=ack/pack（触发即重生成）、claims（GitHub）、todo（执行器自产）、env/oauth（人工重配/重登）、wrapper/plist（install 脚本重生）。机器丢失的实际损失=修复过程记忆+取证记录，恢复路径会先撞 D10 幽灵认领。

## 五、审阅范围与未覆盖

**核对了**：task-loop.mjs/claim.mjs/env-file.mjs/gitlab-triggers.mjs/task-loop-core.mjs/install-task-loop.sh/launchd plist 模板全文；session-pack/broker/doctor/ledger 关键路径；5 天实跑账本（events.jsonl 1768 条逐类统计、out/err 抽样）；远端 claims 现状（ls-remote）；.ai/task-loop 全部滞留文件；4 项 /tmp 实验（claim 断连抛错、SIGTERM/KILL 下 exit 钩子不执行、env 非法行、worktree 残留取证）。任务简报给的 6 个必查面逐一有结论：①D1/D7/D9 ②见第四节末盘点 ③D2/D3/D5 ④D8/D10/D11/D14+仅记录#1 ⑤D6/D7/D12/D13 ⑥D10。

**未覆盖/不可核**：AutoClaw 定时会话的应用内配置（overlap=skip、2700s 超时策略、会话调度细节）不在仓库内，只能采信简报并以上下游证据旁证（/tmp/tl-main 残留、round-1 清理记录）；GitHub 推送凭据过期的实际表现未模拟（D1 结论基于 unreachable 实验+代码路径，凭据失败走同一 catch）；多机并发争抢仅代码推演（现网单机）；飞书 refresh_token 过期时长未实测；简报"2 小时 2400 次"的口径未复现（已注明实测口径）。审批面（approvalValid）与 CI 归因正确性属其他审计分路，本文未重查。
