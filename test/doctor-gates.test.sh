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
# 凭据文件必须隔离：doctor 现在也读 0600 的 task-loop.env（与 runner 同一份，否则
# "定时器能跑"和"doctor 说没配"会同时成立）。本机真装过定时器时那个文件里有真实 token，
# 会让下面「未配连接」这条在开发机上翻绿、在 CI 上翻红。指向空文件 = 明确不用凭据文件。
: > "$TMP/empty.env"; export HARNESS_ENV_FILE="$TMP/empty.env"

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
# 这里原来是 `| xargs -I{} check ...`：check 是 shell 函数，xargs 调不到，
# 于是这一条从未真正执行过（只打一行 xargs 报错，退出码还被管道吃掉）。
# "写了断言但从不运行"和"没有断言"在结果上完全一样，所以改成变量捕获。
OFF_LEVEL="$(node -e '
  const m = await import(process.argv[1] + "/scripts/lib/feishu-project-mcp.mjs");
  const r = await m.probe(null);
  console.log(r.level);
' --input-type=module "$HERE" 2>/dev/null)"
check "无凭据 → off 档（未配置≠故障）" "off" "$OFF_LEVEL"
kill $FMCP_PID 2>/dev/null; wait $FMCP_PID 2>/dev/null

echo "== 6. GitLab 接入地址形状（扩展项：空=不接，填错必须红） =="
# 这条以前没有判据：url 填成 API 地址时，代码再拼一次 /api/v4 → 每次 404，
# 报错长得像"接口不存在"，没人会想到是配置多了两个路径段。
node --input-type=module -e '
import { checkGitlabUrl } from "'"$HERE"'/scripts/lib/config-checks.mjs";
const cases = {
  empty: checkGitlabUrl(""),
  blank: checkGitlabUrl("   "),
  ok: checkGitlabUrl("https://gitlab.example.com"),
  okSlash: checkGitlabUrl("https://gitlab.example.com/"),
  api: checkGitlabUrl("https://gitlab.example.com/api/v4"),
  apiSlash: checkGitlabUrl("https://gitlab.example.com/api/v4/"),
  noProto: checkGitlabUrl("gitlab.example.com"),
  apiMid: checkGitlabUrl("http://git.example.com/api/v4/projects"),
};
const want = { empty: null, blank: null, ok: null, okSlash: null, api: "err", apiSlash: "err", noProto: "err", apiMid: "err" };
const got = Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, v === null ? null : "err"]));
console.log(JSON.stringify(got));
process.exit(JSON.stringify(got) === JSON.stringify(want) ? 0 : 1);' > "$TMP/glurl.txt" 2>&1
r=$?; [ "$r" -eq 0 ] || cat "$TMP/glurl.txt"
check "空/空白=不接（null）；正常地址放行；API 地址/缺协议/带 API 段 全部报错" "0" "$r"

