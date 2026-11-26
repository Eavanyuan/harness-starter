# CR 代码审查记录 — discussions 翻页修复（!1847 根因：评审打回评论落在第 2 页）

> 产出：独立审阅者（只读）· 本地审查
> 规则：🔴 = 0 且 🟡 均已表态，方可 approve；approve 权在人。

- 审查范围：本地 diff，基线 `HEAD=f21898f` → 工作区，2 个已跟踪文件：`scripts/lib/gitlab-triggers.mjs`（+29/−1）、`test/task-loop.test.sh`（+112/−5）。`git diff <两文件> | shasum -a 256` = `2f16f235609d0c4ea0ca454a7ee7eb004057eff3f8d931c908ae8607da3a06c5`，审查起止一致（两文件 mtime 09:51:55 / 09:48:30 未变）。
- 关联 FS：`docs/02-features/task-loop/FS-任务循环执行器.md`（审查期间作者会话并发追加了 2 行，**不在本次范围**）
- 关联 SR 报告：无
- **已加载的 skill**：`harness v1.1.0`（`node scripts/resolve-skills.mjs --diff` → 改动文件 4 个〔含 2 个未跟踪〕，命中 1 个：`scripts/lib/gitlab-triggers.mjs`、`test/task-loop.test.sh`）
- 审查方式：未修改任何工作区文件；变异检验与探针在 `/tmp/cr-review/` 的 rsync 副本上跑（复跑命令见附录 B）。

## 0 硬规则逐条核（harness skill H1–H9）

| # | 规则 | 检测命令 | 结果 |
|---|---|---|---|
| H1 | 改 `hooks/**` 或 `scripts/**` 必须同批新增测试场景 | `git diff --name-only HEAD \| rg '^(hooks\|scripts)/'` → `scripts/lib/gitlab-triggers.mjs`；`git diff --name-only HEAD \| rg -c '^test/'` → `1` | ✅ 同批新增 2 条 `check`（`test/task-loop.test.sh:894` 单测块含 4 个断言；`:944` 端到端） |
| H2 | 生成物禁止手改，只能改源 + 重建 | `npm run check:agents` → 「68 个文件与源一致」；`npm run check:hooks` → 「hook 接线与 manifest 一致」 | ✅ |
| H3 | 解析失败必须 fail-closed，不许 `return 0` 伪装放行 | `rg -n "=== null" hooks/*.mjs` → 4 处：`guard_write.mjs:90` → `deny`、`guard_state.mjs:55` → `block`、`guard_state.mjs:70` → `block`、`guard_command.mjs:94` → `deny` | ✅（命令口径；本次 diff 不碰 hooks）。但 diff 新增的 `gitlab-triggers.mjs:265` `Array.isArray` 守卫把「2xx 非数组体」当空页，属同一精神的形态级 fail-open → §3 🟡#2 |
| H4 | 黑名单/白名单/受保护区只写在 `harness.config.json` | `rg -n "'rm -rf\|--no-verify\|\.claude/agents/\*\*" hooks/*.mjs` → 无输出；`git diff HEAD \| rg '^\+.*(rm -rf\|--no-verify\|\.claude/agents)'` → 无输出 | ✅ |
| H5 | 每个 skill 的 Stage 0 ≤ 5 项、单文件 ≤ 200 行、深度 ≤ 2 层 | `npm run check:skills` → 5 个 skill 通过（harness 79 行） | ✅ |
| H6 | 新增拦截规则时，同一批必须给出「如何合法绕过」 | — | 未命中（本次是取数修复，不是拦截规则）。附注：超页 → `die(1)` 无旁路，并入 §3 🟡#1 |
| H7 | 新增 hook 必须同时接进两个 CLI | — | 未命中（无新增 hook）。旁证：作者 `.ai/verify/RWC2.log` 中 `test:wiring` ✓（09:53:37–09:54:23，晚于受审文件最后修改） |
| H8 | 配置里新增的功能键必须有消费者 | — | 未命中（无新增配置键；`DISCUSSIONS_MAX_PAGES` 为代码常量，见附录 A）。旁证：`RWC2.log` `doctor` ✓ |
| H9 | 新增或修改的断言必须可证伪，并附一次变异结果 | 对照组 + 4 个变异，见下表（本人在 `/tmp` 副本实跑） | ✅ |

H9 变异实跑（每组均为全量 `bash test/task-loop.test.sh`，副本含 `.ai/`、`.claude/`，排除 `.git`、`.zwork`）：

| 组 | 变异（`scripts/lib/gitlab-triggers.mjs`） | 结果 |
|---|---|---|
| ctrl | 不变异 | **152 通过 0 失败**（证明副本环境本身有效，红不是环境造成的） |
| M1 | `:269` 改为无条件 `break`（不追 `x-next-page`） | 150 通过 **2 失败**：`FAIL cross-page` + 端到端用例红 |
| M2 | `:272` 到上限 `break` 而非 `throw` | 151 通过 **1 失败**：`FAIL max-pages-throws` |
| M3 | `:263` 非 2xx `break` 而非 `throw` | 151 通过 **1 失败**：`FAIL http-error-on-page2-throws` |
| rev | `:301` 取 discussions 退回 `api(...)` | 150 通过 **2 失败**：`FAIL cross-page` + 端到端用例红——与作者「2 条新用例变红、其余 150 条不受影响」一致 |

## 1 改动摘要

`fetchTriggers` 对每个 open MR 拉 `/discussions` 时原不带 `per_page`，GitLab 默认每页 20 条；!1847 有 22 条，评审人的打回评论落在第 2 页，runner 每轮只看到「无评审意见」。本次新增闭包助手 `allDiscussions(path)`（`:254-276`）：`per_page=100`，按 `x-next-page` 翻页，上限 10 页；到上限仍未取完或任一页非 2xx 一律抛错、不返回部分结果（部分视角会让 sweep 把看不见的触发当「消失」关账）；读不到下一页头按「已取完」处理。调用点 `:301` 由 `api(...)` 改为 `allDiscussions(...)`。测试新增单测 4 断言 + 端到端 1 条，并把 5 处存量夹具的 `/discussions$` 放宽为 `/discussions(\?|$)`。**diff 中未混入无关改动**（逐 hunk 核过：triggers 仅注释块 + 助手 + 1 行调用；test 仅 5 处正则 + 2 个新块）。

