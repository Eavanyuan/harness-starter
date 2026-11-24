# harness-starter

一套让 **多个工程师、多种 CLI** 共用同一条 AI 编码流水线的脚手架。
它只解决两件事：

1. **AI 的产出能不能被机器验收**——每个"做完了"都要有跑过命令的证据；
2. **换个人、换个模型，标准还是不是同一个**——纪律长在仓库里，不长在谁的记忆里。

```bash
npm run gate          # 一条命令验全部：体检 + 架构 + 28 项测试套件 + 证据链
```

---

## 30 秒理解

一个任务的完整生命周期：

```
init-harness 建档 → 干活（agent 按 skill 硬规则写码）→ verify-run 包装验证命令留证据
→ 证据随代码提交入库（CI 只认 git 里的事实）→ CR（机器判据 + 语义审）
→ harness close 收尾（自动跑 gate）
```

核心纪律一句话：**验证命令必须用 `bash scripts/verify-run.sh <todo-id> -- <命令>` 包装**——裸跑的日志没有标准头，CI 一律判"未入库=没跑过"。

这套东西全自动跑起来是什么样：task-loop 定时轮询飞书缺陷单和 GitLab MR，认领→归因→生成工单→执行器修复→推分支→等 CI→再归因，人只在升级点和批准点出现。

---

## 设计哲学

**五条不变式**（改任何一层前先对照）：

1. **单一源 + 生成**——`agents/*.agent.md` 是 12 个 agent 的唯一事实源，`hooks/hooks.manifest.json` 是 hook 接线的唯一源；`.claude/`、`.zcode/`、`prompts/` 全是生成物，改源后 `build:agents` / `build:hooks` 重建，漂移在 CI 变成构建错误。
2. **git 是唯一序列化点**——任务状态、证据日志、配置全部入库；常驻进程只读事件、只发通知，不成为第二个状态源。
3. **机器提议、人来拍板**——机器和 AI 只出候选与证据（🔴 findings、决策选项）；处置与 approve 永远归人。
4. **fail-closed 判定，fail-open 观测**——门禁坏了就拒绝（exit 2），绝不放行；监控坏了只记日志，不绑架判定。
5. **判不了的明说不判**——CI 只认 git 里的日志事实；"代码好不好"归人审，不造形式化断言装样子。

**三条关键取舍**：

- **约束代码化，方法留文档**："不许做什么"（hook + CI）必须确定；"怎么做"（agent / skill 的 markdown）必须人能读能改。
- **按路径判，不按身份判**：hook 载荷里没有 agent 名；要真正收紧只有裁 `capabilities`（工具集）。
- **提醒优先于阻断**：性能超线、架构黄牌是信号不是死刑——先可见，再行动，存量债不挡新开发。

---

## 整体架构

```text
会话层（每个开发者的本地）
├─ CLI：Claude Code / ZCode / 任何读 AGENTS.md 的客户端
├─ 12 个 agent（全在 agents/）：编码 · 审查 · 架构 · 需求 · 规格 ·
│  规格评审 · 测试 · 分解 · 选型 · 原型 · 复盘 · 编排
└─ 本地三道门
   ├─ guard_command —— 高危命令拦截
   ├─ guard_write   —— 考卷区 / 生成物 / 凭据路径
   └─ guard_state   —— 无证据不得标完成
        │
        ▼  git = 唯一序列化点：任务状态、证据日志、配置、代码全部入库
        │
边界层（MR：个人纪律 → 团队纪律）
├─ GitLab CI：review-router → ai-review（机器判据零 token + 语义审）
│              → ci-verify（证据链口径）—— 红灯挡合入
├─ broker：GitLab webhook → 飞书卡片 / 摘要 / 账本，aging 到点升级
└─ task-loop：自动化修复循环（见下节）
        │
观测与治理
├─ .ai/ledger 事件账本 → ledger:report 复盘
├─ doctor 体检：配置在场性、接线、性能预算、僵尸任务
└─ architect-check F1-F5：模块边界 / 依赖方向 / 复杂度预算 / 配置面 /
   验证耗时趋势（性能基线与预算见「治理三件套」）
```

## task-loop：自动化修复循环

监控端与执行端**解耦**，靠工单文件（`pack-*.md`）做宿主无关协议：

```
launchd/systemd 心跳 → task-loop.mjs（节流：pollSeconds / activeHours / OFF 哨兵）
  → 拉飞书单（优先级门控 + 迭代前缀过滤 + 信息完备性检查）
  → 拉 GitLab MR（打回评论 / CI 红归因：引入 vs 基线同款）
  → CAS 认领（跨机互斥）→ 生成工单落盘
  → 执行器取工单：修 → 本地复现优先（envNotes 环境事实随工单）→ 推分支 → 等 CI → 下一轮
  → 预算约束（maxRounds=3）超限升级给人
```

**执行器可插拔**（ADR-22）：`runtime.headless.executor.kind`

| kind | 机制 | 适用 |
|---|---|---|
| `autoclaw`（缺省） | 宿主定时会话轮询工单 | 已有 AutoClaw 的机器 |
| `cli` | runner 认领即起无头 CLI 会话（worktree + hook 注入 + 产物验收 + 影子模式） | 任意机器；零客户端通知、事件驱动 |

---

## 快速开始

前置：Node.js ≥ 20、git。本仓就是脚手架本体——clone 后即可用；装进业务仓见路径三。

**路径一：本地开发（最小集）**

```bash
bash scripts/init-harness.sh <slug> S        # 建任务档案（feature）
# …写代码，改前先 node scripts/resolve-skills.mjs --diff 加载对应 skill…
bash scripts/verify-run.sh --task <slug> <id> -- <验证命令>   # 证据
node scripts/harness-cli.mjs close . <slug> --by "你的名字"    # 收尾（gate 自跑）
```

