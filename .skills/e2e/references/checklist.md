# E2E 规则详解

> 入口在 `../SKILL.md` 的「硬规则」表。这里放反例与 flaky 的成因排查。

## E1 选择器

```ts
// ✗ 三种都会随 UI 文案/结构变动而碎
page.getByText('保存')
page.locator('.el-table__row:nth-child(2)')
page.locator('//div[@class="toolbar"]/button[2]')

// ✓
page.getByTestId('toolbar-save')
page.getByTestId('row-actions').getByTestId('delete')
```

`data-testid` 是**给测试用的契约**，不是给用户的说明。命名按「区域-动作」：`toolbar-save`、`dialog-confirm`、`row-delete`。
组件改版时只要 testid 不变，用例就不该碎。

## E2 等待

```ts
// ✗ 两种都不可靠：短了不够、长了拖时间，而且掩盖真实问题
await page.waitForTimeout(3000)
await page.waitForSelector('.loading', { state: 'hidden' })

// ✓ Playwright 的断言自带重试
await expect(page.getByTestId('table-row')).toHaveCount(10)
await expect(page.getByTestId('submit')).toBeEnabled()
```

只有在**无法用断言表达**的等待（比如等一个外部任务真的完成）才允许显式轮询，
并且必须设上限 + 超时后给出可读的失败信息。

## E3 断言质量

```ts
// ✗ 元素存在 ≠ 功能正确，接口返回 500 时它也可能"存在"
await expect(page.getByTestId('total')).toBeVisible()

// ✓ 断言业务值
await expect(page.getByTestId('total')).toHaveText('1,234')
await expect(page).toHaveURL(/\/detail\/42$/)
```

## E4 force

`{ force: true }` 跳过「元素可点击」检查，等于关掉 Playwright 最有价值的保护。
它让用例从「验证用户能做到」退化成「验证元素在 DOM 里」。

元素点不到的真实原因通常是：被浮层遮挡、动画未结束、不在视口内。
**修真实原因**，不要 force。

## E5/E6 数据与顺序

```ts
// ✗ 依赖库里已有一条叫 "demo" 的数据，且依赖前一个用例删过它
await page.getByTestId('row-demo').click()

// ✓ 建、用、清，名字带前缀避免撞车
const name = `e2e-${Date.now()}`
await createItem(name)
// ... 断言 ...
await deleteItem(name)
```

---

## flaky 的四个成因（按出现频率排）

1. **等待时机**：固定 sleep 或依赖动画时长 → 换成断言重试。
2. **数据污染**：上一个跑挂了留下脏数据，或并发 worker 互相踩 → 用例名加唯一前缀，清理放 `afterEach`。
3. **选择器过脆**：依赖文案、顺序、层级 → 改 `data-testid`。
4. **真实竞态**：应用本身的 bug 被 E2E 暴露 → **这是好消息**，报 bug，不要改测试绕过去。

判断方法：单跑 10 次仍偶发 = 前两类；只在全量跑时偶发 = 并发/数据污染；
换个环境就崩 = 环境依赖。**先分类再动手**，直接加重试会把第 4 类掩盖成"偶发"。

## 数据准备

需要多角色/多租户时，用**独立的 fixture 建数据**，不要在 spec 里调内部接口拼数据——
那会让用例依赖后端实现细节，重构即碎。fixture 只走公开 API 或 seed 脚本。
