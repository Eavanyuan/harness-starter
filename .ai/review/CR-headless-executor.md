# CR - headless-executor（T5 cli 执行器）

> 审查人：code-reviewer（会话隔离：审的是 git diff + 日志，非实现者记忆）
> 范围：de7e40e（配置层）+ b37d576（T5-2/3/4）+ T54 端到端 + 本 CR 前的修正
> 模板：templates/CR-代码审查记录.md §0 硬规则逐条核

## §0 硬规则逐条核

| # | 规则 | 判定 | 证据 |
|---|---|---|---|
| H1 | scripts 改动同批有测试 | ✅ | §2b 6 例 + §2c 9 例 + §2d 4 例，task-loop 150/150 |
| H2 | 生成物未手改 | ✅ | 改的全是源（scripts/、rules、test/）；无 .claude/.zcode 直改 |
| H3 | 解析失败 fail-closed | ✅ | 产物缺失=无效轮（2d 实测 acks/resolves 缺失被拦）；注入失败抛错拒起 |
| 坑50 | 绝对路径 | ✅ | cmd/repoDir 启动闸强制；hook 命令注入时绝对化 |
| D6 | 无 hook 会话拒启 | ✅ | e2e 首跑实测：fixture 无 settings.json → 拒跑并明说 |
| 约束A | harness 文件零进目标仓 | ✅ | 断言 origin 全历史无 settings.json；worktree 在仓外 |
| D4 | 影子缺省 | ✅ | shadow!==false 即影子；2d 断言影子不推 |

## 发现与处置

- 🔴 无阻断项。
- 🟡#1 DRY 未定义（wiring 笔误）：e2e 首跑抓到，已修（opt.dryRun）——端到端测试的存在价值即在此。
- 🟡#2 测试替身 prompt 解析脆（BSD grep 多字节括号）：改环境变量直传，已修。
- 🟡#3 生成物 settings.json 注入的是"存在性"而非"可解析性"：v1 注入不校验 hook 脚本存在（生产 root=harness-starter 时路径有效；旁挂他仓时 hook 脚本路径指向 harness 根，脚本在）。风险低，记录不改。
- 结论：approve。
