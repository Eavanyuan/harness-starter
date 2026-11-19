# CR 代码审查记录 — p0-stability 未提交变更（架构体检 P0 止血四件，change tier 2）

> 审查者：code-reviewer（独立核对，2026-11-19）· 正式 CR
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。

- 审查范围：`a471a41`...工作区未提交（`git status`：RS/FS/rules/claim.mjs/task-loop.mjs/test 六文件 + `.ai/tasks/p0-stability/`）
- 关联 FS：`docs/02-features/task-loop/FS-任务循环执行器.md` §4.4/§8/§9
- 关联 SR 报告：`.ai/review/ARCH-2026-11-19-架构体检.md`（D1/D2/D10/D11）
- **已加载的 skill**：`resolve-skills --diff` 命中 **harness v1.1.0**（claim.mjs/task-loop.mjs/test/rules）+ **deployment v1.0.0**（harness.rules.json）

## 0 硬规则逐条核（命中 skill 的规则表，必填）

harness skill（H1-H9）：

| # | 规则 | 检测命令 | 结果 |
|---|---|---|---|
| H1 | 改 scripts 必须同批新增测试 | `git diff --name-only HEAD` | ✅ `scripts/` 两文件改动，`test/task-loop.test.sh` 同批 +173 行（5u/5v/5w/5x） |
| H2 | 生成物禁止手改 | `git status` + `npm run check:agents && check:hooks` | ✅ `.claude/`、`.zcode/`、`prompts/` 零改动 |
| H3 | 解析失败 fail-closed | 本次未改 hook 解析 | 未命中 |
| H4 | 名单/保护区只进配置 | `rg` 字面量 | ✅ healthAlertTicks 落 `harness.rules.json:200`，代码仅留默认值 10 兜底 |
| H5 | skill 体量约束 | 本次未改 skill | 未命中 |
| H6 | 新拦截规则附绕过法 | 本次无新拦截规则（全是故障路径兜底） | 未命中 |
| H7 | 新 hook 双 CLI 接线 | 本次无 hook 改动 | 未命中 |
| H8 | 配置新键有消费者 | `npm run doctor` | ✅ 真跑通过：「配置键均有消费者（19 个）」 |
| H9 | 断言可证伪 + 变异结果 | 见 §6 | 🔴 部分：5u 名义覆盖"释放失败不动本地账"但**零断言**，failed 分支变异不会红；变异产物亦未入库（`.ai/verify/` 只有 4 份普通套件日志） |

deployment skill（D1-D6）：部署流程规则（init 后开箱绿/影子周/凭据 0600/旁挂零文件/skipTests/首单手动），本次为 harness 自开发变更，全部未命中。

## 1 改动摘要

对架构体检 D1/D2/D10/D11 的止血：claim 网络异常按源分类不掀轮（claim_error）、releaseEx 三态释放（失败不动本地账）、孤儿认领观测、SIGTERM/SIGINT 显式处理器、循环健康自查（health.json + loop_degraded + osascript 通知）、轮次历史独立化（rounds-history.json，Draft 关账不清）。套件 125→129，本轮真跑 `bash test/task-loop.test.sh` **129 通过 0 失败**（与 4 份 verify 日志一致）。

## 2 阻断项 🔴

### 🔴#1 `releaseEx` 失败态被嵌套，`status === 'failed'` 永假——D11 修复整体失效

- **位置**：`scripts/lib/claim.mjs:93` `return { status: failed_safe(e, err) };` + `:97`（`failed_safe` 返回的已是 `{status:'failed',error}` 完整对象）
- **问题**：失败时实际返回 `{status: {status:'failed', error:…}}`。**实测**（/tmp 裸仓、远端路径不存在、git 2.50.1）：
  ```
  releaseEx(...) → {"status":{"status":"failed","error":"fatal: '…' does not appear to be a git repository…"}}
  r.status === "failed" → false
  release(...) → true   ← 旧代码失败返回 false
  ```
