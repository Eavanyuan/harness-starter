# harness-starter

一套能让 **3 种 CLI、多个工程师** 共用同一条 AI 编码流水线的脚手架。
解决两件事：**AI 的产出能不能被机器验收**，以及**换个人、换个模型，标准还是不是同一个**。

## 🚀 从这里开始

**[guides/快速上手.md](guides/快速上手.md) —— 五步从零到 task-loop 跑起来**（小白照做就行）：

1. 把 harness 装进你的项目（新项目 / 存量项目）
2. 接 GitLab（PAT + Runner + Webhook）
3. 接飞书项目（MCP + OAuth + 严重级词表）
4. 起 task-loop（定时器 + 影子周 + 真跑）
5. 日常使用

## 整体架构

```text
┌───────────────────── 会话层（每个开发者的本地）─────────────────────┐
│ CLI（Claude Code / ZCode / DeepSeek）× 11 个 agent                  │
│ agent 唯一源 agents/*.agent.md → 生成三套产物，改一处处处同步        │
│ 本地三道门：guard_command（高危）guard_write（考卷区）              │
│             guard_state（无证据不得标完成）← verify-run 产证据       │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ git —— 唯一序列化点
                           │ （任务状态、证据日志、路由规则、代码全部入库）
┌──────────────────────────┴─────────────────────────────────────────┐
│ 边界层（MR = 个人纪律 → 团队纪律）                                   │
│ · GitLab CI：review-router（变更→审核类型，零 LLM）                  │
│              → ai-review（L0 机器判据零 token + 单发语义审）         │
│              → ci-verify（证据链 CI 口径）—— 红灯即挡合入            │
│ · broker（薄事件桥）：GitLab webhook → 飞书卡片票拟找人；            │
│   方案 D 批红：人在 RS 开放问题行裁决 → push diff 落账（author 身份）│
│   订阅三档投递（card/digest/ledger）+ aging 到点升级                 │
│ · task-loop（本地循环执行器）：拉模型轮询打回评论/飞书缺陷单，        │
│   git CAS 认领（跨机互斥）→ 会话打包（制品交接）→ CI 归因            │
│   （指纹+merge-base 基线+三分流）→ 停点=引入失败0+人审有效            │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ 观测面（fail-open：坏了不绑架判定）
┌──────────────────────────┴─────────────────────────────────────────┐
│ .ai/ledger：deny.jsonl（误拦率基线）· events.jsonl（路由/决策/token）│
│ → ledger:report 复盘 · doctor 门禁在场性（runner/批准规则/MCP 数据档）│
└────────────────────────────────────────────────────────────────────┘
     横切：harness-cli 把以上整套装进任意存量/新项目（init/remove 安全内核）
```

**五条架构不变式**（改任何一层前先对照）：

1. **单一源 + 生成**——`agents/` 与 `hooks/hooks.manifest.json` 是唯一事实源，三套 CLI 产物全部生成，`--check` 进 CI 防漂移。
2. **git 是唯一序列化点**——一切状态变更走正式提交；常驻服务（broker/task-loop）只读事件、只发通知，不成为第二个状态源。
3. **票拟与批红分离**——机器与 AI 只出候选和证据（🔴 findings、决策卡选项），处置与 approve 永远归对应角色的人。
4. **fail-closed 判定、fail-open 观测**——门禁失败绝不放行（规则坏 → exit 2）；观测失败只记 stderr 不影响判定。
5. **判不了的明说不判**——本地口径认 mtime、CI 口径只认 git 事实；语义质量归人审，不造形式化断言装样子。

## 设计取舍

1. **单一源 + 生成**：3 CLI × 11 agent = 33 份文件，手写三个月后必然漂移——生成 + CI 漂移检测变成构建期错误。
2. **约束代码化，知识留 prompt**："不许做什么"要确定（hook + CI）；"怎么做"要人能读能改（markdown）。
3. **不追求全自动门禁**：`feature_complete` / `quality_clean` 机器判不了；门禁守最低限度的诚实，不守正确性。
4. **skill 两层、单文件 ≤200 行**：让"是否真的加载过"可被检验。
5. **按路径判，不按身份判**：PreToolUse 载荷里没有 agent 名；真收紧只有裁 `capabilities`。
6. **判不了的就不假装**：CI 判 mtime 会把合规 PR 判红；两边共用校验库但口径分开。

## 目录速览

| 目录 | 是什么 | 改不改 |
|---|---|---|
| `agents/*.agent.md` | 11 个 agent 唯一事实源 | ✅ 改后跑 `build:agents` |
| `harness.rules.json` | 审核路由+订阅+运行时配置 | ✅ 改数据不改代码 |
| `harness.config.json` | CLI 能力映射+高危命令 | ⚠️ 考卷区（需放行条） |
| `AGENTS.md` | 常驻规则（所有 CLI 都读） | ✅ |
| `.skills/` | 领域知识（≤200 行两层深） | ✅ |
| `scripts/` | 全部工具（17 脚本 + 23 共享库） | ✅ 同批配测试 |
| `hooks/` | 三道门 + 校验核心 | ⚠️ 考卷区（需放行条） |
| `test/` | 20 组自测 + e2e | ✅ |
| `templates/` | 9 张文档模板 | ⚠️ 考卷区（需放行条） |
| `.ai/` | 任务状态 + 证据 + 观测账本 | 状态按任务写；`verify/*.log` 入库 |
| `.claude/ .zcode/ prompts/` | 生成物 | ❌ 不要手改 |
| `deploy/task-loop/` | 定时器模板 + CI 参考配置 | ✅ 部署时抄 |

## 常用命令

```bash
npm run doctor          # 体检（含门禁在场性）
npm run gate            # 全量自检（20 组，必须全绿）
npm run verify:state    # 证据链校验（CI 口径）
npm run ledger:report   # 拦截面统计
npm run e2e             # L2：真 GitLab 端到端

bash scripts/init-harness.sh <slug> [S|M|L|XL] [--type feature|change|bugfix] [--related <slug或feishu:单号>]
bash scripts/verify-run.sh [--task <任务名>] <todo-id> -- <命令>
node scripts/task-loop.mjs --once [--dry-run]
bash scripts/install-task-loop.sh <仓库> [--print|--status|--uninstall]
```

## CLI 接法

| CLI | 形态 | 注意 |
|---|---|---|
| Claude Code | subagent（`.claude/` 生成） | clone 即用 |
| ZCode | subagent（`.zcode/` 生成） | 首次需确认信任工作区 hook |
| DeepSeek 兼容端点 | subagent（复用 `.claude/`） | 设 `ANTHROPIC_BASE_URL` |
| DeepSeek 独立 CLI | prompt-only（`prompts/`） | **无 hook**，只有 CI 兜底 |

---

## 文档索引

| 文档 | 给谁看 |
|---|---|
| **[guides/快速上手.md](guides/快速上手.md)** | 第一次用的人（五步跑通） |
| [guides/审核与通知自动化.md](guides/审核与通知自动化.md) | 配 broker/飞书/CI 的人 |
| [guides/多人协作最佳实践.md](guides/多人协作最佳实践.md) | 团队负责人 |
| [guides/需求变更与Bug修复.md](guides/需求变更与Bug修复.md) | 走 change/bugfix 流程的人 |
| `docs/06-reference/state-fields.md` | 想了解 state.json 字段的人 |
| `docs/06-reference/adr/ADR-010-task-loop.md` | 想了解 task-loop 架构裁决的人 |
