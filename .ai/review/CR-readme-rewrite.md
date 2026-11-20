# CR - readme-rewrite

## §0 硬规则逐条核
| # | 规则 | 判定 |
|---|---|---|
| H1 | scripts/hooks 改动需同批测试 | ✅ 纯文档，无代码改动 |
| H2 | 生成物未手改 | ✅ 仅 README.md |
| 事实核 | 声称与仓库一致 | ✅ 抽检 7 项（12 agents / executor 两 kind / activeHours / F1-F5 / 50 坑 / maxRounds=3 / verify-run 包装）全部属实 |

## 审查意见
- 🟡 旧版"旁挂模式"细节段并入快速开始三路径，旧版独有信息（代价说明）保留一句——无信息丢失。
- 结论：approve。