- **影响**（链式）：
  1. sweep 两处关账分支（`task-loop.mjs:504-512` draft、`:541-549` close）的 `rel.status === 'failed'` 永假 → **释放失败仍删本地 ack+工单**——正是本次要修的 D11 病灶，改动核心目标落空；
  2. `release_failed` 事件从关账路径永不落账（作者自述的"下一轮重试"信号不存在）；
  3. `release()` 布尔语义反转（失败→true）：`releaseAll`(:263)、ack_stale 重认领(:563)、feishu_ack_failed(:678)、task_failed(:846) 全部把失败记成 `released`；且 `:679 if (okRel) held.delete(...)` 在失败时误删持有账，退出钩子不再补释放。
- **依据**：claim.mjs:93/97 与上述调用点；/tmp 实验输出（本 CR 审阅环境留存）。
- **修复方向**：`releaseEx` 失败分支直接 `return failed_safe(e, err);`（去掉外层包装），一行修复。

### 🔴#2 `blocked` TDZ：修好 🔴#1 后，释放失败分支立即 ReferenceError

- **位置**：`scripts/task-loop.mjs:508`、`:545`（sweep 两失败分支 `blocked += 1`）vs `:577`（`let blocked = 0;` 声明）
- **问题**：sweep 在声明前使用 `blocked`。当前因 🔴#1 该分支不可达所以 129 全绿；一旦修 #1，**每次释放失败都变 ReferenceError → uncaughtException → 整轮 die(1)**——比现状（静默删账）更吵但同样不完成关账。两错互相掩护，也证明该分支从未被任何测试执行。
- **依据**：模块顶层执行顺序（sweep ~501-570 → 声明 577 → claim 循环 578+）。
- **修复方向**：`let blocked = 0` 上移到 `stats` 声明（~161）附近。

### 🔴#3 `alreadyGone` 判据采信服务端可控文案——真实拒绝可被误判，本地账被误清

- **位置**：`scripts/lib/claim.mjs:92` `/does not exist|deleted|no match|remote ref/i.test(err)`
- **问题**：stderr 里的 `remote: …` 行是**服务端任意文本**（pre-receive 钩子/服务端策略原样透传）。**实测**（/tmp 裸仓 + pre-receive 钩子，拒绝文案含 "may not be deleted"）：ref **仍在远端**（ls-remote 确认 `5d10c62…` 在岸），`releaseEx` 却返回 `{status:'alreadyGone'}` → 调用方继续删本地 ack → 远端认领活、本地账没——与 D11 完全同形态的不一致，下轮 claim → taken → orphan_claim 观测 → 卡到 TTL 24h。
- **实测反例（不中招）**：git 自带 `receive.denyDeletes` 文案为 `denying ref deletion` / `deletion prohibited`，不含 `deleted` 字样 → 正确判 failed。git 2.50.1 删不存在 ref 是 warning + exit 0（判 deleted）。真实 GitLab/Gitea/GitHub 的拒绝文案未逐一实测（无实例），但机制上任何含 `deleted/no match/remote ref` 的服务端文案都会翻转分类。
- **依据**：/tmp 实验（case D/E/B）；git 2.50.1 (Apple Git-155)。
- **修复方向**：删失败后用 `git ls-remote <remote> <ref>` 复核在岸性定 alreadyGone/failed（claim.mjs 已有 ls-remote 机制可复用），或把判据收紧到 git 客户端固定文案白名单。

### 🔴#4 `markHealth` 记分点覆盖不全——剖面 B 硬死/uncaught/启动死不计分，长期故障下 loop_degraded 永不触发

