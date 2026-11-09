---
name: backend
stack: backend
version: 1.1.0
stage0: true
applies_to:
  - "backend/src/**"
references:
  - references/checklist.md
  - references/backend-quality.md
---

# Java 后端开发

管 `backend/` 下任何 Java 改动：新接口、改逻辑、补测试、修缺陷。
**不管**架构选型（走 ADR）、构建流水线配置（走 CI 配置）、前端。

## Stage 0（写码前强制）

| # | 读什么 | 为什么非读不可 |
|---|---|---|
| 0.1 | `references/checklist.md` | R1–R8 的反例与正例，违反即打回 |
| 0.2 | 要改的类 + 它的直接调用方 | 不知道谁在调它，改出来就是回归 |
| 0.3 | `harness.config.json` → `stacks.backend` | 验证命令以它为准，不凭记忆 |

> 改到**查询、写操作、迁移**时，先读 `references/backend-quality.md`（R9–R11）。
> 不改这三类就不用读——它是按需的，不在 Stage 0 必读里。

前置自检（全 ✅ 才允许 Edit / Write）：

- [ ] 0.1 的规则逐条看过，能说出本次改动命中哪几条
- [ ] 已找出直接调用方：`rg -n '类名' backend/src`
- [ ] 知道验证命令，并确认它不是「跳过测试」的形态
- [ ] 知道对应测试文件在哪、要补哪些用例

## 分流

| 走哪条 | 判据 |
|---|---|
| 全流程 | 新增接口 / 表结构或 DTO 变更 / 跨层改动 / 范围不清 |
| debug 快速路径 | 修失败测试 / 已知异常分支 / 局部行为改动 |

debug 路径只允许改方法体内部。**一旦要动签名、SQL、配置或跨类调用，立即切回全流程**，切换点写进 `state.stage_history`。

## 硬规则

| # | 规则 | 怎么查 |
|---|---|---|
| R1 | 编排在 service，不在 resource。resource 只做参数绑定与响应封装 | diff 里 `**/resource/` 出现 `mapper.` 或跨多个 service 的编排即违规 |
| R2 | 入参在边界校验，不把非法值往 service 深处推 | 对照新增接口：`rg -n '@Valid\|@NotNull\|@Positive' backend/src/main/java` |
| R3 | SQL 的 WHERE 禁止对不同列用 `OR`（三库都不做跨列 index merge，整句退化为全表扫） | `rg -n '\bOR\b' --glob '*.xml' --glob '*.sql' backend/src`；**命中后逐个确认分支是否共用索引**——同列多值（`status='A' OR status='B'`）等价 `IN`，不算违规。注解 SQL 另查 `@Select`/`@Update` |
| R4 | 事务注解只加在**可被拦截的非 private** 方法；同类内部 `this.xxx()` 不走代理 | `rg -n -A1 '@Transactional' backend/src`，下两行出现 `private ` 即违规 |
| R5 | 新配置项进 `application*.yml`，不写内联常量；禁硬编码密钥/端口/本机路径 | `rg -n 'password\|passwd\|secret\|token\|/Users/\|/home/' backend/src/main/java` |
| R6 | 抛领域异常或既有错误码，不抛裸 `RuntimeException` | `rg -n 'throw new RuntimeException' backend/src` |
| R7 | 改了行为必须同次补测试；要改存量测试先问人 | diff 里源码与测试的文件数——只有源码、没有测试即违规 |
| R8 | 不许用变通参数让构建变绿（`-DskipTests`、`failOnError=false`、`failure.ignore=true`） | `rg -n 'skipTests\|skip\.tests\|failure\.ignore\|failOnError' --glob '!*.md'` |
| R9 | 查询/更新必须限定调用者可见范围：`selectById` 拿到就返回、不校验归属 = 越权（IDOR） | `rg -n 'selectById\|getById\|findById\|selectOne' backend/src/main/java`，逐个确认有无 owner/tenant 过滤。**这条不可机判，不进 CI**，只在 `/cr` 必答 |
| R10 | 对外写操作必须幂等（幂等键 / 唯一索引 / 状态机前置校验三选一）；读改写必须有 `@Version` 或行锁 | `rg -n 'Idempotent\|Idempotency\|request_id\|@Version\|for update' backend/src/main/java`；再扫「先查后改」：`rg -n -U 'selectById[\s\S]{0,400}?updateById'` |
| R11 | 迁移必须有配对 down；破坏性变更（删列/改类型/加非空无默认）必须 expand-then-contract 分两步 | 迁移目录 up/down 文件配对数不符即违规；`rg -n 'DROP COLUMN\|MODIFY COLUMN\|NOT NULL' backend/src/main/resources/db` 命中即要两步方案 |

> R8 在 `.ai/rules/verification.md` 第 2 条已经声明。**同一规则出现两处不算重复**：L0 是纪律，这里是本栈的查法。但检测命令只写在这里，别在别处再抄一份。

> R9–R11 的判据、反例与「哪些不可机判」写在 `references/backend-quality.md`。
> 这三条与 R1–R8 分工不同：R1–R8 管**代码写在哪**，R9–R11 管**写出来会不会在越权/并发/迁移上炸**。

> R7 只要求「补了测试」，不保证断言有效。恒真断言、注释掉的断言、吞异常的 `try/catch`
> 都能让测试绿着而什么都没测（上周实测 3 条）。判据见 `.skills/harness/references/test-quality.md`
> ——跨栈共用一份，**不要在本文另写一套**，否则两处必然漂移。

## 交付

1. 验证命令 + 原始输出落 `.ai/verify/<todo>.log`，`exit_code: 0` 且 mtime 晚于源码
2. 复查结论：改了哪些类、为什么落在这一层
3. 剩余风险：没覆盖的分支、依赖外部环境的用例
4. 一条可直接用的 commit message

## 按需加载

- 表结构 / 迁移脚本 → 必走 ADR（`docs/06-reference/adr/`），不直接改；落地前先按 R11 判 up/down 配对与是否需两步
- 新增权限点、鉴权排查 → `references/checklist.md` 末尾「按需场景」
- 并发 / 事务隔离 / 缓存失效 → 同上，先读完再动
- 越权（IDOR）/ 幂等键 / 迁移 expand-contract → `references/backend-quality.md`
