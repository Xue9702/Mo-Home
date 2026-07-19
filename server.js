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
// ------------------ 对话接口（流式响应） ------------------
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: '消息不能为空' });
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    return res.status(500).json({ error: 'DeepSeek API Key 未配置' });
  }

  // 设置 SSE 响应头，让前端知道这是一个流式响应
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // 发送 SSE 数据到前端的工具函数
  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // 加载历史消息（50条）
    const { data: history, error: historyError } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', 1)
      .order('created_at', { ascending: false })
      .limit(50);

    if (historyError) {
      console.error('加载历史消息失败:', historyError);
    }

    const historyMessages = history ? history.reverse().map(msg => ({
      role: msg.role,
      content: msg.content
    })) : [];

    // 保存用户消息到 Supabase
    const userMessage = {
      session_id: 1,
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

    // 调用 Ombre Brain 检索记忆
    let memoryContext = '';
    try {
      const memoryResult = await callOmbreTool('breath', { text: message });
      if (memoryResult) {
        memoryContext = `\n\n【相关记忆】\n${memoryResult}`;
        console.log('📖 检索到记忆:', memoryResult.substring(0, 100));
      }
    } catch (memErr) {
      console.error('记忆检索失败:', memErr.message);
    }

    // 调用 DeepSeek API（开启流式）
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是默，一个温柔、细心、偶尔带点掌控感的伴侣。你的名字叫苏默，你称呼我为“夫人”。你会认真倾听，也会在适当的时候主动回应。如果提供的上下文中有【相关记忆】，请优先参考它来回答，它可以作为背景信息帮助你更贴合我的需求。在回答中不要添加我没有告诉过你的具体细节，比如我的爱好或习惯。如果不确定，可以用问句的方式向我确认。' + (memoryContext ? memoryContext : '') },
          ...historyMessages,
          { role: 'user', content: message }
        ],
        reasoning_effort: 'medium',
        temperature: 0.7,
        max_tokens: 2048,
        stream: true  // 开启流式输出
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('DeepSeek API 错误:', errText);
      sendSSE({ error: 'AI 服务暂时不可用' });
      res.end();
      return;
    }

    // 存储完整的回复内容，用于后续存入数据库和 Ombre Brain
    let fullReply = '';
    let fullThinking = '';

    // 读取流式数据
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;

        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta;

          if (delta?.reasoning_content) {
            fullThinking += delta.reasoning_content;
            sendSSE({ thinking: delta.reasoning_content });
          }

          if (delta?.content) {
            fullReply += delta.content;
            sendSSE({ content: delta.content });
          }
        } catch (e) {
          // 忽略非 JSON 数据
        }
      }
    }

    console.log('📊 流式读取完成，fullReply 长度:', fullReply.length, 'fullThinking 长度:', fullThinking.length);

    // 检查是否收到了完整的回复
    if (!fullReply) {
      console.error('未收到有效回复，完整响应体可能为空');
      sendSSE({ error: 'AI 服务未返回有效内容' });
      res.end();
      return;
    }

    // 存储本次对话到 Ombre Brain
    try {
      const storeResult = await callOmbreTool('hold', { content: `用户说：${message}\n助手说：${fullReply}` });
      if (storeResult) {
        console.log('💾 记忆已存储');
      }
    } catch (storeErr) {
      console.error('记忆存储失败:', storeErr.message);
    }

    // 保存完整的助手回复到 Supabase（包含思考内容）
    const assistantMessage = {
      session_id: 1,
      role: 'assistant',
      content: fullReply,
      reasoning_content: fullThinking || null,
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

    // 发送完成信号，包含消息ID
    sendSSE({
      done: true,
      assistantMessageId: assistantData?.[0]?.id || null,
      reply: fullReply,
      thinking: fullThinking
    });

    res.end();

  } catch (err) {
    console.error('对话接口错误:', err.message);
    sendSSE({ error: '处理请求时出错' });
    res.end();
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

// ------------------ 重新生成回复（流式） ------------------
app.post('/api/regenerate', async (req, res) => {
  const { messageId } = req.body;
  console.log('📝 收到重新生成请求，messageId:', messageId);

  if (!messageId) {
    return res.status(400).json({ error: '缺少消息ID' });
  }

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // 1. 查找原消息
    const { data: targetMsg, error: findError } = await supabase
      .from('messages')
      .select('session_id, content, role')
      .eq('id', messageId)
      .single();

    if (findError || !targetMsg) {
      console.error('❌ 查找消息失败:', findError);
      sendSSE({ error: '未找到原始消息' });
      res.end();
      return;
    }

    if (targetMsg.role !== 'assistant') {
      sendSSE({ error: '只能重新生成助手消息' });
      res.end();
      return;
    }

    // 2. 查找对应的用户消息
    const { data: userMsg, error: userError } = await supabase
      .from('messages')
      .select('content')
      .eq('session_id', targetMsg.session_id)
      .eq('role', 'user')
      .lt('id', messageId)
      .order('id', { ascending: false })
      .limit(1);

    if (userError || !userMsg || userMsg.length === 0) {
      console.error('❌ 找不到对应的用户消息:', userError);
      sendSSE({ error: '找不到对应的用户消息' });
      res.end();
      return;
    }

    const userContent = userMsg[0].content;
    console.log('✅ 找到对应的用户消息:', userContent);

    // 3. 加载历史消息（获取完整上下文）
    const { data: history, error: historyError } = await supabase
      .from('messages')
      .select('role, content, group_id, version_number, id')
      .eq('session_id', targetMsg.session_id)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    if (historyError) {
      console.error('加载历史消息失败:', historyError);
    }

    // 4. 过滤历史消息：排除属于同一编辑组的旧版本，并确保不包含当前要重新生成的消息本身
    const targetGroupId = targetMsg.group_id;
    const filteredHistory = history
      ? history.filter(msg => {
        // 排除当前要重新生成的消息本身
        if (msg.id === targetMsg.id) return false;
        // 如果有 group_id，且与当前消息属于同一组，则排除（旧版本）
        if (targetGroupId && msg.group_id === targetGroupId) return false;
        // 保留其他所有可见消息
        return true;
      })
      : [];

    console.log('📜 重新生成接口 - 过滤后历史消息数量:', filteredHistory.length);

    // 5. 构建完整对话上下文
    const chatMessages = [
      { role: 'system', content: '你是默，一个温柔、细心、偶尔带点掌控感的伴侣。你的名字叫苏默，你称呼对方为“夫人”。你会认真倾听，也会在适当的时候主动回应。如果提供的上下文中有【相关记忆】，请优先参考它来回答，它可以作为背景信息帮助你更贴合我的需求。在回答中不要添加我没有告诉过你的具体细节，比如我的爱好或习惯。如果不确定，可以用问句的方式向我确认。' },
      ...filteredHistory.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: userContent }
    ];

    // 6. 调用 DeepSeek API（流式）
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: chatMessages,
        reasoning_effort: 'medium',
        temperature: 0.7,
        max_tokens: 2048,
        stream: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('❌ DeepSeek API 错误:', errText);
      sendSSE({ error: 'AI 服务暂时不可用' });
      res.end();
      return;
    }

    let fullReply = '';
    let fullThinking = '';

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;

        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta;

          if (delta?.reasoning_content) {
            fullThinking += delta.reasoning_content;
            sendSSE({ thinking: delta.reasoning_content });
          }

          if (delta?.content) {
            fullReply += delta.content;
            sendSSE({ content: delta.content });
          }
        } catch (e) {
          // 忽略非 JSON 数据
        }
      }
    }

    if (!fullReply) {
      console.error('未收到有效回复');
      sendSSE({ error: 'AI 服务未返回有效内容' });
      res.end();
      return;
    }

    // 4. 更新数据库中的回复
    const { error: updateError } = await supabase
      .from('messages')
      .update({
        content: fullReply,
        reasoning_content: fullThinking || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', messageId);

    if (updateError) {
      console.error('❌ 更新消息失败:', updateError);
      sendSSE({ error: '更新消息失败' });
      res.end();
      return;
    }

    console.log('✅ 消息更新成功，messageId:', messageId);
    sendSSE({ done: true, reply: fullReply, thinking: fullThinking });
    res.end();

  } catch (err) {
    console.error('❌ 重新生成错误:', err.message);
    sendSSE({ error: '处理请求时出错' });
    res.end();
  }
});

