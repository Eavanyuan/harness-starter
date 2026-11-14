# poll-config：任务轮询节拍可配置（2026-11-14）

> 任务：`.ai/tasks/poll-config/state.json`（S 档 feature）。
> 需求来源：用户会话指令——"任务轮询的时间改成可配置的方案"。

## 方案（心跳与节拍分离）

原来只有 install 时 `--interval`（默认 180s），渲染进 launchd/systemd 单元——**改一次
节拍要重装一次定时器**。现在拆成两层：

| 层 | 谁定 | 改动方式 |
|---|---|---|
| 心跳上限 | OS 定时器（`--interval`，模板渲染 StartInterval/OnUnitActiveSec） | 重装（很少动） |
| **真实节拍** | `harness.rules.json` 的 `runtime.taskLoop.pollSeconds`（env `TASK_LOOP_INTERVAL` 临时覆盖） | **改配置即生效，下一拍采纳** |

- 定时器模板注入 `HARNESS_TIMER=1`，节流只对它生效；手动 `--once` 是"我现在就要跑"，
  不受限——排障时不会被自己的节拍挡住。
- 节流戳 `.ai/locks/task-loop.last-run` 在**轮次成功后**才落盘：中途崩溃则下一心跳
  立即重试，失败不会被节拍吞掉（与"门禁坏不等于放行"同一哲学）。
- 默认 180s；配置缺失或非法回退默认，不猜。

## 验证

test:task-loop 75→86：定时器+新鲜戳节流 / 陈旧戳照跑+戳刷新 / 手动豁免 / env 覆盖
（1s 节拍+sleep 1.2 放行）/ 双模板注入断言；安装脚本 `--print` 冒烟确认 plist 渲染
含 `StartInterval` 与 `HARNESS_TIMER`。doctor 配置键全消费（pollSeconds 有读者）。

## 一条交接说明

已装的旧定时器**不带** HARNESS_TIMER=1 → 节流对其不生效（等价旧行为，心跳即节拍），
要吃到新节拍语义需 `install-task-loop.sh` 重装一次（之后改节拍就不用再动了）。
