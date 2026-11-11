#!/usr/bin/env bash
# ai-review 自测：L0 机器判据 + 模式 B 单发 + fail-closed + token 计量。
#
# 模型端点用本地 mock（不打真网）：requests.log 记每个请求，mode/response.json 控制行为。
# 核心负向判据（checklist §3）：解析失败/端点 5xx/缺凭据，绝不允许产出"通过"。
# 用法：bash test/ai-review.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HARNESS_LEDGER_DIR="$TMP/ledger"

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

# ---- fixture 仓库：rules + config + 清单 + 被审文档（模拟落地项目布局）----
REPO="$TMP/repo"
mkdir -p "$REPO/docs/01-requirements" "$REPO/scripts/reviews" "$REPO/.ai/reviews"
cp "$HERE/harness.rules.json" "$REPO/"
cp "$HERE/scripts/reviews/rs.md" "$HERE/scripts/reviews/fs.md" "$REPO/scripts/reviews/"
echo '{ "projects": [ { "id": "docs", "lang": "md", "dir": "docs" } ] }' > "$REPO/harness.config.json"

cat > "$REPO/docs/01-requirements/RS-bad.md" <<'EOF'
# RS-坏文档
## 1 背景与痛点
缺章节的坏文档。
## 2 用户故事
### US-1 坏的
- **作为**：谁
**验收标准**
- 看起来对其实没有 GWT
## 3 核心需求
| 编号 | 需求 | 优先级 | 来源 |
|---|---|---|---|
EOF

cat > "$REPO/docs/01-requirements/RS-good.md" <<'EOF'
# RS-好文档
## 1 背景与痛点
好文档。
## 2 用户故事
### US-1 正常
- **作为**：开发
**验收标准**
- Given 已建档 When 跑审核 Then 退出码为 0
## 3 核心需求
| 编号 | 需求 | 优先级 | 来源 |
|---|---|---|---|
| R-1 | 路由 | P0 | 会话 |
## 7 开放问题
| 编号 | 问题 | 状态 |
|---|---|---|
| OP-1 | 无 | 已定 |
EOF

git -C "$REPO" init -q && git -C "$REPO" config user.email t@t && git -C "$REPO" config user.name t
git -C "$REPO" add -A && git -C "$REPO" commit -qm base

FILES="$TMP/files.txt"
printf 'docs/01-requirements/RS-bad.md\n' > "$FILES"
FILES_GOOD="$TMP/files-good.txt"
printf 'docs/01-requirements/RS-good.md\n' > "$FILES_GOOD"

# ---- mock 模型端点（OpenAI 兼容形状）----
mkdir -p "$TMP/mock"
echo ok > "$TMP/mock/mode"
echo '{"summary":"无问题","findings":[]}' > "$TMP/mock/response.json"
cat > "$TMP/mock/server.mjs" <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
const dir = process.env.MOCK_DIR;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    fs.appendFileSync(`${dir}/requests.log`, `${body}\n`);
    const mode = fs.readFileSync(`${dir}/mode`, 'utf8').trim();
    if (mode === 'http500') { res.writeHead(500); res.end('{}'); return; }
    let content;
    if (mode === 'garbage') content = 'I am not JSON at all';
    else content = fs.readFileSync(`${dir}/response.json`, 'utf8');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1234, completion_tokens: 56 } }));
  });
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(`${dir}/port`, String(srv.address().port)));
EOF
MOCK_DIR="$TMP/mock" node "$TMP/mock/server.mjs" &
MOCK_PID=$!
for _ in $(seq 1 50); do [ -f "$TMP/mock/port" ] && break; sleep 0.1; done
PORT="$(cat "$TMP/mock/port")"
reqs() { [ -f "$TMP/mock/requests.log" ] && wc -l < "$TMP/mock/requests.log" | tr -d ' ' || echo 0; }

export AI_REVIEW_BASE_URL="http://127.0.0.1:${PORT}"
export AI_REVIEW_MODEL="mock-small"
unset AI_REVIEW_API_KEY

echo "== 1. L0 机器判据：零 token 先阻断 =="
node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES" --out "$REPO/.ai/reviews" >/dev/null 2>&1
rc=$?
check "坏 RS（缺开放问题章节）→ exit 1" "1" "$rc"
check "机器判据路径零 API 调用" "0" "$(reqs)"
V="$(ls "$REPO/.ai/reviews"/rs-*.md | head -1)"
grep -q '缺必填章节「开放问题」' "$V"; check "verdict 含缺章节明细" "0" "$?"

