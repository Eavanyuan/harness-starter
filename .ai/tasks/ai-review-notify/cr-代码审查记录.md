# CR-代码审查记录：审核与通知自动化

> 审查对象：`.ai/tasks/ai-review-notify/state.json`（任务 ai-review-notify，S 档 feature）。
> 审查路径：本地会话自审（按 AGENTS.md 硬规则 4 + CR 模板全量条款，含 §0）。
> 审查人：ZCode 会话（GLM-5.3）；批红归人（tech_lead）。

## §0 硬规则逐条核（harness skill H1–H8）

| # | 规则 | 结论 | 证据 |
|---|---|---|---|
| H1 | hooks/scripts 改动同批配测试 | ✅ | scripts/ 新增 6 文件，同批新增 3 个测试文件共 56 断言（15+19+22），`git diff --name-only` 可核 |
| H2 | 生成物禁手改 | ✅ | 未触碰 `.claude/ .zcode/ prompts/`；`npm run check:agents && check:hooks` 绿 |
| H3 | 解析失败 fail-closed | ✅ | rules 缺失/非法 → exit 2（router §4 用例×2）；模型非法 JSON 重试仍败 → exit 2（ai-review §3 用例）；未知判据 id → exit 2（§4 用例） |
| H4 | 黑/白/保护区只在 config | ✅ | 路径模式全在 harness.rules.json；代码 grep 无路径字面量（仅 API 协议路径 `/chat/completions`） |
| H5 | skill 约束 | ✅ | 未改 skill；本次不改判定口径，check:skills 绿 |
| H6 | 新拦截给合法绕过 | ✅ | 新增"拦截"只有退出码：`--dry-run`（0 API）与 `--machine-only`（免模型降级）即合法路径，guides §四 写明 |
| H7 | 新 hook 双 CLI 接线 | ✅（不适用） | 未新增 hook；broker 是独立服务不是 CLI hook |
| H8 | 新配置键有消费者 | ✅ | 未加 harness.config.json 键；harness.rules.json 每个键都有消费者（router/ai-review/broker） |

## 一、改动清单与性质

| 文件 | 性质 | 一句话 |
|---|---|---|
| `harness.rules.json` | 新增（数据） | 审核路由+通知路由的唯一事实源；cli TEMPLATE_FILES 已登记随装传播 |
| `scripts/lib/review-rules.mjs` | 新增 | 规则加载校验+glob 匹配+route()，三入口共读 |
| `scripts/lib/review-checks.mjs` | 新增 | L0 机器判据注册表（3 条），未知 id fail-closed |
| `scripts/review-router.mjs` | 新增 | 变更文件→审核类型，零 LLM |
| `scripts/ai-review.mjs` | 新增 | 模式 B 审核：L0→打包→单发→verdict→计量 |
| `scripts/lib/notify.mjs` | 新增 | 三类飞书卡片渲染+发送（fail-open） |
| `scripts/harness-broker.mjs` | 新增 | 事件桥：GitLab 入/飞书回投，认证 fail-closed |
| `scripts/reviews/{rs,adr,cr}.md` | 新增 | AI 判据清单（与 CR 模板 §0 同源声明） |
| `test/review-router.test.sh` 等 ×3 | 新增 | 56 断言，含 mock 模型/飞书/GitLab 全本地 |
| `scripts/harness-cli.mjs` | 1 行 | TEMPLATE_FILES 加 harness.rules.json |
| `guides/审核与通知自动化.md`、RS | 新增 | 接入文档与需求规格 |

## 二、正确性（对照 RS 验收标准逐条）

