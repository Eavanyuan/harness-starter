---
name: e2e
stack: frontend
version: 1.0.0
stage0: true
applies_to:
  - "frontend/tests/e2e/**"
references:
  - references/checklist.md
---

# E2E 用例编写

管 `frontend/tests/e2e/` 下的端到端用例：新增 spec、修 flaky、补关键路径。
**不管**单元测试（归各栈 skill）。E2E 只覆盖「跨页面、跨服务、真实登录态」的路径，
能用单测覆盖的逻辑不要写成 E2E——它慢 100 倍，而且失败时定位成本高 10 倍。

## Stage 0（写码前强制）

| # | 读什么 | 为什么非读不可 |
|---|---|---|
| 0.1 | `references/checklist.md` | 6 条阻断级规则 + flaky 的四个真实成因 |
| 0.2 | 同目录既有 spec 的选择器写法 | 新写法与存量不一致，等于制造两套约定 |
| 0.3 | 应用的登录/鉴权准备方式 | 没登录态的 spec 一定失败，且失败原因具有误导性 |

前置自检（全 ✅ 才允许写 spec）：

- [ ] 确认这条路径**无法**用单测覆盖（能覆盖就写单测）
- [ ] 知道本地怎么跑：npx playwright test <file>
- [ ] 知道登录态从哪来、过期后怎么恢复
- [ ] 要断言的数据在跑之前已存在，或由本用例自建

## 分流

| 走哪条 | 判据 |
|---|---|
| 全流程 | 新增关键路径 / 新增页面 / 涉及多角色 |
| debug 快速路径 | 修单个 flaky 用例 |

修 flaky **必须先定位原因**再改。加 `retry`、加 `sleep`、加 `force` 都是掩盖，
按 `references/checklist.md` 的四个成因逐个排除。

## 硬规则

| # | 规则 | 怎么查 |
|---|---|---|
| E1 | 选择器用 `data-testid`；禁用中文文案、`nth-child`、层级 XPath | `rg -nP "locator\\(['\"].*[\\p{Han}]" frontend/tests/e2e` |
| E2 | 禁用固定等待（`waitForTimeout`、`sleep`、`setTimeout` 轮询） | `rg -n 'waitForTimeout\|sleep\\(' frontend/tests/e2e` |
| E3 | 每个用例至少一个**业务断言**（值/状态/跳转），只断言「元素可见」不算 | review：`expect` 的实参是否含数据比较 |
| E4 | 禁用 `force: true`、`{ force: true }` 绕过可操作性检查 | `rg -n 'force:\\s*true' frontend/tests/e2e` |
| E5 | 数据自建自清，不依赖其他人跑过留下的数据 | review：用例开头是否有创建步骤，结尾是否清理 |
| E6 | 用例之间不得依赖执行顺序 | 单跑任一 spec 必须通过：`npx playwright test <file> --workers=1` |

## 交付

1. 运行命令 + 原始输出落 `.ai/verify/<todo>.log`
2. 复查结论：覆盖了哪条关键路径、为什么这条路径单测覆盖不了
3. 剩余风险：依赖外部服务的步骤、已知时序敏感点
4. 一条可直接用的 commit message

## 按需加载

- 用例跑起来但结果不稳定 → `references/checklist.md`「flaky 的四个成因」
- 需要构造多角色/多租户场景 → 同上「数据准备」
