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

## 开放问题

1. TDC 内嵌副本（`.ai/` 两项停滞任务 + 2 份 verify 日志 + 全套散落 harness 文件 + `.gitignore` harness 标记行）如何处置：归档后清理 / 原样保留——待用户裁决，不阻塞本次注册。
2. 飞书 task-loop 是否为 Cloud 迭代（label 前缀 `Cloud-`）开接单通道——本次不做，另行决策（当前 iteration.prefix 只放行 IDMP）。
3. TDC-UI / TDC-Go 是否注册——本次不做。

## 非功能约束

- 旁挂目录与目标仓同机同层级；证据链全部落 harness 仓（CI 口径不变）。
- 不向目标仓写入任何文件（约束 A）；跨仓引用零网络依赖。

## 范围外

- 目标仓自身的 CI 改造；harness 与目标仓的 webhook 打通（走既有 broker）。

## 术语表

- **旁挂（sidecar）**：harness 装独立目录、`--root` 指向业务仓的部署形态。
- **tdc-sidecar**：TDengine 系资产仓（TDasset 类）的旁挂部署约定。

## 开放问题

- 多业务仓共用一套 harness 时的 projects 路由细化（当前按相对路径约定）。
