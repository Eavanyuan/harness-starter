#!/usr/bin/env node
/**
 * 飞书项目登录（device code）—— 不需要项目空间管理员。
 *
 * 用法：
 *   node scripts/feishu-auth.mjs login      # 打印授权链接与码，浏览器点同意后自动换取 token
 *   node scripts/feishu-auth.mjs status     # 凭据状态（不打印 token 本体）
 *   node scripts/feishu-auth.mjs token      # 输出 access_token（给脚本用）
 *   node scripts/feishu-auth.mjs logout     # 删除本地凭据
 *
 * 退出码：0 成功；1 失败；69 未登录/凭据不可用（与 doctor 的 off 档对齐）。
 *
 * 登录成功后立刻自检一次（initialize + tools/list），因为"拿到 token"和
 * "token 能读到你的工作项"是两件事——不验证就等于把未确认的东西写进凭据。
 */
import {
  credentialPath, loadCredentials, saveCredentials, clearCredentials,
  registerClient, startDeviceFlow, pollForToken, ensureToken, isExpired, DEFAULT_ISSUER,
} from './lib/feishu-oauth.mjs';

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) || 'status';
const JSON_OUT = argv.includes('--json');
const FORCE_REGISTER = argv.includes('--force-register');
const NO_VERIFY = argv.includes('--no-verify');
const ISSUER = process.env.FEISHU_ISSUER || DEFAULT_ISSUER;
const FILE = credentialPath();

const die = (code, msg) => { console.error(`[feishu-auth] ${msg}`); process.exit(code); };
const mask = (t) => (!t ? '(none)' : t.length <= 12 ? `${t.slice(0, 4)}…` : `${t.slice(0, 6)}…${t.slice(-4)}`);
const fmt = (ms) => (ms == null ? '未知' : new Date(ms).toLocaleString('zh-CN', { hour12: false }));

/** 自检：用 Bearer 打 MCP，证明"通道 + 身份"真的通，而不是只有一张 token。 */
async function selfCheck(token) {
  const endpoint = process.env.FEISHU_MCP_URL || `${ISSUER}/mcp_server/v1`;
  const post = async (body, sid) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...(sid ? { 'mcp-session-id': sid } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    return { status: res.status, sid: res.headers.get('mcp-session-id'), text };
  };

  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'harness-feishu-auth', version: '1.0' } } });
  if (init.status === 401) return { ok: false, level: 'auth', detail: 'MCP 端点不认这张 token（HTTP 401）' };
  if (init.status !== 200) return { ok: false, level: 'error', detail: `MCP HTTP ${init.status}` };

  const initBody = init.text.startsWith('data:') ? init.text.split('data:').pop() : init.text;
  const serverName = (() => { try { return JSON.parse(initBody)?.result?.serverInfo?.name ?? '?'; } catch { return '?'; } })();

  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid);
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.sid);
  const listBody = list.text.startsWith('data:') ? list.text.split('data:').pop() : list.text;
  let tools = [];
  try { tools = JSON.parse(listBody)?.result?.tools ?? []; } catch { /* 下面按 0 个工具报 */ }
  return { ok: true, level: 'channel', detail: `通道通（${serverName}，${tools.length} 个工具）`, tools: tools.map((t) => t.name) };
}

