#!/usr/bin/env bash
# notify + broker 自测：票拟卡片渲染、webhook 认证、路由降级、决策回投。
#
# 全链路本地 mock（不打真网）：mock 飞书收卡片、mock GitLab 出 diffs/存文件。
# 负向重点（checklist §13）：回投失败必须显式红（422），不能静默"看起来批过了"。
# 用法：bash test/notify-broker.test.sh
set -uo pipefail

# 本地自测只连 127.0.0.1：显式绕过环境里的 http_proxy。
# 否则机器上配了代理时，curl 会把发往临时端口的请求送给上游，结果是
# "502 upstream connect failed"——测的成了代理通不通，不是被测代码对不对。
export NO_PROXY='*' no_proxy='*'

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
    // 方案 D：读某个 commit 的 diff。真实 GitLab 用 /repository/commits/:sha/diff，
    // 不含 `/diffs` 子串，所以不会和上面的 MR diffs 分支撞。
    if (req.url.includes('/repository/commits/')) {
      if (mode === 'commitdiff500') { res.writeHead(500); res.end('{}'); return; }
      // 按 sha 取 patch：一个 push 可以带多个 commit，每个 commit 的 diff 不一样
      // （合并场景里原提交和合并提交都改了同一行），共用一份 patch 测不出跨 commit 去重。
      const sha = decodeURIComponent(req.url.split('/repository/commits/')[1].split('/')[0]);
      const per = `${dir}/commit-diff-${sha}.patch`;
      const diff = fs.readFileSync(fs.existsSync(per) ? per : `${dir}/commit-diff.patch`, 'utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ new_path: 'docs/01-requirements/RS-x.md', diff }]));
      return;
    }
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

# 绑定面必须自证：排查"宿主 curl 200、GitLab 报 internal error"时，缺的正是这一句。
bind="$(curl -s "http://127.0.0.1:${BPORT}/healthz" | sed -n 's/.*"bind":"\([^"]*\)".*/\1/p')"
check "healthz 报出实际绑定面（默认回环）" "127.0.0.1:${BPORT}（仅本机回环）" "$bind"
grep -q '只绑回环' "$TMP/broker.out" && r=ok || r=bad
check "回环启动时日志点明后果（容器里的 GitLab 打不进来）" ok "$r"

# 反过来：显式对外监听时不能再提示"打不进来"，否则这条提示就变成噪音被无视。
HOST=0.0.0.0 GITLAB_WEBHOOK_SECRET=s3cret HARNESS_RULES_ROOT="$TMP/rules" FEISHU_VERIFY_TOKEN=fs-verify \
  node "$HERE/scripts/harness-broker.mjs" --port 0 > "$TMP/broker-open.out" 2>/dev/null &
OPEN_PID=$!
for _ in $(seq 1 50); do [ -s "$TMP/broker-open.out" ] && break; sleep 0.1; done
open_port="$(sed -n 's/^PORT //p' "$TMP/broker-open.out")"
open_bind="$(curl -s "http://127.0.0.1:${open_port}/healthz" | sed -n 's/.*"bind":"\([^"]*\)".*/\1/p')"
check "对外监听时报出所有 IPv4 网卡" "0.0.0.0:${open_port}（所有 IPv4 网卡）" "$open_bind"
grep -q '只绑回环' "$TMP/broker-open.out" && r=bad || r=ok
check "对外监听时不再喊「打不进来」" ok "$r"
kill "$OPEN_PID" 2>/dev/null

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

# 配置坏了：router / ai-review 是 exit 2，broker 不能变成 HTTP 500。
# 500 的后果是 GitLab 反复重投 + 这次连账都不记，排查时只剩对方日志里一串 500。
# 正确姿态是「接住、但不装没事」：200 + 明确原因，卡片与账本都留痕。
echo '{"projects":"backend"}' > "$TMP/rules/harness.config.json"
curl -s -o "$TMP/resp-cfg.json" -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' \
  -d "$(mr_payload)" "http://127.0.0.1:${BPORT}/webhook/gitlab" > "$TMP/code"
check "config 形状错 → 200（不把 5xx 甩给 GitLab 反复重投）" "200" "$(cat "$TMP/code")"
check "响应里点明配置错误" "1" \
  "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.config_error?1:0)' "$TMP/resp-cfg.json")"
tail -1 "$TMP/feishu/cards.log" | grep -q 'harness.config.json 有问题'; check "卡片写明是配置坏了（不是「没命中审核」）" "0" "$?"
grep -q '"type":"mr_route_config_error"' "$TMP/ledger/events.jsonl"; check "账本单记一条 mr_route_config_error" "0" "$?"
grep -q '"type":"mr_routed".*"config_error":"' "$TMP/ledger/events.jsonl"; check "mr_routed 也带 config_error（不漏记）" "0" "$?"
rm -f "$TMP/rules/harness.config.json"
cards_after_cfg=$(feishu_cards)

echo "== 4. pipeline 失败与 digest =="
curl -s -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' \
  -d '{ "object_kind": "pipeline", "project": { "name": "demo" }, "user": { "name": "王五" },
       "object_attributes": { "status": "failed", "ref": "main", "sha": "abc1234def" } }' \
  "http://127.0.0.1:${BPORT}/webhook/gitlab" > /dev/null
check "pipeline 失败 → 失败卡片" "$((cards_after_cfg + 1))" "$(feishu_cards)"
curl -s -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' \
  -d '{ "object_kind": "push", "project": { "id": 1 } }' "http://127.0.0.1:${BPORT}/webhook/gitlab" > "$TMP/resp.json"
node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).digest)' "$TMP/resp.json" > "$TMP/d.txt"
check "非卡片事件走 digest（不推飞书）" "true" "$(cat "$TMP/d.txt")"
check "digest 不产生新卡片" "$((cards_after_cfg + 1))" "$(feishu_cards)"

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

