#!/usr/bin/env bash
# 文档完备性自测 —— RS / FS / WBS 的「写全了没有」。
#
# 这一组用例守的是两件事：
#   1. 完备的文档不许判红（门禁误杀一次，人就会把它关掉——上一版在 CI mtime 上踩过）
#   2. 每一类"看起来填了其实没填"必须判红：占位符残留、只有表头的空表、
#      追溯表漏条目、WBS 指向不存在的 FS 小节、FS 小节没有任务对应
#
# 另外守一条容易被改坏的性质：**阶段没到就不判**。写到一半的文档必然不完整，
# 这时候判红会逼人删掉 artifacts 声明，门禁反而训练出"别登记产物"的行为。
#
# 用法：bash test/completeness.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

rsync -a --exclude '.git' --exclude 'node_modules' --exclude '.ai/tasks' "$HERE/" "$TMP/repo/"
cd "$TMP/repo"
rm -f .gitignore
rm -rf .ai/tasks
mkdir -p .ai/tasks/demo docs src
: > src/A.java

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then
    printf "  \033[32m✓\033[0m %s\n" "$1"
    pass=$((pass + 1))
  else
    printf "  \033[31m✗\033[0m %s  (期望 %s，实际 %s)\n" "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

write_docs() {
  cat > docs/rs.md <<'EOF'
# RS-筛选

## 1 背景与痛点

列表页在十万级数据下无法按状态筛选，用户只能导出后自行过滤。

## 2 用户故事

### US-1 按状态筛选

- **作为**：运维
- **我希望**：按状态筛选列表
- **以便**：快速定位异常实例

**验收标准**

- Given 存在 3 条不同状态的数据 When 选择异常 Then 只返回异常那 1 条
- Given 没有任何匹配数据 When 选择异常 Then 展示空态且保留筛选条件

### US-2 记住筛选条件

- **作为**：运维
- **我希望**：刷新后筛选条件还在
- **以便**：不用反复重选

**验收标准**

- Given 已选择异常 When 刷新页面 Then 筛选条件仍为异常
- Given 已选择异常 When 切换 tab 再回来 Then 筛选条件仍为异常

## 3 核心需求

| 编号 | 需求 | 优先级 | 来源 |
|---|---|---|---|
| R-1 | 按状态筛选 | P0 | US-1 |
| R-2 | 条件持久化 | P1 | US-2 |

## 4 非功能约束

| 类别 | 约束 | 判据 |
|---|---|---|
| 性能 | 十万级数据筛选响应 | P95 小于 800ms |
| 边界 | 状态枚举固定 5 种 | 新增状态需评估索引 |

## 5 范围外

- 不做多条件组合筛选
- 不做筛选条件分享链接

## 6 术语表

| 术语 | 含义 | 易混淆点 |
|---|---|---|
| 状态 | 实例生命周期状态 | 与健康度不是一回事 |

## 7 开放问题

| # | 问题 | 候选解读 | 影响 | 是否业务取舍 |
|---|---|---|---|---|
| Q1 | 筛选条件存哪 | 本地 / 服务端 | 跨设备是否生效 | 是 |
EOF

  cat > docs/fs.md <<'EOF'
# FS-筛选

## 1 概述

给运维提供按状态筛选列表的能力，关联 US-1、US-2。

## 2 需求追溯

| RS 条目 | 本文档小节 | 覆盖状态 |
|---|---|---|
| US-1 | §4.1 | 完整 |
| US-2 | §4.2 | 完整 |

## 3 方案要点

- 关联 ADR：无
- 关键取舍：筛选走服务端查询，不在前端过滤

## 4 详细设计

### 4.1 筛选查询

- 输入：status 枚举
- 处理：拼 where 条件
- 输出：分页结果
- 失败分支：非法枚举返回 400

### 4.2 条件持久化

- 输入：当前筛选值
- 处理：写入 localStorage
- 输出：无
- 失败分支：存储不可用时降级为不持久化

## 5 接口契约

| 方法 | 路径 | 入参 | 出参 | 错误码 |
|---|---|---|---|---|
| GET | /api/instances | status | 分页列表 | 400 |

## 6 数据变更

| 变更 | 类型 | 迁移脚本 | down 脚本 | 破坏性 |
|---|---|---|---|---|
| 无 | — | — | — | 否 |

## 7 交互与状态

- 状态矩阵：ui_scope 为 NONE，不适用
- 关键交互：下拉选择后立即触发查询

## 8 配置项

| key | 默认值 | 说明 | 是否必填 |
|---|---|---|---|
| filter.pageSize | 20 | 每页条数 | 否 |

## 9 测试要点

| 场景 | 断言 | 边界 |
|---|---|---|
| 选择异常 | 返回条数为 3 | 零匹配 |
| 刷新页面 | 筛选值保持 | localStorage 禁用 |

## 10 兼容与回滚

- 旧数据怎么办：不涉及
- 旧客户端怎么办：新增可选参数，不传即全量
- 出问题怎么回滚：回滚前端版本即可
EOF

  cat > docs/wbs.md <<'EOF'
# WBS-筛选

## 1 拆分树

| id | 栈 | 任务 | 验收标准 | spec_ref | depends_on | 风险级 | required_skills |
|---|---|---|---|---|---|---|---|
| T1 | backend | 查询参数解析与校验 | 非法枚举返回 400 | `fs#§4.1@3b91d0` | — | HIGH | backend |
| T2 | frontend | 筛选条件持久化 | 刷新后筛选值不变 | `fs#§4.2@3b91d0` | — | MEDIUM | frontend |
| V1 | backend | 统一验证 | 编译与单测全绿 | `fs#§4.1@3b91d0` | T1 | — | backend |

## 2 依赖拓扑

```text
T1 ──→ V1
T2
```

## 3 统一验证收口

| 栈 | 验证 TODO | 覆盖范围 | 命令 |
|---|---|---|---|
| backend | V1 | 全部后端 TODO | `mvn -q test` |

## 4 不作数的情况

- 叶子按文件拆
EOF
}

