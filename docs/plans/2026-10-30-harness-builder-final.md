# harness-builder 最终落地方案

> 2026-10-30 定稿（修订 v1.1）。综合三轮评审：初版设计（plan/apply 安全内核）、
> GPT MVP 文档（两段式写入、稳定 JSON 契约、运行期 profile）、GLM 两版迭代（npm 分发、
> 两层自检、基线校准、flows 进 config），以及第二轮差距评审（运行时前提、安装清单、
> 多栈、agent 子集、夹具、deny ledger、schema 版本、零测试语义）。
> 本文档取代 `2026-10-30-harness-builder-mvp.md` 作为唯一实施依据。

## 0. 一句话定位

一个零依赖 CLI，让**全新项目**一行命令获得本仓库的完整 harness + agent，让**存量项目**
在不被破坏的前提下被"收编"：机械探测确定性填配置，知识侦察产出带证据的草稿，
门禁从基线起步而不是从幻觉起步。

## 0.1 运行时前提（v1 必须探测并显式告知）

| 前提 | 说明 | 探测方式 |
|---|---|---|
| **Node ≥ 18** | 全部 hook 与脚本是 `.mjs`，这是硬依赖不是建议。纯 Java/Go 团队和 CI runner 常常没有 Node——必须在 adopt 探测阶段就明确告知"装 Node 是使用本 harness 的成本"，而不是等第一次 hook 报错 | `node -v` 解析主版本 |
| **bash** | `init-harness.sh` / `test/*.sh` 需要 bash；Windows 原生（cmd/PowerShell）不支持，**必须走 WSL** | `SHELL` / `bash --version` |
| git | change 基线校验（`git cat-file`）与漂移检测需要；非 git 目录降级跳过并提示 | `git rev-parse` |

**事实纠正**：本仓库脚本日期处理统一用 `date -u +%Y-%m-%dT%H:%M:%SZ`（POSIX 可移植），
不存在 `date -v` / `date -d` 分支，macOS / Linux / WSL 均可用。唯一真实缺口是 Windows 原生。

探测结果在 `plan diff` 预览的第一屏打印，缺失即 warn（不阻塞只读探测，阻塞 `--apply`）。

## 1. 命令面（4 个动词 + doctor 复用）

| 命令 | 场景 | 行为 |
|---|---|---|
| `harness init <dir>` | 全新项目 | 运行时前提检查 → 复制模板（含 `test/`）→ 收集 flag 写裁剪后 config → `build:agents` + `build:hooks` → doctor 绿 → 写安装 manifest → 输出四周节奏 checklist |
| `harness adopt <repo>` | 存量项目 | ① 前提探测 + 机械探测（只读）→ ② 基线运行（可选）→ ③ 提案暂存 + `plan diff`（创建/合并/跳过三态）→ `--apply` 原子落盘 → ④ build + doctor 收口 → manifest + checklist |
| `harness trim` | 两者 | 选 flows 档位 / 任务类型 / **agent 启用清单** → 写 config → trim linter 校验不变量 |
| `harness remove` | 两者 | 读 manifest 干净退出（见 §6） |
| `harness analyze <repo>` | 存量 | 机械探测的**事实视图**：`analysis.json` + `PROJECT-MAP.md`（含依赖图/热点/风险清单），只写到 `--out` 指定目录（默认目标项目之外），只读保证见 §11。引擎是 `scripts/lib/analyzer.mjs`（已存在） |
| `harness doctor` | 通用 | 复用现有，扩展读取 baseline.json / flows / agents.enabled |
| `harness recon` | 存量（v3） | **引导式会话**：拼装侦察 prompt + checklist，供普通会话执行（不建专用 agent） |

**交互纪律：flag 优先，交互兜底。** 所有命令可非交互执行（测试这么打），缺 flag 时才问答。

## 2. 分发形态：仓库为唯一源，npm 包为发布物

- 实现落在仓库内（`scripts/harness-cli.mjs` + `scripts/lib/`），单一源
- release 时从仓库打包零依赖 npm 包（`"bin"` + `"files"`，无 dependencies），包版本 = 仓库 tag
- **只从仓库 tag 发包，不手改包内容**——写进 README release 章节，防模板漂移
- 包内嵌当前仓库作为模板："全新项目默认 = 当前 harness + agent"由复制保证，无第二套模板

## 3. 存量自检：两层分开

### 第 1 层 · 机械探测（确定性，无 LLM，秒级）

- **构建体系**：`pom.xml / package.json / go.mod / pyproject.toml / Cargo.toml` → 填 `stacks`。
  **MVP 只为 Java + TS/Vue 生成命令**，其余标记 `unsupported` 留空——不发明命令
- **多栈/多模块（v1 显式拒绝静默）**：检测到多个构建根（三服务 + 两前端 + 一共享库）时，
  v1 不猜测：列出全部候选，要求 `--stack-dir` 选主栈，其余写入 adoption 清单标 `unsupported`。
  **v2** 把 `stacks` 从 `{backend, frontend}` 键值平铺升为 `projects: [{dir, stack, ...}]` 数组，
  coder 的 `<backend-dir>` 占位符按任务所属 project 解析
- **CI 平台**：`.github/` / `.gitlab-ci.yml` → 生成对应门禁接线文件
- **依赖图（内置兜底）**：JS/TS import 解析、Java import→类文件映射，聚合为顶层目录 mermaid
- **热点与风险**：高扇入/扇出 Top10、超 500 行巨石文件、循环依赖、无测试目录/无构建清单
- **产出契约**：带 `schema_version` / `evidence` / `warnings` / tool metadata 的稳定 JSON，
  报告默认写到**目标项目之外**
- **可选适配器**：检测到 `dependency-cruiser` / `jdeps`（只读编译产物）时用，否则回退内置标低置信。
  开源 skill 一律 **pinned 版本 + license 审查 + 用途声明**（skill-catalog.json），扫描期不 fetch；
  **license 审查前置**——工具自己先用它的口径审第三方，`code-reviewer` 已有的 license 维度不双标

