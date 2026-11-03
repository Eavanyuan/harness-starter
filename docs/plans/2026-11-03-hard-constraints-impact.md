# 硬约束落地前的影响评估（2026-11-03）

> 目的：在把「软约束」变成「硬约束」之前，先确认每一步会动到谁、谁会变红、能不能回滚。
> 结论不是「都做」，而是 **可做 2 条、改形态 1 条、撤回 1 条**。

## 0. 核查得到的事实（可复跑）

| 事实 | 证据 |
|---|---|
| `npm run gate` 有 16 步，CI 只跑 11 步 | `package.json` 的 gate 串 vs `.github/workflows/quality-gate.yml` |
| 不在 CI 里的 5 个测试文件合计约 **87s** | harness-cli 66.6s、completeness 8.7s、init 6.4s、verify-run 4.5s、ledger 1.3s（本机实测） |
| 完整 gate 约 **110s** | 上述 87s + hooks/writes/agents/skills/doctor/check:* |
| 存量 state：starter 2 份、TDC 2 份，全部 schema 1、stage=impl | `for f in .ai/tasks/*/state.json` |
| `local` 口径判 72h 新鲜度，`ci` 口径不判 | `ci-verify.mjs:8-10, 53`；`--local` 才切 |
| `check-skills` 的 200 行上限只作用于 `SKILL.md` | `check-skills.mjs:163`（`${lines}` 取自 SKILL.md）；`checklist.md` 已 501 行，无上限 |
| 有 4 条断言在 toybox/busybox 的 grep 下恒红 | `grep -q "a\|x"` 在 BRE 下不支持交替；`/usr/bin/grep`（BSD, GNU compatible）能过 |

最后一条不是仓库缺陷，但它说明：**判据对执行环境有隐式假设，换环境结论就变**。这类断言不该出现在"硬约束"里。

## 1. ① 状态驱动的判据入口 —— 可做，但必须显式口径

**做法**：新增 `harness verify --json [--mode local|ci]`，只读磁盘，不依赖 stdin payload。

**影响面**：

- 纯新增子命令，**不修改 `hooks/lib/verify.mjs`** → TDC 的副本无需同步，TDC 零影响。
- 对 `guard_state` / `guard_write` / CI 全部无行为变更（它们各自调各自的）。
- 风险只有一处：**口径**。默认必须是 `ci`（宽松），因为新入口会被用在"干净检出"的场景；若默认 `local`，任何没跑过 72h 内验证的 PR 都会被判红。反过来，默认 `ci` 时"证据过期"这件事就没人管，所以 `--mode` 必须显式出现在帮助里，且未知值报错而不是降级（沿用 `ci-verify.mjs:46-48` 的白名单策略）。

**回滚**：删子命令，无副作用。

## 2. ② 给每条约束登记 claim 者 —— 可做，但要分批，且要改命名

**做法**：`checklist.md` 36 条各标一个执行者（`guard_write` / `gate:test-xxx` / 无人）。

**影响面**：

- 不会让 `check:skills` 变红（references 无行数限制）。
- 会变长 501 → 约 540 行，作为 skill reference 进入上下文，成本可接受。
- **真正的风险不是技术，是语义**：如果 36 条里有 20 条标"无人"，这份清单当场从"约束"降级成"愿望清单"。所以不能一次标完，应该**只标能指到执行者的，其余单列一节「待补执行者」**——清单本身仍然是约束，缺口是可见的待办。
- 第二个风险：标完没人读，又是一条软约束。缓解办法是让 gate 校验"每条 claim 者指向的东西真实存在"（比如 `gate:test-hooks` 必须在 gate 串里）。

## 3. ③ stage 变成推导值 —— **撤回，不做**

核查后结论：`stage` 不是状态，是**过程事实**。

`state_history` 每条记录的是 `entered_at / exited_at / gate / waived_by / agent / model`（见 `.ai/state.example.json`）。这些无法从磁盘产物反推：

- 谁在什么时候过的这道闸；
- 谁签的豁免（`waived_by: "张三（无架构级取舍…）"`）；
- 用的是哪个模型、哪版 skill。

如果 stage 由产物推导，这些字段全部失去来源，"评审发生过"就降级成"相关文件存在"。而 `checkStage` 的输入正是 `stage_history`——拆掉它等于拆掉现有判据的地基。

**能做的只有单向一致性**：`stage` 已越过某阶段，但该阶段产物不合格 → 判红。这件事 `checkCompleteness` 已经在做（自带阶段门槛，`ci-verify.mjs:95-101`）。方向是对的，不需要新机制，只需要继续往这个方向加判据。

## 4. 建议的落地顺序

| 步 | 内容 | 风险 | 验证方式 |
|---|---|---|---|
| 0 | 把 4 条依赖 `\|` 交替的断言改成 `grep -E`（或改用 node 判） | 极低，只动测试 | 在 toybox 与 BSD grep 下都跑一遍，确认 23/23 |
| 1 | `harness verify --json --mode ci\|local` | 低，纯新增 | 对同一份 state 跑出与 `ci-verify` 一致的结果；TDC 侧不动 |
| 2 | checklist 加 claim 列（能指到执行者的先标） | 低，文档 | `check:skills` 仍绿；新增"claim 者存在性"断言 |
| 3 | CI 补 `test:completeness`(8.7s) + `test:ledger`(1.3s) | 低，+10s | CI 时间从 ~25s 到 ~35s |
| 3b | `test:harness-cli`(66.6s) 单独 job 或 nightly | 中，CI 时间翻倍 | 单独 workflow，不阻塞 PR |
| — | stage 推导 | 高，破坏 stage_history | 不做 |

## 5. 不做的事，以及为什么

- **不做 pre-commit 全量 gate**：110s 的前置钩子必然被 `--no-verify` 绕过，而 `--no-verify` 正是 `guard_command` 拦的命令之一——门禁会逼人学会绕过门禁。
- **不做 ③**：见第 3 节。
- **不把 5 个测试一次性塞进 CI**：87s 的增量会让 PR 反馈从 30s 变 2min，代价是开发者开始忽略 CI。

## 6. 落地结果（2026-11-03）

按 0 → 1 → 3 执行，② 按评估推迟（等入口稳定后再做覆盖矩阵），③ 未做。

| 步 | 实际改动 | 验证 |
|---|---|---|
| 0 | `test/agents.test.sh` 4 条 `\|` 交替改 `grep -qE` / `-qF` | 在 toybox grep 下也 23/23 |
| 1 | `ci-verify.mjs` 增 `--json`、`--mode ci\|local`；`harness-cli.mjs` 增 `verify` 子命令（spawn，不复制判据） | `test/harness-cli.test.sh` 新增 8 条（含反向：无证据的完成态必须红；拼错的 `--mode` 必须 64） |
| 3 | CI 增 `test:completeness` + `test:ledger`（约 10s） | workflow 新增两步 |

全套 gate：**11 个文件 / 472 条断言 / 0 失败**，证据 `.ai/verify/HARDEN-VERIFY-ENTRY.log`（exit 0）。

未做且仍待决定：`test:harness-cli`（66.6s）是否另起 job；checklist 的覆盖矩阵。

