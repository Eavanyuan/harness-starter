# Java 后端规则详解

> 入口在 `../SKILL.md` 的「硬规则」表。这里放反例、正例和判断边界——**动手前要看的细节**，不是背景知识。
> 每条对应 SKILL.md 的 R#，编号不得重排。

## R1 分层：编排在 service

```java
// ✗ resource 里编排
@GET public Response get(Long id) {
    var row = mapper.selectById(id);
    var user = userService.load(row.userId());
    return Response.ok(assemble(row, user));
}

// ✓ resource 只绑定参数，编排在 service
@GET public Response get(@PathParam("id") Long id) {
    return Response.ok(service.loadDetail(id));
}
```

判断边界：resource 里**允许**参数注解、DTO 转换、`Response` 封装；**不允许**多个 mapper/service 的调用顺序编排。

## R2 入参校验

校验必须发生在**跨进程边界**（resource 入口）。service 内部的方法参数由调用方类型保证，不重复加 `@NotNull`。

```java
// ✗ 把校验推给 service，非法值一路下传
public Response create(CreateReq req) { return Response.ok(service.create(req)); }

// ✓ 边界拦住
public Response create(@Valid CreateReq req) { ... }
```

## R3 跨列 OR

```sql
-- ✗ 两列各走各的索引，优化器不做 index merge → 全表扫
WHERE user_id = ? AND (parent_id = ? OR child_id = ?)

-- ✓ 拆两条单列语句，各自走索引
WHERE user_id = ? AND parent_id = ?
WHERE user_id = ? AND child_id = ?
```

**同列多值不受限制**：`a = 1 OR a = 2` 等价于 `IN`，能走索引。
`<foreach separator=" OR ">` 拼出 `(a=? AND b=?)` 列表同样违规，改写为 `a IN (...) AND b IN (...)`（两列各自走索引），并注意空列表会生成 `IN ()` 语法错误。

## R4 事务边界

```java
// ✗ 注解加在 private 上，代理拦不到，事务不生效
@Transactional private void doWrite() { ... }

// ✗ 同类内部调用绕过代理
public void outer() { this.doWrite(); }

// ✓ 拆到独立 bean，或经注入的 self 引用调用
```

**只包必须原子的写范围。** 把远程调用、大循环、慢 I/O 包进事务是锁饥饿的常见起点。

## R5 配置与密钥

```java
// ✗
String url = "jdbc:mysql://10.0.0.7:3306/prod";
String token = "ghp_xxx";

// ✓ application.yml 外置 + 安全默认值
@ConfigProperty(name = "svc.endpoint") String endpoint;
```

新增配置键要给默认值，别让老环境起来就挂。环境相关的行为要写明落在哪个 profile 文件。

## R6 异常

```java
// ✗
throw new RuntimeException("not found");
// ✓
throw new ResourceNotFoundException(ErrorCode.E4041, id);
```

## R7 测试同步

改了可观测行为（返回体、状态码、排序、默认值、异常类型）就必须有对应测试。
**要改动存量测试才能通过时，先停下问人**——那通常意味着契约变了，而契约变更不是编码 agent 能单方面决定的。

## R8 禁变通参数

下列形态一律视为「让结果变绿」而非「修好」：

```text
-DskipTests   -Dmaven.test.skip=true   -Dskip.tests=true
-Dmaven.test.failure.ignore=true       -Dmaven.compiler.failOnError=false
--passWithNoTests                      -fn / --fail-never
@Disabled（无 TODO 说明原因的）
```

唯一例外：明确标注的「仅编译」任务，且必须在交付里写明「本次未运行测试」。

---

## 按需场景

### 新增权限点

顺序固定，漏一步就是 403 或越权：迁移脚本 → 权限声明 → 后端注解 → 前端指令 → 缓存刷新。
先确认 `state.stage_history` 里有对应 ADR，没有就先补。

### 鉴权排查

按「谁没权限 → 权限点是否存在 → 角色是否绑定 → 注解是否生效 → 缓存是否过期」逐层排，不要跳步改代码。

### 并发与锁

先画清楚：谁在写、锁的粒度、持锁期间做了什么 I/O。三问答不全就不要动代码——
这类改动属于「高复杂」，按 `.ai/rules/verification.md` 停点上报。