诚实边界：正则级解析，产出是**可复核的事实视图**，不是"理解了架构"。

### 第 2 层 · 知识侦察（v3，引导式会话，产物全是草稿）

- **不建专用 recon agent**：`harness recon` 输出侦察 prompt + checklist，在普通会话里跑。
  agent 编队是结果不是起点，等引导式会话被用烦了再固化
- 产出：as-built 视图（模块地图/分层边界/依赖方向）→ `docs/06-reference/as-built/`、
  风险热点（初始 risk_tier 建议）、栈 skill 草稿 `SKILL.draft.md`
- **成本与增量**：`--scope <module>` 按模块取样，不追求一次性全景；as-built 天然分模块，
  哪个模块即将进入变更才侦察哪个；结果缓存 + 可再生成（缓存键 = 模块 + 代码内容 hash）
- **侦察期 skill ≠ 运行期 skill**：只在 adopt 用一次，不进受管 `.skills/`
- 草稿转正三道关：栈 owner 人审 + `check-skills` 通过 + "检测不了的降级为 references 建议"
- **合规安民告示**（写进 README 与指南）：侦察走团队既有 CLI/模型配置，不产生新的数据出口

## 4. 基线校准（v2）

**问题**：门禁要求绿、存量仓库现在就是红的 → 装完即被迫绕过。
**解法**：跑一次 lint/test，红数、警告数写进 `baseline.json`，门禁从"不比现状差"起步。

### 4.1 有测试的项目：红数基线

三条执行边界（缺一不可）：
1. `--no-baseline` 跳过——跑 test 等于**执行用户代码**（可能触发迁移/网络）
2. 基线运行按 `verify-run.sh` 语义留证据日志（命令 + exit code + 红数）
3. **单次运行判不了 flaky**——不设 flaky 字段假装判得了，只记红/警告数

### 4.2 零测试/低覆盖项目：增量达标，不是全量达标

正确语义是 Codecov 式 **diff-only**：只要求新增/改动的代码带测试，存量豁免且豁免范围随时间收缩。
机器可判形态（不假装能判覆盖率）：
- **co-change 校验**：TODO 的 `files` 改动含 `src` 下文件时，必须同时含该模块测试目录下的文件
  （或显式 `kind:"no-test"` + 理由 + 记名）
- `baseline.json` 记录豁免清单（模块 × 豁免理由），月度收紧时逐项核销
- 免责边界：co-change 只保证"改了代码也改了测试"，不保证测的是对的——那归 CR

### 4.3 消费者（防 modelTiers 空转重演）

- `doctor` 读 baseline.json 提示当前门禁相对基线的状态
- 收紧 = harness owner 的**月度人工节奏**，写进 checklist。没有 CI 托管跑测试之前，
  "逐月收紧"是人的日程，不是机器的能力——不承诺自动化

## 5. 流程裁剪：两个维度都进 config（v2）

### 5.1 flows（阶段裁剪）

```json
"flows": {
  "feature": { "S": ["impl","test","cr"],
               "M": ["rs","fs","sr","impl","test","cr"],
               "L": ["rs","adr","proto","fs","sr","wbs","impl","test","cr","retro"] },
  "change":  { "S": ["fs-delta","impl","test","cr"],
               "M": ["rs-delta","fs","sr","impl","test","cr"] },
  "bugfix":  { "default": ["repro","fix","verify","cr"] }
}
```

- **阶段 ID 用固定词表**，不用自由文本（orchestrator 与 trim linter 都要机器可判）
- `orchestrator.agent.md` 从 config 读阶段表（标准 meta-task，走完整流程补测试）
- `skipped` 成为合法 gate 值：**waived = 该做没做、记名担责；skipped = 裁剪本来就不含**
- **trim linter**：阶段名在词表内 + 任何档位不得砍掉五样永不裁剪项
  （verify 证据链、同次补测试、破坏性停点、事实源一致性、blocker 通道）

### 5.2 agents.enabled（agent 裁剪）——四周节奏的机械基础

```json
"agents": { "enabled": ["orchestrator","requirements-analyst","tech-selector","spec-reviewer"] }
```

- `build-agents` 只生成 enabled 清单内（`orchestrator` 恒在），其余不产出；
  **`.ai/writes.json` 与 `prompts/INDEX.md` 同步只含 enabled 集合**——治理文档与实际启用面必须一致，否则又是"看起来存在的门禁"
- `harness trim --agents read-only` 一键配"只读阶段"子集
- **没有这个开关，"第 1 周只上只读 agent"就是文档里的愿望**——四周 checklist 与机制同批落地
- `doctor` 校验：enabled 里含未知 agent 名 → 报错；空清单 → 报错

## 6. 安装清单、干跑预览与卸载（v1）

adopt/init 会碰十几个位置（`.claude/`、`.zcode/`、`.ai/`、`hooks/`、`scripts/`、`agents/`、
`templates/`、`docs/`、CI 文件、`package.json` scripts、`AGENTS.md`）。三件套缺一不可：

- **安装 manifest** `.harness-manifest.json`：每个被触碰路径 + 动作（create/merge/skip/conflict）
  + 内容 hash，人和工具都查得到。它同时是 `remove` 与 v4 `upgrade` 的数据基础
- **`--dry-run` 预览**：创建/合并/跳过三态逐行列出。对已有 `AGENTS.md`、`README`、`docs/`
  结构的项目是**合并不是覆盖**——合并统一用受管标记块（`<!-- harness:begin -->` …
  `<!-- harness:end -->`），`package.json` 用 JSON 合并并对冲突键报冲突而非覆盖
- **`harness remove`**：只按 manifest 反查删除（**绝不 glob 批量删**），先打印将删除清单，
  需 `--yes`；merge 类文件只摘标记块内的内容，保留用户自己的部分。
  没有退出策略的治理工具，最后都会变成没人敢动的钉子

## 7. 写安全内核（v1 必须落地）