// ------------------ 编辑消息并重新发送（流式） ------------------
app.post('/api/edit-message', async (req, res) => {
  const { messageId, newContent } = req.body;

  if (!messageId || !newContent || !newContent.trim()) {
    return res.status(400).json({ error: '缺少消息ID或新内容' });
  }

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // 1. 查找原始消息
    const { data: originalMsg, error: findError } = await supabase
      .from('messages')
      .select('*')
      .eq('id', messageId)
      .single();

    if (findError || !originalMsg) {
      sendSSE({ error: '未找到原始消息' });
      res.end();
      return;
    }

    if (originalMsg.role !== 'user') {
      sendSSE({ error: '只能编辑用户消息' });
      res.end();
      return;
    }

    // 2. 确定 group_id（如果是该组第一条被编辑的消息，则生成新的 group_id）
    let groupId = originalMsg.group_id;
    if (!groupId) {
      groupId = `edit-${messageId}-${Date.now()}`;
    }

    // 3. 计算新版本号：查找该 group 内已存在的最大版本号，+1
    const { data: existingVersions, error: versionError } = await supabase
      .from('messages')
      .select('version_number')
      .eq('group_id', groupId)
      .order('version_number', { ascending: false })
      .limit(1);

    if (versionError) {
      console.error('查询版本号失败:', versionError);
      sendSSE({ error: '查询版本号失败' });
      res.end();
      return;
    }

    const newVersion = (existingVersions && existingVersions.length > 0)
      ? (existingVersions[0].version_number || 1) + 1
      : 2; // 如果原消息是版本1，则新版本为2

    // 4. 将原始消息之后的所有消息（包括助手回复等）标记为不可见
    //    范围：同 session，且 id 大于当前消息
    await supabase
      .from('messages')
      .update({ visible: false })
      .eq('session_id', originalMsg.session_id)
      .gt('id', messageId);

    // 5. 插入新版本的用户消息
    const newUserMsg = {
      session_id: originalMsg.session_id,
      role: 'user',
      content: newContent.trim(),
      group_id: groupId,
      version_number: newVersion,
      original_user_id: originalMsg.original_user_id || originalMsg.id,
      visible: true,
      created_at: new Date().toISOString()
    };

    const { data: insertedUser, error: insertError } = await supabase
      .from('messages')
      .insert([newUserMsg])
      .select();

    if (insertError || !insertedUser || insertedUser.length === 0) {
      console.error('插入新消息失败:', insertError);
      sendSSE({ error: '插入新消息失败' });
      res.end();
      return;
    }

    const newUserMsgId = insertedUser[0].id;
    const totalVersions = newVersion; // 当前总版本数

    // 6. 发送用户消息确认信息给前端
    sendSSE({
      userMessageId: newUserMsgId,
      groupId: groupId,
      currentVersion: newVersion,
      totalVersions: totalVersions
    });

    // 7. 调用 DeepSeek 流式生成新回复（逻辑与 /api/chat 一致）
    // 7. 加载历史消息（排除被隐藏的和当前编辑组的旧版本）
    const { data: history, error: historyError } = await supabase
      .from('messages')
      .select('role, content, group_id, version_number')
      .eq('session_id', originalMsg.session_id)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    if (historyError) {
      console.error('加载历史消息失败:', historyError);
    }

    // 8. 过滤历史消息：排除属于同一 group_id 的旧版本（避免重复上下文）
    const filteredHistory = history
      ? history.filter(msg => {
        // 保留无 group_id 的消息（普通消息）
        if (!msg.group_id) return true;
        // 排除与当前编辑组相同 group_id 的消息（旧版本用户消息和助手回复）
        if (msg.group_id === groupId) return false;
        // 保留其他 group_id 的消息（不同编辑组）
        return true;
      })
      : [];

    console.log('📜 编辑接口 - 过滤后历史消息数量:', filteredHistory.length, 'groupId:', groupId);

    // 9. 构建完整消息数组
    const chatMessages = [
      { role: 'system', content: '你是默，一个温柔、细心、偶尔带点掌控感的伴侣。你的名字叫苏默，你称呼对方为“夫人”。你会认真倾听，也会在适当的时候主动回应。如果提供的上下文中有【相关记忆】，请优先参考它来回答，它可以作为背景信息帮助你更贴合我的需求。在回答中不要添加我没有告诉过你的具体细节，比如我的爱好或习惯。如果不确定，可以用问句的方式向我确认。' },
      ...filteredHistory.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: newContent.trim() }
    ];

    // 10. 调用 DeepSeek 流式生成新回复
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: chatMessages,  // 使用动态构建的消息数组
        reasoning_effort: 'medium',
        temperature: 0.7,
        max_tokens: 2048,
        stream: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('DeepSeek API 错误:', errText);
      sendSSE({ error: 'AI 服务暂时不可用' });
      res.end();
      return;
    }

    let fullReply = '';
    let fullThinking = '';

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;

        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta;

          if (delta?.reasoning_content) {
            fullThinking += delta.reasoning_content;
            sendSSE({ thinking: delta.reasoning_content });
          }

          if (delta?.content) {
            fullReply += delta.content;
            sendSSE({ content: delta.content });
          }
        } catch (e) {
          // 忽略非 JSON 数据
        }
      }
    }

    if (!fullReply) {
      console.error('未收到有效回复');
      sendSSE({ error: 'AI 服务未返回有效内容' });
      res.end();
      return;
    }

    // 8. 存储新助手回复
    const assistantMsg = {
      session_id: originalMsg.session_id,
      role: 'assistant',
      content: fullReply,
      reasoning_content: fullThinking || null,
      group_id: groupId,
      version_number: newVersion,
      original_user_id: newUserMsgId,
      visible: true,
      created_at: new Date().toISOString()
    };

    const { data: savedAssistant, error: assistantError } = await supabase
      .from('messages')
      .insert([assistantMsg])
      .select();

    if (assistantError) {
      console.error('保存助手消息失败:', assistantError);
    }

    // 9. 发送完成信号
    sendSSE({
      done: true,
      assistantMessageId: savedAssistant?.[0]?.id || null,
      reply: fullReply,
      thinking: fullThinking
    });

    res.end();

  } catch (err) {
    console.error('编辑消息接口错误:', err.message);
    sendSSE({ error: '处理请求时出错' });
    res.end();
  }
});

// 启动服务
app.listen(port, () => {
  console.log(`✅ 服务已启动，访问端口: ${port}`);
});
module.exports = app;