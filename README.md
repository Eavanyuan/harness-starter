# harness-starter

一套能让 **3 种 CLI、多个工程师** 共用同一条 AI 编码流水线的脚手架。

它不解决"让 AI 更聪明"，解决的是另外两件事：
**AI 的产出能不能被机器验收**，以及**换个人、换个模型，标准还是不是同一个**。

---

## 运行时前提（先用 30 秒确认，别等第一次 hook 报错）

| 前提 | 硬不硬 | 说明 |
|---|---|---|
| **Node ≥ 18** | **硬依赖** | 全部 hook 与脚本是 `.mjs`。纯 Java / Go 团队和 CI runner 上常常没有 Node——**装 Node 是使用这套 harness 的成本**，不是可选优化 |
| **bash** | **硬依赖** | `scripts/init-harness.sh`、`test/*.sh`、`scripts/verify-run.sh`。Windows 原生 cmd/PowerShell **不支持，请走 WSL** |
| git | 建议 | `change` 任务的 `--baseline` 校验、产物漂移检测要用；非 git 目录会降级跳过并提示 |

`node scripts/harness-cli.mjs check <dir>` 一条命令打印这三项的真实状态；缺失硬前提时
**`init` 会直接拒绝安装**（exit 69），不会装到一半才发现跑不起来。脚本里的日期一律用
`date -u +%Y-%m-%dT%H:%M:%SZ`（POSIX 可移植），macOS / Linux / WSL 行为一致。

---

## 5 分钟上手

```bash
npm run doctor              # 先体检：模板态下会提示 stacks.*.dir 是占位值（不阻塞，退出码 0）
npm run build:agents        # 从 agents/ 生成三套 CLI 产物
npm run build:hooks         # 从 hooks/hooks.manifest.json 生成两套 CLI 的 hook 接线
npm run check:skills        # 确认 .skills/ 结构完整、引用不断
npm run gate                # 门禁 + 全部自测套件（14 组，含审核自动化与通知回投）
bash scripts/init-harness.sh my-feature M   # 新功能（默认 --type feature）
bash scripts/init-harness.sh my-change M --type change --related my-feature --baseline <commit>  # 需求变更
bash scripts/init-harness.sh my-bug M --type bugfix --related my-feature                        # 缺陷修复
```

`doctor` 在模板态只提醒不报红（`project.name` 还是 `harness-starter` 时算模板态）；
把它改成真实项目名、`stacks` 指向真实目录之后，占位值就会变成阻塞问题。
`gate` 检查的是"配好之后对不对"——那是必须全绿的。

然后任选一个入口：

```bash
/task 做一个按标签筛选列表的功能     # Claude Code / ZCode
```

DeepSeek 或无 subagent 的 CLI：打开 `prompts/agents/orchestrator.md` 贴进上下文，或按 `prompts/INDEX.md` 取对应角色。

---

## 三种 CLI 怎么接

| CLI | 形态 | Agent 入口 | Hook 接线 | 还需要做什么 |
|---|---|---|---|---|
| Claude Code | subagent | `.claude/agents/*.md`、`.claude/commands/*.md` | `.claude/settings.json`（生成） | 无，clone 即用 |
| ZCode | subagent | `.zcode/agents/*.md` | `.zcode/config.json`（生成，`hooks.enabled: true`） | 首次运行需在 ZCode 里**确认信任工作区 hook**；未确认前门禁不生效 |
| DeepSeek（Anthropic 兼容端点） | subagent | 同上（复用 `.claude/`） | 复用 `.claude/settings.json` | `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` |
| DeepSeek（独立 CLI / 纯 API） | prompt-only | `prompts/agents/*.md` + `AGENTS.md` | **无**（该形态没有 hook 机制） | 只有 CI 兜底，本地没有任何硬门禁 |

关键点：**以上四行不需要维护四份内容。** Agent 从 `agents/*.agent.md` 生成，hook 接线从
`hooks/hooks.manifest.json` 生成，改一处，各处同步；`--check` 进 CI 防漂移。

两处必须知道的差异（不知道就会误以为有门禁）：

