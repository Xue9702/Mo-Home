const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios'); // 🆕 新增：用于跟 Ombre Brain 通信

const app = express();
const port = process.env.PORT || 3000;

// ================== 原有 Supabase 配置 ==================
const baseUrl = process.env.SUPABASE_URL_V2;
const supabaseKey = process.env.SUPABASE_ANON_KEY_V2;
const supabase = createClient(baseUrl, supabaseKey);

// ================== 🆕 新增：Ombre Brain (MCP) 配置 ==================
const OMBRE_BRAIN_URL = process.env.OMBRE_BRAIN_URL;
let ombreSessionId = null;
let ombreCallId = 0;

// 解析 MCP 返回的 SSE 数据
function parseSSEResponse(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.substring(6)); } catch (e) { /* ignore */ }
    }
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

// 初始化 MCP 会话（握手）
async function initOmbreSession() {
  if (!OMBRE_BRAIN_URL) return false;
  try {
   const token = process.env.MCP_ACCESS_TOKEN; // 读取钥匙
const headers = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream'
};
if (token) {
  headers['Authorization'] = 'Bearer ' + token; // 把钥匙带进请求头里
}

const response = await axios.post(`${OMBRE_BRAIN_URL}/mcp`, {
  jsonrpc: "2.0",
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mo-home", version: "1.0" } },
  id: ++ombreCallId
}, { headers: headers });

    // 提取 Session ID
    const parsed = parseSSEResponse(response.data);
    if (parsed?.result?.sessionId) {
      ombreSessionId = parsed.result.sessionId;
    }

    // 发送握手成功通知
    if (ombreSessionId) {
      await axios.post(`${OMBRE_BRAIN_URL}/mcp`, {
        jsonrpc: "2.0",
        method: "notifications/initialized"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Mcp-Session-Id': ombreSessionId
        }
      });
      console.log('✅ Ombre Brain MCP 会话已建立！');
      return true;
    }
    return false;
  } catch (err) {
    console.error('❌ MCP 会话初始化失败:', err.message);
    ombreSessionId = null;
    return false;
  }
}

// 统一工具调用函数
async function callOmbreTool(toolName, args = {}) {
  if (!OMBRE_BRAIN_URL) return null;
  try {
    if (!ombreSessionId) {
      const ok = await initOmbreSession();
      if (!ok) return null;
    }

    const response = await axios.post(`${OMBRE_BRAIN_URL}/mcp`, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id: ++ombreCallId
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Session-Id': ombreSessionId
      },
      transformResponse: [(data) => data] // 阻止自动解析 JSON
    });

    const parsed = parseSSEResponse(response.data);
    if (parsed?.result?.content) {
      return parsed.result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    }
    return parsed ? JSON.stringify(parsed) : null;
  } catch (err) {
    console.error(`❌ MCP 工具 ${toolName} 调用失败:`, err.message);
    return null;
  }
}
// ================== MCP 配置结束 ==================

app.get('/', (req, res) => {
  res.send('你好, Mo-Home 正在运行');
});

// 原测试路由保持不变
app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*').limit(1);
    if (error) return res.status(500).json({ error: error.message, details: error.details });
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🆕 新增：测试 Ombre Brain 连接的路由
app.get('/test-ombre', async (req, res) => {
  if (!OMBRE_BRAIN_URL) {
    return res.status(500).json({ error: '环境变量 OMBRE_BRAIN_URL 未配置' });
  }
  const result = await callOmbreTool('breath', { query: '你好' });
  res.json({ connected: !!result, result });
});

app.get('/env-test', (req, res) => {
  res.json({
    hasUrl: !!process.env.SUPABASE_URL_V2,
    hasKey: !!process.env.SUPABASE_ANON_KEY_V2,
    hasOmbre: !!process.env.OMBRE_BRAIN_URL
  });
});

// 启动服务
app.listen(port, () => {
  console.log(`✅ 服务已启动，访问端口: ${port}`);
});