echo "== 6. 方案 D：决策走 git（零入站口） =="
# 人在 RS 文档里把开放问题那行改成「已裁决：X」并提交，broker 从 push 的 diff 里读。
# 这条路只用「GitLab → broker」这条内网边，飞书侧连回调都不用配。
cat > "$TMP/gitlab/commit-diff.patch" <<'EOF'
@@ -4,3 +4,4 @@
-| OP-1 | 用哪个方案 | 开放 |
+| OP-1 | 用哪个方案 | 已裁决：A（张三 @ 2026-11-06 16:00 git 批红） |
+| OP-2 | 灰度还是全量 | 开放 |
+| OP-3 | 保留旧结论 | 已废止 |
@@ -8,1 +9,1 @@
-| OP-9 | 改判 | 已裁决：Z |
+| OP-9 | 改判 | 已裁决：Y |
@@ -12,1 +12,0 @@
-| OP-8 | 这一行被整行删掉了 | 已裁决：W |
EOF

push_payload() { cat <<EOF
{ "object_kind": "push", "ref": "${3:-refs/heads/main}", "project": { "id": 1, "path": "demo" },
  "user_name": "$1", "user_email": "$2",
  "commits": [ { "id": "${4:-abc1234def}", "author": { "name": "$1", "email": "$2" },
                 "added": [], "modified": ["docs/01-requirements/RS-x.md"] } ] }
EOF
}
landed_of() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((j.landed||[]).map(d=>d.blocker_id+"="+d.choice).join(","))' "$1" 2>/dev/null || echo '<parse-error>'; }

puts_before_git=$(gl_puts)
curl -s -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' \
  -d "$(push_payload 张三 zhangsan@corp.com)" "http://127.0.0.1:${BPORT}/webhook/gitlab" > "$TMP/push.json"