- ZCode 执行工作区 hook 属于"执行本地代码"，默认不信任。先在 ZCode 设置里确认，否则 hook 静默不跑；
  这种状态下只有 CI 兜底，`npm run doctor` 能看出接线是否存在，但看不出"人有没有点信任"。
- DeepSeek 独立调用那条路径**没有任何 hook**。所以 `.ai/rules/verification.md` 的纪律靠 CI + 人审兜底，
  不要在文档里写"hook 硬拦"——那是只有 Claude / ZCode 且已信任时才成立的事实。


---

## 目录

```text
agents/                  ← 唯一事实源，11 个 <name>.agent.md
harness.config.json      ← 三 CLI 能力映射 + 高危命令清单 + 技术栈命令 + skill 校验参数
harness.rules.json       ← 审核路由与通知路由的机器可执行规则（rs/fs/adr/cr/evidence）
AGENTS.md                ← 常驻规则（所有 CLI 都读）

.skills/                 ← 领域知识层：怎么改这个栈的代码
  backend/SKILL.md       ←   Java：Stage 0 / 分流 / 8 条硬规则 / 交付
  frontend/SKILL.md      ←   Vue：7 条硬规则
  e2e/SKILL.md           ←   Playwright：6 条硬规则
  harness/SKILL.md       ←   门禁与生成器自身：8 条硬规则 + 37 个已知失效点（references/checklist.md）
  SKILL.template.md      ←   加新栈时复制它
  references/            ←   长表（反例、检测命令、场景），SKILL.md ≤ 200 行，超了就拆到这里

.claude/  .zcode/  prompts/     ← 生成物，不要手改
scripts/build-agents.mjs        ← Agent 生成器；`--check` 即漂移检测，`--prune` 清理孤儿文件
scripts/build-hooks.mjs         ← Hook 接线生成器：一份 manifest → .claude/settings.json + .zcode/config.json
scripts/doctor.mjs              ← 配置体检：占位值、接线缺口、空转配置键、僵尸任务、门禁在场性（runner/批准规则）
scripts/review-router.mjs       ← MR 变更 → 该跑哪些审核（零 LLM；无槽代码可见化）
scripts/ai-review.mjs           ← 模式 B 审核：L0 机器判据零 token 先行 + 预打包单发 + 🔴 退码 1
scripts/harness-broker.mjs      ← 通知事件桥：GitLab webhook 入 / 方案 D 决策落账，不写 state 不合 MR
scripts/feishu-ws.mjs           ← 飞书长连接入站（内网零开放端口），配 lib/ws-client + lib/feishu-frame
scripts/reviews/                ← 各审核类型的判据清单（rs/fs/adr/cr，改判据改这里）
scripts/lib/                    ← 共享库：review-rules（路由）/ review-checks（L0）/ notify（卡片）/ decision-from-git

hooks/
  hooks.manifest.json    ← hook 接线的唯一源（哪个事件、匹配什么、跑哪个脚本）
  lib/verify.mjs         ← 校验核心，hook 与 CI 共用；按 local / ci 两种口径判
  guard_state.mjs        ← 拦住"把 state.json 写成没证据的完成态"
  guard_command.mjs      ← 拦住高危命令与敏感文件读取
  guard_write.mjs        ← 拦住手改生成物、改考卷区、写凭据
  session_start.mjs      ← 换人接手时注入当前进度 + 当前模型档位
  allowlist.txt          ← 命令例外（带到期日）
  write-allowlist.txt    ← 写入受保护区的例外（带到期日）
test/                    ← 14 组自测：hooks / evidence / wiring / writes / agents / skills / init /
                           harness-cli / verify-run / ledger / completeness / router / ai-review /
                           notify-broker（含方案 D）/ feishu-ws；另有 e2e（真 GitLab，npm run e2e）
                           与 regress-p2.sh（恒退 1 的缺陷复现器，不进 gate）

.ai/
  rules/verification.md  ← L0 规则，永不裁剪
  tasks/<slug>/state.json ← 一个任务一份状态
  writes.json            ← 从 agents/*.agent.md 投影出的写入域，供人评审与 CI
  verify/<todo-id>.log   ← 验证证据，入库（跨任务同名会被 --task 归属检查拒覆盖）
  review/                ← 手动/推送前审查记录（CR 模板全量条款）
  ledger/                ← deny.jsonl（误拦率基线）+ events.jsonl（观测面，gitignore）
templates/               ← 9 张文档模板（RS/FS/ADR/MATRIX/SR/WBS/CR/RETRO/TRACE）
guides/                  ← 多人协作最佳实践 + 审核与通知自动化接入指南
retro/                   ← 复盘沉淀（外部系统借鉴候选，各带触发条件）
docs/                    ← 工件（需求、规格、ADR）
```

