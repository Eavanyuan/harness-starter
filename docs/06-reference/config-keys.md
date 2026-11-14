# 配置键总览（config-keys）

> **这是什么**：harness 三处配置（`harness.config.json`、`harness.rules.json`、环境变量与凭据文件）的全部键、默认值、消费方，一页查完。给改配置、装机、排障的人看。
> **适用范围与前提**：harness-starter v1.1（config `version: "1.1"` / rules `schema_version: 1`）。全部条目按 `scripts/`、`hooks/` 源码逐一核对（rg，2026-11-14）；未在代码中找到读者的标 **TODO**。
> **版本**：2026-11-14 v1 初版。来源：`.ai/review/harness易用性与配置面评估.md` C4（后加配置键无汇总文档）。

通例：优先级 **进程 env > 配置文件 > 内置兜底**，空串按「没配」处理。「doctor 登记」指 doctor 的配置键消费名录——键空转（配置了没人读）会被 doctor 判红。

## 1. harness.config.json（⚠️ 考卷区，改需放行条）

### 项目与流程

| 键 | 默认/当前值 | 消费方 | 说明 |
|---|---|---|---|
| `version` | `"1.1"` | **TODO**（未见机器消费） | 配置格式版本标识 |
| `project.name` | `"harness-starter"` | harness-cli init（回填）、doctor（模板态提示） | 项目名；接真实项目先改它 |
| `project.defaultFlowTier` | `"M"` | init-harness.sh | init 不给档位时的缺省流程档（S/M/L/XL） |
| `project.trustLevel` | `"L1"` | init-harness.sh | 信任级别，写进任务 meta |
| `promotionDir` | `"docs/plans"` | scripts/lib/cli/check.mjs | FS 定稿晋升目录；必须落在某个 agent 的 writes 里，否则定稿无处落盘 |
| `runtime.spawn_agents` / `runtime.shell` / `runtime.ask_user` | `"unknown"` | harness-cli runtime（回写） | 宿主会话能力声明；unknown=未验证，orchestrator 首段自检后改真值 |

### 栈与项目

| 键 | 默认/当前值 | 消费方 | 说明 |
|---|---|---|---|
| `stacks.<id>.{dir,srcGlob,lint,test,testOne}` | backend/frontend 两槽 | check-skills、doctor、build-agents、lib/review-rules（v1 兼容） | v1 栈对象；与 v2 `projects` 只能选一种形态（有 `projects` 时以它为准） |
| `projects[].{id,dir,srcGlob,lint,test,testOne}` | TDasset 旁挂两条 | lib/review-rules（cr 源码路径）、doctor（lint/test 命令撞黑名单反查）、check-skills（合法 stack id） | v2 项目数组；`reviews.cr.paths_from="projects"` 的路径来源 |

### skills 与 agents

| 键 | 默认/当前值 | 消费方 | 说明 |
|---|---|---|---|
| `skills.dir` | `".skills"` | **无读者**——check-skills / resolve-skills 硬编码 `.skills`（TODO：接线或删键） | skill 根目录（当前仅声明态） |
| `skills.maxLines` | `200` | check-skills | 单份 SKILL.md 行数上限 |
| `skills.requiredKeys` | name/stack/version/stage0 | check-skills | frontmatter 必填键 |
| `skills.requiredSections` | `## Stage 0` / `## 硬规则` / `## 交付` | check-skills | 必须出现的章节 |
| `skills.extraStacks` | `["harness"]` | check-skills | stacks 之外的受管 stack 白名单 |
| `agents.enabled` | 11 个全列（删键=全部启用） | build-agents | agent 启用清单；必须含 orchestrator；改后跑 `npm run build:agents` |
| `capabilityMap.<能力>.<cli>` | claude/zcode 有工具名，deepseek 空 | build-agents | 能力→各 CLI 工具名映射；未定义的能力直接 die |

### 生成目标与 hook 接线

