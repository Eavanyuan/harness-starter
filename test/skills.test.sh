#!/usr/bin/env bash
# check-skills.mjs 的自测。每个用例在临时副本上制造一种坏形态，验证它真的报错。
#
# 为什么必须有"应该通过"的用例：只测拦截，读不到配置的 bug 会让所有输入都被判错，
# 而测试依然全绿。hooks 那边就踩过这个坑。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

reset() {
  rm -rf "$TMP/repo"
  mkdir -p "$TMP/repo"
  cp "$ROOT/harness.config.json" "$TMP/repo/"
  cp -R "$ROOT/.skills" "$TMP/repo/"
  cp -R "$ROOT/.ai" "$TMP/repo/"
  mkdir -p "$TMP/repo/scripts"
  cp "$ROOT/scripts/check-skills.mjs" "$TMP/repo/scripts/"
  cp "$ROOT/scripts/resolve-skills.mjs" "$TMP/repo/scripts/"
}

# mut <形态> —— 在 fixture 上制造一种坏形态。
# 只用 node：本仓库的硬依赖是 node，不是 python3。CI 跑在 node:22-alpine 里，
# 那里没有 python3，用 python3 写变异会让"应该拦住"的用例静默失效。
mut() {
  local shape="$1"
  case "$shape" in
    longline)  # 追加 300 行，越过行数上限
      node -e '
        const fs = require("fs");
        const p = ".skills/backend/SKILL.md";
        fs.writeFileSync(p, fs.readFileSync(p, "utf8") + "\n" + "填充\n".repeat(300));
      ' ;;
    ghost)     # required_skills 指向一个不存在的 skill
      node -e '
        const fs = require("fs");
        const p = ".ai/state.example.json";
        const d = JSON.parse(fs.readFileSync(p, "utf8"));
        d.todos[0].required_skills = ["backend", "ghost"];
        fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
      ' ;;
    nofront)   # 砍掉 frontmatter
      node -e '
        const fs = require("fs");
        const p = ".skills/backend/SKILL.md";
        const t = fs.readFileSync(p, "utf8");
        const end = t.indexOf("---", 3);
        if (end < 0) throw new Error("这份 fixture 没有可砍的 frontmatter");
        fs.writeFileSync(p, t.slice(end + 3));
      ' ;;
    upstream-nosha)   # 声明了「素材来源」却不写 commit 锚
      node -e '
        const fs = require("fs");
        const p = ".skills/backend/references/checklist.md";
        const t = fs.readFileSync(p, "utf8");
        fs.writeFileSync(p, "> 素材来源：foo/bar（MIT）\n\n" + t);
      ' ;;
    upstream-sha)     # 声明来源且带锚 —— 必须放行，否则规则会把合法的也拦掉
      node -e '
        const fs = require("fs");
        const p = ".skills/backend/references/checklist.md";
        const t = fs.readFileSync(p, "utf8");
        fs.writeFileSync(p, "> 素材来源：foo/bar@abc1234（MIT）\n\n" + t);
      ' ;;
    *) echo "未知形态：$shape" >&2; return 1 ;;
  esac
}

# expect <名称> <期望退出码> <期望输出里的片段|-> <变更命令>
expect() {
  local name="$1" want_code="$2" needle="$3" mutate="$4"
  reset
  # 变异失败必须当场报错。原来这里是 `( ... ) >/dev/null 2>&1`，一旦变异命令本身跑不起来
  # （典型：镜像里没有 python3），fixture 原封不动，本该被拦的用例就变成恒真断言，
  # 而测试仍然"绿"——那是最坏的一种绿。
  if ! ( cd "$TMP/repo" && eval "$mutate" ) >/dev/null 2>&1; then
    printf '  ✗ %s（变异命令执行失败，用例不成立）\n' "$name"
    fail=$((fail + 1))
    return
  fi
  local out code
  out="$(cd "$TMP/repo" && node scripts/check-skills.mjs 2>&1)"
  code=$?
  local ok=1
  [ "$code" -eq "$want_code" ] || ok=0
  if [ "$needle" != "-" ] && ! printf '%s' "$out" | grep -qF "$needle"; then ok=0; fi
  if [ "$ok" -eq 1 ]; then
    printf '  ✓ %s\n' "$name"; pass=$((pass + 1))
  else
    printf '  ✗ %s（退出码 %s，期望 %s）\n' "$name" "$code" "$want_code"
    printf '%s\n' "$out" | sed 's/^/      /'
    fail=$((fail + 1))
  fi
}

