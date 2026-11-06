/**
 * 飞书长连接的线格式 —— pbbp2.Frame 的零依赖编解码。
 *
 * 为什么手写而不是装 @larksuiteoapi/node-sdk：那个包 6MB，拖着 axios / ws /
 * protobufjs 三棵子树，而本项目至今零依赖、node18 内置模块就能跑。长连接用到的
 * 协议面其实很窄：一个两字段的 Header、九个字段的 Frame、心跳帧、事件帧的应答帧。
 * 这些编解码器本身就是判据（"帧发得对不对"），手写反而可测——假网关能逐字节校验。
 *
 * 线格式（与官方 SDK 的 protobuf 描述一致，字段号写死，改了就连不上）：
 *   Frame:  1 SeqID(uint64) 2 LogID(uint64) 3 service(int32) 4 method(int32)
 *           5 headers(Header, repeated) 6 payloadEncoding(string) 7 payloadType(string)
 *           8 payload(bytes) 9 LogIDNew(string)
 *   Header: 1 key(string) 2 value(string)
 *
 * 边界：不做 WebSocket 层的分片重组（那是 ws-client 的事），只做飞书应用层的
 * sum/seq 分片合并——一个事件超过 2MB 时网关会拆成多帧，漏合并 = 事件体截断。
 */

export const FrameType = { control: 0, data: 1 };
export const MessageType = { event: 'event', card: 'card', ping: 'ping', pong: 'pong' };
export const HeaderKey = {
  type: 'type', message_id: 'message_id', sum: 'sum', seq: 'seq', trace_id: 'trace_id', biz_rt: 'biz_rt',
};

const asBuf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v || new Uint8Array()));

function varint(n) {
  let v = typeof n === 'bigint' ? n : BigInt(Math.trunc(Number(n) || 0));
  if (v < 0n) v = BigInt.asUintN(64, v); // proto 的 int32 负数按 64 位补码发
  const out = [];
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

const tag = (field, wire) => varint((field << 3) | wire);
const num = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const bytes = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), buf]);
const text = (field, s) => bytes(field, Buffer.from(String(s), 'utf8'));

export function encodeHeader(h) {
  const parts = [];
  if (h && h.key != null) parts.push(text(1, h.key));
  if (h && h.value != null) parts.push(text(2, h.value));
  return Buffer.concat(parts);
}

export function encodeFrame(frame = {}) {
  const parts = [];
  if (frame.SeqID != null) parts.push(num(1, frame.SeqID));
  if (frame.LogID != null) parts.push(num(2, frame.LogID));
  if (frame.service != null) parts.push(num(3, frame.service));
  if (frame.method != null) parts.push(num(4, frame.method));
  for (const h of frame.headers || []) parts.push(bytes(5, encodeHeader(h)));
  if (frame.payloadEncoding) parts.push(text(6, frame.payloadEncoding));
  if (frame.payloadType) parts.push(text(7, frame.payloadType));
  if (frame.payload && frame.payload.length) parts.push(bytes(8, asBuf(frame.payload)));
  if (frame.LogIDNew) parts.push(text(9, frame.LogIDNew));
  return Buffer.concat(parts);
}

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let i = pos;
  for (;;) {
    if (i >= buf.length) throw new Error('varint 越界（帧被截断）');
    const b = buf[i++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error('varint 过长（不是合法的 protobuf 帧）');
  }
  return [result, i];
}

const toNum = (v) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);

export function decodeHeader(buf) {
  const out = { key: '', value: '' };
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire !== 2) throw new Error(`Header 字段 ${field} 线型 ${wire} 不支持`);
    let len;
    [len, i] = readVarint(buf, i);
    const l = Number(len);
    const slice = buf.subarray(i, i + l);
    i += l;
    if (field === 1) out.key = slice.toString('utf8');
    else if (field === 2) out.value = slice.toString('utf8');
  }
  return out;
}

export function decodeFrame(buf) {
  const frame = {
    SeqID: 0, LogID: 0, service: 0, method: 0,
    headers: [], payloadEncoding: '', payloadType: '', payload: null, LogIDNew: '',
  };
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      let v;
      [v, i] = readVarint(buf, i);
      if (field === 1) frame.SeqID = toNum(v);
      else if (field === 2) frame.LogID = toNum(v);
      else if (field === 3) frame.service = Number(v);
      else if (field === 4) frame.method = Number(v);
    } else if (wire === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      const l = Number(len);
      const slice = buf.subarray(i, i + l);
      i += l;
      if (field === 5) frame.headers.push(decodeHeader(slice));
      else if (field === 6) frame.payloadEncoding = slice.toString('utf8');
      else if (field === 7) frame.payloadType = slice.toString('utf8');
      else if (field === 8) frame.payload = Buffer.from(slice);
      else if (field === 9) frame.LogIDNew = slice.toString('utf8');
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      throw new Error(`Frame 字段 ${field} 线型 ${wire} 不支持`);
    }
  }
  return frame;
}

