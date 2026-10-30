# harness-starter

一套能让 **3 种 CLI、多个工程师** 共用同一条 AI 编码流水线的脚手架。

它不解决"让 AI 更聪明"，解决的是另外两件事：
**AI 的产出能不能被机器验收**，以及**换个人、换个模型，标准还是不是同一个**。

---

## 5 分钟上手

```bash
npm run doctor              # 先体检：模板态下会提示 stacks.*.dir 是占位值（不阻塞，退出码 0）
npm run build:agents        # 从 agents/ 生成三套 CLI 产物
npm run build:hooks         # 从 hooks/hooks.manifest.json 生成两套 CLI 的 hook 接线
npm run check:skills        # 确认 .skills/ 结构完整、引用不断
npm run gate                # 门禁 + 六套自测
bash scripts/init-harness.sh my-feature M   # 建一个任务状态文件
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
AGENTS.md                ← 常驻规则（所有 CLI 都读）

.skills/                 ← 领域知识层：怎么改这个栈的代码
  backend/SKILL.md       ←   Java：Stage 0 / 分流 / 8 条硬规则 / 交付
  frontend/SKILL.md      ←   Vue：7 条硬规则
  e2e/SKILL.md           ←   Playwright：6 条硬规则
  harness/SKILL.md       ←   门禁与生成器自身：8 条硬规则 + 14 个已知失效点
  SKILL.template.md      ←   加新栈时复制它
  references/            ←   长表（反例、检测命令、场景），SKILL.md ≤ 200 行，超了就拆到这里

.claude/  .zcode/  prompts/     ← 生成物，不要手改
scripts/build-agents.mjs        ← Agent 生成器；`--check` 即漂移检测，`--prune` 清理孤儿文件
scripts/build-hooks.mjs         ← Hook 接线生成器：一份 manifest → .claude/settings.json + .zcode/config.json
scripts/doctor.mjs              ← 配置体检：占位值、接线缺口、空转的配置键、僵尸任务

hooks/
  hooks.manifest.json    ← hook 接线的唯一源（哪个事件、匹配什么、跑哪个脚本）
  lib/verify.mjs         ← 校验核心，hook 与 CI 共用；按 local / ci 两种口径判
  guard_state.mjs        ← 拦住"把 state.json 写成没证据的完成态"
  guard_command.mjs      ← 拦住高危命令与敏感文件读取
  guard_write.mjs        ← 拦住手改生成物、改考卷区、写凭据
  session_start.mjs      ← 换人接手时注入当前进度 + 当前模型档位
  allowlist.txt          ← 命令例外（带到期日）
  write-allowlist.txt    ← 写入受保护区的例外（带到期日）
test/hooks.test.sh       ← state 门禁 / 高危命令 / 敏感文件，25 个场景
test/evidence.test.sh    ← 证据链口径，9 个场景（含"干净检出不得误杀"回归）
test/wiring.test.sh      ← hook 接线，12 个断言（含"ZCode 侧必须有接线"）
test/writes.test.sh      ← 写入边界，15 个场景
test/agents.test.sh      ← 产物契约，14 个断言
test/skills.test.sh      ← skill 校验器能否拦住，17 个断言

.ai/
  rules/verification.md  ← L0 规则，永不裁剪
  tasks/<slug>/state.json ← 一个任务一份状态
  writes.json            ← 从 agents/*.agent.md 投影出的写入域，供人评审与 CI
  verify/<todo-id>.log   ← 验证证据，入库
templates/               ← 8 张文档模板（RS/FS/ADR/MATRIX/SR/WBS/CR/RETRO）
docs/                    ← 工件（需求、规格、ADR）
```

---

## 一个任务长什么样

```text
/task 需求
  └─ orchestrator 建 state.json，定档 M
      ├─ /rs     → docs/01-requirements/01-xxx.md      [人审]
      ├─ /wbs    → state.todos + xxx.wbs.md
      ├─ /adr    → docs/06-reference/adr/001-xxx.md     [人拍板·仅架构级]
      ├─ /fs     → docs/02-features/xxx/fs-xxx.md
      ├─ /sr     → fs-xxx.review.md                     🔴 清零才放行
      ├─ /impl   → 源码 + .ai/verify/T1.log
      ├─ /test   → 测试 + .ai/verify/V1.log
      ├─ /cr     → 审查意见                              [人 approve]
      ├─     CI  → quality-gate
      └─ /retro  → retro/2026-xx-xx-xxx.md → skill 修订
```

每个箭头处的门禁**要么是文件检查、要么是命令退出码、要么是 mtime 比较**，
没有一条是"模型说它做完了"。

mtime 只在**本地 hook** 里比：开发者工作树里它是真事实。CI 跑在全新 checkout 上，
git 不保存 mtime，检出后所有文件同一时刻——所以 CI 只判 git 里可复现的事实
（日志是否入库、exit_code 是否 0、声明文件是否存在）。假装 CI 也能判新鲜度，
结果就是把合规 PR 判红，然后整套门禁被人关掉。

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
npm run verify:state     # 证据链（CI 口径：入库 + exit_code + 声明文件存在）
npm run verify:state:local # 证据链（本地口径：额外判新鲜度与 72h 时效）
npm run test:hooks       # state 门禁 / 高危命令 / 敏感文件
npm run test:evidence    # 证据链口径（含干净检出回归）
npm run test:wiring      # hook 接线（两个 CLI 都要有）
npm run test:writes      # 写入边界
npm run test:agents      # 产物契约
npm run test:skills      # 校验器自测（确认它真能拦住）
npm run gate             # 上面全部一起跑

bash scripts/verify-run.sh T1 -- mvn -q test -Dtest=FooTest
bash scripts/init-harness.sh <slug> [S|M|L|XL]
```

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

**6. 判不了的就不假装判得了（本地口径 ≠ CI 口径）。**
上一版在 CI 侧也用 mtime 判证据新鲜度。git 不保存 mtime，全新 checkout 上所有文件同一时刻，
于是一份完全合规的证据（真日志、exit_code=0、审计四项齐备）在 PR 里必然判红——
门禁把好人拦在门外，比不设门禁更快被人整体关掉。
现在两边共用同一份校验库，但**口径分开**：本地判"日志晚于源码 + 72h 内"，
CI 只判 git 里可复现的事实（日志入库、exit_code=0、声明文件存在）。
判不了的东西写进文档让人审兜底，而不是编一条只在本地成立的规则，然后在 CI 上爆炸。

---

多人协作的完整方案（谁改什么、怎么避免互相踩、豁免怎么治理）见
[`guides/多人协作最佳实践.md`](guides/多人协作最佳实践.md)。
