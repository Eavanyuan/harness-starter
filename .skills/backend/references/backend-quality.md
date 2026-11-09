# 后端质量：越权、幂等、迁移

> 素材来源：globalmpc/backendskills（MIT）的 api-endpoint / data-integrity / db-migration。
> 只保留能被一条命令或一次 diff 判定的部分；判断型原则标「建议」，不进硬规则表。
> 上游 commit 锚：`globalmpc/backendskills@6131a31`（改写而非复制，内容已按本仓库 R1–R8 去重）。

这三条填补的是 R1–R8 没管的空洞：**R1–R8 管「代码写在哪、怎么组织」，
这里管「写出来的东西在越权 / 并发 / 迁移上会不会炸」。**

---

## R9 查询必须限定调用者可见范围

**病灶**：拿到主键就查、就返回，没校验这条数据属不属于当前调用者。前端传 `id=42`，
后端就返回 42 号订单——这叫 IDOR（越权访问），是最常见也最容易被扫描器漏掉的一类。

**判据**：`selectById` / `getById` / `findById` 按主键直取之后，同一个方法里必须有
owner / tenant / user_id 维度的过滤或归属校验。**没有就是违规**，不是「待确认」。

```bash
rg -n 'selectById|getById|findById|selectOne' backend/src/main/java
```

命中后逐个确认（与 R3 同一套手法：先定位，再人工判）：

1. 这个方法是否对外暴露（resource / controller 里被调用）？
2. 主键是从请求参数直接来的，还是从当前登录态推出来的？
3. 有没有第二步校验归属？只查 `deleted = 0` **不算**归属校验。

**修法优先级**：把归属条件下推到 SQL（`WHERE id = ? AND tenant_id = ?`）> service 里查完再比对 > 只在前端藏按钮（无效，不算修）。

> ⚠️ **这条不可机判**。grep 只能帮你找到候选，无法判断「有没有归属校验」——
> 那取决于业务语义。所以它**不进 CI 门禁**，只在 `/cr` 的审查清单里作为必答项。
> 别在任何地方声称这条被门禁覆盖。

---

## R10 写操作幂等，读改写走锁

**病灶**：两个请求同时进来，各查一次「余额够」，各扣一次，钱就少了。
或者用户双击提交，生成两笔订单。

**判据（两部分，都要）**：

**写操作必须有幂等手段**——以下三者至少一个：

- 幂等键（`Idempotency-Key` 头 / 业务唯一号 / `requestId`）+ 唯一约束兜底
- 数据库唯一索引（最可靠，不依赖应用层判断）
- 状态机前置校验（「已支付」不允许再支付）

```bash
rg -n 'Idempotent|idempotent|Idempotency|requestId|request_id' backend/src/main/java
```

**读改写必须防止并发覆盖**——`select` 之后 `update` 之间没有锁，就是丢失更新：

```bash
rg -n '@Version|for update|FOR UPDATE|setIfAbsent|compareAndSet' backend/src/main/java
```

以及扫描「先查再改」的裸更新形态：

```bash
rg -n -U 'selectById[\s\S]{0,400}?updateById' backend/src/main/java
```

命中后确认：中间有没有版本号 / 行锁 / CAS。三样都没有 = 丢失更新风险。

**「并发与锁」三问仍在 checklist 里**（谁在写、锁的粒度、持锁期间做了什么 I/O）。
R10 是它的可判定下限，不是替代——三问答不全的改动按「高复杂」停点上报。

> 幂等键的「有没有」可机判；「键选得对不对」（业务唯一性够不够）不可机判，属审查范围。

---

## R11 迁移必须可回滚，破坏性变更分两步

**病灶**：加了列没写 down，回滚时只能手工改库；或者直接 `DROP COLUMN`，
旧版本代码还在读这一列，发布窗口内直接 500。

**判据一：up/down 必须配对**

```bash
# 按项目实际迁移目录调整（Flyway 默认 db/migration，Liquibase 改 changelog 路径）
ls backend/src/main/resources/db/migration/ 2>/dev/null | sort
```

版本号成对出现即合规；只有 up 没有 down，或命名不成对 = 违规。
**改这里要同步改本节的路径**，否则判据会静默失效（与 verify-run 那次教训同类）。

**判据二：破坏性变更必须 expand-then-contract**

```bash
rg -n 'DROP COLUMN|DROP TABLE|MODIFY COLUMN|ALTER COLUMN|RENAME COLUMN' backend/src/main/resources/db
```

命中任一即要求两步走，**一次迁移只做一步**：

| 阶段 | 做什么 | 为什么不能合并 |
|---|---|---|
| expand | 加新列（可空）/ 加新表 / 双写 | 旧代码还在读旧结构，必须同时可用 |
| migrate | 回填数据、切读路径 | 回填要能重跑，且不锁全表 |
| contract | 删旧列 / 加非空约束 | 等所有实例都跑新代码之后 |

`NOT NULL` 无默认值加列、大表加索引不 `CONCURRENTLY`，都属同一类：**会锁表的 DDL，
必须单独一次迁移，且写进交付说明的「发布顺序」**。

> 判据一可机判（文件配对），判据二只能定位候选（是否需要两步取决于表大小与发布方式）。
> 所以**只有判据一适合进 CI**，判据二留给 review。

---

## 不适用本仓库的部分（明说不抄）

- 上游的 `bench/`（20 个买家抢 5 件库存这类隐藏用例）是**它的**评测，不是我们的验收。
  看了有用，但不构成判据。
- 上游的安装建议（append `dist/AGENTS.md`、copy `dist/cursor/`）在本仓库**是错的**：
  `AGENTS.md` 是 `build-agents.mjs` 的生成物，手改会被 `--check` 判漂移。
- 限流、4xx 语义：属接口契约层，归 FS 与 `/sr` 管，不在 skill 里重复。
