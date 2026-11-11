# deferred-fixes 清账（2026-11-11）

> 任务：`.ai/tasks/deferred-fixes/state.json`（M 档 change，related gate-channel-fix）。
> 范围：架构审核显式搁置的七项一次性清完。授权：用户会话指令。

## 七项清单与落法

| # | 项 | 落法 | 证据 |
|---|---|---|---|
| P1-② | retro 落盘机器判 | `checkRetroLanding()`：done 任务必须有 `artifacts.retro`（须在 retro/ 下且存在）或 `retro/<slug>*.md` 兜底；abandoned 豁免、`gates.retroCheckFromDate` 之前不追溯；接进 guard_state / ci-verify / resume 三处 | test:retro 9 断言 |
| P1-③后半 | verify 日志绑 commit | verify-run.sh 头部第 5 行 `# commit: <HEAD>`；两侧口径校验它是当前 HEAD 的**祖先**（跨线/被丢弃分支的证据不再能冒充）；旧日志无此行不追溯 | evidence 17b 三向（当前 HEAD 过/侧分支拦/旧日志放） |
| P2-① | S 档收尾合并 | `review → done` 对 S 档成为合法直达（2026-11-12 起新任务）；代价折进 done 出口：必须有一条 `cmd 含 npm run gate` 的绿日志 + retro 落盘（P1-② 判据）。折叠≠免检 | hooks 41 节三向 |
| P2-① | 三次打回降档 | resume 统计同阶段 gate=fail 次数；第 3 次起提示出口，`--ack-strikes <人>` 具名放行，waived_by 记进 stage_history；blocker/校验/收尾拦截一律不降档 | harness-cli 50 节四断言 |
| P2-②a | harness-cli 拆分 | 1938 行单文件 → 113 行入口 + `scripts/lib/cli/` 11 个域模块，行为零差异（223/0 前后一致） | test:harness-cli |
| P2-②b | broker 幂等 | 落账键 `(event_id, action)`；索引文件 `$HARNESS_LEDGER_DIR/broker-seen-keys.txt` 启动扫回、append 落盘、超窗压实；**先记账后记键**（防账本写失败被吞）；fail-open | notify-broker §10 16 断言 |
| P2-②c | ai-review 缓存键 | 缓存名 `.cache-<type>-<sha256(rules+清单)前12>`，规则一变自动失效 | ai-review §5b 7 断言 |
| P3-⑤ | runtime 回写 | `harness runtime <项目> --spawn_agents yes --shell yes --ask_user yes`：值域校验、键白名单、已知结论不许静默退回 unknown（--reset 显式重置需记名） | harness-cli 49 节 |

`npm run gate` 全量绿（DFG.log，24 套件，含新增 test:retro）。

## 值得留下的三条

1. **折叠判据要跟着出口走**。S 档合并 ci/retro 阶段不是"少走两站"，而是把两站的判据
   （gate 日志、retro 落盘）搬进 done 出口——不然每次流程减重都会变成一次免检。
2. **降档必须具名**。三次打回后机械拦截只剩副作用（教人绕过），但放行要
   `--ack-strikes <人>` 记进 stage_history——降档是人的判断，工具只负责留痕。
3. **并发分工按文件集**。本轮三个机械项（拆分/幂等/缓存）派子代理并行、判据类由主线
   串行，唯一冲突点（拆分重写覆盖了主线刚接的 resume 接线）在合流时立刻发现并重接——
   上一轮的教训直接变成了本轮的流程。

## 拆分的一个交接坑

子代理重写 harness-cli.mjs 时基于旧版，主线在旧版上的三行接线（checkRetroLanding
import 与调用）被整体覆盖。合流时 rg 一查便知、按新结构重接即可——**多人/多会话
改同一文件，接线类小改动必须在合流时重验**，不能信"谁后提交谁对"。
