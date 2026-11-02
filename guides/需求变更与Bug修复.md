# 需求变更与 Bug 修复流程

> 回答一个问题：**已交付之后，需求变了、代码坏了，怎么走才不破坏证据链。**
>
> 判据一句话：两条独立入口，共用同一套 state、verify 证据和门禁。
> 每个独立交付项仍对应一份 state——**不重开旧 state，不覆盖旧验收记录**，
> 改历史等于伪造证据。

---

## 一、入口分流

| 情况 | 入口 | 建档命令 |
|---|---|---|
| 新功能 | feature（默认） | `bash scripts/init-harness.sh <slug> [tier]` |
| 已交付功能的需求改动 | change | `bash scripts/init-harness.sh <slug> [tier] --type change --related <原任务slug> --baseline <commit hash>` |
| 缺陷修复 | bugfix | `bash scripts/init-harness.sh <slug> [tier] --type bugfix --related <发现来源slug>` |

`--related` 必须指向本仓库已存在的任务；`--baseline` 只对 change 必填，且只收
**7–40 位 git commit hash**（`git rev-parse HEAD` 可取）——RS 是活文档，"v1.2" 这类
修订号机器验证不了，等于没锚；RS 的锚点就用"最后一次触碰它的 commit"。
这两条由 init 脚本硬校验（exit 64），不是文档建议。

---

## 二、需求变更（change）

变更类型按影响范围分三档，写进 `state.meta.change_tier`：

| 档位 | 适用 | 流程 |
|---|---|---|
| 1 | 文案、展示细节，不影响行为 | 记录变更点与验收标准 → 实现 → 定向验证 → CR |
| 2 | 局部行为变化，兼容现有接口 | 更新受影响的 RS/FS 条目 → 分析调用方和测试 → 拆受影响 TODO → 定向验证与必要回归 → CR |
| 3 | 改 API、数据结构、权限、配置，或跨栈影响 | 完整走 RS → ADR（有方案取舍时）→ FS/矩阵 → SR → WBS → 实现和统一验证 → CR |

核心原则：**只更新受影响的内容，但把影响链补齐。**
US-4 改了，就追到对应 FS 小节、TODO、验收测试和回归测试；没受影响的模块不重跑完整流程。
调查中发现改动其实触及对外契约 → 升级为档位 3，不要原地硬裁。

**档位是谁选的：做变更的 agent 自己。** 这是声明，不是门禁——CR 必须复核档位选择
（尤其看 diff 是否触及 API 路由、迁移脚本、权限配置），档位不符直接打回重定档。

---

## 三、Bug 修复（bugfix）

建档后先写清四件事：实际行为、预期行为、复现步骤、影响范围。通常**不需要**重写 RS/FS：

1. 建 bugfix state，`meta.affected_ids` 填受影响模块；
2. **先补能复现问题的回归测试**（TODO 标 `kind: "regression"`），跑一次留下**红灯日志**
   （`scripts/verify-run.sh` 记录失败运行，exit_code≠0），把路径写进 TODO 的 `red_log_path`
   ——CI 对完成态强制校验：没有红灯日志、或"红灯"exit_code=0，都不放行；
3. 修复并跑相关验证，保存 verify 日志；
4. 检查调用方和邻近回归面，完成 CR。

快速路径沿用栈内现有规则：后端局部修复限于方法体内，改签名/SQL/配置/跨类即升级；
前端不能改 props/emit/路由，触及契约也升级。权限、安全、数据损坏、迁移问题直接走高风险完整流程。

**bugfix 还是 change？** 现有实现不符合已批准需求 → bugfix + 回归测试。
需求本身定义错了，或修复必须改变产品行为 → 转 change：先确定新预期，再实现。

---

## 四、追溯链与门禁分工

用稳定 ID 建链：**RS 条目 → FS 小节 → TODO → 测试场景 → verify 证据**。
变更时列出受影响 ID 和明确不受影响的部分；审核者逐项检查，而不是看"文档已同步"的声明。

| 校验 | 谁执行 | 何时 |
|---|---|---|
| --type 枚举、--related 存在性、baseline 格式与 commit 存在性 | init 脚本 | 建档 |
| related_task 指向的任务仍然存在（meta 被改写也能抓到） | guard_state + ci-verify | 每次写 state / CI |
| change 完成态：baseline 是历史里真实存在的 commit hash、change_tier、affected_ids 非空 | 同上 | 完成态 |
| bugfix 完成态：affected_ids 非空 + 每个已完成 `kind:"regression"` TODO 带红灯日志（存在、exit_code≠0、已入库） | 同上 | 完成态 |
| 档位选择是否合理、affected_ids 是否列全、文档是否真同步、红灯日志是不是真跑出来的 | CR 人审 | review 阶段 |

机器判"有没有"和"hash 在不在 git 里"，不判"对不对"——影响分析质量假装能自动化，
只会催生形式化断言。

**升级触发条件（无事故不预建门禁）**：CR 一旦发现真实的"影响链漏对应"事故
（改了 RS 没改 FS、改了 TODO 没跑测试之类），同批给 TODO 加 `trace` 字段并做
affected_ids 双向机判；在那之前不要预建。

**已知残余风险（诚实版）**：
- CI 无法拿到 PR 的 base diff，"diff 触及契约但声称档位 1"在 CI 上判不了，靠 CR 复核；
- 红灯日志可以伪造（手写一个 header 就行），机器只保"提交里有失败运行的记录"，
  不保"它真是修复前跑出来的"。CR 可用 git log 核对红灯日志的提交顺序应早于修复 commit。
  要机器级保证只能 CI 托管跑测试，那是另一个量级的基础设施，当前不做、不假装做了。

---

## 五、为什么是"共用门禁"而不是"轻量通道"

给 change/bugfix 单独建一套轻量门禁，违反失效点 7（hook 与 CI 必须同一份校验）：
两条判据迟早不一致，人一定走松的那条。所以只加字段、复用 `verify.mjs`，
不新建任务类型专属的 hook 或 CI 脚本。
