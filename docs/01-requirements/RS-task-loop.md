# RS-task-loop：本地任务循环执行器

> 任务：`.ai/tasks/task-loop/state.json`（M 档，feature）。方案基线 = 会话定稿 v2（含 2026-11-09 技术评审：三条硬伤已修、七条边界已闭合、CAS ref 修正为 heads/ 命名空间）。

## 1 背景与痛点

流程里机器能做的部分（路由、审核、证据链）已经闭环，但两道缝仍靠人盯：**MR 被打回后修复意见躺着等人**（场景 1）、**飞书 bug 任务指派后等人开跑**（场景 2）。流失点不在"写修复"而在等待与重试的缝里：CI 半夜红没人归因、打回意见过夜、第二天上下文丢失。单次 agent 调用跨不过这些缝（完成标准跨小时、依赖外部状态、失败要换法重试、最终人签字）——需要**本地循环执行器**（拉模型），而不是中央调度器。

## 2 用户故事

### US-1 剖面 A：MR 打回自动修复

- **作为**：提交者（MR author）
- **我希望**：TL 打回后，我本地的 agent 自动确认意见、修复、推回 MR
- **以便**：打回意见不再过夜，我不在屏幕前时循环也在走

**验收标准**

- Given TL 提交 CHANGES_REQUESTED 评审且存在未解决 discussions When 本地 runner 轮询到 Then git CAS 认领成功（`refs/heads/claims/mr-<iid>` 创建），agent 先在 MR 逐条回复"已确认 + 修复方案"再动手
- Given 两台 runner 同时认领同一 MR Then 仅一台 push 成功，另一台非快进拒绝并跳过本轮（认领竞争落账）
- Given 修复推送后 CI 红 When 归因为本 MR 引入 Then 进入修复子循环，同一失败同根因连续 2 次强制换法，3 轮未绿转 blocked 升级
- Given 达到停点 Then 判定条件为"本 MR 引入的失败 = 0 且 approved_by 非空且 approver ≠ author 且审批晚于最后一次 push"，缺一不算完成

### US-2 剖面 B：飞书 bug 自动接单（hotfix 状态机）

- **作为**：bug 任务 owner
- **我希望**：指派给我的 P0/P1 bug 由本地 agent 自动接单走 hotfix 流程
- **以便**：紧急修复的等待缝被机器缝合

**验收标准**

- Given P0/P1 bug 指派 When owner runner 在线 Then 自动接单；P2 则 confirm_first（卡片确认才开跑）
- Given bug 归属候选多于一个仓库 Then 卡片列候选+证据等人选，不猜
- Given 在 main（或 owner 指定的 base 分支）复现失败 Then 转求证反馈，不硬修（只修能复现的）
- Given 接单建档 Then `--related feishu:<单号>` 通过追溯门禁（`EXT-<id>` 行被接受），`state.meta.remote_id` 双向锚定

### US-3 订阅三档投递与防轰炸

- **作为**：参与者
- **我希望**：按重点（关注的 MR、severity、SLO、临期）设定消息档位，也可全量
- **以便**：消息轰炸不淹没真需要我的

**验收标准**

- Given 事件命中个人规则 Then 按 card / digest / ledger 三档投递；降档必带 `escalate_after`，aging 巡检按事件自身 SLO 升级（P0 豁免静默时段）
- Given "必须我批"类事件 Then 对审批人本人最低档为 digest + aging（订阅可延迟不可吞消息，循环不在门口无人值守）
- Given 个人 mode=all Then 全部事件 card（个人选择，不做全局默认）

### US-4 停点、豁免与预算（循环的刹车系统）

- **作为**：技术负责人
- **我希望**：豁免、重跑、预算都有硬闸和账
- **以便**：主干红两天那样的存量红不会变成所有人的通行证

**验收标准**

- Given 申请基线豁免 Then 仅对断言指纹相同的失败生效，且必须携带 owner 与到期日，过期自动失效
- Given 重跑导致红绿翻转 Then 落 `flaky:<套件>/<用例>` 事件并强制开 issue，不落账的重跑不算数
- Given 预算（活动墙钟 + 轮次为硬限；tokens 仅可观测处计）或轮次耗尽 Then 任务 blocked + 一屏四块证据包卡片，不自愈；CI 与人审等待不计墙钟（pause/resume 事件）
- Given `.ai/task-loop/OFF` 哨兵存在 Then 每轮检查即停（kill switch）

## 3 核心需求

| 编号 | 需求 | 优先级 | 来源 |
|---|---|---|---|
| R-1 | task-loop runner：双剖面触发轮询（零 LLM）、git CAS 认领+TTL、worktree、headless spawn（`runtime.headless` 新键，hook 必接线）、预算与 kill switch | P0 | US-1/2/4 |
| R-2 | 剖面 A 全环（结构化触发→确认→修复→CI 归因循环→停点含人审三条件） | P0 | US-1 |
| R-3 | 剖面 B hotfix 状态机（归属判定→复现闸→修复→验证→CI 归因→人审停点→收尾回写读回） | P0 | US-2 |
| R-4 | 追溯门禁扩展：`--related` 收外部单号 + `EXT-<id>` + 模板与套件 | P0 | US-2（评审 M2） |
| R-5 | 订阅三档 + broker 评估器 + aging 巡检 + digest 模板 + 批准下限 | P1 | US-3 |
| R-6 | 失败指纹归一化（✗ 剥参 + 硬编码文案并轨 + `step:*` 类）+ merge-base 基线实跑 + 集合差 | P0 | US-4（评审 B） |
| R-7 | 豁免三道闸（指纹相同+owner+到期日 / flaky 落账+issue / 豁免率告警） | P0 | US-4（评审 C） |
| R-8 | 影子周可证零写入（mock 全 POST/PUT 即失败）；P1 验收 0 误触发且 N≥30 且漏触发单列 | P0 | 分期（评审六） |

## 4 非功能约束

拉不推（开发者机器零入站）；git 唯一序列化点（认领/状态/证据全走 git，runner 崩溃可从触发源重推）；停机在 runner 层；凭据 owner 自有 PAT 最小授权，绝不共享 bot 代推；判不了的明说不判（tokens 不可观测不计硬限）。

## 5 范围外

中央调度器/常驻 agent 池；自动合并（永不在循环内）；跨人改派；飞书事件源未批期间的自动形态（降级为手动派单卡）。

## 6 术语表

- **认领（claim）**：runner 对一个触发（MR/任务）的独占执行权，git 分支创建仲裁，带 TTL。
- **停点**：循环停止等待人的条件——引入失败为 0 且人审有效（三条件）。
- **豁免（exemption）**：把某失败归因为基线的登记行为，指纹绑定、限期、计量。
- **一屏四块证据包**：变更/理由/验证证据/风险四段的升级卡片。

## 7 开放问题

| 编号 | 问题 | 状态 |
|---|---|---|
| OP-1 | K1：TDC 侧 CI runner 安装（P1 准入，doctor 阻塞级为闸） | 待运维 |
| OP-2 | K2：飞书项目 OpenAPI 权限（未批则剖面 B 走降级形态） | 待申请 |
| OP-3 | aging 缺省时长（通用 4h / 打回修复完成类 2h）是否需要按仓库配置 | 已定缺省值，配置化留实现期 |
