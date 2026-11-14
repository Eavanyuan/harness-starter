# TDasset 旁挂落地修订方案（v2，2026-11-14）

> 状态回答：**尚未落地**。截至今天所有工作都在 harness-starter 侧（代码/配置/实测/方案），
> TDasset 仓库内无任何 harness 文件（实测确认：无 .ai/、hooks/、agents/、.skills 新增）。
>
> 本版按两条新硬约束修订 v1 方案（`tdasset-启用操作方案.md`）：
> **约束 A：harness 相关文件一律不提交进 TDasset 仓库。**
> **约束 B：bug 修复提交只含代码+测试；仅当涉及用户手册或 fs 文档修改才提交文档。**

## 一、模式变更：从"嫁接进仓"到"旁挂"（约束 A 的直接后果）

v1 假设 init 把 176 个文件落进 TDasset 并入库。约束 A 下改为**旁挂模式**：

| 资产 | v1（进仓） | v2（旁挂） |
|---|---|---|
| harness 本体（hooks/agents/scripts/模板） | TDasset 仓库内 | **留在 harness-starter 仓**（它本身就是 git 仓） |
| 任务 state / verify 日志 / retro | TDasset 仓库 `.ai/` | **harness-starter 仓的 `.ai/`**——证据链照常入库，入的是 harness 仓，TDasset 保持干净 |
| TDasset 里的工作方式 | 在 TDasset 开会话 | **会话在 harness-starter 目录起**，`--root ../TDasset` 指向代码仓（task-loop 已支持）；verify-run 包命令时 `cd ../TDasset && mvn …`，日志落 harness 仓 |
| GitLab MR 审核（router/ai-review） | 挂 TDasset CI job | **GitLab webhook → broker**（webhook/PAT 是项目**设置**不是文件提交）；结论发飞书卡片辅助人审，TDasset 流水线零改动 |
| 本地 hooks（guard_*） | 装进 TDasset .zcode/.claude | **v2 不装**（那两个是已提交文件，本地改不提交会常脏）；纪律由 harness 侧会话执行 + CR 兜底 |
| 定时器/task-loop | 装在 TDasset | 装在 harness-starter 仓跑，`--root` 指向 TDasset（现状即如此，无需改） |

**保得住的**：任务状态机与证据链（在 harness 仓，判据原样）、飞书拉单/IDMP 过滤/追问回写、
broker 三档通知与决策走 git、task-loop 轮询（2h 节拍已生效）。
**降级的**：TDasset MR 上没有 harness 红绿灯（审核结论走飞书卡片+人审，不再挡合入的机器闸）；
TDasset 侧无本地 hook 拦截（绕过面回到 CR/人审兜底——本会话复审抓绕过的经验正好用上）。
**待定**：task-loop 认领用的远端 `claims/*` 分支会出现在 TDasset 远端（不进主干、TTL 删）。
若也不接受，单机运行可退化本地锁——留给你决策。

## 二、修订后的启用步骤

```bash
# 全程在 harness-starter 仓，TDasset 只读+收 MR
# 1. TDasset 的 stacks 指到旁挂仓的 harness.config.json（projects.dir 用绝对路径 ../TDasset/tda-server，
#    test 命令 cd 过去跑，双 skipTests=false）
# 2. 定时器装在 harness-starter（已可装）：bash scripts/install-task-loop.sh .
#    轮询已配 2h（pollSeconds=7200，100ade2）
# 3. GitLab 侧（项目设置，零提交）：webhook 指向 broker（MR+Pipeline 事件）+ PAT
# 4. 影子周：task-loop --once --dry-run（已支持 --root）
# 5. 试点单：会话在 harness-starter 起，按第二节动线修，MR 只含代码+测试
```

## 三、bug 修复提交的文档策略（约束 B 的执行口径）

**MR 内容 = 代码 + 测试，仅此而已**；以下两种情况才追加文档，且只追加对应文档：

| 情况 | 追加什么 | 不追加什么 |
|---|---|---|
| 修复改变**用户可见行为**（界面/操作步骤/提示文案/默认值） | `tdengine-idmp-docs/`（用户手册子模块）对应页 | — |
| 修复改变**功能规格所述行为**（fs-*.md 写明的契约） | `docs/02-features/fs-<域>.md` 对应小节 | — |
| 其余一切修复 | **零文档提交** | 不提交 .ai/、retro、修复说明、changelog 式附注——过程文档全留在 harness 仓 |

执行机制（v2 简化）：
- 这条进 **CR 检查项**（harness 仓侧的审查会话照单核：MR diff 里出现非代码非测试非手册/fs 的文件 → 打回）；
- 后续若要机器化，可在 ai-review 的 cr 清单加一条文件类型白名单判据（改动只列触点，属 harness 仓侧配置，不进 TDasset）。

与合并批方案（`同类型bug合并修复方案.md`）的衔接：批 MR 的 squash 提交体同样只列单号与
一句话根因（commit body 是追溯锚，不算"文档"）；入批单号的全量记录在 harness 仓的 state 里。

## 四、旁挂模式的固有代价（明说）

1. TDasset 主干合入不再有 harness 机器闸——**门禁后撤到 harness 仓与飞书卡片**，MR 质量兜底
   回到 TDasset 既有六关卡 + 人审；
2. 跨仓引用（harness 仓的 state 记 TDasset 文件路径）要求两仓在同一台机器同目录层级，
   换机需同步（harness 仓本身可 clone，TDasset 亦然——比"文件进仓"多一次 clone，可接受）；
3. 并发约束更依赖自觉：没有 TDasset 本地 hook，harness 侧会话的 guard 仍全量生效
   （会话 cwd 在 harness 仓，写 TDasset 路径同样过 guard_write/guard_command 判据）。

## 五、下一步（待你点头即执行）

1. 修 `harness.config.json` 的 TDasset 旁挂 stacks（dir 绝对路径 + test 命令带 cd）；
2. 装定时器于 harness-starter、开影子周；
3. broker 起服务 + TDasset GitLab webhook 配置（需要你给 PAT 与可绑的机器）；
4. 拿 1 张 IDMP 真单按新动线走通第一个 MR（只含代码+测试）。
