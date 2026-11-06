/**
 * 最小 WebSocket 客户端（RFC6455）—— 只做长连接用得到的那一半。
 *
 * 为什么不用 ws 包：本项目零依赖，而客户端要的东西很少——握手、掩码帧收发、
 * ping/pong、close。服务端那半边（选协议、处理掩码）一行都不用写。
 * 为什么要自己写而不是用 node22 的全局 WebSocket：engines 声明是 node>=18，
 * 而 node18 没有全局 WebSocket，部署机是什么版本不由我们决定。
 *
 * 明确不做：压缩扩展（permessage-deflate）、子协议协商、重定向跟随。
 * 飞书网关这三样都不用；真要用了，握手阶段就会失败而不是"静默降级成明文"。
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11D';
const OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

function frameOut(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN=1
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/**
 * @returns {Promise<{send, close, socket, on, off, emit}>} 事件：message(Buffer) / close / error
 */
export function connectWebSocket(urlStr, { headers = {}, timeoutMs = 10_000, tls = {} } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    let u;
    try { u = new URL(urlStr); } catch { return fail(new Error(`WebSocket 地址非法：${urlStr}`)); }
    const secure = u.protocol === 'wss:';
    if (!secure && u.protocol !== 'ws:') return fail(new Error(`只支持 ws/wss，收到 ${u.protocol}`));

    const key = crypto.randomBytes(16).toString('base64');
    const mod = secure ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...headers,
      },
      ...(secure ? tls : {}),
    });

    const timer = setTimeout(() => { try { req.destroy(); } catch { /* 已销毁 */ } fail(new Error('WebSocket 握手超时')); }, timeoutMs);

    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== accept) {
        socket.destroy();
        return fail(new Error('Sec-WebSocket-Accept 不匹配（对面不是 WebSocket 或经过了改写握手的代理）'));
      }
      socket.setNoDelay(true);

      const emitter = new EventEmitter();
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      const fragments = [];
      let closed = false;

      const api = {
        readyState: 1,
        socket,
        on: (ev, cb) => { emitter.on(ev, cb); return api; },
        off: (ev, cb) => { emitter.off(ev, cb); return api; },
        send(data) {
          if (closed) throw new Error('连接已关闭，不能再发');
          socket.write(frameOut(OP.binary, data));
        },
        close(code = 1000, reason = '') {
          if (closed) return;
          const body = Buffer.alloc(2 + Buffer.byteLength(reason));
          body.writeUInt16BE(code, 0);
          body.write(reason, 2);
          try { socket.write(frameOut(OP.close, body)); } catch { /* 对端已断 */ }
          closed = true;
          socket.end();
        },
        terminate() {
          closed = true;
          try { socket.destroy(); } catch { /* 已销毁 */ }
        },
      };

      const consume = () => {
        while (buf.length >= 2) {
          const b0 = buf[0];
          const b1 = buf[1];
          const fin = (b0 & 0x80) !== 0;
          const opcode = b0 & 0x0f;
          const masked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            offset = 10;
          }
          const maskLen = masked ? 4 : 0;
          if (buf.length < offset + maskLen + len) return;
          let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
          if (masked) {
            const mask = buf.subarray(offset, offset + 4);
            payload = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
          } else {
            payload = Buffer.from(payload);
          }
          buf = buf.subarray(offset + maskLen + len);

          if (opcode === OP.ping) { try { socket.write(frameOut(OP.pong, payload)); } catch { /* 对端已断 */ } continue; }
          if (opcode === OP.pong) { emitter.emit('pong', payload); continue; }
          if (opcode === OP.close) {
            closed = true;
            emitter.emit('close', { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.subarray(2).toString() });
            socket.end();
            return;
          }
          if (opcode === OP.cont) {
            fragments.push(payload);
            if (!fin) continue;
            const whole = Buffer.concat(fragments.splice(0));
            emitter.emit('message', whole);
            continue;
          }
          if (opcode === OP.text || opcode === OP.binary) {
            if (!fin) { fragments.push(payload); continue; }
            emitter.emit('message', payload);
            continue;
          }
        }
      };

      socket.on('data', (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        try { consume(); } catch (e) { emitter.emit('error', e); }
      });
      socket.on('close', () => {
        if (!closed) { closed = true; emitter.emit('close', { code: 1006, reason: '连接被对端关闭' }); }
      });
      socket.on('error', (e) => emitter.emit('error', e));

      settled = true;
      resolve(api);
      emitter.emit('open');
    });

    req.on('response', (res) => {
      clearTimeout(timer);
      res.resume();
      fail(new Error(`握手被拒绝：HTTP ${res.statusCode}（长连接没开或 app 凭据不对）`));
    });
    req.on('error', (e) => { clearTimeout(timer); fail(e); });
    req.end();
  });
}
