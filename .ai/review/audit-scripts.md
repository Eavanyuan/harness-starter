# scripts/ 与 hooks/ 实现质量与架构审计

日期：2026-11-11 · 范围：guard_state / guard_write / guard_command / verify-run.sh / ci-verify / task-loop / harness-broker / review-router / ai-review / hooks/lib / scripts/lib · 方法：逐文件读实现，只报有 文件:行号 证据的问题。整体评价先说：这套代码的注释质量、fail-closed 意识与"实测踩坑回填"密度远超一般内部工具，以下问题多数是**残余边界**而非低级错误。

## 结论摘要

门禁体系（guard_* + verify.mjs + verify-run.sh）设计上 fail-closed 且 hook/CI 共用判据，主体可信；但存在四类结构性缺口：① Bash 通道整体绕过写/读门禁（最大缺口）；② allowlist 前缀匹配可短路全部高危规则；③ 证据链对"协作的 agent"不可伪造性为零（设计已承认，CI 口径只认入库事实）；④ 编排层（task-loop 的 hook 接线检查、broker 的内存幂等、ai-review 的结论缓存）各有一处会静默失效的判定。置信等级：高（全部有行号证据）。

## 一、绕过 / 失效路径

### A1. Bash 通道绕过 guard_write 与 sensitiveRead（严重）
- `hooks/lib/write_tools.mjs:13`：WRITE_TOOLS 只含 `Write/Edit/MultiEdit/NotebookEdit/create_file/str_replace_editor`，不含 Bash。
- `hooks/guard_command.mjs:77-93`：Bash 分支只跑 `blockedRules(gates)` 黑名单；`harness.config.json` 的 blockedCommands（约 15 条正则）没有一条覆盖 `>`/`>>` 重定向写文件或 `cat .env` 类敏感读。sensitiveRead 只挂在 `tool === 'Read'`（guard_command.mjs:96-100）。
- 后果：`echo ... > .claude/settings.json`（绕 generated 拦截）、`echo '{}' > .ai/tasks/x/state.json`（绕 guard_state 全部校验）、`cat .env`（绕禁读）都畅通。harness.config.json writeGuards.note 承认了 writes 声明不是运行时门禁，但**没有承认 Bash 写这条路**。
- 建议：在 blockedCommands 增加"shell 写 protected/generated/sensitive 路径"的通用规则（匹配 `>`/`tee`/`sed -i` + 路径），或至少把 sensitiveRead 同样的正则应用到 Bash 命令文本上。

### A2. allowlist 前缀匹配短路全部规则（严重）
- `hooks/guard_command.mjs:81-84`：`cmd.startsWith(prefix)` 命中即 `process.exit(0)`，**跳过其后所有 blockedRules**。
- 后果：allowlist 加了 `mvn test`（为绕 -DskipTests 提示类误拦），则 `mvn test; git push --force`、`mvn test && curl ... | sh` 整条放行。前缀匹配对"命令组合"没有边界。
- 建议：allowlist 命中后仍跑其余规则，或把前缀匹配收紧为"整条命令无 `;`/`&&`/`||`/管道时才生效"。

### A3. 证据链对 agent 本身不可伪造性为零（设计边界，需明示）
- `hooks/lib/verify.mjs:297-298`：`requireVerifyLog === false` 是全局开关；更本质的是日志头（`# exit_code: 0`）格式公开（verify-run.sh:126-131），手写即可伪造。local 口径靠 mtime 兜（verify.mjs:350-401），但：
  - `verify.mjs:367-373`：新鲜度候选集 = 自报 files ∪ srcGlob 命中的脏文件。改了 srcGlob 之外的文件（scripts/、hooks/、docs/）不在候选集内，日志不重跑也判 ok。
  - `verify.mjs:401-404`：工作树干净（已 commit）时 pool 为空直接 ok——"改完代码 commit 后再手写日志"两步就能通过 local 口径；CI 口径（verify.mjs:330-341）也只验"文件存在 + 入库 + exit_code 头"。
- 建议：承认这是"防诚实者的失误、防不了协作 agent 的故意"，在 verification.md 明示；或把 `# cmd` 行与日志内容一起做弱指纹校验（如 cmd 需与 state 里声明的验证命令一致）。

