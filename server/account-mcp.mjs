import { timingSafeEqual } from 'node:crypto';

/** 功能：按账号最新完整报告确认可用额度；参数：rows 为同一报告的全部窗口；返回值：仅已知可用返回 true，耗尽或未知返回 false。 */
export function hasUsableQuota(rows) {
  if (!rows.length) return false;
  // 任一窗口耗尽均阻止推荐，重置时间经过也不能替代新的额度读数。
  if (rows.some(row => typeof row.used_percent === 'number' && row.used_percent >= 100)) return false;
  if (rows.every(row => typeof row.used_percent === 'number' && Number.isFinite(row.used_percent) && row.used_percent >= 0 && row.used_percent < 100)) return true;
  return false;
}

const tool = {
  name: 'get_codex_account_status',
  description: '按完整账号 ID 或精确别名查询额度、重置时间和设备状态。',
  inputSchema: {
    type: 'object',
    properties: { account: { type: 'string', minLength: 1, maxLength: 128 } },
    required: ['account'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};
const accountTools = [tool,
  {...tool, name:'list_codex_accounts_with_credit', description:'列出当前有额度的账号及额度、重置时间和在线占用人数。'},
  {...tool, name:'recommend_codex_login_account', description:'无需账号参数，直接从全部可见账号推荐。仅推荐所有窗口使用比例已知且小于100%的账号，剩余比例为100减使用比例，balance余额不参与判断。按管理员状态及在线设备数排序。'},
  {...tool, name:'list_unoccupied_codex_accounts', description:'列出当前没有在线设备占用的账号。'},
];
// 列表查询允许组合筛选，保留旧客户端传入 account 的兼容方式。
for (const item of accountTools.slice(1)) {
  item.inputSchema = {type:'object',properties:{account:{type:'string',minLength:1,maxLength:128},status:{type:'string',enum:['normal','unknown','restricted']},online_count:{type:'integer',minimum:0},offline_count:{type:'integer',minimum:0}},additionalProperties:false};
  item.description += ' 支持 status（正常normal、未知unknown、受限restricted）、online_count和offline_count精确数量组合筛选。';
}
const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];

/**
 * 功能：处理无状态 Streamable HTTP MCP，只允许查询账号在线设备。
 * 参数：req/res 为 HTTP 对象，token 为独立凭据，lookup 为查询函数，readBody/send 为 HTTP 读写函数。
 * 返回值：完成响应的 Promise；工具结果中的 checked_at 为 Unix 秒。
 */
export async function handleAccountMcp(req, res, token, lookup, readBody, send) {
  if (!token || token.length < 32) return send(res, 404, { error: 'not_found' });
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers.origin !== undefined) return send(res, 403, { error: 'origin_not_allowed' });
  const expected = Buffer.from('Bearer ' + token);
  const supplied = Buffer.from(req.headers.authorization ?? '');
  // 独立凭据覆盖协议握手和调用；先比较长度以满足定时安全比较的要求。
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return send(res, 401, { error: 'unauthorized' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'method_not_allowed' });
  }
  const version = req.headers['mcp-protocol-version'];
  if (version !== undefined && !versions.includes(version)) return send(res, 400, { error: 'unsupported_protocol_version' });
  const raw = await readBody(req, res, 8192);
  let message;
  try { message = JSON.parse(raw); } catch {
    return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  // 只接受单个 JSON-RPC 请求，通知不产生 JSON-RPC 响应。
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string'
      || (message.id !== undefined && !['string', 'number'].includes(typeof message.id))) {
    return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
  }
  if (message.id === undefined) return res.writeHead(202).end();
  const reply = { jsonrpc: '2.0', id: message.id };
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      return send(res, 200, { ...reply, result: {
        protocolVersion: versions.includes(requested) ? requested : versions[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'codex-accounts', version: '1.0.0' },
      } });
    }
    case 'ping':
      return send(res, 200, { ...reply, result: {} });
    case 'tools/list':
      return send(res, 200, { ...reply, result: { tools: accountTools } });
    case 'tools/call': {
      const args = message.params?.arguments;
      const account = typeof args?.account === 'string' ? args.account.trim() : '';
      // 校验工具名和参数，防止通过 MCP 分派到任何管理操作。
      if (!args || typeof args !== 'object' || Array.isArray(args) || !accountTools.some(item => item.name === message.params?.name) || (message.params.name === tool.name ? (!account || account.length > 128 || Object.keys(args).length !== 1) : Object.keys(args).some(key => !['account','status','online_count','offline_count'].includes(key)) || (args.account !== undefined && (!account || account.length > 128)) || (args.status !== undefined && !['normal','unknown','restricted'].includes(args.status)) || ['online_count','offline_count'].some(key => args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < 0)))) {
        return send(res, 200, { ...reply, error: { code: -32602, message: 'Invalid tool or account argument' } });
      }
      const result = lookup(account, message.params.name, args);
      const guidance = { ambiguous_use_account_id: '账号别名重名，请提供完整账号 ID。', not_found: '未找到可查询的账号。' };
      return send(res, 200, { ...reply, result: {
        content: [{ type: 'text', text: guidance[result.status] ?? JSON.stringify(result) }],
        isError: result.status !== 'ok',
      } });
    }
    default:
      return send(res, 200, { ...reply, error: { code: -32601, message: 'Method not found' } });
  }
}
