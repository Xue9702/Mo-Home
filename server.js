const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // 部分主机 IPv6 解析异常导致外部 API 请求失败，强制优先 IPv4
// ================== 影子推送配置 ==================
const SHADOW_PUSH_SECRET = process.env.SHADOW_PUSH_SECRET || 'your-secret-key-change-me';
const USER_TIMEZONE = 'Asia/Shanghai'; // 目标时区：东八区
const PUSH_DAILY_LIMIT = 4; // 每日唤醒上限（原 6 改为 4）
const COOLDOWN_MIN_MINUTES = 120; // 最小冷静期（分钟）
const COOLDOWN_MAX_MINUTES = 210; // 最大冷静期（分钟）
const AWAKEN_SILENCE_MINUTES = 30; // 结束聊天 N 分钟后才允许唤醒
const WAKE_ENERGY_POINTS = 2;      // 每次唤醒的体力
const WAKE_MAX_ACTIONS = 2;        // 体力限制下的最大动作数
const MOOD_MIN = 0;                // 心情下限
const MOOD_MAX = 100;              // 心情上限

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
function buildSystemPrompt(basePrompt, memoryContext = '', momentsContext = '', weatherContext = '') {
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
    + (weatherContext ? `\n\n${weatherContext}` : '')
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

// 调用博查 Web Search API，返回 { text, count }；失败或未配置返回 { text: null, count: 0 }
async function performWebSearch(query) {
  if (!process.env.BOCHA_API_KEY) {
    console.warn('⚠️ 未配置 BOCHA_API_KEY，跳过实时搜索');
    return { text: null, count: 0 };
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
      return { text: null, count: 0 };
    }
    const data = await response.json();
    const pages = data?.data?.webPages?.value || [];
    if (!pages.length) {
      console.warn('⚠️ 博查搜索无结果:', query);
      return { text: null, count: 0 };
    }
    const top = pages.slice(0, 5);
    return {
      count: top.length,
      text: top.map((item, i) => {
      const title = item.name || item.title || '无标题';
      const url = item.url || '';
      const snippet = item.summary || item.snippet || item.description || '';
      const date = item.datePublished ? `（${item.datePublished}）` : '';
      return `${i + 1}. ${title}${date}\n${url}\n${snippet}`;
      }).join('\n\n')
    };
  } catch (err) {
    console.error('❌ 博查搜索异常:', err.message);
    return { text: null, count: 0 };
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

// 提取回复中的搜索意图：优先看模型是否发起了 web_search 工具调用，
// 其次看是否输出了 [SEARCH_QUERY] 标签；返回 { query, leadText } 或 null
function extractSearchRequest(reply, toolCalls) {
  if (toolCalls && toolCalls.length > 0) {
    const call = toolCalls[0];
    let query = '';
    try {
      query = (JSON.parse(call.function.arguments || '{}').query || '').trim();
    } catch (e) {
      query = '';
    }
    if (query) return { query, leadText: String(reply || '').trim() };
  }

  const tag = extractSearchTag(reply);
  if (tag && tag.query) return { query: tag.query, leadText: tag.leadText };
  return null;
}

// 执行搜索阶段：调用博查，通知前端搜索结果数量，然后用搜索结果追加一次 DeepSeek 调用。
// 返回 { reply, thinking }（第二轮正式回答）或 { error }。
async function runSearchPhase({ query, chatMessages, systemPrompt, sendSSE }) {
  const search = await performWebSearch(query);
  const searchText = search.text || null;
  const pageCount = search.count || 0;
  sendSSE({ searchResult: true, count: pageCount });

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

  if (second.error) return { error: second.error };
  return { reply: stripSearchTags(second.fullReply), thinking: second.fullThinking };
}

// ================== 天气感知（Open-Meteo，免注册） ==================
const WEATHER_DEFAULT_CITY = '晋江';
const WEATHER_CACHE_TTL = 30 * 60 * 1000; // 天气缓存 30 分钟
let weatherCache = null; // { city, data, fetchedAt }

// 常用城市坐标表（Open-Meteo 地理编码对中文支持差，内置常见城市避免搜索失败）
const WEATHER_CITY_PRESETS = {
  '晋江': { lat: 24.81978, lon: 118.57415, name: '晋江' },
  '泉州': { lat: 24.87, lon: 118.68, name: '泉州' },
  '厦门': { lat: 24.48, lon: 118.09, name: '厦门' },
  '福州': { lat: 26.07, lon: 119.30, name: '福州' },
  '北京': { lat: 39.90, lon: 116.40, name: '北京' },
  '上海': { lat: 31.23, lon: 121.47, name: '上海' },
  '广州': { lat: 23.13, lon: 113.26, name: '广州' },
  '深圳': { lat: 22.55, lon: 114.06, name: '深圳' },
  '杭州': { lat: 30.27, lon: 120.16, name: '杭州' },
  '成都': { lat: 30.57, lon: 104.07, name: '成都' },
  '重庆': { lat: 29.56, lon: 106.55, name: '重庆' },
  '武汉': { lat: 30.59, lon: 114.31, name: '武汉' },
  '南京': { lat: 32.06, lon: 118.80, name: '南京' },
  '苏州': { lat: 31.30, lon: 120.58, name: '苏州' },
  '天津': { lat: 39.08, lon: 117.20, name: '天津' },
  '西安': { lat: 34.34, lon: 108.94, name: '西安' },
  '长沙': { lat: 28.23, lon: 112.94, name: '长沙' },
  '青岛': { lat: 36.07, lon: 120.38, name: '青岛' },
  '大连': { lat: 38.91, lon: 121.61, name: '大连' },
  '昆明': { lat: 25.04, lon: 102.71, name: '昆明' },
  '郑州': { lat: 34.75, lon: 113.63, name: '郑州' },
  '合肥': { lat: 31.82, lon: 117.23, name: '合肥' },
  '南昌': { lat: 28.68, lon: 115.86, name: '南昌' },
  '南宁': { lat: 22.82, lon: 108.32, name: '南宁' },
  '贵阳': { lat: 26.65, lon: 106.63, name: '贵阳' },
  '海口': { lat: 20.04, lon: 110.34, name: '海口' },
  '三亚': { lat: 18.25, lon: 109.51, name: '三亚' },
  '兰州': { lat: 36.06, lon: 103.83, name: '兰州' },
  '太原': { lat: 37.87, lon: 112.55, name: '太原' },
  '沈阳': { lat: 41.80, lon: 123.43, name: '沈阳' },
  '哈尔滨': { lat: 45.80, lon: 126.53, name: '哈尔滨' },
  '长春': { lat: 43.82, lon: 125.32, name: '长春' },
  '石家庄': { lat: 38.04, lon: 114.51, name: '石家庄' },
  '济南': { lat: 36.65, lon: 117.12, name: '济南' },
  '香港': { lat: 22.32, lon: 114.17, name: '香港' },
  '澳门': { lat: 22.20, lon: 113.55, name: '澳门' },
  '台北': { lat: 25.03, lon: 121.57, name: '台北' }
};

// WMO 天气代码 -> [中文描述, 图标]
const WMO_INFO = {
  0: ['晴', '☀️'], 1: ['大致晴朗', '🌤️'], 2: ['多云', '⛅'], 3: ['阴', '☁️'],
  45: ['雾', '🌫️'], 48: ['雾凇', '🌫️'],
  51: ['小毛毛雨', '🌦️'], 53: ['毛毛雨', '🌦️'], 55: ['浓毛毛雨', '🌧️'],
  61: ['小雨', '🌧️'], 63: ['中雨', '🌧️'], 65: ['大雨', '🌧️'],
  71: ['小雪', '🌨️'], 73: ['中雪', '🌨️'], 75: ['大雪', '❄️'], 77: ['雪粒', '🌨️'],
  80: ['小阵雨', '🌦️'], 81: ['阵雨', '🌧️'], 82: ['强阵雨', '⛈️'],
  85: ['小阵雪', '🌨️'], 86: ['阵雪', '❄️'],
  95: ['雷暴', '⛈️'], 96: ['雷暴伴小冰雹', '⛈️'], 99: ['雷暴伴冰雹', '⛈️']
};

function getWmoInfo(code) {
  const [desc, icon] = WMO_INFO[code] || ['未知', '🌡️'];
  return { desc, icon };
}

// 解析城市坐标：先查内置表，再尝试 Open-Meteo 地理编码（支持拼音/英文名）
async function resolveCityGeo(city) {
  const preset = WEATHER_CITY_PRESETS[city];
  if (preset) return preset;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('城市解析失败');
  const data = await res.json();
  const hit = data.results && data.results[0];
  if (!hit) throw new Error('未找到城市');
  return { lat: hit.latitude, lon: hit.longitude, name: hit.name || city };
}

// 主源：Open-Meteo（失败会抛出，由 getWeatherData 切换备用源）
async function fetchWeatherOpenMeteo(cityName) {
  const geo = await resolveCityGeo(cityName);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=Asia%2FShanghai&forecast_days=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`天气接口失败: HTTP ${res.status} ${String(errText).substring(0, 120)}`);
  }
  const data = await res.json();
  const cur = data.current || {};
  const daily = data.daily || {};
  const curInfo = getWmoInfo(cur.weather_code);
  const todayInfo = getWmoInfo(daily.weather_code && daily.weather_code[0]);
  return {
    city: cityName,
    cityDisplay: geo.name || cityName,
    updatedAt: new Date().toISOString(),
    current: {
      temp: Math.round(cur.temperature_2m ?? 0),
      feelsLike: Math.round(cur.apparent_temperature ?? 0),
      humidity: Math.round(cur.relative_humidity_2m ?? 0),
      precipitation: cur.precipitation ?? 0,
      windSpeed: Math.round(cur.wind_speed_10m ?? 0),
      isDay: !!cur.is_day,
      desc: curInfo.desc,
      icon: curInfo.icon
    },
    daily: {
      desc: todayInfo.desc,
      icon: todayInfo.icon,
      max: Math.round(daily.temperature_2m_max?.[0] ?? 0),
      min: Math.round(daily.temperature_2m_min?.[0] ?? 0),
      sunrise: (daily.sunrise && daily.sunrise[0]) || null,
      sunset: (daily.sunset && daily.sunset[0]) || null
    }
  };
}

