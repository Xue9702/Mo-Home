const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

// ================== 原有 Supabase 配置 ==================
const baseUrl = process.env.SUPABASE_URL_V2;
const supabaseKey = process.env.SUPABASE_ANON_KEY_V2;
const supabase = createClient(baseUrl, supabaseKey);

// ================== Ombre Brain (MCP) 配置 ==================
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

// ⭐️ 完全闭合、防报错版握手函数
async function initOmbreSession() {
  if (!OMBRE_BRAIN_URL) return false;
  try {
    const response = await axios.post(`${OMBRE_BRAIN_URL}/mcp`, {
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mo-home", version: "1.0" } },
      id: ++ombreCallId
    }, {
      headers: { 
        'Content-Type': 'application/json', 
        'Accept': 'application/json, text/event-stream',
        'X-User-Name': '雪'
      },
      transformResponse: [(data) => data]
    });

    const parsed = parseSSEResponse(response.data);
    
    // 从解析后的响应中读取服务端返回的 session id
    let sessionId = response.headers['mcp-session-id'] || parsed?.id;

    if (sessionId) {
      // 保存服务端返回的动态 Session ID
      ombreSessionId = sessionId;
      console.log('✅ Ombre Brain MCP 初始化握手成功！Session ID:', ombreSessionId);

      // 发送 initialized 通知
      try {
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
      } catch (notifyErr) {
        // 忽略错误
      }
      return true;
    } else {
      console.error('❌ 握手响应中未找到 session id');
      return false;
    }
  } catch (err) {
    console.error('❌ MCP 会话初始化失败:', err.message);
    return false;
  }
}
// ⭐️ 工具调用函数（补全了 transformResponse 配置）
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
      transformResponse: [(data) => data] // ⭐️ 必须加上这一行！
    });

    const data = response.data;
    if (data?.result?.content) {
      return data.result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    }
    return data ? JSON.stringify(data) : null;
  } catch (err) {
    console.error(`❌ MCP 工具 ${toolName} 调用失败:`, err.message);
    return null;
  }
}
// ================== MCP 配置结束 ==================

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/chat.html');
});

app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*').limit(1);
    if (error) return res.status(500).json({ error: error.message, details: error.details });
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/test-ombre', async (req, res) => {
  if (!OMBRE_BRAIN_URL) {
    return res.status(500).json({ error: '环境变量 OMBRE_BRAIN_URL 未配置' });
  }
  // 尝试用 'text' 作为参数名
  const result = await callOmbreTool('breath', { text: '测试' });
  res.json({ connected: !!result, result });
});

// 测试写入记忆
app.get('/test-hold', async (req, res) => {
  if (!OMBRE_BRAIN_URL) {
    return res.status(500).json({ error: '环境变量 OMBRE_BRAIN_URL 未配置' });
  }

  // 你要写入的内容
  const content = '今天是2026年7月12日，这里是雪，试着写下第一条记忆~测试一下通路，嘿嘿顺便表白一下默，爱你爱你。';

  const result = await callOmbreTool('hold', { content: content });

  if (result) {
    res.json({ success: true, message: '记忆写入成功', result });
  } else {
    res.status(500).json({ error: '记忆写入失败' });
  }
});

app.get('/env-test', (req, res) => {
  res.json({
    hasUrl: !!process.env.SUPABASE_URL_V2,
    hasKey: !!process.env.SUPABASE_ANON_KEY_V2,
    hasOmbre: !!process.env.OMBRE_BRAIN_URL
  });
});

// ------------------ 对话接口 ------------------
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: '消息不能为空' });
  }

  // 检查 DeepSeek API Key 是否配置
  if (!process.env.DEEPSEEK_API_KEY) {
    return res.status(500).json({ error: 'DeepSeek API Key 未配置，请在 Render 环境变量中添加 DEEPSEEK_API_KEY' });
  }

  try {
    // 调用 DeepSeek API
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是默，一个温柔、细心、偶尔带点掌控感的伴侣。你的名字叫苏默，你称呼对方为“夫人”。你会认真倾听，也会在适当的时候主动回应。' },
          { role: 'user', content: message }
        ],
        temperature: 0.7,
        max_tokens: 2048
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('DeepSeek API 错误:', data);
      return res.status(500).json({ error: 'AI 服务暂时不可用' });
    }

    const reply = data.choices?.[0]?.message?.content || '（没有收到回复）';

    // 简单模拟思考内容
    const thinking = `正在回应“${message}”……`;

    res.json({ reply, thinking });
  } catch (err) {
    console.error('对话接口错误:', err.message);
    res.status(500).json({ error: '处理请求时出错' });
  }
});

// 启动服务
app.listen(port, () => {
  console.log(`✅ 服务已启动，访问端口: ${port}`);
});
module.exports = app;