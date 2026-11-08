#!/usr/bin/env bash
# 飞书长连接自测：内网 broker 怎么在不开入站端口的情况下，把卡片点选收回来。
#
# 假网关不是 mock 协议：它按 RFC6455 真做握手、真解析带掩码的帧、真收发 protobuf，
# 所以这里验的是"帧发得对不对"，而不是"我们的假设和我们的实现一样"。
# 负向重点：分片漏合并、重投重复提交、声明走长连接却没凭据——三种都会表现为"看着通了"。
# 用法：bash test/feishu-ws.test.sh
set -uo pipefail

# 只连 127.0.0.1：绕过环境里的 http_proxy（否则 curl 得到 502，测的是代理不是代码）
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
wait_file() { for _ in $(seq 1 100); do [ -s "$1" ] && return 0; sleep 0.1; done; return 1; }
wait_until() { for _ in $(seq 1 150); do if eval "$1"; then return 0; fi; sleep 0.1; done; return 1; }
lines_of() { [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }

jget() { node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=process.argv[2].split(".");let v=j;for(const k of p){v=v==null?undefined:v[k]}console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$1" "$2"; }
jline() { node -e 'const fs=require("fs");const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean);const j=JSON.parse(lines[Number(process.argv[2])]);const p=process.argv[3].split(".");let v=j;for(const k of p){v=v==null?undefined:v[k]}console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$1" "$2" "$3"; }
# 应答 payload 的 data 是 base64(JSON(处理结果)) —— 按协议必须先解 base64 再解 JSON，
# 直接对 payload 做字符串匹配只能看到外层 {code, data:"..."}，看不到里面到底回了什么。
ack_json() {
  node -e 'const fs=require("fs");const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n");const j=JSON.parse(L[Number(process.argv[2])-1]);const p=JSON.parse(j.payload);if(!p.data){console.log("{}");process.exit(0)}process.stdout.write(Buffer.from(p.data,"base64").toString("utf8"))' "$1" "$2"
}

# ---- mock GitLab：diffs 与文件读写（RS 里放两行开放问题，分片事件打第二行） ----
mkdir -p "$TMP/gitlab"
echo ok > "$TMP/gitlab/mode"
cat > "$TMP/gitlab/rs.md" <<'EOF'
# RS-X
## 7 开放问题
| 编号 | 问题 | 状态 |
|---|---|---|
| OP-1 | 用哪个方案 | 开放 |
| OP-2 | 灰度还是全量 | 开放 |
| OP-3 | 谁来值班 | 开放 |
EOF
cat > "$TMP/gitlab/server.mjs" <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
const dir = process.env.MOCK_DIR;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    fs.appendFileSync(`${dir}/requests.log`, `${req.method} ${req.url}\n`);
    if (req.method === 'GET' && req.url.includes('/repository/files/')) {
      const rs = fs.readFileSync(`${dir}/rs.md`, 'utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: Buffer.from(rs).toString('base64') }));
      return;
    }
    if (req.method === 'PUT' && req.url.includes('/repository/files/')) {
      const p = JSON.parse(body);
      // 模拟 GitLab 抖一次：第一次写 OP-3 直接 5xx，之后正常。
      // 判据必须看 commit_message（这次动的是哪一行），不能看 content——
      // PUT 的是整篇文档，content 里永远有 "OP-3 |" 这行，按它判会把第一次任意写入也打成 5xx。
      if (String(p.commit_message || '').includes('/OP-3 = ') && !fs.existsSync(`${dir}/failed-once`)) {
        fs.writeFileSync(`${dir}/failed-once`, '1');
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"message":"gitlab 抖了一下"}');
        return;
      }
      // 真 GitLab 提交后文件就变了；mock 也必须把内容落回 rs.md，
      // 否则第二次回投读到的是原始内容，把第一次的结论覆盖掉（测试会显示"只落了一次账"）。
      fs.writeFileSync(`${dir}/rs.md`, p.content);
      fs.writeFileSync(`${dir}/written-content.txt`, p.content);
      fs.appendFileSync(`${dir}/written-messages.txt`, p.commit_message + '\n');
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
wait_file "$TMP/gitlab/port" || { echo "mock GitLab 没起来"; exit 1; }
GITLAB_PORT="$(cat "$TMP/gitlab/port")"
gl_puts() { if [ -f "$TMP/gitlab/written-messages.txt" ]; then wc -l < "$TMP/gitlab/written-messages.txt" | tr -d ' '; else echo 0; fi; }
# 按 blocker 数落账次数：总数对不上时能立刻指认是"多落了一次"还是"少落了一次"
puts_of() { if [ -f "$TMP/gitlab/written-messages.txt" ]; then grep -c "/${1} = " "$TMP/gitlab/written-messages.txt" || true; else echo 0; fi; }

# ---- 假飞书网关：HTTP 换端点 + 真 WebSocket 服务端 ----
mkdir -p "$TMP/gw"
cat > "$TMP/gw/server.mjs" <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
const HERE = process.env.HARNESS_HOME;
const dir = process.env.MOCK_DIR;
const { encodeFrame, decodeFrame, headersToObject, FrameType, MessageType } = await import(`${HERE}/scripts/lib/feishu-frame.mjs`);
const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11D';
const log = (f, o) => fs.appendFileSync(`${dir}/${f}`, JSON.stringify(o) + '\n');
const sockets = new Set();
let conns = 0;

const cardEvent = (eventId, actionValue) => JSON.stringify({
  schema: '2.0',
  header: { event_id: eventId, event_type: 'card.action.trigger', create_time: String(Date.now()), app_id: 'cli_mock', tenant_key: 'tk' },
  event: {
    operator: { open_id: 'ou_ws' },
    action: { tag: 'button', value: actionValue },
    context: { open_message_id: 'om_card', open_chat_id: 'oc_1' },
  },
});
const value = (op, choice) => ({
  k: 'decision', task: 'ws-task', rs_path: 'docs/01-requirements/RS-x.md',
  project_id: 1, branch: 'main', blocker_id: op, choice,
});
const sent = new Map();   // message_id → 发出去的那一帧，重投要原样再发一遍
const resent = new Set(); // 每个事件最多自动重投一次，避免和 broker 的死循环把测试跑挂

function push(socket, headers, payloadBuf) {
  sent.set(headers.message_id, { headers, payloadBuf });
  send(socket, 0x2, frame(headers, payloadBuf));
}

function send(socket, opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  socket.write(Buffer.concat([head, payload]));
}
const frame = (headers, payloadBuf) => encodeFrame({
  SeqID: Number(headers.seq || 0) + 1, LogID: 0, service: 7, method: FrameType.data,
  headers: Object.entries(headers).map(([key, v]) => ({ key, value: String(v) })),
  payload: payloadBuf,
});

const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url.endsWith('/callback/ws/endpoint')) {
      log('endpoint.log', { body: JSON.parse(body || '{}'), ua: req.headers['user-agent'] || '', locale: req.headers.locale || '' });
      if (fs.readFileSync(`${dir}/mode`, 'utf8').trim() === 'reject') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 403, msg: 'app 凭据不对' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        data: {
          URL: `ws://127.0.0.1:${srv.address().port}/ws?device_id=dev-1&service_id=7`,
          ClientConfig: { PingInterval: 1, ReconnectCount: 5, ReconnectInterval: 1, ReconnectNonce: 1 },
        },
      }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
});

srv.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  conns += 1;
  const n = conns;
  log('connections.log', { n, path: req.url });

  if (n === 1) {
    setTimeout(() => {
      // 1) 单片事件：OP-1
      push(socket, { type: MessageType.event, message_id: 'm-single', sum: 1, seq: 0, trace_id: 't1' },
        Buffer.from(cardEvent('ev_a', value('OP-1', 'A'))));
      // 2) 分片事件：OP-2，从中间切开（真网关按 2MB 切，这里切在 JSON 中间也一样要能拼回）
      const full = Buffer.from(cardEvent('ev_b', value('OP-2', 'B')));
      const cut = Math.floor(full.length / 2);
      const h2 = { type: MessageType.event, message_id: 'm-split', sum: 2, seq: 0, trace_id: 't2' };
      push(socket, h2, full.subarray(0, cut));
      setTimeout(() => {
        send(socket, 0x2, frame({ ...h2, seq: 1 }, full.subarray(cut)));
        // 3) 重投：与 1) 同一个 message_id（真网关断线重连会这么干）
        setTimeout(() => {
          const s = sent.get('m-single');
          send(socket, 0x2, frame(s.headers, s.payloadBuf));
        }, 300);
        // 4) 回投会失败的事件：mock GitLab 第一次写 OP-3 就 5xx
        setTimeout(() => {
          push(socket, { type: MessageType.event, message_id: 'm-flaky', sum: 1, seq: 0, trace_id: 't4' },
            Buffer.from(cardEvent('ev_d', value('OP-3', 'C'))));
        }, 400);
        // 5) 账实不符：RS 里根本没有 OP-404，重投也没用，只该明确告诉点按钮的人
        setTimeout(() => {
          push(socket, { type: MessageType.event, message_id: 'm-miss', sum: 1, seq: 0, trace_id: 't5' },
            Buffer.from(cardEvent('ev_e', value('OP-404', 'A'))));
        }, 700);
      }, 150);
    }, 100);
  }

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (masked) { const m = buf.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      buf = buf.subarray(off + maskLen + len);

      if (opcode === 0x8) { socket.end(); return; }
      if (opcode !== 0x2) continue;
      const f = decodeFrame(payload);
      const h = headersToObject(f.headers);
      log('frames.log', {
        method: f.method, type: h.type || '', service: f.service, seqId: f.SeqID,
        messageId: h.message_id || '', bizRt: h.biz_rt || '', payload: f.payload ? f.payload.toString('utf8') : '',
      });
      // 真网关的行为：应答 code≠200 就把同一帧再投一次（同一 message_id）。
      // 测试要验的正是这个配合——broker 应答 500 之后，重投必须能被当成新事件重新处理。
      if (f.method === FrameType.data && h.message_id && sent.has(h.message_id)) {
        let body = {};
        try { body = JSON.parse(f.payload.toString('utf8')); } catch { /* 不是 JSON 就当成功 */ }
        if (body.code && body.code !== 200 && !resent.has(h.message_id)) {
          resent.add(h.message_id);
          fs.appendFileSync(`${dir}/retries.log`, `${h.message_id} code=${body.code}\n`);
          const s = sent.get(h.message_id);
          setTimeout(() => send(socket, 0x2, frame(s.headers, s.payloadBuf)), 300);
        }
      }
      if (f.method === FrameType.control && h.type === MessageType.ping) {
        send(socket, 0x2, encodeFrame({
          SeqID: 0, LogID: 0, service: 7, method: FrameType.control,
          headers: [{ key: 'type', value: MessageType.pong }],
          payload: Buffer.from(JSON.stringify({ PingInterval: 1, ReconnectCount: 5, ReconnectInterval: 1, ReconnectNonce: 1 })),
        }));
      }
    }
  });
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => sockets.delete(socket));
});

