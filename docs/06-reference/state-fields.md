# state.json 字段契约

`.ai/tasks/<slug>/state.json` 是进度的唯一事实源。但"字段存在"和"字段生效"是两件事：
一个键如果没有任何代码读它，它在文档里就是一句承诺，在机器眼里什么都不是。

所以每个字段在这里被标成一个等级，**等级决定它能不能被判据引用**：

| 等级 | 含义 | 能不能拦人 |
|---|---|---|
| **判据** | 有代码读，读出的结论会改变放行/拦截 | 能 |
| **索引** | 有代码读，只用于定位与展示（`resume` 会打印），不改变判定 | 不能 |
| **声明** | 只给人看（分档依据、范围说明），没有任何机器语义 | 不能，且不要假装能 |

新增字段时先问一句：它属于哪一级？定不成判据就老实标"声明"——把声明当门禁，
是这个仓库栽过最多跟头的地方（见 `.skills/harness/references/checklist.md` §15）。

**这张表是双向契约，`npm run doctor` 两头都查**：

- 标成「判据」的字段必须在 `hooks/lib/verify.mjs` 里有读者（文档→代码）；
- `verify.mjs` 里读了的 `state.<字段>` / `meta.<字段>` 必须在这张表里（代码→文档）。

只查一个方向会长出反向的坑：上一版 `checkStageExit()` 已经拿 `deviations` / `known_issues`
拦人了，而这张表还写着"deviations 不是门禁输入"、`known_issues` 干脆没登记。
两个没人知道要写的字段，等于两处默认空转的门禁——体检却全绿。

---

## 顶层

| 字段 | 等级 | 判据出处 |
|---|---|---|
| `stage` | 判据 | `verify.mjs: checkStage()` — 必须是 `rs → adr → fs_review → wbs → impl → review → ci → retro → done` 之一 |
| `stage_history` | 判据 | `checkStage()`（跳阶须记 `waived_by`）、`ci-verify`（`waived` 须记名） |
| `todos` | 判据 | `validateTodos()` / `checkStageTodoClosure()`（impl 收尾）/ `checkStageExit()`（done 收尾） |
| `blockers` | 判据 | `resume`（三档分诊、决策齐全性：`decision` + `resolved_by` + `resolved_at`） |
| `gate_result` | 判据 | `stageGate()` — `resume --advance` 要求**本阶段**且全 pass；CI 只判"记下来的失败项" |
| `artifacts` | **索引** | `artifactIndex()` — `resume` 打印存在性，**不参与 exit code**。唯一例外：`artifacts.retro`（2026-11-11 起）——`checkRetroLanding()` 拿它当 retro 落盘证据，必须在 `retro/` 下且存在；未声明时按 `retro/<slug>*.md` 兜底找。生效范围由 `gates.retroCheckFromDate` 控制（存量不追溯） |

## meta

| 字段 | 等级 | 说明 |
|---|---|---|
| `schema_version` | 判据 | `migrate()`；未知版本显式报错，不静默跳过 |
| `created_at` | **判据** | `checkStage()` — 决定这个任务适用哪条阶段链：`created_at` 早于某条退休链的 `retired_on`（含当天）才允许走旧链序。缺这个字段 = 不给豁免（判不了就不放宽），所以它不是装饰性时间戳 |
| `task` | 索引 | 任务名，`session_start` / `resume` 展示用 |
| `task_type` | 判据 | `checkTaskTraceability()`；`feature` / `change` / `bugfix` |
| `related_task` / `baseline` / `affected_ids` / `change_tier` | 判据 | change/bugfix 追溯链（完成态复核）。`related_task` 支持外部来源形态 `feishu:<单号>`（task-loop 剖面 B） |
| `remote_id` | 判据 | 外部来源双向锚 `{source, id}`。related_task 为外部形态时必填且两者一致（checkTaskTraceability 复核：两处各写各的等于没有锚，回写找不到平台实例）；仓库内关联时为 null |
| `flow_tier` | 判据（弱） | `checkStage()` 只判枚举 `S/M/L/XL`。**档位不改变判据强度**——它记录"这套流程被裁剪过"，裁剪本身靠 `stage_history.waived_by` 记名 |
| `status` | **判据** | `isAbandoned()` — `active`（缺省）/ `abandoned`。与 `stage` **正交的第二条轴**：stage 答"走到哪了"，status 答"还打算走吗"。缺省即 active，老 state 零影响；拼错的状态词（`abandond` / `closed`）会被 `checkStage()` 判红——否则"封存了"与"还在推进"长得一样，停滞判据会继续报它而人继续忽略 |
| `abandoned` | **判据** | `checkStage()` — `status=abandoned` 时必须有 `reason`。没有理由的封存等于静默删除：事后没人知道这任务为什么停。形状 `{at, by, reason, at_stage, open_todos, todos_total}`，由 `abandon` 命令写入，不手改 |
| `risk_tier` | 判据（弱） | `checkStage()` 判枚举 `LOW/MEDIUM/HIGH`。风险等级如何影响流程由人按 `guides/` 决定，机器不据此加减门禁 |
| `no_todo_reason` | 判据 | `checkStageExit()` — `stage=done` 且 `todos` 为空时必须写清理由 |
| `ui_scope` | 声明 | 目前无机器语义。写它是给人看的范围说明；**不要据此认为 UI 相关门禁存在** |
| `trust_level` | 声明 | 同上。信任级别影响的是 hook 接线（`targets.*.hooksFile`），不是 state 里这个字符串 |
| `deviations` | **判据** | `checkStageExit()` — `stage=done` 前每条偏离必须有 `disposition`（`fixed` 或 `acknowledged` + `by` 记名）。只写不处置等于没写：实测里 `@InternalApi` 按 FS 该加却被静默省略，记一句"时间不够"就收工了 |
| `known_issues` | **判据** | `checkStageExit()` — `stage=done` 前每条必须有 `resolution`。已知红灯不许只活在 `audit.tests` 的一段文字里：实测 console 3 例集成测试因 MySQL 不可达长期红着，结论只写在一句"转 T7"里，机器查不到、下个会话看不见 |
| `notes` | 声明 | 自由说明。`artifacts` 里混进来的整段文字（路径字段装不下的那种）挪到这里 |

