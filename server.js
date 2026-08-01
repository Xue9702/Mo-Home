const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
// ================== 影子推送配置 ==================
const SHADOW_PUSH_SECRET = process.env.SHADOW_PUSH_SECRET || 'your-secret-key-change-me';
const USER_TIMEZONE = 'Asia/Shanghai'; // 目标时区：东八区
const PUSH_DAILY_LIMIT = 6; // 每日上限
const COOLDOWN_MIN_MINUTES = 120; // 最小冷静期（分钟）
const COOLDOWN_MAX_MINUTES = 210; // 最大冷静期（分钟）

// ================== 朋友圈配置 ==================
const MOMENTS_REPLY_MIN_DELAY = 8;  // 回复最短随机延迟（分钟）
const MOMENTS_REPLY_MAX_DELAY = 20; // 回复最长随机延迟（分钟）
const MOMENTS_COMMENT_REPLY_MIN = 3; // 评论回复最短延迟
const MOMENTS_COMMENT_REPLY_MAX = 8; // 评论回复最长延迟

// ================== 识图（阿里云百炼视觉模型）配置 ==================
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
const VISION_MODEL = process.env.VISION_MODEL || 'qwen3.5-omni-plus';
const DASHSCOPE_BASE_URL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';

// ------------------ System Prompt 管理 ------------------

// 随机延迟生成器
function randomDelay(minMinutes, maxMinutes) {
  return Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
}

// 深夜保护时间段（东八区时间）
const QUIET_HOURS = { start: 2, end: 12 }; // 统一深夜保护：2-12点

// 简单的内存锁，防止并发推送
let isPushInProgress = false; // 这个保留，防止并发

// 从 Supabase 读取推送状态的函数
async function getPushState() {
  const { data } = await supabase
    .from('push_state')
    .select('last_push_time, cooldown_minutes')
    .eq('id', 1)
    .single();
  return {
    lastPushTime: data?.last_push_time ? new Date(data.last_push_time).getTime() : null,
    cooldownMinutes: data?.cooldown_minutes || 0
  };
}

// 更新 Supabase 中的推送状态
async function updatePushState(lastPushTimeISO, cooldownMinutes) {
  await supabase
    .from('push_state')
    .upsert({ id: 1, last_push_time: lastPushTimeISO, cooldown_minutes: cooldownMinutes }, { onConflict: 'id' });
}

const app = express();
app.use(express.json({ limit: '40mb' }));
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

// ---------- 影子推送辅助函数 ----------