- **位置**：`scripts/task-loop.mjs`——记分仅两处：`:207`（finish 软失败轮）与 `:374`（剖面 A 硬失败）。不计分的死亡路径：`:401/432/462/463/467`（剖面 B 硬 die，含 token 过期）、`:279-285`（uncaughtException/unhandledRejection）、`:61/102/243/248/325-333`（启动期 die）。
- **问题**：RS 本次新增验收行（`docs/01-requirements/RS-task-loop.md` US-1）：「Given 连续 healthAlertTicks 拍（默认 10）无成功轮 Then loop_degraded 落账 + 本地通知」。飞书 token 过期这类**每拍都 die** 的故障：noSuccessStreak 永不增长 → 永不告警——正是 D2「循环瞎了没人知道」要消灭的场景，只是换了个死法。die() 不经 finish，exit 前无记分。
- **依据**：die 实现（`:50` 直接 process.exit）；grep 全部 die 调用点 vs markHealth 调用点。
- **修复方向**：在 die() 里统一接入 `markHealth(false, msg)`（usage 类 64 可豁免），或最低限度补剖面 B 硬失败与 uncaught 处理器两处。

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | `task-loop.mjs:562-567` | ack_stale **重认领**分支仍用布尔 `release()` 且无条件 rmSync ack——RS 验收行写明"关账/**重认领**的释放失败→本地账保留"，实现只保护了两个关账分支 | 该分支同样换 `releaseEx`，failed 时保留 ack 下一轮重试 | 修（与 🔴#1 同批） |
| 2 | `test/task-loop.test.sh` 5u 区段（~1559-1600） | echo 标题与 state.audit 均声称覆盖"释放失败不动本地账"，实际**零断言**——🔴#1/#2 两个地雷因此漏网；H9 变异四件未含 failed 分支且无变异产物入库 | 补一段：远端不可达时 sweep 关账 → ack 仍在 + `release_failed` 事件 + 恢复后下一轮真关账；变异"去掉 failed 分支"必须红 | 修 |
| 3 | `task-loop.mjs:274` | SIGTERM 处理器**无条件** `rmSync(roundLockPath)`，违背本文件 `:246` 自己沉淀的"只有持有者能删锁"（`acquireRoundLock` 在 `e.code!=='EEXIST'`/stat 失败路径 return true 但 `roundLockOwned=false`，此时收到信号会删掉活锁持有者的锁，放第三个进程并发进来） | 包一层 `if (roundLockOwned)`，与 exit 钩子（:236）同判据 | 修 |
| 4 | `task-loop.mjs:729-730` | rounds-history 在轮次**完成前**落盘：SIGTERM/崩溃中断的轮已 +1 但修复没跑，重开后 `max(carried, history+1)` 取到虚高值 → maxRounds 提前升级 needs_human（方向保守，非数据丢失） | 与 ack 落盘同批写历史，或在注释明示"中断轮计入历史"是有意取舍 | 延后（一行注释亦可） |

仅记录（不影响本次交付）：
- 双路径幂等核过：SIGTERM → releaseAll（held.clear 后 exit 钩子 no-op）+ rmSync force 幂等 ✓。
- 历史文件损坏 → `readRoundsHistory` catch `{}` 退化为仅 ack 携带（旧行为）✓ 安全；健康文件损坏同理从零计。
- claim_error 轮 stamp=true 记成功轮：符合 RS 字面口径（落戳=成轮），claim_error 事件已落账可查；长期 claims 单点故障无健康信号属观测缺口，随 🔴#4 一并考虑即可。
- osascript 无 GUI/SSH/Linux：spawnSync 非零退出与 ENOENT 均**不抛**（返回 result.error）、stdio ignore、5s 超时，最坏静默失败/阻塞 5s——符合"尽力而为"注释；同用户无提权。
- `healthAlertTicks: 0` 经 `Number(x)>0 ? x : 10` 退回 10，无法显式关闭。
- markHealth 的 `why` 与 releaseEx 的 `error` 均截断进账本，与既有 recordEvent 口径一致。

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| `task-loop.mjs` 全部 `release()` 调用点（:263/:563/:678/:846） | **是**——🔴#1 布尔反转：失败被记 `released`，`:679` 误删 held | 本 CR §2#1 实测 |
| `task-loop.mjs` 两处 `releaseEx`（:504/:541） | **是**——failed 判定永假，本地账照删 | 本 CR §2#1 |
| `test/task-loop.test.sh`（claim CAS 直测 + 5u/5x e2e） | 否——129 真跑全绿；但零覆盖 failed 分支（🟡#2） | 本轮真跑 |
| `hooks/` | 否——grep 无 claim.mjs 引用 | `grep -rn lib/claim.mjs hooks/` 空 |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入（SQL/命令/模板） | 低危一处：`h.noSuccessStreak` 来自 health.json，`(+1)` 不强转数字，字符串值可拼进 osascript `-e` 脚本——前提是攻击者已能写本仓文件（同用户、无提权）。建议 `Number(h.noSuccessStreak)||0` 强转。`claimRef` id 白名单不变 ✓ |
| 越权 | 不涉及（本地脚本，无权限面变化） |
| 敏感信息进日志 | 与既有口径一致（错误串截 120/160 字符；stderr 不含凭据回显的新增面） |
| 依赖变更 | 无（仅 node:child_process 内置 spawnSync） |