## 封闭：stage 与 status 是两条轴，不是一格

`stage` 回答"走到哪了"，`status` 回答"还打算走吗"。合成一格（把 stage 覆盖成 `abandoned`）
会丢掉"任务一般死在哪一阶段"——而那恰恰是流程该不该减重的证据（我们自己的两条僵尸
都死在 `impl`，这就是"流程太重"最硬的一个数字）。

所以封存**不改 stage**，只写 `status` + `abandoned`。语义边界一句话：
**abandoned = 不再续跑，不是工作没做。** 对账补登记类任务（产物早已交付、只是补一张
记录）也用它，理由里写清产物在哪。

```bash
node scripts/harness-cli.mjs abandon . <slug> --reason "为什么停、产物在哪" [--by <人>]
```

它豁免"必须做完"的判据（TODO 收尾、产物登记），**不豁免**"做过就得有证据"
（已完成 TODO 的日志照样要能对上）——封存允许你停下，不允许你把没做的事记成做了。

### 停滞判据（`gates.staleTaskDays`，默认 3 天）

`npm run doctor` 会对超过阈值没有任何提交的未封闭任务**判红**，并直接印出把红变绿的命令。
四个设计选择，每个都对应一次踩坑：

| 选择 | 为什么 |
|---|---|
| 时钟用 **git 提交时间**，不用 mtime | mtime 是"上次写盘"，不是"上次编辑"：clone / checkout 会按检出顺序重排整棵树（实测新克隆里 14 个历史任务全被判成"刚改过源码"），`touch` 还能把它推到未来。提交时间回答的才是真问题——**这份进度有没有落到仓库里** |
| 有未提交改动 → 按"正在动"算 | 否则"今天正在改"会被判成"停滞"，人就会去给判据加白名单 |
| 已封存 / 已完成 / **有未决 blocker** 不判 | 最后一条是正当暂停。判它停滞等于逼人别把"等决策"记下来——那时真正丢失的是决策记录 |
| 判红，但必须印出关闭命令 | 判据不能只有"你错了"。没有出口的红灯训练出来的只会是"忽略红灯"，那比没有判据更糟 |

判红之后只有两条路，都是明文动作：`resume`（接着做）或 `abandon`（不做了，写理由）。

## artifacts 为什么是索引不是门禁

三个理由，都是踩出来的：

1. **路径存在 ≠ 产物合格。** 把"文件在不在"做成门禁，agent 写个空文件就能过——
   这是把声明当事实（§15），只会给出假的安全感。产物够不够由阶段门禁判。
2. **它已经长成了注释桶。** 真实项目里 `artifacts` 混进过 `null`、空数组、甚至整段说明文字
   （"决策冻结后把定稿移到 docs/plans/"）。严格校验会当场把合规任务判红。
3. **但删掉它更糟。** 它是唯一能把散落在 `docs/0x-*/`、`.ai/tasks/<slug>/artifacts/`、
   `promotionDir` 的产物串起来的索引；删了下次续跑只能靠 glob 猜（§18）。

所以：`resume` 会打印索引、点名缺失、提示形状异常，**但不改 exit code**，
也**不改写你的 state**。值只收 `string | null`；说明性内容放 `meta.notes`。

```bash
# 看索引（顺带看门禁结论与待决项）
node scripts/harness-cli.mjs resume . <slug>
```

## 判据只在两处执行，且共用同一份实现

`hooks/lib/verify.mjs` 是唯一判据源：

- 本地：`hooks/guard_state.mjs`（落盘前，fail-closed）、`hooks/session_start.mjs`（提示）
- CI：`scripts/ci-verify.mjs`（最终裁决）、`harness-cli resume`（推进前）

两边口径必须一致（§7）。改判据只改 `verify.mjs`，不要在 hook 或 CI 里各写一份。
