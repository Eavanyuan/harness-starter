# harness-starter 业务通畅度评估：易用性与配置面（2026-11-14）

> 方法：本会话重度使用实录（我本人是这套系统最近一周最重的用户）+ 两路独立走查
> （新用户按《快速上手》从零走五步 / 配置面全量一致性盘点）。

## 一、直接回答

**核心引擎通畅，上手路径不通畅。** 分两半说：

**通畅且有实证的**（本会话真实跑通）：
- 核心循环：飞书拉单 → IDMP 过滤 → 分级 → 认领 → 接单三连（评论+状态流转）→ 修复 → 证据链 → MR —— 每段都有实测记录（12→2 过滤、Processing 探针、PAT/SSH 双通道）
- 判据闭环：红灯日志、commit 绑定、归属头、retro 唯一性、S 折叠出口——而且**门禁会拦自己人的错**（init_flow_tier 契约漏登记被 doctor 当场拦下、S 折叠拦住我自己的任务）
- 定时器/节流（2h 实测生效）、账本观测、doctor 配置键消费检查
- 报错文案质量高（走查者原话："报错文案整体自解释是亮点"）

**不通畅的**：新用户从零到跑通的全路径。走查按文档走，**第一步就撞墙**。

## 二、易用性问题（按严重度）

### S1 阻断（新用户开箱即撞）

| # | 问题 | 证据 |
|---|---|---|
| U1 | **init 把作者的真实配置带进新项目**（git.tdengine.net、taosdata_td）→ doctor 假绿"GitLab 接入"，task-loop dry-run 直连生产空间 | 走查实测复现 |
| U2 | **新装项目 gate 开箱红**：init 重写 projects=[backend-node] 却全量复制 .skills/{backend,frontend,e2e} → check:skills 3 错；修法无文档 | 走查实测 |
| U3 | **init 不装 deploy/** → test:task-loop 结构性红 → S 档收尾"gate 全量绿"判据**永不可满足** | 走查实测 |
| U4 | **S 档 init→done 最小合法路径无法从文档推出**：RS 要 7 章不是"一段话"；跳站要逐站 waived_by；gate 日志要在特定状态组合下产生；四步顺序错一处即红且报错不指路。会话内知道路径的只有读过源码的人（和我） | 走查结论 + 本会话亲证 |

### S2 严重（重度用户每次都痛）

| # | 问题 | 证据（本会话实录） |
|---|---|---|
| U5 | **S 档收尾自指困境**：gate 日志要校验引用它自己的状态 → 每次收尾都要"impl 态跑绿→升 done"的 bootstrap 舞蹈 | ack-wiring 收尾踩了 **2 次**（AK3 红两次才绿） |
| U6 | **管道吞退出码**：`verify-run ... \| tail -1 && git commit` 里 tail 的 0 让红 gate 照样提交 | 踩了 **2 次**（3444bcd、AK3 首提交），红日志进历史还要返工 |
| U7 | **收尾仪式重**：S 档也要手填 todos（verify 对象/ooda/audit 四项）、retro 命名、多轮状态翻转——走查统计五步约 37 个记忆点，S 路径独占 14 | 每个任务收尾约 10 分钟手工 JSON |
| U8 | 多仓库装定时器时 label/账本路径全局固定 → 互覆 | 走查 |

### S3 次要
mcpKey/userKey 悬空指令、workItemType 旧键、README"20 组"实为 30 组、跨仓 `../TDasset` 模式无文档。

## 三、配置问题

| # | 问题 | 影响 |
|---|---|---|
| C1 | **v1 stacks / v2 projects 两套读者各读一半**：allStacks（doctor/verify/check-skills/review-rules）projects 存在即独占；build-agents **反向只读 stacks**；analyzer 注释说"合并处理"但代码不合并 | 活冲突：本仓 v1 stacks 指向不存在目录却永不被校验；agent 生成物的 `<backend-dir>` 与 projects 口径脱节 |
| C2 | **文档与实配矛盾**：《快速上手》"每 3 分钟跑一轮" vs pollSeconds=7200（2 小时，昨天你刚要求的）——新用户会误判故障 | 走查 |
| C3 | HARNESS_GITLAB_PROJECT 只认 env 且安装器不注入 → 定时器机上 doctor 门禁在场性永远"缺 project" | 配置盘点 |
| C4 | 后加的配置键（gates.shell/extraSourceGlobs/retroCheckFromDate/staleTaskDays/taskLoop）**无汇总文档**——都在代码注释里 | 本会话我自己也靠记忆配 |
| C5 | 指南里旧变量名残留（HARNESS_GITLAB_URL vs GITLAB_URL 代码层已统一到 gitlab-config.mjs 单入口，但审核指南还写旧名） | 配置盘点 |

好消息：41 个 env 读取点里，双前缀问题代码层已被 gitlab-config.mjs 单入口收编——配置面在收敛中，只是文档没跟上。

## 四、修复优先级建议

**P0（不修则"新用户落地"不成立）**
1. init 清净化：模板态默认值（空 url/projectKey）+ 检测到携带真实值时警告；装齐 deploy/ 或 gate 对其豁免；projects 与 .skills 复制集合对齐 → **目标：开箱 `npm run gate` 绿**
2. S 档一键收尾：`harness-cli close <slug>`——自动跑 gate、写 gate-TODO、bootstrap 内建（判定时豁免"自己引用自己"）、生成 retro 模板、翻 done。消灭 U4/U5/U7 的手工路径
3. verify-run 尾注提醒 `set -o pipefail`（U6 便宜修）

**P1**
4. C1 二选一：v1 stacks 退役（init 不再写）或 allStacks 真合并——配合 build-agents 改读 projects
5. C4 配置键总表：docs/06-reference/config-keys.md 一页汇总两文件全部键 + env + 默认值
6. 文档同步：快速上手的 3 分钟改"见 runtime.taskLoop.pollSeconds"、HARNESS_GITLAB_PROJECT 写进安装器注入清单、旧变量名清扫

**P2**：多仓库定时器隔离（label/账本按仓库派生）、README 数字校正、跨仓模式文档化。

## 五、一句话结论

这套系统的**判据与证据链是它最通畅的部分**（而且是自证的——门禁拦得住包括作者在内的所有人）；**最不通畅的是"第一次"**：开箱红、路径靠考古、收尾靠仪式。P0 三项（init 清净化、一键收尾、pipefail 提醒）做完，"新用户 30 分钟跑通"才真正成立——估计 2-3 天工作量，值得在 TDasset 试点放量之前做。