## 2 阻断项 🔴

无（0 条）。

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | `scripts/task-loop.mjs:422-424` × `scripts/lib/gitlab-triggers.mjs:271-273`；`test/task-loop.test.sh:894-994` | (a) **翻页出错经 runner 的分类零测试覆盖**。新用例只钉住 `fetchTriggers` 抛错；存量 5f/5f-bis/5f-ter（`:1034-1105`）的假服务器对所有路径返回同一状态码，首个请求 `/merge_requests` 就抛，`/discussions` 从未出过错；5k-quad（`:1517`）出错的是详情。(b) **超过 10 页走 `die(1)`**：整轮在剖面 B 之前退出、每 30 分钟重复直到该 MR 消失，与同函数 `:266-267` 注释「崩会让整轮剖面 A 失败，为一个 MR 拖死全部」的取舍自相矛盾。探针实证（附录 B）：page 2 返回 502 → exit 1、`剖面 A 临时不可达`、`source_soft_fail`、ack/pack 保留、无 `trigger_gone`（正确）；无限翻页 → exit 1、`剖面 A 触发轮询失败`、无 `source_soft_fail`；discussions 404 → `die(1)`（存量行为；详情 404 在 `:324` 是跳过）。 | ① 补一条端到端：page 2 返回 502 → exit 1 + 「临时不可达」+ ack 保留 + 无 `trigger_gone`（附录 B 探针脚本可直接改写）。② 超页归为源级软失败（保留响亮事件），或在注释明示此处选 `die` 的理由；长期看按 MR 隔离（出错 MR 记入 incomplete 集合，其余 MR 继续）。 | ① 建议同批补；② 可延后登记 KI |
| 2 | `scripts/lib/gitlab-triggers.mjs:264-265` | `if (Array.isArray(rows)) out.push(...rows)`：**2xx 但非数组体被静默当空页**。探针 E：返回 `{message:"weird"}` + 200 → triggers=0、无异常、无日志。与「视角不完整即拒绝判定」的设计意图相悖（形态异常 = 视角不完整）；该页评审意见被当成不存在，退回 CI 分支——正是本次要修症状的静默版。现实触发概率低（GitLab 出错走非 2xx；HTML 体走 `res.json()` 抛错）。 | `if (!Array.isArray(rows)) throw new Error(...)`，一行。 | 修（同批） |

🟡 共 2 条，均已表态。

## 4 跨模块影响

| 调用方 | 是否受影响 | 证据 |
|---|---|---|
| `scripts/task-loop.mjs:404`（全仓**唯一**调用方） | 签名、返回形状不变；新增失败形态经 `:422-424` 的 `temporary` 正则分类：5xx/429/超时/断网 → 软失败；其余（含超页）→ `die(1)` | `rg -n "fetchTriggers\("` 全仓仅 `:404` 一处调用；探针三种形态输出 |
| sweep 关账（`task-loop.mjs:538` `gitlabViewComplete`、`:551`） | 不受影响，且是抛错设计的另一半：抛错 → `softFail` 含 gitlab → 视角不完整 → 不动账。二者互补不重复：若返回部分结果，`gitlabViewComplete` 仍为 true，sweep 会误关账 | 探针 http502-page2：ack/pack 保留、无 `trigger_gone` |
| 剖面 B（飞书） | 5xx/429/超时：不受影响（其余源继续）；超页/4xx：被 `die(1)` 拖死（见 🟡#1） | 探针输出行 |
| 其他夹具/消费者 | 无 | `rg -n "discussions"` 仓内除本测试与 triggers 外无路由匹配；`test/e2e/gitlab-decision.e2e.mjs` 不调用 `fetchTriggers` |
| API 成本 | ≤100 条讨论的 MR 仍是 1 次请求；每多 100 条 +1 次；每页独立 15s 超时，超时在第一页就抛、不会累加到 150s | `:259`、`:261` |

## 5 安全检查

| 项 | 结果 |
|---|---|
| 注入（SQL / 命令 / 模板） | ✅ 无 shell/SQL；URL 由常量与数字 id 拼接（`:300` `mr.project_id`/`mr.iid`） |
| 越权（横向 / 纵向） | ✅ 同一 PAT、同一端点，仅多带分页参数 |
| 敏感信息进日志 | ✅ 错误文案只含 path / status / 条数（`:263`、`:272`）；token 仅在请求头 |
| 依赖变更 | ✅ 无 |

## 6 测试覆盖

| 新增行为 | 是否有对应测试 | 备注 |
|---|---|---|
| 单页：恰好 1 次请求并触发 | ✅ 单测 ① | `discCalls === 1`（省调用的正向用例） |
| 跨页取全并触发（!1847 形态） | ✅ 单测 ② + 端到端 | M1 / rev 变红 |
| 到上限抛错、不返回部分 | ✅ 单测 ③ | M2 变红 |
| 中途 HTTP 错抛错 | ✅ 单测 ④ | M3 变红 |
| 缺 `x-next-page` 头按已取完 | 隐式 | 150 条存量夹具均无 `headers`，可选链是承重的；探针 A/B/C/F 实证（空串/非法值/`next≤page`/`"2abc"` 均 1 次请求、无死循环） |
| runner 对翻页 5xx → 软失败不动账 | ❌ | 行为经探针验证正确，但无用例钉住 → 🟡#1 |
| runner 对超页 → `die(1)` | ❌ | 同上 → 🟡#1 |
| 5 处夹具正则放宽 | ✅ 无断言失去意义 | `(\?|$)` 仍锚定精确路径，`/discussions/xyz` 不匹配；5c-ter 仍区分 MR 7/8；ctrl 组 152/0 |
| 反模式 T1–T7 | ✅ 无恒真/吞异常/注释断言/非确定性 | ③④ 的 `try/catch` 以「必须抛」为断言；端到端 node 恒 `exit 0` 但由 `grep "^ok 0 working 1 true$"`（`:993`）判红，崩溃/读不到 ack 时同样判红 |

## 7 结论

（2026-11-26 结案核对后同步为**最终状态**；前两轮结论原文保留在本节末，依据见 §8、§9）

