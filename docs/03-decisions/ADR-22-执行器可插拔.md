# ADR-T5 执行器接口：可插拔（autoclaw 缺省 / cli 事件驱动）

> 任务：`.ai/tasks/headless-executor/state.json` · 2026-11-19
> 状态：已定（用户指令 2026-11-19："执行器可以指定，本地默认用 autoclaw 的执行器来跑"）

## D1 执行器是配置项不是代码路径

**决定**：`runtime.headless.executor.kind ∈ {autoclaw, cli}`，缺省 `autoclaw`。

**理由**：
- 执行器本质是"谁把工单变成修复动作"的**宿主决策**——有 AutoClaw 的机器用替身轮询（零开发成本、有通知代价）；任何机器都可用 cli（spawn 本地 CLI，零通知、事件驱动）。
- runner 不写死任何一种：`autoclaw` = 现状（落工单即止，宿主定时器来取）；`cli` = runner 全责（worktree + spawn + 验收 + 预算）。
- fail-closed：未知 kind → die(1)，不静默回退（静默回退=配置写了不生效，doctor §4 空转键同罪）。

**代价**：两套执行路径都要测。缓解：autoclaw 路径=现状零改动（回归即可）；cli 路径全部新测试。

## D2 cli 的 cmd 必须绝对路径

**决定**：`cli.cmd` 校验必须以 `/` 开头且文件存在，否则 die(1)。

**理由**：launchd/沙箱 PATH 不含 /opt/homebrew/bin（坑 #50 实测：mvn 误判"未安装"同根因）。runner 由 launchd 起，`claude` 裸命令名必然找不到。

## D3 约束 A × D6 的调和：hook 配置以未跟踪文件注入 worktree

**决定**：cli 模式建 worktree 后，runner 渲染 `.claude/settings.json`（hooks 形态）写入 worktree 根——**未跟踪、永不 git add**；会话结束随 worktree 删除。

**理由**：
- D6 红线：无 hook 的会话绕过全部写入门禁，拒绝启动。
- 约束 A：harness 文件绝不进 TDasset git 历史。
- 两者表面冲突，实则不然：约束 A 管的是 **git 历史**（提交内容），不是工作目录里的临时未跟踪文件。会话提交规则本就"只 add 显式文件清单"（执行器约束 4/替身协议同款），settings.json 永不进清单。
- 替代方案被否：a) TDasset 仓提交 hook 配置——违反约束 A；b) 允许无 hook 会话——违反 D6；c) 只在 harness 自身仓用 cli——丧失 TDasset 修复能力。

**代价**：每次会话渲染一次配置（幂等，成本低）；CI/远端零感知。

## D4 cli 上线走影子准入

**决定**：`executor.cli.shadow` 先 true：产出修复但不推远端，round 报告标记影子轮；≥ `shadowRoundsMin`（默认 5）且人工批准后切 false 放开推送。

**理由**：D2（部署纪律）同律——未校准的自动化直接写远端分支的风险与 task-loop 真跑完全相同，影子先验证会话产物质量（修复是否只含代码+测试、基线同款是否被碰、证据链是否齐）。

## D5 本机当前配置

```json
"executor": { "kind": "autoclaw" }   // 用户指令 2026-11-19：本地默认 AutoClaw 执行器
```

AutoClaw 定时会话（537d776a…，rev 7，已恢复 enabled）继续当宿主替身。**切 cli 的条件**：T5 cli 路径实现完成 + 影子轮达标 + 用户点头——三条件齐才换，换了之后替身可退役（通知问题从根消失）。

## 后果

- 环境事实（envNotes）两种执行器都受益（工单是共同协议）。
- autoclaw 模式的通知代价保留（宿主限制，无法单独关）——这是本机继续用它的已知成本，用户知情选择。
