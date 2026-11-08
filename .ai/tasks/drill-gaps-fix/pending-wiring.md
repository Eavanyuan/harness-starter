# 待人放行的接线（drill-gaps-fix）

> 老三样：测试注册进 gate/CI 需要动考卷区。加完放行条说一声"落接线"即可。

## 放行条（hooks/write-allowlist.txt 追加）

```
package.json | drill-gaps-fix：test:doctor-gates 注册进 gate（用户已授权） | 2026-11-22
.github/workflows/quality-gate.yml | drill-gaps-fix：CI 增加 doctor 门禁在场性测试 | 2026-11-22
```

（注意：P2-11 的两条补登记——package.json 与 .github 的 2026-11 批次——仍悬空，建议一并加。）

## package.json

scripts 块追加：`"test:doctor-gates": "bash test/doctor-gates.test.sh"`
gate 链末尾追加：` && npm run test:doctor-gates`

## quality-gate.yml（「飞书长连接」步骤之后）

```yaml
      - name: doctor 门禁在场性（无 runner 阻塞 / approval 缺位提醒）
        run: bash test/doctor-gates.test.sh
```
