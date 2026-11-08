# harness-starter

一套能让 **3 种 CLI、多个工程师** 共用同一条 AI 编码流水线的脚手架。
它不解决"让 AI 更聪明"，解决两件事：**AI 的产出能不能被机器验收**，以及
**换个人、换个模型，标准还是不是同一个**。

## 整体架构

```text
┌───────────────────── 会话层（每个开发者的本地）─────────────────────┐
│ CLI（Claude Code / ZCode / DeepSeek）× 11 个 agent                  │
│ agent 定义唯一源 agents/*.agent.md → 生成三套产物，改一处处处同步    │
│ 本地三道门：guard_command（高危命令）guard_write（考卷区/生成物）    │
│             guard_state（无证据不得标完成）← verify-run 产证据       │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ git —— 唯一序列化点
                           │ （任务状态 state.json、证据日志、路由规则、代码全部入库）
┌──────────────────────────┴─────────────────────────────────────────┐
│ 边界层（MR = 个人纪律 → 团队纪律的分界线）                           │
│ · GitLab CI：review-router（变更→审核类型，零 LLM）                  │
│              → ai-review（L0 机器判据 + 单发语义审，🔴 退码 1）       │
│              → ci-verify（证据链 CI 口径）—— 红灯即挡合入            │
│ · broker（薄事件桥）：GitLab webhook → 飞书卡片票拟找人；            │
│   方案 D 批红：人在 RS 开放问题行裁决 → push diff 落账（author 身份）│
│   不写 state、不跑 agent、不合 MR —— 中台只当秘书                    │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ 观测面（fail-open：坏了不绑架判定）
┌──────────────────────────┴─────────────────────────────────────────┐
│ .ai/ledger：deny.jsonl（误拦率基线）· events.jsonl（路由/决策/token）│
│ → ledger:report 复盘 · doctor 门禁在场性（runner/批准规则缺位即红）  │
└────────────────────────────────────────────────────────────────────┘
     横切：harness-cli 把以上整套装进任意存量/新项目（init/remove，安全内核）
```

五条架构不变式（改任何一层前先对照）：

1. **单一源 + 生成**——`agents/` 与 `hooks/hooks.manifest.json` 是唯一事实源，三套 CLI 产物全部生成，`--check` 进 CI 防漂移。
2. **git 是唯一序列化点**——一切状态变更走正式提交；常驻服务（broker）只读事件、只发通知，不成为第二个状态源。
3. **票拟与批红分离**——机器与 AI 只出候选和证据（🔴 findings、决策卡选项），处置与 approve 永远归对应角色的人。
4. **fail-closed 判定、fail-open 观测**——门禁失败绝不放行（规则坏 → exit 2）；观测失败只记 stderr 不影响判定（ledger 坏不拦人）。
5. **判不了的明说不判**——本地口径认 mtime、CI 口径只认 git 事实；语义质量（feature_complete）归人审，不造形式化断言装样子。

## 上手

前提：**Node ≥ 18 与 bash 硬依赖**（Windows 走 WSL），git 建议。
`node scripts/harness-cli.mjs check <dir>` 打印真实状态；硬前提缺失时 `init` 直接拒绝安装。

```bash
npm run doctor      # 体检：模板态只提醒不报红
npm run build:agents && npm run build:hooks && npm run check:skills
npm run gate        # 门禁 + 14 组自测（必须全绿）
bash scripts/init-harness.sh my-feature M    # 新功能
bash scripts/init-harness.sh my-change M --type change --related my-feature --baseline <commit>
bash scripts/init-harness.sh my-bug M --type bugfix --related my-feature
```

入口：Claude Code / ZCode 用 `/task <需求>`；无 subagent 的 CLI 按 `prompts/INDEX.md` 取角色 prompt。

## 三种 CLI 怎么接

| CLI | 形态 | 接线 | 注意 |
|---|---|---|---|
| Claude Code | subagent | `.claude/`（生成） | clone 即用 |
| ZCode | subagent | `.zcode/config.json`（生成，`hooks.enabled: true`） | 首次需**确认信任工作区 hook**，未确认前门禁不生效 |
| DeepSeek（Anthropic 兼容） | subagent | 复用 `.claude/` | 设 `ANTHROPIC_BASE_URL` |
| DeepSeek（独立 CLI / 纯 API） | prompt-only | **无 hook** | 只有 CI 兜底，本地没有任何硬门禁 |

Agent 从 `agents/*.agent.md` 生成、hook 从 `hooks/hooks.manifest.json` 生成——改一处各处同步，
`--check` 进 CI 防漂移。别在文档里承诺 DeepSeek 独立路径"hook 硬拦"，那不是事实。

## 目录速览

- `agents/` · `harness.config.json` · `harness.rules.json` · `AGENTS.md` —— 唯一事实源：11 个 agent、能力与高危命令、**审核路由规则**、常驻纪律
- `.skills/` —— 领域知识（backend/frontend/e2e/harness），SKILL.md ≤200 行两层深，长表进 `references/`（含 harness 的 37 条门禁失效点清单）
- `scripts/` —— 生成器（build-agents/build-hooks）、体检（doctor）、任务（init-harness/verify-run）、审核（review-router/ai-review + `reviews/` 判据清单）、通知（harness-broker/feishu-ws + `lib/`）
- `hooks/` —— guard_state / guard_command / guard_write / session_start，校验核心 `lib/verify.mjs` 与 CI 共用
- `test/` —— 14 组自测 + `e2e/`（真 GitLab）+ `regress-p2.sh`（恒退 1 的缺陷复现器）
- `.ai/` —— 任务状态与证据（`tasks/*/state.json`、`verify/*.log` 入库、`ledger/` 观测面）
- `templates/`（9 张文档模板）· `guides/` · `retro/` · `docs/`
- `.claude/ .zcode/ prompts/` —— 生成物，不要手改

