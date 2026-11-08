# CR-代码审查记录：演练缺口修复

> 任务：`.ai/tasks/drill-gaps-fix/state.json`（S 档）。skill：harness（Stage 0 本会话已完成）。
> 证据：`.ai/verify/DG-V1.log`（四套件 + 全链 gate，pipefail 语义，0 断言失败）。

## §0 硬规则逐条核（H1–H8）

| # | 结论 | 证据 |
|---|---|---|
| H1 | ✅ | scripts 改动 5 文件，同批新增断言：router +7（uncovered×4 / fs 路由 / 误报闸 / 提示）、ai-review +2（fs 🔴/verdict 点名）、notify-broker +1（卡片点名）、新文件 doctor-gates 9 断言 |
| H2 | ✅ | check:agents/check:hooks 绿（DG-V1 含 gate） |
| H3 | ✅ | uncovered 是提示不阻断（退出码 0 有专测）；fs 判据复用 requiredSections 未知 id 仍 fail-closed |
| H4 | ✅ | code_hints 扩展名清单在 rules 不在代码；fs 必填章节在 rules |
| H5 | ✅ | check:skills 绿 |
| H6 | ✅ | 无新拦截 |
| H7 | ✅（不适用） | 无新 hook |
| H8 | ✅ | 未加 harness.config.json 键；doctor 连接走 env（文档注明理由，避免空转键） |

## 改动摘要

演练四缺口落地：route() 返回 uncovered（代码文件无槽可归时 router 提示 + uncovered_code 入账 + broker mr_routed 携带 + 卡片点名）；fs 审核类型补槽（L0 章节判据 + fs.md 清单，语义交叉一致性留给有 key 环境）；doctor 门禁在场性两项（无 runner=阻塞、approval 不可用=提醒、未配连接=明示未检查）；guides 降级口径与 API 工作流姿势。

## 🔴 阻断项

无。

## 🟡 建议项（已表态）

| # | 问题 | 处置 |
|---|---|---|
| 1 | uncovered 依赖扩展名清单，改名的代码文件（无扩展名可执行）漏报 | 不改：清单可按仓库裁剪；无扩展名文件本就难判"是代码"，宁缺勿滥（checklist §6） |
| 2 | doctor 无 env 时每次 gate 都出一条"未检查"提醒 | 保留：提醒不阻塞且是诚实口径（"未检查≠通过"）；若团队嫌吵可 HARNESS_GITLAB_* 配上即消 |
| 3 | fs 语义审（FS-A1~A5）清单已写但无消费者（无 key 环境不跑） | 记录在 fs.md 头部 v1 说明；等 CI 配 key 后自然生效，不算空转（清单同时是 spec-reviewer 人的参考） |
| 4 | 测试过程踩到 heredoc 写不存在目录静默失败（set -uo 无 -e） | 已修（mkdir + 注释留教训）；generic 教训记入本 CR 供 retro 提炼 |

## 跨模块影响

route() 增返回字段 uncovered——三个消费者（router/ai-review/broker）中 router/broker 已消费，ai-review 未消费（类型变更未命中仍 exit 0"无需审核"，uncovered 在 router 层已提示）；notify renderMrCard 增可选字段，旧调用不传则不渲染（向后兼容，broker 已传）。

## 结论

🔴 0、🟡 4 已表态。通过。DG-V1 全绿。