check "push 里的「已裁决」被读成决策" "OP-1=A,OP-9=Y" "$(landed_of "$TMP/push.json")"
grep -q '"type":"decision_landed".*"via":"git"' "$TMP/ledger/events.jsonl"; check "账本记 decision_landed via git" "0" "$?"
grep -q '"type":"decision_landed".*"by":"张三"' "$TMP/ledger/events.jsonl"; check "落账带 commit author 身份" "0" "$?"
check "读 git 的决策不写仓库（commit 本身就是账）" "$puts_before_git" "$(gl_puts)"

# 状态还是「开放」、或者写成「已废止」的行都不能算决策——否则满篇都是假批红。
# 孤立删除行（OP-8 整行被删）是这条的关键用例：如果解析器连 `-` 行也认，
# 删掉一条旧结论就会被当成"又批了一次"。上面 OP-9 的改判盖不住它——那种写法里
# 减号行后面紧跟同编号的加号行，会被后者覆盖，缺陷正好被藏起来。
check "作废的旧结论（-行）不被采纳" "0" "$(grep -c '"choice":"W"' "$TMP/ledger/events.jsonl" || true)"

curl -s -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' \
  -d "$(push_payload 张三 zhangsan@corp.com)" "http://127.0.0.1:${BPORT}/webhook/gitlab" > "$TMP/push2.json"
check "同一 commit 重推（force push 会重放）不重复落账" "" "$(landed_of "$TMP/push2.json")"

curl -s -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' \
  -d "$(push_payload 张三 zhangsan@corp.com refs/heads/feat/x sha-feature)" "http://127.0.0.1:${BPORT}/webhook/gitlab" > "$TMP/push3.json"
check "非默认分支的改动不算结论（还没生效）" "" "$(landed_of "$TMP/push3.json")"

# MR 合并的真实形状（L2 实测）：一次合并的 push 里既有原提交、也有合并提交。
# 合并提交的 diff 相对第一父就是整条分支的净变更，于是同一个 OP 被投第二次，
# 而它的 author 是**合并者**。全收的后果：一次批红落两条账，账本看起来是两个人批的。
cat > "$TMP/gitlab/commit-diff-c0ffee01.patch" <<'EOF'
@@ -1,1 +1,1 @@
-| OP-5 | 合并进来的结论 | 开放 |
+| OP-5 | 合并进来的结论 | 已裁决：E（张三 @ 2026-11-07 10:00 git 批红） |
EOF
cat > "$TMP/gitlab/commit-diff-c0ffee02.patch" <<'EOF'
@@ -1,1 +1,1 @@
-| OP-5 | 合并进来的结论 | 开放 |
+| OP-5 | 合并进来的结论 | 已裁决：E（张三 @ 2026-11-07 10:00 git 批红） |
EOF
curl -s -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' -d @- \
  "http://127.0.0.1:${BPORT}/webhook/gitlab" > "$TMP/push-merge.json" <<'EOF'
{ "object_kind": "push", "ref": "refs/heads/main", "project": { "id": 1, "path": "demo" },
  "user_name": "李四", "user_email": "lisi@corp.com",
  "commits": [
    { "id": "c0ffee01", "author": { "name": "张三", "email": "zhangsan@corp.com" },
      "added": [], "modified": ["docs/01-requirements/RS-x.md"] },
    { "id": "c0ffee02", "author": { "name": "李四", "email": "lisi@corp.com" },
      "added": [], "modified": ["docs/01-requirements/RS-x.md"] } ] }
EOF
check "合并 push 只落一条账" "OP-5=E" "$(landed_of "$TMP/push-merge.json")"
check "落账身份是真正改文档的人（张三），不是合并的人（李四）" "1" \
  "$(grep -c '"blocker":"OP-5".*"by":"张三"' "$TMP/ledger/events.jsonl" || true)"
check "合并提交不额外落账（李四那条被认作重复投影）" "0" \
  "$(grep -c '"blocker":"OP-5".*"by":"李四"' "$TMP/ledger/events.jsonl" || true)"

