# Issue Tracker 能力接口

> harness-starter 对 issue tracker 的全部需求抽象为六个能力。
> 飞书是第一个实现；新 tracker（Jira/GitHub Issues/Linear）按此接口实现即可接入。

## 六个能力

| # | 能力 | 飞书实现 | 配置键 | 新 tracker 需要什么 |
|---|---|---|---|---|
| C1 | **拉单**（按指派人+状态查询待处理单） | `search_by_mql` + `buildMyBugsMql` | `runtime.feishu.{projectKey, assigneeField, newStatus}` | 任意 query API（JQL/JQL/GH filter） |
| C2 | **产品线过滤**（按字段前缀只处理本产品线的单） | `filterByIterationPrefix` | `runtime.feishu.iteration.{field, prefix}` | 任意可查询的字段（sprint/component/label） |
| C3 | **优先级分级**（按优先级决定 auto/confirm/skip） | `gateBySeverity` + `normSeverity` | `runtime.feishu.severity.{field, map}` | 优先级字段（P0-P3 / 高中低 / Critical-Major-Minor） |
| C4 | **状态流转**（认领时改状态：如 New→Processing） | `transition_state` + `readStatusViaMql` 回读 | 代码内 `toStatus='Processing'` | 状态转换 API + 可流转状态查询 |
| C5 | **评论**（追问信息不全的单、通知修复进度） | `add_comment` + `search_user_info`(@人) | 代码内 ASK_MARKER | 评论 API + 用户 ID 解析（@人） |
| C6 | **评论防重**（同一张单只追问一次，防轮询刷屏） | `list_workitem_comments` + `[自动追问]` 标记 | 代码内 ASK_MARKER | 评论列表读取 API |

## 实现约定

### 接口形态
每个能力实现为独立模块（如 `scripts/lib/feishu-bug-source.mjs`），导出纯函数——输入是 MCP `call` 函数 + 配置对象，输出是结构化结果。**不依赖具体 MCP 工具名**——工具名映射在实现层处理。

### 新 tracker 接入步骤

```
1. 实现 6 个能力的对应函数（参照 feishu-* 模块结构）
2. 在 harness.rules.json 加 runtime.<tracker> 配置节
3. 在 task-loop.mjs 的剖面 B 里按 tracker 分发（现有 wantFeishu 模式）
4. 写 .skills/deployment/references/<tracker>-setup.md
```

### 已泛化的模式（不依赖具体 tracker）

| 模式 | 位置 | 说明 |
|---|---|---|
| 信息完备性判定 | `feishu-ask.mjs` `assessDescription()` | 纯文本启发式，不含任何飞书 API——任何 tracker 直接复用 |
| 优先级归一 | `feishu-bug-source.mjs` `normSeverity()` | P0-P3/中文轻重/英文轻重三套内置——任何 tracker 的优先级词表都能映射 |
| 产品线前缀过滤 | `feishu-bug-source.mjs` `filterByIterationPrefix()` | 纯前缀匹配，不含飞书 API |
| 接单语义 | coder prompt 步骤 7 + feishu-sync.mjs | 只改状态零评论（用户定稿）——通用原则 |

## 飞书特有经验（新 tracker 可跳过）

| 经验 | 原因 |
|---|---|
| 字段 key 随空间变（field_a7de08 等） | 自定义字段的 key 是空间级 UUID——换 tracker 无此问题 |
| 状态名用英文 label（New/Processing）不用中文（处理中） | 飞书枚举只认英文 label——Jira/GitHub 无此限制 |
| MQL 语法（FROM 两段式、array_contains 等） | 飞书特有查询语言 |
| transition_state 是专用工具，update_field 只管业务字段 | 飞书 API 设计——其他 tracker 可能统一用一个 update API |
| get_workitem_brief 的 status 读不出 | 飞书 API 缺陷——回读用 MQL 替代 |
| @人格式需要 lark_user_id | 飞书 @协议——GitHub 用 @username 即可 |