---

## 一个任务长什么样

```text
/task 需求
  └─ orchestrator 建 state.json，定档 M
      ├─ /rs     → docs/01-requirements/01-xxx.md      [人审]
      ├─ /adr    → docs/06-reference/adr/001-xxx.md     [人拍板·仅架构级]
      ├─ /fs     → docs/02-features/xxx/fs-xxx.md
      ├─ /sr     → fs-xxx.review.md                     🔴 清零才放行
      ├─ /wbs    → state.todos + xxx.wbs.md             ← 拆自已评审的 FS
      ├─ /impl   → 源码 + .ai/verify/T1.log
      ├─ /test   → 测试 + .ai/verify/V1.log
      ├─ /cr     → 审查意见                              [人 approve]
      ├─     CI  → quality-gate
      └─ /retro  → retro/2026-xx-xx-xxx.md → skill 修订
```

`/wbs` 排在 `/sr` 之后不是排版问题：任务叶子的验收标准只能来自已评审的 FS。
先拆任务再评审设计，拆的是想象——FS 补齐后 WBS 往往不回头，于是要么出现悬空任务
（做出来没人要），要么漏做（FS 小节没有对应任务）。`ci-verify` 的完备性检查会双向比对
这张 WBS 与 FS 的小节集合。

每个箭头处的门禁**要么是文件检查、要么是命令退出码、要么是 mtime 比较**，
没有一条是"模型说它做完了"。

门禁不过就停在原地等人——这是正确行为，但停下来的任务需要一个**回来的入口**，
而且**停点本身要能被人从容处理**：8 条决策平铺成 9 道闸门，人的正确反应是"回头再说"。

`harness-cli resume <项目> <slug>` 做三件事：

1. 按**是否挡路**分三档列出待决事项（必须现在定 / 可以先干再定 / 按建议默认即可）。
   分档只认 blocker 里的显式字段 `blocking` `defer_until` `default_ok`，**不从建议文本里猜**——
   猜错等于替人授权；
2. 把待决项渲染成 `.ai/tasks/<slug>/DECISIONS.md`：选项带编号、建议与依凭齐全，
   可在编辑器里填、可转发给同事、可隔天再定。**人已经填好还没应用的输入不会被刷新覆盖**；
3. 回填入口三个，都要求 `--by`（无记名记录不算数）：
   ```bash
   resume . <slug> --from DECISIONS.md --by 张三           # 从决策单读回（推荐）
   resume . <slug> --accept-suggested --by 张三            # 批量接受第三档（可 --except D7）
   resume . <slug> --decide "D1=1,3" --by 张三            # 逐条，值必须是选项编号
   ```
   决策值会校验是否落在 `options` 内（多选需 `multi: true`），自由文本直接拒绝——
   否则选项表只是装饰，机器无法判断人到底选了啥。

决策齐备后自动推进阶段并重跑可机器判的门禁。

mtime 只在**本地 hook** 里比：开发者工作树里它是真事实。CI 跑在全新 checkout 上，
git 不保存 mtime，检出后所有文件同一时刻——所以 CI 只判 git 里可复现的事实
（日志是否入库、exit_code 是否 0、声明文件是否存在）。假装 CI 也能判新鲜度，
结果就是把合规 PR 判红，然后整套门禁被人关掉。本地口径也承认 mtime 的弱处：
clone / checkout 会把整棵树的 mtime 按检出顺序重排，所以与 HEAD 一致的文件有
检出宽限窗（`gates.verifyFreshnessGraceSec`，默认 120s），工作树里有差异的文件零容忍。

---

## 审核与通知自动化（MR 触发，2026-11 起）

会话内的门禁只拦"走 CLI 的那条路"；**MR 是个人纪律与团队纪律的分界线**，所以
审核到场靠 MR 变更自动路由，不靠人记得发起：