| 键 | 默认/当前值 | 消费方 | 说明 |
|---|---|---|---|
| `targets.<cli>.{enabled,mode,agentsDir,commandsDir,hooksFile}` | claude/zcode=subagent，deepseek=prompt-only | build-agents、build-hooks、doctor（校验） | 生成目标与落点；deepseek `hooksFile: null`（无 hook，只有 CI 兜底） |
| `hooks.manifest` | `"hooks/hooks.manifest.json"` | build-hooks、doctor | hook 接线唯一源的路径 |
| `modelTiers[].{id,label,agents,scaffold}` | strong=light，standard=full | hooks/session_start（判档分流）、doctor 登记 | 按模型名定 scaffold 档；light 只豁免逐任务 TODO 提醒，不豁免技能加载与证据链 |

### 门禁（gates）

| 键 | 默认/当前值 | 消费方 | 说明 |
|---|---|---|---|
| `gates.requireVerifyLog` | `true` | hooks/lib/verify | false=全局跳过证据校验（别关） |
| `gates.verifyFreshnessHours` | `72` | hooks/lib/verify | 本地口径证据时效（小时） |
| `gates.verifyFreshnessGraceSec` | `120` | hooks/lib/verify | 新鲜度判据的 clone 检出宽限窗（秒），防全新 clone 整片误报 |
| `gates.blockedCommands[]` | 15 条 `{pattern,hint}` | guard_command、hooks/lib/shell、hooks/lib/verify（验证命令纪律）、doctor（反查 projects 命令） | 高危命令黑名单；命中即拦并给出修法文案 |
| `gates.sensitiveRead[]` | `.env`/`.pem`/`.key`/`id_rsa` 等 7 条 | guard_command（Read 工具与 Bash 读类命令**共用**同一份） | 敏感读路径正则 |
| `gates.writeGuards.{generated,protected,sensitive,sensitiveExempt}` | 见文件 | hooks/lib/path_guards（guard_write 与 shell 写通道共用） | 三类写入拦截的路径 glob；按路径判，不按 agent 身份判 |
| `gates.shell.stateGlob` | `.ai/tasks/*/state.json` | guard_command | shell 通道一律禁写的 state 路径 |
| `gates.shell.evidenceGlob` | `.ai/verify/**` | guard_command | shell 通道一律禁写的证据路径 |
| `gates.extraSourceGlobs[]` | hooks/scripts/templates 三条 | hooks/lib/verify | 本地新鲜度口径追加的源码 glob（CI 口径不判新鲜度） |
| `gates.staleTaskDays` | `3` | doctor | 未封闭任务停滞判据（天）；0/负数/非数字判配置错误，不静默失效 |
| `gates.retroCheckFromDate` | `"2026-11-11"` | ci-verify、hooks/lib/verify | retro 落盘判据起算日，早于它的存量任务不追溯 |
| `notes.*` | — | 无人读 | 背景注释 |

## 2. harness.rules.json（✅ 改数据不改代码）

### 审核路由（reviews）

| 键 | 默认/当前值 | 消费方 | 说明 |
|---|---|---|---|
| `schema_version` | `1` | lib/review-rules（≠1 直接拒） | 规则文件格式版本 |
| `reviews.<id>.title` | — | ai-review（prompt 前缀）、broker（卡片） | 审核类型显示名 |
| `reviews.<id>.paths` 或 `paths_from`+`fallback_paths` | rs/adr/fs 直配路径；cr `paths_from:"projects"` | review-router、broker | 变更文件命中即路由到该审核；cr 源码路径取 projects[].dir，无配置仓库退 `fallback_paths` |
| `reviews.<id>.checklist` | `scripts/reviews/<type>.md` | ai-review（L1 静态前缀）、lib/review-rules（校验） | AI 审核清单文件；声明了但仓库没有 = exit 2 |
| `reviews.<id>.machine_checks[]` | rs/fs/adr 各若干 | ai-review（L0 零 token 判据，经 lib/review-checks 注册表） | 未知 check id 直接 exit 2，不静默跳过 |
| `reviews.<id>.model_tier` | narrow 或 deep | ai-review | 模型档位，对应 `model_tiers.<档>.model` |
| `reviews.<id>.max_findings` | 10（fs 为 15） | ai-review | findings 输出上限，红优先保留 |
| `reviews.<id>.approval_role` | tech_lead / code_owner / machine | broker（经 notify.roles 转显示名） | 批红角色 |
| `reviews.evidence.{always,runner}` | `true` + ci-verify | review-router | 证据链校验不走 AI，真实变更必跑 |