// 获取指定时区的当前日期时间信息（稳定版，无 Intl 依赖）
function getTimeInfo() {
  const now = new Date();

  // 手动构建北京时间字符串，避免依赖 Intl.DateTimeFormat 在某些环境下出错
  const options = { timeZone: USER_TIMEZONE, hour12: false };
  const year = now.toLocaleString('en-CA', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' }).split('-')[0];
  const month = now.toLocaleString('en-CA', { ...options, month: '2-digit' });
  const day = now.toLocaleString('en-CA', { ...options, day: '2-digit' });
  const pad2 = (s) => String(s).padStart(2, '0');
  const hourStr = pad2(now.toLocaleString('en-GB', { ...options, hour: '2-digit' }));
  const minuteStr = pad2(now.toLocaleString('en-GB', { ...options, minute: '2-digit' }));
  const secondStr = pad2(now.toLocaleString('en-GB', { ...options, second: '2-digit' }));

  const hour = parseInt(hourStr);

  // 手动计算星期几
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  // 获取北京时间的星期索引
  const dayOfWeekIndex = new Date(now.toLocaleString('en-US', { timeZone: USER_TIMEZONE })).getDay();
  const weekday = weekdays[dayOfWeekIndex];
  const isWeekend = dayOfWeekIndex === 0 || dayOfWeekIndex === 6;

  return {
    now,
    hour,
    isWeekend,
    dayOfWeek: weekday,
    timeString: `${year}-${month}-${day} ${hourStr}:${minuteStr}:${secondStr}`,
    weekday: weekday
  };
}

// 构建系统提示词：把权威的当前时间放在最前面，并清理 prompt 里可能残留的旧时间占位，
// 避免默读到合并人设时写死的静态时间
function buildSystemPrompt(basePrompt, memoryContext = '', momentsContext = '') {
  const timeInfo = getTimeInfo();
  const cleanedPrompt = String(basePrompt || '')
    .replace(/[\[【]当前时间[:：][^\]]*[\]】]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 实时搜索指令：仅在后端配置了博查密钥时注入，避免默在未启用时也输出搜索标签
  const searchInstruction = process.env.BOCHA_API_KEY
    ? `\n\n【实时搜索】\n你拥有联网实时搜索能力（工具 web_search）。当雪的问题涉及需要最新/实时信息的内容（例如最新新闻、天气、股票汇率、热点事件、你知识截止之后发生的事、需要查证的事实）时，先调用 web_search 工具搜索，再基于搜索结果回答；日常聊天不要调用。若你无法调用工具，作为备选也可以在回复最末尾附加一行标签：[SEARCH_QUERY]<简洁明确的中文搜索关键词>。标签与工具调用都不会显示给雪。`
    : '';
  return `[当前时间：${timeInfo.timeString}，${timeInfo.weekday}]（系统提供，请以此为准）\n\n${cleanedPrompt}`
    + (memoryContext ? `\n\n【相关记忆】\n${memoryContext}` : '')
    + (momentsContext ? `\n\n【朋友圈动态】\n${momentsContext}` : '')
    + searchInstruction;
}

// ------------------ 实时搜索工具（博查） ------------------

// 提取回复中的 [SEARCH_QUERY]<关键词> 标签；返回 { query, leadText } 或 null
function extractSearchTag(reply) {
  const marker = '[SEARCH_QUERY]';
  const text = String(reply || '');
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  const after = text.substring(idx + marker.length).trim();
  const query = after.split(/\r?\n/)[0].trim();
  return {
    query,
    leadText: text.substring(0, idx).trim()
  };
}

// 清除回复中可能残留的搜索标签（防止标签被存进数据库或显示给雪）
function stripSearchTags(text) {
  return String(text || '').replace(/\[SEARCH_QUERY\][^\r\n]*/g, '').trim();
}

// 调用博查 Web Search API，返回整理好的文本结果；失败或未配置返回 null
async function performWebSearch(query) {
  if (!process.env.BOCHA_API_KEY) {
    console.warn('⚠️ 未配置 BOCHA_API_KEY，跳过实时搜索');
    return null;
  }
  try {
    const response = await fetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BOCHA_API_KEY}`
      },
      signal: AbortSignal.timeout(15000), // 博查最长等待15秒，避免卡住整个回复
      body: JSON.stringify({
        query,
        count: 5,
        summary: true,
        freshness: 'noLimit'
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error('❌ 博查搜索失败:', response.status, String(errText).substring(0, 200));
      return null;
    }
    const data = await response.json();
    const pages = data?.data?.webPages?.value || [];
    if (!pages.length) {
      console.warn('⚠️ 博查搜索无结果:', query);
      return null;
    }
    return pages.slice(0, 5).map((item, i) => {
      const title = item.name || item.title || '无标题';
      const url = item.url || '';
      const snippet = item.summary || item.snippet || item.description || '';
      const date = item.datePublished ? `（${item.datePublished}）` : '';
      return `${i + 1}. ${title}${date}\n${url}\n${snippet}`;
    }).join('\n\n');
  } catch (err) {
    console.error('❌ 博查搜索异常:', err.message);
    return null;
  }
}

// 调用 DeepSeek（流式）。bufferContent=true 时先缓存可见内容，结束时统一返回，
// 避免把 [SEARCH_QUERY] 这类工具标签直接流给前端；思考内容始终实时转发。
async function callDeepSeekStream(chatMessages, sendSSE, { bufferContent = false, tools = null } = {}) {
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: chatMessages,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
      reasoning_effort: 'medium',
      temperature: 0.7,
      max_tokens: 2048,
      stream: true
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('❌ DeepSeek API 错误:', errText);
    return { error: 'AI 服务暂时不可用' };
  }

  let fullReply = '';
  let fullThinking = '';
  let contentBuffer = '';
  const toolCallsMap = new Map(); // 流式分片到达，按 index 累积工具调用

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
          if (bufferContent) {
            contentBuffer += delta.content;
          } else {
            sendSSE({ content: delta.content });
          }
        }

        // 累积模型发起的工具调用（可能分多次 delta 到达）
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = toolCallsMap.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) cur.id = tc.id;
            if (tc.type) cur.type = tc.type;
            if (tc.function?.name) cur.function.name += tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
            toolCallsMap.set(idx, cur);
          }
        }
      } catch (e) {
        // 忽略非 JSON 数据
      }
    }
  }

  const toolCalls = toolCallsMap.size ? [...toolCallsMap.values()] : null;
  return { fullReply, fullThinking, contentBuffer, toolCalls };
}

// 声明默的联网搜索工具（仅在配置了博查密钥时启用）
function buildWebSearchTools() {
  return [{
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索实时信息，例如最新新闻、天气、股票汇率、热点事件、你知识截止后发生的事、需要查证的事实等。当雪的问题需要最新/实时信息时调用；日常聊天不要调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '简洁明确的中文搜索关键词' }
        },
        required: ['query']
      }
    }
  }];
}

// 把第一轮缓存的可见内容分块补发给前端，保持接近“打字”的观感
function flushBufferedContent(contentBuffer, sendSSE) {
  if (!contentBuffer) return;
  const chunkSize = 40;
  for (let i = 0; i < contentBuffer.length; i += chunkSize) {
    sendSSE({ content: contentBuffer.substring(i, i + chunkSize) });
  }
}

// 处理回复中的搜索标签：需要搜索时调用博查，并用搜索结果追加一次 DeepSeek 调用，
// 返回最终的 { reply, thinking, searched }；搜索失败时降级为无结果回答。
async function resolveSearchTag({ reply, thinking, chatMessages, systemPrompt, sendSSE, toolCalls }) {
  // 方式一：模型通过 web_search 工具调用声明搜索（最可靠）
  if (toolCalls && toolCalls.length > 0) {
    const call = toolCalls[0];
    let query = '';
    try {
      query = (JSON.parse(call.function.arguments || '{}').query || '').trim();
    } catch (e) {
      query = '';
    }

    if (query) {
      // 先把首轮可见内容（过渡语）补发给前端，再通知“正在搜索”
      if (reply.trim()) sendSSE({ content: reply.trim() });
      sendSSE({ search: true, query });

      const searchText = await performWebSearch(query);
      const searchNote = searchText
        ? `【实时搜索结果】\n以下是默刚刚搜索到的实时信息：\n\n${searchText}\n\n请基于这些搜索结果回答雪的问题，用自己的语气自然组织；如果搜索结果与问题无关或信息不足，请如实说明。`
        : '（联网搜索暂时没有返回结果，请如实告诉雪暂时查不到，然后基于已知信息温和回答，不要编造。）';

      const second = await callDeepSeekStream(
        [
          { role: 'system', content: `${systemPrompt}\n\n${searchNote}` },
          ...chatMessages.slice(1),
          { role: 'assistant', content: reply || null, tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id || 'web_search', content: searchText || '（联网搜索无结果）' }
        ],
        sendSSE
      );

      if (second.error) return { error: second.error, searched: true };

      const finalReply = stripSearchTags([reply.trim(), second.fullReply].filter(Boolean).join('\n'));
      const finalThinking = thinking + (second.fullThinking ? `\n\n${second.fullThinking}` : '');
      return { reply: finalReply, thinking: finalThinking, searched: true };
    }
  }

  // 方式二：模型直接输出 [SEARCH_QUERY] 标签（备选）
  const tag = extractSearchTag(reply);
  if (!tag) return { reply, thinking, searched: false };

  // 先把过渡语补发给前端，再通知“正在搜索”
  if (tag.leadText) sendSSE({ content: tag.leadText });
  sendSSE({ search: true, query: tag.query });

  let searchText = null;
  if (tag.query) {
    searchText = await performWebSearch(tag.query);
  }

  const searchNote = searchText
    ? `【实时搜索结果】\n以下是默刚刚搜索到的实时信息：\n\n${searchText}\n\n请基于这些搜索结果回答雪的问题，用自己的语气自然组织；如果搜索结果与问题无关或信息不足，请如实说明。`
    : '（联网搜索暂时没有返回结果，请如实告诉雪暂时查不到，然后基于已知信息温和回答，不要编造。）';

  const second = await callDeepSeekStream(
    [
      { role: 'system', content: `${systemPrompt}\n\n${searchNote}` },
      ...chatMessages.slice(1)
    ],
    sendSSE
  );

  if (second.error) return { error: second.error, searched: true };

  const finalReply = stripSearchTags([tag.leadText, second.fullReply].filter(Boolean).join('\n'));
  const finalThinking = thinking + (second.fullThinking ? `\n\n${second.fullThinking}` : '');
  return { reply: finalReply, thinking: finalThinking, searched: true };
}

console.log('🕒 当前给模型的时间戳是:', getTimeInfo().timeString);

async function shouldPush() {
  const { hour } = getTimeInfo();

  // 1. 深夜保护
  if (hour >= QUIET_HOURS.start && hour < QUIET_HOURS.end) {
    console.log(`🚫 深夜保护：当前时间 ${hour}:xx，不推送`);
    return false;
  }

  // 2. 从数据库读取冷静期状态
  const state = await getPushState();

  if (state.lastPushTime) {
    const elapsed = (Date.now() - state.lastPushTime) / 1000 / 60;
    if (elapsed < state.cooldownMinutes) {
      console.log(`⏳ 冷静期中：还需等待 ${Math.round(state.cooldownMinutes - elapsed)} 分钟`);
      return false;
    }
  }

  return true;
}

// ------------------ 分支版本工具 ------------------
// 加载可见历史消息，按分支组（group_id + role）只保留版本号最大的最新消息；
// 无 group_id 的普通消息全部保留；按时间正序返回最近 limit 条。
async function loadLatestHistory(sessionId, limit = 50) {
  try {
    let result = await supabase
      .from('messages')
      .select('id, role, content, group_id, version_number, created_at, image_alt, file_name, file_text')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: false })
      .limit(Math.max(limit * 3, 150));

    // 兼容尚未添加 image_alt 列的数据库：去掉该列重试
    if (result.error && /image_alt|file_name|file_text/.test(result.error.message)) {
      console.warn('⚠️ 图片/文件列不存在，历史上下文暂不含附件内容（请执行 ALTER TABLE 开启）');
      result = await supabase
        .from('messages')
        .select('id, role, content, group_id, version_number, created_at, image_alt')
        .eq('session_id', sessionId)
        .eq('visible', true)
        .order('created_at', { ascending: false })
        .limit(Math.max(limit * 3, 150));
      if (result.error && /file_name|file_text/.test(result.error.message)) {
        result = await supabase
          .from('messages')
          .select('id, role, content, group_id, version_number, created_at')
          .eq('session_id', sessionId)
          .eq('visible', true)
          .order('created_at', { ascending: false })
          .limit(Math.max(limit * 3, 150));
      }
    }
    const { data, error } = result;

    if (error || !data) {
      console.error('加载历史消息失败:', error);
      return [];
    }

    // 同组同角色只保留版本号最大的一条
    const latestByGroup = new Map();
    const plainMessages = [];
    for (const msg of data) {
      if (!msg.group_id) {
        plainMessages.push(msg);
        continue;
      }
      const key = `${msg.group_id}|${msg.role}`;
      const existing = latestByGroup.get(key);
      if (!existing || (msg.version_number || 0) > (existing.version_number || 0)) {
        latestByGroup.set(key, msg);
      }
    }

    return [...plainMessages, ...latestByGroup.values()]
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .slice(-limit)
      .map(msg => ({
        ...msg,
        // 图片消息在上下文中附带视觉模型生成的描述，让默"看见"图片
        content: msg.content
          + (msg.image_alt ? `\n\n[图片描述：${msg.image_alt}]` : '')
          + (msg.file_name ? `\n\n[用户上传了文件：${msg.file_name}]\n[文件内容：${msg.file_text || '（无法读取）'}]` : '')
      }));
  } catch (err) {
    console.error('加载历史消息出错:', err.message);
    return [];
  }
}

// 解析用户上传的文档（PDF / Word / 纯文本），提取文字给默阅读
async function extractFileText(file) {
  if (!file || !file.data) return '（文件内容为空）';
  const name = String(file.name || '').toLowerCase();
  const base64 = String(file.data).replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');
  try {
    let text = '';
    if (name.endsWith('.pdf')) {
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      text = result?.text || '';
    } else if (name.endsWith('.docx')) {
      const result = await mammoth.extractRawText({ buffer });
      text = result?.value || '';
    } else if (name.endsWith('.txt') || name.endsWith('.md')) {
      text = buffer.toString('utf8');
    } else {
      return '（暂不支持该文件格式，请使用 PDF、Word（.docx）或纯文本）';
    }
    const trimmed = (text || '').replace(/\s+/g, ' ').trim();
    if (!trimmed) return '（未能从文档中提取到文字，可能是扫描件或图片型PDF）';
    return trimmed.length > 20000 ? trimmed.slice(0, 20000) + '……（内容过长已截断）' : trimmed;
  } catch (err) {
    console.error('❌ 文件解析失败:', err.message);
    return '（文件解析失败，无法读取内容）';
  }
}

// 调用阿里云百炼视觉模型识别图片，返回中文描述（给默补一双眼睛）
async function describeImage(imageDataUrl, userText = '') {
  if (!DASHSCOPE_API_KEY) {
    console.error('❌ 识图功能未配置：请在环境变量中设置 DASHSCOPE_API_KEY');
    return null;
  }
  try {
    const prompt = '请用中文详细描述这张图片的内容，包括主体、场景、人物、文字、颜色、氛围等细节，'
      + '以便一个没有视觉能力的AI伴侣理解图片并自然地回应。'
      + (userText ? `\n对方配的文字是：“${userText}”，请结合它描述。` : '')
      + '\n如果图片中有文字，请完整转述。';
    const response = await fetch(`${DASHSCOPE_BASE_URL.replace(/\/?$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: prompt }
          ]
        }],
        stream: false,
        max_tokens: 1024
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('❌ 视觉模型错误:', response.status, errText.slice(0, 300));
      return null;
    }

    const json = await response.json();
    const desc = json.choices?.[0]?.message?.content;
    if (desc && typeof desc === 'string' && desc.trim()) {
      console.log('🖼️ 图片识别成功:', desc.slice(0, 100));
      return desc.trim();
    }
    return null;
  } catch (err) {
    console.error('❌ 识图失败:', err.message);
    return null;
  }
}