write_state() {
  cat > .ai/tasks/demo/state.json <<EOF
{
  "meta": { "schema_version": 1, "task": "demo", "flow_tier": "M", "risk_tier": "MEDIUM" },
  "stage": "${1:-impl}",
  "artifacts": { "rs": "docs/rs.md", "fs": "docs/fs.md", "wbs": "docs/wbs.md", "adr": null },
  "todos": []
}
EOF
}

reset() { write_docs; write_state "${1:-impl}"; }
ci() { node scripts/ci-verify.mjs --file .ai/tasks/demo/state.json >"$TMP/out" 2>&1; echo $?; }
out() { cat "$TMP/out"; }
has() { grep -q "$1" "$TMP/out" && echo yes || echo no; }

reset
echo "== 1. 完备文档 → 必须通过（不误杀） =="
check "三份文档齐备时门禁放行" 0 "$(ci)"

echo "== 2. 模板占位符残留 → 拦截 =="
reset
printf '\n- <角色>\n' >> docs/rs.md
check "占位符残留判红" 1 "$(ci)"
check "报错点名占位符" yes "$(has '占位符没替换')"

echo "== 3. 章节只剩表头 → 拦截 =="
reset
sed -i.bak '/^| 选择异常/d; /^| 刷新页面/d' docs/fs.md
check "空表章节判红" 1 "$(ci)"
check "报错点名 §9" yes "$(has '测试要点')"

echo "== 4. 追溯表漏条目 → 拦截 =="
reset
sed -i.bak '/^| US-2 | §4.2 | 完整 |/d' docs/fs.md
check "RS 覆盖率不足判红" 1 "$(ci)"
check "报错点名 US-2" yes "$(has 'US-2')"

echo "== 5. WBS 指向不存在的 FS 小节 → 拦截 =="
reset
sed -i.bak 's/fs#§4.1@3b91d0/fs#§4.9@3b91d0/' docs/wbs.md
check "悬空 spec_ref 判红" 1 "$(ci)"
check "报错说明悬空" yes "$(has '悬空任务')"

echo "== 6. FS 小节没有任务对应 → 拦截 =="
reset
cat > docs/wbs.md <<'EOF'
# WBS-筛选

## 1 拆分树

| id | 栈 | 任务 | 验收标准 | spec_ref | depends_on | 风险级 | required_skills |
|---|---|---|---|---|---|---|---|
| T1 | backend | 查询参数解析与校验 | 非法枚举返回 400 | `fs#§4.1@3b91d0` | — | HIGH | backend |

## 2 依赖拓扑

```text
T1
```

## 3 统一验证收口

| 栈 | 验证 TODO | 覆盖范围 | 命令 |
|---|---|---|---|
| backend | T1 | 全部后端 TODO | `mvn -q test` |

## 4 不作数的情况

- 叶子按文件拆
EOF
check "漏做判定为红" 1 "$(ci)"
check "报错点名 §4.2" yes "$(has '§4.2')"

echo "== 7. WBS 缺 spec_ref 列 → 拦截 =="
reset
sed -i.bak 's/| 验收标准 | spec_ref | depends_on |/| 验收标准 | depends_on |/' docs/wbs.md
check "缺列判红" 1 "$(ci)"
check "报错点名 spec_ref" yes "$(has 'spec_ref')"

