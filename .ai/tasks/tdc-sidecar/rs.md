# RS — tdc-sidecar：TDC 旁挂接入 harness-starter

## 背景与痛点

TDC（`git@git.tdengine.net:rd-app/cloud.git`，Java 11 多模块）在 2026-10-31 曾由 harness-builder 收编过一份**内嵌** harness 副本。该副本已停滞：11-02 后未随 harness-starter 演进（落后约三周的门禁与修复）、`projects[]` 一直空置（lint/test 从未接线，部署 Stage 0.3 未完成）、verify 证据日志一度被提交进产品仓又在 a97fb4837 里删除。2026-11-14 为 TDasset 定下的纪律（harness 文件一律不进产品仓，旁挂模式，状态与证据留在 harness 仓）是产品仓现行标准形态，TDC 应对齐。

## 用户故事

作为在 TDC 上干活的工程师，我希望 TDC 的任务走 harness-starter 的状态机与证据链（harness 与 `.ai/` 状态留在 harness-starter 仓，产品仓保持零 harness 文件），使 License Center 后续工作（当前活跃区 `tdc-mgmt/uc`）有可验证的门禁、真实可跑的验证命令与凭据隔离。

## 核心需求

1. `harness.config.json` `projects[]` 注册 TDC 后端条目（`id: backend`、`dir: ../TDC`、`srcGlob` 覆盖全模块 `src/main/java`；lint/test/testOne 使用**实测通过**的命令：绝对路径 mvn + `JAVA_HOME` 钉 MS OpenJDK 11.0.29；test 默认作用域 `tdc-mgmt/uc -am -Dtest='PublicController*Test'`——整仓连带 -am 的 test 离线不绿，见 envNotes）。
2. `harness.rules.json` `runtime.headless.envNotes` 增补 TDC 环境事实：JDK 23 编不过 tdc-billing（Lombok 1.18.22 撞 `JCTree$JCImport`）；四个顶层 pom（billing/gateway/job/oss）把 skipTests=true 硬编码进 surefire configuration、CLI `-D` 翻不动；可跑测试模块清单与指定测试类的命令形态。
3. `notes` 记录旁挂决策、内嵌副本停滞事实与待清理状态。

环境实测依据（2026-11-21，本机）：commons `-DskipTests=false` 7 用例真跑绿；tdc-billing 同参数 BUILD SUCCESS **零测试**（硬编码生效）；tdc-billing 在 Java 23 下编译期 `NoSuchFieldError: JCTree$JCImport`、JDK 11 下编译通过；`tdc-mgmt/uc` 的 `PublicControllerLicenseSmsTest` 4 用例 JDK 11 下绿。

## 非功能约束

- 不新增配置键，只新增值；既有消费者（doctor/check-skills/review-router）行为零变化，TDasset 两条目未动。
- 命令内嵌本机绝对路径（mvn/JAVA_HOME）——与 envNotes 同口径：宿主环境事实的唯一事实源在配置里可见可迁移。
- test 命令必须离线真绿（扩大作用域前先验离线绿，写入 envNotes）。

## 范围外

- 飞书 task-loop 为 Cloud 迭代开接单通道（同开放问题 2）。
- TDC-UI / TDC-Go 仓注册（同开放问题 3）。
- TDC 内嵌副本清理的执行（部署动作，11-21 已经用户裁决"归档后清理"执行完毕：→ `../TDC-harness-legacy/`，TDC 仓已零 harness 文件）。

## 术语表

- 旁挂：harness 文件不进产品仓（状态/证据留 harness 仓），`projects[].dir` 指向产品仓的接入形态。
- 收编（内嵌）：harness-builder 把 harness 文件复制进产品仓的旧形态（TDC 10-31 采用，已废弃归档）。
- envNotes：`harness.rules.json runtime.headless.envNotes`——宿主环境事实唯一事实源，随工单渲染。
- skipTests 双形态：TDasset 双属性（-D 可翻）vs TDC 四模块 surefire 硬编码（-D 翻不动）。

## 开放问题

1. ~~TDC 内嵌副本如何处置~~ 已裁决并执行（11-21）：归档至 `../TDC-harness-legacy/` 后清理，TDC 仓零 harness 文件。
2. 飞书 task-loop 是否为 Cloud 迭代（label 前缀 `Cloud-`）开接单通道——本次不做，另行决策（当前 iteration.prefix 只放行 IDMP）。
3. TDC-UI / TDC-Go 是否注册——本次不做。
4. 多业务仓共用一套 harness 时的 projects 路由细化（当前按相对路径约定，后续按需演进）。