export function headersToObject(headers = []) {
  return headers.reduce((acc, h) => { if (h && h.key) acc[h.key] = h.value; return acc; }, {});
}

/**
 * 应用层分片合并：sum>1 时按 seq 拼回完整 payload，拼不齐返回 null（继续等）。
 * 顺带做过期清理——丢片的事件必须自己烂掉，不能一直占着内存等一个永不到来的 seq。
 */
export function createFragmentMerger({ limit = 64, ttlMs = 60_000 } = {}) {
  const pending = new Map();
  return function merge({ message_id, sum, seq, trace_id, data } = {}) {
    const total = Number(sum) || 1;
    const payload = asBuf(data);
    if (total <= 1) return { payload, trace_id };
    const now = Date.now();
    for (const [id, slot] of pending) {
      if (now - slot.at > ttlMs) pending.delete(id);
    }
    const key = String(message_id || '');
    if (!key) throw new Error('分片事件缺 message_id，无法合并');
    const slot = pending.get(key) || { parts: new Map(), at: now };
    slot.at = now;
    slot.parts.set(Number(seq) || 0, payload);
    pending.set(key, slot);
    if (slot.parts.size < total) return null;
    const ordered = [...slot.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    pending.delete(key);
    return { payload: Buffer.concat(ordered), trace_id };
  };
}

/**
 * 事件去重：长连接断线重连后，网关会重投"已收到但没来得及应答"的事件。
 * 对通知来说是重复卡片，对回投来说是**同一份批红提交两次**——必须挡。
 *
 * 但"记住"必须发生在**处理成功之后**，所以拆成 seen / forget 两步：
 *   seen(id)  → 首次返回 false 并占位；重复返回 true
 *   forget(id)→ 处理失败时撤回占位（事务回滚）
 * 只记住不撤回的后果很隐蔽：第一次因 GitLab 5xx 失败、应答 500 请求重投，
 * 重投却被自己当成"重复"丢掉并回 200 —— 飞书以为已处理，账上什么都没有。
 * 这正是"看起来通了"里最难查的一种：两端日志都正常，只有仓库少了一行批红。
 *
 * 占位按 LRU 截断：limit 是"记多少个 message_id"，不是"处理多少个事件"。
 */
export function createDeduper({ limit = 512 } = {}) {
  const seen = new Set();
  const order = [];
  return {
    seen(id) {
      if (!id) return false;
      if (seen.has(id)) return true;
      seen.add(id);
      order.push(id);
      if (order.length > limit) seen.delete(order.shift());
      return false;
    },
    forget(id) {
      if (!id || !seen.delete(id)) return;
      const i = order.indexOf(id);
      if (i >= 0) order.splice(i, 1);
    },
  };
}

/**
 * 应答帧：把收到的帧原样回吐（SeqID/LogID/service 必须一致，否则网关对不上号），
 * 补一个 biz_rt 耗时头，payload 换成 {code, data?}——data 是 base64(JSON(处理结果))。
 */
export function buildAck(frame, { code = 200, data, elapsedMs = 0 } = {}) {
  const body = data === undefined ? { code } : { code, data: Buffer.from(JSON.stringify(data), 'utf8').toString('base64') };
  return {
    SeqID: frame.SeqID, LogID: frame.LogID, service: frame.service, method: frame.method,
    headers: [...(frame.headers || []), { key: HeaderKey.biz_rt, value: String(-Math.abs(elapsedMs)) }],
    payloadEncoding: frame.payloadEncoding,
    payloadType: frame.payloadType,
    payload: Buffer.from(JSON.stringify(body), 'utf8'),
  };
}

/** 心跳帧：service 必须用网关下发的 service_id，method 固定 control，其它字段为 0。 */
export function buildPing(serviceId) {
  return {
    SeqID: 0, LogID: 0, service: Number(serviceId) || 0, method: FrameType.control,
    headers: [{ key: HeaderKey.type, value: MessageType.ping }],
  };
}
