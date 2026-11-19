# RS-T5 headless 执行器（可插拔：cli / autoclaw）

> 产出：requirement-analyst（本任务）· `docs/01-requirements/22-t5-headless-executor.md`
> 任务：`.ai/tasks/headless-executor/state.json`（M 档 feature，related: task-loop）

## 1 背景与痛点

task-loop 的监控端（launchd runner）已完整：检测触发 → CAS 认领 → CI 归因 → 落工单（pack-*.md）。但**执行端从未接线到 runner**——T5 的"认领后起无头会话"停留在设计，实际用 AutoClaw 定时会话轮询工单当替身（2026-11-17，因当时本机无任何 agent CLI）。

代价：
- **响应延迟**：替身每 30 分钟一拍，CI 红后最坏等 30 分钟才开工；事件驱动应为认领即修。
- **宿主耦合**：AutoClaw 会话每次运行推客户端通知（无法单独关闭），且替身逻辑在宿主 prompt 里（环境事实已下沉 envNotes，但执行编排仍宿主绑定）。
- **前提已变**：`/opt/homebrew/bin/claude` 已安装（2026-11-19 核实）——runner 直接 spawn CLI 的原始设计现在可行。

## 2 用户故事

### US-1 执行器可插拔

- **作为**：harness 部署者
- **我希望**：在 harness.rules.json 里指定执行器类型（`autoclaw` / `cli`）
- **以便**：同一套 runner 在不同宿主环境（有/无 AutoClaw、要/不要通知）下复用，不换代码只换配置

**验收标准**
- Given `runtime.headless.executor.kind="autoclaw"` When runner 认领并落工单 Then 不 spawn 任何本地进程（替身轮询模式，行为与现状完全一致）
- Given `executor.kind="cli"` When runner 认领 Then runner 在独立 worktree 起 `<cli.cmd> <cli.args>` 无头会话，工单全文作为输入
- Given `executor.kind="cli"` 且 `cli.cmd` 配了相对路径 When runner 启动 Then die(1)（坑 #50：沙箱 PATH 不可假设，必须绝对路径）
- Given `executor.kind` 非法值（如 `"zcode"` 未实现）When runner 启动 Then die(1) 报"可用值 autoclaw|cli"（fail-closed，不静默回退）
- Given 未配置 executor When runner 启动 Then 按 `kind="autoclaw"`（缺省=现状，已有部署零迁移）

### US-2 cli 执行器：认领即修，零客户端通知

- **作为**：被 30 分钟通知轰炸的用户
- **我希望**：runner 自己 spawn 的 headless 会话不经过任何客户端
- **以便**：通知噪音从根上消失，同时修复响应降到认领即起

**验收标准**
- Given executor=cli 且有 working 工单 When runner 起会话 Then 会话工作目录=独立 worktree（`tl-<id>` 前缀，用后清理），工单 pack 全文喂给 CLI
- Given 会话结束 When runner 验收 Then `readSessionArtifacts` 校验产物（todo.json/acks.json/resolves.json/round-N.md），缺件=本轮无效（fail-closed，消耗预算轮次）
- Given 会话 exit 非零或超 `executor.timeoutMs` When runner 处理 Then 记失败轮次 + 保留 worktree 现场（不静默重试）
- Given 轮次超 `budget.maxRounds` When runner 判定 Then 升级 needs_human（复用现有预算机制，不另起一套）

### US-3 约束 A × 写入门禁的调和

- **作为**：TDasset 仓的守门人（约束 A：harness 文件不入 TDasset git）
- **我希望**：cli 会话在 TDasset worktree 里受 hook 写入门禁约束，但 worktree 里不出现任何会被提交的 harness 文件
- **以便**：无门禁的会话 = 绕过全部写入门禁（ADR D6 红线）与 harness 文件绝不进 TDasset 仓两条约束同时成立

**验收标准**
- Given executor=cli When runner 建 worktree Then runner 把渲染好的 hook 配置（.claude/settings.json 形态）以**未跟踪文件**放进 worktree——绝不经 git add/commit 进入 TDasset 历史（会话提交规则本就只 add 显式文件清单）
- Given worktree 注入的 hook 配置 When 会话结束清理 Then 随 worktree 一并删除，TDasset 主仓与远端零残留
- Given 注入失败（渲染/写入）When runner 起会话 Then die(1)——宁可不起，不裸奔（D6）

### US-4 影子准入（cli 执行器上线闸）

- **作为**：不想被未校准自动化写坏分支的人
- **我希望**：cli 执行器先以影子模式跑 N 轮（产出修复但只落 worktree/报告，不推远端）
- **以便**：验证会话产物质量后再放开推送（D2 同律：影子周先于真跑）

**验收标准**
- Given `executor.shadow=true` When 会话产出修复 Then 不推远端，round 报告标记"影子轮"，人工抽查
- Given 影子轮 ≥ N（配置，默认 5）且人工批准 When 切换 shadow=false Then 才允许推送
- Given 影子期间触发升级条件 Then 与真跑同语义（预算/needs_human 不因影子而豁免）

## 3 核心需求

1. `runtime.headless.executor` 配置节：`{ kind: "autoclaw"|"cli", cli?: { cmd(绝对路径), args, timeoutMs, shadow }, shadowRoundsMin }`；缺省 kind=autoclaw（现状）。
2. runner 认领路径分叉：autoclaw=只落工单（现状）；cli=worktree + spawn + 产物验收 + 预算。
3. 本机配置落 `kind="autoclaw"`（用户指令 2026-11-19：本地默认用 AutoClaw 执行器跑）。
4. doctor：executor 节校验（kind 合法、cli 时 cmd 绝对路径存在、autoclaw 时提示替身依赖宿主定时器）。
5. 测试：配置分叉各分支、产物验收 fail-closed、影子不推送、hook 注入零 git 残留。

## 4 非目标

- 不动 AutoClaw 替身的既有编排（它继续按 30 分钟轮询工单，作为 autoclaw 执行器的宿主实现）。
- 不实现 AutoClaw 之外的"通知型"执行器（im 推送等）——只做 cli/autoclaw 两种。
- 不改监控端节拍/认领/CAS（本任务只动执行侧）。
