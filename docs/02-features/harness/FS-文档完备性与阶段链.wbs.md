# WBS-harness 文档完备性与阶段链

> 产出：feature-decomposer 角色 · 同步写入 `state.todos`，落盘 `docs/02-features/harness/`
> 规则：叶子必须可独立验证；不按文件拆；每栈有且仅有一个统一验证 TODO。

## 1 拆分树

| id | 栈 | 任务 | 验收标准 | spec_ref | depends_on | 风险级 | required_skills |
|---|---|---|---|---|---|---|---|
| T1 | harness | 占位符残留与空章节判据 | 占位符残留、只有表头的空章节各有用例判红；三份齐备时零告警 | `fs#§4.1@2b0e914` | — | HIGH | harness |
| T2 | harness | RS 到 FS 的追溯覆盖率 | US 缺条目判红并点名编号；追溯表缺失单独报一条 | `fs#§4.2@2b0e914` | T1 | MEDIUM | harness |
| T3 | harness | WBS 与 FS 小节双向覆盖 | 悬空 spec_ref 与漏做小节各有用例；缺列时不再逐行报噪音 | `fs#§4.3@2b0e914` | T2 | HIGH | harness |
| T4 | harness | 阶段链修正与退休链登记 | 现行链次序有断言；旧链 history 放行、逆序仍判红 | `fs#§4.4@2b0e914` | T1 | HIGH | harness |
| T5 | harness | artifacts 路径解析 | 中文与空格路径照检；读不出路径判红并说明等于没登记 | `fs#§4.5@2b0e914` | T1 | MEDIUM | harness |
| V1 | harness | 统一验证：仓内全量门禁 | `npm run gate` 退出码 0，断言数不低于 450 | `fs#§4.1@2b0e914` | T1,T2,T3,T4,T5 | — | harness |

## 2 依赖拓扑

```text
T1 ──┬──→ T2 ──→ T3
     ├──→ T4
     └──→ T5
T2、T3、T4、T5 ──→ V1
```

> 无环是硬要求。T1 是判据库骨架，其余三支都挂在它下面；V1 只收口不实现。

## 3 统一验证收口

| 栈 | 验证 TODO | 覆盖范围 | 命令 |
|---|---|---|---|
| harness | V1 | 本需求全部 harness TODO | `npm run gate` |

## 4 不作数的情况

- 叶子写成「改 doc_completeness.mjs」——按文件拆，无法验证完成
- 叶子没有验收标准——无法判定 done
- `spec_ref` 留空，或指向 FS 里不存在的小节——悬空任务
- FS 有 §4.x 却没有任何任务对应——漏做，交付前不会有人发现
- 实现 TODO 自己跑全量门禁——应由 V1 收口
- 只写判据不补用例——判据本身没有证据，等于用一个没验证过的检查去验证别人
