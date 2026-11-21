# RS — registering-instance-guard：注册未完成用户可创建 tsdb 实例（授权缺失修复）

## 背景与痛点

线上观察：某用户状态停在「注册中」（REGISTERING，注册未完成）却已创建出 tsdb 实例。分析确认这是服务端授权缺失，不是设计行为：

- uc 的状态机允许 REGISTERING 用户登录（登录态服务于"补全信息"流程，仅靠前端引导到补全页）；
- 被邀请/asset/marketplace 来源的 REGISTERING 用户已绑定 accountId；
- console 的实例创建端点（`POST /app`、`POST /app/tsdb-asset`）只检查余额（FREE 档豁免）与价格计划，**全链路（console/gateway）没有任何用户状态检查**，UserPrincipal 里现成的 status 字段无人消费。

影响：未完成注册（甚至尚未设置密码）的账户可开通真实 tsdb 实例（含 tsdb+asset 打包开通），消耗集群资源、破坏"完成注册才有实例"的业务不变量。

## 用户故事

作为云平台运营者，我希望实例创建（以及一切资源开通）以完成注册（ACTIVE）为服务端强制前置，使"前端路由"不再是对未完成注册用户的唯一防线。

## 核心需求

1. `AppController` 两个创建端点入口增加用户状态门 `ensureRegistrationCompleted`：非 ACTIVE（含 null principal）抛 `CommonsException(NOT_ACTIVATION_ERROR=436, "user.not.activated")`，且必须发生在余额检查等任何下游动作之前。
2. 回归测试（离线可跑，纯 JUnit+Mockito，不起 Spring 上下文）：REGISTERING 被 436 拒绝且无下游调用、null principal 拒绝、ACTIVE 放行并真实到达余额检查；变异验证（摘掉守卫→测试红）。
3. 修复分支基于 origin/main（d143a228a），不动 main。

## 开放问题

1. `ClusterController` 的 start/suspend/expansion 等生命周期端点同属"资源操作无用户状态检查"（仅有资源级 @RequiresPrivileges），本任务不扩科——建议另开任务统一收口（拦截器形态）。
2. 既有 `AppControllerTest`（Spring 上下文型）依赖本地环境离线跑不了，本次不为其补环境，回归由新增的离线单测承担。