- 提案生成到**项目外暂存区**，`plan diff` 预览
- 冲突拒写：目标已有同名文件 → 列出冲突、默认中止
- 路径检查：写入路径必须在目标目录内（防包含逃逸）、拒绝穿过 symlink
- `--apply` 原子落盘（先写临时、后统一 rename），幂等可重跑
- apply 前在暂存区跑 `check:agents / check:hooks / check:skills` 自验证
- apply 后跑 `build:agents` + `build:hooks` + doctor；`test/` 随 harness 复制，
  目标项目 `npm run gate` 开箱可用

## 8. docs 结构映射（v1 可见，v2 可配）

harness 硬编码 `docs/01-requirements`、`02-features`、`06-reference` 编号结构，存量项目常有
自己的约定。v1：`--dry-run` 必须把**冲突显式列出来**，并要求人选
`--docs-layout harness|keep`（keep = 本次不写 docs 目录，adoption 清单标待确认）。
v2：`paths: { requirements, features, reference }` 映射配置，由 `build-agents` 据此生成
agents 的 writes glob，不手改生成物。

## 9. state schema 版本化与迁移（v1）

- `meta.schema_version`（当前 1）；`hooks/lib/verify.mjs` 提供 `migrate(state)`
- `ci-verify` **与 `guard_state`** 都在校验前走 migrate（同一判据库，失效点 7）
- **hook 不改写内容**（checklist：hook 只判定不代改）：缺 `schema_version` 的存量 state 按当前版 1 校验；
  仅"高于已知版本"或"非法值"显式报错（枚举闭合，失效点 15），不制造一次全量迁移
- 趁 state 还少（`.ai/tasks` 目前为空）做，成本≈0；等有了存量任务再做就是数据迁移事故

## 10. deny ledger（v1，纯观测零行为变化）

- `hooks/lib/ledger.mjs`：`recordDeny(hook, rule, reason, command)` 追加写
  `.ai/ledger/deny.jsonl`（append-only，不参与任何判定）
- 挂载点：`guard_command.mjs` 的 `deny()`（唯一入口）、`guard_write`/`guard_state`
  各自的拒绝分支
- 价值：从第一个任务开始积累拦截面基线，后续所有"误拦率高不高"都有据可查；
  等 Harness² 立项再补就是零基线起步
- 红灯：ledger 写入失败绝不影响 hook 判定（try/catch 吞掉并 stderr 提示）
- 落盘位置 `.ai/ledger/deny.jsonl`，目录可用 `HARNESS_LEDGER_DIR` 覆写（测试注入用，
  避免测试污染真实仓库）；**v1 进 .gitignore 按本地观测处理**，是否随分支入库
  留给 Harness² 多人信号层决策（届时是一人一份，不存在合并冲突问题）

## 11. 工装夹具（v1 验收的一部分）

三个夹具仓库，每条探测规则都要在夹具上断言：

| 夹具 | 覆盖 |
|---|---|
| `test/fixtures/java-small` | 单栈 Java：pom 探测、import 依赖图、无循环 |
| `test/fixtures/vue-small` | TS/Vue：package.json 探测、import 解析、缺测试目录风险项 |
| `test/fixtures/bare-zero-test` | 零测试裸仓：基线语义、co-change 豁免、风险清单 |

- 断言"探测后再 hash 夹具目录，内容未变"（只读保证）
- 断言"循环依赖检出"（fixture 里故意埋一个环）
- 没有夹具，探测器这种"看起来对"的代码就是下一个静默失效点

## 12. 存量 adopt 完整流水线

```
harness adopt
① 前提探测   → Node/bash/git + 单/多栈判定 + docs 结构冲突      （只读，第一屏）
② 机械探测   → config 草稿 + PROJECT-MAP.md + dependencies.mmd   （确定性，只读）
③ 基线运行   → baseline.json + verify 日志                        （确定性，可 --no-baseline）
④ 提案暂存   → plan diff 创建/合并/跳过三态，冲突拒写              （安全内核）
⑤ --apply    → 原子落盘 + build + doctor + gate 绿 + manifest      （接线收口）
⑥ 流程裁剪   → flows + agents.enabled，trim linter 校验不变量      （v2）
⑦ 知识侦察   → harness recon 引导式会话，as-built + skill 草稿     （v3）
⑧ 输出四周节奏 checklist（第 1 周只读 agent → 第 3 周才给 coder，由 agents.enabled 保证）
```

治理照旧：adopt 完仍需 harness owner、CODEOWNERS、四周节奏——工具生成提醒，不能替代。

## 13. 分期落地（按风险递增）

| 期 | 内容 | 验收标准 |
|---|---|---|
| **v1** | 前提探测 + init + 机械探测 + 写安全内核（dry-run/原子写/manifest/remove/symlink）+ **agents.enabled** + **schema_version 迁移** + **deny ledger** + 三夹具 + npm 打包配置 | 三夹具全流程跑通；冲突/symlink/逃逸/remove/重跑 init 用例全拦；只读保证断言通过；`npm pack --dry-run` 模板齐全；gate 全绿 |
| **v1.5** | `adopt` 独立动词：staging 区 + 完整 `plan diff` + `--apply` 原子落盘（init 目前承担安装本身） | staging 与目标隔离；apply 前可在暂存区跑三套 check |
| **v2** | 基线校准（含零测试 diff-only/co-change）+ flows/trim linter + `stacks` → `projects` 数组 + docs 路径映射（`paths` + `--docs-layout`） | 基线日志可复核；裁掉五不变量任一被拦；多栈项目不再静默跑错 |
| **v3** | `harness recon` 引导式会话 + skill-catalog（pinned/license）+ 草稿转正三道关 | 侦察产物全带证据链接；草稿未经三道关不进 `.skills/`；"--scope 取样"可用 |
| **v4** | upgrade 版本 diff | **推迟到第二个采用者出现**——单项目场景模板就地演进，无跨仓同步需求；为一个想象的需求写三方合并是提前设计 |

每期同批补测试（硬规则 H1），接入 `npm run gate`。

### 13.1 v1 实现状态对账（2026-10-30）

文档与代码各说各话是本仓库点名过的失效形态，所以这里逐项对账——**没做到的写在表里，不写在别处**。

