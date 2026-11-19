# p5-ci-parity 收尾（2026-11-19）

> 任务：`.ai/tasks/p5-ci-parity/state.json`。CR：`.ai/review/CR-2026-11-19-p5-ci-parity.md`。
> 起点是一句问话："CI 全量跑要 6 分钟，能诊断一下为何需要这么长时间？" —— 答案不在耗时里。

## 做了什么

CI 的 20 个手写步骤换成单步 `npm run gate`，本地与 CI 从此是同一份清单（`package.json` 的 `gate`）。连带修好：计时从秒级相减改毫秒差（±1000ms 抖动 → ±1ms）、`install-task-loop.sh` 的全角句号吞变量名（轮换提示静默丢失的生产 bug）、三处硬编码绝对路径、四个测试的 `$VAR` 写法。详见 CR §1。

## 留下的经验

**1. 三条读数，只有一条能回答"为什么慢"。**
本地 383s、Linux 容器 66.8s、CI 官方 56s。第一反应是"CI 慢"，实际 CI 最快——慢的是本机 shell：`grep`/`cat` 指向 `sandbox-center-runtime-kit/shim/brokered-bin/`，每次调用走 IPC，74ms vs `/usr/bin/grep` 1.9ms（39×）。**关闭沙箱也还是这样**（env 传递），所以"干净 PATH 对照"那次实验数据作废，得在容器里跑才有基准。教训：诊断耗时先确认测量工具本身不在被测路径上。

**2. "两份清单"的代价不是维护成本，是断口被绿灯盖住。**
六个套件只在本地清单里，其中 `gate-regressions` 一直红着。本地红 → 全量 6 分钟没人跑 → CI 全绿 → 提交写 "gate green"。红不是消失了，是执行面断了，断口在 CI 那边看不见。合并成一条命令后，"CI 跑哪些"成为 gate 的推论，加套件只改 `package.json` 一处。

**3. 判据最底层的失效形态：脚本对失败免疫。**
`gate-regressions.test.sh` 的 `[ "$fail" -eq 0 ]` 写在文件中段，后面还有两节。bash 退出码只看最后一条命令 —— 前五节全红也是 exit 0。这条 bug 在"修 CI 清单"的过程里被发现，很讽刺：**我在加判据，而承载判据的脚本自己不判**。以后新增多节测试，判定必须只有一个、且在最后一行。

同一批里还有第二次：`doctor.mjs:584` 的 `warn.push`（`warn` 是函数）。分支从入库起没被执行过，因为最近 5 次验证都没超预算；第一次 close 写下 371s 日志，第二次 close 才把它踩响。**没被执行过的分支等于没写**，而它崩掉时报的是"doctor 挂了"不是"超预算了"——两种红混成一种，查起来最费时间。

**4. 跳过和通过长得一样，是最贵的失败。**
本批碰到三处：浅克隆让高危扫描与 ci-verify 静默退化；硬编码路径让 feishu-sync 三处用例在 CI 上 skip；`activeHours` 窗外让 task-loop 静默 exit 0。判据的形态应该是"要么真跑过，要么红"，没有第三种。

**5. 墙钟依赖要用 TZ 钉，不能用时间窗放宽。**
`runtime.taskLoop.activeHours` 09:30–21:00，runner 在窗外 exit 0，UTC 上午必红。先试过把窗口放宽到 -60/+180 分钟——第 10 段就过期了，而且 `2b`/`3b` 各复制了一份真实 rules，改一处管不住。正解是 `TZ=XXX-N`（POSIX 写法，两平台都认）把子进程本地时间固定到 12:00；注意 `env -i` 会抹掉 `TZ`，两处都要显式传。

## 验证

本机全量 383s / 995 断言 / 0 失败（修前 383s，中途 371s，收尾回涨 12s——doctor 性能预算按条遍历 `.ai/verify/*.log`，本批多了 5 份）；容器 54.7s / 979 / 0；CI 56s。三条都跑 `npm run gate`。新增判据全部验过反例（CR §4）。证据：`.ai/verify/{P5C1,P5C2,P5C3,P5C4,CLOSE-GATE-p5-ci-parity}.log`。
