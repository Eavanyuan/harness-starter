# harness-starter 架构审核报告

日期：2026-11-11 ｜ 审阅范围：全仓（agents/hooks/scripts/templates/.ai 实例/文档）｜方法：通读核心配置与门禁实现 + 两路子审计（实现层、agent/流程层），全部问题附文件级证据。

## 总体评价

架构骨架是健全的：单一源+生成、git 唯一序列化点、票拟与批红分离、fail-closed 判定 / fail-open 观测——五条不变式清楚且大部分真的落了地（doctor 全绿、20 组自测、双向 state 字段契约检查是同类项目少有的优点）。guard_state.mjs 的"TodoWrite 挂错事件"复盘注释说明团队真的在迭代失效点。

主要问题不在理念，而在**三处**：本地门禁存在整体绕过面、证据链"防失误不防故意"、流程自重在小任务上压垮收益。以下按严重度排列。

---

## 一、必须修（架构级缺口）

### 1. Bash 通道整体绕过写/读门禁 ⚠️ 最重
- `hooks/lib/write_tools.mjs:13` 的 WRITE_TOOLS 不含 Bash；`guard_command.mjs:77-93` 的 15 条高危正则不覆盖 `>`/`>>` 重定向写文件和 `cat .env`；`sensitiveRead` 只挂 Read 工具（`guard_command.mjs:96-100`）。
- 后果：`echo … > .ai/tasks/x/state.json` 可绕过 guard_state 全部校验；`cat .env > /tmp/x` 绕过敏感读拦截。整套"无证据不得标完成"对 Bash 写是敞开的。
- 建议：① guard_command 增加"写类重定向到受保护/生成/状态路径"的拦截（哪怕只拦 `>` 目标命中 generated/protected/state 的情形，正则可枚举）；② sensitiveRead 判据下沉到 Bash 命令文本（`cat|head|less|<` 命中模式串即拦）。

### 2. allowlist 前缀匹配短路一切高危规则
- `guard_command.mjs:81-84`：命令命中 allowlist 前缀即 `exit 0`，跳过全部后续检查——`mvn test; git push --force` 整条放行。
- 建议：allowlist 只豁免"非高危子集"，即先扫描整条命令（按 `;`/`&&`/`||` 切分逐段判），allowlist 只用于段级豁免；或 allowlist 命中后仍跑 blockedCommands 全量正则。

### 3. 证据链防失误不防故意
- 日志头格式公开，可手写伪造；新鲜度候选集只含自报 files ∪ srcGlob 命中（`hooks/lib/verify.mjs:367-373`），改 `scripts/hooks/docs` 不触发重跑；工作树 commit 后 pool 为空直接 ok（:401-404）。
- 定位说明：README 已声明"门禁守诚实不守正确"，此为已知取舍；但 srcGlob 不含 harness 自身目录意味着 dogfood 场景（本仓最大的使用场景）改动不在新鲜度口径内。
- 建议：① srcGlob 增补 `scripts/**`、`hooks/**`、`templates/**`（本仓配置下）；② verify-run.sh 的日志加 `git rev-parse HEAD` 与命令哈希，CI 侧核一次（防重放、防跨任务挪用）；③ 明示"防故意"归 CR/人审，文档不要再加码。

### 4. 僵尸任务违反自定 3 天规则，且规则无机器判据
- `harness-builder-hardening`（stage=impl、stage_history 空、T1 pending）与 `harness-doc-gate` 停滞 9-10 天，orchestrator 的"超 3 天视为僵尸"只写在 prompt，`verify:state`/CI 不查——doctor 只提醒不拦截。
- 建议：僵尸判据进 ci-verify（最后更新时间 vs 分支最后 commit），僵尸任务的 state 在 CI 口径直接 fail，倒逼收口或显式 `--abandon`。

### 5. retro 门禁不闭合，经验沉淀链断裂
- 8 个 done 任务，`retro/` 仅 3 个文件且命名两种风格；"retro 文档存在"的判据与实际落盘位置对不上。
- 建议：判据固定为 `retro/<slug>*.md`，由 verify:state 机械查；否则 retro 阶段就是流程里的"橡皮图章"。

---

## 二、卡点与流程局限（业务摩擦）

### 6. S 档仍过重
- `harness-gate-fix`（5 文件 bugfix）走满 9 阶段；`ai-review-notify` 的 stage_history 出现 ci↔retro 三轮往返——门禁把人赶进了"推进-打回"循环。
- 建议：S 档把 ci/retro 合并为收尾单阶段；resume 对"同一阶段第三次打回"自动降档为提示+人工放行，而不是继续机械拦。

### 7. 只读 agent 声明与运行时不一致（已知但未收口）
- writes 是交接契约不是运行时门禁：spec-reviewer 可写 `docs/02-features/**` 而 test-engineer 不能，四个 agent 共写同一目录无细分；窄 writes 的 agent 运行时仍可写任何未保护路径。
- 建议：短期在 CR 模板加"writes diff"必填项；长期给 Bash 写路径加与 guard_write 同源的目标判据（与缺口 1 一并修）。

### 8. harness-cli.mjs 1852 行单文件
- 安装/移除/resume/决策路由全在一个文件，是 scripts 里最重的单点；broker 重启重复落账（:206 + decision-from-git.mjs:87）、digest `Date.now() % interval`（:505）会整窗错过、ai-review 缓存不区分 checklist/base（ai-review.mjs:99-108）清单更新后沿用旧结论。
- 建议：按命令拆模块；事件落账幂等键改 `(event_id, action)`；缓存键并入 rules 文件哈希。

### 9. 一致性债
- glob 引擎四份实现，`verify.mjs:227` 声称与 guard_write 一致但只有前者支持 `{a,b}`——同一 pattern 两处判定可不同。建议抽单一 glob 库。
- `verify-run.sh:50,62` 的 todo-id 未过滤，可把日志写到 `.ai/verify/` 外；task-loop 未知 `--` 旗标静默忽略。

### 10. 模板态与落地成本
- FS/WBS/ADR/SR 模板仅被 dogfood 过一次，`docs/00-planning`、`04-testing` 为空；runtime 三项（spawn_agents/shell/ask_user）仍是 unknown——orchestrator 每次会话都要重新试错自检。建议把自检结论写回配置做成一次性命令。

---

## 三、改进优先级

| 优先级 | 事项 | 对应 |
|---|---|---|
| P0 | Bash 重定向写 + sensitiveRead 下沉到命令文本 | 缺口 1 |
| P0 | allowlist 改段级豁免 | 缺口 2 |
| P1 | 僵尸任务 CI 判据 + 显式 abandon 流 | 缺口 4 |
| P1 | retro 落盘路径机器判 | 缺口 5 |
| P1 | verify 日志绑 commit + harness 目录进新鲜度口径 | 缺口 3 |
| P2 | S 档收尾阶段合并、三次打回降档 | 卡点 6 |
| P2 | harness-cli 拆分、broker 幂等、缓存键 | 卡点 8 |
| P3 | glob 统一、todo-id 过滤、runtime 自检回写 | 9/10 |

## 结论

这是一套设计自觉性很高的 harness：它对自身失效模式的记录（checklist 17 条、guard_state 的复盘注释）说明门禁是被认真维护的。当前最大的风险不是"规则不够多"，而是**两条通道性绕过（Bash 写、allowlist 短路）让既有规则的威慑力打折**，以及**流程自重使小任务的成本收益倒挂**。先堵通道，再减自重，harness 的可信度会上一个台阶。

详细证据见：[audit-scripts.md](audit-scripts.md)、[audit-agents.md](audit-agents.md)。