echo "== 8. 声明了不存在的路径 → 拦截 =="
reset
sed -i.bak 's|"rs": "docs/rs.md"|"rs": "docs/nope.md"|' .ai/tasks/demo/state.json
check "声明与事实不符判红" 1 "$(ci)"
check "报错说明文件不存在" yes "$(has '文件不存在')"

# P1-1（实测：中文/空格文件名让整条检查静默放行）。判据曾是
# `!/\s/.test(p) && !/[\u4e00-\u9fa5]/.test(p)`——命中就 continue，于是
# `docs/需求 规格.md` 这份根本没被打开过的文档，结论是"完备性通过"。
echo "== 8b. 中文/空格文件名 → 必须真检（不许静默跳过） =="
reset
mv docs/rs.md "docs/需求 规格.md"
sed -i.bak 's|"rs": "docs/rs.md"|"rs": "docs/需求 规格.md"|' .ai/tasks/demo/state.json
check "中文+空格路径指向存在的文件 → 放行（不误杀）" 0 "$(ci)"
sed -i.bak 's|"rs": "docs/需求 规格.md"|"rs": "docs/需求 规格-不存在.md"|' .ai/tasks/demo/state.json
check "同一路径指向不存在的文件 → 判红" 1 "$(ci)"
check "报错点名那份不存在的文件" yes "$(has '需求 规格-不存在.md')"

echo "== 8c. 登记写成了说明文字 → 判红（不是提示，不再放行） =="
reset
sed -i.bak 's|"rs": "docs/rs.md"|"rs": "见飞书文档（未落盘）"|' .ai/tasks/demo/state.json
check "读不出路径的登记判红" 1 "$(ci)"
check "报错说清为什么算没登记" yes "$(has '读不出文件路径')"

echo "== 8d. 路径后面跟说明 → 抠出路径照检 =="
reset
mv docs/rs.md "docs/需求 规格.md"
sed -i.bak 's|"rs": "docs/rs.md"|"rs": "docs/需求 规格.md（初稿）"|' .ai/tasks/demo/state.json
check "带后缀说明的登记仍按路径检（存在则放行）" 0 "$(ci)"

echo "== 9. 阶段没越过产出阶段 → 不判（写到一半是常态） =="
reset fs_review
printf '\n- <模块/流程>\n' >> docs/fs.md
check "fs_review 阶段不判 FS 完备性" 0 "$(ci)"
sed -i.bak 's/"stage": "fs_review"/"stage": "impl"/' .ai/tasks/demo/state.json
check "同一份文档到 impl 就判红" 1 "$(ci)"

echo "== 10. 未登记的产物 → 提示但不判死 =="
reset
sed -i.bak 's|"wbs": "docs/wbs.md", ||' .ai/tasks/demo/state.json
check "未登记不判红" 0 "$(ci)"
check "提示点了 WBS" yes "$(has 'WBS')"

echo "== 11. review-packet 首版 =="
reset
rp() { node scripts/harness-cli.mjs review-packet . demo --first >"$TMP/rp" 2>&1; echo $?; }
check "完备时 review-packet 退出 0" 0 "$(rp)"
check "首版标注" yes "$(grep -q '首版' "$TMP/rp" && echo yes || echo no)"
check "给出该谁签" yes "$(grep -q '该谁签' "$TMP/rp" && echo yes || echo no)"

reset
printf '\n- <角色>\n' >> docs/rs.md
node scripts/harness-cli.mjs review-packet . demo --first >"$TMP/rp" 2>&1
check "有缺口时 review-packet 退出 1" 1 "$?"
check "评审包列出待补项" yes "$(grep -q '待补' "$TMP/rp" && echo yes || echo no)"

echo "== 12. review-packet 列表模式 =="
reset
node scripts/harness-cli.mjs review-packet . >"$TMP/rp" 2>&1
check "列表模式退出 0" 0 "$?"
check "列出任务名" yes "$(grep -q 'demo' "$TMP/rp" && echo yes || echo no)"

echo "== 13. review-packet 变更版 =="
reset
git init -q 2>/dev/null || true
git config user.email harness@example.com
git config user.name harness
git add docs .ai >/dev/null 2>&1
git commit -qm "v1: 初版"
sed -i.bak 's/^- 不做多条件组合筛选$/- 不做多条件组合筛选\n- 不做排序自定义/' docs/rs.md
git add docs >/dev/null 2>&1
git commit -qm "v2: 补范围外一条"
node scripts/harness-cli.mjs review-packet . demo >"$TMP/rp" 2>&1
check "识别为变更版" yes "$(grep -q '（变更）' "$TMP/rp" && echo yes || echo no)"
check "按小节报改动（不是只报标题）" yes "$(grep -q '动过的小节：§5 范围外' "$TMP/rp" && echo yes || echo no)"

echo
printf "通过 %s，失败 %s\n" "$pass" "$fail"
[ "$fail" -eq 0 ]
