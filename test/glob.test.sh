#!/usr/bin/env bash
# glob 引擎自测 —— 它同时决定「写入门禁放不放行」和「证据是否过期」。
#
# 为什么要单独一套：这个语义曾经有四份实现（guard_write / verify / resolve-skills /
# review-rules），差异很细但后果具体：同一个 pattern 在门禁里命中、在 CI 里不命中，
# 于是"本地被拦、提交却能过"。四份实现里只有一份支持 {a,b}，另一份的 `a/**/b`
# 不匹配 `a/b`。这类不一致不会报错，只会让两边得出不同结论。
#
# 所以这里测两件事：
#   1. 语义本身（单层/跨层/{a,b}/转义）；
#   2. **只有一份实现**（结构断言）——有人再抄一份，这里就红。
#
# 用法：bash test/glob.test.sh     全部通过退出 0
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
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

# 把断言写在 node 里：一行一个 case，输出 ok / BAD:...
OUT="$(node --input-type=module -e '
import { globToRe } from "'"$HERE"'/hooks/lib/glob.mjs";
const cases = [
  ["单层 * 不跨目录", "*", "a/b", false],
  ["单层 * 命中同层", "*.mjs", "x.mjs", true],
  ["双星跨目录", "hooks/**", "hooks/lib/a/b.mjs", true],
  ["双星+/ 允许零层", "a/**/b", "a/b", true],
  ["双星+/ 允许多层", "a/**/b", "a/x/y/b", true],
  ["{a,b} 是或（第一项）", "**/*.{ts,vue}", "src/a/B.ts", true],
  ["{a,b} 是或（第二项）", "**/*.{ts,vue}", "B.vue", true],
  ["{a,b} 不命中第三类", "**/*.{ts,vue}", "src/a/B.java", false],
  ["{x,y}/** 目录或", "{hooks,scripts}/**/*", "scripts/lib/x.mjs", true],
  ["{x,y}/** 不越界", "{hooks,scripts}/**/*", "templates/x.mjs", false],
  ["正则元字符被转义", "a.b", "axb", false],
  ["点号按字面匹配", "a.b", "a.b", true],
  ["任务目录单层", ".ai/tasks/*/state.json", ".ai/tasks/demo/state.json", true],
  ["任务目录不跨层", ".ai/tasks/*/state.json", ".ai/tasks/a/b/state.json", false],
  ["凭据豁免写法", "**/.env.example", "x/y/.env.example", true],
];
const bad = [];
for (const [name, glob, value, want] of cases) {
  const got = globToRe(glob).test(value);
  if (got !== want) bad.push(`${name}（${glob} vs ${value} → ${got}）`);
}
console.log(bad.length ? "BAD " + bad.join(" | ") : "ok");
' 2>&1)"
check "语义 15 条" "ok" "$OUT"

echo "== 2. 只有一份实现（结构断言）=="
# 再抄一份的典型形态就是重新写一个 function globTo…。这份断言让"抽库"不会回退。
LOCAL_IMPL="$(grep -rn "function globTo" --include=*.mjs "$HERE/hooks" "$HERE/scripts" 2>/dev/null | grep -v "hooks/lib/glob.mjs" | wc -l | tr -d ' ')"
check "除 hooks/lib/glob.mjs 外没有第二份 glob 实现" "0" "$LOCAL_IMPL"

for f in hooks/guard_write.mjs hooks/lib/verify.mjs scripts/resolve-skills.mjs scripts/lib/review-rules.mjs; do
  grep -q "glob.mjs" "$HERE/$f" && r=0 || r=1
  check "$f 引用共享引擎" 0 "$r"
done

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