srv.listen(0, '127.0.0.1', () => fs.writeFileSync(`${dir}/port`, String(srv.address().port)));
fs.writeFileSync(`${dir}/ready`, '1');
// 测试要它断，它就断：模拟网络抖动/网关侧主动关连接
setInterval(() => {
  if (fs.existsSync(`${dir}/cut`)) {
    for (const s of sockets) { try { s.destroy(); } catch { /* 已断 */ } }
    sockets.clear();
    fs.rmSync(`${dir}/cut`, { force: true });
  }
}, 200);
EOF
echo ok > "$TMP/gw/mode"
HARNESS_HOME="$HERE" MOCK_DIR="$TMP/gw" node "$TMP/gw/server.mjs" &
GW_PID=$!
wait_file "$TMP/gw/ready" || { echo "假网关没起来"; exit 1; }
GW_PORT="$(cat "$TMP/gw/port")"

mkdir -p "$TMP/rules"
cp "$HERE/harness.rules.json" "$TMP/rules/"

start_broker() { # $1=输出文件，其余是额外 env
  local out="$1"; shift
  env "$@" PORT=0 \
    GITLAB_WEBHOOK_SECRET=s3cret GITLAB_URL="http://127.0.0.1:${GITLAB_PORT}" GITLAB_TOKEN=gt \
    HARNESS_RULES_ROOT="$TMP/rules" FEISHU_NAME_MAP='{"ou_ws":"张三"}' \
    node "$HERE/scripts/harness-broker.mjs" --port 0 > "$out" 2>"$out.err" &
  echo $!
}