## 6 测试覆盖

| 新增行为 | 是否有对应测试 | 备注 |
|---|---|---|
| claim 网络异常分类（claim_error 不掀轮） | ✅ 5u② | 断言 exit 1 + 事件 + 无 uncaught |
| 孤儿认领观测（orphan_claim 不抢占） | ✅ 5u① | 真实认领→删本地 ack→复跑 |
| **释放失败不动本地账** | ❌ **零断言** | 5u 标题声称覆盖；🔴#1/#2 因此漏网（🟡#2） |
| alreadyGone 判据 | ❌ | 无"服务端拒绝删除"形态用例（🔴#3） |
| SIGTERM 清锁退出 | ✅ 5v | 挂起 /user→SIGTERM→快退+锁清 |
| 健康告警（阈值/落账/重置） | ✅ 5w | 阈值 2 三段断言，可证伪 |
| 轮次历史（Draft 保留/真终态清） | ✅ 5x | 四相序断言 rounds=1→保留→2→清 |
| 剖面 B 硬死/uncaught 计分 | ❌ | 🔴#4 的缺口，无测试亦无实现 |

## 7 结论

- 🔴 数量：**4**（正确性层：#1 三态判定失效+#2 TDZ+#3 判据误报；要求符合性：#4 健康记分覆盖）
- 🟡 已全部表态：是（修×3、延后×1）
- 建议：**request changes**——四件套里①（释放三态）核心链路实测不成立，②③④ 成立但②有覆盖缺口。#1+#2 是"两错互锁"，修任一都必须同批修另一并补 5u 失败路径断言（🟡#2），否则修复本身会当场爆 ReferenceError。

## 8 审阅范围与未验证

- 已核：六文件 diff 全文 + task-loop.mjs/claim.mjs 上下游全文；套件真跑 129 通过；`npm run doctor`（H8）；/tmp 裸仓四组实验（不存在 ref / denyDeletes / pre-receive 拒绝 / 远端不可达，git 2.50.1）；state.json 变更关联（--type change --related task-loop --baseline a471a41）合规。
- 未验证：①「变异四件各 1 红」——工作区无变异产物（`.ai/verify/PS1-4.log` 均为普通套件跑），按未核实处理；②真实 GitLab/GitHub 删除拒绝文案——无实例凭据，以 pre-receive 钩子代表"服务端可控文案"类别，git 自带 denyDeletes 文案已实测不误判；③osascript 无 GUI 实机行为——按 Node spawnSync 语义（非零退出/ENOENT 不抛）+ 代码阅读判定，未在 SSH 无 GUI 会话实测。

---

## 9 二审（2026-11-19，一审修复验收 + 新发现）

> 审者：code-reviewer 二审（独立核对）· 基线不变（`a471a41`…工作区六文件 + `.ai/tasks/p0-stability/`）
> skill：`resolve-skills --diff` 复跑，命中同前（harness v1.1.0 + deployment v1.0.0），Stage 0 复核通过。
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。

