# WBS-本地任务循环执行器（task-loop）

> 产出：`feature-decomposer` · 落盘 `docs/02-features/task-loop/task-loop.wbs.md`　｜　验收标准见 `docs/01-requirements/RS-task-loop.md`　｜　裁决依据 `docs/06-reference/adr/ADR-010-task-loop.md`
>
> 本文件于 2026-11-10 按模板补齐结构（原版只有一张扁平表，缺拆分树/依赖拓扑/验证收口/不作数四节）。
> 补齐的契机是账本从 `fs_review` 推进到 `impl`——账本一动，`ci-verify` 的完备性检查才开始判它，
> 于是"这份 WBS 不符合模板"这件事第一次变成红灯。补结构不改事实：T0–T6 的范围与估时与原版一致。

## 1 拆分树

| id | 栈 | 任务 | 验收标准 | spec_ref | depends_on | 风险级 | required_skills | 估时（天） |
|---|---|---|---|---|---|---|---|---|
| T0 | harness | 仓库税：本任务 RS/ADR/WBS/FS 自身过门，并让"账实一致"变成会红的判据 | `test/task-loop-contract.test.sh` 5/5，且 stage 退回产出阶段时变红 | `fs#§4.1@499e35f` | — | LOW | harness | 0.5 |
| T1 | harness | 追溯门禁：`--related feishu:<id>` + `EXT-<id>` 行 + `meta.remote_id` 双向锚 + 模板与套件 | `init.test.sh` 29/29；把 `remote_id.source` 伪造成 `jira` 时变红 | `fs#§4.2@499e35f` | — | MEDIUM | harness | 1 |
| T2 | harness | 订阅三档投递 + broker 评估器 + aging 巡检 + digest 模板 + 批准下限 | `notify-broker.test.sh` 70/70；摘掉 `mustAct` 下限时变红 | `fs#§4.3@499e35f` | — | MEDIUM | harness | 3.5 |
| T3 | harness | runner 核心：双剖面触发 + git CAS 认领（`heads/claims`）+ TTL + `runtime.headless`（hook 必接线）+ pause/resume + 预算（D7）+ kill switch + 停点三条件 + 认领释放配对 | `task-loop.test.sh` 39/39，含假 GitLab 真触发端到端与"认领后异常必释放"；拿掉 `createBudget` 或反转触发判定时变红 | `fs#§4.4@499e35f` | T1 | HIGH | harness | 4.5 |
| T4a | harness | 失败指纹归一化（剥参/剥色/全角/截断）+ merge-base 基线实跑 + 集合差 | `task-loop.test.sh` 形态层与端到端层全过：引入=B、继承=A，参数随机化下身份稳定 | `fs#§4.5@499e35f` | — | MEDIUM | harness | 1.2 |
| T4b | harness | 三分流决策 + 豁免三道闸 + MR 附证 | 五形态 + 过期/指纹不同/豁免率 60% 告警 + 7% 不误报 + 分母缺失不猜；退回恒等 1 的"率"时变红 | `fs#§4.6@499e35f` | T4a | MEDIUM | harness | 1.2 |
| T5 | harness | 剖面 A 影子周（零写入可证 + 触发/漏触发双列，N≥30）→ 单任务 → 小批；共用件：会话打包器 / CI 盯梢 / launchd+systemd 定时器 | 打包与产物 fail-closed、CI 盯梢终态与超时两态、安装器 `--print` 无残留占位符、无接线仓库 `exit 69`、影子周去重统计 | `fs#§4.7@499e35f` | T3 | HIGH | harness | 3 |
| T6 | harness | 剖面 B：飞书事件源（权限未批走降级形态）+ 接单三连 + 回写读回 + doctor 前提在场性 | MQL 实测契约（两段式表名 / `current_status_operator` / 状态英文 label）/ 真实 `moql_field_list` 形态解析（取 label 不取 key）/ 严重级三套词汇归一（P 档 + 高/中/低 + 英文）/ 空间身份配置化到 `runtime.feishu`（零环境变量可跑，doctor 校验必填与词表值域）/ 同步四路（拒硬转、读回成功、静默丢弃→评论兜底、兜底失败显式红）；`feishu-bug-source.test.sh` 41/41，把指派字段改回 `owner`、状态改回中文"待处理"、严重级 key 配错三处变异均变红 | `fs#§4.8@499e35f` | T3 | MEDIUM | harness | 4 |
| V1 | harness | 统一验证：本需求新增/改动的套件一起跑（全量门禁由 CI 承担） | `task-loop 39 + 契约 5 + doctor-gates 12 + init 29 + feishu-oauth 15 + feishu-bug-source 41` 全过；全量 `npm run gate` exit 0 | `fs#§4.1@499e35f` | T0 T1 T2 T3 T4a T4b T5 T6 | — | harness | — |

