/**
 * 飞书长连接接收器 —— 让内网里的 broker 也能收到飞书的消息。
 *
 * 背景：飞书回调地址必须是公网可达的。GitLab 在内网、broker 也在内网时，
 * 飞书那侧根本连不进来，卡片点选就永远回不到 broker —— 业务闭环断在最后一段。
 * 长连接把这根线反过来拉：由 broker 主动向飞书网关建 WebSocket，事件顺着
 * 这条已经建好的连接推下来，不需要任何入站端口、不需要公网 IP。
 *
 * 协议三步（与官方 SDK 同一套线格式，实现在 lib/feishu-frame.mjs）：
 *   1. POST /callback/ws/endpoint 换连接地址（AppID + AppSecret 换 URL + 心跳参数）
 *   2. 连上后按 PingInterval 发 control 帧保活；断线按 ReconnectInterval 重连
 *   3. 收到 method=data 的帧 → 合并分片 → 解析 → 交给 onEvent → 原帧回吐应答
 *
 * 三道防线，缺一个都会"看起来通了但账不对"：
 *   - 分片合并：大事件被拆成多帧，漏合并 = 事件体截断 = 解析失败或字段缺失
 *   - 事件去重：断线重连会重投未应答事件，对回投来说是同一份批红提交两次
 *   - 串行处理：并发写同一个 RS 文件会互相覆盖（后一个提交把前一个的结论顶掉）
 */
import { createFragmentMerger, createDeduper, decodeFrame, encodeFrame, headersToObject, buildAck, buildPing, FrameType, MessageType } from './lib/feishu-frame.mjs';
import { connectWebSocket } from './lib/ws-client.mjs';

const UA = 'harness-broker/1.1 (feishu-longconn)';