### 9.1 一审处置逐条验收

| 一审项 | 修复后位置 | 验收 | 证据（本轮实测/核对） |
|---|---|---|---|
| 🔴#1 releaseEx 嵌套 | `claim.mjs:96` 直接 `return failed_safe(e, err);` | ✅ | /tmp 嵌套变异（复原一审形态）→ **恰好 5u-bis 1 红**（r2 exit 0≠1）；`release()` 布尔恢复（失败→false），:271/:693/:863 调用点语义复位 |
| 🔴#2 blocked TDZ | `task-loop.mjs:170` 声明上移至 stats 旁；sweep 使用点 :517/:554/:576 均在其后 | ✅ | /tmp TDZ 变异（声明挪回 sweep 后）→ **恰好 5u-bis 1 红**；钉内含 `!/ReferenceError/` 断言 |
| 🔴#3 alreadyGone 判据 | `claim.mjs:96` catch 一律 `failed_safe`（不再 regex 服务端文案）；alreadyGone 态整体移除 | ✅ | grep 全仓**无 alreadyGone 调用点**（仅注释/文档残留，见 🟡#2′）；边界实测（git 2.50.1 本地 bare）：删不存在的 ref = `remote: warning: deleting a non-existent ref` + **exit 0** → 走 deleted 正常关账——「远端已被清但本地有账」不构成永久重试 |
| 🔴#4 markHealth 记分面 | die :55 / SIGTERM :281 / uncaught :290 已接 | ⚠️ 部分 | die/uncaught/SIGTERM 记分在场；但**启动早期两个 die(1) 点（:68 坏凭据文件、:109 loadRules 失败）早于 `taskLoopCfg` 声明（:118）**，实测抛 ReferenceError、健康分落不上 → 见 🔴#1′ |
| 🟡#1 stale 分支 | `task-loop.mjs:573-580` releaseEx 化：failed → release_failed(where=stale)+blocked+保留 ack | ✅ | 代码核对；与关账分支同机制 |
| 🟡#2 5u 零断言 | `test:1612-1664` 5u-bis | ✅ | 七件断言（r1=0 / r2=1 / ack 仍在 / release_failed+close 落账 / 无 trigger_gone / 「本地账保留」文案 / 无 ReferenceError）；双变异各 1 红（本轮 /tmp 实测）；套件 129→130 本轮真跑通过 |
| 🟡#3 SIGTERM 无条件删锁 | `task-loop.mjs:282` `if (roundLockOwned)`；锁未取得路径 exit 0 不动锁 | ✅ | 代码核对；5v 绿 |
| 🟡#4 历史认领前落盘 | CI 路径 :729 仅内存更新，ack 落盘后 :778/:805 统一 `writeRoundsHistory`；关账清历史 :565 保留 | ✅ | 代码核对：归因中途中断不再虚增历史 |
| 附加：零触发早退计入 blocked | `task-loop.mjs:588-589` `code: blocked>0 \|\| softFail ? 1 : 0` | ✅ | 5u-bis r2（零触发+blocked）exit 1 实测 |

另核：PS1-4 日志已带 verify-run 标准头重跑（03:30Z，130 通过 0 失败）；`# commit: unknown` 为 `verify-run.sh:76` 注释明示的 agent 工作流预期形态，非缺陷。

### 9.2 新发现

**🔴#1′（正确性/要求符合性，阻断）die() 的健康记分在启动早期抛 ReferenceError——「typeof 守卫防启动早期」被实测证伪**