# 同一 push 内真的改判（OP 的结论变了）则取最终状态——去重不能把改判也吃掉
cat > "$TMP/gitlab/commit-diff-c0ffee03.patch" <<'EOF'
@@ -1,1 +1,1 @@
-| OP-6 | 改判 | 已裁决：X |
+| OP-6 | 改判 | 已裁决：Y |
EOF
cat > "$TMP/gitlab/commit-diff-c0ffee04.patch" <<'EOF'
@@ -1,1 +1,1 @@
-| OP-6 | 改判 | 已裁决：Y |
+| OP-6 | 改判 | 已裁决：Z |
EOF
curl -s -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' -d @- \
  "http://127.0.0.1:${BPORT}/webhook/gitlab" > "$TMP/push-revote.json" <<'EOF'
{ "object_kind": "push", "ref": "refs/heads/main", "project": { "id": 1, "path": "demo" },
  "user_name": "张三", "user_email": "zhangsan@corp.com",
  "commits": [
    { "id": "c0ffee03", "author": { "name": "张三", "email": "zhangsan@corp.com" },
      "added": [], "modified": ["docs/01-requirements/RS-x.md"] },
    { "id": "c0ffee04", "author": { "name": "张三", "email": "zhangsan@corp.com" },
      "added": [], "modified": ["docs/01-requirements/RS-x.md"] } ] }
EOF
check "同一 push 里改判取最终结论" "OP-6=Z" "$(landed_of "$TMP/push-revote.json")"

# 配了 approvers 就是 fail-closed：不是名单里的人改的，记 rejected 但不落账
node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));j.notify.git_decision.approvers=["tech@corp.com"];fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")' "$TMP/rules/harness.rules.json"
curl -s -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' \
  -d "$(push_payload 李四 lisi@corp.com refs/heads/main sha-outsider)" "http://127.0.0.1:${BPORT}/webhook/gitlab" > "$TMP/push4.json"
check "approvers 名单外的人改的不落账" "" "$(landed_of "$TMP/push4.json")"
grep -q '"type":"decision_rejected".*"reason":"author_not_approver"' "$TMP/ledger/events.jsonl"; check "名单外记 decision_rejected 留痕" "0" "$?"
curl -s -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' \
  -d "$(push_payload 陈五 tech@corp.com refs/heads/main sha-insider)" "http://127.0.0.1:${BPORT}/webhook/gitlab" > "$TMP/push5.json"
check "名单内的人改的照常落账" "OP-1=A,OP-9=Y" "$(landed_of "$TMP/push5.json")"

# 读不到 diff 时不能把 push 打成 5xx（GitLab 会重试，重试也读不到），但必须留痕
echo commitdiff500 > "$TMP/gitlab/mode"
curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'x-gitlab-token: s3cret' \
  -d "$(push_payload 张三 zhangsan@corp.com refs/heads/main sha-nodiff)" "http://127.0.0.1:${BPORT}/webhook/gitlab" > "$TMP/code"
check "diff 接口 5xx 时 push 仍返回 200" "200" "$(cat "$TMP/code")"
grep -q '"type":"decision_landed_failed"' "$TMP/ledger/events.jsonl"; check "读不到 diff 显式留痕（不静默当没决策）" "0" "$?"
echo ok > "$TMP/gitlab/mode"

echo "== 7. link 模式卡片：不依赖任何回调 =="
# 纯内网部署（不配长连接、也没有公网回调）时，决策卡必须是"可点的链接"，
# 而不是"N 个点了没反应的按钮"——后者是这套东西上线后最常见的"配好了但点不动"。
HARNESS_DECISION_MODE=link GITLAB_URL="http://gitlab.internal" \
  node "$HERE/scripts/lib/notify.mjs" --event "$TMP/ev-decision.json" > "$TMP/card-link.json" 2>/dev/null
