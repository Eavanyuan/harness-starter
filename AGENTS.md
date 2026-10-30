# AGENTS.md

> 给所有 CLI 读的常驻规则。Claude Code / ZCode 可用 `CLAUDE.md` 引用本文件；无 subagent 的 CLI 直接把它当 system prompt。
> **保持精简。** 这里每多一行，模型对真正的任务就少一分注意力。

## 这是什么仓库

一套 AI 编码流水线脚手架：11 个 agent 分工、状态机、门禁、证据链。
`agents/*.agent.md` 是 **agent 的唯一事实源**；`hooks/hooks.manifest.json` 是 **hook 接线的唯一源**。`.claude/`、`.zcode/`、`prompts/` 全是生成物。

## 硬规则（每次都要生效）

1. 验证纪律见 `.ai/rules/verification.md`，五条不裁剪。
2. 进度只认 `.ai/tasks/<slug>/state.json`，不认会话记忆。一个任务一份，并行任务不要合并。
3. 改代码前必须加载 `applies_to` 命中的 `.skills/*/SKILL.md`，其 `## Stage 0` 未完成不得动手（读不完等于没有）。
4. 只读 agent 不许调 `Edit` / `Bash` 改源码——要改就抛 blocker。
5. 改 `agents/*.agent.md` 或 `hooks/hooks.manifest.json` 后必须跑 `build:agents` / `build:hooks`，否则 CI 挂。

## 找 skill

```bash
node scripts/resolve-skills.mjs --diff      # 本次改动该读哪些，别靠猜
```

| 你要改 | 先读 |
|---|---|
| `backend/` 下的 Java | `.skills/backend/SKILL.md` |
| `frontend/src/` 下的 Vue / TS | `.skills/frontend/SKILL.md` |
| `frontend/tests/e2e/` | `.skills/e2e/SKILL.md` |
| `hooks/`、`scripts/`、`agents/`、`templates/`、`harness.config.json` | `.skills/harness/SKILL.md` |
| 新栈 | 复制 `.skills/SKILL.template.md`，见 `.skills/README.md` |

## 找 agent

| 场景 | Claude / ZCode | DeepSeek（无 subagent） |
|---|---|---|
| 启动任务 | `/task <需求>` | `prompts/agents/orchestrator.md` |
| 写需求 / 审规格 | `/rs` `/sr` | `prompts/agents/requirement-analyst.md` |
| 编码 / 测试 / 审查 | `/impl` `/test` `/cr` | `prompts/agents/coder.md` |
| 全量索引 | `.claude/agents/` | `prompts/INDEX.md` |

## 当前任务在哪

```bash
ls .ai/tasks/          # 每个目录是一个任务
npm run verify:state   # 证据链是否成立（CI 口径）
```

接手别人的任务：先读 state，校验 `artifacts` 路径存在，再从当前 stage 续跑。**不要凭 git log 推断进度。**

## 不许做

- 不许绕过门禁：删 `verify` 字段、改 `status` 枚举、`ooda_stage` 填 `act` —— 写 state.json 时被
  `guard_state` 拦，CI 再判一次。`files: []` 的统一验证项照样要有日志。
- 不许 `git push --force`（含 `+main:main` 这类 refspec）、`rm -rf /`、读 `.env`（`.env.example` 例外）、
  管道执行远程脚本（`curl … | sh` / `wget … | bash`）。
- **硬门禁不是处处都有**：Claude / 已信任工作区 hook 的 ZCode 会拦；DeepSeek 独立调用、
  未信任的 ZCode、以及人手动 commit 都只有 CI 兜底。别把"有门禁"当默认前提。
- 不许手改生成物（`.claude/`、`.zcode/`、`prompts/`）：`guard_write` 直接拒。
- 不许改考卷区（`hooks/`、`templates/`、`agents/`、`harness.config.json`）：确需改，由人往
  `hooks/write-allowlist.txt` 加一行带到期日的放行条，并同批补测试。
- 不许在共享分支上直接改别人的 `state.json`。

## 写入范围

每个 agent 能写哪，写在 `agents/*.agent.md` 的 `writes` 里，生成后投影到 `.ai/writes.json`。
`guard_write` **按路径判**（生成物 / 考卷区 / 凭据），不按 agent 身份判——CLI 的 hook 载荷里没有 agent 名。
想收紧某个 agent 的权限，改 `capabilities`（裁剪工具集），那是唯一真正生效的手段。
