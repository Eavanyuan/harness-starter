# 部署已知坑清单（56 条：首批 47 条蒸馏自 24 个 retro + 17 个 CR，#48–56 为后续实战追记）

> 按部署阶段分组。每条标注来源（retro/CR 文件名）与严重度（🔴 阻断 / 🟡 注意）。

## init 阶段（7 条）

| # | 坑 | 严重度 | 来源 |
|---|---|---|---|
| 1 | init 带入源仓真实接入（GitLab url、飞书 space key）——已修（净化），但 iteration.field 仍可能残留 | 🟡 | usability audit |
| 2 | 空目录 init 后 check:skills 红——.skills 全套与 projects 集合不对齐——已修（template 占位条） | 🟡 | usability audit |
| 3 | deploy/ 和 docs/06-reference/ 不随包装——已修（进 TEMPLATE_DIRS） | 🟡 | usability audit |
| 4 | AGENTS.md conflict 留人工合并——最大的人工项，不能跳 | 🔴 | init 实测 |
| 5 | Java 项目 skipTests 陷阱：根 pom 和子模块可能用**不同的属性名**（skipTests vs skip.tests），裸 mvn test 零测试 exit 0 | 🔴 | TDasset 落地 |
| 6 | v1 stacks 与 v2 projects 两套消费者——新装一律用 projects 数组（init 自动），别手写 stacks 对象 | 🟡 | 复审 C1 |
| 7 | `.ai/writes.json` 是生成物——改源 agents/*.agent.md 后必须 build:agents，别手改 writes.json | 🟡 | 复审 R2 |

## 凭据/接入阶段（8 条）

| # | 坑 | 严重度 | 来源 |
|---|---|---|---|
| 8 | 飞书 OAuth 优先（零管理员），插件身份备选（需空间管理员安装）——不是二选一，OAuth 是推荐路径 | 🟡 | 飞书落地 |
| 9 | GitLab PAT 只认 private-token 头——OAuth access token 会 401 假象 | 🔴 | L2 实测 |
| 10 | GITLAB_URL vs HARNESS_GITLAB_URL 双前缀——代码层已统一到 GITLAB_URL，但 doctor 的门禁在场性仍读 HARNESS_GITLAB_* 三个 | 🟡 | 配置盘点 |
| 11 | 凭据文件路径：~/.harness/task-loop/task-loop.env（0600）——不是 .env、不是环境变量直接 export | 🟡 | 安装器实测 |
| 12 | 飞书接单门槛用**优先级**字段（内置 priority，label 即 P0-P3），不用自定义"严重级别"——后者可能零区分度（12 张单全"中"） | 🔴 | 用户更正+实测 |
| 13 | 迭代周期字段 key 随空间变——用 MQL 中文名「迭代周期」直接探 key（SELECT 认中文名并返回 key/name 对） | 🟡 | 迭代过滤实测 |
| 14 | broker HOST 默认 127.0.0.1 只绑回环——要接 webhook 必须显式 0.0.0.0 + 两个 token 配齐 | 🟡 | L2 实测 |
| 15 | PAT 在聊天等明文渠道出现过——链路稳定后应轮换，换新值只改 env 文件 | 🟡 | 安全实践 |

## 轮询/接单阶段（12 条）

| # | 坑 | 严重度 | 来源 |
|---|---|---|---|
| 16 | 定时器心跳 ≠ 真实节拍——心跳 180s 固定，真实节拍读 pollSeconds（改配置即生效免重装） | 🟡 | poll-config |
| 17 | 手动 --once 不受节拍限制（想跑就跑），但跑完刷新节流戳（定时器下一拍顺延） | 🟡 | 节流语义 |
| 18 | 改 task-loop.mjs 期间必须 touch .ai/task-loop/OFF（kill switch），否则半成品代码立即上线 | 🔴 | 11-16 实战 |
| 19 | 定时器账本在用户级 ~/.harness/task-loop/，手动跑才写仓库 .ai/ledger——排查先看用户级 | 🟡 | 运维事实 |
| 20 | 接单状态流转用专用工具 transition_state{transition_id}，**不是** update_field——后者只管业务字段，传状态静默返回空 | 🔴 | 真实首跑三教训 |
| 21 | 回读用 search_by_mql，不用 get_workitem_brief——后者的 status 字段实测读不出（undefined） | 🔴 | 真实首跑 |
| 22 | 接单只改状态零评论——评论会刷屏（每 2h 追问一次同一张单）；追问有防重（[自动追问] 标记） | 🔴 | 用户指令 |
| 23 | 信息不全两层守门：预筛（描述空洞→不接单评论 @提交者）+ 实际复现（照描述在本地尝试→失败→不修评论） | 🟡 | 用户澄清 |
| 24 | @人需要 search_user_info 拿 lark_user_id（不是 user_key），格式 `@名<!-- mention:{"id":"lark_user_id_...","blockType":"AT_USER_BLOCK"} -->` | 🟡 | feishu-ask |
| 25 | 跨元素批量取值：门必须过滤 helpers（查询驱动者），不是 recordIndex（富化索引）——过滤错集合等于没过滤 | 🔴 | IDOR 复审 |
| 26 | 最新值门核子属性/trait/KPI displaySubAttribute——门内不要复刻解析逻辑，直接调用取值路径的同一个解析函数 | 🔴 | IDOR 复审 |
| 27 | 库名用 resolvedSourceDbName()（sourceDBName 回落 dbName），不用 getDbName()——与写路径口径必须一致 | 🔴 | IDOR 复审 |

> 执行器/定时任务的坑见文末 #51–53（编号稳定不重排，故未移入本节）。

## CR/审核阶段（8 条）

| # | 坑 | 严重度 | 来源 |
|---|---|---|---|
| 28 | coder 本地 CR 用 ai-review.mjs（独立脚本读 git diff + 规则，会话上下文完全隔离）——**禁止自审**（同上下文=盲区一致） | 🔴 | CR 流程审计 |
| 29 | ai-review --machine-only 对 machine_checks 为空的类型（如 cr）是空壳绿灯——已修 exit 2，别绕 | 🔴 | 复审 M3 |
| 30 | CR 循环 ≤3 轮，第 3 轮仍红升级 human_decision——不设预算会死循环（CR 永远能挑出新问题） | 🟡 | CR 设计 |
| 31 | .ai/review/（agent 正式 CR 记录，给人看）≠ .ai/reviews/（ai-review verdict 缓存，给门禁读）——不同产物不同读者 | 🟡 | 复审 C1 |
| 32 | orchestrator review 阶段必须调度 code-reviewer 子 agent——不是自审、不是让 coder 自审 | 🔴 | 复审 C2 |
| 33 | close 失败路径必须真还原（快照回写落盘），不能只改内存就 die——谎报"已还原"比不还原更糟 | 🔴 | 复审 M1 |
| 34 | 管道吞退出码：verify-run | tail && git commit 会把红 gate 照样提交——用 set -o pipefail 或不接管道 | 🔴 | 两次实测事故 |
| 35 | verify-run 日志带 # commit 头只在干净源码树上写——脏树写 unknown（.ai/ 排除后已改善） | 🟡 | commit 戳修复 |

## 架构治理阶段（6 条）

| # | 坑 | 严重度 | 来源 |
|---|---|---|---|
| 36 | 架构守护用三层混合（机器指标+判断 agent+周期报告），不是全时段流水线 agent——S 档小修不需要架构审 | 🟡 | architect 设计 |
| 37 | fitness functions 双模式：报告（gate 内存量不阻断）/ strict（PR CI 拦新增违规）——不分离会把存量红全爆 | 🔴 | architect 落地 |
| 38 | 测试文件天然长——用独立红线（8000）与主源码红线（3000）分开 | 🟡 | architect 首跑 |
| 39 | architect 的判断是票拟不是裁决——🔴 建议需人确认才生效 | 🟡 | architect 设计 |
| 40 | 复杂度趋势比绝对值重要——2000 行不可怕，从 500 涨到 2000 才可怕 | 🟡 | architect 设计 |
| 41 | 删除是最好的架构改进——如果建议是"删掉"，优先级最高 | 🟡 | architect 设计 |

## 通用教训（6 条）

| # | 坑 | 严重度 | 来源 |
|---|---|---|---|
| 42 | 门禁核的对象必须与实际操作的对象一致——核 recordIndex 但操作 helpers = 核错对象；核顶层属性但读子属性 = 门没对准 | 🔴 | IDOR 根因 |
| 43 | 失败路径必须真失败——谎报"已还原""已通过""状态已流转"比不报告更危险 | 🔴 | 三次同类事故 |
| 44 | 文档说"评论兜底"实现却没兜住——注释与实现不符时以实现为准，审阅者应验证注释声称的行为 | 🟡 | 首跑三教训 |
| 45 | 多仓并发改同一文件必须按文件集分工或串行——拆分重写覆盖接线是实测事故 | 🟡 | 并发教训 |
| 46 | BSD/GNU 差异：sed -i '' 是 BSD 专属，GNU 会把 '' 当文件名——用 node 替代或 sed -i.bak | 🟡 | CI 实测 |
| 47 | read 工具会脱敏 URL 中的 token 字面量——用 read 输出做 apply_patch 锚文本时会静默不匹配，用 sed/od 核对磁盘真实字节 | 🟡 | TDasset 教训 |

## 后续实战追记（9 条，#48–56）

> 2026-11-19 起逐次追记；编号稳定不重排，按追记顺序排列。

| 48 | 测试脚本写了但没接进 gate 聚合 = 从不运行——architect-check 的 --root 越界（argv[2+indexOf] off-by-one）存在数月，test:architect 因不在 gate 里从未被跑到。新增测试必须同批接进 gate | 🔴 | perf-early 实测 |
| 49 | 时间戳秒级分辨率有 ±1s 抖动——基于耗时的测试用例必须在抖动区间内仍确定归档（先算 [min,max] 时长区间再选基线），否则偶发红 | 🟡 | perf-early 实测 |
| 50 | agent 沙箱 PATH ≠ 用户 shell PATH——mvn 装在 /opt/homebrew/bin 但沙箱看不到，agent 判"无 mvn"降级盲修。**解法（已落地）**：环境事实进 harness.rules.json `runtime.headless.envNotes`，随每份工单渲染（session-pack 四剖面）——配置随仓走可迁移，宿主 prompt 只指向配置不复制内容 | 🔴 | mvn 误判实测 |
| 51 | **宿主定时器会因 misfire 静默丢拍**——AutoClaw 调度器：计划时刻机器没醒（合盖/休眠），醒来处理时迟到 > misfireGraceMs（10 分钟）即按 policy=skip 丢弃。症状 = 执行器"时跑时不跑"，日志是 `scheduling.admit.skipped reason=misfire`。执行器节拍应远小于机器醒着的连续时段，或宿主保持唤醒 | 🟡 | 2026-11-23 执行器丢拍 |
| 52 | **"执行器连不上大模型"先别信这个归因——它多半不是连接问题**。已实测到的三种形态，靠**每次运行的耗时 + 是否记了用量**区分：①上游过载——`http 529 overloaded_error`，`model.capacity.retry_scheduled` 指数退避，耗时数百秒；②**任务被超时掐断**——真实长任务跑到 `timeoutSeconds` 上限被判 failed，下一拍 `skipped`；③掐断后的**秒败**——1~6s、`input=0`、只试一次。**秒败 ≠ 连接层**（2026-11-24 实证：同一连接、同一定时任务，秒败 81 次的同时也成功跑完过 1757s；用户手动切换同一模型可用）。判连接是否可用，看**同一连接在别处有没有成功运行**，不要看失败运行的耗时 | 🔴 | 2026-11-23/24 执行器秒败 81 次 |
| 53 | **模型选择的真实解析机制未查明——别把推断当机制写下来**。已确认的事实只有三条：(a) `scheduled_tasks.model_connection_id` 为空，任务不携带模型；(b) 运行时实际发出的模型以 `work_runs.connection_model` / transcript 的 `payload.data.model` 为准；(c) 给会话写 `session_model_connection:*` 偏好后，**只生效了一拍**就回到原模型，且项目/会话偏好会被本会话之外的途径改动。**未查明**：定时任务新起一轮时按什么规则解析模型。另：执行器的工作记录在**真实执行会话**里（trace 与 `work_runs` 都按该会话 ID），不是定时任务记录线上的那个会话——看错会话会得出"执行器全停"的错误结论 | 🔴 | 2026-11-24 绑定只生效一拍；看错会话误判 38 连败 |
| 54 | **解析外部接口的返回，先看实物再取值**——飞书附件字段的值本身就是数组，我按「外面包一层」的直觉去取，结果永远是空列表，**不报错，附件无声消失**。对着真实数据冒烟一次就看见了，而当时 43 条测试全绿（测试夹具是照我的错误直觉写的）。做法：夹具的形态来自真实返回的采样，不来自想象；写完解析必须对真实数据跑一次，并在摘要里核对「该出现的东西确实出现了」 | 🔴 | 2026-11-26 飞书接入 |
| 55 | **规则判断的盲区要写明，不能让它看起来像「没问题」**——规则版只看类型名、描述长短、行为变更字段，读不懂内容。实测：描述说 3 个编号、附件里有 10 个，规则照样给「把握高、0 项待决」。把这类局限写进需求规格的范围外；要机器发现内容矛盾，得交给模型并要求给出依据 | 🟡 | 2026-11-26 飞书接入 |
| 56 | **检验脚本自己跑不起来时必须判红，不能静默变绿**——变异检验用 python3 heredoc 生成用例，python3 不在 PATH 时 heredoc 静默失败、后续循环空转，输出「全部通过」退出 0（独立评审实测发现）。做法：外部命令先判存在性；生成的清单要与期望条数对账；每一步退出码逐个判，不能只看最后汇总 | 🔴 | 2026-11-26 飞书接入独立评审 |
