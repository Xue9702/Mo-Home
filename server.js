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

app.use(express.static('public'));
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

// ------------------ 对话接口（带 Supabase 存储） ------------------
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: '消息不能为空' });
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    return res.status(500).json({ error: 'DeepSeek API Key 未配置' });
  }

  try {
    // 加载最近 25 轮历史消息（包含用户和助手）
    const { data: history, error: historyError } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', 1)
    .order('created_at', { ascending: true })
    .limit(50); // 25轮对话 = 50条消息（用户+助手）

    if (historyError) {
      console.error('加载历史消息失败:', historyError);
    }

    // 构建历史消息列表
    const historyMessages = history ? history.map(msg => ({
      role: msg.role,
      content: msg.content
    })) : [];

    // 1. 保存用户消息到 Supabase
    const userMessage = {
      session_id: 1, // 暂时固定为 1，后续可扩展多会话
      role: 'user',
      content: message,
      visible: true,
      created_at: new Date().toISOString()
    };

    const { data: userData, error: userError } = await supabase
      .from('messages')
      .insert([userMessage])
      .select();

    if (userError) {
      console.error('保存用户消息失败:', userError);
    }

    // 2. 调用 DeepSeek API
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
         ...historyMessages,
          { role: 'user', content: message }
        ],
        reasoning_effort: 'medium', 
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
    const thinking = data.choices?.[0]?.message?.reasoning_content || null;

    // 3. 保存助手回复到 Supabase
    const assistantMessage = {
      session_id: 1,
      role: 'assistant',
      content: reply,
      reasoning_content: thinking,
      visible: true,
      created_at: new Date().toISOString()
    };

    const { data: assistantData, error: assistantError } = await supabase
      .from('messages')
      .insert([assistantMessage])
      .select();

    if (assistantError) {
      console.error('保存助手消息失败:', assistantError);
    }

    res.json({
      reply,
      thinking,
      userMessageId: userData?.[0]?.id || null,
      assistantMessageId: assistantData?.[0]?.id || null
    });

  } catch (err) {
    console.error('对话接口错误:', err.message);
    res.status(500).json({ error: '处理请求时出错' });
  }
});

// ------------------ 获取历史消息 ------------------
app.get('/api/history', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', 1)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('读取历史消息失败:', error);
      return res.status(500).json({ error: '读取历史消息失败' });
    }

    res.json({ messages: data });
  } catch (err) {
    console.error('历史接口错误:', err.message);
    res.status(500).json({ error: '读取历史消息时出错' });
  }
});

// ------------------ 重新生成回复 ------------------
app.post('/api/regenerate', async (req, res) => {
  const { messageId } = req.body;
  console.log('📝 收到重新生成请求，messageId:', messageId, '类型:', typeof messageId);

  if (!messageId) {
    return res.status(400).json({ error: '缺少消息ID' });
  }

  try {
    // 1. 先查出这条消息所属的 session_id 和原始用户消息
    const { data: targetMsg, error: findError } = await supabase
      .from('messages')
      .select('session_id, content, role')
      .eq('id', messageId)
      .single();

    if (findError || !targetMsg) {
      console.error('❌ 查找消息失败:', findError);
      return res.status(404).json({ error: '未找到原始消息' });
    }

    // 只有助手消息才能被重新生成，并且需要找到对应的用户消息
    if (targetMsg.role !== 'assistant') {
      return res.status(400).json({ error: '只能重新生成助手消息' });
    }

    // 查找这条助手消息之前的用户消息
    const { data: userMsg, error: userError } = await supabase
      .from('messages')
      .select('content')
      .eq('session_id', targetMsg.session_id)
      .eq('role', 'user')
      .lt('id', messageId)  // 找比这条消息更早的用户消息
      .order('id', { ascending: false })
      .limit(1);

    if (userError || !userMsg || userMsg.length === 0) {
      console.error('❌ 找不到对应的用户消息:', userError);
      return res.status(404).json({ error: '找不到对应的用户消息' });
    }

    const userContent = userMsg[0].content;
    console.log('✅ 找到对应的用户消息:', userContent);

    // 2. 调用 DeepSeek API
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
          { role: 'user', content: userContent }
        ],
        reasoning_effort: 'medium',
        temperature: 0.7,
        max_tokens: 2048
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ DeepSeek API 错误:', data);
      return res.status(500).json({ error: 'AI 服务暂时不可用' });
    }

    const reply = data.choices?.[0]?.message?.content || '（没有收到回复）';
    const thinking = data.choices?.[0]?.message?.reasoning_content || null;

    // 3. 更新数据库中的回复
    const { error: updateError } = await supabase
      .from('messages')
      .update({
        content: reply,
        reasoning_content: thinking,
        updated_at: new Date().toISOString()
      })
      .eq('id', messageId);

    if (updateError) {
      console.error('❌ 更新消息失败:', updateError);
      return res.status(500).json({ error: '更新消息失败' });
    }

    console.log('✅ 消息更新成功，messageId:', messageId);
    res.json({ reply, thinking, messageId });

  } catch (err) {
    console.error('❌ 重新生成错误:', err.message);
    res.status(500).json({ error: '处理请求时出错' });
  }
});

// 启动服务
app.listen(port, () => {
  console.log(`✅ 服务已启动，访问端口: ${port}`);
});
module.exports = app;