| 验收标准 | 结果 |
|---|---|
| US-1：RS-only MR → 仅 rs（+evidence） | ✅ router §1 用例 |
| US-1：纯噪声 → 全跳过 | ✅ §2 trivial 用例 |
| US-1：规则坏 → exit 2 | ✅ §4 用例×2 |
| US-2：坏 RS 无 key → 🔴 exit 1 且 0 API | ✅ ai-review §1 用例 |
| US-2：非法 JSON×2 → exit 2 | ✅ §3 用例 |
| US-2：token 计量入 events.jsonl | ✅ §2 用例（tokens_in=1234 断言） |
| US-2：dry-run 零 API | ✅ §5 用例 |
| US-3：卡片结构/按钮数/value 上下文 | ✅ notify §1 用例×3 |
| US-3：MR webhook→卡片；token 不符 403 | ✅ broker §2/§3 |
| US-3：回调→resolved_by 落账；账实不符 422 | ✅ §5 用例×4 |

## 三、发现的问题与处置

| 级别 | 问题 | 处置 |
|---|---|---|
| 🟡 | package.json（gate 注册）与 .github/workflows/quality-gate.yml（CI 步骤）属考卷区，guard_write 拦截，本批未接线 | **待人放行**：人在 write-allowlist.txt 加两行后即可落（diff 已备好，见任务目录 pending-wiring.md）。测试本身可直接 `bash test/*.test.sh` 跑，不因未注册而失效 |
| 🟡 | broker 决策回投只写 RS 文档 OP 行，blockers 未进 state.json（OP-1 开放问题） | 按设计留正式立项；回投失败显式 422 不盲写 |
| 🟡 | `reviews/cr.md` 与 `templates/CR-代码审查记录.md` §0 语义同源但物理两份，有漂移风险 | 已在 cr.md 头部声明"改动任一侧须同步"；completeness 检查不覆盖此关联，列为已知风险 |
| 🟡 | ai-review 增量缓存的 carried findings 不复核规则变更（rules 改了判据，旧结论仍沿用） | 影响：改判据后需删 `.ai/reviews/.cache-*.json`；guides 未写。可接受，retro 候选 |
| 🔴 | 无 | —— |

## 四、风险与误伤面

- 路由新规则误报时绕过：改 harness.rules.json 的 noise_paths/paths 即可，无需改代码（H6）。
- 模型侧唯一"自由裁量"是 AI 判据 findings，🔴 仅阻断不自动处置——票拟/批红分离，误报成本 = 一次人审。
- broker 未设 secret 时日志提示并继续（内网试点取舍）；公网部署必须设（guides 已写）。

## 五、审查结论

**通过（带 3 项 🟡 待办：两项待人放行接线、一项 retro 候选）。** 56 断言全绿；fail-closed 路径每条都有负向用例；无 🔴。

---

## 六、第二轮复核（外部审查，2026-11-06）

上一节的自审结论是"通过，无 🔴"。二次复核推翻了这个结论：**4 个 P1，其中 2 个直接推翻了 §0 的两行 ✅。**

| # | 问题 | 上一轮怎么记的 | 实测事实 | 处置 |
|---|---|---|---|---|
| P1-1 | 决策回投：只绑 127.0.0.1（指南让人填 `<host>:8788`）、飞书 `url_verification` 回 400、回投入口无鉴权 | §0 H3「认证 fail-closed」/ 风险面「未设 secret 时提示并继续」 | `POST {"type":"url_verification"}` → 400「未知卡片动作」；不带任何凭据的回投直接进 GitLab 写流程，`operator.open_id` 由调用方给 → 可冒用真实 open_id 记成"张三批红" | 加 `HOST`、challenge 回显、`FEISHU_VERIFY_TOKEN`（未配 → 503）。测试 +4 |
| P1-2 | `--machine-only` 在配了 key 的机器上照调模型 | §0 **H6 ✅**「`--machine-only` 即合法绕过」 | 分支顺序把 `canCall` 排在最前：带 key + `--machine-only` → mock 收到 1 次调用 | 判断顺序改为 machineOnly → 机器红 → 全缓存 → 才调；测试 +4 |
| P1-3 | `harness.rules.json` 没进 `package.json` 的 `files`，安装器还 `existsSync` 静默跳过 | 改动清单写「cli TEMPLATE_FILES 已登记随装传播」（1 行，无测试） | `npm pack --dry-run` 不含该文件 → 装出来的项目 init 成功、审核路由**永远 exit 2**；`pending-wiring.md` 的 diff 也漏了这一处 | 补 `files`；缺声明模板文件时 `die`；新增 §46 断言「发出去的包里有没有」 |
| P1-4 | 退休链无时间闸，`retired_on` 是死字段 | 上一批（`5e3b5bf`）刚加的 `RETIRED_STAGE_CHAINS` | 本任务 `created_at=2026-11-06`，走的却是 `2026-11-02` 退休的 `rs→wbs→adr→fs_review`；旧实现判"放行" | 加 `created_at` 时间闸 + 「越过的每一站都具名 defer」判定；红灯先复现（同 state 旧实现放行 / 新实现拦） |