### 模型与打包

| 键 | 默认/当前值 | 消费方 | 说明 |
|---|---|---|---|
| `model_tiers.narrow/deep.model` | `""` | ai-review | 留空回落 env `AI_REVIEW_MODEL` |
| `bundle.max_files` / `max_lines_per_file` | `12` / `600` | ai-review | L1 预打包硬顶；超限截断并在结论注明 |
| `skip.noise_paths[]` | lock 文件、`.ai/ledger/**` 等 7 条 | lib/review-rules | diff 噪声过滤 |
| `code_hints.ext[]` | 17 种源码扩展名 | lib/review-rules | 命中又不属任何审核槽 → 进 uncovered 可见化（只提示不阻断） |

### 运行时（runtime）

| 键 | 默认/当前值 | 消费方 | 说明 |
|---|---|---|---|
| `runtime.gitlab.url` | `"https://git.tdengine.net"` | lib/gitlab-config | 接哪个实例；优先级 `GITLAB_URL` > `HARNESS_GITLAB_URL` > 此键。空=不接（扩展项，不算故障）。**token 永不进此文件** |
| `runtime.feishu.projectKey` | `"taosdata_td"`（兜底空串=不接） | lib/feishu-bug-source（task-loop 剖面 B） | 飞书项目空间 key；是空间事实，换空间必改 |
| `runtime.feishu.taskTypes` | `["Defect"]` | 同上 | 轮询的工作项类型，可多个 |
| `runtime.feishu.assigneeField` | `current_status_operator` | 同上 | 「指派给我」的字段 key（不是 owner） |
| `runtime.feishu.newStatus` | `"New"` | 同上 | 「未开始」状态 label；认领后状态流转即天然去重 |
| `runtime.feishu.mqlLimit` | `20`（代码硬顶 50） | 同上 | MQL 单次拉单上限 |
| `runtime.feishu.issuer` | `"https://project.feishu.cn"` | 同上 | 飞书项目根地址 |
| `runtime.feishu.severity.{field,fieldName,map}` | `field_6bff71` / 故障严重级别 / 高→P1 中→P2 低→P3 | 同上 | 自定义严重级字段与 P 档映射（fieldName 供人读）；P0/P1 自动接、P2 待确认、P3 不接 |
| `runtime.feishu.iteration.{field,fieldName,prefix}` | `field_a7de08` / 迭代周期 / `IDMP` | 同上 | 产品线过滤；field 与 prefix 任一为空整体关闭（兜底=关） |
| `runtime.taskLoop.pollSeconds` | `7200`（再兜底 180） | task-loop | **真实轮询节拍**；OS 定时器只是心跳上限。`TASK_LOOP_INTERVAL` 可临时覆盖；改配置下一拍生效，免重装 |
| `runtime.headless.{cli,args,permission_mode,hooks}` | `claude` / `["-p"]` / `acceptEdits` / `true` | task-loop | 无头会话剖面；`hooks` ≠ false 时目标仓无 hook 接线拒绝启动 |
| `runtime.budget.{maxRounds,maxActiveMs,claimTtlMs}` | `3` / `1800000` / `86400000` | task-loop、lib/task-loop-core、lib/claim | 单任务修复轮次上限 / 活动墙钟（等 CI/人审不计）/ 认领 TTL；缺省走库默认值 |

### 通知（notify）

