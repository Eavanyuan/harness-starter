---
name: harness
stack: harness
version: 1.0.0
stage0: true
applies_to:
  - "hooks/**"
  - "scripts/**"
  - "agents/**"
  - "templates/**"
  - "harness.config.json"
  - ".claude/settings.json"
  - ".zcode/config.json"
  - ".github/workflows/**"
references:
  - references/checklist.md
---

# Harness 自身开发

改门禁、生成器、agent 定义、模板时加载。**不管**业务代码（走 `backend` / `frontend`）与业务文档内容（走 `docs` 模板）。

判断标准很简单：**你改完之后，别人「什么算合格」的定义变了没有。** 变了就走这里。

## Stage 0（动手前强制）

| # | 读什么 | 为什么非读不可 |
|---|---|---|
| 0.1 | `references/checklist.md` | 我们自己在门禁上踩过的 17 个失效点，其中 8 个是"门禁根本没到场" |
| 0.2 | 本次要改的 hook/脚本全文 + 调它的地方（`hooks/hooks.manifest.json` / `package.json` / CI） | 门禁的通路只有"被接线"这一条，改完没接线等于没改 |
| 0.3 | `test/` 下对应测试文件 | 先看现有用例覆盖了哪条路径，避免只加"拦得住"不加"不误拦" |

前置自检（全 ✅ 才允许 Edit / Write）：

- [ ] 能说出本次改动会让哪一类行为从「放行」变成「拦截」，或反之
- [ ] 已确认接线点：hook 进 `hooks/hooks.manifest.json`（再由 `build:hooks` 生成两套 CLI 配置），脚本进 `package.json` 与 CI
- [ ] 知道要新增哪几个测试场景，其中至少一个**正向**（必须放行）用例
- [ ] 改的是判定逻辑还是阈值？阈值优先改 `harness.config.json`，不要改代码
- [ ] 新增的判定依赖的事实，在 `git clone` 出来的目录里还成立吗？不成立就只能留在本地口径

## 分流

| 走哪条 | 判据 |
|---|---|
| 全流程 | 改动会改变判定口径（新增规则、改拦截条件、改 schema） |
| debug 快速路径 | 修文案、补漏注册、修路径拼接、加测试用例 |

走 debug 时一旦发现「原判定本身是错的」，立即切回全流程：**判据变化必须留下可评审的痕迹**，否则下一个人无法解释这条门禁为什么长这样。

## 硬规则

| # | 规则 | 怎么查 |
|---|---|---|
| H1 | 改 `hooks/**` 或 `scripts/**` 必须同批新增测试场景，没有测试的门禁改动一律不合 | `git diff --name-only HEAD \| rg '^(hooks\|scripts)/'` 非空时，`git diff --name-only HEAD \| rg -c '^test/'` 必须 > 0 |
| H2 | 生成物禁止手改，只能改源 + 重建 | `npm run check:agents && npm run check:hooks`（漂移即失败） |
| H3 | 解析失败必须 fail-closed，不许 `return 0` 伪装放行 | `rg -n "=== null" hooks/*.mjs` 逐处确认后面跟的是 `deny` 而不是 `exit(0)` |
| H4 | 黑名单/白名单/受保护区只写在 `harness.config.json`，代码里不出现字面量 | `rg -n "'rm -rf\|--no-verify\|\.claude/agents/\*\*" hooks/*.mjs` 应无输出 |
| H5 | 每个 skill 的 Stage 0 ≤ 5 项、单文件 ≤ 200 行、深度 ≤ 2 层 | `npm run check:skills` |
| H6 | 新增拦截规则时，同一批必须给出「如何合法绕过」，否则第一次误报就会被整体关掉 | 看 PR 描述里有没有写 allowlist 用法 |
| H7 | 新增 hook 必须同时接进两个 CLI（ZCode 需 `hooks.enabled: true`），只接一个按"没接"计 | `bash test/wiring.test.sh` |
| H8 | 配置里新增的功能键必须有消费者，否则 doctor 报红 | `npm run doctor` 的「配置键均有消费者」一项 |

## 交付

1. 改动的判定口径前后对比（一句话：以前放行什么、现在拦什么）
2. `npm run gate` 的原始输出（`.ai/verify/<todo>.log`）
3. 新增测试场景清单，标注正负向
4. 剩余风险：这条规则在什么情况下会误报、谁可能被误伤

## 按需加载

- 写新 hook 前的失效模式自查 → `references/checklist.md` §常见失效点
- 门禁与 CI 的分工 → `guides/多人协作最佳实践.md` §三层分治
