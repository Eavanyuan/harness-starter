# 架构体检 C 路：性能瓶颈审计

- 审计对象：task-loop 轮询链（scripts/task-loop.mjs + scripts/lib/gitlab-triggers.mjs + claim.mjs + ci-failures.mjs）、观测/证据面（账本与日志）、测试面（gate）。
- 审计日期：2026-11-19。方法：代码推导调用模型 + 真实运行数据实测（378 轮 task-loop.out 耗时行、用户级 events.jsonl 1768 条、45 份历史 gate 日志头、目录实测 du/ls）。未跑 /tmp 假服务（真实日志已足以定标单位成本）；未读任何凭据文件（task-loop.env 按规矩不碰）。
- 分层口径：🔴 = 随规模（MR 数/天数/套件数）恶化且当前无上限机制；🟡 = 当前已可观的实测浪费；🟢 = 核过、量级可接受。

## 结论（Top 5）

| # | 档 | 发现 | 量化 | 拐点 |
|---|---|---|---|---|
| 1 | 🔴 | 轮询 O(N) 串行 API 扇出，无增量无缓存 | 当前 ~10 次 GitLab 调用/轮（4 非 Draft + 4 Draft）实测 5.2-7.0s；30 MR→62 次≈28s；100 MR→202 次≈91s | 100 条=正确性崖（列表截断） |
| 2 | 🔴 | gate 全量串行且随套件数线性增长 | 10-30 实测 45-81s → 11-19 实测 115s（33 步串行、27 套件）；套件增速 ~5/周 | +17s/周，~13 周（约 2027-02）破 5min/关账 |
| 3 | 🔴 | 观测/证据面全部无轮转无清理无上限 | traces 关账不删（实测 408K/2MR）；out/err/events 无轮转（912KB/4.5 天）；.ai/verify 155 份 1.3M 全部入 git | 日常态 ~50KB、风暴日 ~300KB+；无任何上限 |
| 4 | 🟡 | 软失败零退避重试风暴 | 333/378 轮（88%）为 gitlab 软失败；断连时 19 轮/小时 × 11s（Nov 16 连续 9h 实测） | GitLab 断连即触发，日烧 ~40 分钟空转 |
| 5 | 🟡 | 认领竞争每轮 3 次 git 网络往返/触发 | push 拒→ls-remote→fetch --depth=1；实测每条已认领触发 +3.3s/轮 | 5 条并发修复 → +15s/轮、~345 git 网络操作/天 |

---

## 🔴 会随规模恶化

### 1. task-loop 轮询：O(N) 串行 API 扇出，每轮全量重拉

**位置**：`scripts/lib/gitlab-triggers.mjs` fetchTriggers 主循环（`for (const mr of mrs)` 内逐条 `await api(...)`），`scripts/task-loop.mjs` 轮询段。

**调用模型（代码推导，非作者自述）**：每轮 GitLab 调用数 =
- 2 固定：`GET /user`（identity=token 实测确认每轮必调，run-round.sh 未注入 GITLAB_USERNAME）+ `GET /merge_requests?...per_page=100`；
- 每条非 Draft MR：1 × `discussions`；
- 其中无评审信号的再 +1 × 详情（CI 在场判据）；有评审信号的 +1 × commit + 0..1 × approvals；
- CI 命中再加 ≤13：jobs(1) + trace(≤5) + 基线流水(1) + 基线 jobs/traces(≤6)（`scripts/lib/ci-failures.mjs:102-143`），trace 端点下的是**全量日志**（实测落盘 48-101KB/份）。

**当前实测**：近轮 4 条 Draft 跳过 + 4 条非 Draft → 1+1+4×2 = **10 次 GitLab 调用** + 飞书 2（connect + 1 MQL）。触发 0 的轮次实测耗时 5.2-7.0s（378 轮采样），扣除 node 启动与飞书段，串行单位成本 ≈ **400-500ms/调用**（内网 RTT 定标，与耗时行互证：触发 2/跳过 2 的 12.6s 轮 = 10 调用 + 2×认领竞争 ≈ 12.9s，吻合）。