| 方案项 | 状态 | 落地形态 / 偏差 |
|---|---|---|
| 命令面 | **部分** | 已实现 `check / detect / analyze / init / remove / resume`；**`adopt` 未做成独立动词**——安装由 `init` 承担，staging + plan diff 挪到 v1.5。`trim` 的 `--agents` 部分已由 `init --agents read-only` 覆盖，flows 档位随 v2。`resume` 是 v1 之后补的第六个动词（见 §13.3），职责是"把人接回停在门禁上的任务" |
| 写安全内核 | **已实现** | `--dry-run` 三态预览、冲突拒写、`assertWritableUnder` 逐段 symlink 检查、`analyze --out` 用 realpath（含悬挂 symlink）判定、原子写（tmp+rename）、manifest `pending → complete` 两段落盘 |
| manifest 语义 | **已实现（比方案更严）** | 重跑 init **合并**（先前 create 记录保留，含本次 plan 里不再出现的条件生成项），否则重跑会让 remove 失效；`generated` 展开成**文件清单**（不记录目录）；remove 按 sha256 比对，改过的文件要求 `--force` |
| 生成物归属（v4） | **已实现** | 归属由**生成器声明**：`build-agents/build-hooks --manifest` 回报"我写了哪些文件"，`init` 只认这份清单；安装前已存在的生成物记入 `manifest.foreign`，remove 永不删。此前按目录扫描认领，会把用户手写的 `.claude/commands/*.md` 记成我们的并在卸载时删掉（hash 是安装时对用户文件算的，护不住） |
| 覆盖可恢复 | **已实现** | build 覆盖安装前已存在的文件（`.ai/writes.json`、`.claude/settings.json` 等）时，原内容备份到 `.ai/backup/<ts>/` 并在输出里点名；`.ai/backup` 进 NEVER_REMOVE 与 `.gitignore` |
| package.json scripts 合并 | **已实现** | 目标已有 package.json 时按 key 合并（已有键不覆盖、冲突单列），manifest 记 `action: merge`（remove 不删用户文件）；新建的 package.json 带 `harness.tooling` 标记，避免被下一轮探测误判成 Node 栈 |
| 运行时前提门禁 | **已实现** | `check` 打印三项并可作脚本判据（硬前提缺失 exit 1）；`init` 在 Node<18 或 bash 缺失时**拒绝安装**（exit 69）；git 缺失仅降级 |
| 多栈 | **v1 范围已实现** | `detect` 列出全部构建根（按清单**所在目录**判根，嵌套不合并）；`init --stack-dir` 选主栈；同类型双根 / >2 根显式告警。`projects` 数组仍在 v2 |
| 机械探测契约 | **已实现** | `analysis.json` 带 `schema_version` / `tool` / `warnings` / `evidence` / `edges` / `buildRoots`；报告默认写项目外 |
| 不发明命令 | **已实现** | Java/Maven、Java/Gradle、TS/Vue 生成命令；Go/Python/Rust 只识别并标 `unsupported`，`stacks` 留空待手填 |
| init 适配 config | **已实现** | `project.name` 取目标目录名；`stacks` **一律**由探测结果覆盖（不再抄模板的 `backend/`+`mvn`、`frontend/`+`pnpm`） |
| agents.enabled | **已实现** | `build-agents` 消费清单、`doctor` 双向校验、`init --agents read-only` |
| schema_version 迁移 | **已实现** | `migrate()` 只产出校验视图不改盘；未知高版本在 hook 与 CI 两侧显式报错 |
| deny ledger | **已实现** | 追加写 `.ai/ledger/deny.jsonl`，字段 `hook / rule / target / detail`；写失败不影响判定（fail-open） |
| npm 打包 | **已实现（发布待 tag）** | `bin.harness` + `files` 已配；`npm pack --dry-run` 实测 76 个文件、模板与夹具齐全；**只从 tag 发包**，包版本取 tag |
| docs 结构映射 | **降级（已知）** | v1 不安装 `docs/`，因此不存在冲突；`--docs-layout` 与 `paths` 映射合并到 v2。**这是有意的裁剪，不是遗漏** |
| 文档同步 | **已实现** | `guides/` 随模板安装（`orchestrator` 与 `.skills/harness` 都引用了它，不装就是死链）；`templates/` 同批复制 |
| 三夹具 | **已实现** | `java-small`（Maven + 测试）、`vue-small`（Vue + 循环依赖）、`bare-zero-test`（无构建清单/零测试） |

### 13.2 第二轮审核修复（2026-10-31）

对已落地实现重新审一遍（不看上一轮结论、逐条复现）后修的六类问题，全部带回归用例：

| 编号 | 问题（已复现） | 修法 |
|---|---|---|
| P1-1 | 重跑 init 后 manifest 丢掉条件生成项（package.json / .gitignore / CI workflow），remove 残留而输出称"退出干净" | `files` 按并集维护：本次 plan + 旧 create 记录 |
| P1-2 | `generated` 靠扫目录认领，用户安装前手写的 `.claude/commands/deploy.md` 记成我们的，remove 直接删 | 生成器 `--manifest` 声明归属 + `manifest.foreign` |
| P1-3 | build 静默覆盖用户既有 `.ai/writes.json` / `.claude/settings.json`，无提示无备份 | build 前快照 → 覆盖即备份 `.ai/backup/<ts>/` + 点名 |
| P1-4 | `init` 到不存在目录：ENOENT + 完整 stack trace（前面还打了"计划：create 73"） | 显式创建 + note；非目录报错 64 |
| P1-5 | 构建清单用递归集判 Gradle：根 package.json 命中子目录 `build.gradle`，误报 Java 栈、生成跑空的 `./gradlew test`、与真实后端撞 id | 只认**直属**文件 |
| P2-1/2 | `ci-verify --file` 缺值静默降级为全量扫描；`--lcoal` 静默按 ci 口径通过 | flag 白名单 + 缺值报错（exit 64） |
| P2-3/4 | `remove --yes` 有保护项时删 0 个文件却 exit 0；路径含 symlink 时 `die` 中断整场卸载（措辞还是"拒绝写入"） | 前者 exit 2，后者跳过并聚合说明 |