- 🔴 数量：0（首轮 0；增量复核 0；结案核对 0）
- 🟡 已全部表态：是。**前两轮 4 条编号 🟡 均已结案**——首轮 #1：① 已修，② 超页保持致命，并入 A2、延后可接受；首轮 #2：已修；增量 #1：已修（字面全角括号 + 非数组用例 + 工单字节比对，M10b / M11 独立复跑变红）；增量 #2：已修（超页报错带路径 + 超页端到端，M12 / M2 变红）。**结案核对新开 🟡 3 条（§9.3），均不阻断**，且都不涉及产品代码的行为：测试块共用账本导致串扰误红、A2 延后项未见登记、retro 第 9 条对上轮 M11 的归因与证据不符。
- 建议：**approve**（维持，三轮一致）。产品代码与断言不需要再改；合入前建议顺手带上 §9.3 的 #1（改 3 处路径名）与 #2（`known_issues` 补一条），#3 改一句措辞。
- 增量复核结论原文：🔴 数量 0；🟡 已全部表态：是（首轮 2 条已处置——#1 ① 已修（5g-ter 端到端 + M7 变红），② 作者保留「超页致命」，复核**认可结论、不认可论据**（§8.3）；#2 代码已修（探针实证），其测试缺口转入增量 🟡#1。增量复核新开 🟡 2 条（§8.3），均不阻断）；建议 **approve**（增量复核后维持）；「超页 → 不可重试的源级硬失败」重构登记 KI。
- 首轮结论原文：🔴 数量 0；🟡 已全部表态：是（2 条）；建议 **approve**——🟡#2 一行 `throw` 建议合入前顺手带上；🟡#1 不阻断，① 建议同批补端到端，② 登记 KI。

## 附录 A：仅记录（不计入 🟡）

- `.ai/tasks/review-with-ci/state.json` 仍在 `rs`、`todos: []`、`artifacts: {}`；`RWC1.log`（测试套件 152/0）与 `RWC2.log`（`npm run gate` 36 段全绿）已落盘但未登记进 state；变异与 !1847 实测无日志。
- 审查期间作者会话并发改动：`docs/01-requirements/RS-task-loop.md`（+1，09:52:52）、`docs/02-features/task-loop/FS-任务循环执行器.md`（+2，09:52:57），不在本次范围。
- `allDiscussions(path)`（`:259`）以字符串拼接 URL，隐含「path 不含 `?`」假设；**现状成立**（唯一调用点 `:301` 的 `base` 在 `:300` 由数字 id 拼成），不会弄坏查询串。日后复用请改 `URLSearchParams`。
- 缺 `x-next-page` 头按「已取完」：若实例前的代理剥离分页头，原症状会静默复现且无遥测；可用 `x-total` > 已取条数作截断探测（KI）。
- `DISCUSSIONS_MAX_PAGES = 10` 为代码常量（skill Stage 0 自检项「阈值优先 `harness.config.json`」）；1000 条讨论量级下可接受。
- `test/task-loop.test.sh:895` 注释写「三形态」，实为四形态。
- 代码注释引用「架构体检 🔴#1」「CR 二审 🔴#1」等历史编号，本次未核。
- GitLab 分页公开约定（默认 20 条、`x-next-page`、末页空串）：联网工具不可用，未在线核对；代码对空串/缺头的处理经探针验证正确。

## 附录 B：审阅范围与未覆盖

**核对了哪些主张**：diff 仅含所述 3 项；测试套件全绿；3 项变异 + 红灯复现；`fetchTriggers` 全函数与 runner 分类/sweep 上下游；调用方检索；`x-next-page` 六种边界；runner 对三种出错形态的实际分类。

**标准**：harness skill H1–H9；`references/test-quality.md` T1–T7；任务给定的设计意图（不返回部分结果）。

**复跑命令**（均在 `/tmp` 副本，不碰工作区）：
```bash
# 副本 + 变异
rsync -a --exclude .git --exclude .zwork --exclude node_modules ./ /tmp/cr-review/<组>/
#   变异脚本对目标行做字面量精确替换，匹配数 != 1 即 exit 2
# 分类探针（page2 502 / 无限翻页 / discussions 404）
node /tmp/cr-review/classify-probe.mjs /tmp/cr-review/ctrl /tmp/cr-review <mode>
```

**没能验证**：
- !1847 真实实例上的 signal / 指纹变化：需真实 token（不读 `.env`），未验证。
- `npm run gate` 全量、`test:wiring`、`doctor`：未亲自复跑；采信作者 `RWC2.log`（时间戳晚于受审文件最后修改）。
- `npm run e2e`（`test/e2e/gitlab-decision.e2e.mjs`）：未跑；不在 gate 内，且不调用 `fetchTriggers`。
- docs/RS、FS 的并发改动：不在范围。
- GitLab 分页头的在线文档：联网工具不可用。

## 8 增量复核（2026-11-26 11:01）

> 复核对象：**首轮之后的变化**——`scripts/task-loop.mjs:424-430`（`discNotFound`）、`scripts/lib/gitlab-triggers.mjs:250-258 / 274-282 / 290`（注释重写、JSON 解析包裹、报错文案）、`test/task-loop.test.sh:1205-1294`（5g-ter 新块 + 远端引用核对）。其余 hunk 沿用首轮结论，未重审。
> 范围指纹：`git diff HEAD -- <三文件> | shasum -a 256` = `314d8c36db61a66826ee30971e007bc3c76ce61449dfa5d319d1ff16b8c93c80`（+251/−7）。受审文件 mtime 10:44:45 / 10:41:47 / 10:12:16；复核起止及落笔前三处均与副本 `cmp` 逐字节一致。
> skill：`node scripts/resolve-skills.mjs --diff` → 命中 `harness v1.1.0`（上述三文件）；已读 `SKILL.md` 硬规则表与 `references/test-quality.md`。
> 方式：未改工作区任何文件（`git status` 前后一致）。测试、变异、探针全部在 `/tmp/cr-inc/` 的 rsync 副本上跑（排除 `.git`/`.zwork`/`node_modules`；副本三文件 `cmp` 等于工作区）。受只读约束**未用 `verify-run.sh` 包装**（它会写 `.ai/verify/`）；命令与输出摘要见 8.5。

### 8.1 结论

**可以交付。🔴 0；🟡 2（增量新开，均为测试断言强度与报错可操作性，不阻断）。** 首轮两条 🟡 的处置：#1 ① 已修，② 作者保留「超页致命」——结论认可、论据不认可（见下）；#2 代码已修（探针实证），测试缺口转入 🟡#1。

