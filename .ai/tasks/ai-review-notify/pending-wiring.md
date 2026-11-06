# 待人放行的接线 —— 已落地（2026-11-06）

> 本文保留作决策记录，不再是待办。原计划的两处接线已在用户会话内授权后落盘，
> 并补上了当初漏掉的第三处。

## 实际落地的三处（不是两处）

| 位置 | 改了什么 | 原 diff 有没有 |
|---|---|---|
| `package.json` → `scripts` | 新增 `test:router` / `test:ai-review` / `test:broker` | 有 |
| `package.json` → `gate` | 链尾追加三个 test | 有 |
| `package.json` → `files` | **新增 `harness.rules.json`** | **没有** |
| `.github/workflows/quality-gate.yml` | 新增三步 | 有 |

第三处是漏掉的：`harness.rules.json` 已经进了 `scripts/harness-cli.mjs` 的 `TEMPLATE_FILES`，
却没进发布包清单。结果是源码仓库一切正常，装出来的项目 init 成功、审核路由每次 `exit 2`——
装的时候不报错，用的时候才红，而且红在一个跟"安装"看不出因果关系的地方。

## 为什么 `hooks/write-allowlist.txt` 没有加行

那份文件由人维护（文件头写着"agent 改它就该被 guard_write 拦住"），本次没有自授权。
授权事实记在 state 的 `deviations[0]`（`disposition: fixed` + `by`），以及本轮提交里。

## 仍需人处理

- `templates/CR-代码审查记录.md` §0 加"每行必须带可复现命令 + 输出"（考卷区，理由见 CR §六）。
