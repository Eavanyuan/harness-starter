# TDasset tda-server × harness-starter 落地可行性评估

日期：2026-11-14。依据：init 冲突面实测（/tmp/tda-init-report.md，TDasset 全量拷贝 dry-run）+ 链路能力盘点（/tmp/tda-loop-report.md，逐文件行号证据）+ 本会话对两仓的既有审计。目标场景：**飞书项目管理拉 bug → 修复 tda-server → MR → CI 审核未过 → 拉打回意见修复闭环**；约束：保留并改进 TDasset 原 harness，不直接替换；信息不全时在飞书任务回复提交人补充。

## 一、总结论

**可行，且冲突面出乎意料地小**：init dry-run 实测 create 176 / merge 1 / **conflict 仅 4 个文件**（`.skills/README.md`、`.skills/backend/SKILL.md`、`.skills/frontend/SKILL.md`、`AGENTS.md`）——全部是"TDasset 资产被 init 保护"，没有 harness 需要却被挡的。落地本质是**嫁接**：TDasset 的 44 个业务 skill + 853 行 AGENTS 总纲 + GitLab 六关卡流水线全保留，harness 只补三样 TDasset 没有的东西——**任务状态机与证据链**（state.json/verify 日志/门禁）、**MR 审核自动化**（review-router + ai-review 的 L0 机器判据）、**跨系统循环**（飞书↔GitLab↔开发机的 task-loop/broker）。

真正的工作量不在合并，在**链路接线**：四段链路里"拉单触发"“通知裁决"已具备且经真实环境验证，"自动修复执行"（headless T5）与"CI 归因循环"（T4a/b）目前是占位——这决定了落地方案必须**人机混合起步**（task-loop 触发 + 人开带 hook 的会话修），不能直接上全自动。

## 二、目标场景全链路与现状标注

```
飞书项目管理(bug 单) ──MQL 轮询──▶ task-loop 拉单【部分：拉取/分级已备，P0/P1 auto、P2 确认】
   │ 产品线过滤【已实现并实测（2026-11-14）】：迭代周期 label 以 IDMP 开头才算本产品 bug，
   │   key=field_a7de08 已实测入配置；实拉 12 张→保留 2 张 IDMP 单，行为与规则一致
   │ 信息判读：复现步骤/环境/版本/日志/截图齐全？
   ├─ 不全 ─▶ add_comment 回复提交人【缺口：能力已写零调用 + 数据档未授权】→ 挂起等补充
   └─ 全 ──▶ init-harness <slug> S --type bugfix --related feishu:<单号>【已备】
        ▶ 回归测试先行 + 红灯日志【已备，机器强制】▶ 修复 tda-server
        ▶ MR ─▶ review-router 按路径路由【已备，需接线 GitLab CI】
              ─▶ ai-review L0 机器判据 + 单发语义审【已备，需内网模型端点】
        ▶ CI 未过 ─▶ broker 飞书卡片（pipeline failed 找作者）【已备】
                  ─▶ task-loop 双信号拉打回（discussion + 批红时间）【已备并真实验证】
                  ─▶ 修复会话【缺口：headless T5 占位 → 阶段 1 由人执行】
                  ─▶ CI 归因（引入失败=0）【脚本已备未接 runner】
        ▶ 人审批红 ─▶ 卡片按钮回投 / 改 RS 落账【已备，内网走"决策走 git"最省】
        ▶ 合并 ─▶ feishu transitionStatus 回写【缺口：已实现零接线】
```

## 三、init 实测冲突面与"保留并改进"处置

| 冲突/合并项 | 实测行为 | 处置方案（不替换原则） |
|---|---|---|
| `AGENTS.md`（TDasset 853 行 vs harness 70 行） | conflict，保留 TDasset 版 | **人工合并一次**：harness 的"硬规则/意图路由/找 skill/不许做"四段以独立小节并入总纲（harness 版改名 `HARNESS.md` 被引用亦可）。总纲的任务分类表加一行：bugfix → `init-harness.sh --type bugfix --related feishu:<单号>`。这是落地最大的人工项，一次性 |
| `.skills/backend|frontend/SKILL.md` | conflict ×2，保留 TDasset 版 | **把 harness 版的硬规则表（R1–R11/F1–F7 查法列）手工并入 TDasset 版对应段落**，不是取其一——TDasset 版缺"怎么查"的机器命令列，AGENTS 第 4 条"按 skill 硬规则逐条核"会落空 |
| `.skills/README.md` | conflict | 并入 harness 的"加载协议/三条硬约束"段（resolve-skills 扫描机制说明） |
| `.skills/` 其余 44 个 TDasset skill | 无冲突，天然共存 | resolve-skills 按 applies_to 全量路由，两套同场生效（实测机制，resolve-skills.mjs:66-77） |
| `package.json` | merge：只追加 38 个 scripts | 已有 playwright 等键与 deps 原样保留（init.mjs:215-245），安全 |
| `.gitlab-ci.yml` | init 自动镜像 quality-gate 进 GitLab CI | 人工核对镜像结果，与既有六关卡合流（见 K3） |
| TDasset 六关卡 MR 流水线 | 不动 | harness review job 作为**附加 job** 并列挂入（`rules:changes` 防重跑），不替换任何既有关卡 |