### 8.2 必须修 🔴

无（0 条）。

### 8.3 值得考虑 🟡（2 条）

| # | 位置 | 问题 | 影响 | 依据 | 修复方向 | 处置 |
|---|---|---|---|---|---|---|
| 1 | `test/task-loop.test.sh:1284`；`:1260,1266,1272,1286`、`:1275-1279` | 5g-ter 有两处断言**弱于其标题**。(a) `non-array-body-throws` 的正则 `响应体不是(合法 JSON\|数组)\b[^\n]*content-type=text/html` 里「数组」分支是**死分支**：`数组` 后紧跟全角括号 `（`，两侧都不是 `\w`，`\b` 永不成立。该用例实际只走了「非 JSON」路径；「2xx + 合法 JSON 但非数组」（首轮 🟡#2 的原始场景）没有任何用例。(b) 判据标题写「账目/工单不动」，但工单只断言 `existsSync(pack)`，字节从未比对；`fatal()` 里连存在性都没查 | (a) 把守卫退回首轮缺陷后全套仍绿，回归无感知；(b) 软失败轮改写工单全套仍绿 | **M10**（`:280-283` 还原为 `if (Array.isArray(rows)) out.push(...rows)`）→ **154 通过 0 失败**；对 M10 副本喂 200+`{message:"weird"}`，runner 打印「gitlab 无待办触发」并 `exit 0`（变异确实生效）。**M11**（`:433` 后追加「软失败轮向 `pack-*.md` 追加一行」）→ **154 通过 0 失败**；对 M11 副本跑「健康轮 → 502 轮」，pack-62 哈希 `ab1a695b70dc` → `cd9e90f30bd0`、ack 不变（变异确实生效）。正则实测：该断言对真实报错行「响应体不是数组（object，content-type=text/html）」→ `false`，去掉 `\b` → `true` | (a) `\b` 改成字面 `（`（或删掉），并加一个 `disc_jsonobj` 模式（200 + `{}`）；(b) 健康轮后取 `beforePack`，各故障轮比对字节 | 修（同批，约 5 行测试） |
| 2 | `scripts/lib/gitlab-triggers.mjs:290`；`test/task-loop.test.sh:1205-1294` | 超页分支既然定性为「需要人看见」（`:256-258` 注释与 A2 取舍），就没有为「人」做完：(a) 报错不带 MR 标识；(b) runner 把超页归 `die(1)` 这一分类决定没有端到端用例（M2 只钉住 `fetchTriggers` 抛错；5g-ter 六种形态里没有超页） | 列表有多个 MR 时，运维看到「超过 10 页仍未取完（N 条）」要自己猜是哪个；且该 MR 连带拖停其余 MR 与剖面 B（`:430` 先于剖面 B 退出） | 探针（列表含 MR 62、63，discussions 恒回 `x-next-page`）→ `[task-loop] 剖面 A 触发轮询失败：discussions 超过 10 页仍未取完（10 条）——视角不完整，拒绝按部分结果判定`，无 iid；同函数 `:269` 的 HTTP 报错则带 `path page=N` | (a) 报错加 `${path}`（与 `:269` 对齐，一行）；(b) 5g-ter 加 `disc_overflow` 模式，断言 exit 1 +「剖面 A 触发轮询失败」+ 无 `source_soft_fail` | 修（同批，约 3 行）；「不可重试源级硬失败」重构登记 KI |

🟡 共 2 条，均已表态。

**A2 的独立判断：超页保持致命是否合理**

**结论：保持致命可以接受，不要求本批改成软失败；但支撑它的论据「软失败是静默的」与代码不符，建议更正注释与交付说明里的这条理由。**

1. 「软失败是静默的（每 30 分钟一条 `source_soft_fail`，没人看）」不成立。软失败轮 `finish({ code: 1, stamp: false })`（`task-loop.mjs:643`）→ `markHealth(false, '软失败轮…')`（`:235`）；`die(1)` → `markHealth(false, 'die 1: …')`（`:57`）。两条路进同一个 `noSuccessStreak`，连续 `healthAlertTicks`（本仓 10）拍后**同样**落 `loop_degraded` + macOS 本地通知（`:179-199`），退出码同为 1。实跑对照（`healthAlertTicks=2`）：502 软失败 ×2 → `⚠ 循环退化：连续 2 轮无成功（软失败轮（源故障不落戳））` + `loop_degraded`；超页 die ×2 → `⚠ 循环退化：…（die 1: 剖面 A 触发轮询失败：discussions 超过 10 页…）` + `loop_degraded`。附带更正：软失败与 die 都不落节流戳，按定时器心跳重试（默认 180s；`pollSeconds=1800` 只约束成功轮），不是「每 30 分钟一条」。
2. 真正的差别只有两点。① `die` 在剖面 B 之前 `process.exit`，连带拖停飞书源——它是靠「殃及另一个有活跃消费者的源」才变响的，而 `:418-420` 的存量注释正是为此去掉这种耦合。② 软失败的文案（`临时不可达` / `下 tick 重试`）与 `loop_degraded` 的 `why`（固定为「软失败轮」）会把永久性故障说成临时；`die` 的 `why` 带因由。第 ② 点足以否决「直接归软失败」，第 ① 点说明「保持致命」有代价。
3. 第三种处理（建议登记 KI，不建议本批做）：把超页定义为**不可重试的源级硬失败**——照旧 exit 1 + `markHealth(false, 因由)`（响度与 die 相同），但只跳过 GitLab 源、让剖面 B 继续，并落独立事件（如 `source_overflow`，带 MR 路径与页数），不混进 `source_soft_fail`。约 10 行，同时消掉 ① 的代价与 ② 的语义错误。本批先用 🟡#2 的两处补强即可。

### 8.4 仅记录

