# CR 代码审查记录 — tdc-sidecar：TDC 旁挂注册 harness-starter（本地审查）

> 产出：本地手动审查（AutoClaw 会话）· 2026-11-21
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。
>
> 两种路径都必须先跑 `node scripts/resolve-skills.mjs --diff` 并按命中 skill 的硬规则表逐条核。已执行。

- 审查范围：工作区 diff（未提交）——`harness.config.json`、`harness.rules.json`，及新增 `.ai/tasks/tdc-sidecar/`（rs.md/state.json）、`.ai/verify/TDC1.log`、`.ai/verify/TDC2.log`
- 关联 FS：无（配置注册，无行为判定变更）
- 关联 SR 报告：无
- **已加载的 skill**：`resolve-skills --diff` 命中 → deployment v1.0.0（命中 harness.config.json, harness.rules.json）、harness v1.1.0（命中 harness.config.json）；两份 SKILL.md 全文 + deployment 的 pitfall-checklist（50 条）已读

## 0 硬规则逐条核（命中 skill 的规则表，必填）

### deployment skill 硬规则

| # | 规则 | 检测命令 | 结果 |
|---|---|---|---|
| D1 | init 后必须 `npm run gate` 开箱绿 | 本次为旁挂注册非 init；gate 走 close 流程 | ⏸ 暂缓（并发会话在途，见 §3-3；CLOSE todo 已挂） |
| D2 | 影子周 N≥30 且 0 误触发才转真跑 | 未接 task-loop 接单（TDC 迭代未开通道） | ✅ 不适用（显式不接 ≠ 忘了接，rs 开放问题 2） |
| D3 | 凭据只进 0600 文件 | 本次不涉及凭据 | ✅ |
| D4 | 旁挂模式下目标仓零 harness 文件 | `git -C ../TDC status --short \| grep -v '^??'` → 仅 `.gitignore` 有 harness 标记残留 | 🔴 遗留（2026-10-31 内嵌副本所致，**非本次引入**；处置挂 rs 开放问题 1 待用户裁决） |
| D5 | skipTests 陷阱必须显式绕过 | test 命令含 `-DskipTests=false` 且实测 | ✅（并实测出更强的坑：四模块硬编码 -D 翻不动，已入 envNotes） |
| D6 | 前 2-3 张单手动走全流程再放开自动 | 后续 license-center-sms 续跑时执行 | ✅ 计划内 |

### harness skill 硬规则

| # | 规则 | 检测命令 | 结果 |
|---|---|---|---|
| H1 | 改 hooks/scripts 同批补测试 | `git diff --name-only HEAD \| grep -E '^(hooks\|scripts)/'` | ✅ 空（未改 hooks/scripts，无义务） |
| H2 | 生成物禁手改 | 未触碰 .claude/.zcode/prompts；`check:skills` 绿 | ✅ |
| H3 | 解析失败 fail-closed | 未改判定代码 | ✅ N/A |
| H4 | 黑名单只写 config | 未新增黑名单 | ✅ N/A |
| H5 | skill Stage 0 ≤5 项/≤200 行 | 未改 skills | ✅ N/A |
| H6 | 新拦截规则同批给合法绕过 | 无新拦截 | ✅ N/A |
| H7 | 新 hook 双 CLI 接线 | 无新 hook | ✅ N/A |
| H8 | 新配置键必须有消费者 | 未新增键，只新增值；消费者实跑：doctor ✓（dir/命令反查）、check-skills ✓（id=backend 合法栈）、review-router（cr paths_from，既有机制） | ✅（TDC1.log） |
| H9 | 断言可证伪（变异） | 变异实测：test 命令去掉 `-Dtest` 过滤 → 红（mgmt-client 502×4、azure-marketplace AAD×2，见 TDC2 首跑）；JAVA_HOME 换回缺省 Java 23 → billing 编译红 | ✅ 两种变异均红过（留档于会话记录与 envNotes） |

## 1 改动摘要

把 TDC（rd-app/cloud.git）以旁挂模式注册进 harness-starter：`projects[]` 新增 backend 条目（dir/srcGlob/lint/test/testOne 全部为实测过的命令），`envNotes` 增补四条 TDC 环境事实（JDK 11 钉死、skipTests 硬编码模块清单、指定测试类形态、离线不绿全景），`notes` 记录旁挂决策与内嵌副本待清理状态。不改任何判定逻辑、门禁与生成物——别人「什么算合格」的定义不变。

## 2 阻断项 🔴

| # | 位置 | 问题 | 依据 | 建议 |
|---|---|---|---|---|
| 1 | （非本次 diff）TDC 仓 `.gitignore` + 未跟踪 harness 文件 | D4 遗留：目标仓存在 10-31 内嵌副本（projects 空置、证据曾误提交 a97fb4837 后删） | deployment skill D4 | 归档后清理 + 还原 .gitignore（待用户裁决，rs 开放问题 1） |

本次 diff 自身 🔴 = 0。

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | projects[].test 作用域 | 收窄到 `PublicController*Test` 是离线真绿的权宜口径，回归网小 | 有内网环境/AAD env 方案后扩大作用域，扩前先验离线绿（envNotes 已写） | 延后（有据） |
| 2 | harness.config.json lint/test 内嵌绝对路径 | 绝对路径是本机事实（与 envNotes 同口径），换机器需改配置 | 保持现状：envNotes 本就是「宿主环境事实」唯一事实源的既有设计 | 不改（理由：与 TDasset envNotes 机制一致） |
| 3 | 收尾 close 暂缓 | 并发会话在本仓改 test-selfcontain（TS1 红、state 半成品），此刻跑全量 gate 会撞其 WIP 且被其污染 | 待 test-selfcontain 落定后执行 `harness-cli close`（CLOSE todo 已挂） | 延后（坑 #45 串行纪律） |

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| doctor（projects 消费：dir 存在性、命令黑名单反查） | 否（新增条目全绿） | TDC1.log |
| check-skills（projects[].id → 合法栈集合） | 否（backend 已存在，Set 去重） | TDC1.log 5 skill 通过 |
| review-router / cr `paths_from=projects` | 行为扩展：cr 源码路径新增覆盖 ../TDC（既有 TDasset 不变） | config-keys.md 消费清单 |
| task-loop 工单渲染（envNotes） | 行为扩展：TDC 工单将带四条新事实 | harness.rules.json $comment（envNotes 随工单渲染） |
| TDasset 两条 projects 既有条目 | 否（未触碰） | diff 仅新增 |

## 结论

approve（本次 diff 🔴=0，🟡 三项均已表态：延后×2 有据、不改×1 有理由）。D4 遗留与 close 暂缓为**外部依赖项**，已分别挂 rs 开放问题 1 与 CLOSE-GATE todo，不掩盖。
