#!/usr/bin/env bash
# doctor 门禁在场性自测（演练 B1/B2）：无 runner=阻塞、approval 不可用=提醒、未配连接=提醒。
#
# mock 一个 GitLab API（/runners 与 /approval_rules 行为可切换），不打真网。
# 注意 doctor 是对**本仓库**体检：其余检查项依赖仓库自身健康（gate 里 doctor 本就全绿），
# 这里只断言门禁在场性三档的判定与退出码语义。
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; kill ${MOCK_PID:-0} 2>/dev/null; wait ${MOCK_PID:-0} 2>/dev/null' EXIT

pass=0; fail=0
check(){ if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); else printf "  \033[31m✗\033[0m %s (期望 %s，实际 %s)\n" "$1" "$3" "$2"; fail=$((fail+1)); fi; }

mkdir -p "$TMP/mock"; echo norunner > "$TMP/mock/mode"
cat > "$TMP/mock/server.mjs" <<'MSEOF'
import http from 'node:http';
import fs from 'node:fs';
const dir = process.env.MOCK_DIR;
const srv = http.createServer((req, res) => {
  const mode = fs.readFileSync(`${dir}/mode`, 'utf8').trim();
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url.includes('/runners')) return send(200, mode === 'norunner' ? [] : [{ id: 7, active: true }]);
  if (req.url.includes('/approval_rules')) {
    if (mode === 'approval404') return send(404, { error: 'not found' });
    return send(200, mode === 'approvalset' ? [{ id: 1, approvals_required: 1 }] : []);
  }
  send(404, {});
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(`${dir}/port`, String(srv.address().port)));
MSEOF
MOCK_DIR="$TMP/mock" node "$TMP/mock/server.mjs" & MOCK_PID=$!
for _ in $(seq 1 50); do [ -f "$TMP/mock/port" ] && break; sleep 0.1; done
GP="http://127.0.0.1:$(cat "$TMP/mock/port")"

echo "== 1. 未配连接 = 提醒未检查，不是通过 =="
out="$(cd "$HERE" && env -u HARNESS_GITLAB_URL -u HARNESS_GITLAB_TOKEN -u HARNESS_GITLAB_PROJECT npm run --silent doctor 2>/dev/null)"
rc=$?
check "退出码 0（提醒不阻塞）" "0" "$rc"
grep -q "门禁在场性未检查" <<<"$out"; check "明示「未检查」而非装作通过" "0" "$?"

echo "== 2. 无活跃 runner = 阻塞（演练 B1） =="
echo norunner > "$TMP/mock/mode"
out="$(cd "$HERE" && HARNESS_GITLAB_URL="$GP" HARNESS_GITLAB_TOKEN=t HARNESS_GITLAB_PROJECT=root/x npm run --silent doctor 2>/dev/null)"
rc=$?
[ "$rc" -ne 0 ] && echo 1 > "$TMP/rc" || echo 0 > "$TMP/rc"
check "退出码非 0" "1" "$(cat "$TMP/rc")"
grep -q "CI 门禁缺位" <<<"$out"; check "报「CI 门禁缺位」并指向 B1 形态" "0" "$?"

echo "== 3. runner 在场 + approval 不可用 = 提醒（演练 B2，版本差异不算配置错） =="
echo approval404 > "$TMP/mock/mode"
out="$(cd "$HERE" && HARNESS_GITLAB_URL="$GP" HARNESS_GITLAB_TOKEN=t HARNESS_GITLAB_PROJECT=root/x npm run --silent doctor 2>/dev/null)"
rc=$?
check "退出码 0（能力差异不判红）" "0" "$rc"
grep -q "CI runner 在场" <<<"$out"; check "runner 在场计为 ok" "0" "$?"
grep -q "不支持 approval_rules" <<<"$out"; check "approval 404 → 说明性提醒" "0" "$?"

echo "== 4. 全在场 = ok =="
echo approvalset > "$TMP/mock/mode"
out="$(cd "$HERE" && HARNESS_GITLAB_URL="$GP" HARNESS_GITLAB_TOKEN=t HARNESS_GITLAB_PROJECT=root/x npm run --silent doctor 2>/dev/null)"
rc=$?
check "退出码 0" "0" "$rc"
grep -q "批准规则在场" <<<"$out"; check "approval 在场计为 ok" "0" "$?"

echo "== 5. 飞书项目 MCP 通道三档探测（task-loop 前提在场性） =="
# mock MCP：只实现 initialize/initialized/tools/call 的协议骨架，call 行为可切换（ok/perm/protocol）
mkdir -p "$TMP/fmcp"; echo perm > "$TMP/fmcp/mode"
cat > "$TMP/fmcp/server.mjs" <<'FSEOF'
import http from 'node:http';
import fs from 'node:fs';
const dir = process.env.MOCK_DIR;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const mode = fs.readFileSync(`${dir}/mode`, 'utf8').trim();
    const send = (code, obj, sid) => { res.writeHead(code, { 'content-type': 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}) }); res.end(JSON.stringify(obj)); };
    const j = body ? JSON.parse(body) : {};
    if (j.method === 'initialize') return send(200, { jsonrpc: '2.0', id: j.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mock-meego' } } }, 'sess-1');
    if (j.method === 'notifications/initialized') return send(200, {});
    if (j.method === 'tools/call') {
      if (mode === 'protocol') { res.writeHead(500); res.end('boom'); return; }
      const text = mode === 'ok' ? '[{"x":1}]' : 'error=ErrOapiCallCheckTokenPermFailed,message=Check Token Perm Failed,retriable=false';
      return send(200, { jsonrpc: '2.0', id: j.id, result: { content: [{ type: 'text', text }] } });
    }
    send(404, {});
  });
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(`${dir}/port`, String(srv.address().port)));
FSEOF
MOCK_DIR="$TMP/fmcp" node "$TMP/fmcp/server.mjs" & FMCP_PID=$!
for _ in $(seq 1 50); do [ -f "$TMP/fmcp/port" ] && break; sleep 0.1; done
FEP="http://127.0.0.1:$(cat "$TMP/fmcp/port")"
probe_level() { node -e '
  const m = await import(process.argv[1] + "/scripts/lib/feishu-project-mcp.mjs");
  const r = await m.probe(process.argv[2], { projectKey: "any" });
  console.log(r.level);
' --input-type=module "$HERE" "$FEP"; }
echo perm > "$TMP/fmcp/mode"; check "数据档未配 → perm 档（提示后台勾选，不判死）" "perm" "$(probe_level)"
echo ok > "$TMP/fmcp/mode"; check "数据档已配 → ok 档" "ok" "$(probe_level)"
echo protocol > "$TMP/fmcp/mode"; check "协议错 → error 档（不吞）" "error" "$(probe_level)"
node -e '
  const m = await import(process.argv[1] + "/scripts/lib/feishu-project-mcp.mjs");
  const r = await m.probe(null);
  console.log(r.level);
' --input-type=module "$HERE" | xargs -I{} check "无凭据 → off 档（未配置≠故障）" "off" "{}"
kill $FMCP_PID 2>/dev/null; wait $FMCP_PID 2>/dev/null

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
