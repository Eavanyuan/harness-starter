# 同类型 bug 合并修复落地方案（2026-11-14）

> 需求：同类型（同根因）的多张飞书 bug 单可以合并成一个提交修复。
> 张力：harness 纪律是"一张单一份 state、一条分支、一个 MR"（证据链与追溯按单隔离）；
> 合并的正当性来自**同根因**——一个修复动作天然对应多张单，强行拆开反而制造重复 MR。
> 方案原则：**提交可以合并，追溯不能合并**——每张单号都必须机器可查、逐单回写通知。

## 一、什么算"同类型"（入批硬边界）

全部满足才可入批，判定由 agent 提议、**人确认**（P2 确认卡或 MR 描述里列明）：

| # | 边界 | 理由 |
|---|---|---|
| 1 | **同一根因**（不是"现象像"——修复 diff 能互相解释） | 不同根因混批 = 红灯日志造假（一张单的复现盖不住另一张） |
| 2 | 同一模块/同一修复面（一个 MR 能说清） | 跨模块的"顺手修"是回归面放大器 |
| 3 | 同一迭代周期（都在 IDMP-* 内） | 跨迭代的单优先级/发布节奏不同 |
| 4 | ≤5 张单 | 批太大=回写与评审粒度失衡 |
| 5 | P0 不入批（单独走全流程） | 高危单的处置节奏不该被批拖慢 |

## 二、落地形态（v1：不改代码即可用的手动批）

```bash
git checkout dev && git pull
git checkout -b fix/batch-feishu-7167752069-7167910546-dashboard-share

# 批任务：主单做锚，其余单号进 affected_ids 与 meta.note（v1 机器只校验主单，见第三节 P1）
bash scripts/init-harness.sh dashboard-share-batch S --type bugfix --related feishu:7167752069
# 手工补：meta.note = "批修复：7167752069、7167910546（同根因：共享会话越权）"
#          meta.affected_ids += [feishu:7167910546]

# 一条参数化复现测试盖全批（@ParameterizedTest 逐单号），红灯一次覆盖：
bash scripts/verify-run.sh --task dashboard-share-batch T1 -- \
  mvn -pl tda-server test -DskipTests=false -Dskip.tests=false -Dtest=DashboardShareBatchTest
# 修复 → 同命令跑绿（T2）→ state 收尾

git add -A && git commit   # 批内可多笔工作提交
git push && 开 MR          # MR 描述**必须**列全部单号（追溯锚）→ 合并时 **squash 成一个提交**
```

**"合并成一个提交"的实现位置在 GitLab MR 的 squash merge**，不在工作分支（工作分支保留
过程提交，证据链可读；squash 后主干上一个提交对应一批修复，单号清单在 commit body 与
MR 描述里）。TDasset 侧需在项目设置开启 Allow squash（或团队约定合并时勾选）。

**回写不合并**：每张单逐个 `transitionStatus`（已修复）+ `add_comment`（"随批修复 MR !x，
本单为同根因批次之一"）——提交可以省，通知不能省，提交人对自己的单都要收到答复。

## 三、机器支持（P1：代码触点，约半天，建议试点 1-2 批后做）

| 触点 | 改动 |
|---|---|
| `scripts/init-harness.sh` | `--related` 接受逗号分隔多来源：`--related feishu:A,feishu:B`；首单为主锚（related_task + remote_id），其余进新键 `meta.remote_ids[]` |
| `hooks/lib/verify.mjs` `checkTaskTraceability` | `remote_ids` 存在时逐个校验非空/格式一致；`related_task` 必须等于首元素；数量 >5 → 拦（边界 4 进机器） |
| `scripts/lib/feishu-sync.mjs` + task-loop | 批任务收尾时循环逐单回写（transitionStatus + 评论带 MR 链接） |
| `docs/06-reference/state-fields.md` | 登记 `remote_ids`（doctor 双向契约） |
| 测试 | 多单建档/越界 5 张拦/回写循环 mock 三组断言 |

v1 与 P1 的差别只在追溯强度：v1 其余单号靠 meta.note + MR 描述（人可查，机器不校验）；
P1 后全部单号机器可校验、可逐单回写。**影子周期间用 v1 跑 1-2 批真实样本**，确认入批
边界判得准，再做 P1——边界规则先被数据校准，再进代码。

## 四、明确不做

- task-loop **不自动归并**单子成批（"哪些单同根因"是判断不是检索，v1 由人/agent 在接单时
  提议归并，批的确认走 P2 确认卡同款交互）；
- 不与"信息不全追问"冲突：批里任何一张单信息不全 → **整批挂起等那张单补齐**，或把该单
  摘出批单独走（不允许"带着糊的单先修"）；
- 不与轮询节拍耦合：2 小时一拍（pollSeconds=7200 已生效，100ade2）下拉到多张 IDMP 单，
  正好由 agent 在一轮内提议归并——节拍越长，批的收益越明显。

## 五、判定不准时

"这是不是同根因"拿不准 → 不入批，各走各的单（合并是优化不是义务）；事后发现两单同根因，
在两份 state 的 retro 里互引即可，不需要返工成批。