```bash
node scripts/review-router.mjs --base origin/main...   # 变更文件 → 该跑哪些审核（零 LLM）
node scripts/ai-review.mjs --type rs --base origin/main...  # L0 机器判据零 token 先行 + 单发语义审
node scripts/ai-review.mjs --type cr --dry-run ...     # 打包统计，0 次 API 调用
```

- **路由规则全在 `harness.rules.json`**（rs / fs / adr / cr / evidence），改路由改数据不改代码。
- **退出码即门禁**：0 过 / 1 有 🔴（pipeline 红 → 挡合入）/ 2 基础设施失败——失败绝不产出"通过"。
- **省 token 分层**：机器判据（模板章节、引用存在、验收可测）零 token 先跑；预打包上下文
  硬顶（文件数/行数）；未变更文件沿用上轮结论；每次运行的 token 用量入 `events.jsonl` 账本。
- **无槽可见化**：代码文件不属于任何审核槽时，router 提示 + `uncovered_code` 入账 + 卡片点名
  ——静默缺席比没有审核更危险，可见缺席才有得治。
- **无模型 key 没有悄悄降级**：机器判据干净但无凭据时 exit 2（fail-closed）；要只跑机器判据须显式 `--machine-only`。

通知侧是 `harness-broker`（薄事件桥）：GitLab webhook 入 → 路由 → 飞书卡片**票拟找人**（批红按钮）；
决策可走**方案 D**——人在 RS 文档「开放问题」行写「已裁决：X」提交，broker 从 push diff 落账
（身份取 commit author，内网零开放端口）。broker 不写 state、不跑 agent、不合 MR。
`doctor` 另有**门禁在场性**体检：无活跃 CI runner = 阻塞、MR 批准规则缺位 = 提醒——
演练实证过这两个缺位会让"CI 兜底 / 批红强制"变成空话，落地当天就要看得见。

接入手册（env、`.gitlab-ci.yml` 样例、部署边界、L2 真 GitLab 演练坑）：
[`guides/审核与通知自动化.md`](guides/审核与通知自动化.md)。

---

## 常用命令