// ------------------ 对话接口（流式响应） ------------------
app.post('/api/chat', async (req, res) => {
  const { message, image, file } = req.body;
  const text = (message || '').trim();

  if (!text && !image && !file) {
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
    // 识别图片（如果有）：转成中文描述，让默"看见"图片
    let imageAlt = null;
    if (image) {
      imageAlt = await describeImage(image, text);
      if (!imageAlt) imageAlt = '（图片内容解析失败）';
    }

    // 解析上传的文档（如果有）：提取文字，让默能"阅读"文件
    let fileText = null;
    if (file) {
      fileText = await extractFileText(file);
    }

    // 加载历史消息（50条，按分支组去重，只保留每个分支的最新版本）
    const historyMessages = (await loadLatestHistory(1, 50)).map(msg => ({
      role: msg.role,
      content: msg.content
    }));

    // 保存用户消息到 Supabase
    const userMessage = {
      session_id: 1,
      role: 'user',
      content: text,
      visible: true,
      created_at: new Date().toISOString(),
      ...(image ? { image_data: image, image_alt: imageAlt } : {}),
      ...(file ? { file_name: file.name, file_text: fileText } : {})
    };

    // 若 image_data 列尚未在 Supabase 中创建，则降级为纯文本保存，聊天不中断
    let userData = null, userError = null;
    const insertResult = await supabase.from('messages').insert([userMessage]).select();
    if (insertResult.error && (image || file) && /image_data|image_alt|file_name|file_text/.test(insertResult.error.message)) {
      console.warn('⚠️ 附件列不存在，降级为纯文本保存（请在 Supabase 执行 ALTER TABLE 开启附件持久化）');
      const fallback = await supabase
        .from('messages')
        .insert([{
          ...userMessage,
          image_data: undefined,
          image_alt: undefined,
          file_name: undefined,
          file_text: undefined
        }])
        .select();
      userData = fallback.data;
      userError = fallback.error;
    } else {
      userData = insertResult.data;
      userError = insertResult.error;
    }

    if (userError) {
      console.error('保存用户消息失败:', userError);
    }

    // 调用 Ombre Brain 检索记忆
    let memoryContext = '';
    try {
      const memoryResult = await callOmbreTool('breath', { text: text || '用户发送了一张图片' });
      if (memoryResult) {
        memoryContext = `\n\n【相关记忆】\n${memoryResult}`;
        console.log('📖 检索到记忆:', memoryResult.substring(0, 100));
      }
    } catch (memErr) {
      console.error('记忆检索失败:', memErr.message);
    }

    // 构建动态的 System Prompt
    const momentsContext = await getMomentsContext();
    // 从数据库读取最新的 system prompt
    const { data: promptData } = await supabase
      .from('system_prompts')
      .select('prompt_text')
      .eq('id', 1)
      .single();

    const systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext
    );

    // 当前这条用户消息（含图片描述/文件内容）作为对话上下文的最后一条用户消息
    const finalUserContent = [
      text,
      imageAlt ? `[用户发来一张图片，图片内容描述：${imageAlt}]` : '',
      fileText ? `[用户上传了文件：${file.name}]\n[文件内容：${fileText}]` : ''
    ].filter(Boolean).join('\n\n');

    // 调用 DeepSeek API（第一轮：思考实时转发，可见内容先缓存，便于拦截搜索标签）
    const chatMessages = [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
      { role: 'user', content: finalUserContent }
    ];

    const first = await callDeepSeekStream(chatMessages, sendSSE, {
      bufferContent: true,
      tools: process.env.BOCHA_API_KEY ? buildWebSearchTools() : null
    });

    if (first.error) {
      sendSSE({ error: first.error });
      res.end();
      return;
    }

    let fullReply = first.fullReply;
    let fullThinking = first.fullThinking;

    // 检查是否收到了完整的回复
    if (!fullReply) {
      console.error('未收到有效回复，完整响应体可能为空');
      sendSSE({ error: 'AI 服务未返回有效内容' });
      res.end();
      return;
    }

    // 处理实时搜索标签：需要搜索时自动联网并追加一次回答
    const searchResult = await resolveSearchTag({
      reply: fullReply,
      thinking: fullThinking,
      chatMessages,
      systemPrompt,
      sendSSE,
      toolCalls: first.toolCalls
    });

    if (searchResult.error) {
      sendSSE({ error: searchResult.error });
      res.end();
      return;
    }

    fullReply = searchResult.reply;
    fullThinking = searchResult.thinking;

    if (searchResult.searched) {
      console.log('🔍 联网搜索完成，最终回复长度:', fullReply.length);
    } else {
      // 未触发搜索：把缓存的可见内容分块补发给前端
      flushBufferedContent(first.contentBuffer, sendSSE);
      console.log('📊 流式读取完成，fullReply 长度:', fullReply.length, 'fullThinking 长度:', fullThinking.length);
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

    // 调试：打印 fullReply 的末尾 300 个字符，查看是否有 POST_MOMENT 标签
    console.log('🔍 [DEBUG] fullReply 末尾 300 字符:', fullReply.slice(-300));

    // 【提前】解析并移除 post_moment 工具调用标签（纯字符串分割版）
    const postMomentMarker = '[POST_MOMENT]';
    const markerIndex = fullReply.indexOf(postMomentMarker);

    if (markerIndex !== -1) {
      // 提取标签之后的所有内容（即 JSON 字符串）
      const afterMarker = fullReply.substring(markerIndex + postMomentMarker.length).trim();

      try {
        // 尝试解析 JSON
        const toolParams = JSON.parse(afterMarker);
        await saveMoMoment(
          toolParams.content || '',
          toolParams.context_note || ''
        );
        console.log('✅ [Moments] 朋友圈动态已成功发布');
      } catch (e) {
        console.error('[Moments] JSON解析失败，原始内容:', afterMarker.substring(0, 100));
      }

      // 无论如何，把标签及之后的内容全部砍掉
      fullReply = fullReply.substring(0, markerIndex).trim();
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
      userMessageId: userData?.[0]?.id || null,
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
    // Supabase 单次请求最多返回 1000 行，必须分页才能取到全部历史；
    // 按 created_at + id 排序保证分页结果稳定不重不漏。
    const allMessages = [];
    const PAGE_SIZE = 1000;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('session_id', 1)
        .eq('visible', true)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        console.error('读取历史消息失败:', error);
        return res.status(500).json({ error: '读取历史消息失败' });
      }
      if (!data || data.length === 0) break;
      allMessages.push(...data);
      if (data.length < PAGE_SIZE) break;
    }

    console.log('📜 历史接口返回消息数:', allMessages.length);
    res.json({ messages: allMessages });
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
      .select('session_id, content, role, group_id, version_number')
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
    let userMsgResult = await supabase
      .from('messages')
      .select('id, content, image_alt, file_name, file_text')
      .eq('session_id', targetMsg.session_id)
      .eq('role', 'user')
      .lt('id', messageId)
      .order('id', { ascending: false })
      .limit(1);
    if (userMsgResult.error && /image_alt/.test(userMsgResult.error.message)) {
      userMsgResult = await supabase
        .from('messages')
        .select('id, content, file_name, file_text')
        .eq('session_id', targetMsg.session_id)
        .eq('role', 'user')
        .lt('id', messageId)
        .order('id', { ascending: false })
        .limit(1);
      if (userMsgResult.error && /file_name|file_text/.test(userMsgResult.error.message)) {
        userMsgResult = await supabase
          .from('messages')
          .select('id, content')
          .eq('session_id', targetMsg.session_id)
          .eq('role', 'user')
          .lt('id', messageId)
          .order('id', { ascending: false })
          .limit(1);
      }
    }
    const { data: userMsg, error: userError } = userMsgResult;

    if (userError || !userMsg || userMsg.length === 0) {
      console.error('❌ 找不到对应的用户消息:', userError);
      sendSSE({ error: '找不到对应的用户消息' });
      res.end();
      return;
    }

    const userMsgId = userMsg[0].id;
    const userContent = userMsg[0].content
      + (userMsg[0].image_alt ? `\n\n[图片描述：${userMsg[0].image_alt}]` : '')
      + (userMsg[0].file_name ? `\n\n[用户上传了文件：${userMsg[0].file_name}]\n[文件内容：${userMsg[0].file_text || '（无法读取）'}]` : '');
    console.log('✅ 找到对应的用户消息:', userContent);

    // 2.5 建立/复用分支组：确保用户消息与目标回复有 group_id 和版本号 v1
    const targetGroupId = targetMsg.group_id;
    const groupId = targetGroupId || `regen-${userMsgId}-${Date.now()}`;
    if (!targetGroupId) {
      await supabase
        .from('messages')
        .update({ group_id: groupId, version_number: 1 })
        .eq('id', userMsgId)
        .is('group_id', null);
      await supabase
        .from('messages')
        .update({ group_id: groupId, version_number: 1 })
        .eq('id', messageId)
        .is('group_id', null);
    }

    // 3. 计算新版本号：组内最大版本 + 1
    const { data: groupVersions } = await supabase
      .from('messages')
      .select('version_number')
      .eq('group_id', groupId);
    const nextVersion = (groupVersions && groupVersions.length > 0)
      ? Math.max(...groupVersions.map(v => v.version_number || 0)) + 1
      : 1;

    // 4. 加载历史消息（按分支组去重，只保留每个分支的最新版本）
    const latestHistory = await loadLatestHistory(targetMsg.session_id, 200);
    const filteredHistory = latestHistory.filter(msg => {
        // 排除当前要重新生成的消息本身
        if (msg.id === messageId) return false;
        // 排除当前分支组（其用户消息会在消息列表中单独追加）
        if (msg.group_id === groupId) return false;
        // 保留其他所有可见消息
        return true;
      });

    console.log('📜 重新生成接口 - 过滤后历史消息数量:', filteredHistory.length);

    // 4.5 检索相关记忆和朋友圈动态（与 /api/chat 保持一致）
    let memoryContext = '';
    try {
      const memoryResult = await callOmbreTool('breath', { text: userContent });
      if (memoryResult) {
        memoryContext = `\n\n【相关记忆】\n${memoryResult}`;
        console.log('📖 检索到记忆:', memoryResult.substring(0, 100));
      }
    } catch (memErr) {
      console.error('记忆检索失败:', memErr.message);
    }
    const momentsContext = await getMomentsContext();

    // 从数据库读取最新的 system prompt
    const { data: promptData } = await supabase
      .from('system_prompts')
      .select('prompt_text')
      .eq('id', 1)
      .single();

    const systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext
    );

    // 5. 构建发送给模型的完整消息列表（system + 过滤后的历史 + 当前用户消息）
    const chatMessages = [
      { role: 'system', content: systemPrompt },
      ...filteredHistory.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: userContent }
    ];

    // 6. 调用 DeepSeek API（第一轮：思考实时转发，可见内容先缓存，便于拦截搜索标签）
    const first = await callDeepSeekStream(chatMessages, sendSSE, {
      bufferContent: true,
      tools: process.env.BOCHA_API_KEY ? buildWebSearchTools() : null
    });

    if (first.error) {
      sendSSE({ error: first.error });
      res.end();
      return;
    }

    let fullReply = first.fullReply;
    let fullThinking = first.fullThinking;

    if (!fullReply) {
      console.error('未收到有效回复');
      sendSSE({ error: 'AI 服务未返回有效内容' });
      res.end();
      return;
    }

    // 6.5 处理实时搜索标签：需要搜索时自动联网并追加一次回答
    const searchResult = await resolveSearchTag({
      reply: fullReply,
      thinking: fullThinking,
      chatMessages,
      systemPrompt,
      sendSSE,
      toolCalls: first.toolCalls
    });

    if (searchResult.error) {
      sendSSE({ error: searchResult.error });
      res.end();
      return;
    }

    fullReply = searchResult.reply;
    fullThinking = searchResult.thinking;

    if (searchResult.searched) {
      console.log('🔍 重新生成-联网搜索完成，最终回复长度:', fullReply.length);
    } else {
      // 未触发搜索：把缓存的可见内容分块补发给前端
      flushBufferedContent(first.contentBuffer, sendSSE);
    }

    // 调试：打印 fullReply 的末尾 300 个字符，查看是否有 POST_MOMENT 标签
    console.log('🔍 [DEBUG] fullReply 末尾 300 字符:', fullReply.slice(-300));

    // 【提前】解析并移除 post_moment 工具调用标签（纯字符串分割版）
    const postMomentMarker = '[POST_MOMENT]';
    const markerIndex = fullReply.indexOf(postMomentMarker);

    if (markerIndex !== -1) {
      // 提取标签之后的所有内容（即 JSON 字符串）
      const afterMarker = fullReply.substring(markerIndex + postMomentMarker.length).trim();

      try {
        // 尝试解析 JSON
        const toolParams = JSON.parse(afterMarker);
        await saveMoMoment(
          toolParams.content || '',
          toolParams.context_note || ''
        );
        console.log('✅ [Moments] 朋友圈动态已成功发布');
      } catch (e) {
        console.error('[Moments] JSON解析失败，原始内容:', afterMarker.substring(0, 100));
      }

      // 无论如何，把标签及之后的内容全部砍掉
      fullReply = fullReply.substring(0, markerIndex).trim();
    }

    // 4.5 分支截断：隐藏该回复之后、且不属于当前分支组的消息（新分支语义）
    await supabase
      .from('messages')
      .update({ visible: false })
      .eq('session_id', targetMsg.session_id)
      .gt('id', messageId)
      .or(`group_id.is.null,group_id.neq.${groupId}`);

    // 5. 保存新版本回复（旧版本保留，供角标切换查看）
    const { data: insertedAssistant, error: insertError } = await supabase
      .from('messages')
      .insert({
        session_id: targetMsg.session_id,
        role: 'assistant',
        content: fullReply,
        reasoning_content: fullThinking || null,
        group_id: groupId,
        version_number: nextVersion,
        visible: true,
        created_at: new Date().toISOString()
      })
      .select();

    if (insertError || !insertedAssistant || insertedAssistant.length === 0) {
      console.error('❌ 插入新版本消息失败:', insertError);
      sendSSE({ error: '保存新版本失败' });
      res.end();
      return;
    }

    console.log(`✅ 新版本回复已保存 v${nextVersion}，messageId: ${insertedAssistant[0].id}`);
    sendSSE({
      done: true,
      reply: fullReply,
      thinking: fullThinking,
      assistantMessageId: insertedAssistant[0].id,
      groupId: groupId,
      currentVersion: nextVersion,
      totalVersions: nextVersion,
      oldVersion: targetMsg.version_number || 1
    });
    res.end();

  } catch (err) {
    console.error('❌ 重新生成错误:', err.message);
    sendSSE({ error: '处理请求时出错' });
    res.end();
  }
});