| 键 | 默认/当前值 | 消费方 | 说明 |
|---|---|---|---|
| `notify.roles` | 6 个角色 | harness-broker | approval_role → 中文显示名 |
| `notify.card_events[]` | mr_open / pipeline_failed / review_blocked / decision_open | harness-broker | 推飞书卡片的事件集 |
| `notify.digest_events[]` | mr_merged / pipeline_success | harness-broker | 只进摘要不推卡片，防通知疲劳 |
| `notify.subscriptions.{defaults.delivery,persons}` | `digest` / `{}` | lib/subscriptions | 订阅三档 all/focused/minimal；降档必带升级时间 |
| `notify.git_decision.{enabled,approvers}` | `true` / `[]` | harness-broker | 决策走 git（方案 D）；approvers 空=靠分支保护，配邮箱=fail-closed |

## 3. 环境变量

### GitLab（统一解析入口 `scripts/lib/gitlab-config.mjs`，除注明外）

| 变量 | 默认 | 消费方 | 说明 |
|---|---|---|---|
| `GITLAB_URL` | 无 | gitlab-config、harness-broker、lib/notify | 实例地址，最高优先级 |
| `GITLAB_TOKEN` | 无 | gitlab-config、harness-broker | PAT（`private-token` 头只认 PAT；OAuth access token 会 401） |
| `GITLAB_USERNAME` | 无（用 token 调 GET /user 自取） | task-loop、lib/gitlab-triggers | 显式指定账号名；**配错会把你自己写的留言判成他人的打回意见（假触发）**，宁可不配 |
| `HARNESS_GITLAB_URL` / `HARNESS_GITLAB_TOKEN` | 无 | gitlab-config（兼容旧名，第二优先级） | 仅为兼容保留；新配置一律用 `GITLAB_*` |
| `HARNESS_GITLAB_PROJECT` | 无 | **doctor（唯一消费者）** | 门禁在场性检查的目标项目（`group/project`）；不配则该项只提醒「门禁在场性未检查」 |
| `GITLAB_PROJECT` | 无 | gitlab-config | `HARNESS_GITLAB_PROJECT` 的次选名 |
| `GITLAB_WEBHOOK_SECRET` | 空=不验 | harness-broker | GitLab webhook 鉴权；不设只限内网试点 |
| `GITLAB_DEFAULT_BRANCH` | `main` | harness-broker | push 事件判默认分支（决策落账只认默认分支） |
| `HOST` / `PORT` | `127.0.0.1` / `8788` | harness-broker | 监听面与端口；接回调必须显式 `HOST=0.0.0.0` |
| `NODE_EXTRA_CA_CERTS` | 无 | Node 运行时 | 内网自签 CA 证书路径（企业 CA GitLab 必配） |

### 飞书（FEISHU_* 全族；覆盖键优先级 env > `runtime.feishu` > 内置兜底）

| 变量 | 默认 | 消费方 | 说明 |
|---|---|---|---|
| `FEISHU_PROJECT_KEY` / `FEISHU_WORK_ITEM_TYPE` / `FEISHU_ASSIGNEE_FIELD` / `FEISHU_NEW_STATUS` / `FEISHU_MQL_LIMIT` / `FEISHU_SEVERITY_FIELD` / `FEISHU_ISSUER` / `FEISHU_ITERATION_FIELD` / `FEISHU_ITERATION_PREFIX` | 对应 `runtime.feishu` 兜底值 | lib/feishu-bug-source | 临时覆盖同名配置项（CI 指假端点、临时切空间） |
| `FEISHU_WEBHOOK_URL` | 无 | harness-broker | 群机器人 webhook（发卡片） |
| `FEISHU_VERIFY_TOKEN` | 无 | harness-broker | http 回调入站鉴权；未配置则决策回投 503 拒服务（ws 模式不需要） |
| `FEISHU_MODE` | 按 app 凭据自动选 | harness-broker | `http` \| `ws`；ws 只免「飞书→broker」入站边，GitLab webhook 仍要打得进来 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 无 | harness-broker、feishu-ws | 长连接凭据；`FEISHU_MODE=ws` 缺它们 exit 64 |
| `FEISHU_DOMAIN` | `https://open.feishu.cn` | harness-broker | Lark 国际版填 `https://open.larksuite.com` |
| `FEISHU_NAME_MAP` | `{}` | harness-broker | open_id → 姓名 的 JSON 映射 |
| `FEISHU_MCP_URL` | 无 | feishu-auth、lib/feishu-project-mcp | 插件身份的 MCP 端点（URL 里含 mcpKey/userKey） |
| `FEISHU_MCP_KEY` / `FEISHU_USER_KEY` | 无 | lib/feishu-project-mcp | 拆开给的插件凭据（与 MCP_URL 二选一） |
| `FEISHU_OAUTH_FILE` | `~/.harness/task-loop/feishu-oauth.json` | lib/feishu-oauth | OAuth 凭据落点 |