echo "== 2. 机器判据干净 + 模型通过 =="
export AI_REVIEW_API_KEY="mock-key"
node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES_GOOD" --out "$REPO/.ai/reviews" >/dev/null 2>&1
rc=$?
check "好 RS → exit 0" "0" "$rc"
check "恰好 1 次模型调用" "1" "$(reqs)"
V="$(ls -t "$REPO/.ai/reviews"/rs-*.md | head -1)"
grep -q '^# tokens: in=1234 out=56' "$V"; check "verdict 头记录 token 用量" "0" "$?"
grep -q '"tokens_in":1234' "$TMP/ledger/events.jsonl"; check "events.jsonl 计量落账" "0" "$?"

echo "== 3. 模型返回 🔴 / 垃圾 / 5xx =="
echo '{"summary":"x","findings":[{"severity":"red","rule":"RS-A2","file":"docs/01-requirements/RS-good.md","message":"Then 不可观测"}]}' > "$TMP/mock/response.json"
node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES_GOOD" --out "$REPO/.ai/reviews2" >/dev/null 2>&1
check "模型 🔴 → exit 1" "1" "$?"
V="$(ls -t "$REPO/.ai/reviews2"/rs-*.md | head -1)"
grep -q '^# findings: red=1 yellow=0' "$V"; check "verdict 红/黄计数正确" "0" "$?"

# sed -i.bak 是 GNU/BSD 双兼容写法（既有测试的约定）；`sed -i ''` 在 GNU sed 上会把 '' 当脚本、
# 替换式当文件名——CI(ubuntu) 上退出 1 且不改测试输入（P1-9，第五轮审查）。
sed -i.bak 's|docs/01-requirements/RS-good.md|docs/01-requirements/RS-good2.md|' "$FILES_GOOD"
cp "$REPO/docs/01-requirements/RS-good.md" "$REPO/docs/01-requirements/RS-good2.md"
echo garbage > "$TMP/mock/mode"
node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES_GOOD" --out "$REPO/.ai/reviews3" >/dev/null 2>&1
check "非法 JSON 重试仍败 → exit 2" "2" "$?"

echo http500 > "$TMP/mock/mode"
node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES_GOOD" --out "$REPO/.ai/reviews3" >/dev/null 2>&1
check "端点 5xx（机器无红）→ exit 2 fail-closed" "2" "$?"
echo ok > "$TMP/mock/mode"

echo "== 4. 降级与防御 =="
node "$HERE/scripts/ai-review.mjs" --type zzz --root "$REPO" --files "$FILES" >/dev/null 2>&1
check "未知类型 → exit 2" "2" "$?"
node "$HERE/scripts/ai-review.mjs" --type evidence --root "$REPO" --files "$FILES" >/dev/null 2>&1
check "机器裁决型（evidence）拒绝走 AI → exit 2" "2" "$?"
sed 's/"rs_required_sections"/"no_such_check"/' "$HERE/harness.rules.json" > "$REPO/harness.rules.json"
node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES" >/dev/null 2>&1
check "未知机器判据 id → exit 2（不静默跳过）" "2" "$?"
cp "$HERE/harness.rules.json" "$REPO/"

# 三个入口共用 route()，配置坏掉的处置也必须一致（P2-3）。
# 这条以前只测过 router：ai-review 的 RulesError → exit 2 分支没有断言保护，
# 而"没有断言的正确"下一次就会被改成"没有断言的不正确"。
echo '{ "projects": "backend" }' > "$REPO/harness.config.json"
node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES" >/dev/null 2>&1
check "config 形状错（projects 是字符串）→ exit 2" "2" "$?"
echo '{ "projects": [ { "id": "docs", "lang": "md" } ] }' > "$REPO/harness.config.json"
node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES" >/dev/null 2>&1
check "config 形状错（项目漏 dir）→ exit 2" "2" "$?"
echo '{ "projects": [ { "id": "docs", "lang": "md", "dir": "docs" } ] }' > "$REPO/harness.config.json"

echo "== 4b. 显式降级路径必须真的不调模型 =="
# 三处口径（RS US-2、指南 §一.1「🔴 直接出，模型都不用调」、CR §0 H6「合法绕过」）都说这两条路零调用。
# 原实现把 canCall 判断放在最前，于是只要机器上配了 key，--machine-only 照调不误、
# 机器已出 🔴 也照调一次——而有 key 的 CI 正是这两个开关唯一存在的理由。
before=$(reqs)
AI_REVIEW_API_KEY="mock-key" node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" \
  --files "$FILES_GOOD" --out "$REPO/.ai/reviews4" --machine-only >/dev/null 2>&1
rc=$?
check "带 key + --machine-only → 模型 0 次调用" "$before" "$(reqs)"
check "带 key + --machine-only → exit 0（机器判据干净即通过）" "0" "$rc"

before=$(reqs)
AI_REVIEW_API_KEY="mock-key" node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" \
  --files "$FILES" --out "$REPO/.ai/reviews5" >/dev/null 2>&1
rc=$?
check "带 key + 机器判据有 🔴 → 模型 0 次调用" "$before" "$(reqs)"
check "带 key + 机器判据有 🔴 → exit 1" "1" "$rc"

