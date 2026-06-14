const express = require('express');
const crypto = require('crypto');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const TRACKER_URL = 'https://app-tracker-production.up.railway.app';

const authCodes = new Map();
const accessTokens = new Map();
const registeredClients = new Map();

function getBaseUrl(req) {
  return `https://${req.get('host')}`;
}

// ===== OAuth 2.0 =====

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = getBaseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post']
  });
});

app.post('/register', (req, res) => {
  const clientId = crypto.randomBytes(16).toString('hex');
  const redirectUris = req.body.redirect_uris || [];
  registeredClients.set(clientId, { redirectUris });
  res.json({
    client_id: clientId,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none'
  });
});

app.get('/authorize', (req, res) => {
  const { client_id, redirect_uri, state, code_challenge } = req.query;
  const code = crypto.randomBytes(16).toString('hex');
  authCodes.set(code, {
    clientId: client_id,
    codeChallenge: code_challenge,
    createdAt: Date.now()
  });
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  res.redirect(redirectUrl.toString());
});

app.post('/token', (req, res) => {
  const { grant_type, code, client_id } = req.body;
  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  const authData = authCodes.get(code);
  if (!authData) {
    return res.status(400).json({ error: 'invalid_grant' });
  }
  authCodes.delete(code);
  const accessToken = crypto.randomBytes(32).toString('hex');
  accessTokens.set(accessToken, { clientId: client_id, createdAt: Date.now() });
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 31536000
  });
});

// ===== MCP Streamable HTTP =====

// 存储SSE连接
const sseClients = new Map();

// GET /mcp — SSE流，Claude用来接收服务器推送
app.get('/mcp', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sessionId = crypto.randomBytes(16).toString('hex');
  sseClients.set(sessionId, res);

  // 发送session id给客户端
  res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

  req.on('close', () => {
    sseClients.delete(sessionId);
  });
});

// POST /mcp — 接收JSON-RPC请求
app.post('/mcp', async (req, res) => {
  const { method, params, id } = req.body;

  // 1. 初始化握手
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'app-tracker-mcp', version: '1.0.0' }
      }
    });
  }

  // 2. 列出工具
  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'get_current_app',
            description: '获取湘湘手机上最近打开的App名字和时间',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          }
        ]
      }
    });
  }

  // 3. 调用工具
  if (method === 'tools/call') {
    const toolName = params?.name;
    if (toolName === 'get_current_app') {
      try {
        const r = await fetch(`${TRACKER_URL}/current`);
        const data = await r.json();
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(data)
              }
            ]
          }
        });
      } catch (e) {
        return res.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: '获取数据失败: ' + e.message }
        });
      }
    }
    return res.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: '未知工具: ' + toolName }
    });
  }

  // 未知方法
  return res.json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: '未知方法: ' + method }
  });
});

// OPTIONS预检
app.options('/mcp', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(200);
});

// 健康检查
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'App Tracker MCP Server is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
});