### 13.3 第一轮真实落地反馈（TDC 项目，2026-10-31）

第一个真实项目装完、跑完第一个任务之后才暴露的四类问题。共同点：**都不是工具的 bug，
而是"工具装好了、流程却走不下去"的断点**——这类断点单测测不出来，只有真跑一遍才会撞上。

| 编号 | 现场 | 根因 | 修法 |
|---|---|---|---|
| F-1 | 任务停在 adr、8 条决策等人裁决；用户回来后**没有任何工具能继续**，只能手改 `state.json` | 状态机只设计了"停下来"，没设计"回来的路" | 新增 `resume` 动词：列待决项 → `--decide/--resolve` 记名回填 → 重跑可机器判的门禁 → 决策齐备自动推进并写 `stage_history`。退出码 0/3/64 可直接进脚本 |
| F-2 | `writes.json` 声明 orchestrator 有 `agent.spawn`，实际会话没有；rs/wbs/adr 三阶段全由 orchestrator 直做，到 impl 才卡死 | 能力是**声明**不是**事实**，且没有任何环节要求先验证 | `harness.config.json` 加 `runtime.{spawn_agents,shell,ask_user}`；SessionStart 每次开场打印能力自检行；orchestrator 加"阶段 0：能力自检"，缺能力走 direct 模式并记偏离 |
| F-3 | 流程要求"FS 定稿移至 `docs/plans/`"，但**没有任何 agent 的 writes 覆盖该目录** | 写入域与流程文本各写各的，没人对账 | 加 `promotionDir`（默认 `docs/plans`），orchestrator writes 扩容；`check` 校验"promotionDir 是否落在某个 agent 的 writes 里"，不覆盖就点名 |
| F-4 | 装完跑一次自测，80 条必然命中的探测全灌进 `.ai/ledger/deny.jsonl`；同时 15 条规则共用一段"强推类"文案，拦到 `-DskipTests` 也在讲强推 | 观测数据不分来源、规则建议不按规则给 | ledger 加 `source`（`tool`/`selftest`，测试脚本内置 `HARNESS_LEDGER_SOURCE=selftest` 并隔离目录）；`blockedCommands` 支持 `{pattern, hint}`，每条规则给自己的修法，通用兜底只留"例外出口" |

顺带修掉的小问题：`init-harness.sh` 对"slug 日期段 ≠ 建档日"静默放行（真实项目出现
`2026-09-24-*` 目录却在 10-31 建档，按日期找任务直接扑空）→ 改为当场提示并说明业务日期该写哪里。

### 13.4 第二轮：停点交互（同一项目，2026-11-01）

F-1 补上了"回来的路"，但真跑一次 resume 之后发现**这条路太窄**：`resume` 把 8 条决策
同权平铺，末行是 `仍卡在 D1、D2…D8、B1`；而 D2 的建议自己写着"先做 T1 盘点再定，
盘点本身不依赖决策"——它根本不该挡路。回填还得把 `·` 分隔的选项在脑子里拼成
`--decide "D1=磁盘/存储+CPU+内存"` 这种另一种串。

| 编号 | 现场 | 根因 | 修法 |
|---|---|---|---|
| F-5 | 8 条决策同权平铺 = 9 道闸门全落，人看到就"回头再说"；停点失效 | blocker 结构里没有"是否挡路"，所有 `human_decision` 一律当门禁 | 加 `blocking` / `defer_until` / `default_ok`；resume 与 DECISIONS.md 按三档呈现。分档**只认显式字段**，不从 suggestion 文本猜 |
| F-6 | 屏幕印 `1. 磁盘 / 2. CPU / 3. 内存`，要输入的是 `磁盘/存储+CPU+内存`；显示与输入不同构 | 选项只给人看，`decision` 是自由字符串，写什么都过 | `options` 归一成 `{id,label}` 并加 `multi`；回填值必须是选项编号，落在选项外直接 exit 64；`decision_ids` 落盘供机器判（§16 枚举闭合） |
| F-7 | 待决信息只活在一次 stdout：关掉终端就没，手机上处理不了，也没法转给同事 | 载体是输出流，不是文件 | 停点渲染成 `.ai/tasks/<slug>/DECISIONS.md`（选项带编号、建议与依凭齐全）；`--from DECISIONS.md` 读回；`--accept-suggested` 只批第三档（`--except` 可排除） |
| F-8 | 决策单是人要填的，但每次 resume 都重写它——刷新一次就冲掉人填了一半的答案 | 生成物同时承载人的输入，刷新前没比对 | 刷新前读出已有内容：有未应用编辑则**不覆盖**并点名提示；无编辑且内容无变化则不写 |
| F-9 | SessionStart 只报"8 个 blocker 待决"，不给门路；light 档连这句都不打 | 只说屋里有人，不给门牌号 | 每个卡住的任务下直接给恢复命令与决策单路径；light 档保留这一条（TODO 提醒仍豁免） |

判断依据：**停点的价值不取决于"停得准不准"，而取决于人能不能在合适的时机、用合适的载体、
以可核对的粒度把它处理掉**。前面 F-1~F-4 修的是"停得住"，这一段修的是"接得回"。

### 13.5 第三轮：分层审核（状态机与门禁代码，2026-11-01）

这一次不看"装得上吗"，只看**判据本身站不站得住**：状态机、门禁代码、观测面各过一遍。
发现的共同形态是"判据写了，但判据的输入是假的/缺的/只在一个出口生效"。

