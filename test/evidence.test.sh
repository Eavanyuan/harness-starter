#!/usr/bin/env bash
# 证据链自测 —— 重点是"在 CI 上不误杀"。
#
# 背景：CI 跑在全新 checkout 上，git 不保存 mtime。上一版在 CI 侧也用 mtime 判新鲜度，
# 结果一份完全合规的证据（真日志、exit_code=0、审计四项齐备）在 clone 里必然判红：
# 要么"日志早于源码"，要么"找不到任何已改动的源码文件"（files: [] 的统一验证 TODO）。
# 门禁把合规 PR 判红，比不设门禁更快让人关掉它。
#
# 所以这里的第一条用例就是这个回归：干净检出 + 合规证据 → 必须通过。
#
# 用法：bash test/evidence.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/repo"
rsync -a --exclude '.git' --exclude 'node_modules' "$HERE/" "$TMP/repo/"
cd "$TMP/repo"
rm -rf .ai/tasks && mkdir -p .ai/tasks/demo .ai/verify src
: > src/A.java
git init -q
git config user.email harness@example.com
git config user.name harness

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

age() {
  local t
  t=$(node -e 'const d=new Date(Date.now()-Number(process.argv[1])*36e5);const p=n=>String(n).padStart(2,"0");console.log(`${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`)' "$2")
  touch -t "$t" "$1"
}

log() {
  cat > ".ai/verify/$1.log" <<EOF
# cmd: mvn -q test
# started: 2026-01-01T00:00:00Z
# exit_code: $2
# ---- output tail ----
BUILD SUCCESS
EOF
}

# 合规状态：T1 声明文件，V1 是统一验证（files: []）
mk_state() {
  cat > .ai/tasks/demo/state.json <<'EOF'
{
  "meta": { "task": "demo", "flow_tier": "M", "trust_level": "L1" },
  "stage": "impl",
  "stage_history": [{ "stage": "rs", "gate": "pass", "waived_by": null }],
  "todos": [
    { "id": "T1", "status": "completed", "ooda_stage": "audit", "files": ["src/A.java"],
      "audit": { "compile": true, "tests": "pass", "feature_complete": true, "quality_clean": true },
      "verify": { "log_path": ".ai/verify/T1.log" } },
    { "id": "V1", "status": "completed", "ooda_stage": "audit", "files": [],
      "audit": { "compile": true, "tests": "pass", "feature_complete": true, "quality_clean": true },
      "verify": { "log_path": ".ai/verify/V1.log" } }
  ]
}
EOF
}

ci() { local code=0; node scripts/ci-verify.mjs "$@" >/dev/null 2>"$TMP/err" || code=$?; echo "$code"; }

mk_state
log T1 0
log V1 0
git add -A
git commit -qm "compliant evidence"

echo "== 1. 干净检出 + 合规证据 → 必须通过（上一版必红的回归）=="
check "CI 口径不误杀合规证据" 0 "$(ci)"

echo "== 2. --file 只校验一份 state → 通过 =="
check "单文件校验" 0 "$(ci --file .ai/tasks/demo/state.json)"

echo "== 3. 日志 exit_code 非 0 → 拦截 =="
log T1 3
git add -A && git commit -qm "bad exit"
check "失败命令不能入库成完成态" 1 "$(ci)"
git checkout -q HEAD~1 -- .ai/verify/T1.log && git commit -qm "restore" >/dev/null

echo "== 4. 日志缺失 → 拦截 =="
rm -f .ai/verify/V1.log
git add -A && git commit -qm "drop log"
check "没有证据不算完成" 1 "$(ci)"
git checkout -q HEAD~1 -- .ai/verify/V1.log && git commit -qm "restore2" >/dev/null

echo "== 5. 日志未入库（只在本机）→ 拦截 =="
log T2 0
cp .ai/tasks/demo/state.json "$TMP/state.bak"
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.todos[1].id="T2";
  s.todos[1].verify.log_path=".ai/verify/T2.log";
  fs.writeFileSync(p, JSON.stringify(s,null,2));
'
git add .ai/tasks/demo/state.json && git commit -qm "state only, log untracked"
check "未入库日志不算证据" 1 "$(ci)"
cp "$TMP/state.bak" .ai/tasks/demo/state.json && rm -f .ai/verify/T2.log && git add -A && git commit -qm "restore3" >/dev/null

echo "== 6. waived 没有记名 → 拦截 =="
node -e '
  const fs=require("fs");const p=".ai/tasks/demo/state.json";
  const s=JSON.parse(fs.readFileSync(p,"utf8"));
  s.stage_history.push({stage:"sr",gate:"waived",waived_by:null});
  fs.writeFileSync(p, JSON.stringify(s,null,2));
'
git add -A && git commit -qm "waived without name"
check "豁免必须记名" 1 "$(ci)"
git checkout -q HEAD~1 -- .ai/tasks/demo/state.json && git commit -qm "restore4" >/dev/null

echo "== 7. --local 仍判新鲜度：日志早于源码 → 拦截 =="
age .ai/verify/T1.log 48
age .ai/verify/V1.log 48
age src/A.java 1
check "本地口径拦陈旧证据" 1 "$(ci --local)"

echo "== 8. --local 把栈内未声明的源码改动也计入（srcGlob 生效）=="
age .ai/verify/T1.log 48
age .ai/verify/V1.log 48
age src/A.java 72
: > src/B.java
age src/B.java 1
check "未声明但同栈改动的源码使旧日志失效" 1 "$(ci --local)"

echo "== 9. --local 合规（日志晚于所有源码）→ 通过 =="
age src/A.java 72
age src/B.java 72
age .ai/verify/T1.log 1
age .ai/verify/V1.log 1
check "本地口径放行新鲜证据" 0 "$(ci --local)"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