link_actions() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const a=c.card.elements.flatMap(e=>e.actions||[]);console.log(a.length)' "$TMP/card-link.json"; }
check "link 模式只给一个按钮（不是 N 个都跳同一页）" "1" "$(link_actions)"
check "按钮自带 url（点了直接开编辑页，不经 broker）" \
  "http://gitlab.internal/-/edit/main/docs/01-requirements/RS-x.md" \
  "$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.card.elements.flatMap(e=>e.actions||[])[0].url||"")' "$TMP/card-link.json")"
check "link 模式不再生成 decision value（没有回调可回）" \
  "guide" \
  "$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.card.elements.flatMap(e=>e.actions||[])[0].value.k)' "$TMP/card-link.json")"
grep -q 'OP-1' "$TMP/card-link.json"; check "正文点名要改哪一行（OP-1）" "0" "$?"

# callback 模式不能被上面这次改动带跑：MR 卡的「去处理」现在也自带 url，
# 否则即使配了回调，k:'open' 也会被 broker 当"未知卡片动作"打回 400。
cat > "$TMP/ev-mr.json" <<'EOF'
{ "kind": "mr", "mr": { "iid": 7, "title": "演示", "url": "http://gitlab.internal/demo/-/merge_requests/7" },
  "reviews": [ { "id": "rs", "title": "需求规格审核", "approval_role": "pm" } ] }
EOF
node "$HERE/scripts/lib/notify.mjs" --event "$TMP/ev-mr.json" > "$TMP/card-mr.json" 2>/dev/null
check "MR 卡「去处理」按钮自带 url" "http://gitlab.internal/demo/-/merge_requests/7" \
  "$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.card.elements.flatMap(e=>e.actions||[])[0].url||"")' "$TMP/card-mr.json")"

echo "== 8. 相对路径启动（P1-10 回归：文档写法必须真的能启动） =="
# 文件头与 guides 写的启动命令都是相对路径 `node scripts/harness-broker.mjs`。
# 原手拼 file:// 的主模块判定在相对路径下永不相等 → 静默退出 0：
# 照文档敲命令，服务不启动、无报错——"配好了但点不动"的最安静形态。
(cd "$HERE" && node scripts/lib/notify.mjs --event "$TMP/ev-decision.json" > "$TMP/rel-notify.out" 2>/dev/null)
grep -q '"msg_type": "interactive"' "$TMP/rel-notify.out"; check "notify CLI 相对路径正常渲染（非静默空转）" "0" "$?"
(cd "$HERE" && exec node scripts/harness-broker.mjs --port 0 > "$TMP/rel-broker.out" 2>/dev/null) &
REL_PID=$!
rel_port=""
for _ in $(seq 1 50); do rel_port="$(sed -n 's/^PORT //p' "$TMP/rel-broker.out")"; [ -n "$rel_port" ] && break; sleep 0.1; done
[ -n "$rel_port" ]; check "broker 相对路径能启动（PORT 行出现）" "0" "$?"
curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${rel_port}/healthz" > "$TMP/code"
check "相对路径 broker healthz → 200" "200" "$(cat "$TMP/code")"
kill $REL_PID 2>/dev/null
wait $REL_PID 2>/dev/null

# 同一类缺陷的第二种姿势：路径本身经过软链（macOS 上 /tmp → /private/tmp）。
# Node 把模块加载成真实路径写进 import.meta.url，argv[1] 却原样保留软链，
# 两边对不上 → 又是"输出为空、退出 0"。实测：仓库放在 /tmp 下就复现。
ln -s "$HERE" "$TMP/link-repo" 2>/dev/null
node "$TMP/link-repo/scripts/lib/notify.mjs" --event "$TMP/ev-decision.json" > "$TMP/link-notify.out" 2>/dev/null
grep -q '"msg_type": "interactive"' "$TMP/link-notify.out"; check "经软链路径调用也正常渲染（不是静默空转）" "0" "$?"

kill $BROKER_PID $FEISHU_PID $GITLAB_PID 2>/dev/null
wait $BROKER_PID $FEISHU_PID $GITLAB_PID 2>/dev/null
echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