| 编号 | 问题（多数已实测复现） | 根因 | 修法 |
|---|---|---|---|
| P1-1 | `resume` 把 `gate: pass:false` + 2 个未完成 TODO 的 impl 直接推进 review，history 记成 `impl/pass` | 推进条件是"没有未解 blocker"，不是"本阶段门禁已评估且全 pass"；且 history 的 gate 由"本次没报错"推出 | `stageGate()` 成为推进前提（须本阶段、须全 pass）；新增 `checkStageTodoClosure()`（impl 收尾）；推进失败一字节不写 |
| P1-2 | `init-harness.sh` 起始阶段写 `stage:"intake"`，不在链上；`fs-review`（连字符）CI 照样绿 | 阶段链只在 `harness-cli.mjs` 里存了一份，且没有任何地方校验阶段名合法性 | 链移入 `verify.mjs` 做单源（`STAGE_CHAIN`/`STAGE_NEXT`）；`checkStage()` 判枚举 + 跳阶须记名；init 起始改 `rs` |
| P2-3 | `defer_until` / `default_ok` 的 blocker 仍被算进"卡住"，三档分诊只改了显示 | 呈现与判定各算各的 | 判定只认 `triage()==='block'`；exit code 同步（可稍后定的项 exit 0） |
| P2-4 | `--accept-suggested` 把建议原文写进 `decision` 并留 `decision_ids: []`，绕过枚举校验 | 批量出口没走与逐条相同的解析函数 | 一律走 `parseDecision()`；映射不到选项则跳过并点名，不给假默认 |
| P2-5 | 档位裁剪只写在文档里，跳三个阶段与一步没跳长得一样 | `flow_tier` 无读者，`stage_history` 不校验相邻性 | `checkStage()` 校验档位枚举 + 跳阶须 `waived_by`（"可以跳，但要有人签字"），不发明档位裁剪表 |
| P2-6 | 空 `todos` + `stage:"done"` 即全绿——删光 todos 是最便宜的完工方式 | 退出条件只判"没有未完成的"，没判"凭什么没有" | `checkStageExit()` 要求 `meta.no_todo_reason` |
| P3-7 | `guard_state` 的工具表少了 `str_replace_editor`（`guard_write` 有）：用它写 state 直接放行 | 两个门禁各存一张"哪些工具算写"的表 | 抽 `hooks/lib/write_tools.mjs`（工具集合 + 载荷投影）供两者共用 |
| P3-8 | `doctor` 的"空转配置键"检查只在本地手动跑，CI 与 `npm run gate` 都不跑 | 检查存在，但没有执行点 | CI 首步 + `gate` 首步跑 `doctor`；doctor 新增"state 判据字段必须真有人读"（读 `state-fields.md`） |
| P3-9 | push 到 main 时 `base_ref` 为空 → `BASE=origin/main` 而 HEAD 就是它 → 高危命令扫描恒 skip | 基线取值只考虑了 PR | PR 用 `base_ref`，push 用 `event.before`（全零/不存在则退 `HEAD~1` → 根提交） |
| P3-10 | `artifacts` / `risk_tier` / `ui_scope` / `trust_level` / `deviations` 只有写入没有读者 | 字段没有契约，写着"约束"实际没人看 | `artifacts` 降级为**索引**（`artifactIndex()` 只展示、不改 exit code、不改写 state）；`risk_tier`/`flow_tier` 进枚举判据；`ui_scope`/`trust_level`/`deviations` 明确标**声明**；新增 `docs/06-reference/state-fields.md` 三档契约表 |
| P3-11 | `deny.jsonl` 只写不读，误拦率没有出口；且规则名一律记 `deny`，问不出"哪条规则在拦" | 观测面缺读取端 | 新增 `npm run ledger:report`（按 hook×规则、按 target 聚合，source 分开）；`guard_command` 账本改记具体 pattern |

顺带修正：退出码语义写进了 README（`0` 无阻塞 / `3` 有必须现在定的项或校验/门禁没过 / `64` 用法错误），
checklist 补 §23–§26（阶段名不在链上、推进替门禁下结论、分档只改显示、观测只写不读）。

判断依据：**门禁的可信度取决于"判据的输入能不能被伪造"**。这一轮修的多数问题都不是漏判，
而是判据被一个更便宜的写法绕过（删掉 todos、把 gate 写成 pass、走批量出口、用另一个写工具）。


### 13.6 第四轮：判据的输入本身是坏的（2026-11-01）

第三轮修的是"判据写没写、挂没挂对位置"，这一轮全是**判据读进来的东西错了**。
这一类的共同点：代码逐行看完全正常，错在输入。三个 P1 里两个当场实测复现，且都长在上一轮新加的判据上。

| 编号 | 问题（实测） | 根因 | 修法 |
|---|---|---|---|
| P1-1 | `gitChangedFiles()` 把首个改动文件的**首字符切掉**：`" M pom.xml"` → `om.xml` | `git()` 对整段 stdout 做 `.trim()`，吃掉第一条状态位的前导空格，之后固定 `slice(3)` 多切一个字符；git 按字母序输出，Maven 仓库里 `pom.xml` 几乎总在第一条 | `git()` 只裁尾（`replace(/\s+$/,'')`）；`gitChangedFiles` 不再先 `trim` 再切；顺带 `-uall` 让新增目录内的文件展开成具体路径 |
| P1-2 | `verify-run.sh` 的 `# cmd:` 被测试计数覆盖（写成 `7 0 0 0`） | 统计计数时 `set -- $parsed` 覆盖了脚本自身的位置参数；越有 surefire 报告的运行越必然踩中 | 命令先落 `CMD=("$@")` 与 `%q` 串；拆字段改 `read -r a b c`；新增 `test/verify-run.test.sh`（11 条，覆盖头部、聚合、退出码、用法错） |
| P1-3 | 新门禁依赖的 `deviations` / `known_issues` 在契约文档里写着"不是门禁输入"/"根本没登记" | doctor 只查"文档→代码"，不查"代码→文档" | doctor 加反向检查（扫 `verify.mjs` 的 `state.X`/`meta.X`，剥字符串与注释）；契约补 `known_issues`、`notes`，`deviations` 改判据；init 模板补两个空数组 |
| P2 | `#18 未声明基建文件` **从无用例**，且被上面的截断 bug 静默放行 | 规则、测试、真跑三者缺一 | 新增 evidence 用例 22/23/24（首字符、未声明 pom → 拦、夹具 → 放）；`-uall` 后又补了夹具豁免，避免改夹具就判红 |
| P2 | `resume --advance` 保留上一阶段 `gate_result` → 工具刚写下的 state 被自己 CI 判红 | "保留旧记录"看起来保守，但旧记录的语义是"本阶段已评估"，保留即伪造 | 推进后清成 `{stage:<新阶段>, checks:[], last_check:null, note}`，即显式"尚未评估" |
| P2 | `events.jsonl` 只写不读（§26 重演） | 观测面缺读取端 | `ledger:report` 增加在线记录段（条数、覆盖整点、最近一次），`--json` 同步；新增 `test/ledger.test.sh`（13 条） |
| P2 | checklist 没跟着更新（还写"这 26 条"） | 新增判据没对清单 | 补 §27–§33 |