## 任务生命周期

```text
/task 需求 → orchestrator 建 state.json 定档
  rs[人审] → adr[人拍板·仅架构级] → fs → sr 🔴清零才放行 → wbs（拆已评审的 FS）
  → impl+test（每 TODO 配 .ai/verify/T*.log 证据）→ cr[人 approve] → CI → retro
```

每个箭头处的门禁是文件检查、命令退出码或 mtime 比较，**没有一条是"模型说它做完了"**。
门禁不过就停在人那里——停点可从容处理：`harness-cli resume <dir> <slug>` 把待决项按
"必须现在定 / 可先干再定 / 按建议默认"三档列出，生成 `DECISIONS.md`，回填要求 `--by` 记名。

证据口径分两套：本地判"日志晚于源码 + 72h 内"（clone 检出宽限 `verifyFreshnessGraceSec` 默认 120s，
工作树有差异的文件零容忍）；CI 只判 git 里可复现的事实（日志入库、exit_code=0、声明文件存在）。
`bash scripts/verify-run.sh [--task <任务名>] <todo-id> -- <命令>` 产日志，
`--task` 防跨任务同名日志被静默覆盖。

## 审核与通知自动化（MR 触发）

会话内门禁只拦"走 CLI 的那条路"；MR 是个人纪律与团队纪律的分界线——审核到场靠变更自动路由：

```bash
node scripts/review-router.mjs --base origin/main...          # 变更 → 审核类型（零 LLM）
node scripts/ai-review.mjs --type rs --base origin/main...    # L0 机器判据零 token + 单发语义审
```

- 路由规则（rs/fs/adr/cr/evidence）全在 `harness.rules.json`，改数据不改代码
- 退出码即门禁：0 过 / 1 有 🔴 挡合入 / 2 基础设施失败——**失败绝不产出"通过"**
- 省 token 分层：机器判据零 token 先行 → 预打包硬顶 → 未变更沿用上轮 → 每次用量入账本
- 无槽代码可见化：槽外代码文件被点名（`uncovered_code` 入账 + 卡片提示），静默缺席变可见缺席
- 无模型 key 不悄悄降级：机器判据干净但无凭据 → exit 2；只跑机器判据须显式 `--machine-only`

通知侧 `harness-broker`（薄事件桥，不写 state/不跑 agent/不合 MR）：GitLab webhook 入 → 路由 →
飞书卡片**票拟找人**；决策走**方案 D**——人在 RS「开放问题」行写「已裁决：X」提交，
broker 从 push diff 落账（身份取 commit author，内网零开放端口）。
`doctor` 另有**门禁在场性**体检：无活跃 runner = 阻塞、批准规则缺位 = 提醒——这两个缺位会让
"CI 兜底 / 批红强制"变空话，落地当天就要看得见。接入手册：[`guides/审核与通知自动化.md`](guides/审核与通知自动化.md)。

## 常用命令

```bash
npm run doctor / verify:state / verify:state:local / ledger:report
npm run test:router | test:ai-review | test:broker | test:feishu-ws   # 审核自动化套件
npm run e2e                                                            # 真 GitLab 端到端（环境未起退 78）
node scripts/harness-cli.mjs resume <dir> <slug> --from DECISIONS.md --by 张三
node scripts/harness-cli.mjs verify <dir> --json    # 统一验证入口（机器可读）
node scripts/harness-cli.mjs review-packet <dir> <slug>   # 评审包（直接贴 PR）
```

## 装进别的项目（harness-builder）

```bash
node scripts/harness-cli.mjs check|detect|analyze --out <dir>|init [--dry-run]|remove --yes <项目>
```

安全内核：已存在文件一律不覆盖（标 conflict）；路径不得逃逸目标目录、拒 symlink 穿越原子写；
生成物归属由生成器 `--manifest` 声明（`foreign` 永不删）；被改过的文件须 `--force` 才删，
`--yes` 删不动时 exit 2 不报成功。配置用探测回填（Go/Python/Rust 只识别不发明命令），
多构建根要 `--stack-dir`。完整方案见 `docs/plans/2026-10-30-harness-builder-final.md`。
npm 分发只在 tag 上发包（`npm pack --dry-run` 核对 files），日常用 `node scripts/harness-cli.mjs` 即可。

## 六条设计取舍

1. **单一源 + 生成**：3 CLI × 11 agent = 33 份文件，手写三个月后必然漂移——生成 + CI 漂移检测把它变成构建期错误。
2. **约束代码化，知识留 prompt**："不许做什么"要确定（hook+CI）；"怎么做"要人能读能改（markdown）。
3. **不追求全自动门禁**：`feature_complete`/`quality_clean` 机器判不了，假装能判只会催生形式化断言；门禁守最低限度的诚实。
4. **skill 两层、单文件 ≤200 行**：深度和行数上限是为了让"是否真的加载过"可被检验——最初那套 12 文件的 skill，模型读了 3 个就开始编造自检勾。
5. **按路径判，不按 agent 身份判**：PreToolUse 载荷里没有 agent 名，`writes` 只能投影成 `.ai/writes.json` 供人评审；真收紧只有裁 `capabilities`——文字禁令在压力下必然失效，裁剪能力不会。
6. **判不了的就不假装（本地口径 ≠ CI 口径）**：CI 判 mtime 会把合规 PR 判红，门禁被整体关掉；两边共用校验库但口径分开，判不了的写进文档让人审兜底。

---

深入阅读：[`guides/多人协作最佳实践.md`](guides/多人协作最佳实践.md) ·
[`guides/审核与通知自动化.md`](guides/审核与通知自动化.md) ·
state 字段契约 `docs/06-reference/state-fields.md`
