# CR 代码审查记录 — TDC 未提交改动（gateway Dockerfile profile 默认值移除 + 空壳测试 + 未跟踪清单盘点）

> 产出：本地手动审查（AutoClaw 会话）· 2026-11-23
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。

- 审查范围：TDC 主工作区 `feat/License-Center-msg`（HEAD=35735bc79）未提交改动——`tdc-gateway/Dockerfile`（M）、`tdc-gateway/Dockerfile.full`（M）、`tdc-gateway/gateway/src/test/java/com/taosdata/tcloud/gateway/config/k8s/TdResourceInformerLabelTest.java`（未跟踪）；另对全部未跟踪非代码文件做敏感项盘点
- 关联 FS：无
- **已加载的 skill**：`resolve-skills --diff`（HARNESS_ROOT 旁挂形态，cwd=TDC）输出：**0 命中**——Dockerfile 不在任何 skill 的 applies_to；未跟踪 Java 文件因工具只读 git diff 未被计入（工具盲区，人工补核）。最近似标尺=backend skill v1.1.0（已读全文）+ deployment skill D3（凭据纪律）

## 0 硬规则逐条核（backend v1.1.0 硬规则表，对本次改动的适用性判定）

| # | 规则 | 检测 | 结果 |
|---|---|---|---|
| R1 | 编排在 service 不在 resource | 本次无 Java 主代码改动 | ✅ N/A |
| R2 | 入参边界校验 | 同上 | ✅ N/A |
| R3 | SQL 跨列 OR | 无 SQL 改动 | ✅ N/A |
| R4 | @Transactional 代理可见性 | 无 | ✅ N/A |
| R5 | 禁硬编码密钥/端口/本机路径 | `rg -i 'password\|secret\|token'` 于未跟踪清单 | 🔴 命中：`cicd/all.env`（Auth0 api-client-secret 字面量）、`cicd/Jenkinsfile.pre`（token 字面量）、`docker-compose.mysql.local.yml`（MYSQL_ROOT_PASSWORD 字面量）——均**未跟踪**，见 §2-1 |
| R6 | 领域异常 | 无 Java 改动 | ✅ N/A |
| R7 | 行为改动同批补测试 | Dockerfile=镜像默认行为改动（默认 profile dev→无），无自动化测试可配——以部署侧确认代替（§3-2）；空壳测试类不构成任何覆盖（§3-1） | 🟡 |
| R8 | 禁变通参数让构建变绿 | 无 | ✅ N/A |
| R9-R11 | IDOR/幂等/迁移 | 无查询、写操作、迁移改动 | ✅ N/A |

## 1 改动摘要

两份 Dockerfile 删掉 `CMD ["--spring.profiles.active=dev"]`，改为注释说明 profile 由部署侧提供。动机（注释自述+代码核实成立）：Spring 命令行参数优先级高于环境变量，镜像内置 dev profile 会让部署侧 `SPRING_PROFILES_ACTIVE` 失效，生产集群静默加载 dev 配置。另有一个未跟踪的空壳测试类（3 行、零用例）。

## 2 阻断项 🔴

| # | 位置 | 问题 | 依据 | 建议 |
|---|---|---|---|---|
| 1 | `cicd/all.env`、`cicd/Jenkinsfile.pre`、`docker-compose.mysql.local.yml`（均未跟踪） | 含真实凭据字面量（Auth0 api-client-secret、webhook token、mysql root 密码）。一旦被 `git add -A`/`-am` 类操作卷入提交即泄露（11-18 有同类事故先例） | R5 检测实测命中；deployment skill D3（凭据只进 0600 文件，绝不进 git） | 三选一：加 .gitignore 条目 / 凭据改环境变量引用 / 移出仓库目录。**提交前 git status 核对** |

本次 Dockerfile 改动自身 🔴 = 0。

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | `TdResourceInformerLabelTest.java` | 空壳类（`public class TdResourceInformerLabelTest {}`，零用例）。目标逻辑真实存在且值得测：`TdResourceInformer.java:178-185`（labels==null 守卫、`"tdengine"` type 过滤、clusterName 提取）。空壳比没有更糟——占着"已覆盖"的位置 | 随对应改动同批补齐（null/非 tdengine/正常提取三态），或暂不加 | 待作者（WIP） |
| 2 | 两份 Dockerfile | 仓内零处 `SPRING_PROFILES_ACTIVE` 引用——注释声称的 k8s values 与 VM 侧提供方式全在仓外，本仓无法证实每个环境都显式给了 profile。不设置的 env 从"默认 dev"变为"无 profile"（application.yml 兜底 `bj.wj-1`） | 合入前在部署仓核对各集群 values 的 env.SPRING_PROFILES_ACTIVE；仓内 `cicd/docker-compose.yml:278` 已显式传参（实测不受影响） | 待部署侧确认 |
| 3 | `Dockerfile.full` | 仓内无任何消费方引用；且文件尾缺换行 | 确认是否外部流水线在用；不用则连同改动一并删；保留则补尾换行 | 待作者确认 |
| 4 | （流程）backend skill 的 applies_to=`backend/src/**` 不覆盖 TDC 的 `tdc-*/**` 路径——旁挂注册时留下的 skill 覆盖缺口，本次靠人工套规则 | 给 TDC 加 applies_to 或独立 skill | 延后（记入待办） |

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| `cicd/docker-compose.yml`（gateway 服务） | 否——compose `command:` 整体替换镜像 CMD，本就显式传 `--spring.profiles.active=${PROFILE}` | cicd/docker-compose.yml:278-279 |
| k8s 部署（仓外 values） | 待确认——旧 CMD 令 env 失效（这正是本修复动机）；新镜像要求 values 显式设置 SPRING_PROFILES_ACTIVE | 仓内零引用（rg 实测） |
| 任何 `docker run` 不带 env/args 的用法 | 是——默认从 dev profile 变为无 profile | Dockerfile CMD 删除本身 |
| 前端/其他服务 | 否 | 无接口/契约变化 |

## 结论

Dockerfile 改动**方向正确、技术断言经代码核实成立**（`application.yml:102` 兜底 `bj.wj-1` 属实、Spring 参数优先级属实、仓内 compose 不受影响）——approve 前提=§3-2 部署侧确认完成。阻断项 §2-1（未跟踪凭据文件）与改动质量无关，但属"未提交内容"审查的正当发现：**不处理就提交会泄露凭据**。空壳测试随其 WIP 主人处置。
