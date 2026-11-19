# Retro — p0-stability（2026-11-19）

## 一句话

架构体检 P0 四件（claim 异常分类/SIGTERM 清理/健康告警/轮次历史）三轮 CR 打出两颗实战地雷（嵌套+TDZ 互相掩护、早期 die TDZ），全部修完。

## 教训

1. **嵌套 bug 的杀伤在于反转布尔语义**：`return { status: failed_safe() }` 不只是不触发失败分支——布尔包装 `status !== 'failed'` 恒真，失败变成功向上传播六处调用点。写三态返回时直接 return 目标函数即可，不包一层。
2. **两错互相掩护 = 零覆盖的铁证**：嵌套让 `=== 'failed'` 永假 → `blocked += 1` 的 TDZ 永不可达 → 套件 129 全绿。分支未被测试执行过这件事，只有变异+分支专属用例（5u-bis）能证明——回归钉不是可选项。
3. **函数声明提升让 typeof 守卫永不拦截**：`typeof markHealth === 'function'` 在声明提升后恒真——防 TDZ 的正确武器是 try/catch 或可选链（`taskLoopCfg?.key`），不是 typeof。
4. **早退路径与主路径的对齐**：零触发早退 `finish({ code: softFail.length ? 1 : 0 })` 漏了 `blocked`——每当给 finish 语义加维度（blocked），搜所有 finish 调用点对齐，否则主路径修好了早退路径还是旧的。
5. **架构体检→P0→修复→三轮 CR 的闭环本身有效**：D1/D2/D10/D11 四条体检发现全部落地为可验行为（回归钉+变异+实测），两颗地雷都在合入前被拦住。
