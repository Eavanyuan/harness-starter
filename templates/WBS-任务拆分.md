# WBS-<需求标题>

> 产出：`feature-decomposer` · 写入 `state.todos` 并落盘 `docs/02-features/<module>/<slug>.wbs.md`
> 规则：叶子必须可独立验证；不按文件拆；每栈有且仅有一个统一验证 TODO。

## 1 拆分树

| id | 栈 | 任务 | 验收标准 | depends_on | 风险级 | required_skills |
|---|---|---|---|---|---|---|
| T1 | backend | | | — | HIGH | |
| T2 | frontend | | | T1 | MEDIUM | |
| V1 | backend | 统一验证：编译 + 定向测试 | 全绿零警告 | T1 | — | |

## 2 依赖拓扑

```text
T1 ──→ T2 ──→ V1
 └───────────→ V2
```

> 无环是硬要求。出现环说明拆分粒度错了，回到 RS 重新看边界。

## 3 统一验证收口

| 栈 | 验证 TODO | 覆盖范围 | 命令 |
|---|---|---|---|
| backend | V1 | 本需求全部后端 TODO | `<test-cmd>` |
| frontend | V2 | 本需求全部前端 TODO | `<fe-test-cmd>` |

## 4 不作数的情况

- 叶子写成「改 A.java」——按文件拆，无法验证完成
- 叶子没有验收标准——无法判定 done
- 实现 TODO 自己跑全量测试——应由统一验证 TODO 收口
- 联调工作藏进某个实现 TODO——应单列，否则永远没人做