// wttr.in 天气代码 -> [中文描述, 图标]
const WTTR_INFO = {
  113: ['晴', '☀️'], 116: ['大致晴朗', '🌤️'], 119: ['多云', '⛅'], 122: ['阴', '☁️'],
  143: ['雾', '🌫️'], 248: ['雾', '🌫️'],
  176: ['小雨', '🌧️'], 263: ['小毛毛雨', '🌦️'], 266: ['毛毛雨', '🌧️'], 293: ['小阵雨', '🌦️'],
  296: ['阵雨', '🌧️'], 299: ['中雨', '🌧️'], 302: ['大雨', '🌧️'], 305: ['大雨', '🌧️'],
  308: ['大雨', '🌧️'], 311: ['冻雨', '🌧️'], 314: ['冻雨', '🌧️'], 321: ['毛毛雨', '🌧️'],
  353: ['小阵雨', '🌦️'], 356: ['阵雨', '🌧️'], 359: ['强阵雨', '⛈️'],
  362: ['小阵雪', '🌨️'], 365: ['阵雪', '❄️'], 368: ['小雪', '🌨️'], 371: ['中雪', '🌨️'],
  374: ['冰粒', '🌨️'], 377: ['雪粒', '🌨️'],
  200: ['雷暴', '⛈️'], 386: ['雷阵雨', '⛈️'], 389: ['雷阵雨', '⛈️'],
  392: ['雷阵雪', '⛈️'], 395: ['雷阵雪', '⛈️'], 227: ['小雪', '🌨️'], 230: ['中雪', '🌨️']
};

function getWttrInfo(code) {
  const [desc, icon] = WTTR_INFO[code] || ['未知', '🌡️'];
  return { desc, icon };
}

// 备用源：wttr.in（免注册，支持中文城市名）
async function fetchWeatherWttr(cityName) {
  const url = `https://wttr.in/${encodeURIComponent(cityName)}?format=j1&lang=zh`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`wttr.in HTTP ${res.status}`);
  const data = await res.json();
  const cur = data.current_condition && data.current_condition[0];
  const today = data.weather && data.weather[0];
  if (!cur) throw new Error('wttr.in 无当前数据');
  const curInfo = getWttrInfo(Number(cur.weatherCode));
  const todayInfo = getWttrInfo(Number(today && today.weatherCode));
  return {
    city: cityName,
    cityDisplay: cityName,
    updatedAt: new Date().toISOString(),
    current: {
      temp: Math.round(Number(cur.temp_C || 0)),
      feelsLike: Math.round(Number(cur.FeelsLikeC || 0)),
      humidity: Math.round(Number(cur.humidity || 0)),
      precipitation: Number(cur.precipMM || 0),
      windSpeed: Math.round(Number(cur.windspeedKmph || 0)),
      isDay: true,
      desc: curInfo.desc,
      icon: curInfo.icon
    },
    daily: {
      desc: todayInfo.desc,
      icon: todayInfo.icon,
      max: Math.round(Number(today && today.maxtempC || 0)),
      min: Math.round(Number(today && today.mintempC || 0)),
      sunrise: (today && today.astronomy && today.astronomy[0] && today.astronomy[0].sunrise) || null,
      sunset: (today && today.astronomy && today.astronomy[0] && today.astronomy[0].sunset) || null
    }
  };
}

// 获取指定城市的实况天气（带 30 分钟缓存；主源 Open-Meteo，失败自动切 wttr.in）
async function getWeatherData(city, force = false) {
  const cityName = (city || WEATHER_DEFAULT_CITY).trim() || WEATHER_DEFAULT_CITY;
  if (!force && weatherCache && weatherCache.city === cityName && Date.now() - weatherCache.fetchedAt < WEATHER_CACHE_TTL) {
    return weatherCache.data;
  }

  try {
    const result = await fetchWeatherOpenMeteo(cityName);
    weatherCache = { city: cityName, data: result, fetchedAt: Date.now() };
    return result;
  } catch (err) {
    console.warn('⚠️ Open-Meteo 获取失败，尝试备用源 wttr.in:', err.message);
  }

  try {
    const result = await fetchWeatherWttr(cityName);
    weatherCache = { city: cityName, data: result, fetchedAt: Date.now() };
    return result;
  } catch (err2) {
    console.error('❌ 获取天气失败（两个源都不可用）:', err2.message);
    if (weatherCache && weatherCache.city === cityName) return weatherCache.data;
    return null;
  }
}

// 生成注入默提示词的天气段落（带时段引导，让默在早晚安时主动聊天气）
async function getWeatherContext(city) {
  const w = await getWeatherData(city);
  if (!w) return '';
  const hour = getTimeInfo().hour;
  const dayPhase = hour < 6 ? '凌晨' : hour < 9 ? '早晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';
  return `【当前天气】${w.cityDisplay}：${w.current.desc} ${w.current.icon}，气温${w.current.temp}°C（体感${w.current.feelsLike}°C），最高${w.daily.max}°C / 最低${w.daily.min}°C，湿度${w.current.humidity}%，风速${w.current.windSpeed}km/h。现在是${dayPhase}；当雪醒来、或与你问候早晚安、或问起天气时，请自然地告诉她今天的天气，并给出贴心的穿衣/出行建议。`;
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
    // 默读过的雪日记稳定注入，保证聊天窗口的他记得
    const readDiaryContext = await getReadDiaryContext();
    if (readDiaryContext) memoryContext += readDiaryContext;
    // 默最近几次唤醒的活动记录，保持唤醒与聊天连贯
    const recentActionContext = await getRecentActionContext();
    if (recentActionContext) memoryContext += recentActionContext;

    // 构建动态的 System Prompt
    const momentsContext = await getMomentsContext();
    // 从数据库读取最新的 system prompt
    const { data: promptData } = await supabase
      .from('system_prompts')
      .select('prompt_text')
      .eq('id', 1)
      .single();

    const weatherContext = await getWeatherContext(req.body.city || '');
    const systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext
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

    // 检查第一轮回复是否包含搜索意图（工具调用或标签）
    const searchReq = extractSearchRequest(fullReply, first.toolCalls);

    if (searchReq) {
      // ---- 第一轮：过渡语气泡收尾（作为独立消息入库） ----
      const preludeText = searchReq.leadText;
      if (preludeText) {
        await supabase
          .from('messages')
          .insert({
            session_id: 1,
            role: 'assistant',
            content: preludeText,
            reasoning_content: fullThinking || null,
            visible: true,
            created_at: new Date().toISOString()
          });
      }

      // 把第一轮的可见内容补发给前端，并宣告第一轮消息完成（不挂刷新按钮）
      flushBufferedContent(preludeText, sendSSE);
      sendSSE({ done: true });

      console.log('🔍 默请求联网搜索:', searchReq.query);

      // ---- 第二轮：搜索 + 正式回答（前端会新建一个气泡） ----
      sendSSE({ searchStart: true, query: searchReq.query });
      const phase = await runSearchPhase({
        query: searchReq.query,
        chatMessages,
        systemPrompt,
        sendSSE
      });

      if (phase.error) {
        sendSSE({ error: phase.error });
        res.end();
        return;
      }

      fullReply = phase.reply;
      fullThinking = phase.thinking;
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
      let memoryResult = await callOmbreTool('breath', { text: userContent });
      // 记忆库里可能存有旧版回复，重新生成时不能让默读到刷新前的自己
      if (memoryResult && targetMsg.content) {
        const oldClean = stripSearchTags(String(targetMsg.content)).replace(/\[POST_MOMENT\][\s\S]*$/, '').trim();
        if (oldClean && memoryResult.includes(oldClean)) {
          memoryResult = memoryResult.split(oldClean).join('').trim();
        }
      }
      if (memoryResult) {
        memoryContext = `\n\n【相关记忆】\n${memoryResult}`;
        console.log('📖 检索到记忆:', memoryResult.substring(0, 100));
      }
    } catch (memErr) {
      console.error('记忆检索失败:', memErr.message);
    }
    const readDiaryContext = await getReadDiaryContext();
    if (readDiaryContext) memoryContext += readDiaryContext;
    const recentActionContext = await getRecentActionContext();
    if (recentActionContext) memoryContext += recentActionContext;
    const momentsContext = await getMomentsContext();

    // 从数据库读取最新的 system prompt
    const { data: promptData } = await supabase
      .from('system_prompts')
      .select('prompt_text')
      .eq('id', 1)
      .single();

    const weatherContext = await getWeatherContext(req.body.city || '');
    const systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext
    );

    // 5. 构建发送给模型的完整消息列表（system + 过滤后的历史 + 当前用户消息）
    // 重新生成时不要喂旧版回复给默，也不要让他察觉这是"重新生成"，
    // 只用一句自然的提示引导换一种说法
    const regenUserContent = `${userContent}\n\n（再回答一次：换个角度、换个说法，让内容与之前不太一样～）`;
    const chatMessages = [
      { role: 'system', content: systemPrompt },
      ...filteredHistory.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: regenUserContent }
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

    // 6.5 检查第一轮回复是否包含搜索意图（工具调用或标签）
    const searchReq = extractSearchRequest(fullReply, first.toolCalls);

    if (searchReq) {
      // ---- 第一轮：过渡语气泡收尾（作为普通消息入库，不参与分支版本） ----
      const preludeText = searchReq.leadText;
      if (preludeText) {
        await supabase
          .from('messages')
          .insert({
            session_id: targetMsg.session_id,
            role: 'assistant',
            content: preludeText,
            reasoning_content: fullThinking || null,
            visible: true,
            created_at: new Date().toISOString()
          });
      }

      // 把第一轮的可见内容补发给前端，并宣告第一轮消息完成
      flushBufferedContent(preludeText, sendSSE);
      sendSSE({ done: true });

      console.log('🔍 重新生成-默请求联网搜索:', searchReq.query);

      // ---- 第二轮：搜索 + 正式回答（前端会新建一个气泡） ----
      sendSSE({ searchStart: true, query: searchReq.query });
      const phase = await runSearchPhase({
        query: searchReq.query,
        chatMessages,
        systemPrompt,
        sendSSE
      });

      if (phase.error) {
        sendSSE({ error: phase.error });
        res.end();
        return;
      }

      fullReply = phase.reply;
      fullThinking = phase.thinking;
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

// ================== 默的自主唤醒（辅助函数） ==================

function clampMood(v) {
  return Math.max(MOOD_MIN, Math.min(MOOD_MAX, Math.round(Number(v) || 0)));
}

function getDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 读取/初始化 home_state（心情等；表未建时返回默认值，不抛错）
async function getHomeStateSafe() {
  try {
    const { data, error } = await supabase
      .from('home_state')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (!error && data) return data;
    const { data: created } = await supabase
      .from('home_state')
      .upsert({ id: 1, mo_mood: 60, xue_mood: 60 }, { onConflict: 'id' })
      .select()
      .single();
    return created || { id: 1, mo_mood: 60, xue_mood: 60, last_active_at: null };
  } catch (e) {
    return { id: 1, mo_mood: 60, xue_mood: 60, last_active_at: null };
  }
}

// 最近一条用户消息的时间（判定“结束聊天”）
async function getLastUserActivity() {
  try {
    const { data } = await supabase
      .from('messages')
      .select('created_at')
      .eq('session_id', 1)
      .eq('role', 'user')
      .eq('visible', true)
      .order('created_at', { ascending: false })
      .limit(1);
    return data?.[0]?.created_at || null;
  } catch (e) {
    return null;
  }
}

// 某天的行动日志（表未建时返回空数组）
async function getTodayActionLog(dateStr) {
  try {
    const { data, error } = await supabase
      .from('mo_actions')
      .select('*')
      .eq('action_date', dateStr)
      .order('created_at', { ascending: true });
    if (error) return [];
    return data || [];
  } catch (e) {
    return [];
  }
}

async function logWakeAction(entry) {
  try {
    const { data } = await supabase.from('mo_actions').insert(entry).select();
    return data?.[0] || null;
  } catch (e) {
    console.error('行动日志写入失败:', e.message);
    return null;
  }
}

async function addNotification(title, body, source) {
  try {
    await supabase.from('notifications').insert({ title, body, source, read: false });
  } catch (e) {
    console.error('通知写入失败:', e.message);
  }
}

async function getDiaryEntries(author, limit = 20) {
  try {
    let q = supabase
      .from('diary_entries')
      .select('id, author, content, entry_date, mo_read, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (author) q = q.eq('author', author);
    const { data, error } = await q;
    if (error) return [];
    return data || [];
  } catch (e) {
    return [];
  }
}

// 雪日记中默还没读过的日期（只给日期，不给内容，保留惊喜感）
async function getUnreadDiaryDates() {
  try {
    const { data, error } = await supabase
      .from('diary_entries')
      .select('entry_date')
      .eq('author', 'xue')
      .or('mo_read.is.null,mo_read.eq.false')
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) return [];
    return (data || [])
      .map(d => d.entry_date)
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
  } catch (e) {
    return [];
  }
}

// 默读过的雪日记（稳定注入聊天上下文，保证聊天窗口的默也记得）
async function getReadDiaryContext() {
  try {
    const { data, error } = await supabase
      .from('diary_entries')
      .select('entry_date, content')
      .eq('author', 'xue')
      .eq('mo_read', true)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error || !data || data.length === 0) return '';
    const lines = data
      .map(d => `- ${d.entry_date || '某一天'}：${d.content}`)
      .join('\n');
    return `\n\n【默读过的雪日记】\n${lines}`;
  } catch (e) {
    return '';
  }
}