echo "== 1. 声明走长连接但缺凭据 / 模式拼错 → 拒启动（fail-closed） =="
FEISHU_MODE=ws PORT=0 node "$HERE/scripts/harness-broker.mjs" --port 0 > "$TMP/nocred.out" 2>"$TMP/nocred.err"
check "ws 模式缺 app 凭据 → exit 64" "64" "$?"
grep -q 'FEISHU_APP_ID' "$TMP/nocred.err"; check "报错指明缺哪个 env" "0" "$?"
FEISHU_MODE=gopher PORT=0 node "$HERE/scripts/harness-broker.mjs" --port 0 > /dev/null 2>"$TMP/badmode.err"
check "FEISHU_MODE 拼错 → exit 64（不猜）" "64" "$?"
grep -q 'FEISHU_MODE=gopher' "$TMP/badmode.err"; check "报错原样带出错误取值" "0" "$?"

echo "== 2. 长连接建立：换端点 → 握手 → 心跳 =="
BROKER_PID="$(start_broker "$TMP/broker.out" \
  FEISHU_MODE=ws FEISHU_APP_ID=cli_mock FEISHU_APP_SECRET=s3cr3t \
  FEISHU_DOMAIN="http://127.0.0.1:${GW_PORT}")"
wait_file "$TMP/broker.out" || { echo "broker 没起来"; cat "$TMP/broker.out.err"; exit 1; }
wait_until '[ -f "$TMP/gw/connections.log" ]'
BPORT="$(sed -n 's/^PORT //p' "$TMP/broker.out")"
check "启动日志声明入站模式" "ws" "$(sed -n 's/^FEISHU_MODE //p' "$TMP/broker.out")"
check "换端点带 AppID" "cli_mock" "$(jline "$TMP/gw/endpoint.log" 0 body.AppID)"
check "换端点带 AppSecret" "s3cr3t" "$(jline "$TMP/gw/endpoint.log" 0 body.AppSecret)"
check "换端点带 locale（网关按它回中文错误）" "zh" "$(jline "$TMP/gw/endpoint.log" 0 locale)"
check "WebSocket 握手成功（网关记录到连接）" "1" "$(lines_of "$TMP/gw/connections.log")"
check "连的是网关下发的 device_id/service_id" "1" "$(grep -c 'device_id=dev-1&service_id=7' "$TMP/gw/connections.log" || true)"