echo "== 7. GitLab 配置解析：runner 与 doctor 必须读同一处 =="
# 上一版 runner 只认 GITLAB_*，doctor 只认 HARNESS_GITLAB_*，"我配好了"在两个进程里
# 指的不是同一件事。现在两边都走 lib/gitlab-config.mjs，这条断言盯的就是优先级本身。
mkdir -p "$TMP/home/.harness/task-loop"
printf 'file-token\n' > "$TMP/home/.harness/task-loop/gitlab-token"
chmod 600 "$TMP/home/.harness/task-loop/gitlab-token"
node --input-type=module -e '
import { resolveGitlabConfig, tokenFileMode } from "'"$HERE"'/scripts/lib/gitlab-config.mjs";
const home = process.argv[1];
const rules = { runtime: { gitlab: { url: "https://cfg.example.com/" } } };
const fromFile = resolveGitlabConfig({ rules, env: {}, home });
const envWins = resolveGitlabConfig({ rules, env: { GITLAB_TOKEN: "env-token", GITLAB_URL: "http://env.example.com" }, home });
const legacy = resolveGitlabConfig({ rules: null, env: { HARNESS_GITLAB_URL: "http://old.example.com", HARNESS_GITLAB_TOKEN: "t", HARNESS_GITLAB_PROJECT: "g/p" }, home });
const blank = resolveGitlabConfig({ rules, env: { GITLAB_TOKEN: "   ", GITLAB_URL: "" }, home });
const half = resolveGitlabConfig({ rules: { runtime: { gitlab: { url: "" } } }, env: {}, home: home + "/nohome" });
const mode = tokenFileMode({ home });
const got = {
  fileUrl: fromFile.url, fileToken: fromFile.token, fileSource: fromFile.tokenSource, fileConfigured: fromFile.configured,
  envUrl: envWins.url, envToken: envWins.token, envSource: envWins.tokenSource,
  legacyUrl: legacy.url, legacyProject: legacy.project,
  blankToken: blank.token, halfConfigured: half.configured, halfMissing: half.missing.join("/"),
  modeLoose: mode.loose, modeBits: mode.mode,
};
console.log(JSON.stringify(got, null, 0));
process.exit(JSON.stringify(got) === JSON.stringify({
  fileUrl: "https://cfg.example.com", fileToken: "file-token", fileSource: "file", fileConfigured: true,
  envUrl: "http://env.example.com", envToken: "env-token", envSource: "env",
  legacyUrl: "http://old.example.com", legacyProject: "g/p",
  blankToken: "file-token", halfConfigured: false, halfMissing: "url/token",
  modeLoose: false, modeBits: "600",
}) ? 0 : 1);' "$TMP/home" > "$TMP/glcfg.txt" 2>&1
r=$?; [ "$r" -eq 0 ] || cat "$TMP/glcfg.txt"
check "配置 url 去掉尾斜杠 / token 文件兜底 / env 覆盖 / 旧名兼容 / 空串不覆盖 / 只含一半算未接入 / 0600 不算过宽" "0" "$r"

chmod 644 "$TMP/home/.harness/task-loop/gitlab-token"
LOOSE="$(node --input-type=module -e '
import { tokenFileMode } from "'"$HERE"'/scripts/lib/gitlab-config.mjs";
const m = tokenFileMode({ home: process.argv[1] });
console.log(m ? String(m.loose) + ":" + m.mode : "none");' "$TMP/home" 2>/dev/null)"
check "0644 的 token 文件被识别为过宽" "true:644" "$LOOSE"

echo "== 8. 凭据文件：doctor 读的就是定时器那份（否则同一个问题两个答案） =="
# 定时器的凭据只在 0600 的 task-loop.env 里（plist / unit 不含秘密）。doctor 不读它的话，
# 装完定时器的机器上会同时成立两句话：「定时器在跑」与「GitLab 未接入」。
mkdir -p "$TMP/cred"; EC="$TMP/cred/task-loop.env"
printf 'GITLAB_URL=%s\nGITLAB_TOKEN=t\n' "$GP" > "$EC"; chmod 600 "$EC"
echo approvalset > "$TMP/mock/mode"
out="$(cd "$HERE" && HARNESS_ENV_FILE="$EC" HARNESS_GITLAB_PROJECT=root/x npm run --silent doctor 2>/dev/null)"
grep -q "凭据文件" <<<"$out" && grep -q "生效 2 键" <<<"$out"; check "认出 0600 文件并报出生效键数" "0" "$?"
# 文件在场时 doctor 真的用了它：url/token 只在文件里，GitLab 检查必须从"未检查"变成有结论
grep -q "门禁在场性未检查" <<<"$out"; check "凭据来自文件时不再说「未检查」" "1" "$?"
# 写成非 KEY=VALUE（比如手贴了一段命令）→ 定时器每轮都会失败，doctor 必须判红而不是放过
printf 'GITLAB_TOKEN=t\nset -a; . /tmp/x\n' > "$EC"
out="$(cd "$HERE" && HARNESS_ENV_FILE="$EC" npm run --silent doctor 2>/dev/null)"; rc=$?
check "非法行 → 退出码非 0" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
grep -q "凭据文件无法解析" <<<"$out"; check "明说解析失败并指向后果" "0" "$?"

echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1


