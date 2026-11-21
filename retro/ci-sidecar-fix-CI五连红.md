# CI 五连红根因链（2026-11-21，run 40-50 → run 51 绿）

> 任务 ci-sidecar-fix（S 档 bugfix）。用户报告：GitHub 最近提交的 Actions 全失败。

## 根因清单（四层，逐层剥）

| # | 根因 | 层 | 修法 |
|---|---|---|---|
| 1 | close 生成的 retro 文件未提交（本地磁盘在=本地绿，CI 只认 git） | 流程 | 补提交；体检观察项升级为根因 |
| 2 | ci-verify 对旁挂任务的仓外声明文件判"不存在=红"（约束 A 决定目标仓代码永不进本仓） | 设计缺口 | 边界守卫：仓外降提示，仓内照硬判 |
| 3 | 测试用 /opt/homebrew/bin/claude 当"合法绝对路径"（CI 不存在→die 落错检查点） | 可移植性 | /bin/echo |
| 4 | §2d fixture 依赖 init.defaultBranch（本机 main、CI master）→ worktree 起点不存在 | 可移植性 | 显式 checkout -b main |

## 诊断方法论（无日志权限时的三层信道）

1. jobs API 每步结论（免认证）→ gate 拆 8 步定位红组
2. check-runs annotations API（免认证）→ 失败时 ::error:: 吐断言行
3. 本地新鲜克隆 + 分离 HEAD 复刻 CI 形态（排除法）
教训：**日志=admin 权限时，把诊断信息发到免权限信道**——步骤名和注解都是可用的比特信道。

## 假红与真红
- 假红：gate-regressions"单步 gate 存在"断言被诊断模式自己打红——诊断脚手架必须可退场
- 真红之外的教训：谓词第一版写反（一切仓内路径都匹配"父目录前缀"），同批测试立功拦住