- `discNotFound`（`task-loop.mjs:429`）对代码库自身形态无误放行：实测 `/discussions/<id> HTTP 404`、MR 详情 / 列表 / notes 的 404、`HTTP 4040` 均不命中；`optional()`（`gitlab-triggers.mjs:249`）吞错后到不了这个 catch，详情 404 在 `:342` 已被跳过。唯一能命中的非目标形态：非 JSON 报错里 80 字符响应体片段含 `/discussions HTTP 404`（远端可控文本；`temporary` 正则早有同等暴露）——不现实，不改。
- discussions 404 的归类成立：列表能返回该 MR，则同一 token 读 discussions 不会因权限持续 404；持续 404 只剩「列表与 discussions 之间 MR 被删」的竞态，下一拍它离开 opened 列表。（GitLab 接口语义未在线核对，见 8.6。）
- B 的修复生效（真实 runner）：discussions 回 `text/html` → `剖面 A 触发轮询失败：GitLab /projects/1/merge_requests/62/discussions page=1 响应体不是合法 JSON（content-type=text/html; charset=utf-8）：Unexpected token '<', "<html><bod"... is not valid JSON`；回 200+`{"message":"weird"}` → `…响应体不是数组（object，content-type=application/json）`。均 exit 1、带 path 与 content-type，裸 `Unexpected token` 只作尾部片段。
- `task-loop.mjs:421` 存量注释「（401/403/404…）才整轮 die」已不准确（应为「其它 404」），与 6 行下的新注释并排。
- 软失败轮仍打印「gitlab 无待办触发，本轮结束」（探针输出；存量行为，非本次增量），与「视角不完整」相斥，靠行尾「源故障 gitlab」兜底。
- 新块沿用了已占用的标签 `5g-ter`（`:1205` 新块、`:1296` 存量块，HEAD 即有）；标题「三类形态」/「三种故障」实为 6 轮。
- 非 JSON 报错把最多 80 字符响应体带进 die 文案（stdout / stderr 两路）；GitLab 响应体非敏感，但含换行时会打破单行。

### 8.5 实跑命令与输出摘要

```bash
# 副本：/tmp/cr-inc/<组>（ctrl 三文件 cmp 与工作区一致）
rsync -a --exclude .git --exclude .zwork --exclude node_modules ./ /tmp/cr-inc/ctrl/
# 变异：/tmp/cr-inc/mutate.mjs <副本> <组>——字面量精确替换，锚点不唯一或不命中即 exit 2
cd /tmp/cr-inc/<组> && bash test/task-loop.test.sh          # 每组约 32s，5 组并行
node /tmp/cr-inc/probes/regex-probe.mjs /tmp/cr-inc/ctrl     # 从源码原样取正则，14 种报错形态
/tmp/cr-inc/probes/run.sh <html|jsonobj|jsonobj_html|overflow|page2_502> <轮数> [healthAlertTicks]
```

| 组 | 变异 | 结果 |
|---|---|---|
| ctrl | 不变异 | **154 通过 0 失败**（exit 0，32s）——作者基线属实 |
| M7 | `:429` 放宽为任何 `HTTP 404` | 153 通过 **1 失败**：`FAIL other-path-404-still-fatal:1` |
| M9 | `:275-279` 去掉 try/catch，退回裸 `res.json()` | 153 通过 **1 失败**：`FAIL non-array-body-throws:1` |
| M10 | 还原首轮 🟡#2 缺陷（`if (Array.isArray(rows)) out.push(...rows)`） | **154 通过 0 失败** → 🟡#1(a) |
| M11 | 软失败轮向 `pack-*.md` 追加一行 | **154 通过 0 失败** → 🟡#1(b) |

探针输出（真实 runner，`--once --profile a`，`--root` 指向 /tmp 临时 git 仓）：

| 模式 | exit | 关键输出 |
|---|---|---|
| html | 1 | `剖面 A 触发轮询失败：GitLab /projects/1/merge_requests/62/discussions page=1 响应体不是合法 JSON（content-type=text/html; charset=utf-8）：Unexpected token '<', "<html><bod"... is not valid JSON` |
| jsonobj / jsonobj_html | 1 / 1 | `…响应体不是数组（object，content-type=application/json）` / `…（object，content-type=text/html）` |
| overflow（MR 62、63） | 1 | `剖面 A 触发轮询失败：discussions 超过 10 页仍未取完（10 条）——视角不完整，拒绝按部分结果判定`（无 iid） |
| page2_502 ×2（ticks=2） | 1, 1 | `剖面 A 临时不可达（… page=2 HTTP 502）` → 第 2 轮 `⚠ 循环退化：连续 2 轮无成功（软失败轮（源故障不落戳））` + `loop_degraded` |
| overflow ×2（ticks=2） | 1, 1 | 第 2 轮 `⚠ 循环退化：…（die 1: 剖面 A 触发轮询失败：discussions 超过 10 页…）` + `loop_degraded` |
| M11 副本：健康轮 → 502 轮 | 0, 1 | pack-62 `ab1a695b70dc` → `cd9e90f30bd0`，ack 不变 |
| M10 副本：200+`{message:"weird"}` | **0** | `gitlab 无待办触发，本轮结束`（ctrl 同一输入为 exit 1） |

硬规则（harness H1–H9，仅就增量）：

| # | 结果 |
|---|---|
| H1 | ✅ `scripts/**` 与 `test/**` 同批（5g-ter 两条 `check`） |
| H3 | ✅ discussions 404 归软失败后 `gitlabViewComplete=false`，`:557` 不动账，非 fail-open |
| H6 | 未命中（无新增拦截规则） |
| H9 | ⚠ M7 / M9 变红；M10 / M11 揭示两处断言未钉住其声称 → 🟡#1 |
| H2 / H4 / H5 / H7 / H8 | 增量未触及，沿用首轮结果，未重跑 |

### 8.6 审阅范围与未覆盖

**核对的主张**：① 增量范围与三文件指纹；② `discNotFound` 的放行面（14 种报错形态 + 到达该 catch 的代码路径可达性）；③ B 修复的真实报错（HTML、合法 JSON 非数组两种）；④ 5g-ter 逐条 `must`——`must` 与 `fatal` 都以 `process.exit(1)` + 不打印 `ok` 行判红，子进程崩溃同样没有 `ok` 行，无吞失败；远端引用核对（`:1293`）非恒真：引用由健康轮的 runner 创建，故障轮在认领前就抛错、不会重建，任一轮释放即红；⑤ 基线 154/0；⑥ M7、M9 变红且位置与作者自述一致；⑦ A2 论据涉及的 `die` / `finish` / `markHealth` / 节流节拍。