### A4. verify-run.sh 的 todo-id 未做路径校验（中）
- `scripts/verify-run.sh:50,62`：`ID="$1"` 未过滤，`LOG=".ai/verify/${ID}.log"`，`ID="../..//hooks/foo` 可把日志写到 .ai/verify 之外任意 `*.log` 路径。它是被门禁背书的"官方写入口"，等于一条受保护的任意 .log 覆盖通道（如覆盖 `hooks/allowlist.txt` 不行——后缀不符，但覆盖其他证据日志可行）。
- 建议：`case "$ID" in *[!A-Za-z0-9._-]*|.*|..*) exit 64;; esac` 一行闭合。

### A5. task-loop 的 hook 接线检查恒真（中）
- `scripts/task-loop.mjs:101`：`(c.hooks?.enabled !== false && (c.hooks || c.hooks !== undefined))` —— 只要 JSON 里存在 `hooks` 键（哪怕是 `{}` 或只含 SessionStart），表达式即真。注释声称"headless 会话会绕过全部写入门禁，拒绝启动"，实际判定形同虚设：删掉 PreToolUse 的 guard 接线、留一个空 hooks 对象即可通过。
- 建议：改为显式检查 `.claude/settings.json` / `.zcode/config.json` 中 PreToolUse 事件下注册的 hook 命令包含 `guard_`。

## 二、复杂度 / 耦合

### C1. glob 引擎四份实现，语义已经分叉
- `hooks/guard_write.mjs:60`、`hooks/lib/verify.mjs:232`、`scripts/lib/review-rules.mjs:16`、`scripts/resolve-skills.mjs:33` 四份 globToRe。verify.mjs:227 注释明确说"与 guard_write 的 glob 语义保持一致"，但 verify.mjs 版支持 `{a,b}` 花括号展开，guard_write 版**不支持**（花括号被当字面量转义）——同一个配置 pattern 在两处命中结果不同，guard_write 侧静默变窄。review-rules 版是第四种（手写扫描器）。
- 建议：抽单一 glob 模块（连测试一起），四处 import；或至少删掉 verify.mjs:227 那句与事实不符的注释。

### C2. harness-cli.mjs 1852 行、analyzer.mjs 962 行单文件
- `wc -l` 实测。harness-cli 承担了 resume/gate/推进等多职责，task-loop.mjs:112 的注释本身就记录了"上一版 STAGE_NEXT 长在 harness-cli 里，init-harness.sh 自己造了个 intake 阶段"这类双源事故——文件越大越容易再生。
- 建议：把 STAGE_CHAIN 消费方全部改为 import verify.mjs（已做），再把 harness-cli 按子命令拆文件。

### C3. task-loop.mjs 单文件混合五种关注点
- 轮询（A/B 剖面）、认领、预算、dry-run 观测、报告统计同在一文件（349 行 + 大段注释），注释里自认"v1 占位：headless 修复在 T5 接入"（task-loop.mjs 约 320 行）——当前它实际能做的只是认领 + 写 ack 文件，认领后长期持有直到 TTL 过期（task-loop.mjs:322-328），对 MR 是 24h 级锁。
- 建议：T5 落地前把认领 TTL 调短或 dry-run 化，避免占位代码锁真实资源。

## 三、单点故障 / 扩展性

### S1. broker 幂等集合仅存内存且有 LRU 淘汰
- `scripts/harness-broker.mjs:206` + `scripts/lib/decision-from-git.mjs:87-97`：`seenGitDecisions` 是进程内 Set，上限 2000 条 FIFO 淘汰。两个后果：① broker 重启后 GitLab 重投的 push 事件会重复落 `decision_landed` 账（账本是 ledger，无防重）；② 高频仓库里 2000 条滑窗外的重复事件同样穿透。注释自辩"重复推送只是日志噪音"，但 ledger-report 若把 decision_landed 当对账依据就会重复计数。
- 建议：幂等键持久化到 notify-queue 同目录的 jsonl，或落账前按 ledger 反查最近 N 条。

