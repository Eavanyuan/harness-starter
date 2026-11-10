#!/usr/bin/env bash
# 飞书项目 OAuth 自测：过期判据 / 凭据落盘权限 / device 全流程 / 刷新 / token 形状 / fail-closed。
#
# 为什么要假服务器：这条路径的真实端点在"用户点同意"之前无法观测成功形态，
# 不搭假服务器就等于没测——budget 那个 ReferenceError 就是这么活下来的。
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export FEISHU_OAUTH_FILE="$TMP/creds/feishu-oauth.json"

pass=0; fail=0
check(){ if [ "$2" = "$3" ]; then printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); else printf "  \033[31m✗\033[0m %s (期望 %s，实际 %s)\n" "$1" "$3" "$2"; fail=$((fail+1)); fi; }

echo "== 1. 过期判据（无 token / 未来 / 临界 / 缺 expires_at）=="
node --input-type=module -e '
import { isExpired } from "'"$HERE"'/scripts/lib/feishu-oauth.mjs";
const now = 1_000_000_000_000;
const r = [
  isExpired(null, now),
  isExpired({}, now),
  isExpired({ access_token: "t", expires_at: now + 3600_000 }, now),
  isExpired({ access_token: "t", expires_at: now + 60_000 }, now),   // 60s 后到期 < 120s 提前量 → 视为过期
  isExpired({ access_token: "t" }, now),                              // 缺有效期
];
console.log(r.map((x) => (x ? "T" : "F")).join(""));
' > "$TMP/exp.txt" 2>&1
grep -q "^TTFTT$" "$TMP/exp.txt"; check "空/缺 token/缺有效期判过期，临界按过期" "0" "$?"
[ -s "$TMP/exp.txt" ] || cat "$TMP/exp.txt"

echo
echo "== 2. 凭据落盘：文件 0600、目录 0700 =="
node --input-type=module -e '
import { saveCredentials } from "'"$HERE"'/scripts/lib/feishu-oauth.mjs";
saveCredentials({ client_id: "cli_x", access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600_000 });
' 2>&1
# stat -f 是 macOS 专用、stat -c 是 GNU 专用——用 node 取权限，跨平台无歧义（CI 实测红）
mode_file=$(node -pe "(require('fs').statSync(process.argv[1]).mode & 0o777).toString(8)" "$FEISHU_OAUTH_FILE")
mode_dir=$(node -pe "(require('fs').statSync(process.argv[1]).mode & 0o777).toString(8)" "$(dirname "$FEISHU_OAUTH_FILE")")
check "凭据文件 0600（refresh_token 等于长期口令）" "600" "$mode_file"
check "凭据目录 0700" "700" "$mode_dir"

echo
echo "== 3. device 全流程（假服务器：注册 → 发起 → pending×2 → 成功）=="
cat > "$TMP/fake-oauth.mjs" <<'JS'
import http from 'node:http';
const state = { reg: 0, device: 0, token: 0, refresh: 0 };
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => {
    const u = req.url.split('?')[0];
    const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u === '/mcp_server/oauth/register') { state.reg++; return send({ client_id: 'cli_fake_123', client_secret: 's' }); }
    if (u === '/goapi/v5/mcp_server/oauth/device_code') {
      state.device++;
      if (!body.includes('client_id=cli_fake_123')) return send({ error: 'invalid_client' }, 400);
      return send({ device_code: 'dev-1', user_code: 'ABCD-EFG', verification_uri: 'https://x/auth', verification_uri_complete: 'https://x/auth?code=ABCD-EFG', expires_in: 600, interval: 1 });
    }
    if (u === '/mcp_server/oauth/token') {
      if (body.includes('grant_type=refresh_token')) {
        state.refresh++;
        return send({ access_token: 'at-refreshed', refresh_token: 'rt-2', expires_in: 3600, token_type: 'Bearer' });
      }
      state.token++;
      if (state.token <= 2) return send({ error: 'authorization_pending' });   // 前两次还没点
      return send({ access_token: 'at-real', refresh_token: 'rt-1', expires_in: 3600 });
    }
    send({ error: 'not_found' }, 404);
  });
});
srv.listen(0, '127.0.0.1', () => { console.log(srv.address().port); });
process.on('SIGTERM', () => { console.error(JSON.stringify(state)); process.exit(0); });
JS
node "$TMP/fake-oauth.mjs" > "$TMP/port.txt" 2> "$TMP/state.txt" &
SRV=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$TMP/port.txt" ] && break; sleep 0.2; done
PORT=$(head -1 "$TMP/port.txt")
[ -n "$PORT" ] || { echo "  ✗ 假服务器未起（端口未知）"; fail=$((fail+1)); PORT=0; }