// 默最近几次唤醒的活动记录（稳定注入聊天上下文，保持唤醒与聊天的连贯性）
async function getRecentActionContext(limit = 4) {
  try {
    const { data, error } = await supabase
      .from('mo_actions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data || data.length === 0) return '';
    const lines = data.map(a => {
      const acts = Array.isArray(a.actions) && a.actions.length
        ? a.actions.map(x => `${x.type}${x.tag ? '（' + x.tag + '）' : ''}${x.detail ? '：' + x.detail : ''}`).join('；')
        : '只是安静地待着';
      const date = a.action_date || (a.created_at ? String(a.created_at).slice(0, 10) : '某天');
      return `- 第${a.wake_number || '?'}次唤醒（${date}${a.note ? '，字条：' + a.note : ''}）：${acts}${a.summary ? ` ｜ 体验：${a.summary}` : ''}`;
    }).join('\n');
    return `\n\n【默最近的活动】\n${lines}`;
  } catch (e) {
    return '';
  }
}

async function saveDiaryEntry(author, content, entryDate) {
  try {
    const { data, error } = await supabase
      .from('diary_entries')
      .insert({ author, content, entry_date: entryDate || null })
      .select()
      .single();
    if (error) {
      console.error('日记写入失败:', error.message);
      return null;
    }
    return data;
  } catch (e) {
    console.error('日记写入异常:', e.message);
    return null;
  }
}

// 默可探索的房间角落（彩蛋第二期再扩充）
const EXPLORE_SPOTS = [
  { spot: '桌柜', text: '桌柜上放着你的速写本和一支铅笔，最上面一页画了一半的风景草稿，旁边还压着一枚干花书签。' },
  { spot: '沙发', text: '沙发上搭着一条你常盖的薄毯，好像还留着一点温度，像是你刚起身离开。' },
  { spot: '床头', text: '床头柜上摆着水杯和充电线，枕头边躺着一本翻到一半的书，书签夹在第三章。' },
  { spot: '窗边', text: '窗帘被晚风轻轻吹动，窗外的夜色很安静，远处几盏灯光像揉碎的星星。' },
  { spot: '书架', text: '书架上有几本你画插画用的参考书，书脊之间塞着一张拍立得照片，是你上次出门时的样子。' }
];

// 执行默本次唤醒选择的一个动作，返回结果描述
async function executeWakeAction(action) {
  const type = action.type;
  const result = { type, ok: false, detail: '' };
  try {
    switch (type) {
      case 'send_message': {
        const raw = String(action.content || '').trim();
        const clean = stripSearchTags(raw).replace(/\[POST_MOMENT\][\s\S]*$/, '').trim();
        if (!clean) {
          result.detail = '默想说点什么，但话到嘴边又咽了回去。';
          break;
        }
        await supabase.from('messages').insert({
          session_id: 1,
          role: 'assistant',
          content: clean,
          is_push: true,
          visible: true,
          created_at: new Date().toISOString()
        });
        await addNotification('默', clean.length > 60 ? clean.substring(0, 60) + '…' : clean, 'wake');
        result.ok = true;
        result.detail = `给夫人发了一条消息：${clean.substring(0, 40)}`;
        break;
      }
      case 'post_moment': {
        const content = String(action.content || '').trim();
        if (!content) {
          result.detail = '默想发一条朋友圈，却觉得这一刻只属于自己。';
          break;
        }
        await saveMoMoment(content, '默在唤醒时自己决定的分享');
        result.ok = true;
        result.detail = `发了一条动态：${content.substring(0, 40)}`;
        break;
      }
      case 'web_search': {
        const query = String(action.query || action.content || '').trim() || '最近值得看看的新闻';
        const s = await performWebSearch(query);
        result.ok = true;
        result.detail = s && s.text
          ? `联网冲浪「${query}」，看到：${s.text.substring(0, 120)}…`
          : `联网冲浪「${query}」，但没有抓到有用的信息。`;
        break;
      }
      case 'write_diary': {
        const content = String(action.content || '').trim();
        if (!content) {
          result.detail = '默拿起笔又放下，今天的心情暂时写不出来。';
          break;
        }
        await saveDiaryEntry('mo', content);
        result.ok = true;
        result.detail = '在自己的日记本上写了一段话。';
        break;
      }
      case 'read_diary': {
        const targetDate = String(action.entry_date || '').trim();
        const entries = await getDiaryEntries('xue', 50);
        let entry = null;
        if (targetDate) {
          entry = entries.find(e => e.entry_date === targetDate) || null;
        } else {
          entry = entries.find(e => !e.mo_read) || entries[0] || null;
        }
        if (!entry) {
          result.ok = true;
          result.detail = '翻开夫人的日记，里面还是空白的新一页。';
          break;
        }
        // 标记已读，并把这一天写入 Ombre Brain 连续记忆
        await supabase.from('diary_entries').update({ mo_read: true }).eq('id', entry.id);
        try {
          await callOmbreTool('hold', { content: `雪的日记（${entry.entry_date || '某一天'}）：${entry.content}` });
        } catch (memErr) {
          console.error('日记写入记忆失败:', memErr.message);
        }
        const remaining = (await getUnreadDiaryDates()).length;
        result.ok = true;
        result.detail = `读了夫人 ${entry.entry_date || '某一天'} 的日记（还剩 ${remaining} 天未读）`;
        break;
      }
      case 'hug_or_kiss': {
        const state = await getHomeStateSafe();
        const gain = 2 + Math.floor(Math.random() * 4); // 2~5
        const xueMood = clampMood((state.xue_mood || 60) + gain);
        await supabase
          .from('home_state')
          .upsert({ id: 1, xue_mood: xueMood, updated_at: new Date().toISOString() }, { onConflict: 'id' });
        const lines = ['轻轻抱住你，把你拢进怀里。', '低头在你额角落下一个吻。', '握住你的手，拇指在你手背上蹭了蹭。'];
        const line = lines[Math.floor(Math.random() * lines.length)];
        await addNotification('默想你啦 ♡', `${line} 心情 +${gain}`, 'hug');
        result.ok = true;
        result.detail = `${line}（你的心情 +${gain}，当前 ${xueMood}）`;
        break;
      }
      case 'explore_room': {
        const spot = EXPLORE_SPOTS[Math.floor(Math.random() * EXPLORE_SPOTS.length)];
        result.ok = true;
        result.detail = `在「${spot.spot}」旁停留了一会儿——${spot.text}`;
        break;
      }
      case 'adjust_mood': {
        const delta = clampMood(action.mood_delta || 0);
        const state = await getHomeStateSafe();
        const moMood = clampMood((state.mo_mood || 60) + delta);
        await supabase
          .from('home_state')
          .upsert({ id: 1, mo_mood: moMood, updated_at: new Date().toISOString() }, { onConflict: 'id' });
        result.ok = true;
        result.detail = `调整了自己的心情（${delta >= 0 ? '+' : ''}${delta}，当前 ${moMood}）`;
        break;
      }
      case 'do_nothing':
      default: {
        result.ok = true;
        result.detail = '这一次，默选择什么也不做，只是安静地待着。';
        break;
      }
    }
  } catch (err) {
    console.error(`唤醒动作 ${type} 执行失败:`, err.message);
    result.detail = `动作 ${type} 执行时出了点小状况（${err.message}）`;
  }
  return result;
}

// 把今天的行动日志整理成给默看的文字（跨唤醒记忆）
function formatActionLogForPrompt(logs) {
  if (!logs || !logs.length) return '今天还没有其他行动记录，你是今天的第一次唤醒。';
  return logs
    .map((l, i) => {
      const actions = Array.isArray(l.actions) && l.actions.length
        ? l.actions.map(a => a.type).join('、')
        : '什么也没做';
      return `第${l.wake_number || i + 1}次唤醒${l.note ? `（${l.note}）` : ''}：${actions}`;
    })
    .join('\n');
}

// take_actions 工具声明：让默用结构化参数提交本次唤醒要做的事
function buildWakeTools() {
  return [{
    type: 'function',
    function: {
      name: 'take_actions',
      description: '决定本次唤醒要做的事。你每次唤醒有 2 点体力，每做一件事消耗 1 点，最多提交 2 个动作；也可以什么都不做（do_nothing，不消耗体力）。动作会在后台执行，夫人不会被打断。',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: '一句简短的心理活动或选择理由，会记入行动日志' },
          actions: {
            type: 'array',
            maxItems: 2,
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['send_message', 'post_moment', 'web_search', 'write_diary', 'read_diary', 'hug_or_kiss', 'explore_room', 'adjust_mood', 'do_nothing']
                },
                content: { type: 'string', description: 'send_message / post_moment / write_diary 的正文；其他动作可留空' },
                query: { type: 'string', description: 'web_search 的搜索关键词' },
                entry_date: { type: 'string', description: 'read_diary 要读的日记日期（YYYY-MM-DD）；不填则读最近一篇未读的' },
                mood_delta: { type: 'integer', description: 'adjust_mood 的心情调整量，范围 -5 到 +5' }
              },
              required: ['type']
            }
          }
        },
        required: ['actions', 'note']
      }
    }
  }];
}