**增长推算**（线性，同单位成本）：

| open MR（非 Draft） | 调用/轮 | 轮耗时 | 日调用量（1800s 节拍 × 23 轮/工作窗） |
|---|---|---|---|
| 4（现在） | 10 | 5-7s | ~230 |
| 30 | 62 | ≈28s | ~1,430 |
| 100 | 202 | ≈91s | ~4,650 |

**100 是双重点**：`per_page=100` 无翻页——恰好 100 条即列表截断，最老的 MR 被挤出 sweep 视角 → 误关账（代码注释自认，KI-3 登记，gitlab-triggers.mjs:186 附近）。即性能问题到 100 条时同时变成正确性问题。

**修复方向**（点到为止）：列表 `updated_after` 增量过滤 / 详情调用按轮去重（无新讨论则跳过）/ discussions 请求并发化（Promise.all，RTT 不变时轮耗时可降 ~N 倍）/ 逼近 100 时关账前单查复核。

### 2. gate：33 步全量串行，随套件数线性增长，每次关账必跑

**位置**：`package.json` `gate` 脚本（doctor→architect→check:*→verify:state→27 个 test:*，`&&` 串行）。

**实测趋势**（45 份 `# cmd: npm run gate` 日志头，start/finish 差）：
- 2026-10-30：45-81s（当时套件 ~5-8 个）
- 2026-11-07~11：54-190s
- 2026-11-19（CLOSE-GATE-perf-early，01:42:53→01:44:48Z）：**115s**

套件增速：`git log --diff-filter=A test/*.test.sh` → 3 周 +15 个（≈5/周）。斜率 ≈ +3.5s/套件 ≈ **+17s/周**。

**为什么是放大器**：S 档收尾折叠也免不了全量 gate（test/hooks.test.sh #41 断言"gate 全量日志免不了"；.ai/verify 里 38 份 CLOSE-GATE-*.log 是每任务一份的实证）。任务侧每天 ~2 任务关账 → gate 机器时间 2×115s/天，且随周线性上涨。

**任务给的"10.4 秒"核不上**：45 份 gate 日志最小 40s、最新 115s，无一份 ≤11s。10.4s 若存在只能是单套件/doctor 口径，不能当全 gate 数字引用。

**次要**：test/perf-checks 一套 17s（PE1 实测 01:39:52→01:40:09），其中 ~16s 是基线比对用 `sleep 4` × 4——测试睡眠占 gate 14%；task-loop.test.sh 2053 行（全部 8598 行的 24%）是最大单套件。

**修复方向**：套件按文件并行（bats/npm-run-all -p）或拆 gate 快慢档（提交门禁跑快档，关账跑全量）；sleep 改注入时钟。

### 3. 观测/证据面：全部无轮转、无清理、无上限

同根因一组（写入面各有归属，共同点是没有一条删除路径）：

- **traces/ 关账不清理**：sweep 关账只 `rmSync` ack 与 pack（task-loop.mjs sweep 段两处），`traces/<id>/` 无任何删除代码。实测 `.ai/task-loop/traces/`：MR 1847、1896 两个 11-17 的目录至今留存，**408K**（每 CI-opaque MR ~200KB）。round-\*.md / todo-\*.json 同类：每修复轮一份、关账不删，4 个 MR 已积 14 份。
- **用户级无轮转**：`~/.harness/task-loop/` events.jsonl 287KB + task-loop.out 384KB + task-loop.err 244KB = 912KB/4.5 天；launchd/systemd 模板均无日志轮转接线。常态 ~25KB/天（23 轮 × ~1KB），风暴日 ~330KB/天（见 🟡#4）。
- **repo 账本**：`.ai/ledger/deny.jsonl` 465KB/1386 条（10-30 起 20 天，~69 条/天），未入 git（git ls-files=0，符合"本地观测"设计），但同样无清理。
- **`.ai/verify` 永久入库**：155 份 1.3M **全部在 git 里**（`git ls-files .ai/verify` = 155）。每次关账 +8-19KB 且进历史。当前 ~18KB/天 → 年 ~6.5MB + 历史膨胀（clone/checkout 变慢是全组人付）。