### 复盘的复盘

§0 那张表的形式是问题本身：**每行只写"✅ + 一句我记得我做了"，没有任何一行要求把被检查的事实打印出来。**
H4 写着"路径模式全在 rules、代码无路径字面量"，而 `scripts/lib/review-rules.mjs:80` 就硬编码了
`'**/*.java' … '**/*.js'`（且漏 `.mjs/.cjs/.sh`）——一条 `grep` 就能证伪，但"逐条核"没有逼你跑那条 grep。

所以 §0 的判据改成：**每行给可复现命令 + 输出摘要**，没有命令的 ✅ 按未核处理。
这条同样适用于 CR 模板（`templates/CR-代码审查记录.md`），已列为本轮遗留。

---

## 七、第三轮：飞书长连接入站（2026-11-06，T7）

场景从"公网 broker"换成"纯内网"：出站推卡片一直通，入站（飞书 → broker）缺一条路，
按钮点选永远回不来。长连接由 broker 主动出站建 WS 解决。审查对象是这一段的三个新文件
（`lib/feishu-frame.mjs`、`lib/ws-client.mjs`、`feishu-ws.mjs`）与 broker 的接线。

| # | 问题 | 判据 | 处置 |
|---|---|---|---|
| P1-5 | 去重占位"收到就记"：第一次因 GitLab 5xx 失败、应答 500 请网关重投，重投却被自己当重复丢掉并回 200 | 假网关第一次写 OP-3 直接 500，看仓库有没有那一行 | `createDeduper` 拆成 `seen`/`forget`；处理失败撤回占位。测试「GitLab 抖过一次的事件重投后落账」= 1 |
| P1-6 | 回投失败一律 422：GitLab 抖动与"账实不符"共用一个状态码，前者本该重试却让飞书停止重投 | 对同一个 5xx 分别看应答码与账本 `retryable` | `PermanentError` 区分：可重试 → 502（长连接应答 500），账实不符 → 422 + toast |
| P2-7 | 重连放弃后进程仍活着、`/healthz` 照回 `{ok:true}`——入站死了没人看得见 | `curl /healthz` 看能不能读出 `feishu.connected` | healthz 带上 `mode/connected/events/duplicates/failures/lastError`；http 模式不谎报 ws |
| P2-8 | 测试自身有三处"红得不对"：`"event"` 写成 `"type"`、ack 的 data 是 base64 却直接字符串匹配、http 模式连接数写死 1 | 解 base64 后再断言、连接数取运行前的实测值 | 加 `ack_json` 辅助按协议解码；连接数改成前后对比 |

### 又一条"通过但原因是错的"

假 GitLab 的 5xx 触发条件最初写成 `content.includes('OP-3 |')`。PUT 的是**整篇文档**，
content 里永远有 `| OP-3 |` 这行——于是第一次任意写入（OP-1）就被打成 500，测试因为
"OP-1 恰好重投成功"而全绿，「OP-3 抖过一次」这条断言则在没抖的情况下通过。
改成按 `commit_message`（这次动的是哪一行）判定后才真正打在第一枪上。