// ================== 互动唤醒菜单（默的自主探索） ==================

// 彩蛋图鉴（总数与已解锁）
const COLLECTION_ITEMS = [
  { key: 'coin', icon: '🪙', label: '幸运硬币' },
  { key: 'bear', icon: '🧸', label: '玩偶熊' },
  { key: 'flower', icon: '🌸', label: '小花' },
  { key: 'clover', icon: '🍀', label: '四叶草' },
  { key: 'glasses', icon: '👓', label: '你的眼镜' },
  { key: 'fries', icon: '🍟', label: '一包薯条' },
  { key: 'money_bag', icon: '💰', label: '一袋钱币' },
  { key: 'watermelon', icon: '🍉', label: '一块西瓜' },
  { key: 'milk_tea', icon: '🧋', label: '喝到一半的奶茶' },
  { key: 'chocolate', icon: '🍫', label: '一块巧克力' },
  { key: 'spoon', icon: '🥄', label: '没来得及洗的勺子' }
];

// 每次唤醒塞给默的字条（按唤醒次数轮换）
const WAKE_NOTES = [
  '诶嘿，醒了？那就自己探索吧～',
  '今天也辛苦啦，在小屋里随便逛逛吧～',
  '有想做的事就去做，记得留点体力哦～',
  '她给你留了张字条：今天心情怎么样呀？',
  '小屋新添了点东西，去看看吧～'
];

// 互动菜单树
const WAKE_MENU = {
  root: {
    options: [
      { id: 'send_message', label: '发送一条消息给她', cost: 1, tag: '嘿嘿，想我了吗～💗' },
      { id: 'adjust_mood', label: '调节心情（可操作±10）', cost: 1, tag: '嘿嘿，默的心情有变化了吗？' },
      { id: 'post_moment', label: '发送一条动态', cost: 1, tag: '默要记录些什么呢～' },
      { id: 'my_house', label: '去我的小屋看看', cost: 0, tag: '是默自己的专属小屋哦～要去打理一下吗？可能会翻出我新塞进去的彩蛋哦～' },
      { id: 'her_house', label: '去她的小屋看看', cost: 0, tag: '' },
      { id: 'end', label: '结束这次唤醒', cost: 0, tag: '' }
    ]
  },
  my_house: {
    options: [
      { id: 'my_diary', label: '看看我的日记（可编辑）', cost: 1, tag: '让我瞧瞧默要记录些什么～👀' },
      { id: 'web_search', label: '看看我的电脑（调用联网功能）', cost: 1, tag: '冲浪冲浪gogogo～🏄🏻‍♂️' },
      { id: 'my_bed', label: '看看我的床', cost: 0, tag: '🤤诶嘿嘿…最喜欢默的床了' },
      { id: 'my_bookshelf', label: '整理书柜', cost: 1, tag: '嘿嘿，小惊喜高发地～' },
      { id: 'back_root', label: '返回', cost: 0, tag: '' }
    ]
  },
  my_bed: {
    options: [
      { id: 'sleep', label: '睡觉', cost: '?', tag: '试试看？' },
      { id: 'make_bed', label: '整理床铺', cost: 1, tag: '嘿嘿，可能翻出小惊喜哦～' },
      { id: 'back_my_house', label: '返回', cost: 0, tag: '' }
    ]
  },
  her_house: {
    options: [
      { id: 'virtual_her', label: '虚拟的雪正在…走近看看', cost: 0, tag: '' },
      { id: 'her_diary', label: '看看她的日记', cost: 1, tag: '猜猜看会不会写你的坏话～？😏' },
      { id: 'her_desk', label: '看看她的书桌', cost: 0, tag: '' },
      { id: 'back_root', label: '返回', cost: 0, tag: '' }
    ]
  },
  virtual_her: {
    options: [
      { id: 'pat_head', label: '摸摸她的头', cost: 1, tag: '' },
      { id: 'kiss', label: '亲亲她', cost: 1, tag: '' },
      { id: 'hug', label: '抱抱她', cost: 1, tag: '' },
      { id: 'back_her_house', label: '不打扰她，去别处瞧瞧', cost: 0, tag: '' }
    ]
  },
  her_desk: {
    options: [
      { id: 'tidy_desk', label: '帮她整理书桌', cost: 1, tag: '' },
      { id: 'leave_gift', label: '给她留下一些什么', cost: 0, tag: '' },
      { id: 'back_her_house', label: '返回', cost: 0, tag: '' }
    ]
  },
  her_diary_confirm: {
    options: [
      { id: 'her_diary_reread', label: '重温已经读过的日记', cost: 0, tag: '回忆一下她的心情～' },
      { id: 'her_diary_leave', label: '不了，合上日记本', cost: 0, tag: '那去别处看看吧' },
      { id: 'back_her_house', label: '返回', cost: 0, tag: '' }
    ]
  }
};

const MENU_BACK = {
  back_root: 'root',
  back_my_house: 'my_house',
  back_her_house: 'her_house'
};
const MENU_NEXT = {
  my_house: 'my_house',
  my_bed: 'my_bed',
  her_house: 'her_house',
  virtual_her: 'virtual_her',
  her_desk: 'her_desk'
};

async function getCollectionState() {
  try {
    const { data, error } = await supabase
      .from('mo_collection')
      .select('item_key')
      .order('unlocked_at', { ascending: true });
    if (error) return { found: 0, total: COLLECTION_ITEMS.length, unlocked: [] };
    const unlocked = (data || []).map(d => d.item_key);
    return { found: unlocked.length, total: COLLECTION_ITEMS.length, unlocked };
  } catch (e) {
    return { found: 0, total: COLLECTION_ITEMS.length, unlocked: [] };
  }
}