export async function pullWsEndpoint({ appId, appSecret, domain = 'https://open.feishu.cn', timeoutMs = 15_000, fetchImpl = fetch }) {
  const res = await fetchImpl(`${domain.replace(/\/+$/, '')}/callback/ws/endpoint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', locale: 'zh', 'user-agent': UA },
    body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`取长连接端点 HTTP ${res.status}`);
  const j = await res.json();
  if (!j || j.code !== 0 || !j.data || !j.data.URL) {
    throw new Error(`取长连接端点失败：code=${j && j.code} msg=${(j && j.msg) || '空响应'}`);
  }
  const url = new URL(j.data.URL);
  const cc = j.data.ClientConfig || {};
  return {
    url: j.data.URL,
    deviceId: url.searchParams.get('device_id') || '',
    serviceId: url.searchParams.get('service_id') || '0',
    pingMs: Math.max(1, Number(cc.PingInterval) || 120) * 1000,
    reconnectCount: Number.isFinite(Number(cc.ReconnectCount)) ? Number(cc.ReconnectCount) : -1,
    reconnectMs: Math.max(1, Number(cc.ReconnectInterval) || 120) * 1000,
  };
}

/**
 * 把飞书推下来的原始事件归一成 broker 认得的形状。
 *
 * 两种都认：新版卡片回调走事件通道（schema 2.0 信封，event_type=card.action.trigger），
 * 老版回调是裸的 {action, operator}。归一化放在这里而不是 broker 里，是因为
 * "长连接长什么样"属于传输层知识，不该漏进业务处理。
 */
export function normalizeInbound(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.action && raw.action.value) {
    return { transport: 'ws', action: raw.action, operator: raw.operator || {}, raw };
  }
  const evt = raw.event || {};
  const eventType = (raw.header && raw.header.event_type) || raw.event_type || '';
  if (eventType === 'card.action.trigger' || evt.action) {
    return { transport: 'ws', action: evt.action || {}, operator: evt.operator || {}, eventType, raw };
  }
  return { transport: 'ws', action: null, operator: evt.operator || {}, eventType, raw };
}

/**
 * @param {object} o
 * @param {string} o.appId
 * @param {string} o.appSecret
 * @param {(evt:object, meta:object)=>Promise<any>} o.onEvent 返回应答 data（会 base64 进应答帧）
 */
export function startFeishuWs({
  appId, appSecret, domain = 'https://open.feishu.cn',
  onEvent, log = console, fetchImpl = fetch,
  pingMs, reconnectMs, reconnectCount,
  connect = connectWebSocket, pull = pullWsEndpoint,
} = {}) {
  if (!appId || !appSecret) throw new Error('长连接需要 FEISHU_APP_ID / FEISHU_APP_SECRET');
  if (typeof onEvent !== 'function') throw new Error('长连接需要 onEvent 处理函数');

  const stats = { connected: false, connections: 0, events: 0, duplicates: 0, acks: 0, failures: 0, pings: 0, lastError: '' };
  let stopped = false;
  let ws = null;
  let pingTimer = null;
  let liveness = null;
  let reconnectTimer = null;
  let attempts = 0;
  let queue = Promise.resolve();
  const merge = createFragmentMerger();
  const dedupe = createDeduper();
  let cfg = null;

  const say = (msg) => log.info ? log.info(`[feishu-ws] ${msg}`) : log.log(`[feishu-ws] ${msg}`);
  const oops = (msg) => log.error ? log.error(`[feishu-ws] ${msg}`) : log.log(`[feishu-ws] ${msg}`);

  function armLiveness(wsRef, interval) {
    if (liveness) clearTimeout(liveness);
    liveness = setTimeout(() => {
      oops(`超过 ${Math.round(interval / 1000)}s 没收到任何帧，判定半开连接，重连`);
      stats.lastError = '半开连接超时';
      try { wsRef.terminate(); } catch { /* 已断 */ }
    }, interval * 3);
  }

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (liveness) { clearTimeout(liveness); liveness = null; }
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectCount > 0 && attempts >= reconnectCount) {
      // 放弃 = 入站彻底死掉。必须留一个能被外部看见的状态（healthz 读 stats.connected），
      // 否则进程还活着、HTTP 面还 200，运维根本不知道按钮点下去已经没人接了。
      stats.connected = false;
      stats.lastError = `重连 ${attempts} 次仍未成功，已放弃`;
      oops(`重连 ${attempts} 次仍未成功，放弃（ReconnectCount=${reconnectCount}）—— 入站已断，进程仍在跑`);
      return;
    }
    attempts += 1;
    const wait = reconnectMs || 1000;
    say(`${Math.round(wait / 1000)}s 后第 ${attempts} 次重连`);
    reconnectTimer = setTimeout(() => { session().catch((e) => { oops(`重连失败：${e.message}`); scheduleReconnect(); }); }, wait);
  }

  async function handleDataFrame(frame, wsRef) {
    const headers = headersToObject(frame.headers);
    const mid = headers.message_id;
    const started = Date.now();
    const merged = merge({
      message_id: headers.message_id, sum: headers.sum, seq: headers.seq,
      trace_id: headers.trace_id, data: frame.payload,
    });
    if (!merged) return; // 还在等剩下的分片
    if (dedupe.seen(mid)) {
      stats.duplicates += 1;
      say(`重复事件 ${mid}，丢弃（重连重投）`);
      wsRef.send(encodeFrame(buildAck(frame, { code: 200, data: { ok: true, duplicated: true }, elapsedMs: Date.now() - started })));
      stats.acks += 1;
      return;
    }
    let raw;
    try {
      raw = JSON.parse(merged.payload.toString('utf8'));
    } catch (e) {
      // 不 forget：payload 坏掉是确定性的，重投多少次都一样，留着占位让下一次直接被去重挡回去，
      // 避免和网关形成"500 → 重投 → 500"的无限循环。
      stats.failures += 1;
      oops(`事件体不是 JSON（message_id=${mid}）：${e.message}`);
      wsRef.send(encodeFrame(buildAck(frame, { code: 500, data: { error: 'payload 不是 JSON' }, elapsedMs: Date.now() - started })));
      return;
    }
    const evt = normalizeInbound(raw);
    let data;
    let code = 200;
    try {
      stats.events += 1;
      data = await onEvent(evt, { messageId: mid, traceId: headers.trace_id, headers });
    } catch (e) {
      // 处理失败 = 这次回投没落账。必须撤回占位，让网关的重投能真正再走一遍；
      // 不撤回就把"我们的故障"永久记账成了"飞书重复投递"。
      code = 500;
      stats.failures += 1;
      dedupe.forget(mid);
      oops(`事件处理失败（message_id=${mid}），应答 500 请网关重投：${e.message}`);
      data = { error: String(e.message) };
    }
    wsRef.send(encodeFrame(buildAck(frame, { code, data, elapsedMs: Date.now() - started })));
    stats.acks += 1;
  }

  function onFrame(buf, wsRef) {
    let frame;
    try {
      frame = decodeFrame(buf);
    } catch (e) {
      stats.failures += 1;
      oops(`帧解码失败：${e.message}`);
      return;
    }
    if (frame.method === FrameType.control) {
      const t = headersToObject(frame.headers).type;
      if (t === MessageType.ping) return; // 网关主动探活，回 pong 由 ws 层处理
      if (t === MessageType.pong) {
        // pong 里带的是新的心跳/重连参数，照它改——网关心跳策略会动态下发
        try {
          const p = JSON.parse(frame.payload.toString('utf8'));
          if (p && p.PingInterval) {
            cfg.pingMs = Math.max(1, Number(p.PingInterval)) * 1000;
            restartPing(wsRef);
          }
        } catch { /* pong 体坏了不影响主流程，按旧心跳继续 */ }
      }
      return;
    }
    if (frame.method !== FrameType.data) return;
    // 串行化：并发处理会让两个决策同时写同一个 RS 文件，后提交的把先提交的覆盖掉
    queue = queue.then(() => handleDataFrame(frame, wsRef)).catch((e) => oops(`串行队列异常：${e.message}`));
  }

  function restartPing(wsRef) {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      try {
        wsRef.send(encodeFrame(buildPing(cfg.serviceId)));
        stats.pings += 1;
      } catch (e) {
        oops(`心跳发送失败：${e.message}`);
      }
    }, cfg.pingMs);
  }

  async function session() {
    if (stopped) return;
    cfg = await pull({ appId, appSecret, domain, fetchImpl });
    const conn = await connect(cfg.url, { timeoutMs: 10_000 });
    ws = conn;
    stats.connected = true;
    stats.lastError = '';
    stats.connections += 1;
    attempts = 0;
    say(`已连上飞书网关（device_id=${cfg.deviceId || '-'} service_id=${cfg.serviceId} 心跳=${Math.round(cfg.pingMs / 1000)}s）`);

    armLiveness(conn, cfg.pingMs);
    restartPing(conn);
    conn.on('message', (buf) => {
      armLiveness(conn, cfg.pingMs);
      onFrame(buf, conn);
    });
    conn.on('close', () => {
      clearTimers();
      stats.connected = false;
      if (stopped) return;
      say('连接断开');
      scheduleReconnect();
    });
    conn.on('error', (e) => {
      stats.lastError = e.message;
      oops(`连接错误：${e.message}`);
    });
  }

  session().catch((e) => {
    stats.lastError = e.message;
    oops(`首连失败：${e.message}`);
    scheduleReconnect();
  });

  return {
    stats,
    /** 等排队中的事件都处理完（测试与优雅退出用） */
    drain() { return queue; },
    stop() {
      stopped = true;
      stats.connected = false;
      clearTimers();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { if (ws) ws.close(); } catch { /* 已断 */ }
    },
  };
}
