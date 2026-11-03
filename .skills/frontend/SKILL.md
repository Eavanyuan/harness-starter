---
name: frontend
stack: frontend
version: 1.0.0
stage0: true
applies_to:
  - "frontend/src/**"
references:
  - references/checklist.md
---

# Vue 前端开发

管 `frontend/src/` 下的组件、组合式函数、状态与 API 封装。
**不管** E2E（走 `e2e` skill）、后端契约（走 ADR）、纯设计稿评审。

## Stage 0（写码前强制）

| # | 读什么 | 为什么非读不可 |
|---|---|---|
| 0.1 | `references/checklist.md` | 7 条阻断级规则的反例与正例 |
| 0.2 | 要改的组件 + 它在哪些页面被引用 | 组件是多处复用的，改一处崩一片 |
| 0.3 | 对应的 `*.spec.ts` 现状 | 先知道现在测了什么，才知道该补什么 |

前置自检（全 ✅ 才允许 Edit / Write）：

- [ ] 0.1 逐条看过，能说出本次命中哪几条
- [ ] 已搜出引用方：`rg -n '<组件名' frontend/src`
- [ ] 知道本次走单测还是还要加 E2E
- [ ] 知道要动哪些文案 key（有文案改动时）

## 分流

| 走哪条 | 判据 |
|---|---|
| 全流程 | 新增页面/组件 / 改 props 或 emit 契约 / 影响复用方 / 范围不清 |
| debug 快速路径 | 修渲染或交互 bug / 局部样式 / 补测试 |

debug 路径不得新增或修改对外 props、emit、路由。**一旦要改契约，切回全流程。**

## 硬规则

> L0 验证纪律（.ai/rules/verification.md 五条）对全部栈生效，此处是本栈的查法补充。

| # | 规则 | 怎么查 |
|---|---|---|
| F1 | 改 `.vue` / `.ts` 必须同次补对应单测；只改源码不补测试即违规 | diff 里 `frontend/src` 与 `frontend/tests` 的文件数对照 |
| F2 | 用户可见文案走 i18n key，不硬编码在模板里 | `rg -nP '>\s*[\p{Han}]' --glob '*.vue' frontend/src` |
| F3 | 跨页面/跨组件共享状态进 Pinia，不留组件内单例 | review：`reactive(` 声明的对象是否被多个组件引用 |
| F4 | 禁用 `any` / `@ts-ignore` / `@ts-expect-error` 掩盖类型错误 | `rg -n ':\s*any\b\|\bas any\b\|<any>\|@ts-ignore\|@ts-expect-error' --glob '*.ts' --glob '*.vue' frontend/src`（**不要**用 `\bany\b`，会命中 license 头里的 "by any medium"） |
| F5 | 改 `.vue`/`.scss`/`.css` 必须过 stylelint 且零错误 | `npx stylelint <改动的文件>`（**不要**跑带 `--fix` 的全仓脚本，会顺手改无关文件） |
| F6 | HTTP 调用集中在 `api/` 层，组件内不裸写 `axios`/`fetch` | `rg -n 'axios\|fetch\(' --glob '*.vue' frontend/src` |
| F7 | 列表接口必须有分页或上限，不做无界查询 | 对照新增 API：请求参数里有 `page`/`limit`/`size` |

## 交付

1. 验证命令 + 原始输出落 `.ai/verify/<todo>.log`
2. 复查结论：改了哪些组件、复用方是否受影响、文案 key 是否补齐
3. 剩余风险：没覆盖的交互分支、依赖后端数据的用例
4. 一条可直接用的 commit message

## 按需加载

- 表格列显隐/列宽/排序持久化 → `references/checklist.md`「按需场景」
- 表单校验规则与后端一致性 → 同上
- 时间/日期展示格式 → 同上，先确认是「显示」「查询文本」还是「直发后端」
