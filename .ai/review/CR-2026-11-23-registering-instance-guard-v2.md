# CR 代码审查记录 — registering-instance-guard 独立复查（v2，审阅者子代理）

> 产出：独立复查（Saved Agent「审阅者」，与修复作者不同上下文——坑 #28 禁自审的落实）· 2026-11-23
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。
> 原审查：CR-2026-11-21-registering-instance-guard.md（同会话本地审查，参考但以本复查为准）。

- 审查范围：TDC worktree `../TDC-registering-fix`，`d143a228a..be80cf5d8`（2 文件 +104：AppController 守卫 + 回归测试）
- 关联 FS：无
- **已加载的 skill**：backend v1.1.0（R1–R11 逐条核，见 §0）；复查者另做了单测实测复跑（JDK 11，4/4 绿）

## 0 硬规则逐条核（backend v1.1.0）

R2 边界校验 ✓（守卫即边界、fail-closed 含 null）；R6 既有错误码+领域异常 ✓（436 复用与 uc 同语义，LoginController:211-213、UserServiceImpl:790-791）；R7 同批补测 ✓；R8 实测显式 -DskipTests=false、无变通 ✓；R1 守卫在 controller 与该类既有风格一致（余额检查同层 controller:198）✓；R3/R4/R5/R9/R11 不涉及；R10 createApp 非幂等为存量问题、非本 diff 引入。

## 1 复查结论：**approve with findings**（2 LOW + 2 INFO，无阻塞）

修复方向正确、最小、两端点覆盖、fail-closed。关键回退风险逐项排除（见 §4 必答摘录）。

## 2 阻断项 🔴

无。

## 3 建议项 🟡/LOW/INFO（均经主会话独立复核属实）

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| F1 LOW | AppController tsdb-asset 端点（LOGGER.info 在 :300、守卫在 :304） | 被拒用户的完整请求体（含 alias 等）先落日志才被守卫拒；与 createApp 守卫居首行不一致 | 守卫上移至 LOGGER 之前 | 待作者：建议随分支追加小 commit |
| F2 LOW | msgCode `user.not.activated` | console 的 messages*.properties 为数字键型（messages.properties:103 已有 `21436=Your account has not been activated yet!`），字符串 msgCode 无条目，i18n 回落异常默认英文 | 三份 properties 补 `user.not.activated` 条目（或直接改用数字键语义） | 同上 |
| F3 INFO | console/filter/JwtAuthenticationFilter:84-96 + application.yml ttl | principal（含 status）按 token 缓存 Redis 并续期：REGISTERING→ACTIVE 后沿用旧 token 的用户在 TTL 内仍被拒（反向 DISABLED 亦然）——存量缓存语义，非本 diff 引入 | 知悉；如需收紧属独立改造 | 不改（存量） |
| F4 INFO | AppControllerRegistrationGuardTest | 无「ACTIVE 放行 tsdb-asset 端点」对称用例（两调用点共用私有方法，风险低） | 可与 F1 同批补 | 待作者 |

## 4 回退风险排除（必答①要点，主会话已复核）

- `/tsdb-asset` 全仓唯一出现于 AppController:294；POST /app 无任何 Java/Feign 服务间调用方；InternalAppController 仅 GET；marketplace/aws/azure 检查在建实例流程内部且仍由前端驱动走这两个 HTTP 端点——**守卫不影响任何自动开通链路，调用方只有 web 前端**。
- 生产 principal 构造点仅三处（console JwtAuthenticationFilter 缓存反序列化/uc-client checkToken、dev-only DevJwtAuthenticationFilter、UC UserFactory copyProperties），status 均必被填充——**不存在无 status 的合法 principal**。
- UserStatus 共 5 态（INVITED/REGISTERING/ACTIVE/DISABLED/DELETED），INVITED 首登即转 REGISTERING，无合法建实例场景——**只放行 ACTIVE 无误伤**。

## 5 验证边界

检视 + 单测实测（JDK 11 复跑 4/4 绿）；未验证运行时端到端（需 console+UC+Redis 环境）与前端对 msgCode 的处理（前端仓不在本仓）。