echo "== 4c. fs 审核类型（演练 B3 补槽） =="
# 目录必须先建：heredoc 写不存在的路径会静默失败（set -uo 无 -e 不拦），
# 文件缺失时机器判据按「读不到→跳过」走 AI 路，断言就被 mock 罐头响应假绿/假红
mkdir -p "$REPO/docs/02-features/demo"
cat > "$REPO/docs/02-features/demo/FS-bad.md" <<'FSEOF'
# FS-坏
## 1 概述
缺章节的坏规格。
## 2 需求追溯
| US | RS 锚点 |
|---|---|
| US-1 | rs#§2 |
FSEOF
FILES_FS="$TMP/files-fs.txt"; printf 'docs/02-features/demo/FS-bad.md\n' > "$FILES_FS"
node "$HERE/scripts/ai-review.mjs" --type fs --root "$REPO" --files "$FILES_FS" --out "$REPO/.ai/reviews-fs" >/dev/null 2>&1
check "坏 FS（缺接口契约/测试要点/兼容与回滚）→ exit 1" "1" "$?"
V="$(ls "$REPO/.ai/reviews-fs"/fs-*.md | head -1)"
grep -q '缺必填章节「接口契约」' "$V"; check "verdict 点名缺失章节" "0" "$?"

echo "== 5. dry-run 与增量缓存 =="
# 回到 RS-good.md：它在 reviews2 有成功轮的缓存（§3 红结论），才能测"沿用不重跑"
sed -i.bak 's|docs/01-requirements/RS-good2.md|docs/01-requirements/RS-good.md|' "$FILES_GOOD"
echo '{"summary":"无问题","findings":[]}' > "$TMP/mock/response.json"
before=$(reqs)
node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES_GOOD" --out "$REPO/.ai/reviews2" --dry-run 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.files_total,j.files_in_bundle,j.bundle_chars>0?1:0)})' > "$TMP/dry.txt"
check "dry-run 打包统计（§3 已建缓存 → 本轮全沿用）" "1 0 1" "$(cat "$TMP/dry.txt")"
check "dry-run 零 API 调用" "$before" "$(reqs)"
# 增量：同文件正式跑（reviews2 已有缓存），全部沿用 → 不调模型；沿用的是上轮红结论 → 仍阻断
node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES_GOOD" --out "$REPO/.ai/reviews2" >/dev/null 2>&1
check "沿用上轮红结论仍阻断（exit 1）" "1" "$?"
check "未变更文件不重复调模型" "$before" "$(reqs)"
node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES_GOOD" --out "$REPO/.ai/reviews2" --dry-run 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.files_in_bundle)})' > "$TMP/dry2.txt"
check "缓存生效：打包文件数归零" "0" "$(cat "$TMP/dry2.txt")"

echo "== 5b. 缓存键绑定规则源内容（P2：规则/清单更新不得沿用旧结论）=="
bundle_count() {
  node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES_GOOD" --out "$REPO/.ai/reviews2" --dry-run 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.files_in_bundle)})'
}
# ① 正向：规则与清单都没动 → 同键命中缓存，全沿用（打包 0、0 次调用）
check "规则未变 → 命中缓存（打包文件数 0）" "0" "$(bundle_count)"
before=$(reqs)
node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES_GOOD" --out "$REPO/.ai/reviews2" >/dev/null 2>&1
check "规则未变 → 0 次模型调用" "$before" "$(reqs)"
# ② 负向：清单加一个字符 → 键变 → 缓存失效，重新打包重算（变异检验：换回旧实现这两条必红）
printf 'x' >> "$REPO/scripts/reviews/rs.md"
check "清单微改（+1 字符）→ 缓存失效（打包文件数 1）" "1" "$(bundle_count)"
before=$(reqs)
node "$HERE/scripts/ai-review.mjs" --type rs --root "$REPO" --files "$FILES_GOOD" --out "$REPO/.ai/reviews2" >/dev/null 2>&1
rc=$?
check "清单微改后重算 → 恰好 1 次模型调用" "1" "$(( $(reqs) - before ))"
check "按新清单重算（mock 无问题）→ exit 0" "0" "$rc"
ls "$REPO/.ai/reviews2"/.cache-rs-????????????.json >/dev/null 2>&1
check "缓存文件名含规则源哈希（.cache-rs-<12位>.json）" "0" "$?"
# ③ harness.rules.json 本体微改（尾部加一空格，语义不变）同样要失效：键必须同时覆盖两个规则源
printf ' ' >> "$REPO/harness.rules.json"
check "rules 微改（+1 空格）→ 缓存失效（打包文件数 1）" "1" "$(bundle_count)"

kill $MOCK_PID 2>/dev/null; wait $MOCK_PID 2>/dev/null
echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