```bash
npm run doctor           # 配置体检：占位值 / 接线缺口 / 空转配置键 / 僵尸任务
npm run build:agents     # 生成三套 Agent 产物
npm run build:hooks      # 生成两套 hook 接线
npm run check:agents     # 校验产物与源一致（CI 同款）
npm run check:hooks      # 校验接线与 manifest 一致（CI 同款）
npm run check:skills     # 校验 .skills 结构 / 断链 / 行数 / 级联
npm run resolve:skills -- --diff   # 本次改动该加载哪些 skill
npm run verify:state     # 证据链 + 文档完备性（CI 口径）
npm run verify:state:local # 证据链（本地口径：额外判新鲜度与 72h 时效）
npm run test:hooks       # state 门禁 / 高危命令 / 敏感文件
npm run test:evidence    # 证据链口径（含干净检出回归）
npm run test:completeness # 文档完备性（RS/FS/WBS 三层，含"写全了但写错了"的边界）
npm run test:wiring      # hook 接线（两个 CLI 都要有）
npm run test:writes      # 写入边界
npm run test:agents      # 产物契约
npm run test:skills      # 校验器自测（确认它真能拦住）
npm run test:init        # init 脚本 slug 白名单与 JSON 合法性
npm run test:harness-cli # 安装/探测/退出工具自测（夹具在 test/fixtures/）
npm run test:verify-run  # 证据包装器：头部字段、计数聚合、退出码、--task 归属
npm run test:ledger      # 账本读取端：误拦率分组 + events 在线记录
npm run test:router      # 审核路由（含无槽可见化与 fs 补槽）
npm run test:ai-review   # L0 判据 / 模式B / fail-closed / token 计量
npm run test:broker      # 卡片渲染 / webhook 鉴权 / 方案 D 决策落账
npm run test:feishu-ws   # 飞书长连接：握手 / 分片 / 去重 / 失败重投
npm run e2e              # L2：真 GitLab 端到端（需本地实例，退出码 78 = 环境未起）
npm run ledger:report    # 拦截面统计：哪条规则在拦、拦了谁、那段时间门禁在不在线
npm run gate             # 上面全部一起跑（已含 doctor）

bash scripts/verify-run.sh T1 -- mvn -q test -Dtest=FooTest
bash scripts/verify-run.sh --task <任务名> T1 -- <命令>   # 声明证据归属，跨任务同名日志拒绝静默覆盖
# 日志头固定 4 行（有 surefire 报告时第 5 行是计数）：
#   # cmd / # started / # finished / # exit_code / # tests: total=N …
# 校验器只认前 5 行——贴过来的 BUILD SUCCESS 不算证据，因为头部不是它写的。
bash scripts/init-harness.sh <slug> [S|M|L|XL] [--type feature|change|bugfix] [--related <slug>] [--baseline <commit-hash>]

node scripts/harness-cli.mjs resume /path/to/project                 # 有哪些任务卡着、卡在哪
node scripts/harness-cli.mjs resume /path/to/project <slug>           # 三档待决清单 + 生成 DECISIONS.md
node scripts/harness-cli.mjs resume /path/to/project <slug> \
  --from DECISIONS.md --by 张三                                       # 读回填好的决策单（推荐）
node scripts/harness-cli.mjs resume /path/to/project <slug> \
  --accept-suggested --except D7 --by 张三                            # 批量接受"按建议默认"那一档
node scripts/harness-cli.mjs resume /path/to/project <slug> \
  --decide "D1=1,3" --by 张三                                         # 逐条（值必须是选项编号）
node scripts/harness-cli.mjs resume /path/to/project <slug> \
  --resolve "B1=换到有子 agent 的会话" --by 张三                      # 能力/环境类阻断

node scripts/harness-cli.mjs review-packet /path/to/project <slug>           # 评审包（markdown，直接贴 PR）
node scripts/harness-cli.mjs review-packet /path/to/project <slug> --first   # 强制按首版口径

node scripts/harness-cli.mjs verify /path/to/project --json              # 统一验证入口（机器可读）
node scripts/harness-cli.mjs verify /path/to/project --mode local        # 本地口径：额外判 72h 新鲜度
```

`verify` 是**不依赖 hook 载荷**的入口：它只读磁盘，所以 cron、post-checkout、CI 之外的
worker 交付前检查都能用同一个判据。退出码 0 过 / 1 不过 / 2 无法判（输入不存在）/ 64 用法错。
`--json` 输出 `{ok, mode, root, checked, problems, notices}`——给机器读，别去 grep 中文提示。

退出码可直接用于自动化：`0` 无阻塞（决策齐备且门禁全 pass 时会自动推进阶段）、
`3` 还有"必须现在定"的未解项，或机器校验/本阶段门禁没过、`64` 用法错误（含决策值不在选项内）。

"可以先干再定"（`defer_until`）与"按建议默认"（`default_ok`）那一档**不挡推进**，也不改退出码——
三档分诊要同时进呈现和判定，否则屏幕分了档、判定还按一档算。

它只重跑**机器可判**的门禁（`adr_human_decision_records`：决策是否齐备且记名）与
`hooks/lib/verify.mjs` 里的判据（阶段枚举、TODO 证据链、impl 收尾、追溯链）；语义判断仍归人。
state 里每个字段是"判据 / 索引 / 声明"哪一档，见 `docs/06-reference/state-fields.md`。

## 把本仓库装进别的项目（harness-builder v1）

```bash
node scripts/harness-cli.mjs check  /path/to/project    # 运行时前提：node≥18 / bash / git / 构建根
node scripts/harness-cli.mjs detect /path/to/project    # 栈与 CI 平台探测（只读）
node scripts/harness-cli.mjs analyze /path/to/project --out /tmp/rp   # 事实视图：依赖图/热点/风险（只读）
node scripts/harness-cli.mjs init   /path/to/project    # 安装模板 + build + doctor + manifest
node scripts/harness-cli.mjs init   /path/to/project --dry-run        # 三态预览：create/skip/conflict
node scripts/harness-cli.mjs init   /path/to/project --agents read-only   # 第 1 周只读子集
node scripts/harness-cli.mjs init   /path/to/project --stack-dir services/api  # 多构建根时选主栈
node scripts/harness-cli.mjs remove /path/to/project --yes             # 按 manifest 干净退出
```