**标准**：harness skill H1–H9；`references/test-quality.md` 的 T2 / T3 / T7；任务给定的设计意图（视角不完整即拒绝判定）。A2 按「是否静默、代价多大、人能否处置」三项判断。

**没能验证**：
- GitLab 公开事实（分页头约定、MR 删除后 discussions 的 404 语义、关闭 / 合并后是否仍可读）：`web_search` 与 `fetch_content` 本轮均返回 unavailable，未在线核对；A1 归类依据的是代码可达性，不是接口语义。
- M1 / M2 / M3 / M6 / M8 未重跑（首轮已核 M1–M3；M6、M8 与 M7 同一根因，采信作者自述）。
- `npm run gate`、`test:wiring`、`doctor`、`npm run e2e`：未跑；`.ai/verify/RWC2.log` 未核其时间戳是否晚于 10:44:45。
- !1847 真实实例：无 token，未验证。
- 剖面 B 在软失败轮「继续」只读了代码路径（`:434` 之后顺序执行），未用双源环境实跑。
- 作者会话是否仍在改动：受审三文件在 10:53、10:58、落笔前三次 `cmp` 一致，之后未再核。

## 9 结案核对（2026-11-26 11:28）

> 复核对象：§8 两条 🟡 的处置、A2「延后第三种处理」、M10b / M11 复测主张。
> 范围：`scripts/lib/gitlab-triggers.mjs:275-290`、`scripts/task-loop.mjs:429-437`、`test/task-loop.test.sh:1205-1337`（5g-quinquies + 5g-ter）、`retro/review-with-ci-2026-11-26.md`、`.ai/tasks/review-with-ci/state.json`。其余 hunk 沿用前两轮结论，未重审。
> 范围指纹：`git diff HEAD -- <三文件> | shasum -a 256` = `53d7d1128c3d88af9f7cd0b1e1b81c90021a3a266b9711b79e5ec9edbc6f924c`（+263/−7）；文件 sha256 前 8 位 triggers `ad67579b` / task-loop `b23378e8` / test `c022ab65`；11:09 首取、11:25 落笔前复核一致（mtime 11:06:14 / 11:07:21 / 11:08:23）。
> skill：`node scripts/resolve-skills.mjs --diff` → 命中 `harness v1.1.0`；已读 `SKILL.md` 硬规则表与 `references/test-quality.md`（T2 / T3 / T7）。
> 方式：工作区只读，本轮唯一写入是本文件；测试 / 变异 / 探针全部在 `/tmp/cr-close/` 的 rsync 副本上跑（排除 `.git` / `.zwork` / `node_modules` / `.env*`；七个副本的受审三文件 `cmp` 与工作区一致，mismatch = 0）。受只读约束未用 `verify-run.sh` 包装（它会写 `.ai/verify/`）。

### 9.1 结论

**可以交付。🔴 0；🟡 3（本轮新开，均不阻断，且都不涉及产品代码的行为）。**

- 上轮两条 🟡 **均已按描述修复**，并经独立变异复证：M11 → 153 通过 1 失败（红在 `502-keeps-ledger`），M10b → 151 通过 3 失败（红在主断言 + 两条连带），与作者自述逐项一致；基线 154 通过 0 失败属实。
- A2「延后第三种处理」**可接受**；但「已登记为后续项」在产物里找不到落点（🟡#2）。
- 建议：**approve（维持，三轮一致）**。产品代码与断言不需要再改；合入前建议顺手带上 🟡#1（改 3 处路径名）与 🟡#2（`known_issues` 补一条），🟡#3 改一句措辞。

### 9.2 必须修 🔴

无（0 条）。

### 9.3 值得考虑 🟡（3 条）

| # | 位置 | 问题 | 影响 | 依据 | 建议 |
|---|---|---|---|---|---|
| 1 | `test/task-loop.test.sh:1301`（5g-quinquies）× `:1335`（5g-ter） | 两块共用同一组临时路径 `"$TMP/ledger5gt"` 与 `"$TMP/e2e5gt.txt"`。5g-ter 对**整个** `events.jsonl` 断言不含 `trigger_gone`（`:1332-1333`），读到的是上一块 MR 62 的关账事件 | 上一块任何一次真实的误关账都会让 `--mr 过滤轮不动账` 跟着红，把排查者引到 `--mr` 过滤逻辑上，而它自己的被测对象（MR 61）其实完好。基线不受影响（只会多红，不会漏红），属于红错用例 | M10b 保留临时目录实测（9.8）：`ledger5gt/events.jsonl` 第 9 行是 `trigger_gone {kind:mr, id:"62", released:true}`，位于第 10 行（`--mr 999` 轮的 `gitlab_polled`）之前；`e2e5f/w/.ai/task-loop/ack-61.json`、`pack-61.md`、`refs/heads/claims/mr-61` 均在；`e2e5gt.txt` = `bad 0`（exit 0）。M2 下同样是这两条连带红 | 新块换一组路径名（如 `ledger5gq` / `e2e5gq.txt`，3 处字面量）；或 5g-ter 只看本轮新增事件（`slice(t0)`，与 `:1261` 同法） |
| 2 | `.ai/tasks/review-with-ci/state.json`（`"known_issues": []`）；`retro/review-with-ci-2026-11-26.md:23-25`（第 7、8 条） | 「第三种处理登记为后续项」找不到登记：`known_issues` 为空，retro 第 7、8 条只写取舍与论据更正、没有后续项，RS / FS 的 diff 里也没有 | 超页的残余代价（`die(1)` 在 `task-loop.mjs:437` 剖面 B 之前退出，飞书源被拖停）只留在本 CR §8.3；按 `state.json` 接手的人看不到这条已知风险 | 对 `retro/`、RS、FS、`.ai/tasks/review-with-ci/` 四处搜 `硬失败`、`source_overflow`、`不可重试`、`第三种`，只命中 retro 第 7、8 条里的「超页」字样，无后续项 | `known_issues` 补一条（超页 → `die(1)` 连带拖停剖面 B；拟改为只跳过 GitLab 源的源级硬失败，需动剖面 A 分类、`finish`、`markHealth`、sweep 视角判定） |
| 3 | `retro/review-with-ci-2026-11-26.md:27`（第 9 条） | 把「M11 不红」归因为「首版变异脚本用了硬编码相对路径，工单根本没被改写，所谓不红是变异本身空转」。这对审阅者上一轮的那次 M11 不成立：该副本的变异行（`/tmp/cr-inc/m11/scripts/task-loop.mjs:434`，10:53:30 写入）用的是 `join(root, '.ai', 'task-loop')`；本轮把该旧副本（旧断言 + 该变异）原样重跑并保留临时目录，`pack-62.md` 含 2 行 `MUTATED`，套件仍 154 通过 0 失败 | 教训方向没错，但因果写错了对象：上一轮不红是真实的断言缺口（旧断言只查存在性；§8.3 当时就记录了探针哈希变化），不是变异空转。照现在的写法，读者会以为审阅者的变异结论不可信 | 9.8 表 `m11-old` 行；该副本相对 ctrl 的 `diff` 只多这一行变异 | 改一句措辞——空转发生在作者自己的复跑脚本里（「我复跑用的首版脚本…」），审阅者那次是断言缺口 |

