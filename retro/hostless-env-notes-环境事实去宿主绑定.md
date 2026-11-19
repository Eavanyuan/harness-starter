# hostless-env-notes：环境事实从宿主 prompt 下沉到配置（2026-11-19）

> 任务：`.ai/tasks/hostless-env-notes/state.json`（S 档 change，change_tier=2，related=ci-fail-trigger，baseline=929939d）。
> 触发：用户问"harness 放到没有 zcode/autoclaw 的机器上能否跑"——审计发现 gap 3：
> mvn 路径/skipTests 坑等环境事实写在 AutoClaw 定时任务 prompt 里（宿主绑定，换机器即丢）。

## 改动

| 层 | 改什么 |
|---|---|
| 配置 | `runtime.headless.envNotes: string[]`（5 条：mvn 绝对路径 / skipTests 双属性 / 指定测试类命令 / 前端 e2e / 降级语义） |
| 打包器 | session-pack 四剖面（A/B/CI/Rn）渲染「本机构建/复现环境事实」节；未配置不渲染（向后兼容） |
| runner | task-loop.mjs 读 headless.envNotes 传给三个 builder |
| 宿主 | AutoClaw 执行器 prompt rev5：删硬编码事实，改为"工单里的环境事实节是唯一事实源" |

## 原则沉淀

- **机器属性跟配置走，不跟宿主走**：构建环境（工具路径、属性名坑）是部署属性，归属 harness.rules.json；
  宿主 prompt（AutoClaw/任何 CLI）只做流程编排 + 指向配置——换宿主/换机器零改动。
- 坑 #50 的完整解法分两半：症状解（绝对路径写进 prompt）昨天已做，根因解（配置单源）本轮完成。
- 工单是宿主无关协议的载体：pack-*.md 谁来读都行（AutoClaw 会话/claude -p/人）——环境事实进 pack 等于进了所有宿主。

## 验证
task-loop 128/128（新 envNotes 正反例进 §8）；contract + doctor 过；四剖面渲染手动核过。