async function cmdLogin() {
  let creds = FORCE_REGISTER ? null : loadCredentials(FILE);
  if (!creds?.client_id) {
    process.stderr.write('[feishu-auth] 注册 OAuth 客户端…\n');
    const reg = await registerClient({ issuer: ISSUER });
    creds = { client_id: reg.client_id, client_secret: reg.client_secret, issuer: ISSUER };
    saveCredentials(creds, FILE);
  } else {
    process.stderr.write(`[feishu-auth] 复用已注册客户端 ${creds.client_id.slice(0, 16)}…\n`);
  }

  const dev = await startDeviceFlow({ issuer: ISSUER, clientId: creds.client_id });
  console.log('');
  console.log('  在浏览器打开下面这个链接，用你的飞书账号同意授权：');
  console.log('');
  console.log(`    ${dev.verification_uri_complete || dev.verification_uri}`);
  console.log('');
  console.log(`  如果链接被拆分，手动输入码：${dev.user_code}`);
  console.log(`  （${Math.round(dev.expires_in / 60)} 分钟内有效；授权只需要一次，之后靠 refresh_token 续期）`);
  console.log('');
  process.stderr.write('[feishu-auth] 等待授权…\n');

  let lastTick = -1;
  const tok = await pollForToken({
    issuer: ISSUER,
    clientId: creds.client_id,
    deviceCode: dev.device_code,
    interval: dev.interval,
    expiresIn: dev.expires_in,
    onTick: (left) => {
      const m = Math.floor(left / 60);
      if (m !== lastTick) { lastTick = m; process.stderr.write(`  剩余 ${m} 分钟…\n`); }
    },
  });

  const next = { ...creds, ...tok, issuer: ISSUER, obtained_at: Date.now() };
  saveCredentials(next, FILE);
  process.stderr.write(`[feishu-auth] 已保存凭据 ${FILE}（0600）\n`);

  if (NO_VERIFY) {
    console.log(JSON_OUT ? JSON.stringify({ ok: true, file: FILE, token: mask(next.access_token) }, null, 2) : `已登录：${mask(next.access_token)}`);
    return 0;
  }

  // "拿到 token" ≠ "能读你的工作项"：立刻打一次真实端点，把差别暴露在这一步。
  process.stderr.write('[feishu-auth] 自检：用这张 token 打开 MCP 通道…\n');
  const chk = await selfCheck(next.access_token);
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: chk.ok, level: chk.level, detail: chk.detail, file: FILE, token: mask(next.access_token), tools: chk.tools ?? [] }, null, 2));
  } else if (chk.ok) {
    console.log(`\n  ✓ ${chk.detail}`);
    console.log('    凭据已就绪，task-loop 剖面 B 会用这张 token 读你的工作项。');
    console.log('    下一步：node scripts/task-loop.mjs --once --profile b --dry-run  （先影子周，不写外部系统）');
  } else {
    console.log(`\n  ✗ ${chk.detail}`);
  }
  return chk.ok ? 0 : 1;
}

function cmdStatus() {
  const c = loadCredentials(FILE);
  if (!c) {
    if (JSON_OUT) console.log(JSON.stringify({ logged_in: false, file: FILE }, null, 2));
    else console.log(`未登录（${FILE} 不存在）——运行 node scripts/feishu-auth.mjs login`);
    return 69;
  }
  const expired = isExpired(c);
  if (JSON_OUT) {
    console.log(JSON.stringify({ logged_in: true, expired, expires_at: c.expires_at ?? null, token: mask(c.access_token), can_refresh: !!c.refresh_token, client_id: c.client_id, file: FILE }, null, 2));
  } else {
    console.log(`凭据文件  ${FILE}`);
    console.log(`access    ${mask(c.access_token)}`);
    console.log(`有效期至  ${fmt(c.expires_at)}${c.expires_at == null ? '（无 expires_in，按过期处理）' : ''}`);
    console.log(`状态      ${expired ? (c.refresh_token ? '已过期，下次调用自动刷新' : '已过期且无 refresh_token —— 需重新 login') : '可用'}`);
  }
  return 0;
}

async function cmdToken() {
  try {
    const t = await ensureToken({ file: FILE, issuer: ISSUER });
    process.stdout.write(t);
  } catch (e) {
    die(69, e.message);
  }
  return 0;
}

function cmdLogout() {
  clearCredentials(FILE);
  console.log(`已删除 ${FILE}`);
  return 0;
}

const table = { login: cmdLogin, status: cmdStatus, token: cmdToken, logout: cmdLogout };
if (!table[cmd]) die(64, `未知命令 ${cmd}（login / status / token / logout）`);
try {
  process.exit(await table[cmd]());
} catch (e) {
  die(1, e.message);
}