# 心跳帧：service 必须是网关下发的 service_id（这里 7），method=control
wait_until 'grep -q "\"type\":\"ping\"" "$TMP/gw/frames.log" 2>/dev/null'
check "收到应用层心跳" "1" "$(grep -c '"type":"ping"' "$TMP/gw/frames.log" || true)"
PING_LINE="$(grep -n '"type":"ping"' "$TMP/gw/frames.log" | head -1 | cut -d: -f1)"
check "心跳 method=control(0)" "0" "$(jline "$TMP/gw/frames.log" "$((PING_LINE - 1))" method)"
check "心跳 service 用网关下发的 service_id" "7" "$(jline "$TMP/gw/frames.log" "$((PING_LINE - 1))" service)"
wait_until '[ "$(grep -c "\"type\":\"ping\"" "$TMP/gw/frames.log" 2>/dev/null || echo 0)" -ge 2 ]'
check "心跳按 PingInterval 持续发（≥2 次）" "1" "$([ "$(grep -c '"type":"ping"' "$TMP/gw/frames.log")" -ge 2 ] && echo 1 || echo 0)"

echo "== 3. 事件处理：单片 / 分片 / 重投 / 失败重试 / 账实不符 =="
wait_until '[ "$(gl_puts)" -ge 3 ]'
check "单片事件回投 OP-1（只落一次）" "1" "$(puts_of OP-1)"
check "分片事件回投 OP-2（合并成功才有 choice）" "1" "$(puts_of OP-2)"
check "GitLab 抖过一次的事件重投后落账（应答 500 请重投 → 撤回去重占位）" "1" "$(puts_of OP-3)"
grep -qE '\| OP-1 \|.*已裁决：A' "$TMP/gitlab/written-content.txt"; check "RS 里 OP-1 那行状态列被改写（其余列不动）" "0" "$?"
grep -qE '\| OP-3 \|.*已裁决：C' "$TMP/gitlab/written-content.txt"; check "三次回投互不覆盖（后写的没顶掉先写的）" "0" "$?"
check "账本 decision_written_back 全带 via:ws" "3" "$(grep -c '"type":"decision_written_back".*"via":"ws"' "$TMP/ledger/events.jsonl" || true)"