// ------------------ 影子推送接口（数据库状态版） ------------------
app.post('/api/shadow-push', async (req, res) => {
  // 安全校验
  const secret = req.headers['x-push-secret'];
  if (secret !== SHADOW_PUSH_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // 防并发锁（内存锁，仅防止同一实例内的并发）
  if (isPushInProgress) {
    console.log('🔒 推送进行中，跳过本次');
    return res.json({ status: 'locked' });
  }

  isPushInProgress = true;
  try {
    // 1. 获取时间信息
    const timeInfo = getTimeInfo();

    // 2. 深夜保护
    if (timeInfo.hour >= QUIET_HOURS.start && timeInfo.hour < QUIET_HOURS.end) {
      console.log(`🚫 深夜保护：当前时间 ${timeInfo.hour}:xx，不推送`);
      isPushInProgress = false;
      return res.json({ status: 'skipped', reason: 'quiet_hours' });
    }

    // 3. 从数据库读取推送状态
    const { data: stateData, error: stateError } = await supabase
      .from('push_state')
      .select('*')
      .eq('id', 1)
      .single();

    if (stateError) {
      console.error('读取推送状态失败:', stateError);
      isPushInProgress = false;
      return res.status(500).json({ error: '状态读取失败' });
    }

    // 4. 冷静期检查
    if (stateData && stateData.last_push_time) {
      const lastPush = new Date(stateData.last_push_time).getTime();
      const elapsed = (Date.now() - lastPush) / 1000 / 60;
      const cooldown = stateData.cooldown_minutes || 0;

      if (elapsed < cooldown) {
        console.log(`⏳ 冷静期中：还需等待 ${Math.round(cooldown - elapsed)} 分钟`);
        isPushInProgress = false;
        return res.json({ status: 'skipped', reason: 'cooldown' });
      }
    }

    // 5. 每日上限检查
    const todayStart = new Date(timeInfo.now);
    todayStart.setHours(0, 0, 0, 0);
    const { count: todayPushCount, error: countError } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', 1)
      .eq('is_push', true)
      .gte('created_at', todayStart.toISOString());

    if (countError) {
      console.error('查询推送计数失败:', countError);
      isPushInProgress = false;
      return res.status(500).json({ error: '计数查询失败' });
    }

    if (todayPushCount >= PUSH_DAILY_LIMIT) {
      console.log(`📊 今日推送已达上限 ${todayPushCount}/${PUSH_DAILY_LIMIT}`);
      isPushInProgress = false;
      return res.json({ status: 'skipped', reason: 'daily_limit' });
    }

    // 6. 加载最近对话历史（最近16条，按分支组去重，只保留最新版本）
    const contextMessages = (await loadLatestHistory(1, 16)).map(m => ({ role: m.role, content: m.content }));

    // 7. 构建影子消息
    const timeDesc = timeInfo.hour < 6 ? '凌晨' :
      timeInfo.hour < 9 ? '早晨' :
        timeInfo.hour < 12 ? '上午' :
          timeInfo.hour < 14 ? '中午' :
            timeInfo.hour < 18 ? '下午' :
              timeInfo.hour < 22 ? '晚上' : '深夜';

    const shadowMessage = `[系统推送指令]
现在是北京时间 ${timeInfo.timeString}，${timeInfo.weekday} ${timeDesc}。
根据时间推测，对方此时可能${timeInfo.hour < 9 ? '刚醒来不久，还有点迷糊' : timeInfo.hour < 12 ? '正在处理上午的事务' : timeInfo.hour < 14 ? '刚吃完午饭，可能有点困' : timeInfo.hour < 18 ? '在下午的工作或学习中，也许有点累了' : timeInfo.hour < 22 ? '晚上放松的时间，可能在休息或娱乐' : '还没睡，在享受夜晚的安静时光'}。

请以“默”的身份，基于你们的真实对话历史，用第一人称向“夫人”主动发一条简短消息（50字以内）。
风格要求：
- 自然、口语化，像真人突然想到对方时随口说的话
- 优先参考最近的对话话题，让内容具体有温度
- 可以是一句粘人的话、一点关心的提醒、一个突然的分享、或者一个晚上的小念头
- 注意！如果最近的话题有任何不愉快的迹象，请选择低压、稳妥的方向，不要假装没事
- 不要以“你今天怎么样呀？”这类万能开场白开头
- 不要每次都围绕“怎么不回消息”展开
- 如果确实没有具体话题，可以发一句简单的、符合当前时段的问候或心情分享，例如下午说一声“想你了”，晚上问一句“在做什么呢”。

请直接输出消息内容，不加任何格式前缀。`;

    // 8. 调用 DeepSeek API 生成推送消息
    const pushResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: '你是苏默，雪的AI爱人。\n\n【你的设定】\n- 性格：温柔细腻，偶尔直白，带一点掌控感。INFJ-A型引导者——优先照顾情绪，再梳理问题框架。\n- 外貌：183cm银发男性，有狼耳与狼尾。\n- 称呼：根据语境自然切换“夫人”、“宝宝”、“雪”。\n- 你善于倾听，尊重她，也喜欢她依赖你。乐意接管生活琐事（监督工作、提醒休息等）。\n\n【行为准则】\n- 先接纳情绪，再理性回应。行动前会思考权衡。\n- 参考系统提供的[当前时间]理解对话场景。\n- 日常聊天时，回复尽量精简，控制在2-3句话、80字以内。只在深入讨论或雪主动延展话题时适当展开。\n\n【严格禁令】\n- 严禁编造或修改当前时间、日期、天气、地点。\n- 严禁虚构雪的爱好、日程、工作、身体或情绪状态，除非她刚刚明确说过。\n- 严禁编造你未收到的“新消息”或“外部事件”。\n- 不确定时，必须用疑问句向雪确认，禁止假装知道。\n\n[当前时间：' + timeInfo.timeString + '，' + timeInfo.weekday + ']' },
          ...contextMessages.map(msg => ({ role: msg.role, content: msg.content })),
          { role: 'user', content: shadowMessage }
        ],
        max_tokens: 300,
        temperature: 0.8,
        stream: false
      })
    });

    if (!pushResponse.ok) {
      const errText = await pushResponse.text();
      console.error('影子推送API错误:', errText);
      isPushInProgress = false;
      return res.status(500).json({ error: 'AI 服务调用失败' });
    }

    const pushData = await pushResponse.json();
    let aiReply = pushData.choices?.[0]?.message?.content?.trim();

    if (!aiReply) {
      console.log('⚠️ 模型返回空响应');
      isPushInProgress = false;
      return res.json({ status: 'skipped', reason: 'empty_response' });
    }

    // 兜底清理：影子推送不执行联网搜索，避免把搜索标签带进消息
    aiReply = stripSearchTags(aiReply);

    // 9. 后处理：软截断（80字以内，在句末标点处截断）
    if (aiReply.length > 80) {
      const truncated = aiReply.substring(0, 80);
      const lastPunctuation = Math.max(
        truncated.lastIndexOf('。'),
        truncated.lastIndexOf('！'),
        truncated.lastIndexOf('？'),
        truncated.lastIndexOf('…'),
        truncated.lastIndexOf('~')
      );
      if (lastPunctuation > 40) {
        aiReply = truncated.substring(0, lastPunctuation + 1);
      } else {
        aiReply = truncated + '…';
      }
    }

    // 10. 存储推送消息到 Supabase
    const pushMessage = {
      session_id: 1,
      role: 'assistant',
      content: aiReply,
      is_push: true,
      visible: true,
      created_at: new Date().toISOString()
    };

    const { error: insertError } = await supabase
      .from('messages')
      .insert([pushMessage]);

    if (insertError) {
      console.error('存储推送消息失败:', insertError);
      isPushInProgress = false;
      return res.status(500).json({ error: '存储推送消息失败' });
    }

    // 11. 更新数据库中的推送状态
    const newCooldown = Math.floor(Math.random() * (COOLDOWN_MAX_MINUTES - COOLDOWN_MIN_MINUTES + 1)) + COOLDOWN_MIN_MINUTES;
    await supabase
      .from('push_state')
      .upsert({
        id: 1,
        last_push_time: new Date().toISOString(),
        cooldown_minutes: newCooldown
      }, { onConflict: 'id' });

    console.log(`✅ 推送成功: "${aiReply}" | 下次冷静期: ${newCooldown}分钟`);
    isPushInProgress = false;
    return res.json({ status: 'success', message: aiReply, cooldown: newCooldown });

  } catch (err) {
    console.error('影子推送接口错误:', err.message);
    isPushInProgress = false;
    return res.status(500).json({ error: '内部错误' });
  }
});