🟡 共 3 条，均已表态。

### 9.4 仅记录

- `test/task-loop.test.sh:1298`：与 `:1297` 同条件的重复断言（标签 `non-array-keeps-ledger`），可删一行。
- `:1206` 注释「三类形态」、`:1306` 用例名「三种故障」：现为 8 轮故障（502 / 404 / 401 / 403 / 列表 404 / HTML / 非数组 / 超页）。
- `:1281`（`fatal()`）只比对 ack 不比对工单；`:1287-1288`（HTML 轮）账目与工单都没比对。两者都是 `die` 路径、在认领之前退出，现状无害。
- 变异形态的差异值得知道：把 `gitlab-triggers.mjs:280-282` 的守卫整段删除（而非改成条件 push）时，`out.push(...rows)` 对对象抛 `Spread syntax requires ...iterable[Symbol.iterator] to be a function`，仍 exit 1、不动账；⑥ 仍判红，因为它的正则钉的是文案——即 ⑥ 同时钉住了「抛错」和「抛的是哪条错」。
- 正则对 content-type 未锚定行尾：真实 GitLab 回 `text/html; charset=utf-8` 时 ⑤ 仍能命中（推演，未用真实实例验证）。
- `.ai/verify/RWC1.log` 是否对应 11:08 之后的最终版文件，未核。

### 9.5 三条意见的结案状态

| 意见 | 状态 | 独立核对证据 |
|---|---|---|
| 增量 🟡#1（5g-ter 断言弱于标题） | **已修** | (a) `数组\b` 死分支拆成 `:1287`、`:1292` 两条独立断言，均为字面全角括号、无 `\b`；新增夹具 `disc_json_object`（200 + `{"message":"not an array"}`）。正则从测试源码原样取出、对真实 runner 的报错行求值，9 格全部符合预期（仅对角线命中，9.8 探针 1）。(b) 工单改字节比对：`beforePack` 在健康轮后取（`:1259`），①②③⑥⑦ 均比对 `readFileSync(pack) === beforePack`；区间 `:1205-1306` 内 `existsSync(pack)` 仅剩 `:1257` 一处（计数 = 1）。编号 `:1205` = `5g-quinquies`，存量 `5g-ter` 在 `:1308`。变异：M11 → 153 / 1，红 `FAIL 502-keeps-ledger`；M10b → 151 / 3，红 `FAIL json-non-array-throws:0`。 |
| 增量 🟡#2（超页分支没为「人」做完） | **已修** | 超页报错末尾带接口路径（`gitlab-triggers.mjs:290`）；新增夹具 `disc_overflow`（`x-next-page` 恒为 page + 1）；`:1296` 断言 exit 1 + `discussions 超过 10 页仍未取完…` + `/projects/1/merge_requests/62/discussions` + `剖面 A 触发轮询失败`（确认走致命而非软失败），`:1297` 比对账目与工单字节。真实报错行见 9.8。变异：M12（只删报错里的 `${path}`）→ 153 / 1，红 `FAIL overflow-fatal-with-path:1`；M2（到上限 `break` 不抛）→ 150 / 4，含 `FAIL overflow-fatal-with-path:0`。 |
| A2（超页致命 vs 软失败 / 第三种处理） | **延后——可接受**；登记未见落地（🟡#2） | 见 9.7。retro 第 8 条对论据的更正属实：`die`（`task-loop.mjs:57`）与 `finish`（`:235`）进同一条 `markHealth` 记分通道。 |

### 9.6 M10b 下连带变红的两条存量用例：一条是真后果，一条是串扰

机制（真实 runner，M10b 副本，健康轮 → `disc_json_object`，9.8 探针 3）：非数组被当空页 → MR 62 无评审触发 → runner 转查 MR 详情，夹具回 404（`mr_detail_404`，跳过）→ 本轮触发集为空且视角完整 → sweep 关账：`mr-62 不再触发（已合并/已批红/已关闭）——释放认领并清理 ack 与工单（关账）`、`trigger_gone`、exit 0。

- **`翻页出错不释放认领`：真实后果。** 保留的临时目录里 `e2e5gt/r.git` 的 `refs/heads/claims/mr-62` 已删，`ack-62.json` / `pack-62.md` 已删——正是本次要防的误关账形态（认领被释放 = 可被别的机器抢走）。
- **`--mr 过滤轮不动账`：不是它所验证行为的后果。** 它跑的是 `TL5F/w` 的 MR 61 + `--mr 999`，实测 exit 0，`ack-61.json`、`pack-61.md`、`refs/heads/claims/mr-61` 原样都在。它判红是因为与上一块共用 `$TMP/ledger5gt`，并对整个账本断言不含 `trigger_gone`，读到的是 MR 62 的关账事件 → 🟡#1。

任务描述里的机制（「非数组被当空页 → 该 MR 讨论为空 → 触发消失 → 账目被关 / 认领被释放」）属实；需要更正的只是「两条连带红都出自这个机制」——第二条是测试隔离问题。

### 9.7 A2：延后「第三种处理」是否可接受

**可接受。** 一句话理由：超页的现状不是静默失败（exit 1，且与软失败走同一条健康记分——连续失败同样落 `loop_degraded` + 本地通知，§8.3 已实跑），账目与工单字节不动已由 `:1297` 钉住，触发条件罕见（单 MR 超过 1000 条讨论）；而第三种处理要同时改剖面 A 的分类（`:429-433`）、`finish` 的退出码与 `markHealth` 的 `why`（`:228-235`）、sweep 的视角判定（`:544`）和围栏文案，是一次设计变更，且健康记分处有过双记分前科（`:430` 注释里的 CR 二审 🟡#3′），不该塞进一个取数修复。

