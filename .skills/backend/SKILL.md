---
name: backend
stack: backend
version: 1.0.0
stage0: true
applies_to:
  - "backend/src/**"
references:
  - references/checklist.md
---

# Java 后端开发

管 `backend/` 下任何 Java 改动：新接口、改逻辑、补测试、修缺陷。
**不管**架构选型（走 ADR）、构建流水线配置（走 CI 配置）、前端。

## Stage 0（写码前强制）

| # | 读什么 | 为什么非读不可 |
|---|---|---|
| 0.1 | `references/checklist.md` | 8 条阻断级规则的反例与正例，违反即打回 |
| 0.2 | 要改的类 + 它的直接调用方 | 不知道谁在调它，改出来就是回归 |
| 0.3 | `harness.config.json` → `stacks.backend` | 验证命令以它为准，不凭记忆 |

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

> R8 在 `.ai/rules/verification.md` 第 2 条已经声明。**同一规则出现两处不算重复**：L0 是纪律，这里是本栈的查法。但检测命令只写在这里，别在别处再抄一份。

## 交付

1. 验证命令 + 原始输出落 `.ai/verify/<todo>.log`，`exit_code: 0` 且 mtime 晚于源码
2. 复查结论：改了哪些类、为什么落在这一层
3. 剩余风险：没覆盖的分支、依赖外部环境的用例
4. 一条可直接用的 commit message

## 按需加载

- 表结构 / 迁移脚本 → 必走 ADR（`docs/06-reference/adr/`），不直接改
- 新增权限点、鉴权排查 → `references/checklist.md` 末尾「按需场景」
- 并发 / 事务隔离 / 缓存失效 → 同上，先读完再动