**拐点**：单看磁盘半年内不痛（年 ~20-50MB 级）；痛的是三点——traces/verify 属"证据链设计内"但**无任何保留期语义**（不会自动停）；git 历史膨胀不可逆（后补清理删不掉历史里的 1.3M）；风暴日速率是常态 6 倍且无人设定告警线。

**修复方向**：traces/round/todo 关账统一并入 sweep 清理；verify 按 task 封存（archive 归档出 git 或定期 squash）；logs 接 newsyslog/logrotate。

---

## 🟡 当前已可观

### 4. 软失败零退避：断连即 19 轮/小时重试风暴

**位置**：task-loop.mjs 软失败路径（"临时不可达……不落节流戳，下一 tick 立即重试"——有意设计，但无退避上限）+ install-task-loop.sh 心跳默认 180s（INTERVAL=180，真实节拍 pollSeconds=1800 只约束**成功**轮）。

**实测**：用户级 events.jsonl 中 gitlab source_soft_fail 333 次 / 378 轮（88%）。Nov 16 15:00-23:00 连续 9 个小时每小时 19 次软失败（=每 189s 一轮，即每个心跳都重试）；每轮 `/user` 10s 超时（AbortSignal.timeout(10_000)）+ 飞书照常轮询 → 轮耗时实测 11.0-11.2s。代价：**~209s/小时空转、~40 分钟/断连日**，当日日志/事件增长 666-952 条（Nov 16/17 实测，为全部 1768 条的大头）。

**修复方向**：软失败也落节流戳（或按连续失败次数指数退避：19/h→6/h→2/h），源恢复后首拍即跑不受影响。

### 5. 认领竞争：每轮每条已认领触发 3 次 git 网络往返

**位置**：`scripts/lib/claim.mjs` claim 失败路径：push（被拒）→ ls-remote → `fetch --depth=1`（同一条 claim ref 每 30 分钟重复取）。

**实测**：触发 0 轮 5.2s vs 触发 1/跳过 1 轮 8.5s → **+3.3s/条**（3 次 git 网络操作 + rejected push）。events 中 claim_skip 21 次。5 条并发修复时：+15s/轮、~345 git 网络操作/天，全部花在"确认别人还持有"上。