安全内核：已存在的文件一律不覆盖（标 conflict）；写入路径不得逃逸目标目录、拒绝穿越
symlink（`analyze --out` 用 realpath 判定，`ln -s 目标目录 /tmp/rep` 这类绕过会被拒）；
写入是原子的（临时文件 + rename），manifest 先落 `pending` 再落 `complete`，崩溃也不留无主文件。

`remove` 只删 manifest 里逐个列出的文件（**不递归删目录**——你后来放进 `.claude/agents/` 的文件不会丢），
目录仅在变空后回收；安装后被改过的文件（sha256 不符）会先警告并要求 `--force`，此时 `--yes`
**不删任何东西并以 exit 2 退出**（给了 `--yes` 却什么都没删，不能报成功）。

归属与恢复（v4 起）：

- **生成物归属由生成器声明**：`build-agents.mjs` / `build-hooks.mjs` 的 `--manifest` 回报"我写了哪些文件"，
  `init` 只认这份清单。按目录扫描认领会把用户自己的 `.claude/commands/deploy.md` 也记成"我们的"，
  remove 时直接删掉——hash 保护救不了它（hash 是对用户文件算的，天然"未改动"）。
- `manifest.foreign` 记录**安装前就存在**的文件，`remove` 永不删。
- `build` 覆盖安装前已存在的生成物（如 `.ai/writes.json`、`.claude/settings.json`）时，原内容备份到
  `.ai/backup/<ts>/` 并在输出里点名——覆盖是必要的（生成物必须重写），但必须可恢复且不留暗账。
- `manifest.files` 按合并语义维护：package.json / .gitignore / CI workflow 这类**条件生成项**
  第二轮 `init` 不再进 plan，旧记录必须保留，否则 `remove` 会把它们落在原地还宣称"退出干净"。

配置不是模板占位值：`init` 用探测结果回填 `project.name` 与 `stacks`（Java/Maven、Java/Gradle、
TS/Vue 生成命令；Go/Python/Rust 只识别、标 `unsupported` 留空——不发明命令）。多构建根时
`detect` 列出全部候选并要求 `--stack-dir` 选主栈，其余标 unsupported。探测是正则级事实视图
（`scripts/lib/analyzer.mjs`），**不是架构结论**。

`analyze` 的报告要能被人复核，所以三件事是刻意的：**四类 import 口径互斥且相加等于总数**
（内部已解析 / 内部未解析 / 外部包 / 标准库），**未解析留前 10 条样本**（只给数字等于不给），
**明细边默认上限 5000 并显式标记 `edges_truncated`**（TDC 的 8959 条会让 `analysis.json` 到 1.9MB，
agent 直接读会撑爆上下文；结论字段按全量算，要全量明细加 `--full-edges`）。
装了 harness 的项目会按 `.harness-manifest.json` 排除工具自身文件，排除数量写在 evidence 里。

三个"把人接回流程"的配置项（v1.1 起，均有代码消费，`doctor` 会查）：

| 键 | 作用 | 不配的后果 |
|---|---|---|
| `promotionDir`（默认 `docs/plans`） | 决策冻结后 RS/FS 定稿的落位；`check` 校验它**落在某个 agent 的 writes 里** | 流程走到"移至 docs/plans/"这一步谁也没权限，静默断掉 |
| `runtime.spawn_agents / shell / ask_user` | 宿主会话能力声明；SessionStart 每次开场打印 | 声明与运行时脱节：按 spawn 流程起手、到 impl 才发现没子 agent，前三阶段白跑 |
| `gates.blockedCommands` 的 `hint` | 每条规则**自己的**修复建议（字符串写法仍兼容） | 15 条规则共用一段文案，拦到 `-DskipTests` 却在讲强推，被拦的人照着改改不好 |

`deny.jsonl` 每条带 `source` 字段：`tool` 是真实拦截，`selftest` 是自测探测。
两者混在一起时，账本作为"误拦率基线"就没有意义了——测试请设 `HARNESS_LEDGER_SOURCE=selftest`
（已内置在 `test/*.sh`）。