# expect_resolve <名称> <期望出现的片段> <期望不出现的片段|-> <文件参数...>
expect_resolve() {
  local name="$1" want="$2" deny="$3"
  shift 3
  reset
  local out
  out="$(cd "$TMP/repo" && node scripts/resolve-skills.mjs "$@" 2>&1)"
  local ok=1
  printf '%s' "$out" | grep -qF "$want" || ok=0
  if [ "$deny" != "-" ] && printf '%s' "$out" | grep -qF "$deny"; then ok=0; fi
  if [ "$ok" -eq 1 ]; then
    printf '  ✓ %s\n' "$name"; pass=$((pass + 1))
  else
    printf '  ✗ %s\n' "$name"
    printf '%s\n' "$out" | sed 's/^/      /'
    fail=$((fail + 1))
  fi
}

echo "check-skills 自测"

# ── 应该通过 ──────────────────────────────────────────────
expect "原样通过" 0 "个 skill 通过" "true"

expect "新增一个合法 skill 仍通过" 0 "个 skill 通过" \
  "mkdir -p .skills/api/references && printf -- '---\nname: api\nstack: backend\nversion: 1.0.0\nstage0: true\napplies_to:\n  - \"backend/src/**\"\nreferences:\n  - references/checklist.md\n---\n\n# API\n\n## Stage 0（写码前强制）\n\n- [ ] 读 checklist\n\n## 硬规则\n\n| # | 规则 | 怎么查 |\n|---|---|---|\n| R1 | 示例 | \`rg x\` |\n\n## 交付\n\n1. 日志\n' > .skills/api/SKILL.md && touch .skills/api/references/checklist.md"

# ── 应该拦住 ──────────────────────────────────────────────
expect "name 与目录名不一致" 1 "与目录名不一致" \
  "sed -i.bak 's/^name: backend/name: backendx/' .skills/backend/SKILL.md"

expect "缺少必备章节" 1 "缺章节「## 硬规则」" \
  "sed -i.bak 's/^## 硬规则/## 规则/' .skills/backend/SKILL.md"

expect "references 指向不存在的文件" 1 "不存在" \
  "sed -i.bak 's|references/checklist.md|references/nope.md|' .skills/backend/SKILL.md"

expect "引用其他 skill 的入口（级联）" 1 "禁止级联" \
  "printf '\n见 .skills/frontend/SKILL.md\n' >> .skills/backend/SKILL.md"

expect "stack 不在 config.stacks 里" 1 "既不在 stacks" \
  "sed -i.bak 's/^stack: backend/stack: workers/' .skills/backend/SKILL.md"

expect "缺 applies_to" 1 "缺 applies_to" \
  "sed -i.bak '/^applies_to:/,+1d' .skills/backend/SKILL.md"

expect "超过行数上限" 1 "超过上限" "mut longline"

expect "required_skills 无法解析" 1 "没有这个 skill" "mut ghost"

expect "缺 frontmatter" 1 "缺少 frontmatter" "mut nofront"

expect "外部素材声明了来源却没写 commit 锚" 1 "没写 commit 锚" "mut upstream-nosha"

expect "外部素材带 commit 锚则放行" 0 "-" "mut upstream-sha"

echo
echo "resolve-skills 自测"

# 断言不写死版本号：这几条验的是「命中哪个 skill」，不是「版本是多少」。
# 写死 v1.0.0 会让「升版」这个正常动作变成红灯，与证据里写死动态数字同类。
expect_resolve "后端文件只命中 backend" "backend  v" "e2e  v" \
  backend/src/main/java/demo/Foo.java

expect_resolve "e2e 文件只命中 e2e（不命中 frontend/src）" "e2e  v" "frontend  v" \
  frontend/tests/e2e/specs/login.spec.ts

expect_resolve "前端业务文件命中 frontend（不命中 e2e）" "frontend  v" "e2e  v" \
  frontend/src/components/Foo.vue

expect_resolve "多栈改动命中多个 skill" "命中 2 个 skill" "-" \
  backend/src/A.java frontend/src/B.vue

expect_resolve "范围外文件不加载 skill" "命中 0 个 skill" "-" \
  docs/01-requirements/a.md

expect_resolve "非 git 仓库时 --diff 明确报错而非静默" "不是 git 仓库" "-" --diff

echo
printf '通过 %d，失败 %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
