/**
 * 飞书项目 OAuth（MCP 端点）—— 不依赖项目空间管理员的接入方式。
 *
 * 为什么要这个文件：原来的通道用 `?mcpKey=&userKey=`，那是**插件身份**——
 * 开放平台按"空间是否安装该插件"判权限，所以没有空间管理权限的人一行数据都取不到。
 * 而 `https://project.feishu.cn/mcp_server/v1` 同时支持标准 MCP OAuth：
 *
 *   401 → www-authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"
 *   /.well-known/oauth-authorization-server 给出 authorize / token / register / device_code 四个端点
 *   registration_endpoint 开放（无需审核），grant 支持 authorization_code + refresh_token + device_code
 *
 * 用户身份凭证（user_plugin_token）代表"用户本人"执行，数据边界是该用户自己的可见范围，
 * 因此**不需要空间管理员安装任何东西**——这正是本文件存在的全部理由。
 *
 * 为什么用 device_code 而不是回调授权：runner 跑在本地 launchd/systemd 里，可能没有可开浏览器的
 * 会话（远程机、SSH）。device code 只要把 URL 和码打出来，用户在任意设备上点一次同意即可，
 * 不占用本地端口、不需要回环地址可达。代价是多一次轮询，但换来的"在哪儿都能授权"更值。
 *
 * 失败分类沿用 feishu-project-mcp.mjs 的原则：不吞、不猜。
 * 尚未授权返回 authorization_pending（不是错误，是"还没点"）；凭据坏了返回 invalid_grant；
 * token 形状认不出就抛错，绝不返回一个空 token 让上层以为"通了但没数据"。
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_ISSUER = 'https://project.feishu.cn';

/** 默认落点跟随仓库既有约定（install-task-loop.sh 用 $HOME/.harness/task-loop），0600，绝不进仓库。 */
export function credentialPath(env = process.env) {
  return env.FEISHU_OAUTH_FILE || join(homedir(), '.harness', 'task-loop', 'feishu-oauth.json');
}

/**
 * 提前 2 分钟判过期：定时器每 180s 一拍，卡在"刚好差 30 秒"时刷新必然打在一半的请求上。
 * 没有 expires_at 一律当作过期——读不到有效期就不能假装还有效。
 */
export function isExpired(creds, now = Date.now(), skewMs = 120_000) {
  if (!creds || typeof creds.access_token !== 'string' || !creds.access_token) return true;
  if (!Number.isFinite(creds.expires_at)) return true;
  return creds.expires_at - skewMs <= now;
}

export function loadCredentials(file = credentialPath()) {
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    // 坏 JSON 不静默当成"没登录"——那会让用户反复登录却查不出原因
    throw new Error(`凭据文件不是合法 JSON：${file}（删掉它重新 login）`);
  }
}