**路径二：全自动 task-loop**

```bash
node scripts/feishu-auth.mjs login            # 飞书 OAuth（不接飞书可跳过，只跑 GitLab）
# ~/.harness/task-loop/task-loop.env 放 GITLAB_URL/TOKEN（0600）
bash scripts/install-task-loop.sh .           # 装定时器（macOS/Linux 自适应）
node scripts/task-loop.mjs --once --dry-run   # 影子周：只看不干，攒 N≥30 且 0 误触发再真跑
```

**路径三：装进其他项目**——读 `.skills/deployment/SKILL.md`（能力选配矩阵 + 五步部署 + 53 条已知坑清单）。

**旁挂模式**：harness 不进业务仓——装独立目录，`--root` 指向业务仓（TDasset 即此形态），证据链落 harness 仓。

---

## 模块地图

| 目录/文件 | 是什么 | 改后要跑 |
|---|---|---|
| `agents/*.agent.md` | 12 个 agent 唯一源 | `build:agents` |
| `hooks/hooks.manifest.json` | hook 接线唯一源 | `build:hooks` |
| `hooks/guard_*.mjs` | 本地三道门（命令/写入/状态） | 同批补测试 |
| `scripts/init-harness.sh` / `harness-cli.mjs` | 建档与一键收尾入口 | — |
| `scripts/verify-run.sh` | 证据包装（标准日志头 + 耗时基线比对） | — |
| `scripts/task-loop.mjs` | 自动化循环 runner | `test:task-loop` |
| `scripts/lib/headless-executor.mjs` | cli 执行器（worktree/hook 注入/影子） | 同上 |
| `scripts/doctor.mjs` | 配置体检（配了没、生效没） | `test:doctor-gates` |
| `scripts/architect-check.mjs` | 架构健身函数 F1-F5（report/strict 双模式） | `test:architect` |
| `scripts/ai-review.mjs` | CR 机器判据 + 语义审（读 diff 不读记忆，禁自审） | `test:ai-review` |
| `.skills/<stack>/SKILL.md` | 各栈硬规则（Stage 0 强制读） | `check:skills` |
| `templates/` | RS/ADR/CR/FS 文档模板 | — |
| `test/`（28 套件） | 全部门禁与流程的测试 | `npm run gate` |
| `.ai/tasks/<slug>/state.json` | 任务唯一进度源（不认会话记忆） | `verify:state` |
| `retro/` | 每次任务的复盘（经验沉淀第一站） | `test:retro` |

## 配置速查

两个文件分工：**`harness.config.json` = 部署事实**（这个仓是谁、栈是什么、阈值多少），**`harness.rules.json` = 行为规则**（审查判据、runtime、通知）。

| 常用配置 | 位置 | 作用 |
|---|---|---|
| `projects[]` | config | 栈目录与 lint/test 命令 |
| `architecture.*` | config | F1-F5 阈值（黄 2000/红 3000 行等） |
| `performance.*` | config | 性能预算（测试套件 300s / gate 600s） |
| `reviews.*.machine_checks` | rules | 机器判据（含 `perf_anti_patterns` 性能反模式） |
| `runtime.taskLoop.*` | rules | 轮询节拍 / 工作窗 / 草稿跳过 / 建议项开关 |
| `runtime.headless.executor` | rules | 执行器（autoclaw/cli）+ envNotes 环境事实 |
| `runtime.budget` | rules | maxRounds=3 / 活动墙钟 / 认领 TTL |
| `runtime.feishu.*` | rules | 优先级门控 / 迭代前缀过滤（凭据在 ~/.harness） |
| `gates.blockedCommands` | config | 高危命令拦截表（带等价安全写法提示） |

改动即生效的项（不用重装定时器）：pollSeconds、activeHours、executor、envNotes、fixSuggestions。

## 治理三件套

1. **架构守护**：机器健身函数（每次 gate，report 模式不阻存量）+ architect agent（adr/tier-3 触发）+ 周期健康报告。PR 侧用 `--strict` 拦新增违规。
2. **性能可见**：CR 反模式静态扫描（零 token）→ verify-run 耗时 vs 基线四档比对 → F5 验证耗时趋势（增长>30% 黄牌）→ doctor 预算对照。
3. **CR 循环**：risk_tier≥MEDIUM 必须 `ai-review --type cr`（独立脚本读 git diff，会话隔离防自审），≤3 轮预算，超限升级 human_decision。

## 深入阅读

- [guides/快速上手.md](guides/快速上手.md) —— 五步从零到 task-loop
- [docs/01-requirements/](docs/01-requirements/) —— 需求规格（每特性一份 RS）
- [docs/03-decisions/](docs/03-decisions/) —— 技术决策记录（ADR）
- [retro/](retro/) —— 复盘全档（踩坑第一现场）
- [.skills/deployment/references/pitfall-checklist.md](.skills/deployment/references/pitfall-checklist.md) —— 53 条已知坑（跨项目可迁移）
- [AGENTS.md](AGENTS.md) —— 给所有 CLI 的常驻规则（路由表 + 红线）

## 红线（不许做）

- 不删 `verify` 字段、不改 `status` 枚举、不手改生成物（`.claude/`、`.zcode/`、`prompts/`）与考卷区（`hooks/`、`templates/`、`agents/`、`harness.config.json`、`harness.rules.json`）
- 不 `git push --force`（用 `--force-with-lease`）、不 `rm -rf /`、不读 `.env`、不管道执行远程脚本
- 不绕过影子周直接真跑；凭据只进 0600 文件（`~/.harness/`），绝不进 git
- agent 代提交必须显式 `GIT_AUTHOR_*/GIT_COMMITTER_*` 指向本人
