#!/usr/bin/env bash
# notify + broker 自测：票拟卡片渲染、webhook 认证、路由降级、决策回投。
#
# 全链路本地 mock（不打真网）：mock 飞书收卡片、mock GitLab 出 diffs/存文件。
# 负向重点（checklist §13）：回投失败必须显式红（422），不能静默"看起来批过了"。
# 用法：bash test/notify-broker.test.sh
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
    printf "  \033[31m✗\033[0m %s  (期望 %s，实际 %s)\n" "$1" "$3" "$2"
    fail=$((fail + 1))
  fi
}

# ---- mock 飞书：POST 全收，body 落盘 ----
mkdir -p "$TMP/feishu"
cat > "$TMP/feishu/server.mjs" <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
const dir = process.env.MOCK_DIR;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    fs.appendFileSync(`${dir}/cards.log`, body + '\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"code":0}');
  });
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(`${dir}/port`, String(srv.address().port)));
EOF
MOCK_DIR="$TMP/feishu" node "$TMP/feishu/server.mjs" &
FEISHU_PID=$!
for _ in $(seq 1 50); do [ -f "$TMP/feishu/port" ] && break; sleep 0.1; done
FEISHU_PORT="$(cat "$TMP/feishu/port")"
feishu_cards() { [ -f "$TMP/feishu/cards.log" ] && wc -l < "$TMP/feishu/cards.log" | tr -d ' ' || echo 0; }

# ---- mock GitLab：diffs / 文件读写，行为可切换 ----
mkdir -p "$TMP/gitlab"
echo ok > "$TMP/gitlab/mode"
cat > "$TMP/gitlab/rs.md" <<'EOF'
# RS-X
## 7 开放问题
| 编号 | 问题 | 状态 |
|---|---|---|
| OP-1 | 用哪个方案 | 开放 |
EOF
cat > "$TMP/gitlab/server.mjs" <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
const dir = process.env.MOCK_DIR;
const RS = fs.readFileSync(`${dir}/rs.md`, 'utf8');
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const mode = fs.readFileSync(`${dir}/mode`, 'utf8').trim();
    fs.appendFileSync(`${dir}/requests.log`, `${req.method} ${req.url} ${body}\n`);
    if (req.url.includes('/diffs')) {
      if (mode === 'diffs500') { res.writeHead(500); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ new_path: 'docs/01-requirements/RS-x.md' }]));
      return;
    }
    if (req.method === 'GET' && req.url.includes('/repository/files/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: Buffer.from(RS).toString('base64') }));
      return;
    }
    if (req.method === 'PUT' && req.url.includes('/repository/files/')) {
      const p = JSON.parse(body);
      fs.writeFileSync(`${dir}/written-content.txt`, p.content);
      fs.writeFileSync(`${dir}/written-message.txt`, p.commit_message);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"file_path":"ok"}');
      return;
    }
    res.writeHead(404); res.end('{}');
  });
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(`${dir}/port`, String(srv.address().port)));
EOF
sed -i '' "s|req.on('end', => {}).on('end', () => {|req.on('end', () => {|" "$TMP/gitlab/server.mjs"
MOCK_DIR="$TMP/gitlab" node "$TMP/gitlab/server.mjs" &
GITLAB_PID=$!
for _ in $(seq 1 50); do [ -f "$TMP/gitlab/port" ] && break; sleep 0.1; done
GITLAB_PORT="$(cat "$TMP/gitlab/port")"
# grep -c 无匹配时打印 0 且退出码 1：`&& … || echo 0` 会二次输出（0\n0），算术展开直接炸
gl_puts() {
  if [ -f "$TMP/gitlab/requests.log" ]; then grep -c '^PUT' "$TMP/gitlab/requests.log" || true; else echo 0; fi
}

# ---- broker fixture：rules + config ----
mkdir -p "$TMP/rules"
cp "$HERE/harness.rules.json" "$TMP/rules/"

echo "== 1. 卡片渲染（纯函数） =="
cat > "$TMP/ev-decision.json" <<'EOF'
{ "kind": "decision", "task": "demo-task", "rs_path": "docs/01-requirements/RS-x.md", "project_id": 1, "branch": "main",
  "blocker_id": "OP-1", "role": "技术负责人", "question": "选 A 还是 B？",
  "options": [ { "key": "A", "label": "方案 A" }, { "key": "B", "label": "方案 B" } ] }
