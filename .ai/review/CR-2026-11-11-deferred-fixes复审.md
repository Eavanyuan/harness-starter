# CR 代码审查记录 — deferred-fixes 批复审（0111f7c..2f729f3 + 复审收口 3444bcd..最新）

> 产出：本地复审（用户委托"复审一下"）· 落 `.ai/review/`
> 方式：主会话自测（可证伪探针）+ 两位独立审阅者并行对抗审查（判据域 / 拆分与外围域）
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。

- 审查范围：deferred-fixes 五笔提交 + 两笔晚到提交（e7f9965、1253b45）
- 关联任务：`.ai/tasks/deferred-fixes/state.json`（M 档 change）
- **已加载的 skill**：`.skills/harness/SKILL.md`（改动全落在 applies_to）

## 0 硬规则逐条核（harness skill H1–H9）

| # | 规则 | 结果 |
|---|---|---|
| H1 | hooks/scripts 改动同批带测试 | ✅ 每笔提交带断言（hooks 87→91、harness-cli 223→234、retro-check 9→11、evidence 68→70、verify-run 24→27、ai-review 27→34、notify-broker 补 16 断言） |
| H2 | 生成物禁手改 | ✅ 无生成物入批 |
| H3 | fail-closed | ✅ ci-verify 判重块曾误用未定义变量，node --check 拦于提交前（未流入） |
| H4 | 名单只写 config | ✅ 新增配置键 retroCheckFromDate 有消费者；词表/正则在 config |
| H5 | skill 约束 | ✅ check:skills 通过 |
| H6 | 新拦截有合法出口 | ✅ slug 命名约定写进拒绝文案；strike 有 --ack-strikes 具名出口 |
| H7 | 双 CLI 接线 | ✅ manifest 未变，check:hooks 无漂移 |
| H8 | 配置键有消费者 | ✅ 首版漏登记 init_flow_tier 被 doctor 双向契约当场拦下（门禁正确工作的实例） |
| H9 | 断言可证伪 | ✅ 复审发现的每个缺口都有探针复现，修复后同探针转绿 |

## 1 改动摘要

七项搁置清账（retro 机器判 / 日志绑 commit / S 档折叠 / 三次打回 / 拆分 / broker 幂等 / 缓存键 / runtime 回写）+ 复审加固六处。审查目标是这些新判据本身是否站得住。

## 2 阻断项 🔴（复审发现，均已当场修复）

| # | 来源 | 问题 | 处置 |
|---|---|---|---|
| R1 | 审阅A+自测 | **retro 三连洞**：`retro/../` 穿越、symlink 挂羊头、拖用他人/无主复盘文件全放行 | ✅ .. 段拒 + realpath 双侧解析（macOS /var 陷阱实测踩到并修正）+ 新任务文件名必须以 slug 开头 + ci-verify 全局唯一性（双声明双红） |
| R2 | 审阅A | **S 折叠可整链洗白**：中途改 flow_tier='S' 即直达 done；借他人 DFG 绿日志过 fold 加查 | ✅ init-harness 落 init_flow_tier 存底、中途改档即拦；fold 的 gate 日志归属头改强制（# task 必须=slug，opt-in 时借无头旧日志可绕） |
| R3 | 审阅A | **三次打回是死代码**：真实 state 的 gate 只有 pass/deferred，数 gate=fail 永远到不了 3 | ✅ 口径改"同阶段重复进入次数"（2f729f3）；代理指标偏早开通道的代价已表态（边界清单 #7） |
| R4 | 审阅B | **脏树 commit 戳伪造可复现性**：四份 DF 日志盖 7642f87 戳但内容含其后才存在的测试 | ✅ verify-run 脏树写 unknown（口径收窄为"跟踪文件源码改动、排除 .ai/verify"，未跟踪文件不参与）；DF 证据在干净源码树重刷为真戳 |
| R5 | 审阅A | **--task 不落日志头**：跨任务借证据无判据可拦，而注释自称"防跨任务" | ✅ verify-run 带 --task 写 # task: 头；S-fold 加查消费 |

## 3 建议项 🟡（已全部表态）

| # | 来源 | 问题 | 处置 |
|---|---|---|---|
| Y1 | 审阅A | 同线重放（旧绿日志原样重提）无判据 | 已表态：登记边界清单 #6——绑 commit 只证 lineage 不证"这次重跑过"，新鲜度挡一部分，再往上是签名链超出工具定位 |
| Y2 | 审阅B | runtime 读-改-写无锁，并发调用丢更新 | 已表态：单写者 CLI 场景不构成现实风险，代码注释记录；真需要再加 flock |
| Y3 | 审阅B | broker "先记账后记键"注释与实际语义不符（两种顺序等价） | 修：注释勘误如实写 |
| Y4 | 审阅B | ai-review 缓存键漏绑脚本自身版本 | 修：self sha 进缓存名（判定协议改在脚本里时旧结论不再沿用） |
| Y5 | 审阅B | usage 未列 runtime | 修：补条目 |

## 4 跨模块影响

| 调用方 | 影响 | 证据 |
|---|---|---|
| 拆分前后 19 组子命令对照 | 16 组字节级一致；init 差异恰为新增 12 个模板文件；函数 1:1 迁移无死代码 | 审阅B 双版本 worktree 对照 |
| verify-run 新头部（commit/task 行） | 旧日志解析不受影响（exit_code 窗口仍 5 行；task 窗口 8 行独立） | test:hooks/evidence/verify-run 全绿 |
| e7f9965 / 1253b45 晚到提交 | 与描述相符无夹带（scan-ok 注解 10 行；stale-task-gate 补账三文件） | 审阅B 逐 diff |

## 5 安全检查

注入：retro 路径穿越/symlink 已堵并有断言；越权：跨任务借 retro/借 gate 日志已堵（slug 命名 + 归属头 + 唯一性）；敏感信息：无新增日志输出；依赖变更：无。

## 6 测试覆盖

复审新增断言：借带头日志拦截（hooks 41 节）、双声明 retro 双红（retro-check 4 节）、脏树不盖戳（verify-run 10 节旁路验证）、缓存名含脚本哈希（ai-review）。最终：**npm run gate 全量绿（DFG，真戳）**，verify:state CI 口径绿，doctor 绿。

## 7 结论

- 🔴 数量：**0**（复审发现的 5 条全部当场修复并有断言）
- 🟡 已全部表态：是（Y1 边界登记、Y2 已知限制、Y3–Y5 已修）
- 建议：**approve（处置权在人）**。复审价值实打实：抓到 1 个死代码特性、3 个可绕过判据、1 类伪造证据戳——全部出自"实现者自己想不到的角度"；两位审阅者的报告留档 /tmp/review-{gate,cli}.md。
