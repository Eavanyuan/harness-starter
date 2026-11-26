# CR 代码审查记录 — harness feishu（工作项接料）独立评审与修复

- 审查范围：本地未提交 diff（基线 f78a9c7，任务 `feishu-task-intake`，S 档 feature）
- 关联 RS：`docs/01-requirements/RS-飞书任务接入.md`
- 独立评审：会话隔离的审阅者子代理（未接触实现过程，按 H1–H9、T1–T7、US-1~4、R1–R9 逐条对照；实测跑了 `node --check`、`test:feishu-intake`、`doctor`、并实测"拿掉 python3 后变异检验判绿"）
- **已加载的 skill**：`resolve-skills --diff` 命中 deployment（含 pitfall-checklist）与 harness 两个，§0 按两份硬规则表逐条核
- 验证阶梯：独立评审（maker-checker）→ 本会话逐条复核实测 → FTI1/FTI3 证据日志（verify-run 包装）→ close 的 CLOSE-GATE 全量

## 0 硬规则逐条核（harness skill H1–H9；deployment skill 见下方附注）

| # | 规则 | 检测命令 / 方式 | 结果 |
|---|---|---|---|
| H1 | 改 scripts/** 必须同批有测试 | 本批 scripts 改 6 个文件，test/ 同批改 5 个（assert 新增 34 条断言、test.sh fail-closed、pitfall/rs 同步） | ✅ |
| H2 | 生成物禁止手改 | 本批未触碰 `.claude/`、`.zcode/`、`prompts/`；`npm run check:agents && npm run check:hooks` 在 gate 里跑 | ✅ |
| H3 | 解析失败必须 fail-closed | `ci-verify --json` 输出判读不了 → `checkRan=false` → `verified=false`、退出码 1、输出"没跑成"；评论/关联/负责人返回形态不认识 → 进未读取清单并列为待决，不当成空（变异 9 钉住） | ✅ |
| H4 | 保护名单只写配置，代码不出现字面量 | 本批未新增仓库保护/黑名单字面量；`READ_ONLY_TOOLS` 是飞书接口的工具白名单（外部接口能力面，非仓库保护配置），独立评审将其核为"约束有机器判据且测试覆盖" | ✅ |
| H5 | skill 结构约束 | 本批只改 SKILL.md 与坑清单的计数文字，未动 Stage 0；`npm run check:skills` 在 gate 里跑 | ✅ |
| H6 | 新增拦截规则须带合法绕过 | 未新增拦截规则（只读闸在本任务上一轮已有，摘要里写明确认命令即放行路径） | 不适用 |
| H7 | 新增 hook 双 CLI 接线 | 未新增 hook | 不适用 |
| H8 | 配置键必须有消费者 | `runtime.feishu.intake.*` 消费于 `validateIntakeCfg(feishu.intake)`；doctor 的 CONSUMED 锚点由裸 `intake` 改为带命名空间的 `feishu.intake`（裸键名会被 import 路径误满足，恒真——评审抓到）；`npm run doctor` 实测"配置键均有消费者（20 个）" | ✅ |
| H9 | 新增断言必须可证伪并附变异 | 变异清册 9 条全部变红（FTI1.log 可对账）；新增断言类各对应：关联项→变异 7、确认人落盘→变异 8、校验器判读→变异 9；CLI"入参先于网络"→手工变异（把提前校验改掉，B11"被拒时没碰凭据"红，凭据被碰 11 次）；rs 检查器反向验证 19 项 | ✅ |

deployment skill 附注：#54（解析外部返回先看实物）在本轮由"关联字段必须带 `relation_field_key` 逐个查、`role_members` 实测形态后取值"继续落实；本轮新教训入库为 **#56**（检验脚本自己跑不起来时必须判红），计数五处同步（清单标题、追记小节、SKILL.md×2、README×2、测试 TOTAL）。

## 1 改动摘要

`harness feishu <ID或链接>`：读飞书工作项（只读）→ 生成带依据的类型建议与摘要 → 人确认后建档，未答问题写成阻断走 `resume`。本轮是独立评审后的修复轮：补读关联工作项、堵三处"失败被当成通过"的口子（校验器判读、形态不认识、变异检验假绿）、确认人落盘、入参先于网络，及文档同步。

## 2 阻断项 🔴（独立评审提出，全部已修）

| # | 位置 | 问题 | 依据 | 处置 |
|---|---|---|---|---|
| 1 | `scripts/lib/feishu-intake.mjs` 只读白名单 | R3"关联工作项"既没读、也不进未读取清单——父单/重复单信息静默缺席 | RS §4 R3 | 已修：白名单加 `list_related_workitem`；实测该接口必须带 `relation_field_key`，按该类型字段表的关联类字段（`field_type` 前缀 `workitem_related`）逐个查；返回非 `{list}` 形态报"形态不认识"进未读取。真实冒烟：7176122491 读出迭代周期「IDMP-2.0.4.0」、修复版本「IDMP-2.0.3.11」、引入版本「IDMP-2.0.3.1」。变异 7 钉住 |
| 2 | `test/feishu-intake.test.sh` 变异段 | `python3` 不在 PATH 时 heredoc 静默失败 → "变异全部做成"判绿、循环空转、整体"通过"退出 0（评审实测复现） | T3 / H9 | 已修：python3 存在性与退出码单独判；变异做成条数与期望条数（由生成侧写入）对账；清单缺失即红。变异 7/8/9 加入时断言用例漏写，被这个机制当场抓住（"变异后 exit=0"判红），补齐后全红 |

## 3 建议项 🟡（评审提出 6 条 + 仅记录 4 条，全部已修）

| # | 问题 | 处置 |
|---|---|---|
| 1 | `verified` 不看校验器退出码，靠正则刮人读文本；崩溃时没红行就报"通过" | 改用 `ci-verify --json` 结构化输出（先实测该模式存在且形态为 `{ok,problems,notices}`）；三态判定 `checkRan`（跑成了没）/`verified`（新档案没红项）/`repoClean`（整仓全绿）；只认点名新任务的问题行；判读不了=没跑成≠通过（变异 9） |
| 2 | 评论/负责人返回形态不认识时静默当空 | 三处（评论、关联、负责人）形态不认识 → 报进未读取清单并汇入"材料是否关键"待决项；负责人区分 absent（返回里没这个字段，不算失败）与 unknown（形态不认识，算失败）。`role_members` 真实形态已实测（`work_item_attribute` 下 `{key,name,members:[{name,email}]}` 数组，默认请求才返回） |
| 3 | NOTES.md 只列字数；classify 不看它，人补完材料仍被建议"重跑" | 摘要列出补充材料实际内容（>600 字截断注明）；classify 读 `notesLength`，描述过短但已补材料 → 推荐翻转为"按现有描述和补充材料继续" |
| 4 | 先连飞书再校验入参（ID 错也先登录）；对应断言是恒真（断的是新造的通道） | CLI 先 `parseWorkItemRef` 再 ensureToken/connect；依赖可注入（deps 参数）；B11 改为断言真实通道的调用次数为 0，手工变异证明可红 |
| 5 | doctor 的 `intake` 检查恒真（被 import 路径满足） | CONSUMED 锚点改 `feishu.intake`；`config-keys.md` 登记 `runtime.feishu.intake.*` |
| 6 | `--by` 只校验不落盘 | `meta.confirmed_by` / `meta.confirmed_at` 写进档案；确认输出同时显示来源 ID 与确认人（来源从真实工作项 ID 取，不再从 slug 反推）；变异 8 钉住 |
| 记 1 | 摘要"下一步"命令不带 target，显式传仓库路径时照抄会跑错目录 | 命令带上 target（`.` 时省略） |
| 记 2 | "材料是否关键"无推荐值，与 US-2"每项带推荐"不符 | 给保守推荐"关键：我来提供内容"（缺料确认正是本功能要防的） |
| 记 3 | 章节判定口径不一致：仓库检查器去编号全等匹配，我的检查器子串匹配，`开放问题的决定（…）` 标题两边判定相反 | 标题回归 `## 8 开放问题`，用户确认信息挪进正文；两边检查器现在同判 |
| 记 4 | US-4 验收标准仅 1 条 Given/Then | 补第二条（调用面只含白名单工具 + 确认人落盘） |

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| task-loop 剖面 B（lib/feishu-bug-source） | 否 | 独立入口，不共享 lib/feishu-intake 的任何导出；`test:task-loop` 单独跑 154/0 |
| `ci-verify.mjs` | 否（只新增调用方） | `--json` 模式为本批之前已有，先实测后接入；confirm-real 在仓库副本上跑真 ci-verify 12 条全过 |
| `harness-cli` / usage | 是（新增 feishu 行） | `test:harness-cli` 在 gate 里跑 |
| resume / decisions | 否（复用，未改） | confirm-real 的 resume 回环 12 条实测 |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入（命令/模板） | 建档参数走 spawnSync 数组形态，不经 shell 拼接；slug 校验复用 init-harness 同款正则 |
| 越权 | 对飞书只读：白名单外工具名直接抛错、请求不发出（变异 4）；确认只写本地档案 |
| 敏感信息进日志 | OAuth 凭据不进日志与摘要；附件落在 git 忽略的 `.ai/intake/` |
| 依赖变更 | 无新增依赖（PDF 解析用本机 pypdf，缺失标注不阻断） |

## 6 测试覆盖

- 单元 43、读取阶段 77、真实建档 12（仓库副本上跑真 init-harness / 真 ci-verify / 真 resume 两步）；变异 9 条全红 + CLI 手工变异 1 条（B11）
- 规格检查器 19 项反向验证（含"待决引用改指术语表""§9 越界"两类拦截）
- 真实冒烟（7176122491，只读）：7 字段、评论 2、关联 3 条、负责人 7 角色、建议 bugfix/把握高；建档数 0
- 正负向：被拒路径 8 条（没读取结果/缺记名/类型枚举/缺基线/有更新/同名任务/非法 slug/非法 ID）均"不建档、不留文件、不调脚本"
- 判定口径三态由假校验器三情形单独钉住（没跑成 / 自己红 / 别人红）

## 7 结论与遗留

🟡 0 未表态，🔴 0 未修 → **通过（修复后复核）**。已知局限（写进 RS §6/§8，交付说明复述）：规则版读不懂内容（描述与附件数量矛盾实测漏判）；评论附件路径未实测到样本；云文档正文读不了；`harness feishu` 编排层除 B11 外无自动化覆盖（真实冒烟补）。流程侧：`npm run gate` 的自指困境（gate 日志被 state 引用后，verify:state 在 gate 进行中判红）按 retro/mr-verb-trigger 的 CLOSE-GATE 两阶段处理——业务 TODO 不引用 gate 日志，整仓证据归 close 补的 pending 条目；本任务 state 已按此重构（FTI2 并入 FTI1）。