- 位置：`task-loop.mjs:55`（die 调 markHealth）→ `:184`（markHealth 读 `taskLoopCfg.healthAlertTicks`）；`taskLoopCfg` 为 const、声明于 `:118`——**晚于**两个早期 die(1) 点（`:68` 凭据文件无法解析、`:109` loadRules 失败）。
- 实测（本机 node v24.20.0）：`HARNESS_ENV_FILE=<含非法行的文件> node scripts/task-loop.mjs --once` → die 消息双通道打出后 `ReferenceError: Cannot access 'taskLoopCfg' before initialization`（栈 `:184 ← die:55 ← :68`），模块顶层崩溃。
- 影响：①本应干净 die(1) 的启动死变成 uncaught 崩溃（exit 码碰巧仍 1，定时器日志多一段误导栈）；②health.json 的写在 markHealth 尾部，中途抛出＝该次失败**不落账**——RS US-1 验收行对「每拍启动死」类故障（恰是 🔴#4 点名的第四类死亡）仍不触发 loop_degraded；③`typeof markHealth === 'function'` 守卫无效：markHealth 是函数声明，模块实例化即提升，typeof 恒真，守卫永不拦截。
- 修复方向：die 侧与 SIGTERM 处理器（:281 已是 `try { markHealth… } catch {}`）对齐止崩；markHealth 内 ticks 计算容错（try 包住/与 taskLoopCfg 解耦，默认 10 兜底）才能让 :68/:109 的死也计分；补一条「坏 env 文件 → exit 1 且无 ReferenceError」断言。

**🟡#2′（可维护性）alreadyGone 幽灵态残留文档：实现两态、文档三态**

- 位置：`claim.mjs:79-81`（JSDoc「三态返回…alreadyGone」）、`:102`（release() 注释）、FS §4.4（:68）。
- 问题：releaseEx 只产 deleted/failed；「远端本就没有 ref」实测走 deleted（warning+exit0）。读者会去找不存在的 alreadyGone 处理分支。
- 建议：文档改两态 + 一行注明「不存在 ref 的删除＝git warning+exit0 → deleted（git 2.50.1 实测）；服务端拒绝/不可达一律 failed」。

**🟡#3′（健康口径）剖面 A 硬失败一拍双记分**

- 位置：`task-loop.mjs:384` `markHealth(false, '剖面 A 硬失败…'); die(1, …)`——die(:55) 再记一次，同拍 noSuccessStreak +2。
- 影响：401/403 类硬故障下 healthAlertTicks=10 实际约 5 拍告警，与 RS「连续 N 拍」口径漂移；显式调用在 die 统一记分后已成冗余。
- 建议：去掉 :384 显式调用（why 并入 die 消息），或改 RS 措辞为「失败信号数」。

仅记录：
- `state.json` stage_history.review 预写「两轮…二审见 CR 文件」且 gate=pass——写于二审实际发生前；本二审为 request changes，review 关应回 open（流程观察，父 agent 收口时核对）。
- blocked>0 且无 softFail 的轮 stamp=true：健康按成功重置（claims 单点长故障对 loop_degraded 不可见——一审已记录接受，claim_error/release_failed 事件可查）；释放失败重试等节拍（默认 1800s）而非下一心跳，方向保守，TTL 24h 内无损。
- `task_failed` 分支 held.delete 无条件（:865）vs `feishu_ack_failed` 条件删（:694）：失败时前者不留给 exit 钩子重试；行为等价（TTL 兜底+事件落账），口径不一。
- sweep stale 分支 `released: relStale.status !== 'failed'`（:581）在 failed 已 continue 后恒真——冗余条件，无害。
- 一审 §5 的 osascript `h.noSuccessStreak` 强转建议未采纳（`(h.noSuccessStreak || 0) + 1` 对字符串值是拼接）——风险面不变（前提＝攻击者可写本仓文件、同用户无提权），维持低危，可随 #1′ 一批处理。

### 9.3 跨模块 / 安全 / 测试 / 门禁

