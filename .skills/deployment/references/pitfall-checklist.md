# 部署已知坑清单（47 条，从 24 个 retro + 17 个 CR 蒸馏）

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