/** 目录 0700、文件 0600：refresh_token 等同于长期口令，不能给同机其他用户读。 */
export function saveCredentials(creds, file = credentialPath()) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* 目录属主已受限时改不动也无妨 */ }
  writeFileSync(file, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function clearCredentials(file = credentialPath()) {
  if (existsSync(file)) unlinkSync(file);
}

async function form(url, fields, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body = null;
  try { body = text.trim() ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, ok: res.ok, body };
}

/**
 * 动态客户端注册（RFC 7591）。开放且无需审核，所以"没有管理员权限"这件事在这里不成立。
 * token_endpoint_auth_method=none：device flow 的公共客户端不带 secret，带了反而增加泄漏面。
 */
export async function registerClient({ issuer = DEFAULT_ISSUER, fetchImpl = fetch, redirectUri = 'http://127.0.0.1:8765/callback', clientName = 'harness-task-loop' } = {}) {
  const res = await fetchImpl(`${issuer}/mcp_server/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`客户端注册失败 HTTP ${res.status}：${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  if (!j.client_id) throw new Error(`客户端注册没返回 client_id：${JSON.stringify(j).slice(0, 160)}`);
  return { client_id: j.client_id, client_secret: j.client_secret ?? null };
}

/** 发起 device 授权：拿到 user_code 与 verification_uri_complete，交给用户去点。 */
export async function startDeviceFlow({ issuer = DEFAULT_ISSUER, clientId, fetchImpl = fetch } = {}) {
  const r = await form(`${issuer}/goapi/v5/mcp_server/oauth/device_code`, { client_id: clientId }, { fetchImpl });
  if (!r.ok || !r.body?.device_code) {
    throw new Error(`device 授权发起失败 HTTP ${r.status}：${JSON.stringify(r.body).slice(0, 160)}`);
  }
  return {
    device_code: r.body.device_code,
    user_code: r.body.user_code,
    verification_uri: r.body.verification_uri,
    verification_uri_complete: r.body.verification_uri_complete,
    expires_in: Number(r.body.expires_in) || 1800,
    interval: Number(r.body.interval) || 5,
  };
}

/**
 * token 响应形状在"授权成功"之前无法观测（pending 时只返回 error），所以两种形态都认：
 *   { access_token, refresh_token, expires_in }
 *   { code: 0, data: { access_token, ... } }   ← 平台部分 goapi 走这层包装
 * 都认不出就抛错，不返回 undefined token。
 */
export function normalizeToken(body, now = Date.now()) {
  const d = body && typeof body.data === 'object' && body.data ? body.data : body;
  const at = d?.access_token;
  if (typeof at !== 'string' || !at) return null;
  const expiresIn = Number(d.expires_in);
  return {
    access_token: at,
    refresh_token: typeof d.refresh_token === 'string' && d.refresh_token ? d.refresh_token : null,
    token_type: d.token_type || 'Bearer',
    scope: d.scope ?? null,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
  };
}

/** 轮询直到授权成功、过期或被拒。返回 token；pending 不算失败。 */
export async function pollForToken({ issuer = DEFAULT_ISSUER, clientId, deviceCode, interval = 5, expiresIn = 1800, fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onTick = () => {} } = {}) {
  const deadline = now() + expiresIn * 1000;
  let wait = Math.max(1, interval) * 1000;
  for (;;) {
    const r = await form(`${issuer}/mcp_server/oauth/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: clientId,
    }, { fetchImpl });
    const err = r.body?.error || r.body?.code;
    if (!err || err === 0) {
      const tok = normalizeToken(r.body, now());
      if (tok) return tok;
      throw new Error(`token 响应认不出（既无 access_token 也无 error）：${JSON.stringify(r.body).slice(0, 200)}`);
    }
    if (err === 'authorization_pending') {
      if (now() + wait > deadline) throw new Error(`授权超时（${Math.round(expiresIn / 60)} 分钟内未完成）——重新运行 login`);
      onTick(Math.round((deadline - now()) / 1000));
      await sleep(wait);
      continue;
    }
    if (err === 'slow_down') {
      wait += 5000;
      await sleep(wait);
      continue;
    }
    if (err === 'access_denied') throw new Error('用户拒绝了授权');
    if (err === 'expired_token') throw new Error('device code 已过期——重新运行 login');
    throw new Error(`换取 token 失败：${JSON.stringify(r.body).slice(0, 200)}`);
  }
}

export async function refreshToken({ issuer = DEFAULT_ISSUER, clientId, refresh, fetchImpl = fetch, now = Date.now } = {}) {
  if (!refresh) throw new Error('没有 refresh_token，只能重新 login');
  const r = await form(`${issuer}/mcp_server/oauth/token`, {
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: clientId,
  }, { fetchImpl });
  const tok = normalizeToken(r.body, now());
  if (!tok) throw new Error(`刷新失败 HTTP ${r.status}：${JSON.stringify(r.body).slice(0, 200)}`);
  // 有的实现对刷新不返回新的 refresh_token，沿用旧的，避免下一次刷新无凭据
  if (!tok.refresh_token) tok.refresh_token = refresh;
  return tok;
}

/**
 * 拿一个可用的 access_token：未过期直接用，过期则刷新并回写文件，刷新不了就报"重新 login"。
 * 上层（task-loop / doctor）只调这个，不自己判断过期——判据只写一份才不会漂。
 */
export async function ensureToken({ file = credentialPath(), issuer = DEFAULT_ISSUER, fetchImpl = fetch, now = Date.now } = {}) {
  const creds = loadCredentials(file);
  if (!creds) throw new Error('尚未登录飞书项目：先运行 node scripts/feishu-auth.mjs login');
  if (!isExpired(creds, now())) return creds.access_token;
  if (!creds.refresh_token) throw new Error('凭据已过期且无 refresh_token：重新运行 node scripts/feishu-auth.mjs login');
  const tok = await refreshToken({ issuer, clientId: creds.client_id, refresh: creds.refresh_token, fetchImpl, now });
  const next = { ...creds, ...tok };
  saveCredentials(next, file);
  return next.access_token;
}