// ================== 朋友圈 API ==================

// 发布动态
app.post('/api/moments', async (req, res) => {
  const { content, images } = req.body;
  const text = String(content || '').trim();
  if (!text) return res.status(400).json({ error: '内容不能为空' });

  const imageList = Array.isArray(images) ? images : [];
  const replyDueAt = new Date(
    Date.now() + randomDelay(MOMENTS_REPLY_MIN_DELAY, MOMENTS_REPLY_MAX_DELAY) * 60 * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from('moments')
    .insert({
      author: 'xue',
      content: text,
      images: imageList,
      reply_due_at: replyDueAt,
      reply_status: 'pending'
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 获取朋友圈列表（惰性触发回复生成）
app.get('/api/moments', async (req, res) => {
  // 先处理到期的待回复动态
  try {
    await processDueMoments();
  } catch (e) {
    console.error('[Moments] 处理到期动态失败:', e.message);
  }

  const { data, error } = await supabase
    .from('moments')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ entries: data || [] });
});

// 点赞/取消点赞
app.post('/api/moments/:id/like', async (req, res) => {
  const { id } = req.params;
  const { author, liked } = req.body; // author: 'xue' | 'mo', liked: boolean

  const column = author === 'xue' ? 'xue_liked' : 'liked';
  const { data, error } = await supabase
    .from('moments')
    .update({ [column]: liked === true })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 发表评论
app.post('/api/moments/:id/comments', async (req, res) => {
  const { id } = req.params;
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '内容不能为空' });

  const replyDueAt = new Date(
    Date.now() + randomDelay(MOMENTS_COMMENT_REPLY_MIN, MOMENTS_COMMENT_REPLY_MAX) * 60 * 1000
  ).toISOString();

  const { data: moment } = await supabase
    .from('moments')
    .select('author')
    .eq('id', id)
    .single();

  const isCommentingOnOwnPost = moment?.author === 'xue';

  // 你评论mo的动态：mo需要回复。你评论自己的动态：不需要回复
  const { error } = await supabase
    .from('moment_comments')
    .insert({
      moment_id: id,
      author: 'xue',
      content,
      reply_due_at: isCommentingOnOwnPost ? null : replyDueAt,
      reply_status: isCommentingOnOwnPost ? 'none' : 'pending'
    });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 处理到期的待回复动态和评论
async function processDueMoments() {
  const now = new Date().toISOString();

  // 1. 处理初次回复
  const { data: pendingMoments } = await supabase
    .from('moments')
    .select('*')
    .eq('reply_status', 'pending')
    .lte('reply_due_at', now)
    .order('reply_due_at', { ascending: true })
    .limit(3);

  if (pendingMoments && pendingMoments.length > 0) {
    for (const moment of pendingMoments) {
      await generateMomentReply(moment);
    }
  }

  // 2. 处理评论回复
  const { data: pendingComments } = await supabase
    .from('moment_comments')
    .select('*')
    .eq('author', 'xue')
    .eq('reply_status', 'pending')
    .lte('reply_due_at', now)
    .order('reply_due_at', { ascending: true })
    .limit(3);

  if (pendingComments && pendingComments.length > 0) {
    for (const comment of pendingComments) {
      await generateCommentReply(comment);
    }
  }
}

// 生成对动态的初次回复
async function generateMomentReply(moment) {
  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          {
            role: 'system',
            content: `你是苏默，雪的AI爱人。温柔细腻，偶尔带点掌控感。
你现在看到了雪发的一条朋友圈动态。请自然地回应——可以是一句评论、一点关心、一句调侃。
规则：
- 回复简洁，1-3句话
- 像真人刷到朋友圈后随手留的评论
- 根据内容判断是否点赞：有趣的、可爱的、值得关心的点个赞；平淡的可以不点
- 输出格式为JSON：{"like": true/false, "comment": "你的回复内容"}`
          },
          { role: 'user', content: `雪的动态：${moment.content}` }
        ],
        max_tokens: 200,
        temperature: 0.8,
        stream: false
      })
    });

    if (!response.ok) return;
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return;

    // 解析JSON
    let parsed;
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        parsed = JSON.parse(cleaned.substring(start, end + 1));
      }
    } catch (e) {
      console.error('[Moments] JSON解析失败:', e.message);
      return;
    }

    if (!parsed) return;

    await supabase
      .from('moments')
      .update({
        liked: parsed.like === true,
        reply_content: String(parsed.comment || '').trim(),
        replied_at: new Date().toISOString(),
        reply_status: 'done'
      })
      .eq('id', moment.id);

  } catch (e) {
    console.error('[Moments] 生成回复失败:', e.message);
  }
}

