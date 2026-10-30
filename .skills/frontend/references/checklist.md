# Vue 前端规则详解

> 入口在 `../SKILL.md` 的「硬规则」表。这里放反例、正例与判断边界。

## F1 测试同步

改行为的判据：**用户在界面上能看到或做到的东西变了**。这类改动必须有单测；
纯重构（提取组件、改内部变量名、拆分函数）不改变行为时可不加，但要在交付里说明为什么不需要。

## F2 文案 i18n

```vue
<!-- ✗ -->
<el-button>保存</el-button>
<el-table-column label="创建时间" />

<!-- ✓ -->
<el-button>{{ t('common.save') }}</el-button>
<el-table-column :label="t('table.createdAt')" />
```

新增 key 三处齐全才算完成：源语言文件、目标语言文件、调用处。
**只加调用不加 key，界面会显示原始 key 串**——这是最常见的漏。

## F3 状态归属

判断顺序：

1. 只有一个组件用 → `ref` / `reactive`，就在组件里
2. 父子之间传递 → `props` / `emit`，别急着建 store
3. 跨页面、跨层级、需要跨路由存活 → Pinia

反例是把一个 `reactive` 对象 export 出去当模块级单例——这在 SSR 和测试隔离下都会出问题，
而且没人知道它被谁改过。

## F4 类型

```ts
// ✗
function parse(data: any) { return data.items }
// @ts-ignore
obj.maybeExists.value = 1

// ✓
function parse(data: { items: Item[] }): Item[] { return data.items }
if ('maybeExists' in obj) { ... }
```

确实需要绕过时，用 `unknown` + 类型守卫，并在同一行注释说明数据来源不可信的原因。

## F5 样式

改动文件名清单要**精确**，不要 `frontend/src/**`。带 `--fix` 的全仓命令会改到无关文件，
把 diff 变脏，也让 review 无法判断改了什么。

## F6 API 分层

```ts
// ✗ 组件里
const res = await axios.get('/api/items', { params })

// ✓ api/items.ts 定义，组件只调函数
export const listItems = (params: ListParams) => http.get<Page<Item>>('/items', { params })
```

组件里裸写请求的代价是：错误处理、鉴权头、baseURL、重试各自为政，改一处漏一片。

## F7 列表查询

无界查询在小数据集上不会暴露问题，上线后才炸。新增列表接口必须有 `page`/`limit`/`size` 之一，
且后端有对应上限。

---

## 按需场景

### 时间与日期（先分类，再选格式）

判定第一步：这个时间是**给人看的**、**查询文本**、还是**直发后端的参数**？三者来源不同，禁止混用。

| 类型 | 做法 | 禁止 |
|---|---|---|
| 显示 | 走系统区域格式化函数，不传模板 | `dayjs(x).format('YYYY-MM-DD HH:mm:ss')` 硬编码 |
| 选择器显示 | 绑定系统区域模板（如 `:format="dateTimeFormat"`） | 不绑 `:format`，用组件库默认 |
| 提交值 | 按接口契约（如毫秒时间戳） | 与显示格式耦合 |

历史教训：某次因为「依赖的函数没导出」而删掉了系统格式注册，导致全站几十处显示点静默回退成硬编码 ISO，
一个多月无人发现。**依赖缺失时升级依赖，不要删注册。**

### 表格布局持久化

列显隐、列宽、排序、分页、过滤、分组六维要一起考虑。只做前两个、漏掉后四个是常见半成品。

### 表单校验

前端校验是体验，后端校验才是安全。两边规则必须一致——前端宽松、后端严格，用户会看到「提交成功但报错」。