EOF
node "$HERE/scripts/lib/notify.mjs" --event "$TMP/ev-decision.json" > "$TMP/card.json" 2>/dev/null
check "决策卡片 msg_type=interactive" "interactive" "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).msg_type)' "$TMP/card.json")"
check "每个选项一个按钮（票拟）" "2" "$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.card.elements.flatMap(e=>e.actions||[]).length)' "$TMP/card.json")"
check "按钮 value 携带回投上下文" "decision|demo-task|OP-1|A" "$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=c.card.elements.flatMap(e=>e.actions||[])[0].value;console.log([v.k,v.task,v.blocker_id,v.choice].join("|"))' "$TMP/card.json")"
cat > "$TMP/ev-bad.json" <<'EOF'
{ "kind": "decision", "task": "x" }
EOF
node "$HERE/scripts/lib/notify.mjs" --event "$TMP/ev-bad.json" >/dev/null 2>&1
check "缺 options 的决策事件 → 拒渲染（非 0）" "1" "$?"
node "$HERE/scripts/lib/notify.mjs" --event "$TMP/ev-decision.json" --webhook "http://127.0.0.1:${FEISHU_PORT}" >/dev/null 2>&1
check "webhook 发送成功且落账" "0" "$?"
grep -q '"type":"card_sent"' "$TMP/ledger/events.jsonl"; check "events.jsonl 记 card_sent" "0" "$?"

echo "== 2. broker：健康与认证 =="
PORT_BROKER=0 \
GITLAB_WEBHOOK_SECRET=s3cret GITLAB_URL="http://127.0.0.1:${GITLAB_PORT}" GITLAB_TOKEN=gt \
FEISHU_WEBHOOK_URL="http://127.0.0.1:${FEISHU_PORT}" HARNESS_RULES_ROOT="$TMP/rules" \
FEISHU_VERIFY_TOKEN=fs-verify \
FEISHU_NAME_MAP='{"ou_123":"张三"}' \
node "$HERE/scripts/harness-broker.mjs" --port 0 > "$TMP/broker.out" 2>/dev/null &
BROKER_PID=$!
for _ in $(seq 1 50); do [ -s "$TMP/broker.out" ] && break; sleep 0.1; done
BPORT="$(sed -n 's/^PORT //p' "$TMP/broker.out")"
curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${BPORT}/healthz" > "$TMP/code"
check "healthz → 200" "200" "$(cat "$TMP/code")"

mr_payload() { cat <<EOF
{ "object_kind": "merge_request", "project": { "id": 1, "name": "demo" }, "user": { "name": "李四" },
  "object_attributes": { "action": "open", "iid": 7, "title": "RS: 新需求", "url": "http://gl/mr/7", "source_branch": "feat/rs" } }
EOF
}
curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'x-gitlab-token: wrong' \
  -d "$(mr_payload)" "http://127.0.0.1:${BPORT}/webhook/gitlab" > "$TMP/code"
check "webhook token 不匹配 → 403" "403" "$(cat "$TMP/code")"

# 飞书侧：登记回调地址时会先打一次 url_verification，要求原样回显 challenge。
# 不回显 = 地址配不上，后面的按钮一个也点不出来（原实现回 400「未知卡片动作」）。
curl -s -X POST -H 'content-type: application/json' \
  -d '{"type":"url_verification","challenge":"abc123"}' "http://127.0.0.1:${BPORT}/webhook/feishu" > "$TMP/ch.json"
check "飞书 URL 校验回显 challenge" "abc123" "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).challenge)' "$TMP/ch.json")"

# 回投是全系统唯一会写仓库的路径，且 operator.open_id 由调用方给：
# 不验签就等于允许任何人以任意人的名义批红。这里锁住"没带 token 就进不去 git 写流程"。
puts_before_auth=$(gl_puts)
curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{ "action": { "value": { "k": "decision", "task": "demo-task", "rs_path": "docs/01-requirements/RS-x.md",
        "project_id": 1, "branch": "main", "blocker_id": "OP-1", "choice": "A" } },
       "operator": { "open_id": "ou_123" } }' \
  "http://127.0.0.1:${BPORT}/webhook/feishu" > "$TMP/code"