node --input-type=module -e '
import { registerClient, startDeviceFlow, pollForToken, saveCredentials } from "'"$HERE"'/scripts/lib/feishu-oauth.mjs";
const issuer = "http://127.0.0.1:" + process.argv[1];
const reg = await registerClient({ issuer });
const dev = await startDeviceFlow({ issuer, clientId: reg.client_id });
if (!dev.verification_uri_complete.includes("ABCD-EFG")) { console.error("device 响应缺 verification_uri_complete"); process.exit(3); }
let ticks = 0;
const tok = await pollForToken({ issuer, clientId: reg.client_id, deviceCode: dev.device_code, interval: 1, expiresIn: 60,
  sleep: async () => {}, onTick: () => { ticks++; } });
saveCredentials({ client_id: reg.client_id, ...tok });
console.log(JSON.stringify({ at: tok.access_token, rt: tok.refresh_token, hasExp: Number.isFinite(tok.expires_at), ticks }));
' "$PORT" > "$TMP/flow.txt" 2>&1
grep -q '"at":"at-real"' "$TMP/flow.txt"; check "轮询穿过 pending 拿到 access_token" "0" "$?"
grep -q '"rt":"rt-1"' "$TMP/flow.txt"; check "refresh_token 一并落盘" "0" "$?"
grep -q '"hasExp":true' "$TMP/flow.txt"; check "expires_in 换算成绝对 expires_at" "0" "$?"
grep -q '"ticks":[1-9]' "$TMP/flow.txt"; check "pending 期间有等待（不是原地空转）" "0" "$?"
kill -TERM $SRV 2>/dev/null; wait $SRV 2>/dev/null

echo
echo "== 4. 刷新：过期凭据 → ensureToken 走 refresh_token 并回写 =="
node "$TMP/fake-oauth.mjs" > "$TMP/port2.txt" 2>/dev/null &
SRV2=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$TMP/port2.txt" ] && break; sleep 0.2; done
PORT2=$(head -1 "$TMP/port2.txt")
node --input-type=module -e '
import { saveCredentials, ensureToken, loadCredentials } from "'"$HERE"'/scripts/lib/feishu-oauth.mjs";
const file = process.env.FEISHU_OAUTH_FILE;
const now = Date.now();
saveCredentials({ client_id: "cli_fake_123", access_token: "at-old", refresh_token: "rt-0", expires_at: now - 1000 }, file);
const t = await ensureToken({ file, issuer: "http://127.0.0.1:" + process.argv[1] });
const after = loadCredentials(file);
console.log(JSON.stringify({ token: t, saved: after.access_token, rt: after.refresh_token, future: after.expires_at > now }));
' "$PORT2" > "$TMP/ref.txt" 2>&1
grep -q '"token":"at-refreshed"' "$TMP/ref.txt"; check "过期 → 自动刷新拿到新 token" "0" "$?"
grep -q '"saved":"at-refreshed"' "$TMP/ref.txt"; check "刷新结果回写文件（下次不再刷）" "0" "$?"
grep -q '"rt":"rt-2"' "$TMP/ref.txt"; check "新 refresh_token 覆盖旧的" "0" "$?"
grep -q '"future":true' "$TMP/ref.txt"; check "新有效期在未来" "0" "$?"
kill -TERM $SRV2 2>/dev/null; wait $SRV2 2>/dev/null

echo
echo "== 5. fail-closed：认不出的 token 响应必须抛错，不能返空 =="
node --input-type=module -e '
import { normalizeToken } from "'"$HERE"'/scripts/lib/feishu-oauth.mjs";
const a = normalizeToken({ code: 0, data: { access_token: "wrapped-1", expires_in: 60 } });   // goapi 包装形态
const b = normalizeToken({ access_token: "flat-1", expires_in: 60 });
const c = normalizeToken({ code: 1, error: { id: 1 } });                                      // 认不出
console.log(JSON.stringify({ a: a?.access_token, b: b?.access_token, c: c === null }));
' > "$TMP/norm.txt" 2>&1
grep -q '"a":"wrapped-1"' "$TMP/norm.txt"; check "认 {code:0,data:{...}} 包装形态" "0" "$?"
grep -q '"b":"flat-1"' "$TMP/norm.txt"; check "认扁平形态" "0" "$?"
grep -q '"c":true' "$TMP/norm.txt"; check "认不出 → null（调用方据此报错，不静默）" "0" "$?"

echo
echo "== 6. 未登录时 ensureToken 给出可执行指引 =="
node --input-type=module -e '
import { ensureToken } from "'"$HERE"'/scripts/lib/feishu-oauth.mjs";
try { await ensureToken({ file: "/nonexistent/feishu-oauth.json" }); console.log("NO-THROW"); }
catch (e) { console.log(e.message.includes("feishu-auth.mjs login") ? "GUIDED" : "BAD:" + e.message); }
' > "$TMP/nologin.txt" 2>&1
grep -q "GUIDED" "$TMP/nologin.txt"; check "未登录 → 报错带 login 命令" "0" "$?"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
