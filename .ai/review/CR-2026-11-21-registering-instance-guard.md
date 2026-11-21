# CR 代码审查记录 — registering-instance-guard：实例创建加用户状态门（本地审查）

> 产出：本地手动审查（AutoClaw 会话）· 2026-11-21
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。

- 审查范围：分支 `fix/registering-instance-guard`（基于 origin/main d143a228a），2 个文件——`AppController.java`（+守卫）、`AppControllerRegistrationGuardTest.java`（新增）
- 关联 FS：无（bugfix，缺陷证据=会话内代码分析：console/gateway 全量无 UserStatus 检查、创建端点无状态门）
- **已加载的 skill**：改动为 tdc-console 下 Java → backend skill（`.skills/backend/SKILL.md` v1.1.0 已读，含 Stage 0 与 references/checklist.md 硬规则表）

## 0 硬规则逐条核（backend skill 硬规则表）

> backend skill 硬规则逐条核（源：harness-starter .skills/backend/SKILL.md）：

| # | 规则 | 检测命令 | 结果 |
|---|---|---|---|
| B1 | 编排在 service 不在 resource（分层） | 守卫位于 controller 入口（先于任何 service 调用），未引入跨层调用 | ✅ |
| B2 | 入参在边界校验 | 守卫即边界校验（principal 状态 + null 防御），先于余额检查 | ✅ |
| B3 | 事务内不做 RPC | 无事务语义变化 | ✅ N/A |
| B4 | 测试断言行为不断言实现 | 断言 436 码 + 下游 never/verify 调用，非实现细节 | ✅ |
| B5 | 回归测试先红后绿（复现） | 修复前行为=缺陷本身；变异摘守卫→3 红，复现路径等价成立并留档（RIG1 audit.tests） | ✅ |
| B6 | 不引入新依赖/新配置键 | 仅用既有 commons 异常与枚举 | ✅ |

## 1 改动摘要

在 AppController 两个实例创建端点（`POST /app`、`POST /app/tsdb-asset`）入口增加 `ensureRegistrationCompleted`：非 ACTIVE 状态（含 null principal）抛 `CommonsException(436 NOT_ACTIVATION_ERROR, "user.not.activated")`，且先于余额检查。修复"注册未完成用户可创建 tsdb 实例"的服务端授权缺失（此前防线只有前端路由）。新增 4 用例离线回归测试（纯 JUnit+Mockito，不起 Spring 上下文）。

## 2 阻断项 🔴

无。

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | ClusterController 生命周期端点 | 同类"资源操作无用户状态检查"缺口仍在（仅资源级 @RequiresPrivileges） | 另开任务以拦截器形态统一收口 | 延后（rs 开放问题 1 登记） |
| 2 | 436 错误码复用 | uc 侧 436=NOT_ACTIVATION_ERROR 语义一致，前端已有处理路径概率高 | 合入后验证前端对 console 域 436 的表现 | 延后（需前端联查） |
| 3 | AppControllerTest（Spring 上下文型） | 依赖本地环境，离线不可跑，本次未触达 | 环境化测试治理另行处理 | 不改（回归由新增离线单测承担） |

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| 前端实例创建页（TDC-UI） | ACTIVE 用户零变化；REGISTERING 用户由"可创建"变 436 | 守卫仅拦截非 ACTIVE |
| tsdb-asset 打包开通（IDMP 上云动线） | 同上，ACTIVE 不受影响 | 同一守卫、同一判定 |
| billing（余额/价格计划） | 否——判定发生在其上游 | verify(orgService, never()) 用例 |
| 已有 ACTIVE 用户的存量实例 | 否——只影响新建动作 | 无数据迁移、无 schema 变更 |

## 结论

approve（🔴=0，🟡 三项均已表态）。变异验证成立（摘守卫→3 红），证据 .ai/verify/RIG1.log（4/4 绿，exit 0）。