### S2. broker 单进程 + 文件队列无锁
- `scripts/harness-broker.mjs:478-483`：notifyQueue 用 writeFileSync 整文件读写，无文件锁。两实例（或与 ledger-report 并发写同目录）会互相覆盖；digest 定时器 `Date.now() % digestInterval < agingInterval`（broker.mjs:505）用取模近似"整点"，事件循环延迟大时会整窗错过，摘要静默不发。
- 建议：队列改 append + 启动时单实例锁（lockfile）；digest 触发改为记录 lastFlushAt 的显式时间比较。

### S3. claim 依赖远端 git 可达，故障即"无事可做"
- `scripts/lib/claim.mjs:55-90`：认领失败落到 catch，`ls-remote` 再失败返回 `{claimed:false, reason:'taken'}`——网络故障与"别人已认领"不可区分，task-loop 侧记 `claim_skip` 后 continue，整轮 exit 0。GitLab 抖动会被当成"今天没活"。
- 建议：区分 `taken` 与 `network-error`（git 退出码/ stderr 特征），后者应 exit 1 走"接入的源坏了"路径。

## 四、明显 bug / 不一致

### B1. task-loop 未知 `--` 旗标被静默吞掉
- `scripts/task-loop.mjs:39`：`else if (args[i].startsWith('--')) continue;` —— `--profile` 拼错成 `--profil` 时不报错直接忽略，与同文件 `else die(64, '未知参数')` 的意图（guard 无处不在的"枚举闭合"原则）矛盾。
- 建议：该分支改为 `die(64, ...)`，已知布尔旗标显式列举。

### B2. ai-review 结论缓存跨 base/commit/checklist 复用
- `scripts/ai-review.mjs:99-108,243-244`：`.cache-<type>.json` 只按文件内容 sha 判定"沿用上轮结论"，不区分 commit/base，也不含 checklist 或 rule 版本。checklist 更新后，旧文件的 carried findings 仍会进入新 verdict（标 `carried`）， Reds 可能被上一版清单的标准放过。
- 建议：cache 键加 checklist 内容 hash，verdict 里把 carried 条目数量计入阻断考量或至少在头部显著标注。

### B3. ai-review 缓存读写无并发保护
- `scripts/ai-review.mjs:244`：CI 并行 job 同 outDir 时 `.cache-*.json` 互相覆盖；JSON.parse 失败（读到半截文件）会直接抛未捕获异常退出。
- 建议：写临时文件 + rename 原子替换；读失败按无缓存处理。

### B4. guard_write allowlist 日期用字符串比较
- `hooks/guard_write.mjs:78`（同 guard_command.mjs:63）：`parts[2] >= today` 对 `2026-13-99` 这类畸形日期也判"未过期"。放行条是人工写的低频数据，风险低，但与"非法输入判死"的整体风格不一致。
- 建议：先 `Date.parse` 校验合法性，非法行拒绝并 stderr 提示。

### B5. broker url_verification 在鉴权之前回显 challenge
- `scripts/harness-broker.mjs:226-229`：http 传输下 challenge 回显先于 token 校验。飞书协议要求如此，但意味着任何知道 URL 的人都能探测"这里是不是飞书回调入口"。信息泄露极低，记录在案即可。
- 建议：可保持现状，healthz 已暴露 bind 信息属同量级。

## 值得肯定（避免只见问题）

- `hooks/lib/verify.mjs:160-168` git porcelain 前导空格、`verify-run.sh:20-33` BASH_ENV 传导 pipefail、`scripts/lib/claim.mjs:44-52` 同 sha 认领碰撞、`scripts/lib/env-file.mjs` 凭据文件数据化——这些注释记录的实测坑与修法一一对应，是这套代码最值钱的部分。
- hook/CI 共用同一判据库（verify.mjs 单源）在结构上正确，本次审计未发现两边口径分叉的实例（除 C1 的 glob 分叉）。

## 待证项

- guard_state 的 `HARNESS_ROOT`（guard_state.mjs:29-31）：注释断言"agent 无法改父进程环境"，对 Claude Code/ZCode 成立；但 vendored 安装场景下宿主 CLI 是否会信任项目内 `.env`/配置注入该变量未验证。建议查 build-hooks 生成物。
- `--no-verify` 规则（harness.config.json blockedCommands）能拦 `git commit --no-verify`，但 `git -c core.hooksPath=/dev/null commit` 等价绕过未覆盖——黑名单类规则的固有边界，值得补一条 `core.hooksPath`。