**stacks 配置（tda-server 适配，含实测确证的陷阱）**：

```json
"projects": [{ "dir": "tda-server", "stack": "backend",
  "srcGlob": "tda-server/**/src/main/java/**/*.java",
  "lint": "mvn -q -pl tda-server validate",
  "test": "mvn -pl tda-server test -DskipTests=false -Dskip.tests=false" }]
```

⚠️ **skipTests 陷阱（实测确证）**：TDasset 根 pom `skipTests=true` 与 tda-server `skip.tests=true` 是**两个独立属性**，裸 `mvn test` 一个测试都不跑、exit 0；而 verify-run 审计只对账"audit.tests 与日志头 total"，**不要求 total>0**——不带双参数会 0/0 绿灯掩盖零测试。命令必须双开。同时建议 harness-starter 侧补一条判据：`audit.tests` 为 0/0 且无 `no_test_reason` → 拦（见第八节 R1）。

## 四、卡点清单（分级，每条给解法）

**阻断级（不解决链路不通）**

| # | 卡点 | 证据 | 解法 |
|---|---|---|---|
| K1 | ~~飞书数据档未授权~~ **已解决（2026-11-14，OAuth 方案）**：用户身份 token 即可；读路径（search_by_mql，65 张可见）、迭代 key（field_a7de08）、写工具可见性（add_comment/update_field 可调）全部实测通过；真实写（评论/状态流转）留首张真单验证 | IT4.log；retro/iteration-prefix | 剩余：transitionStatus 可流转态返回形态核对 + task-loop 接 add_comment 追问分支（阶段 2，约一天） |
| K2 | git.tdengine.net 自建 GitLab 无 harness runner：review-router/ai-review/broker 的 GitLab 边都依赖 runner + PAT | doctor 门禁在场性检查；retro:27"TDC 侧装 runner 是待办" | TDasset 项目注册 gitlab-runner（docker executor，node:22 镜像 + GIT_DEPTH=0，deploy/task-loop/gitlab-ci.example.yml 已写明两个坑）；PAT 给 broker/bot（api 读 + 文件写，不给合 MR） |
| K3 | 内网无 OpenAI 兼容端点：ai-review 无凭据时"机器判据干净"会 exit 2（fail-closed，不装作通过） | ai-review.mjs env；guides §五 | 配 `AI_REVIEW_BASE_URL/KEY` 指内网网关（GLM 等）；或过渡期 job 显式 `--machine-only`（零 token，只有 L0 判据） |
| K4 | headless 修复会话（T5）占位：task-loop 触发后落 ack 清单即止，不真修代码 | task-loop.mjs 末段；loop-report §4 | **阶段 1 不依赖它**：task-loop `--dry-run --report` 出"该修什么"清单 → 人开带 hook 的 Claude/ZCode 会话，用 `harness resume` 接手（会话打包器已备）。T5 接入是阶段 3 的事 |
| K5 | AGENTS.md/两份 SKILL.md 的人工合并 | init 实测 conflict 4 | 一次性人工项（半天），方案见第三节 |

**配置/接线级**

| # | 卡点 | 解法 |
|---|---|---|
| K6 | CI 归因循环（T4a/b baseline/fingerprint/ci-watch）未接进 runner | 阶段 2 接线；接线前"打回修复"的归因由人读 MR 流水线 + task-loop 双信号清单完成 |
| K7 | 飞书状态回写（transitionStatus）未接线 | 阶段 2：修复合并后 task-loop 调 transitionStatus 把单流转到"已修复"（回读验证已实现）；上线前先人工核对一次状态机映射 |
| K8 | 决策卡需显式投递，MR 路由出红不自动附卡 | 阶段 2 小改动（broker 在 renderMrCard 出红时附带）；内网优先用"决策走 git"（零飞书回调配置，身份=commit author 不可冒充） |
| K9 | TDasset 前端 26063 用例 31-36min | bugfix 走定向验证（`testOne`），全量交既有 CI unit-test job；harness gate 只装在 tda-server 侧试点 |
| K10 | 多会话并发同仓（本会话实测踩过：拆分重写覆盖接线） | 落地规约写进合并后的 AGENTS.md：同仓多会话按文件集分工或串行 |

## 五、"信息不全时回复提交人"机制设计（用户点名项）

现状：`feishu-sync.mjs` 的 `add_comment`（markdown 评论到工作项）已实现但零调用、数据档未授权（K1）。设计方案：

1. **判读**：task-loop 拉单后、建档前，按四项判信息完整度——复现步骤、环境/版本（IDMP/TSDB 版本号）、现象日志或截图、期望行为。任一缺失即进入追问分支。
2. **追问**：调 `add_comment` 以固定模板回复提交人：
   > 【自动化助手】收到该缺陷，但缺少 <具体项>。<为什么要>（例如：无版本号无法定位是哪个 release 的行为）。请在评论区补充，或附上 <日志路径/操作录屏>。补充后本单会自动继续处理。