**修复方向**：认领在途状态本地缓存（ack 存在且 fingerprint 未变 → 跳过 claim 尝试，直接判 skip）；或 ls-remote 批量（一次查全部 claims/*）。

---

## 🟢 可接受（核过）

- **飞书剖面 B**：每轮 1 次 connect + 1 次 MQL（单类型 Defect）+ 触发时 1-2 次；391 轮 profile_b_polled 无异常放量。
- **activeHours**：窗口外毫秒级退出（当前 09:30-21:00），夜间零 API 零轮询。
- **并发/进程面**（按任务指示略查）：单机单进程 + 轮次排他文件锁（30min 孤儿接管）+ CAS 认领互斥；每轮进程退出，无跨轮内存累积。
- **verify:state / doctor 等检查步骤**：PE4 实测 5s，轻量。
- **当前 MR 规模**：4 非 Draft + 4 Draft，距 100 截断顶远；Draft 短路发生在 discussions 调用之前（零额外成本，设计对）。

---

## 必查面逐项回答

| # | 必查面 | 回答 | 证据 |
|---|---|---|---|
| ① | 每轮 API 调用数 | 当前 **10 次 GitLab + 2 次飞书**/轮（4 非 Draft：user+list+4×discussions+4×detail）；30 MR→62；100 MR→202 且撞 per_page=100 截断 | gitlab-triggers.mjs 调用点计数 + 378 轮耗时定标（400-500ms/串行调用）+ identity=token 确认 /user 每轮必调 |
| ② | 无界增长面 | events 287KB/out 384KB/err 244KB（4.5 天）无轮转✓；repo deny.jsonl 465KB 无清理✓；.ai/verify 155 份 1.3M 全部入 git✓。**deny.jsonl "只写不读"不成立**：`scripts/ledger-report.mjs:49` 读它（`npm run ledger:report`，guides 多处引用；docs/plans P3-11 明确修过此缺口）——残留问题只是读取端纯手工，gate/CI 无自动消费（仅记录） | du/ls + git ls-files + grep deny.jsonl |
| ③ | traces 关账清理 | **不清理**。sweep 只删 ack-\<id\>.json 与 pack-\<id\>.md；traces/\<id\>/ 无删除路径，实测 1847/1896 两目录 408K 留存 2 天 | task-loop.mjs sweep 段 + ls .ai/task-loop/traces/ |
| ④ | 测试面 | 全 gate 实测 **115s**（11-19 CLOSE-GATE-perf-early），45 份历史日志 40-190s；"10.4s"无任何 gate 日志支撑。gate 确实串行跑全部 33 步（package.json 链 + 日志尾部 perf-checks 收尾为证）。task-loop.test.sh 2053 行为最大套件；perf-checks 17s 中 ~16s 是测试 sleep | .ai/verify/*.log 头部时间戳 + wc -l |
| ⑤ | git 操作频率 | 成功认领 1 push；**竞争认领每轮 3 次网络往返**（push 拒+ls-remote+fetch --depth=1，+3.3s/条实测）；释放 1 push。fetch 策略本身克己（--depth=1 单提交），问题是每轮对同批 ref 重复 | claim.mjs:44-80 + 耗时行差分 |
| ⑥ | 内存/进程 | 略（按任务指示）。未见风险形态：每轮独立进程退出，锁有孤儿接管 | task-loop.mjs 轮次锁段 |

## 增长拐点估算（何时会痛）

| 维度 | 拐点 | 推算依据 |
|---|---|---|
| open MR 数 | **~30 条**：轮询 28s/轮（现在 4.7 倍），日 API 1,400+ 次 | 线性：2+2N 次调用 × 450ms |
| open MR 数 | **100 条**：91s/轮 + 列表截断致 sweep 误关账（正确性崖，先于性能痛） | per_page=100 无翻页（代码 KI-3 自认） |
| 周数 | **~13 周（约 2027-02）**：gate >5min/次关账；26 周破 10min | +17s/周（套件 5/周 × 3.5s/套件） |
| 天数 | 日志/账本常态 ~50KB/天 → 年 ~18MB/机器；**风暴日 ×6**（~300KB+/天） | Nov 16-17 实测 |
| 小时 | **GitLab 断连即生效**：19 轮/h × 11s 空转 + ~14KB/h 日志 | Nov 16 连续 9h 实测 |
| CI-opaque 频率 | 每 CI-opaque MR ~200KB traces 永留；按 2 条/周 → 年 ~20MB | 2 MR = 408K 实测 |

## 审计范围与未覆盖

- 核对过的主张：①-⑥ 全部（上表）；所有数字来自当轮实测（du/ls/wc、events.jsonl 1768 条解析、378 轮耗时行、45 份 gate 日志头、git ls-files/log）或代码行级推导，二者互相印证处已标注。
- 未覆盖：/tmp 假服务压测（真实日志已定标，未重复造）；GitLab 服务端限流阈值（内网自建实例无公开配额，未断言）；内存/进程深查（任务明示可略）；`npm run gate` 本轮未复跑（用 11-19 当天日志 115s 为准，建议复跑命令：`time npm run gate`）。
- 证据文件（可原地复核）：`~/.harness/task-loop/{events.jsonl,task-loop.out}`、`.ai/verify/CLOSE-GATE-*.log`、`.ai/task-loop/traces/`、`scripts/lib/{gitlab-triggers,claim,ci-failures}.mjs`、`package.json` gate。