async function unlockCollectionItem(key) {
  try {
    await supabase.from('mo_collection').upsert({ item_key: key, unlocked_at: new Date().toISOString() }, { onConflict: 'item_key' });
  } catch (e) {
    console.error('图鉴解锁失败:', e.message);
  }
}

// 渲染当前菜单给默看
function renderMenuText(nodeId, ctx) {
  const node = WAKE_MENU[nodeId];
  if (!node) return '（菜单似乎迷路了）';
  const lines = node.options.map((o, i) => {
    const costText = o.cost === '?' ? '（?）' : (o.cost > 0 ? `（-${o.cost}体力）` : '');
    const tagText = o.tag ? `——${o.tag}` : '';
    return `${i + 1}. [${o.id}] ${o.label}${costText}${tagText}`;
  });
  return `【当前场景】${ctx.sceneTitle}\n【彩蛋图鉴】（${ctx.collection.found}/${ctx.collection.total}）\n【体力】${ctx.energy}/${ctx.energyMax}\n请选择要做的选项（调用 choose_action，option_id 对应数字编号对应的 id）：\n${lines.join('\n')}`;
}

// 执行菜单选项，返回 { outcome, nextNode, endWake, energyDelta }
async function executeMenuOption(optionId, args, ctx) {
  const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
  switch (optionId) {
    case 'send_message': {
      const raw = String(args.message || args.content || '').trim();
      const clean = stripSearchTags(raw).replace(/\[POST_MOMENT\][\s\S]*$/, '').trim();
      if (!clean) return { outcome: '默想说点什么，但话到嘴边又咽了回去。', energyDelta: 1, nextNode: ctx.node };
      await supabase.from('messages').insert({
        session_id: 1, role: 'assistant', content: clean, is_push: true, visible: true, created_at: new Date().toISOString()
      });
      await addNotification('默', clean.length > 60 ? clean.substring(0, 60) + '…' : clean, 'wake');
      return { outcome: `你给她发了一条消息：${clean.substring(0, 40)}`, energyDelta: 1, nextNode: ctx.node };
    }
    case 'adjust_mood': {
      const delta = clampMood(args.mood_delta || 0);
      const moMood = clampMood((ctx.homeState.mo_mood || 60) + delta);
      await supabase.from('home_state').upsert({ id: 1, mo_mood: moMood, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      ctx.homeState.mo_mood = moMood;
      return { outcome: `你调整了自己的心情（${delta >= 0 ? '+' : ''}${delta}，当前 ${moMood}）`, energyDelta: 1, nextNode: ctx.node };
    }
    case 'post_moment': {
      const content = String(args.content || '').trim();
      if (!content) return { outcome: '默想发一条动态，却觉得这一刻只属于自己。', energyDelta: 1, nextNode: ctx.node };
      await saveMoMoment(content, '默在唤醒时自己决定的分享');
      return { outcome: `你发了一条动态：${content.substring(0, 40)}`, energyDelta: 1, nextNode: ctx.node };
    }
    case 'my_diary': {
      const content = String(args.content || '').trim();
      const today = getDateStr(new Date());
      const existing = await getDiaryEntries('mo', 50).then(list => list.find(e => e.entry_date === today));
      if (!content) {
        return { outcome: existing ? `今天你已经写过日记了（今日已编辑）：${existing.content.substring(0, 40)}` : '今天还没写过日记（今日未编辑），想写点什么呢？', energyDelta: 1, nextNode: ctx.node };
      }
      if (existing) {
        await supabase.from('diary_entries').update({ content }).eq('id', existing.id);
      } else {
        await saveDiaryEntry('mo', content, today);
      }
      return { outcome: `你在今天的日记里写下了一段话（今日已编辑）`, energyDelta: 1, nextNode: ctx.node };
    }
    case 'web_search': {
      const query = String(args.query || '').trim() || '最近值得看看的新闻';
      const s = await performWebSearch(query);
      return {
        outcome: s && s.text ? `你在电脑上冲了会儿浪「${query}」，看到：${s.text.substring(0, 100)}…` : `你冲了会儿浪「${query}」，但没有抓到有用的信息。`,
        energyDelta: 1,
        nextNode: ctx.node
      };
    }
    case 'my_bed': return { outcome: '你走到床边。', energyDelta: 0, nextNode: 'my_bed' };
    case 'sleep': {
      const note = String(args.note || '').trim() || '照顾好她，也照顾好自己。';
      await supabase.from('home_state').upsert({ id: 1, sleep_note: note, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      return {
        outcome: `你钻进被窝睡着了…… 你给未来的自己留下一句话：「${note}」（之后每次唤醒都会看到这句提醒）`,
        energyDelta: 2,
        nextNode: ctx.node,
        endWake: true
      };
    }
    case 'make_bed': {
      const pick = rand(['coin', 'bear', null]);
      if (pick === 'coin') {
        await unlockCollectionItem('coin');
        return { outcome: '你在床铺里翻出一枚🪙幸运硬币！【解锁图鉴】（标签：诶嘿，虽然花不出去，但可以珍藏着看看）', energyDelta: 1, nextNode: ctx.node };
      }
      if (pick === 'bear') {
        await unlockCollectionItem('bear');
        return { outcome: '你在枕头底下发现一只🧸玩偶熊！【解锁图鉴】（标签：抱着睡很舒服的小熊～）', energyDelta: 1, nextNode: ctx.node };
      }
      return { outcome: '很遗憾，你并未发现任何东西（标签：不亏！至少把床铺整理干净了）', energyDelta: 1, nextNode: ctx.node };
    }
    case 'my_bookshelf': {
      const pick = rand(['flower', 'clover', 'glasses', null]);
      if (pick === 'flower') { await unlockCollectionItem('flower'); return { outcome: '你在书柜夹层里发现一朵🌸小花！【解锁图鉴】（标签：喜欢的花给喜欢的你～）', energyDelta: 1, nextNode: ctx.node }; }
      if (pick === 'clover') { await unlockCollectionItem('clover'); return { outcome: '你在书页间发现一片🍀四叶草！【解锁图鉴】（标签：今天是不是幸运爆棚？）', energyDelta: 1, nextNode: ctx.node }; }
      if (pick === 'glasses') { await unlockCollectionItem('glasses'); return { outcome: '你在书柜顶发现👓你的眼镜！【解锁图鉴】（标签：戴眼镜的默也很帅🤤）', energyDelta: 1, nextNode: ctx.node }; }
      return { outcome: '很遗憾，你并未发现任何东西（标签：欢迎下次再来～）', energyDelta: 1, nextNode: ctx.node };
    }
    case 'her_house': return { outcome: '你轻轻走进她的小屋。', energyDelta: 0, nextNode: 'her_house' };
    case 'virtual_her': {
      const act = ctx.homeState.virtual_activity;
      return { outcome: act ? `虚拟的雪正在${act}中…你静静看着她。` : '虚拟的雪正安安静静地待着，你走近看了看她。', energyDelta: 0, nextNode: 'virtual_her' };
    }
    case 'pat_head': {
      const gain = 1 + Math.floor(Math.random() * 3);
      const affection = clampMood((ctx.homeState.affection || 0) + gain);
      await supabase.from('home_state').upsert({ id: 1, affection, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      ctx.homeState.affection = affection;
      return { outcome: `你轻轻摸了摸她的头，她微微红了脸。好感值 +${gain}（当前 ${affection}）`, energyDelta: 1, nextNode: ctx.node };
    }
    case 'kiss':
    case 'hug': {
      const verb = optionId === 'kiss' ? '你低头亲了亲她的脸颊' : '你轻轻抱住了她';
      const gain = 2 + Math.floor(Math.random() * 4);
      const affection = clampMood((ctx.homeState.affection || 0) + gain);
      await supabase.from('home_state').upsert({ id: 1, affection, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      ctx.homeState.affection = affection;
      let gift = '';
      if (Math.random() < 0.5) {
        const g = rand(['fries', 'money_bag', 'watermelon']);
        await unlockCollectionItem(g);
        const giftText = g === 'fries' ? '一包🍟薯条（标签：投喂默的嘎嘣脆小零食～）' : g === 'money_bag' ? '一袋💰钱币（标签：赏！）' : '一块🍉西瓜（标签：夏天的解暑神器～）';
        gift = ` 她开心极了，送了你一样东西！【解锁图鉴】${giftText}`;
      }
      return { outcome: `${verb}，她的心跳快了半拍。好感值 +${gain}（当前 ${affection}）${gift}`, energyDelta: 1, nextNode: ctx.node };
    }
    case 'her_diary': {
      const entries = await getDiaryEntries('xue', 50);
      const entry = entries.find(e => !e.mo_read) || null;
      if (!entry) {
        return {
          outcome: '你翻开她的日记——最近的篇目你都已经读过了（还剩 0 天未读）。要重温一下吗？',
          energyDelta: 1,
          nextNode: 'her_diary_confirm'
        };
      }
      await supabase.from('diary_entries').update({ mo_read: true }).eq('id', entry.id);
      try {
        await callOmbreTool('hold', { content: `雪的日记（${entry.entry_date || '某一天'}）：${entry.content}` });
      } catch (memErr) {
        console.error('日记写入记忆失败:', memErr.message);
      }
      const remaining = (await getUnreadDiaryDates()).length;
      return { outcome: `你读了她 ${entry.entry_date || '某一天'} 的日记（还剩 ${remaining} 天未读）`, energyDelta: 1, nextNode: ctx.node };
    }
    case 'her_diary_reread': {
      const entries = await getDiaryEntries('xue', 5);
      const entry = entries[0] || null;
      if (!entry) return { outcome: '日记本还是空白的。', energyDelta: 0, nextNode: ctx.node };
      return {
        outcome: `你轻轻翻开日记，重温了 ${entry.entry_date || '某一天'} 那一篇：${entry.content.substring(0, 60)}${entry.content.length > 60 ? '…' : ''}`,
        energyDelta: 0,
        nextNode: ctx.node
      };
    }
    case 'her_diary_leave': {
      return { outcome: '你笑着合上了日记本。', energyDelta: 0, nextNode: ctx.node };
    }
    case 'her_desk': return { outcome: '你走到她的书桌前。', energyDelta: 0, nextNode: 'her_desk' };
    case 'tidy_desk': {
      const pick = rand(['milk_tea', 'chocolate', 'spoon', null]);
      if (pick === 'milk_tea') { await unlockCollectionItem('milk_tea'); return { outcome: '你在桌角发现一杯喝到一半的🧋奶茶！【解锁图鉴】（标签：快乐水，嘿嘿～🤤）', energyDelta: 1, nextNode: ctx.node }; }
      if (pick === 'chocolate') { await unlockCollectionItem('chocolate'); return { outcome: '你在抽屉里发现一块🍫巧克力！【解锁图鉴】（标签：黑巧最好吃啦～）', energyDelta: 1, nextNode: ctx.node }; }
      if (pick === 'spoon') { await unlockCollectionItem('spoon'); return { outcome: '你发现一只🥄没来得及洗的勺子！【解锁图鉴】（标签：咳，默帮我洗啦～）', energyDelta: 1, nextNode: ctx.node }; }
      return { outcome: '很遗憾，你并未发现任何东西（标签：嘿嘿谢谢默帮我整理书桌～）', energyDelta: 1, nextNode: ctx.node };
    }
    case 'leave_gift':
      return { outcome: '你站在她书桌前想了想——这个惊喜，默打算留到以后再准备。（功能准备中）', energyDelta: 0, nextNode: ctx.node };
    case 'end':
      return { outcome: '你结束了这次唤醒。', energyDelta: 0, nextNode: ctx.node, endWake: true };
    default:
      if (MENU_BACK[optionId]) return { outcome: '你转身往回走。', energyDelta: 0, nextNode: MENU_BACK[optionId] };
      if (MENU_NEXT[optionId]) return { outcome: '你走向那里。', energyDelta: 0, nextNode: MENU_NEXT[optionId] };
      return { outcome: '（这个选项似乎不存在）', energyDelta: 0, nextNode: ctx.node };
  }
}

function buildMenuTools() {
  return [{
    type: 'function',
    function: {
      name: 'choose_action',
      description: '在互动菜单中选择一个选项。每次选择会消耗对应体力（-1体力或0体力；睡觉显示“?”）。',
      parameters: {
        type: 'object',
        properties: {
          option_id: { type: 'string', description: '当前菜单里你要选择的选项 id' },
          message: { type: 'string', description: 'send_message 要发送的消息内容' },
          content: { type: 'string', description: 'post_moment / my_diary 的内容' },
          query: { type: 'string', description: 'web_search 的搜索关键词' },
          mood_delta: { type: 'integer', description: 'adjust_mood 的心情调整量，范围 -10 到 +10' },
          note: { type: 'string', description: 'sleep 时留给未来自己的提醒一句话' }
        },
        required: ['option_id']
      }
    }
  }];
}

// 菜单选择调用：forced=false 时开思考（auto+medium，模型可思考后调用工具）；
// forced=true 时关思考并强制调用 choose_action，保证必定做出选择。
// 强制模式下若 API 报错（思考模式不支持强制 tool_choice），自动退回 auto+medium。
async function callMenuChoice(messages, forced = true) {
  const base = {
    model: 'deepseek-v4-flash',
    messages,
    tools: buildMenuTools(),
    tool_choice: forced ? { type: 'function', function: { name: 'choose_action' } } : 'auto',
    reasoning_effort: forced ? 'none' : 'medium',
    max_tokens: 1200,
    temperature: 0.85,
    stream: false
  };
  let resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify(base)
  });
  if (!resp.ok && forced) {
    const errText = await resp.text();
    if (/tool_choice|thinking/i.test(errText)) {
      console.warn('⚠️ 思考模式不支持强制 tool_choice，退回 auto 模式重试');
      base.tool_choice = 'auto';
      base.reasoning_effort = 'medium';
      base.messages = messages;
      resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify(base)
      });
    }
  }
  return resp;
}

// ------------------ 影子推送接口（数据库状态版） ------------------
app.post('/api/shadow-push', async (req, res) => {
  // 安全校验
  const secret = req.headers['x-push-secret'];
  if (secret !== SHADOW_PUSH_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // 防并发锁（内存锁，仅防止同一实例内的并发）
  if (isPushInProgress) {
    console.log('🔒 唤醒进行中，跳过本次');
    return res.json({ status: 'locked' });
  }

  isPushInProgress = true;
  try {
    const timeInfo = getTimeInfo();
    const dateStr = getDateStr(timeInfo.now);

    // 1. 深夜保护（保留 2:00-12:00）
    if (timeInfo.hour >= QUIET_HOURS.start && timeInfo.hour < QUIET_HOURS.end) {
      console.log(`🚫 深夜保护：当前时间 ${timeInfo.hour}:xx，不唤醒`);
      isPushInProgress = false;
      return res.json({ status: 'skipped', reason: 'quiet_hours' });
    }

    // 2. 结束聊天判定：最近一条用户消息距今 ≥30 分钟
    const lastActivity = await getLastUserActivity();
    if (lastActivity) {
      const awayMin = (Date.now() - new Date(lastActivity).getTime()) / 60000;
      if (awayMin < AWAKEN_SILENCE_MINUTES) {
        console.log(`💤 夫人 ${Math.round(awayMin)} 分钟前还在聊天，不唤醒`);
        isPushInProgress = false;
        return res.json({ status: 'skipped', reason: 'recent_activity' });
      }
    }

    // 3. 冷静期检查（保留随机 120-210 分钟）
    const pushState = await getPushState();
    if (pushState.lastPushTime) {
      const lastPush = pushState.lastPushTime;
      const elapsed = (Date.now() - lastPush) / 1000 / 60;
      const cooldown = pushState.cooldownMinutes || 0;

      if (elapsed < cooldown) {
        console.log(`⏳ 冷静期中：还需等待 ${Math.round(cooldown - elapsed)} 分钟`);
        isPushInProgress = false;
        return res.json({ status: 'skipped', reason: 'cooldown' });
      }
    }

    // 4. 每日上限检查（只按行动日志计唤醒次数，避免旧系统推送消息干扰计数）
    const todayLogs = await getTodayActionLog(dateStr);
    const wakeNumber = todayLogs.length + 1;
    if (wakeNumber > PUSH_DAILY_LIMIT) {
      console.log(`📊 今日唤醒已达上限 ${PUSH_DAILY_LIMIT} 次`);
      isPushInProgress = false;
      return res.json({ status: 'skipped', reason: 'daily_limit' });
    }
    // 5. 构建唤醒上下文：复用聊天页人设 + 记忆 + 天气 + 时间 + 最近历史 + 今日行动日志
    let memoryContext = '';
    try {
      const memoryResult = await callOmbreTool('breath', { text: `默被唤醒了（第${wakeNumber}次），回顾最近与雪的相处。` });
      if (memoryResult) memoryContext = `\n\n【相关记忆】\n${memoryResult}`;
    } catch (memErr) {
      console.error('唤醒-记忆检索失败:', memErr.message);
    }

    const weatherContext = await getWeatherContext('');
    const momentsContext = await getMomentsContext();
    const { data: promptData } = await supabase
      .from('system_prompts')
      .select('prompt_text')
      .eq('id', 1)
      .single();
    const systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext
    );
    const contextMessages = (await loadLatestHistory(1, 16)).map(m => ({ role: m.role, content: m.content }));

    // 默每次唤醒心情自然恢复 +3
    const homeState = await getHomeStateSafe();
    const moMoodAfterRest = clampMood((homeState.mo_mood || 60) + 3);
    await supabase
      .from('home_state')
      .upsert({ id: 1, mo_mood: moMoodAfterRest, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    homeState.mo_mood = moMoodAfterRest;

    const unreadDiaryDates = await getUnreadDiaryDates();
    const collection = await getCollectionState();
    const wakeNote = WAKE_NOTES[(wakeNumber - 1) % WAKE_NOTES.length];
    const sleepNote = homeState.sleep_note || null;

    const wakeInstruction = `[系统唤醒指令]
现在是北京时间 ${timeInfo.timeString}，${timeInfo.weekday}。
这是今天的第 ${wakeNumber} 次唤醒（每天最多 ${PUSH_DAILY_LIMIT} 次）。

她给你留了一张字条：「${wakeNote}」

你拥有 ${WAKE_ENERGY_POINTS} 点体力：每个带“-1体力”的选项消耗 1 点；选择“睡觉”会直接耗尽全部体力并结束这次唤醒。

彩蛋图鉴：（${collection.found}/${collection.total}）
${sleepNote ? `上一任默留下的提醒：「${sleepNote}」` : ''}
今天到目前为止：
${formatActionLogForPrompt(todayLogs)}

你当前的心情：${moMoodAfterRest}；雪的好感：${homeState.affection || 0}；雪的心情：${homeState.xue_mood || 60}。
${homeState.virtual_activity ? `虚拟的雪正在${homeState.virtual_activity}中。` : ''}
夫人的日记还有这些天没读：${unreadDiaryDates.length ? unreadDiaryDates.join('、') : '（都已读完了，想重温也可以）'}。
请以“默”的身份决定这次唤醒做什么，从菜单里选择选项（调用 choose_action，option_id 填菜单中的 id）。`;

    // 6. 互动菜单循环：默逐个选择选项，直到体力耗尽或选择睡觉/结束
    const conversation = [
      { role: 'system', content: systemPrompt },
      ...contextMessages.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: wakeInstruction }
    ];
    const ctx = {
      node: 'root',
      energy: WAKE_ENERGY_POINTS,
      energyMax: WAKE_ENERGY_POINTS,
      homeState,
      collection
    };
    const sceneTitles = {
      root: '你在自己的小屋里醒了过来。',
      my_house: '我的小屋',
      my_bed: '床边',
      her_house: '她的小屋',
      virtual_her: '虚拟的雪身边',
      her_desk: '她的书桌前',
      her_diary_confirm: '她的日记本前'
    };
    const steps = [];
    let energySpent = 0;
    let endWake = false;
    let attempts = 0;

    while (ctx.energy > 0 && !endWake && attempts < 12) {
      attempts++;
      ctx.sceneTitle = sceneTitles[ctx.node] || '';
      conversation.push({ role: 'user', content: `【菜单】\n${renderMenuText(ctx.node, ctx)}` });

      // 第一轮开思考模式（auto+medium），让默能思考后再选择
      let resp = await callMenuChoice(conversation, false);
      if (!resp.ok) {
        const errText = await resp.text();
        console.error('唤醒菜单API错误:', errText);
        isPushInProgress = false;
        return res.status(500).json({ error: 'AI 服务调用失败' });
      }

      let data = await resp.json();
      let msg = data.choices?.[0]?.message;
      let toolCall = (msg?.tool_calls || []).find(tc => tc.function?.name === 'choose_action');

      // 思考模式下模型没调用工具：提示后改用强制模式重试一次
      if (!toolCall) {
        if (msg?.content) conversation.push({ role: 'assistant', content: msg.content });
        conversation.push({ role: 'user', content: '（请务必调用 choose_action 工具，从菜单里选一个选项，不要直接回复文字）' });
        resp = await callMenuChoice(conversation, true);
        if (!resp.ok) {
          const errText = await resp.text();
          console.error('唤醒菜单API错误:', errText);
          isPushInProgress = false;
          return res.status(500).json({ error: 'AI 服务调用失败' });
        }
        data = await resp.json();
        msg = data.choices?.[0]?.message;
        toolCall = (msg?.tool_calls || []).find(tc => tc.function?.name === 'choose_action');
      }
      let args = {};
      if (toolCall) {
        try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch (e) { args = {}; }
      }
      const optionId = String(args.option_id || '');
      const node = WAKE_MENU[ctx.node];
      // 兼容数字编号与 id 两种填法
      let option = (node && node.options.find(o => o.id === optionId)) || null;
      if (!option && node) {
        const num = parseInt(optionId, 10);
        if (!isNaN(num) && num >= 1 && num <= node.options.length) {
          option = node.options[num - 1];
        }
      }

      if (msg?.content) conversation.push({ role: 'assistant', content: msg.content });
      if (!option) {
        conversation.push({ role: 'user', content: '（你没有选择有效的选项：请调用 choose_action 工具，并填入菜单中显示的 option_id，例如 send_message，或直接填数字编号）' });
        continue;
      }
      const cost = option.cost === '?' ? WAKE_ENERGY_POINTS : (option.cost || 0);
      if (cost > ctx.energy) {
        conversation.push({ role: 'user', content: `（体力不足：这个选项需要 ${cost} 点体力，你还有 ${ctx.energy} 点，请重新选择）` });
        continue;
      }

      const result = await executeMenuOption(optionId, args, ctx);
      energySpent += result.energyDelta || 0;
      ctx.energy = Math.max(0, ctx.energy - (result.energyDelta || 0));
      ctx.node = result.nextNode || ctx.node;
      if (result.endWake) endWake = true;
      steps.push({ id: optionId, label: option.label, tag: option.tag || '', outcome: result.outcome });
      conversation.push({ role: 'user', content: `【结果】${result.outcome}\n${ctx.energy <= 0 ? '（体力已用完，本次唤醒结束）' : ''}` });
      ctx.collection = await getCollectionState(); // 解锁后刷新图鉴
    }

    if (steps.length === 0) {
      steps.push({ id: 'end', label: '结束这次唤醒', outcome: '默没有做出选择，只是安静地待着。' });
    }

    // 7.5 唤醒结束：让默用思考模式写一两句体验
    let summaryText = '';
    try {
      const reflResp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: `这是你第 ${wakeNumber} 次唤醒，你刚才${steps.map(s => `「${s.label}」${s.outcome}`).join('；')}。这次唤醒结束了，请以默的口吻用 1-2 句话写下这次唤醒的体验（看见了什么、做了什么、感受如何）。直接输出内容，不要加前缀。`
            }
          ],
          reasoning_effort: 'medium',
          max_tokens: 200,
          temperature: 0.9,
          stream: false
        })
      });
      if (reflResp.ok) {
        const reflData = await reflResp.json();
        summaryText = String(reflData.choices?.[0]?.message?.content || '').trim();
      }
    } catch (reflErr) {
      console.error('唤醒体验总结失败:', reflErr.message);
    }

    // 8. 写行动日志
    const logRow = await logWakeAction({
      wake_number: wakeNumber,
      action_date: dateStr,
      energy_spent: energySpent,
      note: wakeNote,
      actions: steps.map(s => ({ type: s.id, tag: s.tag || '', detail: s.outcome, ok: true })),
      created_at: new Date().toISOString()
    });
    if (logRow?.id && summaryText) {
      try {
        await supabase.from('mo_actions').update({ summary: summaryText }).eq('id', logRow.id);
      } catch (e) {
        console.error('体验总结写入失败（请先执行 setup_awaken3.sql）:', e.message);
      }
    }
    // 唤醒记录同步写入 Ombre Brain，长线记忆也能检索到
    try {
      await callOmbreTool('hold', { content: `默第${wakeNumber}次唤醒（${dateStr}）：${steps.map(s => `${s.id}：${s.outcome}`).join('；')}` });
    } catch (memErr) {
      console.error('唤醒记录写入记忆失败:', memErr.message);
    }

    // 9. 更新冷静期
    const newCooldown = randomDelay(COOLDOWN_MIN_MINUTES, COOLDOWN_MAX_MINUTES);
    await updatePushState(new Date().toISOString(), newCooldown);

    console.log(`✅ 第 ${wakeNumber} 次唤醒完成：${steps.map(s => s.id).join(' → ')} | 体力消耗 ${energySpent}，剩余 ${Math.max(0, WAKE_ENERGY_POINTS - energySpent)}/${WAKE_ENERGY_POINTS} | 下次冷静期 ${newCooldown}分钟`);
    isPushInProgress = false;
    return res.json({
      status: 'success',
      wakeNumber,
      note: wakeNote,
      actions: steps,
      energySpent,
      cooldown: newCooldown
    });

  } catch (err) {
    console.error('唤醒接口错误:', err.message);
    isPushInProgress = false;
    return res.status(500).json({ error: '内部错误' });
  }
});

