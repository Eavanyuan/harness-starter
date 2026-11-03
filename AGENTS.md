# AGENTS.md

> 给所有 CLI 读的常驻规则。Claude Code / ZCode 可用 `CLAUDE.md` 引用本文件；无 subagent 的 CLI 直接把它当 system prompt。
> **保持精简。** 这里每多一行，模型对真正的任务就少一分注意力。

## 这是什么仓库

一套 AI 编码流水线脚手架：11 个 agent 分工、状态机、门禁、证据链。
`agents/*.agent.md` 是 **agent 的唯一事实源**；`hooks/hooks.manifest.json` 是 **hook 接线的唯一源**。`.claude/`、`.zcode/`、`prompts/` 全是生成物。

## 硬规则（每次都要生效）

1. 验证纪律见 `.ai/rules/verification.md`，五条不裁剪。验证命令**必须**用 `bash scripts/verify-run.sh <todo-id> -- <命令>` 包装——裸跑的日志无标准头，CI 判"未入库"。
2. 进度只认 `.ai/tasks/<slug>/state.json`，不认会话记忆。一个任务一份，并行任务不要合并。
3. 改代码前必须加载 `applies_to` 命中的 `.skills/*/SKILL.md`，其 `## Stage 0` 未完成不得动手（读不完等于没有）。
4. **审查代码（无论正式 CR 还是本地随手审）同样必须先跑 `resolve-skills --diff` 并按命中 skill 的硬规则表逐条核**。不加载 skill 就审 = 凭记忆操作 = 没审。审查产出按 `templates/CR-代码审查记录.md` 格式（含 §0 硬规则逐条核表）。
5. 只读 agent 不许调 `Edit` / `Bash` 改源码。改 `agents/*.agent.md` / `hooks.manifest.json` 后必须跑 `build:agents` / `build:hooks`。
7. **变更/缺陷修复不新建独立流程**——用 `bash scripts/init-harness.sh <slug> S --type change --related <原任务> --baseline <commit>` 建关联任务。不加 `--type`/`--related` 的 change 会在追溯链校验时被拦（checkTaskTraceability）。

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

## 意图路由（先分类，再动手——禁止跳过分类直接改代码）

| 人的意图 | 任务类型 | 正确入口 | 禁止 |
|---|---|---|---|
| 新功能 / 新能力 | feature | `/task <需求>` 或 `init-harness.sh <slug> S` | 直接开始写代码 |
| 改已交付功能的行为 | change | `init-harness.sh <slug> S --type change --related <原任务> --baseline <commit>` | 不加 `--related`/`--baseline` 就改 |
| 修 bug / 改错误行为 | bugfix | `init-harness.sh <slug> S --type bugfix --related <来源>` | 不建 state 就修、无复现测试就标修复 |
| 纯重构（不改行为） | change (tier 1) | 同 change，`change_tier=1` + 无行为变更说明 | 顺手改行为 |
| 审查代码 | — | 先 `resolve-skills --diff` 再按 skill 硬规则逐条核 | 不加载 skill 就审 |
| 写测试 | — | 先 `resolve-skills --diff` 再写 | 不加载 skill 就写 |

> **判定不准时问人**（"这是改需求还是修 bug？"），不要自行归类后走错流程。
> 已有任务在跑时先 `ls .ai/tasks/`——不要在已有任务的 impl 阶段另建新任务做同一件事。

## 当前任务

```bash
ls .ai/tasks/ && npm run verify:state
```
接手：读 state 确认 stage（rs→…→done 链上），按 `artifacts` 定位产物续跑。**不要凭 git log 推断。**

## 不许做

- 不许绕过门禁：删 `verify` 字段、改 `status` 枚举、`ooda_stage` 填 `act`——`guard_state` 拦，CI 再判。
- 不许 `git push --force`、`rm -rf /`、读 `.env`（`.env.example` 例外）、管道执行远程脚本。
- **硬门禁不是处处都有**：Claude / 已信任 ZCode 拦；DeepSeek 独立调用、人手动 commit 只有 CI 兜底。
- 不许手改生成物（`.claude/`、`.zcode/`、`prompts/`）；不改考卷区（`hooks/`、`templates/`、`agents/`、`harness.config.json`）——需改由人加 `hooks/write-allowlist.txt` 带到期日放行条并同批补测试。
- 不许在共享分支上改别人的 `state.json`。

## 写入范围

`writes` 在 `agents/*.agent.md` 声明，投影到 `.ai/writes.json`。`guard_write` 按路径判（生成物/考卷区/凭据），不按 agent 身份判。收紧权限改 `capabilities`（裁工具集），那是唯一真正生效的手段。
