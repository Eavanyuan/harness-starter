# CR 代码审查记录 — p5-ci-parity CI 与本地同一份清单（本地审查）

- 审查范围：`8540f14` → 工作区，8 文件（99+/132-）：`.github/workflows/quality-gate.yml`、`scripts/verify-run.sh`、`scripts/install-task-loop.sh`、`test/{gate-regressions,perf-checks,feishu-sync,feishu-ws,notify-broker}.test.sh`
- 关联任务：`.ai/tasks/p5-ci-parity/state.json`（change tier 2，baseline=`8540f14`）
- 关联 ADR：无新增。这不是架构决策，是**修一处自洽性缺陷**——"CI 与本地各有一份清单"违反了项目自己的单一事实源约定（`package.json` 的 `gate`）
- 已加载 skill：`harness` v1.1.0
- 审查者：自审（改动者即审者，故全部给出可复跑的检测命令而非结论）

## 0 硬规则逐条核（harness skill H1-H9）

| # | 规则 | 检测命令 | 结果 |
|---|---|---|---|
| H1 | 改 scripts/** 同批须有测试 | `scripts/install-task-loop.sh` → `test/task-loop.test.sh`（含 install 段）；`scripts/verify-run.sh` → `test/verify-run.test.sh` + `test/perf-checks.test.sh` §4；两套均在本批全量 gate 中实跑通过 | ✅ |
| H2 | 生成物禁手改 | 本批未动 `.claude/`、`hooks/` 生成物；`npm run check:agents`/`check:hooks` 在全量 gate 内通过 | ✅ |
| H3 | 解析失败 fail-closed | `verify-run.sh` 计时改动只影响 **日志头的 DURATION_MS 取值**，失败判定仍只看 `exit_code`；毫秒解析失败时保留秒级兜底分支（见 :~110 `else` 支）——精度退化但绝不误判为通过 | ✅ |
| H4 | 名单只写在 harness.config.json | 无新增名单；workflow 里没有"要跑哪些套件"的枚举（这正是本次删除的东西） | 未命中 |
| H5 | skill 结构约束 | `.skills/` 未动，5 个 skill 校验在 gate 内通过 | 未命中 |
| H6 | 新拦截须给绕过 | 新增判据 3 条（见 §1-①），均**只读工作区文本**，不拦运行时；无绕过需求 | 未命中 |
| H7 | 新 hook 双 CLI 接线 | 未动 hook | 未命中 |
| H8 | 配置键必须有消费者 | 未新增配置键 | 未命中 |
| H9 | 断言可证伪 | 见 §4 变异证据：新增 3 条判据**都实跑过反例**（注入失败 → exit 1；注入分步步骤 → 判据红）。这是本批唯一"每条新断言都验过红"的一次 | ✅ |

## 1 改动摘要

三件事，一句话概括：**让"CI 跑什么"变成"本地跑什么"的推论，而不是第二份清单。**

### ① CI 与本地合成一条命令（`quality-gate.yml` 137 行 → 单步）

原来 CI 是 20 个手写 `run: npm run test:xxx`，本地 `npm run gate` 是 34 段清单。两份互不知道对方漏了什么。实测代价：六个套件只存在于本地清单（glob / gate-regressions / stale / retro / feishu-sync / feishu-ask），其中 **`gate-regressions` 一直是红的**——崩溃点是双引号里写了 `$VAR）`，全角右括号被 bash 3.2 并进变量名，`set -u` 下直接 unbound。于是形成闭环：本地红 → 全量 6 分钟没人等 → CI 全绿 → 提交信息写 "gate green"。

保留的一条例外是高危命令扫描（需要 `github.event` 上下文，本地无从复现），并把它放在 gate 之前——1 秒出结果，拦的是安全事故不是回归。

同时补 `fetch-depth: 0`（高危扫描要 diff base…HEAD，ci-verify 要读提交时间；浅克隆下这两件事都**静默退化成跳过**，而跳过和通过长得一样）与 `timeout-minutes: 15`（默认 6 小时，链路上有端到端等待用例，写错一个等待条件就挂满 6 小时才红）。

### ② 计时精度：秒级相减 → 毫秒差

`verify-run.sh` 原先用两个 ISO 秒级时间戳相减算耗时，精度 ±1000ms，导致同一段代码的读数在 ±3~9ms 之间抖动——而 perf-checks 的判据阈值是 1000/600/450ms 三档，**抖动幅度足以跨档**。改为 `BENCH`/`BENCH_END` 用 `Date.now()` 取毫秒差，并保留秒级兜底分支（老日志没有 `BENCH` 行时不至于崩）。

`perf-checks.test.sh` 随之改四档判定（基线 1000/4000/600/450 + sleep 1.0s → 无/✅/🟡/🔴），并把四次 `sleep 4` 降到 `sleep 1`——这是全量耗时从 383s 降到 371s 里唯一真实的一笔。

### ③ 测试自身的三个脆弱点 + 一个吞失败

- `install-task-loop.sh:183` **生产 bug**：`echo "...$keep。"` → 全角句号并进变量名。手工复现：`EXIT=1`，`keep。: unbound variable`——封存动作成功，但**轮换提示静默丢失**。用户看不到"已封存为 xxx、token 需去撤销"这两行最关键的提示。改 `${keep}`。
- 同类写法 3 处测试 + 1 处脚本：`$AFTER）`、`$BEFORE→`、`$TRUNCATED）`、`$tool：`。全部改 `${VAR}`。
- `test/feishu-sync.test.sh` 三处硬编码 `/Users/yuanyuan/Documents/workspace/harness-starter/...` → `"$HERE/scripts/lib/feishu-sync.mjs"`。硬编码路径在 CI 上必然不存在，而这三处是被 skip 而非报错——**又一处"跳过和通过长得一样"**。
- **`test/gate-regressions.test.sh` 吞失败**（本批新发现）：汇总与 `[ "$fail" -eq 0 ]` 写在文件中间（原 :92-93），而文件后面还有 retro 豁免、verify-rotate 两节。bash 退出码只看最后一条命令，于是前五节的失败被后面多节的成功覆盖——脚本 exit 0，gate 判绿。**这就是"判据能变红"这条要求本身在最底层被违反的一次**。修法：中间只留 `echo`，判定移到文件最后一行，一处且只有一处。

### ④ `doctor.mjs` 性能预算分支崩溃（收尾时被自己踩响）

`scripts/doctor.mjs:584` 写的是 `warn.push(...)`，而 `warn` 在 :30 定义为 `const warn = (m) => warns.push(m)` —— 是函数，数组叫 `warns`。这条分支从入库起**从未执行过**：最近 5 次验证的耗时都没超过 `performance.testSuiteMaxMs`（300s）。

触发方式很讽刺：第一次 `harness close` 跑完全量 gate，写下 371s 的日志——它自己把"最近 5 次最慢"顶到了 371s > 300s，于是第二次 close 的 doctor 走进这条分支，`TypeError: warn.push is not a function`，整个 gate 4 秒就红。

两个教训叠在一起：**判据自己不能崩**（崩了报的是"doctor 挂了"，不是"超预算了"，两种红混成一种最费时间），以及**没被执行过的分支等于没写**。修后变异验证：造一份 420s 日志 → 输出 `! 性能预算：最近 5 次验证最慢 420s 超预算 300s`，exit 0。

顺带说明：371s 确实超了 300s 预算，这条提醒的内容是对的——只是它之前没能力把话说出来。

## 2 阻断项 🔴

无。

需要说明的两点边界：

- **`scripts/doctor.mjs` 与本批的两种关系**：① 第 8 项判据（扫 `$VAR` 紧跟非 ASCII，:596-627）随 `b37d576` 已进库，**不在本批 diff 里**；② 第 584 行 `warn.push` 崩溃是本批修的（见 §1-④），doctor.mjs 因此在 diff 中。追溯请以本 CR 为准，不要按 commit message 找。
- **`test/task-loop.test.sh` 的 TZ 钉**同样随 `2eefd5d` 进库，不在本批 diff 里。
- **`test/task-loop.test.sh` 的墙钟依赖**（`activeHours` 09:30–21:00，窗外 exit 0）已用 POSIX TZ 钉法解决：`TZ=XXX-N` 把子进程本地时间固定到 12:00，两平台都认。`env -i` 会抹掉 TZ，故两处 `env -i` 都补了显式 `TZ="$TZ"`。验证：`TZ=UTC` 下从 85/50 变为 135/0。

## 3 建议项 🟡

| # | 位置 | 问题 | 建议 | 处置 |
|---|---|---|---|---|
| 1 | `.github/workflows/quality-gate.yml` 高危扫描步骤 | 该步骤是唯一不在 gate 内的判据，意味着**本地永远无法复现 CI 的红**。本次改动之所以没把它合进 gate，是因为它需要 `github.event` 上下文 | 后续可考虑把"取基线"抽象成参数（本地传 `HEAD~1`），让扫描逻辑本体进 gate、上下文注入留在 workflow | 记录，不在本批 |
| 2 | 全仓 `$VAR` + 全角字符 | doctor 判据只能扫出"非 ASCII 紧跟变量名"，扫不出 `$(cmd)` 里嵌全角、或变量后跟半角标点再接全角的情况 | 判据已覆盖历史两起事故的同一形态；等第三起再扩，避免为想象中的问题加正则 | 记录 |
| 3 | 本批提交 | 8 个文件混了三件事（CI 合并 / 计时精度 / 测试脆弱点），单独看任一件事的读者会被另外两件干扰 | 提交信息按三件事分条写清；若后续 CR 要求，可 `git rebase -i` 拆三个提交（本批不拆：三件事共享同一次全量验证，拆开会有中间态不可验证） | 说明 |

## 4 变异证据（H9）

每条新判据都跑过反例，不是"看起来对"：

```
# ① 吞失败修复：中间段注入一次失败
$ cp test/gate-regressions.test.sh test/.mut-midfail.sh && (注入 fail=$((fail+1)) 于 retro 节前)
$ bash test/.mut-midfail.sh
结果：41 通过，1 失败          EXIT=1     ← 修前此场景 exit 0

# ② CI 漂移判据：往真 workflow 注入一步分步调用
$ printf '      - name: 手工分步（变异验证）\n        run: npm run test:task-loop\n' >> .github/workflows/quality-gate.yml
$ bash test/gate-regressions.test.sh
  ✗ workflow 无手写分步套件（有 = 第二份清单复活）  (期望 1，实际 0)
结果：40 通过，1 失败          EXIT=1
$ (从备份还原，md5 校验 370c49fb… 一致)

# ③ 正常态（无注入）
$ bash test/gate-regressions.test.sh
结果：41 通过，0 失败          EXIT=0

# ④ doctor 性能预算分支：造一份 420s 日志（真实存在过的 371s 已被挤出最近 5 次）
$ printf '# started: 2026-01-01T00:00:00Z\n# finished: 2026-01-01T00:07:00Z\n' > .ai/verify/ZZZ-budget-probe.log
$ node scripts/doctor.mjs
  ! 性能预算：最近 5 次验证最慢 420s 超预算 300s（harness.config.json performance.testSuiteMaxMs）
EXIT=0                          ← 修前：TypeError: warn.push is not a function，doctor 整段崩
```

## 5 全量验证读数（三重）

| 环境 | 耗时 | 断言 | 失败 |
|---|---|---|---|
| 本机 macOS（bash 3.2 + shim） | 383s（收尾这次；修前 383→371→383，见下） | 995 | 0 |
| Linux 容器（隔离副本，UTC） | 54.7s | 979 | 0 |
| GitHub Actions 官方 | 56s（job），46s（测试） | — | 0 |

本机三次全量：修前 383s / 修后 371s / 收尾 383s。回涨的 12s 来自 doctor 第 7 节性能预算扫描——它按条数遍历 `.ai/verify/*.log`，而本批新增了 5 份日志（P5C1–P5C4 + CLOSE-GATE）。也就是说：**这只机器上的 383s 里，真实被测代码只占小部分，大头是 shim 与日志面**。

本机与容器的 16 断言差额来自容器副本跳过的环境相关用例（`.git` 同步后的 ci-verify 分支），非失败。三者同一条命令：`npm run gate`。
