# harness-starter

一套能让 **3 种 CLI、多个工程师** 共用同一条 AI 编码流水线的脚手架。
解决两件事：**AI 的产出能不能被机器验收**，以及**换个人、换个模型，标准还是不是同一个**。

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

## 上手

前提：**Node ≥ 18 与 bash 硬依赖**（Windows 走 WSL）。`node scripts/harness-cli.mjs check <dir>` 确认。

```bash
npm run doctor      # 体检：模板态只提醒不报红；含门禁在场性（runner/批准/MCP 数据档）
npm run gate        # 门禁 + 20 组自测（必须全绿）
bash scripts/init-harness.sh my-feature M    # 新功能
bash scripts/init-harness.sh my-bug M --type bugfix --related <来源>  # 缺陷修复
bash scripts/init-harness.sh feishu-hotfix M --type bugfix --related feishu:<单号>  # 飞书 bug
```

入口：Claude Code / ZCode 用 `/task <需求>`；无 subagent 的 CLI 按 `prompts/INDEX.md` 取角色。

## 三种 CLI 接法

| CLI | 形态 | 注意 |
|---|---|---|
| Claude Code | subagent（`.claude/` 生成） | clone 即用 |
| ZCode | subagent（`.zcode/` 生成） | 首次需确认信任工作区 hook |
| DeepSeek 兼容端点 | subagent（复用 `.claude/`） | 设 `ANTHROPIC_BASE_URL` |
| DeepSeek 独立 CLI | prompt-only（`prompts/`） | **无 hook**，只有 CI 兜底 |

## 任务生命周期

```text
/task → rs[人审] → adr[人拍板] → fs → sr 🔴清零 → wbs → impl+test（每 TODO 配证据）→ cr[人 approve] → CI → retro
```

每个箭头处的门禁是文件检查、命令退出码或 mtime 比较，**没有一条是"模型说它做完了"**。
打回循环与 bug 热修由 task-loop 自动驱动（拉模型、CAS 认领、CI 归因、人审停点）。

## 审核与通知自动化

```bash
node scripts/review-router.mjs --base origin/main...   # 变更 → 审核类型（零 LLM）
node scripts/ai-review.mjs --type cr --dry-run ...      # L0 判据零 token + 打包统计
bash scripts/install-task-loop.sh <仓库>                # 装 task-loop 定时器（launchd/systemd）
node scripts/task-loop.mjs --once --dry-run             # 影子模式（零写入）
```

- **路由规则全在 `harness.rules.json`**（rs/fs/adr/cr/evidence + code_hints + 订阅三档），改数据不改代码
- **退出码即门禁**：0 过 / 1 有 🔴 挡合入 / 2 基础设施失败——**失败绝不产出"通过"**
- **无模型 key 不悄悄降级**：机器判据干净但无凭据 → exit 2；只跑机器判据须显式 `--machine-only`
- **凭据安全**：定时器 plist/unit 不含秘密，0600 env 文件 + 0700 wrapper 注入

## 目录速览

- `agents/` · `harness.config.json` · `harness.rules.json` · `AGENTS.md` —— 唯一事实源
- `.skills/` —— 领域知识（≤200 行两层深；harness 的 37 条门禁失效点清单在 references/）
- `scripts/` —— 生成器（build-\*）、体检（doctor）、任务（init/verify-run）、审核（router/ai-review）、通知（broker/feishu-\*）、循环（task-loop + lib/ 23 个共享库）
- `hooks/` —— guard_state/command/write + session_start；校验核心 `lib/verify.mjs` 与 CI 共用
- `test/` —— 20 组自测 + `e2e/`（真 GitLab）+ `regress-p2.sh`（恒退 1 缺陷复现器）
- `.ai/` —— 任务状态（`tasks/*/state.json`）· 证据（`verify/*.log` 入库）· 观测（`ledger/`）
- `templates/`（9 张文档模板）· `guides/` · `retro/` · `deploy/task-loop/`（定时器模板 + CI 参考）
- `.claude/ .zcode/ prompts/` —— 生成物，不要手改

## 常用命令

```bash
npm run doctor / verify:state / verify:state:local / ledger:report / gate
npm run e2e                     # L2：真 GitLab 端到端（环境未起退 78）
node scripts/harness-cli.mjs check|detect|analyze|init|remove|resume|verify
bash scripts/verify-run.sh [--task <任务名>] <todo-id> -- <命令>    # 证据包装器
```

## 设计取舍

1. **单一源 + 生成**：3 CLI × 11 agent = 33 份文件，手写三个月后必然漂移——生成 + CI 漂移检测变成构建期错误。
2. **约束代码化，知识留 prompt**："不许做什么"要确定（hook + CI）；"怎么做"要人能读能改（markdown）。
3. **不追求全自动门禁**：`feature_complete` / `quality_clean` 机器判不了；门禁守最低限度的诚实，不守正确性。
4. **skill 两层、单文件 ≤200 行**：让"是否真的加载过"可被检验——最初 12 文件的 skill，模型读了 3 个就开始编造自检勾。
5. **按路径判，不按身份判**：PreToolUse 载荷里没有 agent 名；真收紧只有裁 `capabilities`——文字禁令在压力下必然失效，裁剪能力不会。
6. **判不了的就不假装**：CI 判 mtime 会把合规 PR 判红；两边共用校验库但口径分开，判不了的写进文档让人审兜底。

---

深入阅读：[`guides/多人协作最佳实践.md`](guides/多人协作最佳实践.md) ·
[`guides/审核与通知自动化.md`](guides/审核与通知自动化.md) ·
state 字段契约 `docs/06-reference/state-fields.md`
