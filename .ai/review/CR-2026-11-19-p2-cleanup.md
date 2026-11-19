# CR 代码审查记录 — p2-cleanup 体检 P2 清理（本地审查）

- 审查范围：`14a0f7f` → 工作区。注意：三 lib 删除已随 `5fb8963` 提交（信息标 docs(audit)），未提交部分为 `scripts/task-loop.mjs` + `test/task-loop.test.sh`，合计 7 文件（6+/252-）。
- 关联任务：`.ai/tasks/p2-cleanup/state.json`（change tier 2，related=task-loop，baseline=14a0f7f）
- 关联 FS/ADR：`docs/06-reference/adr/ADR-010-task-loop.md`
- **已加载的 skill**：`resolve-skills --diff` → harness v1.1.0（命中 scripts/task-loop.mjs, test/task-loop.test.sh）
- 审查者：code-reviewer（独立复核，2026-11-19）

## 0 硬规则逐条核（harness skill H1-H9）

| # | 规则 | 检测命令 | 结果 |
|---|---|---|---|
| H1 | 改 scripts/** 同批须有测试 | diff 同时含 `scripts/task-loop.mjs` 与 `test/task-loop.test.sh`；**本 CR 实跑 `bash test/task-loop.test.sh` → 128 通过 0 失败**（P2D1.log 同数） | ✅ |
| H2 | 生成物禁手改 | diff 无 `.claude/.zcode/prompts`；`npm run check:agents`（68 文件一致）+ `check:hooks`（接线一致）实跑通过 | ✅ |
| H3 | 解析失败 fail-closed | 无解析逻辑改动（纯删除+一行清理），删库本身无生产消费者 | 未命中 |
| H4 | 名单只写在 harness.config.json | 无新增名单/字面量；`grep -i 'attribution\|baseline\|ci-watch' harness.config.json` 无命中——删除不产生孤儿键（H8 同判） | 未命中 |
| H5 | skill 结构约束 | `npm run check:skills` 5 个全过（.skills/ 未动） | ✅ |
| H6 | 新拦截须给绕过 | 无新增拦截 | 未命中 |
| H7 | 新 hook 双 CLI 接线 | 无 hook 改动（hooks.manifest.json 未动） | 未命中 |
| H8 | 配置键必须有消费者 | 同 H4 查法：删库在 config 中无键，无孤儿 | ✅ |
| H9 | 断言可证伪 | 新断言 `test/task-loop.test.sh:1125`（`!existsSync …/traces/91`）：去掉 `task-loop.mjs:565` 的 rmSync 即红（5k e2e phase 4 `closed` 条件失配 → 汇总 grep 红）。变异**未实跑**（只读审查不改源），建议父 agent 合并前跑一次 |

## 1 改动摘要

体检 P2 三件事：① 删三死码 lib（attribution/baseline/ci-watch）+ 仅覆盖它们的三段测试；② task-loop 关账两分支（Draft 关账 :527、真终态关账 :565）各加 `traces/<id>` 递归清理（体检 C3 泄漏）；③ 体检报告 Y7 按用户纠正改判（12 agent 保留全集，判定作废）。

## 2 阻断项 🔴

无。逐条独立复核结果：

- **零消费**：全仓 grep（scripts/hooks/test/deploy/CI）对三删库的 import 仅剩 `.ai/review/` 报告、state.json 历史字段、`.zwork/` 运行产物——代码与测试中 0 引用，与 B 审计 R1-R3 一致。
- **未误删活码测试**：同文件保留的 fingerprint 纯函数段（:1850 起，import :1853-1869）与 session-pack 段（:1875 起，import :1878）完好，`fingerprint.mjs`（failureFingerprint/extractFailures/setDiff）与 `session-pack.mjs`（readSessionArtifacts 等 5 export）仍在且被消费——删的 4 个检查点只覆盖已删 lib。
- **rmSync 两处位置正确**：写入方 `task-loop.mjs:789` `join(root,'.ai','task-loop','traces',String(t.id))` 与清理方 `join(ackDir,'traces',String(id))`（ackDir=:500 即 root/.ai/task-loop）逐字一致；Draft（:527）与真终态（:565）分支均覆盖；:585 重认领分支保留 traces 属正确（任务仍活）。
- **测试**：本 CR 实跑 128 通过 0 失败；`node --check scripts/task-loop.mjs` 过。

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | `docs/06-reference/adr/ADR-010-task-loop.md:31-33`；`.ai/tasks/p2-cleanup/state.json:104` | B 审计 R2 要求「删 + ADR-010 D5 补一行演进注记」，只做了删：D5 仍以现在时写「采纳：基线在 merge-base 上实跑」，而该实现 11-17 已被目标分支流水基线取代、11-19 连实现一起删了。state.json audit 声称「演进注记随 baseline 删除自动成立」——删代码不会注记文档，与 ADR 现状矛盾 | D5 补一行「11-17 起被目标分支流水基线取代，11-19 baseline.mjs 已删」，并修正 state.json audit 措辞 | 修（随本批，一行） |
| 2 | `.ai/tasks/p2-cleanup/state.json:102`（audit.tests） | 「task-loop 125→128」口径不可复核：实测基线 14a0f7f 的 check 调用 132 处、当前 128、净删恰为被删的 4 个检查点（baseline e2e 2 + 三分流 1 + CI 盯梢 1）；「125」无出处 | 改为「132→128（删 4 检查点）」，retro 同步 | 修（合批时顺手） |
| 3 | 提交 `5fb8963` | 信息标 `docs(audit)` 却夹带 163 行 lib 删除，只字未提删码——git log 检索「删 attribution」找不到它，追溯只能靠 state.json 兜底 | 剩余 task-loop.mjs/test 提交时信息如实（如 `refactor(cleanup): …`），retro 注明删库部分已随 5fb8963 落地 | 修（下次提交起） |

## 仅记录（不阻断）

- Draft 关账分支（:527）的 traces 清理无独立断言，与 :565 同构一行，风险低；真终态路径已由 :1125 覆盖。
- task-类 ack（非 mr-）无关账路径（:513 注释，KI-1 已登记），其 traces 同样不清——存量已知问题，非本次范围。
- `id` 源自本地 ack 文件（自家脚本从 GitLab iid 写入、数字型），与既有 `pack-${id}.md` 删除同一攻击面，未新增注入面；如要收紧可加 `/^\d+$/` 校验。
- state.json:104 `flappyFailures` 拼写（应为 flippyFailures），无实质影响。

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| 三删库的 import 方 | 无 | 全仓 grep：生产 0、测试 0（唯一消费者即被删测试段，B 审计 R1-R3 同判） |
| task-loop.mjs 调用方（launchd/systemd 定时器、install-task-loop.sh、e2e） | 无行为变化 | 新增清理只在两关账分支内；实跑套件 128 全绿 |
| traces 写入方（:789） | 清理路径一致 | ackDir(:500) 推导逐字对齐，见 §2 |
| `harness.config.json` 消费者表 | 无孤儿键 | grep 无 attribution/baseline/ci-watch 键 |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入（命令/路径） | 无新增面；id 未校验为纯数字（见仅记录第 3 条） |
| 越权 | N/A（本地单用户 harness） |
| 敏感信息进日志 | 无（清理只删 traces，不打印内容） |
| 依赖变更 | 无 |

## 6 测试覆盖

| 新增行为 | 是否有对应测试 | 备注 |
|---|---|---|
| 真终态关账清 traces | 是（:1125，5k e2e phase 4） | 负向存在性断言，可证伪（去 :565 rmSync 即红） |
| Draft 关账清 traces | 否 | 仅记录第 1 条 |
| 删码不破坏保留段 | 是（fingerprint/session-pack 段随套件实跑通过） | export 与 import 双向核对仍活 |

## 7 结论

- 🔴 数量：0
- 🟡 已全部表态：是（3 条，处置均为修，无一需打回重做）
- 建议：**approve**——三件声称的事全部独立核实成立（零引用、两处 rmSync 位置与路径正确、Y7 纠正落档），套件实跑 128 全绿；🟡#1（ADR 一行注记）建议随批补上，#2/#3 合批时顺手修正即可。

## 审阅范围与未覆盖

- 已核：基线→工作区全部 7 文件 diff；H1-H9 逐条（§0）；三删库全仓引用检索；traces 写/清路径一致性；task-loop 关账全分支语义（Draft/真终态/ci_green_hold/ack_stale/task-KI1）；task-loop 套件实跑（128/0）；check:agents/check:hooks/check:skills 实跑；Y7 文档 diff。
- 未核：`npm run gate` 全量（跨套件，建议父 agent 合并前跑）；H9 变异检验实跑（只读审查不能改源，已给出变异路径）。