> `spec_ref` 的格式是 `fs#§<小节>@<blob7>`：小节指回 FS 的详细设计，blob7 是 FS 定稿那一刻的
> `git hash-object` 前 7 位。它回答的是「这条任务拆的是哪一版设计」。
>
> 为什么要这一列：任务与设计之间正常的失联方式是**没人发现**。FS 改过而 WBS 没回填，
> 任务指向的小节就不存在了（悬空任务，做出来没人要）；反过来 FS 写了却没任务，就是漏做，
> 交付前一周才发现。两个方向都只有把引用写成机器可读的，才判得出来。

## 2 依赖拓扑

```text
T0 ─────────────────────────────────────────┐
T1 ──→ T3 ──→ V1 ←───────────────────────────┤
        ├──→ T5 ──────────────────────────────┤
        └──→ T6 ──────────────────────────────┤
T2 ──────────────────────────────────────────┤
T4a ──→ T4b ─────────────────────────────────┘
```

> 无环是硬要求。出现环说明拆分粒度错了，回到 RS 重新看边界。
> T3 依赖 T1 的理由：runner 建档要过追溯门禁（`remote_id` 锚），否则剖面 B 接单落不了账。
> T5/T6 依赖 T3 的理由：两者都消费 runner 的认领与账本，runner 的接线断点会直接变成它们的假绿。

## 3 统一验证收口

| 栈 | 验证 TODO | 覆盖范围 | 命令 |
|---|---|---|---|
| harness | V1 | 本需求新增与改动的套件 | `bash test/task-loop.test.sh && bash test/task-loop-contract.test.sh && bash test/doctor-gates.test.sh && bash test/init.test.sh` |

> 单个实现 TODO 不自己跑全量：跑到哪一步、绿了几条，写进该 TODO 的 `audit.tests`；
> 全量归 V1，否则每人各跑一遍全量，既慢又会出现"我这儿绿"的分歧。
>
> **为什么 V1 的证据命令里没有 `npm run gate`**：`gate` 含 `verify:state`，而它读的正是 V1 自己的这份
> 证据日志（存在性 + `exit_code=0` + 已入库）。把这条检查包进它自己的证据命令，第一次跑必然红，
> 红了就写不进 `exit_code: 0`，于是永远红——自指死锁，实测卡了两轮。全量门禁交给 CI 与 `npm run gate`
> 的日常使用去跑，证据只覆盖"这次到底改动了哪些套件"，两者不重叠，谁都不替谁背书。

## 4 不作数的情况

- 叶子写成「改 task-loop.mjs」——按文件拆，无法验证完成
- 叶子没有验收标准，或验收标准写成"测试通过"却没说是哪个套件、哪条断言——无法判定 done
- `spec_ref` 留空，或指向 FS 里不存在的小节——**悬空任务**：拆的时候 FS 还没有那一节，做完才发现没人要
- FS 有 §4.x 却没有任何任务对应——**漏做**，而且交付前不会有人发现
- 用"套件全绿"当完成证据，却没有做变异检验——绿只证明没坏，不证明判据有效（本轮实测：一套 17 条的套件可以覆盖不到被测的那条生产路径）
- 实现 TODO 自己跑全量测试——应由 V1 收口
- 把"数据档未授权"写成"部分完成"——那是一个明确的失败分支（`McpPermError` → 指引），不是半成品；含糊的"部分"让门禁无从判断
