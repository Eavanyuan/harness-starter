# usability-fixes 收尾（2026-11-14）

> 任务：`.ai/tasks/usability-fixes/state.json`（M 档 change）。
> 需求源：`.ai/review/harness易用性与配置面评估.md`（S1 三阻断 + S2 三痛 + 配置五项）。

## 修了什么

**P0（新用户开箱 + 收尾路径）**
- **U1 init 净化**：源仓真实接入（GitLab 实例、飞书空间）不再随包进新项目——projectKey/url 清空为"未接入"，init 输出明说；doctor 同步：projectKey 空 = 未接入提示不判红（半配置才红）
- **U2 开箱绿**：init 自动补 backend/frontend `template:true` 占位条（.skills 全套与 projects 集合对齐，check:skills 不再开箱红）；doctor 对 template 条只提醒。**契约翻转**：旧"未填 stacks 前刻意红"废止——新用户第一条 `npm run gate` 就是绿的，接到真实目录后改值删标记
- **U3 deploy/docs 随包**：TEMPLATE_DIRS + package.json files 补 `deploy/`、`docs/06-reference/`——test:task-loop 不再结构性红，契约文档随行
- **U4/U5/U7 `harness close`**：S 档收尾一键化——自动补 gate TODO、retro 模板（slug 新规）、缺站补记名 defer、**bootstrap 自指在命令内解决**（impl 态跑 gate → 绿翻 done / 红还原指路）、幂等。本任务自己就是用它收的尾
- **U6 pipefail 提醒**：verify-run FAIL 时 stderr 明示管道吞码（实测两次的事故形态）

**P1/P2**
- **C1 v1/v2 统一**：build-agents 的 token 解析改走 allStacks（此前只读 stacks，projects 被遮蔽）；生成物已重生成
- **C4 配置键总表**：docs/06-reference/config-keys.md（182 行，三处全键，子代理逐键对源核验）
- **C2/C3/C6 文档同步**：快速上手（3 分钟→心跳/节拍分离 + HARNESS_GITLAB_PROJECT 必要性）、审核指南（GITLAB_URL/TOKEN 统一入口名）、README 计数（20→25）
- **U8 定时器多仓隔离**：label 按仓库目录名派生（com.harness.task-loop.<slug>），装第二个仓库不再互覆；安装输出提示 HARNESS_GITLAB_PROJECT

## 设计取舍（留在案上）

- close **不设 gate 命令注入口**：S 折叠判据只认 `npm run gate`，注入口等于教人造过不了判据的假证据——测试提速靠目标仓桩化 gate 脚本（命令行不变）
- 旧契约"空目录 init 刻意红"被推翻为"占位条开箱绿"——两条旧断言翻转，理由：快速上手的第一道门必须绿，模板态提醒已足够引导
- 子代理文档同步的两个 TODO（config.version 无消费、skills.dir 无读者）留给后续清理

## 验证

test:harness-cli 234→251（§51 净化五断言 + §52 close 十断言）；test:agents 23/0（重生成后）；
test:init 29/0、doctor-gates 20/0、wiring 15/0；收尾 = `harness close` 真跑全量 gate（CLOSE-GATE 日志）。