### AI 审核（ai-review）

| 变量 | 默认 | 消费方 | 说明 |
|---|---|---|---|
| `AI_REVIEW_BASE_URL` | `https://api.openai.com/v1` | ai-review | OpenAI 兼容端点（GLM/OpenAI/DeepSeek/自建网关均可） |
| `AI_REVIEW_API_KEY` | 无 | ai-review | 模型凭据；缺 key 且机器判据干净 → exit 2，拒绝装作通过 |
| `AI_REVIEW_MODEL` | 无（回落 `model_tiers`） | ai-review | 缺省模型名 |

### 节拍、根路径与装配

| 变量 | 默认 | 消费方 | 说明 |
|---|---|---|---|
| `TASK_LOOP_INTERVAL` | 无（回落 `pollSeconds` → 180） | task-loop | 临时覆盖轮询节拍（秒），演练/排查用 |
| `HARNESS_TIMER` | 无 | task-loop | `=1`（deploy 模板注入）时才做节流；手动 `--once` 不受限 |
| `HARNESS_ROOT` | 无（按脚本自身定位） | guard_state、session_start、init-harness.sh | 自测与 vendored 安装改判定的根路径 |
| `HARNESS_LEDGER_DIR` | `<root>/.ai/ledger` | hooks/lib/ledger、ledger-report、harness-broker | 账本目录重定向（测试/多仓库） |
| `HARNESS_ENV_FILE` | `~/.harness/task-loop/task-loop.env` | lib/env-file（runner 与 doctor 同一入口） | 凭据文件路径；优先级 进程 env > 文件 |
| `HARNESS_RULES_ROOT` | cwd | harness-broker | broker 读 rules 与账本的根目录 |
| `HARNESS_DECISION_MODE` | `callback` | lib/notify | `link` = 卡片按钮改跳 GitLab RS 编辑页（决策走 git） |
| `HARNESS_MODEL`（及 `ZCODE_MODEL` / `ANTHROPIC_MODEL` / `CLAUDE_MODEL`） | 无 | hooks/session_start | 判 modelTiers 档位，定 scaffold 输出 |

## 4. 凭据文件（`$HOME/.harness/task-loop/`）

| 文件 | 权限 | 消费方 | 说明 |
|---|---|---|---|
| `task-loop.env` | 0600 | task-loop、doctor（`loadTaskLoopEnv` 共读） | 纯 `KEY=VALUE` 数据（不执行、不 source）；安装器只代写 `GITLAB_URL` / `GITLAB_TOKEN` / `FEISHU_MCP_URL`；`HARNESS_GITLAB_PROJECT` 也可写在这里 |
| `feishu-oauth.json` | 0600 | feishu-auth、task-loop 剖面 B | 飞书 OAuth token；`feishu-auth.mjs login` 生成 |
| `gitlab-token` | 0600 | lib/gitlab-config | `GITLAB_TOKEN` 的文件回退（env 优先） |
| `run-round.sh` | 0700 | launchd/systemd 拉起 | 安装器生成的定时器执行体；只 export 路径，不含任何秘密 |

---

相关文档：[state-fields.md](state-fields.md)（state.json 字段契约）、[guides/快速上手.md](../../guides/快速上手.md)、[guides/审核与通知自动化.md](../../guides/审核与通知自动化.md)。