- 调用面：releaseEx 全部调用点（:515/:552/:573）failed→保留+release_failed+blocked；release() 布尔点（:271/:693/:863）语义复位；hooks/ 无 claim.mjs 引用（grep 空）。
- 测试：**130 通过 0 失败（本轮真跑）**；嵌套变异→1 红、TDZ 变异→1 红（/tmp 实测）。
- 门禁：H1 ✅（scripts+test 同批）；H2 ✅（check:agents 68 文件一致 / check:hooks 一致，真跑）；H8 ✅（doctor 通过，3 提醒）；H9 ✅（5u-bis 可证伪+双变异红）。

### 9.4 结论

- 🔴 数量：**1**（#1′：die 早期记分 TDZ——🔴#4 处置的直接残留，实测可触发）
- 🟡：2（#2′ 文档两态化、#3′ 双记分口径），仅记录 5
- 建议：**request changes**——一审四 🔴 四 🟡 代码处置全部验收通过（含双变异实证），但 #4 处置中「typeof 守卫防启动早期」被实测证伪且引入早期崩溃形态；修法明确量小（die 包 try + ticks 容错 + 一条断言），连同 #2′/#3′ 修后可直接终审。

### 9.5 二审范围与未覆盖

- 已核：六文件当前版全文与关键区段；套件真跑 130；嵌套/TDZ 双变异 /tmp 实证；坏 env 文件早期 die 实证；git 2.50.1 删不存在 ref 实证；H1/H2/H8/H9 真跑；PS1-4 日志头与计数；state.json/RS/FS/rules diff。
- 未验证：①真实 GitLab/GitHub 服务端对「删不存在 ref」的行为（无实例凭据）——以本地 receive-pack 的 warning+exit0 为判据，若某托管回错误则该场景落 failed→按节拍重试（保守方向、无数据损坏）；②一审时代声称的 claim/sigterm/health/hist 四件变异未复跑（本轮只复验嵌套/TDZ 两件，其余以 130 绿 + 一审记录为准）；③launchd/systemd 真定时器下的信号交付形态（5v 以子进程 SIGTERM 代表）。

---

## 10 三审（2026-11-19，终审——二审处置验收）

> 审者：code-reviewer 三审（独立核对）· 基线不变（`a471a41`…工作区 + `.ai/tasks/p0-stability/`）
> skill：`resolve-skills --diff` 复跑，命中同前（harness v1.1.0 + deployment v1.0.0），Stage 0 复核通过。
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。

### 10.1 二审处置逐条验收

| 二审项 | 修复后位置 | 验收 | 证据（本轮独立实测/核对） |
|---|---|---|---|
| 🔴#1′ die 早期记分 TDZ | `task-loop.mjs:57`（die 内 try 包裹 markHealth，usage 64 豁免保留）+ `:187`（ticks 计算 try——`taskLoopCfg?.healthAlertTicks` 的 TDZ 被吞后走默认 10，记分继续落盘） | ✅ | 独立实测两个早期 die 点（`--root` 指向 /tmp 隔离目录，不污染工作区 health.json）：坏凭据文件（`:70`）与 loadRules 失败（`:111`）均 **exit 1 + die 双通道同文 + 无 ReferenceError + health.json 落账 `noSuccessStreak:1`**；recordEvent 为模块 import（`:26`）且 ledger.mjs:51 自带 try——告警拍（streak≥10）在早期 die 亦无抛出面 |
| 🟡#2′ alreadyGone 文档两态化 | `claim.mjs:79-83`（JSDoc 两态 + git 2.50 warning/exit0→deleted 注记）✅；FS §4.4（`:68` 两态口径）✅；`claim.mjs:101`（release() 注释）❌ | ⚠️ 2/3 | `:101` 仍写「deleted/alreadyGone 都算释放到位」——实现 `:103` 为 `.status !== 'failed'`，只产两态。零行为影响，残留见 10.2#1 |
| 🟡#3′ 剖面 A 双记 | `task-loop.mjs:387` 显式 markHealth 已删，die 统一记分，注释标明「双记致阈值减半」 | ✅ | markHealth 调用点全集核对（`:57` die / `:218` finish / `:284` SIGTERM / `:293` uncaught）：剖面 A 硬失败路径无残留显式调用；`:218` 是 finish 软失败记分（不经 die），保留正确 |
| 套件 | `bash test/task-loop.test.sh` | ✅ | 本轮真跑（verify-run 包装，`.ai/verify/p0-stability.log` 标准头齐）：**130 通过 0 失败** |