**一处自我更正**：上一轮我说"声明一个目录就能豁免里面的所有文件"。实测**不成立**——
`declared` 是精确匹配，声明 `docs/` 不会豁免 `docs/a.md`。真正的便宜路径是另一条：
新建一个"登记型任务"，把文件逐个列进 `todos[].files`，而这类任务本身没有收口判据（无 verify 日志、`stage_history` 空）。
这一条机器判不了，写进 checklist §31 由人审。

判断依据：**门禁的可信度还取决于"判据吃进去的输入是不是真的"**。前三轮集中在"有没有判"，
这一轮集中在"判的时候手里拿的是什么"——一个把 `pom.xml` 读成 `om.xml` 的解析函数，
能让整条规则静默失效，而它的每一行代码看起来都对。


### 13.7 第五轮：分析器的"事实"采样错了（2026-11-01）

这一轮审的是 GLM 落地的"分析可信"批（#0 gitignore / #1 Java FQN / #2 模块聚合 / #3 Go / #4 表血缘）。
方向对、真实仓库上效果可复现：TDC 从 35 个假构建根降到 1 个，模块图首次出现且权重合理
（tdc-mgmt→commons 630），循环依赖从"重名类错连"变成**真环**（接口↔DTO 互 import）。

问题出在**采样**：两处 P1 都长在最普通的项目形态上，而夹具只覆盖了复杂形态。

| 编号 | 问题（实测） | 根因 | 修法 |
|---|---|---|---|
| P1-1 | 表血缘 22% 是列名：TDC 112 个"表"里 25 个是 `appid`/`cpu`/`disk`/`update_time`/`parentgroups`… | 注解 SQL 分支把**整个 Java 文件的所有字符串字面量**拼成一坨再扫 `from\|join\|update`（含注释掉的 SQL、`@Param("cpu")`、`@Result(column=..)`）；XML 分支扫整份 XML（含注释与 `<resultMap>` 属性）；`update` 按关键字全域匹配，`on duplicate key update col` 里的列名也被当表名 | 注解分支只取 `@Select/@Insert/@Update/@Delete` 括号内字面量（先剥 Java 注释）；XML 只取 statement 元素、剥注释；写操作限定在**语句开头**；补 CTE 名剔除（`WITH RECURSIVE ParentGroups AS ... JOIN ParentGroups`）；反引号分段标识符（``monitor.`system` ``）按整段取 |
| P1-2 | 单模块项目的 `modules` 恒为空、`moduleGraph` 空、报告第 5 节整段消失且**无告警** | `moduleUnits` 的匹配写成 `f.startsWith(d + '/')`，`d === '.'` 时前缀是 `'./'`，任何相对路径都匹配不上 → 根目录下所有源码归 null | 补 `d === '.'` 显式分支；用 java-small（单模块）与 harness 自举两条用例钉住 |
| P2-3 | unresolved 只有数字没有样本：TDC 2895 条，人无法复核"漏的是什么" | 计数处只 `stats.unresolved++`，不记引用原文 | `noteUnresolved(from, spec)` 留前 10 条样本进 `evidence.unresolved_samples`；修完立刻暴露真问题（见下） |
| P2-4 | 2895 条里**大部分不是"未解析"，是第三方**：`com.taosdata.jdbc.*` 是官方 JDBC 驱动，与自家包同前缀，被整批算成内部未解析 | 内部候选判据只有"前缀多数派"，没有"这个类在不在仓里" | 前缀命中后再判包目录里有没有这个 `.java`：有 → 真未解析；没有 → 外部依赖。Java 的包名必须对应目录，这条约定让判据可复核。Python 同法（仓里无此包目录 = 外部）。修后 TDC：unresolved **2895 → 4**，且 4 条全是真实路径错误 |
| P2-5 | Go import 按「行首 + 引号」扫全文，`return "a/b"` 计入 imports | 正则没有 import 块的边界概念 | 只解析 `import "x"` / `import ( ... )`；标准库单列计数（否则"外部包 = 总 − 已解析 − 未解析"把 stdlib 算进外部） |
| P2-6 | 用例只证有、不证无：血缘只断言"含 td_demo/td_app"；Go 两条用例断言同一条件（都只判 `unresolved===0`），"2 条"实为 1 条 | 新判据补用例时只写正例 | 新增 `mybatis-annot` 夹具（埋参数名/列名/注释 SQL/方法体字符串四类干扰），断言表名**精确等于**真表集合；Go 换成"只认 import 声明"+"四类口径恒等式"两条互不重复的断言 |
| P2-7 | harness 自己的安装物被当项目代码：TDC 的 `codeCount` 含 hooks/scripts，热点榜会被工具占位 | `walk` 的忽略表只有 `.ai/.claude/.zcode/prompts`，没有"manifest 记录的文件" | `harnessInstalledFiles(root)` 读 `.harness-manifest.json` 排除已安装文件；`evidence.harness_files_excluded` 亮出排除了多少（TDC 79 个）。判据用 manifest 而不是猜目录名 |
| P2-8 | `analysis.json` 1.9MB（TDC 8959 条边），agent 直接 Read 会撑爆上下文 | 明细边全量导出，无上限 | 默认上限 5000 + `edges_truncated {kept,total}` 显式标记 + `--full-edges` 取消；CLI 打印截断提示。schema_version 升 3 |
| P3-9 | 报告章节 `## 5` 标题写"构建模块聚合"，实际是**顶层目录**聚合；`## 6` 出现两次、缺 7 | 加模块图时新章节插在中间，编号没重排 | 重排 1–13；`## 6` 改"顶层目录聚合"，与 `## 5` 的模块图区分开 |
| P3-10 | 构建根显示 `package.json+pom.xml`，但那个 package.json 是 harness 装的工具入口 | `detectBuildRoots` 只用 `tooling` 判"是不是栈"，没把它从 `manifests` 里剔掉 | 排除后 TDC 只显示 `pom.xml`（与"识别的栈：Java/Maven"一致） |

