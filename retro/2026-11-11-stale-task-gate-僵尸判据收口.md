# stale-task-gate 收口（2026-11-11）

> 任务：`.ai/tasks/stale-task-gate/state.json`（僵尸任务判据 + abandon 命令）。
> 本文档由合入会话补写（该批会话未留 retro），内容据其代码、测试与实跑证据整理。

## 判据变更

- doctor 停滞判据从"提醒"升为**阻塞**：`gates.staleTaskDays`（默认 3 天）内有 git 提交
  或未提交改动的任务算活跃，超期无任何提交 = 僵尸，报红并给出 resume/abandon 两条出口命令。
- 时钟用 **git 提交时间**（pathActivity），不用 mtime——mtime 是检出顺序不是编辑时间，
  新克隆曾把 14 个历史任务全判"刚改过"。
- `meta.status` 第二条轴（active/abandoned）：abandoned 豁免"必须做完"类判据
  （TODO 收尾、产物登记），不豁免"做过就得有证据"。
- `harness-cli abandon <slug> --reason`：封存必须带 ≥8 字理由、不改 stage（保留
  "死在哪一阶段"的证据）、记录 at_stage 与 open_todos；resume 清单过滤已封存。

## 实收口

harness-builder-hardening（2026-11-01 停在 impl）、harness-doc-gate（2026-11-02 停在 impl）
两条僵尸已按"对账补登记"语义封存，理由与基线在各自 state 的 meta.abandoned。

## 验证

`test/stale-task.test.sh` 16 断言全绿（含 touch mtime 后仍红的时钟证伪、
staleTaskDays 非法值判配置错误不静默失效）；`npm run gate` 全量绿（见 CGR4.log）。