完整方案见 `docs/plans/2026-10-30-harness-builder-final.md`（基线校准/flows 裁剪/知识侦察在 v2/v3）。

**npm 分发约定（防模板漂移）**：`package.json` 的 `bin.harness` + `files` 已配好，
`npm pack --dry-run` 应能看到 `scripts/ hooks/ agents/ templates/ .skills/ test/ guides/ .ai/rules/
.github/ harness.config.json .gitignore`（模板就是本仓库，没有第二套模板）。
**只在仓库 tag 上发包**——`git checkout <tag> && npm pkg delete private && npm publish`，
包版本取 tag，不手改包内容。日常开发用 `node scripts/harness-cli.mjs`，不发包也能用。

---

## 六条设计取舍

**1. 单一源 + 生成，而不是三份手写。**
3 个 CLI × 11 个 agent = 33 份文件。手写的结局是三个月后三套行为不一致，
而且没人说得清"正确的那个"是哪一套。生成 + CI 漂移检测把这个问题变成构建期错误。

**2. 约束代码化，知识保留 prompt。**
"不许做什么"必须确定（hook + CI）；"怎么做"需要人读和频繁改（markdown）。
判据见 [`guides/多人协作最佳实践.md`](guides/多人协作最佳实践.md)。

**3. 不追求全自动门禁。**
审计四项里只有 `compile` / `tests` 能机器验，`feature_complete` / `quality_clean` 靠人。
假装能全自动，只会催生一堆形式化断言。门禁守的是**最低限度的诚实**，不是正确性。

**4. skill 只允许两层，单文件 ≤ 200 行。**
这条是踩出来的：需求方最初那套 backend skill 要求动手前连读 12 个文件，其中 6 个是子 skill 的子 skill。
实际效果是模型读了 3 个就开始写码，剩下 9 个在自检表里被打了勾——**而且是编造的**。
深度限制和行数上限不是为了整洁，是为了让"是否真的加载过"可以被检验。
超限时 `check:skills` 直接报错，不给"下次再拆"的空间。

**5. 按路径判，不按 agent 身份判。**
`agents/*.agent.md` 里有 `writes` 字段，但 CLI 的 PreToolUse 载荷里**没有 agent 名**，
判不出当前是哪个 agent 在写。靠 `state` 自报身份只是把"自觉"换了个位置。
所以 `guard_write` 只判路径（生成物 / 考卷区 / 凭据），`writes` 则投影成 `.ai/writes.json`
供人评审与 CI diff——**能判定的做成机制，判不了的做成可读的清单**，不假装。

真正能收紧某个 agent 权限的只有一条：改 `capabilities`，让工具集里干脆没有那个工具。
文字禁令在压力下必然失效，裁剪能力不会。

这条取舍的残余风险要摆在明面上：声明了窄 `writes` 的 agent（含只写文档的，
如 spec-reviewer）在运行时仍可用 Write 覆盖未受保护的业务源码——hook 判不出它是谁。
这道风险的兜底是 CR 与 `.ai/writes.json` 的 CI diff，不是 hook。
没有 capabilities 裁剪或进程级沙箱之前，把它说成"契约"，不要说成"门禁"。

**6. 判不了的就不假装判得了（本地口径 ≠ CI 口径）。**
上一版在 CI 侧也用 mtime 判证据新鲜度。git 不保存 mtime，全新 checkout 上所有文件同一时刻，
于是一份完全合规的证据（真日志、exit_code=0、审计四项齐备）在 PR 里必然判红——
门禁把好人拦在门外，比不设门禁更快被人整体关掉。
现在两边共用同一份校验库，但**口径分开**：本地判"日志晚于源码 + 72h 内"，
CI 只判 git 里可复现的事实（日志入库、exit_code=0、声明文件存在）。
判不了的东西写进文档让人审兜底，而不是编一条只在本地成立的规则，然后在 CI 上爆炸。

---

多人协作的完整方案（谁改什么、怎么避免互相踩、豁免怎么治理）见
[`guides/多人协作最佳实践.md`](guides/多人协作最佳实践.md)；
审核与通知自动化的接入手册见
[`guides/审核与通知自动化.md`](guides/审核与通知自动化.md)。