3. **挂起不流转**：平台状态保持不动（不把 New 转走，避免提交人以为已处理）；任务侧建 bugfix state 并挂 `blocker {type: human_decision, question: 同上, options: [补充信息后继续/挂起 5 个工作日后自动关闭], defer_until: "等待提交人"}`——正好复用 harness 既有 blocker/DECISIONS.md 机制，追问内容与答复全程可审计。
4. **防骚扰三规则**：同一单**最多追问 1 次**（state 里记 `asked_at`）；二次信息仍不全 → 不再自动追问，broker digest 档通知人裁决；提交人补充后由下一轮 MQL 轮询（或评论事件）重新判读，不重复建档（git CAS 认领天然防重）。
5. **实现量**：task-loop 剖面 B 加一个分支 + feishu-sync 接线 + add_comment 实测——**约一天工作量**，全部在 harness-starter 侧，不动 TDasset。

## 六、分阶段落地方案

**阶段 0：嫁接（1 天，纯本地）**
- `init <TDasset> --dry-run` 复核 → 正式 init（create 176 + merge 1 落盘，conflict 4 留原版）
- 人工合并 AGENTS.md 与两份 SKILL.md（方案见第三节）；配 tda-server stacks（双 skipTests=false）
- ~~配置迭代过滤~~ 已完成：`runtime.feishu.iteration = { field: "field_a7de08", prefix: "IDMP" }`（实测入配置）
- `npm run doctor` + `npm run gate` 在 TDasset 上首跑；影子周启动：`task-loop --dry-run --report` 每日跑（日志里能看到迭代过滤的 kept/skipped 账，正好验证字段 key 配对了没），N≥30 且 0 误触发才进下一阶段

**阶段 1：人机混合试点（1 周，tda-server 限定 S 档 bugfix）**
- 手动走 2–3 个真实飞书 bug：人读单 → `init-harness <slug> S --type bugfix --related feishu:<单号>` → 红灯日志 → 修复 → MR
- GitLab CI 附加 review job（router + ai-review `--machine-only` 起步）；broker 起在内网开发机（FEISHU_MODE=ws 长连接或决策走 git）
- 验证点：证据链入库、skipTests 陷阱不复现、中文/长路径、TDagent 六关卡与 harness job 并存无互扰
- 产出：试点 retro（按新规 `retro/<slug>*.md`），出第一份 ledger:report 误拦率基线

**阶段 2：接线闭环（2–3 周）**
- K1 数据档授权 → add_comment 追问机制上线（第五节）+ transitionStatus 回写
- ai-review 从 machine-only 升级到带模型（内网端点就绪后）；决策卡自动附卡（K8）
- T4a/b 归因接进 task-loop runner；打回修复仍人执行，但触发、归因、停点判断全自动

**阶段 3：全自动（回到 harness-starter 开发）**
- headless T5（runner 拉起无头会话，hook 强制接线）；预算三闸；P2 级单确认卡
- 这一步的成熟度取决于阶段 1–2 的 ledger 数据（误拦率、追问解决率、归因准确率），不预设时间表

## 七、风险与明确不做的事

- **不做替换**：TDasset 六关卡流水线、44 个业务 skill、版权头/提交规范全部保留；harness 的 review job 是并列附加项，随时可从 `.gitlab-ci.yml` 摘除。
- **不自动合 MR**：批红永远归人（卡片按钮或改 RS），bot token 无合并权限（broker 安全边界）。
- **不假装全自动**：T5/归因未接线前，宣传口径是"触发与门禁自动、修复由人"，避免信任透支。
- Go/Python 栈（ai-agent、mcp-tdengine-idmp 等）v1 不纳管（init 不生成命令），tda-server 试点成功后再扩。

## 八、反哺 harness-starter 的改进需求（TDasset 视角）

| # | 需求 | 优先级 |
|---|---|---|
| R1 | verify 审计加"零测试护栏"：`audit.tests` 0/0 且无 `no_test_reason` → 拦（TDasset 双 skipTests 陷阱的通用解） | P0（TDasset 落地前） |
| R2 | feishu-sync 接线 + add_comment 追问分支（第五节） | P0（阶段 2） |
| R3 | 决策卡自动附卡（MR 出红时） | P1 |
| R4 | ai-review 的 rs/cr 清单适配 TDasset 目录结构（docs/01-requirements vs TDasset docs/01-requirements 编号目录——实测高度接近，核对即可） | P1 |
| R5 | Go/Python 栈 skill 模板 | P2 |

## 结论

冲突面小（4 文件人工合并）、双仓目录约定高度同构（TDasset 本就按 00-planning/01-requirements 编号组织、本就有 .skills 与任务分类，harness 的嫁接面是"为它准备的"）；链路缺口集中在三处接线（飞书写、GitLab runner、归因接入）而非性能或架构冲突。**建议按四阶段推进，阶段 1 结束时用真实数据决定是否继续**——这套流程自己的纪律（影子周、ledger 基线、retro）就是可行性实验的度量工具。