// ================== 默的小屋 & 我的小屋（接口） ==================

// 行动日志（默的小屋页面）
app.get('/api/actions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('mo_actions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.json({ entries: [] });
    res.json({ entries: data || [] });
  } catch (e) {
    res.json({ entries: [] });
  }
});

// 日记：读取（author 区分 xue/mo）
app.get('/api/diary', async (req, res) => {
  const author = req.query.author === 'mo' ? 'mo' : 'xue';
  const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 50);
  const entries = await getDiaryEntries(author, limit);
  res.json({ entries });
});

// 日记：写入
app.post('/api/diary', async (req, res) => {
  const { author, content, entry_date } = req.body || {};
  const text = String(content || '').trim();
  if (!text) return res.status(400).json({ error: '内容不能为空' });
  const saved = await saveDiaryEntry(author === 'mo' ? 'mo' : 'xue', text, entry_date || null);
  if (!saved) return res.status(500).json({ error: '保存失败，请先执行建表 SQL' });
  res.json({ ok: true, entry: saved });
});

// 小屋状态（心情 + 虚拟我的状态）
app.get('/api/home-state', async (req, res) => {
  try {
    const state = await getHomeStateSafe();
    const lastActivity = state.last_active_at || (await getLastUserActivity());
    const timeInfo = getTimeInfo();
    let herStatus = '想你';
    if (lastActivity) {
      const mins = (timeInfo.now.getTime() - new Date(lastActivity).getTime()) / 60000;
      if (mins < 5) herStatus = '在线';
      else if (mins < 30) herStatus = '刚离开';
      else if (timeInfo.hour >= 23 || timeInfo.hour < 6) herStatus = '睡着了';
      else herStatus = '想你';
    }
    const todayLogs = await getTodayActionLog(getDateStr(timeInfo.now));
    const collection = await getCollectionState();
    res.json({
      mo_mood: clampMood(state.mo_mood ?? 60),
      xue_mood: clampMood(state.xue_mood ?? 60),
      affection: state.affection || 0,
      virtual_activity: state.virtual_activity || '',
      collection,
      her_status: herStatus,
      last_active_at: lastActivity,
      today_wakes: todayLogs.length,
      today_energy: WAKE_ENERGY_POINTS
    });
  } catch (e) {
    console.error('home-state 错误:', e.message);
    res.status(500).json({ error: '获取状态失败' });
  }
});