**顺带发现（消费方侧，不是工具缺陷）**：TDC 根目录平铺着 `ci-verify.mjs` / `doctor.mjs` / `harness-cli.mjs`，
内容是 `scripts/` 那份的重复副本、import 路径按 `scripts/` 写的（`../hooks/lib/verify.mjs`），
在根目录跑必然找不到模块。修好样本后这 3 条立刻从"未解析清单"里冒出来——
这正是"数字变样本"的价值：2895 条时没人能发现，4 条时一眼看到。

**流程观察**：本轮改动没有 plan 条目、没有 TODO、`.ai/verify/` 无日志（最近一条还是上一轮的
19:12），"分析可信 #0–#4"只写在代码注释里。按本仓 `rules/verification.md` 第 1、3 条，
这已经算"没有日志就当没跑过"。工具作者绕开自己的流程，消费方会照着学——这一条比上面任何 P 都更值得记。

判断依据：**事实视图的可信度取决于采样覆盖到的形态**。reactor、多模块、Go 模块缓存这些
"难例子"都有夹具，最普通的单模块项目、最普通的 `@Param("cpu")` 反而没有——
P1 不是藏在角落，是藏在大多数人每天在写的代码里。


## 14. 三条红线 + 一条边界

1. **工具不发明真理**：探测与蒸馏产物都是带证据链接的草稿，转正必须过人审——
   工具降低蒸馏成本，不转移决策权
2. **工具不发明治理**：harness owner、CODEOWNERS、四周节奏照旧，工具只生成提醒
3. **警惕范围蔓延**：只做 init/adopt/trim/remove/doctor 五个动词。**明确不做**：
   GitLab 投影层（独立薄胶水，塞进来会把脚手架稀释成"什么都管一点"）、
   org 级技能市场、多仓同步、装 git hooks、管环境

## 15. 残余风险清单（诚实版）

| 风险 | 现状 | 缓解 |
|---|---|---|
| writes 声明无运行时门禁 | 架构限制（PreToolUse 无 agent 身份） | CR + `.ai/writes.json` CI diff；真收紧靠裁 capabilities |
| 影响清单 ↔ RS/FS/TODO 对应 | 机器判不了语义 | 发现真实漏对应事故后同批加 `trace` 字段（无事故不预建门禁） |
| 档位选择 vs 实际 diff | CI 拿不到 base diff | CR 复核；判不了的写明归人审 |
| 红灯日志真伪 | 机器只判存在 + exit_code≠0 | CR 用 git log 核提交顺序；机器级需 CI 托管测试，不做不假装 |
| co-change 只保证"改了也改了测试" | 测得好不好机器判不了 | 归 CR；试过率高不代表覆盖对 |
| npm 包与仓库模板漂移 | 发包流程约定 | 只从 tag 发包 |
| 基线自动收紧 | 无 CI 托管测试 | 月度人工节奏 + checklist |
| 多栈（v1） | 只支持单主栈，其余标 unsupported | v2 升 `projects` 数组；v1 显式拒绝静默 |
| 已装项目的升级 | **upgrade 动词仍缺**（v1.5） | 本次用一次性脚本按 manifest hash 判定"未改动才升级"，配置只做按键合并，升级前备份到 `.ai/backup/<ts>-upgrade/`，并刷新 manifest hash。这条路径可复用，但还没成为正式动词 |

## 16. 与既有机制的接线

- **测试**：`test/harness-cli.test.sh`（53 组 / 195 断言：detect、analyze 只读与 symlink、init 三态与前提门禁与 scripts 合并、
  remove 的 manifest/sha256/用户文件/foreign/symlink、重跑 init 合并与卸载无残留、覆盖备份、
  前提探测、不支持栈、analysis 契约（v3：四类口径 + 未解析样本 + 截断标记）、未知 flag 与缺值、
  resume 全流程（待决/记名回填/拒绝无记名/推进 stage）、promotionDir 覆盖、ledger 自测标记、
  推进前置（门禁未 pass / TODO 未收尾均拒绝）、产物索引（只提示不判死）；
  分析器侧：多构建根折叠与模块聚合、**单模块也有模块视图**、Java FQN 与基础包多数派、
  Go 模块缓存与只认 import 声明、.gitignore 目录推导、**MyBatis 血缘正负例**、
  harness 安装物不计入项目代码、明细边上限与截断标记）；
  全套 gate 合计 **9 个测试文件 / 397 条断言**（hooks 57 / writes 15 / agents 14 / init 25 / harness-cli 195 /
  evidence 53 / verify-run 11 / ledger 13 / wiring 14）；
  夹具从 `test/fixtures/` 拷出模板仓库再探测——safeTarget 拒绝探测模板自身；
  全部接入 gate；按 H1 每个新判据同批补用例
- **文档**：README（支持范围、运行时前提、license、只读声明、release 约定、三个明确不做）、
  `guides/` 随模板安装（引用它的 orchestrator / skills 才不会是死链）
- **失效点自查**：每个新判据对一遍 `checklist.md`（现 34 条）。本方案已预对——
  flows 词表（§15 枚举闭合）、agent 清单（§15）、writes 声明（§16）、
  生成物归属（§18：靠声明不靠扫描）、ledger 写入失败不影响判定（fail-open 边界，与 hook 主体 fail-closed 区分）