check "回投未带校验 token → 403" "403" "$(cat "$TMP/code")"
check "被拒的回投不产生 GitLab 提交" "$puts_before_auth" "$(gl_puts)"
curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{ "token": "wrong", "action": { "value": { "k": "decision", "task": "demo-task", "rs_path": "docs/01-requirements/RS-x.md",
        "project_id": 1, "branch": "main", "blocker_id": "OP-1", "choice": "A" } },
       "operator": { "open_id": "ou_123" } }' \
  "http://127.0.0.1:${BPORT}/webhook/feishu" > "$TMP/code"
check "回投 token 不匹配 → 403" "403" "$(cat "$TMP/code")"

echo "== 3. MR 事件路由 → 卡片找人 =="
cards_before=$(feishu_cards)
curl -s -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' \
  -d "$(mr_payload)" "http://127.0.0.1:${BPORT}/webhook/gitlab" > "$TMP/resp.json"
check "MR 路由返回 rs+evidence" "rs" "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.reviews.filter(r=>r!=="evidence").join(","))' "$TMP/resp.json")"
check "飞书收到 1 张卡片" "$((cards_before + 1))" "$(feishu_cards)"
tail -1 "$TMP/feishu/cards.log" | grep -q '需求规格审核'; check "卡片含审核类型与批红角色" "0" "$?"

echo diffs500 > "$TMP/gitlab/mode"
curl -s -o /dev/null -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' \
  -d "$(mr_payload)" "http://127.0.0.1:${BPORT}/webhook/gitlab"
check "diffs 接口 5xx → 通知降级仍送达（fail-open）" "$((cards_before + 2))" "$(feishu_cards)"
tail -1 "$TMP/feishu/cards.log" | grep -q '降级'; check "降级卡片含说明" "0" "$?"
echo ok > "$TMP/gitlab/mode"

echo "== 4. pipeline 失败与 digest =="
curl -s -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' \
  -d '{ "object_kind": "pipeline", "project": { "name": "demo" }, "user": { "name": "王五" },
       "object_attributes": { "status": "failed", "ref": "main", "sha": "abc1234def" } }' \
  "http://127.0.0.1:${BPORT}/webhook/gitlab" > /dev/null
check "pipeline 失败 → 失败卡片" "$((cards_before + 3))" "$(feishu_cards)"
curl -s -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' \
  -d '{ "object_kind": "push", "project": { "id": 1 } }' "http://127.0.0.1:${BPORT}/webhook/gitlab" > "$TMP/resp.json"
node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).digest)' "$TMP/resp.json" > "$TMP/d.txt"
check "非卡片事件走 digest（不推飞书）" "true" "$(cat "$TMP/d.txt")"
check "digest 不产生新卡片" "$((cards_before + 3))" "$(feishu_cards)"

echo "== 5. 决策回投（批红落账） =="
puts_before=$(gl_puts)
curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{ "token": "fs-verify", "action": { "value": { "k": "decision", "task": "demo-task", "rs_path": "docs/01-requirements/RS-x.md",
        "project_id": 1, "branch": "main", "blocker_id": "OP-1", "choice": "A" } },
       "operator": { "open_id": "ou_123" } }' \
  "http://127.0.0.1:${BPORT}/webhook/feishu" > "$TMP/code"
check "卡片回调 → 200 落账" "200" "$(cat "$TMP/code")"
check "GitLab 收到 1 次文件提交" "$((puts_before + 1))" "$(gl_puts)"
grep -q '已裁决：A（张三' "$TMP/gitlab/written-content.txt"; check "RS 开放问题行写入结论+批红人" "0" "$?"
grep -q 'OP-1 = A（by 张三）' "$TMP/gitlab/written-message.txt"; check "commit message 带身份与结论" "0" "$?"
curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{ "token": "fs-verify", "action": { "value": { "k": "decision", "task": "demo-task", "rs_path": "docs/01-requirements/RS-x.md",
        "project_id": 1, "branch": "main", "blocker_id": "OP-99", "choice": "A" } },
       "operator": { "open_id": "ou_123" } }' \
  "http://127.0.0.1:${BPORT}/webhook/feishu" > "$TMP/code"
check "账实不符（OP 不存在）→ 422 显式红" "422" "$(cat "$TMP/code")"
check "失败回投不产生新提交" "$((puts_before + 1))" "$(gl_puts)"

kill $BROKER_PID $FEISHU_PID $GITLAB_PID 2>/dev/null
wait $BROKER_PID $FEISHU_PID $GITLAB_PID 2>/dev/null
echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