### 10.2 三审发现

**🟡#1（可维护性）🟡#2′ 处置漏一处：claim.mjs:101 release() 注释仍含 alreadyGone**

- 位置：`scripts/lib/claim.mjs:101`；对照二审 🟡#2′ 点名三处（JSDoc ✅ / release() 注释 ❌ / FS §4.4 ✅）。
- 影响：零行为影响（`:103` 实现两态语义正确）；读者按注释 grep alreadyGone 会去找不存在的状态分支——二审点名的「幽灵态」残留。
- 建议：改一行注释为「deleted 算释放到位（两态，见 releaseEx）」，同批顺手闭合。

**🟡#2（可测试性）早期 die 记分无回归钉：删掉 die 的 try，现有 130 条不会红**

- 位置：`test/task-loop.test.sh` 10i（~:2150-2158）；`task-loop.mjs:57`。
- 问题：10i 断言「坏 env → exit 1」，但 TDZ 崩溃形态 exit 码碰巧也是 1（二审 §9.2 实测）——「去掉 :57 的 try」变异在现有套件下全绿；5u-bis `:1658` 的 `!/ReferenceError/` 只覆盖 sweep 路径。二审修复方向明说「补一条断言」，本轮以人工实测代替——实测证明当下，不防退化。
- 建议：10i 补两行：`! grep -q ReferenceError` 于输出 + health.json `noSuccessStreak===1`。

仅记录：
- uncaught 处理器 `:293` markHealth 裸调无 try（die `:57` / SIGTERM `:284` 均有 try）：运行期 taskLoopCfg 已初始化、markHealth 内部 IO 全 try、recordEvent 自带 try（ledger.mjs:51），无抛出面；风格不一，无害。
- 边界确认（任务指派项）：die 的 try 会兼吞 markHealth 写盘 IO 失败——**接受**。markHealth 内部写盘本有 try，外层为双保险；语义 = 记分尽力而为、不改变退出码，与「记分不阻断退出」设计意图一致。
- state.json `stage_history.review` gate=pass 仍为预写形态（二审已记录）；三审 approve 后与事实一致，人最终不批则以人为准。
- 一审 §5 osascript `h.noSuccessStreak` 强转建议仍未采纳，风险面不变（低危，前提 = 攻击者可写本仓文件、同用户无提权）。

### 10.3 结论

- 🔴 数量：**0**；🟡：2（均非阻断：注释残留一行、回归钉缺两行）；仅记录 4。
- 建议：**approve**——二审 🔴#1′ 修复经本轮独立实测闭合（两个早期 die 点：exit 1 + 无 ReferenceError + 记分落账），🟡#2′/#3′ 主体闭合；130 全绿本轮真跑（verify-run 入库）。两项 🟡 建议同批顺手闭合后提交。approve 权在人。

### 10.4 三审范围与未覆盖

- 已核：die/markHealth/剖面 A/SIGTERM/uncaught 调用点全集（读码）；两个早期 die 点独立实测（--root 隔离）；alreadyGone 全仓 grep（代码+文档，命中仅 claim.mjs:90-93 设计注释与 :101 残留）；FS §4.4 两态口径；套件真跑 130（verify-run 包装）；resolve-skills --diff 复跑（harness + deployment）。
- 未重跑：四件主变异（claim/sigterm/health/hist）按三审指令不复跑——一审已验、二审承接（嵌套/TDZ 二审已复验各 1 红），以一审记录 + 本轮 130 绿为准。真实 GitLab/GitHub 删除拒绝文案、launchd/systemd 信号交付形态维持二审未验证口径。