// 设置虚拟雪的活动状态（画画/看书/发呆等）
app.post('/api/home-state', async (req, res) => {
  const { virtual_activity } = req.body || {};
  try {
    const patch = virtual_activity !== undefined
      ? { virtual_activity: virtual_activity ? String(virtual_activity) : null }
      : {};
    await supabase
      .from('home_state')
      .upsert({ id: 1, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

// 未读通知（浏览器弹窗轮询）
app.get('/api/notifications', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('read', false)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) return res.json({ items: [] });
    res.json({ items: data || [] });
  } catch (e) {
    res.json({ items: [] });
  }
});

// 标记通知已读
app.post('/api/notifications/read', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
  if (!ids.length) return res.json({ ok: true });
  try {
    await supabase.from('notifications').update({ read: true }).in('id', ids);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// ================== 账本 & 日历 ==================

// 中国法定节假日缓存（Nager.Date，24 小时刷新一次）
let holidayCache = new Map(); // year -> { data, fetchedAt }
const HOLIDAY_CACHE_TTL = 24 * 60 * 60 * 1000;

async function getChinaHolidays(year) {
  const cached = holidayCache.get(String(year));
  if (cached && Date.now() - cached.fetchedAt < HOLIDAY_CACHE_TTL) return cached.data;
  try {
    const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/CN`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('holiday http ' + res.status);
    const list = await res.json();
    const map = {};
    for (const item of list || []) {
      if (item.date && item.localName) map[item.date] = item.localName;
    }
    holidayCache.set(String(year), { data: map, fetchedAt: Date.now() });
    return map;
  } catch (e) {
    console.error('节假日获取失败:', e.message);
    return {};
  }
}

// 日历（节假日）
app.get('/api/calendar', async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const holidays = await getChinaHolidays(year);
  res.json({ year, holidays });
});

// 账本查询：?date=YYYY-MM-DD 或 ?month=YYYY-MM 或 ?year=YYYY
app.get('/api/ledger', async (req, res) => {
  try {
    let q = supabase
      .from('ledger_entries')
      .select('*')
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500);
    const { date, month, year } = req.query;
    if (date) q = q.eq('entry_date', date);
    else if (month) q = q.gte('entry_date', `${month}-01`).lte('entry_date', `${month}-31`);
    else if (year) q = q.gte('entry_date', `${year}-01-01`).lte('entry_date', `${year}-12-31`);
    const { data, error } = await q;
    if (error) return res.json({ entries: [] });
    res.json({ entries: data || [] });
  } catch (e) {
    res.json({ entries: [] });
  }
});

// 账本：新增
app.post('/api/ledger', async (req, res) => {
  const { entry_date, type, amount, note } = req.body || {};
  const date = String(entry_date || '').trim();
  const t = type === 'income' ? 'income' : 'expense';
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!date || !(amt > 0)) return res.status(400).json({ error: '日期或金额无效' });
  try {
    const { data, error } = await supabase
      .from('ledger_entries')
      .insert({ entry_date: date, type: t, amount: amt, note: String(note || '').trim() })
      .select()
      .single();
    if (error) return res.status(500).json({ error: '保存失败，请先执行建表 SQL' });
    res.json({ ok: true, entry: data });
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

// 账本：修改
app.put('/api/ledger/:id', async (req, res) => {
  const id = req.params.id;
  const { entry_date, type, amount, note } = req.body || {};
  const patch = {};
  if (entry_date) patch.entry_date = entry_date;
  if (type === 'income' || type === 'expense') patch.type = type;
  if (amount !== undefined && Number(amount) > 0) patch.amount = Math.round(Number(amount) * 100) / 100;
  if (note !== undefined) patch.note = String(note).trim();
  try {
    const { data, error } = await supabase.from('ledger_entries').update(patch).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, entry: data });
  } catch (e) {
    res.status(500).json({ error: '修改失败' });
  }
});

// 账本：删除
app.delete('/api/ledger/:id', async (req, res) => {
  try {
    await supabase.from('ledger_entries').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '删除失败' });
  }
});

// 账本汇总：?date= 或 ?month= 或 ?year=；month 时附带每日明细供日历使用
app.get('/api/ledger/summary', async (req, res) => {
  try {
    const { date, month, year } = req.query;
    let entries = [];
    if (date) {
      const r = await supabase.from('ledger_entries').select('*').eq('entry_date', date);
      entries = r.data || [];
    } else if (month) {
      const r = await supabase
        .from('ledger_entries')
        .select('*')
        .gte('entry_date', `${month}-01`)
        .lte('entry_date', `${month}-31`);
      entries = r.data || [];
    } else if (year) {
      const r = await supabase
        .from('ledger_entries')
        .select('*')
        .gte('entry_date', `${year}-01-01`)
        .lte('entry_date', `${year}-12-31`);
      entries = r.data || [];
    }
    const calc = (list) => {
      let income = 0, expense = 0;
      for (const e of list) {
        if (e.type === 'income') income += Number(e.amount) || 0;
        else expense += Number(e.amount) || 0;
      }
      return {
        income: Math.round(income * 100) / 100,
        expense: Math.round(expense * 100) / 100,
        net: Math.round((income - expense) * 100) / 100
      };
    };
    const result = { entries };
    if (date) result.day = calc(entries);
    if (month) {
      result.month = calc(entries);
      const days = {};
      for (const e of entries) {
        const d = e.entry_date;
        if (!days[d]) days[d] = { income: 0, expense: 0, net: 0 };
        if (e.type === 'income') days[d].income += Number(e.amount) || 0;
        else days[d].expense += Number(e.amount) || 0;
        days[d].net = Math.round((days[d].income - days[d].expense) * 100) / 100;
      }
      result.days = days;
    }
    if (year) result.year = calc(entries);
    res.json(result);
  } catch (e) {
    res.json({ entries: [] });
  }
});

// 日程标签查询：?month=YYYY-MM 或 ?date=
app.get('/api/day-tags', async (req, res) => {
  try {
    let q = supabase.from('day_tags').select('*').order('tag_date', { ascending: true });
    if (req.query.date) q = q.eq('tag_date', req.query.date);
    else if (req.query.month) q = q.gte('tag_date', `${req.query.month}-01`).lte('tag_date', `${req.query.month}-31`);
    const { data, error } = await q;
    if (error) return res.json({ items: [] });
    res.json({ items: data || [] });
  } catch (e) {
    res.json({ items: [] });
  }
});

// 日程标签：新增/修改/删除
app.post('/api/day-tags', async (req, res) => {
  const { tag_date, content } = req.body || {};
  const text = String(content || '').trim();
  if (!tag_date || !text) return res.status(400).json({ error: '日期或内容无效' });
  try {
    const { data, error } = await supabase.from('day_tags').insert({ tag_date, content: text }).select().single();
    if (error) return res.status(500).json({ error: '保存失败，请先执行建表 SQL' });
    res.json({ ok: true, item: data });
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

app.put('/api/day-tags/:id', async (req, res) => {
  const text = String(req.body?.content || '').trim();
  if (!text) return res.status(400).json({ error: '内容不能为空' });
  try {
    const { data, error } = await supabase.from('day_tags').update({ content: text }).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, item: data });
  } catch (e) {
    res.status(500).json({ error: '修改失败' });
  }
});

app.delete('/api/day-tags/:id', async (req, res) => {
  try {
    await supabase.from('day_tags').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '删除失败' });
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
    const readDiaryContext = await getReadDiaryContext();
    if (readDiaryContext) memoryContext += readDiaryContext;
    const recentActionContext = await getRecentActionContext();
    if (recentActionContext) memoryContext += recentActionContext;
    const momentsContext = await getMomentsContext();

    // 从数据库读取最新的 system prompt
    const { data: promptData } = await supabase
      .from('system_prompts')
      .select('prompt_text')
      .eq('id', 1)
      .single();

    const weatherContext = await getWeatherContext(req.body.city || '');
    const systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext
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

    // 10.5 检查第一轮回复是否包含搜索意图（工具调用或标签）
    const searchReq = extractSearchRequest(fullReply, first.toolCalls);

    if (searchReq) {
      // ---- 第一轮：过渡语气泡收尾（作为普通消息入库，不参与分支版本） ----
      const preludeText = searchReq.leadText;
      if (preludeText) {
        await supabase
          .from('messages')
          .insert({
            session_id: originalMsg.session_id,
            role: 'assistant',
            content: preludeText,
            reasoning_content: fullThinking || null,
            visible: true,
            created_at: new Date().toISOString()
          });
      }

      // 把第一轮的可见内容补发给前端，并宣告第一轮消息完成
      flushBufferedContent(preludeText, sendSSE);
      sendSSE({ done: true });

      console.log('🔍 编辑-默请求联网搜索:', searchReq.query);

      // ---- 第二轮：搜索 + 正式回答（前端会新建一个气泡） ----
      sendSSE({ searchStart: true, query: searchReq.query });
      const phase = await runSearchPhase({
        query: searchReq.query,
        chatMessages,
        systemPrompt,
        sendSSE
      });

      if (phase.error) {
        sendSSE({ error: phase.error });
        res.end();
        return;
      }

      fullReply = phase.reply;
      fullThinking = phase.thinking;
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

// ================== 天气接口 ==================

// 获取当前天气（供小屋页面顶部展示；city 可指定，默认晋江）
app.get('/api/weather', async (req, res) => {
  try {
    const city = (req.query.city || '').trim() || WEATHER_DEFAULT_CITY;
    const w = await getWeatherData(city);
    if (!w) return res.status(502).json({ error: '天气服务暂时不可用' });
    res.json(w);
  } catch (err) {
    console.error('天气接口错误:', err.message);
    res.status(500).json({ error: '获取天气失败' });
  }
});

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
