/**
 * 飞书项目（Meego）MCP 客户端 —— task-loop 剖面 B 的触发与回写通道（T6）。
 *
 * 通道形态（2026-11-09 实测验证）：MCP streamable HTTP（JSON-RPC over POST），
 * 凭据走 URL query（mcpKey=应用级 / userKey=用户级）。已实测：
 *   initialize → mcp-session-id 会话 → notifications/initialized → tools/list（46 个工具）。
 * 数据层权限（工作项读写范围）在飞书项目后台逐空间授权，未配齐时所有数据工具返回
 * CheckTokenPermFailed —— 本客户端把它显式分类为 PERM 错误，doctor 据此报"通道通、数据档未配"。
 *
 * 设计边界：
 *   - 只做 HTTP 与协议层，不含业务语义（查我的 bug、回写状态在 task-loop 里组装）；
 *   - 失败分类不吞：网络/协议/权限/参数四类错误分开抛，调用方按类决策（权限错≠重试可救）；
 *   - 凭据从 env 读（FEISHU_MCP_URL 含 key，或分开的 MCP_KEY/USER_KEY），绝不进 git。
 */
import { recordEvent } from '../../hooks/lib/ledger.mjs';

export class McpPermError extends Error {}
export class McpProtocolError extends Error {}

const DEFAULT_URL = 'https://project.feishu.cn/mcp_server/v1';

/** 凭据解析：完整 URL（含 query）优先，否则拼 MCP_KEY + USER_KEY。缺一即返 null（调用方决定是否提示）。 */
export function resolveEndpoint(env = process.env) {
  if (env.FEISHU_MCP_URL) return env.FEISHU_MCP_URL;
  if (env.FEISHU_MCP_KEY && env.FEISHU_USER_KEY) {
    return `${DEFAULT_URL}?mcpKey=${env.FEISHU_MCP_KEY}&userKey=${env.FEISHU_USER_KEY}`;
  }
  return null;
}

/** 建会话：initialize + initialized。返回 { call, sessionId, serverInfo }。 */
export async function connect(endpoint, { fetchImpl = fetch, timeoutMs = 30_000, client = 'harness-task-loop' } = {}) {
  let sessionId = null;
  const post = async (body) => {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new McpProtocolError(`MCP HTTP ${res.status}`);
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    if (!text.trim()) return null; // 通知类（initialized）无响应体
    const j = JSON.parse(text.startsWith('data:') ? text.split('data:').pop() : text);
    if (j.error) throw new McpProtocolError(JSON.stringify(j.error).slice(0, 200));
    return j;
  };

  const init = await post({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: client, version: '1.0' } },
  });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const call = async (name, args) => {
    const j = await post({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } });
    // 工具级错误在 content[0].text 里（实测形态："error=ErrOapiCallCheckTokenPermFailed,..."）
    const text0 = j?.result?.content?.[0]?.text ?? '';
    const m = /^error=(\w+),message=([^,]*)/.exec(text0);
    if (m) {
      if (/Perm|Token/i.test(m[1])) throw new McpPermError(`${m[1]}: ${m[2].slice(0, 120)}`);
      throw new McpProtocolError(`${m[1]}: ${m[2].slice(0, 120)}`);
    }
    return text0;
  };

  return { call, sessionId, serverInfo: init?.result?.serverInfo ?? null };
}

/**
 * 通道健康探测（doctor 的"task-loop 前提在场性"用）。
 * 三档结论：ok（数据档已配）/ perm（通道通、数据档未配——后台勾选问题，不是代码问题）/ off（未配置凭据）。
 */
export async function probe(endpoint, { fetchImpl = fetch, projectKey = null } = {}) {
  if (!endpoint) return { level: 'off', detail: '未配置 FEISHU_MCP_URL / FEISHU_MCP_KEY' };
  try {
    const c = await connect(endpoint, { fetchImpl });
    // 探测顺序有讲究：先探目标空间（perm=数据档未配），空间不存在再探通道本身（ok=通道与数据档均通）。
    try {
      if (projectKey) {
        await c.call('list_workitem_types', { project_key: projectKey });
        return { level: 'ok', detail: `通道与数据档均通（${c.serverInfo?.name ?? '?'}，空间 ${projectKey}）` };
      }
    } catch (e) {
      if (e instanceof McpPermError) {
        recordEvent('feishu-mcp', 'probe_perm', { detail: e.message.slice(0, 100) });
        return { level: 'perm', detail: `通道通（${c.serverInfo?.name ?? '?'}），但空间 ${projectKey} 数据档未授权：飞书项目后台给 MCP 应用勾选工作项数据读取范围` };
      }
      throw e;
    }
    // 无目标空间：以一个必然不存在的空间探——ProjectNotFound 说明请求穿过了权限层（通道+身份通），
    // CheckTokenPermFailed 说明卡在数据档。两类错误都是"通道活着"的证据，只有网络/协议错才判 error。
    try {
      await c.call('list_workitem_types', { project_key: '__harness_probe_no_such__' });
      return { level: 'ok', detail: `通道通（${c.serverInfo?.name ?? '?'}）` };
    } catch (e) {
      if (e instanceof McpPermError) {
        recordEvent('feishu-mcp', 'probe_perm', { detail: e.message.slice(0, 100) });
        return { level: 'perm', detail: '通道通（46 工具可见），数据档未授权：飞书项目后台给 MCP 应用勾选工作项数据读取范围' };
      }
      if (/ProjectNotFound/.test(e.message)) return { level: 'ok', detail: `通道通（${c.serverInfo?.name ?? '?'}，错误穿透权限层=身份档正常）` };
      throw e;
    }
  } catch (e) {
    return { level: 'error', detail: e.message.slice(0, 140) };
  }
}