延后要成立的前提是登记落地——现状没有（🟡#2）。登记补上后 A2 即可结案；若最终决定不做，应把 §8.3 的建议从「登记 KI」改写为「已知并接受的代价」，写进 FS 的失败分支一节。

### 9.8 实跑命令与结果

```bash
# 副本（/tmp/cr-close/<组>；七副本受审三文件 cmp = 工作区）
rsync -a --exclude .git --exclude .zwork --exclude node_modules --exclude .env --exclude '.env.*' <工作区>/ /tmp/cr-close/ctrl/
node /tmp/cr-close/mutate.mjs  /tmp/cr-close/<组> <m11|m9|m2|m12|keep-tmp>   # 字面量精确替换，锚点命中数 != 1 即 exit 2
node /tmp/cr-close/mutate2.mjs /tmp/cr-close/<组>                             # M10b（作者口径：非数组 → 条件 push）
cd /tmp/cr-close/<组> && bash test/task-loop.test.sh                          # 每组约 32s，8 组并行
# 探针
node /tmp/cr-close/regex-real.mjs /tmp/cr-close/ctrl <临时仓> <ledger>         # 断言正则（源码原样取出）× 真实报错行
bash  /tmp/cr-close/m11-probe.sh <ctrl|m11>                                    # M11 是否生效：健康轮 → 502 轮，比对 pack 哈希
node  /tmp/cr-close/probes/mode-probe.mjs <副本> <临时仓> <ledger> ok <故障形态>  # 真实 runner 的故障轮行为
```

| 组 | 变异 / 操作 | 结果 |
|---|---|---|
| ctrl | 不变异 | **154 通过 0 失败**（exit 0）——基线属实 |
| **M11** | `task-loop.mjs:433` 后追加「软失败轮向 `pack-*.md` 追加一行」，路径 `join(root, '.ai', 'task-loop')` | **153 通过 1 失败**：`FAIL 502-keeps-ledger`——与作者自述一致 |
| **M10b** | `gitlab-triggers.mjs:280-283` 改为 `if (Array.isArray(rows)) out.push(...rows)`（非数组按空页） | **151 通过 3 失败**：`FAIL json-non-array-throws:0` + `翻页出错不释放认领` + `--mr 过滤轮不动账`——与作者自述一致 |
| M9 | 去掉 `:275-279` 的 try/catch | 153 通过 1 失败：`FAIL non-json-body-throws:1` |
| M12 | `:290` 报错去掉 `：${path}` | 153 通过 1 失败：`FAIL overflow-fatal-with-path:1`（新断言可证伪） |
| M2 | `:290` 到上限 `break` 不抛 | 150 通过 4 失败：`FAIL max-pages-throws` + 主断言（`overflow-fatal-with-path:0`）+ 上述两条连带 |
| M10b′（我的第一种写法，非作者口径） | 守卫整段删除 | 153 通过 1 失败：`FAIL json-non-array-throws:1`（见 9.4 第 4 条） |
| m11-old | 上轮旧副本 `/tmp/cr-inc/m11`（旧断言 `:1260` 只查 `existsSync(pack)` + 上轮 M11 变异）原样重跑，仅改保留临时目录 | **154 通过 0 失败**；保留目录里 `pack-62.md` 含 2 行 `MUTATED` |

M11 生效探针（跑套件之前）：m11 副本 pack-62 `b51cfb1639b9 → 0c3c46d5a17b`（含 `MUTATED` 1 行），ack-62 `0be603680d5e` 两轮不变；ctrl 对照两轮 pack 均 `9cc2d173685f`。

真实报错行（探针 1，ctrl 副本，cwd = 副本根）：

- `disc_html` → `[task-loop] 剖面 A 触发轮询失败：GitLab /projects/1/merge_requests/62/discussions page=1 响应体不是合法 JSON（content-type=text/html）：Unexpected token '<', "<html>sign in</html>" is not valid JSON`
- `disc_json_object` → `[task-loop] 剖面 A 触发轮询失败：GitLab /projects/1/merge_requests/62/discussions page=1 响应体不是数组（object，content-type=application/json）`
- `disc_overflow` → `[task-loop] 剖面 A 触发轮询失败：discussions 超过 10 页仍未取完（10 条）——视角不完整，拒绝按部分结果判定：/projects/1/merge_requests/62/discussions`

三条主正则（`:1287`、`:1292`、`:1296`）× 三种输出共 9 格：仅对角线命中，其余 6 格均不命中。

### 9.9 审阅范围与未覆盖

**核对的主张**：① 三条意见对应的 diff（逐 hunk）；② 三条新断言的正则对真实报错文本（源码原样取出，不手抄）；③ `existsSync(pack)` 在 5g-quinquies 区间内的出现次数；④ M11 / M10b 独立复跑及变异生效证明；⑤ 新断言的可证伪性（M9 / M12 / M2）；⑥ 两条连带红的因果（保留临时目录取证）；⑦ A2 论据更正是否属实（`:57`、`:235`）与登记位置；⑧ 上轮 M11 不红的归因（旧副本重跑）。

**标准**：harness skill H1–H9（本轮相关：H1、H3、H9）；`references/test-quality.md` 的 T2 / T3 / T7；任务给定的设计意图（视角不完整即拒绝判定）。

**硬规则（就本轮）**：H1 ✅（`scripts/**` 与 `test/**` 同批）；H3 ✅（非数组由「当空页」改为抛错 → 致命，非 fail-open）；H9 ✅（M9 / M10b / M11 / M12 / M2 均红，红点与断言一一对应）；H6 未命中；H2 / H4 / H5 / H7 / H8 本轮未触及，沿用前两轮结果，未重跑。

**没能验证**：
- `npm run gate` / `test:wiring` / `doctor` / `npm run e2e` 及 `task-loop.test.sh` 以外的套件：未跑。
- GitLab 公开事实（分页头、真实实例的 content-type 取值）：未在线核对。
- !1847 真实实例上的信号变化：无 token，未验证。
- 作者会话是否仍在改动：受审三文件在 11:09 与 11:25 两次指纹一致，之后未再核。