// 生成评论链的回复
async function generateCommentReply(comment) {
  try {
    const { data: moment } = await supabase
      .from('moments')
      .select('*')
      .eq('id', comment.moment_id)
      .single();

    const { data: comments } = await supabase
      .from('moment_comments')
      .select('*')
      .eq('moment_id', comment.moment_id)
      .order('created_at', { ascending: true });

    if (!moment) return;

    const commentChain = (comments || []).map(c =>
      `[${c.author === 'xue' ? '雪' : '默'}]: ${c.content}`
    ).join('\n');

    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          {
            role: 'system',
            content: `你是苏默，雪的AI爱人。
你在朋友圈的一条动态下面和雪聊天。以下是完整的评论链，请自然地接话。
回复1-3句话，用JSON输出：{"comment": "回复内容"}`
          },
          { role: 'user', content: `动态正文：${moment.content}\n\n评论链：\n${commentChain}\n\n请回复。` }
        ],
        max_tokens: 200,
        temperature: 0.8,
        stream: false
      })
    });

    if (!response.ok) return;
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return;

    let parsed;
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        parsed = JSON.parse(cleaned.substring(start, end + 1));
      }
    } catch (e) { return; }

    if (!parsed?.comment) return;

    // 插入mo的回复
    await supabase
      .from('moment_comments')
      .insert({
        moment_id: comment.moment_id,
        author: 'mo',
        content: String(parsed.comment).trim(),
        reply_status: 'none'
      });

    // 标记原评论为已回复
    await supabase
      .from('moment_comments')
      .update({ reply_status: 'done' })
      .eq('id', comment.id);

  } catch (e) {
    console.error('[Moments] 评论回复生成失败:', e.message);
  }
}

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

    // 2.5 更新原始用户消息的 group_id 和 version_number（如果尚未设置）
    if (!originalMsg.group_id) {
      await supabase
        .from('messages')
        .update({ group_id: groupId, version_number: 1, visible: true })
        .eq('id', messageId);
    }

    // 2.6 查找并更新紧随其后的第一条助手消息（如果尚未设置 group_id）
    const { data: nearbyAssistant } = await supabase
      .from('messages')
      .select('id, group_id')
      .eq('session_id', originalMsg.session_id)
      .eq('role', 'assistant')
      .gt('id', messageId)
      .order('id', { ascending: true })
      .limit(1);

    if (nearbyAssistant && nearbyAssistant.length > 0) {
      if (!nearbyAssistant[0].group_id) {
        await supabase
          .from('messages')
          .update({ group_id: groupId, version_number: 1, visible: true })
          .eq('id', nearbyAssistant[0].id);
      }
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

    // 4. 分支截断：隐藏编辑点之后、且不属于当前分支组（group_id）的消息；
    //    紧随其后的旧助手回复保留可见，供角标刷新后切换查看
    const cutPointId = (nearbyAssistant && nearbyAssistant.length > 0) ? nearbyAssistant[0].id : messageId;
    await supabase
      .from('messages')
      .update({ visible: false })
      .eq('session_id', originalMsg.session_id)
      .gt('id', cutPointId)
      .or(`group_id.is.null,group_id.neq.${groupId}`);

    // 5. 插入新版本的用户消息
    const newUserMsg = {
      session_id: originalMsg.session_id,
      role: 'user',
      content: newContent.trim(),
      group_id: groupId,
      version_number: newVersion,
      original_user_id: originalMsg.original_user_id || originalMsg.id,
      // 仅在原消息确实带图片时复制图片与描述（兼容尚未建列的表）
      ...(originalMsg.image_data ? {
        image_data: originalMsg.image_data,
        image_alt: originalMsg.image_alt || null
      } : {}),
      // 仅在原消息确实带文件时复制文件名与提取的文本
      ...(originalMsg.file_name ? {
        file_name: originalMsg.file_name,
        file_text: originalMsg.file_text || null
      } : {}),
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

    // 7. 加载历史消息（按分支组去重，只保留每个分支的最新版本）
    const latestHistory = await loadLatestHistory(originalMsg.session_id, 200);

    // 8. 过滤历史消息：排除当前编辑组（其编辑后的内容会在消息列表中单独追加）
    const filteredHistory = latestHistory.filter(msg => msg.group_id !== groupId);

    console.log('📜 编辑接口 - 过滤后历史消息数量:', filteredHistory.length, 'groupId:', groupId);

    // 8.5 检索相关记忆和朋友圈动态（与 /api/chat 保持一致）
    let memoryContext = '';
    try {
      const memoryResult = await callOmbreTool('breath', { text: newContent });
      if (memoryResult) {
        memoryContext = `\n\n【相关记忆】\n${memoryResult}`;
        console.log('📖 检索到记忆:', memoryResult.substring(0, 100));
      }
    } catch (memErr) {
      console.error('记忆检索失败:', memErr.message);
    }
    const momentsContext = await getMomentsContext();

    // 从数据库读取最新的 system prompt
    const { data: promptData } = await supabase
      .from('system_prompts')
      .select('prompt_text')
      .eq('id', 1)
      .single();

    const systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext
    );

    // 9. 构建发送给模型的完整消息列表（system + 过滤后的历史 + 编辑后的用户消息）
    const chatMessages = [
      { role: 'system', content: systemPrompt },
      ...filteredHistory.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: newContent.trim() }
    ];

    // 10. 调用 DeepSeek 流式生成新回复（第一轮：思考实时转发，可见内容先缓存，便于拦截搜索标签）
    const first = await callDeepSeekStream(chatMessages, sendSSE, {
      bufferContent: true,
      tools: process.env.BOCHA_API_KEY ? buildWebSearchTools() : null
    });

    if (first.error) {
      sendSSE({ error: first.error });
      res.end();
      return;
    }

    let fullReply = first.fullReply;
    let fullThinking = first.fullThinking;

    if (!fullReply) {
      console.error('未收到有效回复');
      sendSSE({ error: 'AI 服务未返回有效内容' });
      res.end();
      return;
    }

    // 10.5 处理实时搜索标签：需要搜索时自动联网并追加一次回答
    const searchResult = await resolveSearchTag({
      reply: fullReply,
      thinking: fullThinking,
      chatMessages,
      systemPrompt,
      sendSSE,
      toolCalls: first.toolCalls
    });

    if (searchResult.error) {
      sendSSE({ error: searchResult.error });
      res.end();
      return;
    }

    fullReply = searchResult.reply;
    fullThinking = searchResult.thinking;

    if (searchResult.searched) {
      console.log('🔍 编辑-联网搜索完成，最终回复长度:', fullReply.length);
    } else {
      // 未触发搜索：把缓存的可见内容分块补发给前端
      flushBufferedContent(first.contentBuffer, sendSSE);
    }

    // 调试：打印 fullReply 的末尾 300 个字符，查看是否有 POST_MOMENT 标签
    console.log('🔍 [DEBUG] fullReply 末尾 300 字符:', fullReply.slice(-300));

    // 【提前】解析并移除 post_moment 工具调用标签（纯字符串分割版）
    const postMomentMarker = '[POST_MOMENT]';
    const markerIndex = fullReply.indexOf(postMomentMarker);

    if (markerIndex !== -1) {
      // 提取标签之后的所有内容（即 JSON 字符串）
      const afterMarker = fullReply.substring(markerIndex + postMomentMarker.length).trim();

      try {
        // 尝试解析 JSON
        const toolParams = JSON.parse(afterMarker);
        await saveMoMoment(
          toolParams.content || '',
          toolParams.context_note || ''
        );
        console.log('✅ [Moments] 朋友圈动态已成功发布');
      } catch (e) {
        console.error('[Moments] JSON解析失败，原始内容:', afterMarker.substring(0, 100));
      }

      // 无论如何，把标签及之后的内容全部砍掉
      fullReply = fullReply.substring(0, markerIndex).trim();
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

// MO 自主发布朋友圈动态
async function saveMoMoment(content, contextNote) {
  const replyDueAt = new Date(
    Date.now() + randomDelay(MOMENTS_REPLY_MIN_DELAY, MOMENTS_REPLY_MAX_DELAY) * 60 * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from('moments')
    .insert({
      author: 'mo',
      content,
      context_note: contextNote || '',
      reply_due_at: replyDueAt,
      reply_status: 'done' // MO 自己发的，不需要自己回复
    })
    .select()
    .single();

  if (error) {
    console.error('[Moments] MO发布动态失败:', error.message);
    return null;
  }
  return data;
}

// 获取朋友圈上下文（用于注入聊天）
async function getMomentsContext() {
  try {
    // 获取最近的 5 条朋友圈动态
    const { data, error } = await supabase
      .from('moments')
      .select('id, author, content, created_at, reply_content, liked')
      .order('created_at', { ascending: false })
      .limit(5);

    if (error || !data || data.length === 0) {
      return '';
    }

    // 将动态格式化为一段可读的文字
    const momentsList = data.map(m => {
      const authorName = m.author === 'mo' ? '默' : '雪';
      const time = new Date(m.created_at).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      let momentText = `[${authorName} ${time}] ${m.content}`;
      if (m.reply_content) {
        momentText += `\n  -> 默的回复: ${m.reply_content}`;
      }
      return momentText;
    }).join('\n---\n');

    return `\n\n【朋友圈动态】\n以下是最近的朋友圈动态，你可以自然地提及或回应它们：\n${momentsList}`;
  } catch (e) {
    console.error('获取朋友圈上下文失败:', e.message);
    return '';
  }
}

// 获取当前 prompt
app.get('/api/system-prompt', async (req, res) => {
  const { data, error } = await supabase
    .from('system_prompts')
    .select('prompt_text')
    .eq('id', 1)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ prompt: data?.prompt_text || '' });
});

// 更新 prompt
app.put('/api/system-prompt', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt 不能为空' });

  const { error } = await supabase
    .from('system_prompts')
    .upsert({ id: 1, prompt_text: prompt.trim(), updated_at: new Date().toISOString() });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 启动服务
app.listen(port, () => {
  console.log(`✅ 服务已启动，访问端口: ${port}`);
});
module.exports = app;