# 5xx 才值得重投：网关看到 code≠200 会原帧重投，这里验"它重投了、也被重新处理了"
wait_until '[ -f "$TMP/gw/retries.log" ]'
check "网关因应答 500 重投了一次" "1" "$(grep -c 'm-flaky code=500' "$TMP/gw/retries.log" 2>/dev/null || true)"
check "回投失败记为可重试" "1" "$(grep -c '"decision_writeback_failed".*"retryable":true' "$TMP/ledger/events.jsonl" || true)"

# 账实不符：重投一万次也一样，不能变成 500 让网关空转，必须把原因回给点按钮的人
wait_until 'grep -q "\"messageId\":\"m-miss\"" "$TMP/gw/frames.log" 2>/dev/null'
MISS_LINE="$(grep -n '"messageId":"m-miss".*"payload":"{\\"code\\":200' "$TMP/gw/frames.log" | head -1 | cut -d: -f1)"
check "账实不符不应答 5xx（不诱发无谓重投）" "1" "$([ -n "$MISS_LINE" ] && echo 1 || echo 0)"
MISS_ACK=""; [ -n "$MISS_LINE" ] && MISS_ACK="$(ack_json "$TMP/gw/frames.log" "$MISS_LINE")"
check "账实不符把原因回给点按钮的人" "1" "$(printf '%s' "$MISS_ACK" | grep -c '找到开放问题行' || true)"
check "账实不符记为不可重试" "1" "$(grep -c '"decision_writeback_failed".*"retryable":false' "$TMP/ledger/events.jsonl" || true)"
check "账实不符一次都没写进仓库" "0" "$(puts_of OP-404)"

echo "== 4. 应答帧：原帧回吐 + base64 结果 =="
ACK_LINE="$(grep -n '"messageId":"m-single".*"payload":"{\\"code\\":200' "$TMP/gw/frames.log" | head -1 | cut -d: -f1)"
check "单片事件有 200 应答" "1" "$([ -n "$ACK_LINE" ] && echo 1 || echo 0)"
if [ -n "$ACK_LINE" ]; then
  check "应答 method=data(1)" "1" "$(jline "$TMP/gw/frames.log" "$((ACK_LINE - 1))" method)"
  check "应答回吐同一 SeqID（网关靠它对号）" "1" "$(jline "$TMP/gw/frames.log" "$((ACK_LINE - 1))" seqId)"
  check "应答带 biz_rt 耗时头" "1" "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")[Number(process.argv[2])]);console.log(j.bizRt?"1":"0")' "$TMP/gw/frames.log" "$((ACK_LINE - 1))")"
  check "应答 data 是 base64(JSON(toast))" "已回投" "$(ack_json "$TMP/gw/frames.log" "$ACK_LINE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(String(JSON.parse(s).toast).slice(0,3))})')"