同型的三处断言错误（事件字段名、base64、写死连接数）说明一件事：**断言写错时，
红灯和绿灯都不携带信息。** 所以每条负向用例都要问一句"它在什么情况下会红"，
答不上来就等于没有这条用例。

证据：`.ai/verify/T7.log`（`bash test/feishu-ws.test.sh`，43 断言）、`V1.log`（全链 gate）。

---

## 八、第四轮：方案 D —— 决策走 git（2026-11-06，T8）

长连接只是"让入站边存在"的一种办法。这一轮问的是更前面的问题：**这条边能不能不要。**
答案是可以——把批红动作从"点卡片按钮"换成"改 RS 文档并提交"，broker 从 push 事件的 diff 里读，
就只用得到「GitLab → broker」这一条内网天然可达的边，飞书侧连回调都不用配。

| # | 问题 | 判据 | 处置 |
|---|---|---|---|
| P1-7 | 卡片 `{k:'open', url}` 只是 value，**没有 url 字段**：没配回调时按钮点不动；配了也被 `k !== 'decision'` 打回 400。"去处理"一直是死按钮 | 渲染 MR 卡，看 `actions[0].url` 是否为空 | `btn()` 支持第四个参数直出 `url`；断言 `actions[0].url === mr.url` |
| P1-8 | link 模式下若照搬"每个选项一个按钮"，N 个按钮全跳同一页——人以为点了 A 就批了 A | 渲染 link 卡看按钮数与 value.k | 只放一个「去 GitLab 裁决」，选项列在正文；`value.k='guide'` 而非 `'decision'` |
| P2-9 | push 拿到的是 `commits[].added/modified`，**不含 diff 内容**，必须再调 `/repository/commits/:sha/diff` | 只按 payload 解析会一条都读不出 | `handleGitDecisions` 逐 commit 取 diff；读不到记 `decision_landed_failed`，不当成"没有决策" |
| P2-10 | 身份取 `body.user_name` 会被合并者覆盖（MR 合并进 main 时 push 的 user 是合并者，不是改文档的人） | 用 `commit.author` 才对得上"谁改的这行" | 优 `c.author.name/email`，回落到顶层 `user_*` |

### 一条假绿：负向用例被"后者覆盖"救活了

「作废的旧结论（`-` 行）不被采纳」这条，第一版用的是 OP-9 的**改判**场景：

```diff
-| OP-9 | 改判 | 已裁决：Z |
+| OP-9 | 改判 | 已裁决：Y |
```

把解析器故意改成"也认 `-` 行"做变异测试——**测试依然全绿**。原因是 `-` 行解析出 OP-9=Z 之后，
紧跟的 `+` 行解析出 OP-9=Y，Map 按 blocker_id「后者覆盖」，缺陷被自己掩盖了。

真正会暴露它的是**孤立删除行**：整行删掉、没有对应的 `+` 行。

```diff
@@ -12,1 +12,0 @@
-| OP-8 | 这一行被整行删掉了 | 已裁决：W |
```

换成这个用例后，变异立刻变红。结论：**去重/覆盖逻辑会把"多认了一种输入"的缺陷藏起来**，
负向用例必须设计成"缺陷出现后没有任何东西能覆盖它"。同批还变异验证了名单校验、幂等键、
默认分支过滤三处，每一处去掉都能红。

### 不做的事

- **没有让 link 模式发"N 张卡"**：一个 OP 一张卡看着更精细，但那等于把 RS 的表格结构抄进飞书，
  两份数据迟早不一致。
- **没有让 broker 在这条路上写仓库**：commit 本身就是账。写了反而多一条"回投失败"的路径要处理。
- **没有做 `approvers` 的角色化**（技术负责人只能批 tech 类）：那需要把 role→OP 的映射也维护起来，
  而 GitLab 的分支保护已经承担了第一道闸，先不做，等真有越权批红再补。

证据：`.ai/verify/T8.log`（`bash test/notify-broker.test.sh`，43 断言）、`V1.log`（全链 gate）。