fi
check "分片事件也有应答（拼齐后才处理，不吞掉）" "1" "$(grep -c '"messageId":"m-split".*"payload":"{\\"code\\":200' "$TMP/gw/frames.log" || true)"
DUP_LINE="$(grep -n '"messageId":"m-single".*"payload":"{\\"code\\":200' "$TMP/gw/frames.log" | tail -1 | cut -d: -f1)"
check "重投的应答标记 duplicated（网关可据此停投）" "1" "$(ack_json "$TMP/gw/frames.log" "$DUP_LINE" | grep -c '"duplicated":true' || true)"

echo "== 5. 断线重连 =="
conns_before="$(lines_of "$TMP/gw/connections.log")"
: > "$TMP/gw/cut"
wait_until '[ "$(wc -l < "$TMP/gw/connections.log" | tr -d " ")" -gt '"$conns_before"' ]'
check "连接被掐断后自动重连" "1" "$([ "$(lines_of "$TMP/gw/connections.log")" -gt "$conns_before" ] && echo 1 || echo 0)"
sleep 0.8
check "重连不产生重复回投" "3" "$(gl_puts)"
curl -s "http://127.0.0.1:${BPORT}/healthz" > "$TMP/health.json"
check "长连接运行中 HTTP 面仍可用（healthz 报出入站模式）" "ws" "$(jget "$TMP/health.json" feishu.mode)"
# 只报 ok 的话，"进程活着但入站死了"永远查不出来——所以 healthz 要能回答通道在不在
check "healthz 报出通道是活的（不只是进程在）" "true" "$(jget "$TMP/health.json" feishu.connected)"
check "healthz 累计处置过的事件数" "5" "$(jget "$TMP/health.json" feishu.events)"
check "healthz 报出去重挡下的重投数" "1" "$(jget "$TMP/health.json" feishu.duplicates)"
kill $BROKER_PID 2>/dev/null; wait $BROKER_PID 2>/dev/null

echo "== 6. http 模式不回退成 ws：两种接法互不干扰 =="
CONNS_BEFORE="$(lines_of "$TMP/gw/connections.log")"
BROKER2_PID="$(start_broker "$TMP/broker2.out" \
  FEISHU_MODE=http FEISHU_VERIFY_TOKEN=fs-verify \
  FEISHU_APP_ID=cli_mock FEISHU_APP_SECRET=s3cr3t FEISHU_DOMAIN="http://127.0.0.1:${GW_PORT}")"
wait_file "$TMP/broker2.out"
sleep 0.5
check "显式 http 模式即使有凭据也不建长连接" "http" "$(sed -n 's/^FEISHU_MODE //p' "$TMP/broker2.out")"
check "http 模式下没有新增连接" "$CONNS_BEFORE" "$(lines_of "$TMP/gw/connections.log")"
B2PORT="$(sed -n 's/^PORT //p' "$TMP/broker2.out")"
curl -s "http://127.0.0.1:${B2PORT}/healthz" > "$TMP/health2.json"
check "http 模式的 healthz 不谎报长连接" "http" "$(jget "$TMP/health2.json" feishu.mode)"
curl -s -X POST -H 'content-type: application/json' -d '{"type":"url_verification","challenge":"c1"}' \
  "http://127.0.0.1:${B2PORT}/webhook/feishu" > "$TMP/ch.json"
check "http 模式仍能回显 challenge" "c1" "$(jget "$TMP/ch.json" challenge)"
kill $BROKER2_PID 2>/dev/null; wait $BROKER2_PID 2>/dev/null

kill $GW_PID $GITLAB_PID 2>/dev/null
wait $GW_PID $GITLAB_PID 2>/dev/null
echo
printf "结果：%d 通过，%d 失败\n" "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
