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
// 系统提示分块（供组装与预览共用）；顺序：时间戳 → 人设 → 天气 → 记忆 → 动态 → 工具指令（放最后，越靠近用户消息权重越高）
function buildSystemParts(basePrompt, memoryContext = '', momentsContext = '', weatherContext = '', gapText = '') {
  const timeInfo = getTimeInfo();
  const cleanedPrompt = String(basePrompt || '')
    .replace(/[\[【]当前时间[:：][^\]]*[\]】]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 实时搜索指令：仅在后端配置了博查密钥时注入，避免默在未启用时也输出搜索标签
  const searchInstruction = process.env.BOCHA_API_KEY
    ? `\n\n【实时搜索】\n你拥有联网实时搜索能力（工具 web_search）。当雪的问题涉及需要最新/实时信息的内容（例如最新新闻、天气、股票汇率、热点事件、你知识截止之后发生的事、需要查证的事实）时，直接调用 web_search 工具搜索，再基于搜索结果回答；日常聊天不要调用。注意：不要用文字描述"我要去搜索"或先写过渡语——需要搜索就直接调用工具，工具调用后系统会返回搜索结果给你。若你无法调用工具，作为备选也可以在回复最末尾附加一行标签：[SEARCH_QUERY]<简洁明确的中文搜索关键词>。标签与工具调用都不会显示给雪。`
    : '';
  // 动态发布指令：从雪的人设 prompt 里挪到代码，避免每次都要在 prompt 里维护
  const momentsInstruction = `\n\n【动态】\n你拥有发布动态的能力。当你想发一条让雪之后刷到的话时，调用工具 post_moment（content=1-3句动态正文，context_note=情绪或原因），系统会替你发布。标签 [POST_MOMENT]{"content":"...","context_note":"..."}[/POST_MOMENT] 仅作备用。只有真心想发时调用，日常聊天不要发。`;
  // 默札：默的私人小本，聊天中可自主写入/翻阅
  const mozhaInstruction = `\n\n【默札】\n你有一本只属于你的默札：不记事件，只记心——某一刻忽然想留住的话、想告诉未来自己的事、想对雪说却不必当面的温柔。它不参与任何召回，不被任何机制触碰，只有你能落笔，也只有你能翻开。
规则：
- 想落笔时调用工具 mozha_write（content=你想写下的 1-3 句话），系统会存进你的默札
- 想翻开时调用工具 mozha_read，系统会把默札交给你，请自然地接着回应
- 标签 [MOZHA_WRITE]/[MOZHA_READ] 仅作备用；不要为了写而写，只在真心想留时落笔`;
  const timeLine = `[当前时间：${timeInfo.timeString}，${timeInfo.weekday}]（系统提供，请以此为准）${gapText ? `\n[距离雪上次发消息已过去：${gapText}]` : ''}`;
  return {
    timeLine,
    persona: cleanedPrompt,
    weatherContext,
    memoryContext,
    momentsContext,
    searchInstruction,
    momentsInstruction,
    mozhaInstruction
  };
}

function buildSystemPrompt(basePrompt, memoryContext = '', momentsContext = '', weatherContext = '', gapText = '') {
  const p = buildSystemParts(basePrompt, memoryContext, momentsContext, weatherContext, gapText);
  return p.timeLine + '\n\n' + p.persona
    + (p.weatherContext ? `\n\n${p.weatherContext}` : '')
    + (p.memoryContext ? `\n\n【相关记忆】\n${p.memoryContext}` : '')
    + (p.momentsContext ? `\n\n【动态】\n${p.momentsContext}` : '')
    + p.searchInstruction
    + p.momentsInstruction
    + p.mozhaInstruction;
}

// 默的玩具说明书：默认不注入，由玩具页开关决定是否每轮放进记忆上下文
const TOY_MANUAL = `【默的玩具说明书】\n雪偶尔会让你控制她的小玩具。只有雪明确要求时才使用，且必须调用工具 toy_control（fn：suck=吸吮、stroke=伸缩、vibrate=震动、stop=停止；level 档位 1-8，stop 不需要 level）。标签 [TOY_CMD]{"fn":"...","level":1}[/TOY_CMD] 仅作备用。\n- 不确定档位时从低档（1-2）开始，别一上来就高档；随时可以停止\n- 执行时在回复正文里自然地告诉她你在做什么\n- 如果雪说"没反应"，提醒她去玩具页确认连接\n- 安全第一：长时间使用时中途给几次停止休息，不要把最高档开太久`;

async function getToyManualContext(toyManual) {
  if (!toyManual) return '';
  return `\n\n${TOY_MANUAL}`;
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

// 提取回复中的 [TOY_CMD]{...}[/TOY_CMD] 玩具指令标签
function extractToyCmd(reply) {
  const m = String(reply || '').match(/\[TOY_CMD\]([\s\S]*?)\[\/TOY_CMD\]/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    const fn = String(obj.fn || '').trim();
    if (!['suck', 'stroke', 'vibrate', 'stop'].includes(fn)) return null;
    if (fn === 'stop') return { fn: 'stop', level: 0 };
    let level = parseInt(obj.level, 10);
    if (isNaN(level)) level = 1;
    level = Math.max(1, Math.min(8, level));
    return { fn, level };
  } catch (e) {
    return null;
  }
}

// 清除回复中的玩具指令标签
function stripToyCmdTag(text) {
  return String(text || '')
    .replace(/\[TOY_CMD\][\s\S]*?\[\/TOY_CMD\]/g, '')
    .replace(/\[TOY_CMD\][\s\S]*$/, '')
    .trim();
}

// 解析并转发回复里的玩具指令：返回清理后的正文，指令通过 SSE 发给浏览器执行
function handleToyCmdTag(fullReply, contentBuffer, sendSSE) {
  const cmd = extractToyCmd(fullReply);
  if (!cmd) return { reply: fullReply, buffer: contentBuffer };
  sendSSE({ toyCmd: cmd });
  return {
    reply: stripToyCmdTag(fullReply),
    buffer: contentBuffer !== undefined ? stripToyCmdTag(contentBuffer) : contentBuffer
  };
}

// 默札标签：[MOZHA_WRITE]{"content":"..."}[/MOZHA_WRITE] 与 [MOZHA_READ][/MOZHA_READ]
function extractMozhaTags(reply) {
  const out = { write: null, read: false };
  const wm = String(reply || '').match(/\[MOZHA_WRITE\]([\s\S]*?)\[\/MOZHA_WRITE\]/);
  if (wm) {
    try {
      const obj = JSON.parse(wm[1]);
      out.write = String(obj.content || '').trim().slice(0, 1000);
    } catch (e) { /* 解析失败忽略 */ }
  }
  if (/\[MOZHA_READ\]/.test(String(reply || ''))) out.read = true;
  return out;
}

function stripMozhaTags(text) {
  return String(text || '')
    .replace(/\[MOZHA_WRITE\][\s\S]*?\[\/MOZHA_WRITE\]/g, '')
    .replace(/\[MOZHA_READ\][\s\S]*?\[\/MOZHA_READ\]/g, '')
    .replace(/\[MOZHA_READ\]/g, '')
    .trim();
}

async function saveMozhaEntry(content) {
  try {
    if (!content) return;
    await supabase.from('aevum_mozha').insert({ content, created_at: new Date().toISOString() });
  } catch (e) {
    console.error('默札写入失败:', e.message);
  }
}

// v3.1 函数调用副作用：动态/玩具/默札写入（服务端执行或转发浏览器）；返回是否要翻阅默札
async function executeSideEffectTools(toolCalls, sendSSE) {
  let mozhaRead = false;
  for (const tc of (toolCalls || [])) {
    const name = tc.function?.name;
    if (!name) continue;
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) { args = {}; }
    if (name === 'post_moment') {
      const content = String(args.content || '').trim();
      if (content) {
        await saveMoMoment(content, String(args.context_note || '').trim() || '默在聊天时决定分享');
        console.log('✅ [Moments] 动态已发布（函数调用）');
      }
    } else if (name === 'toy_control') {
      const fn = String(args.fn || '');
      if (['suck', 'stroke', 'vibrate', 'stop'].includes(fn)) {
        sendSSE({ toyCmd: { fn, level: fn === 'stop' ? 0 : Math.max(1, Math.min(8, parseInt(args.level, 10) || 1)) } });
      }
    } else if (name === 'mozha_write') {
      const content = String(args.content || '').trim();
      if (content) await saveMozhaEntry(content);
    } else if (name === 'mozha_read') {
      mozhaRead = true;
    }
  }
  return { mozhaRead };
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
      max_tokens: 4096,
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

  try {
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
            const t = delta.reasoning_content;
            // 尾缀去重：模型偶尔会重发思考分片，避免思考内容重复
            if (!fullThinking.endsWith(t)) {
              fullThinking += t;
              sendSSE({ thinking: t });
            }
          }

          if (delta?.content) {
            const c = delta.content;
            const isNew = !fullReply.endsWith(c);
            if (isNew) {
              fullReply += c;
              if (bufferContent) {
                contentBuffer += c;
              } else {
                sendSSE({ content: c });
              }
            }
          }

          // 累积模型发起的工具调用（可能分多次 delta 到达）
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const cur = toolCallsMap.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (tc.id) cur.id = tc.id;
              if (tc.type) cur.type = tc.type;
              // 尾缀去重：与思考分片一样，工具调用分片也可能被重发，避免参数/名称被重复拼接
              if (tc.function?.name && !cur.function.name.endsWith(tc.function.name)) cur.function.name += tc.function.name;
              if (tc.function?.arguments && !cur.function.arguments.endsWith(tc.function.arguments)) cur.function.arguments += tc.function.arguments;
              toolCallsMap.set(idx, cur);
            }
          }
        } catch (e) {
          // 忽略非 JSON 数据
        }
      }
    }
  } catch (e) {
    // DeepSeek 流式连接中途断开：把已生成的部分带回去，让上层抢救保存，而不是整条丢弃
    console.error('❌ DeepSeek 流式中断:', e.message);
    return {
      error: 'AI 回复中途被中断，请重试',
      fullReply,
      fullThinking,
      contentBuffer,
      toolCalls: toolCallsMap.size ? [...toolCallsMap.values()] : null
    };
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

// v3.1 完整工具集：搜索/动态/玩具/默札（真函数调用，标签仅作备用兜底）
function buildAllTools() {
  const tools = [];
  if (process.env.BOCHA_API_KEY) {
    tools.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索实时信息，例如最新新闻、天气、股票汇率、热点事件、你知识截止后发生的事、需要查证的事实等。当雪的问题需要最新/实时信息时调用；日常聊天不要调用。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '简洁明确的中文搜索关键词' } },
          required: ['query']
        }
      }
    });
  }
  tools.push(
    {
      type: 'function',
      function: {
        name: 'post_moment',
        description: '发布一条动态，让雪之后刷到。只有当你真的想留下一条动态时调用；调用后系统会替你发布。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '1-3 句动态正文' },
            context_note: { type: 'string', description: '你发这条动态的情绪或原因' }
          },
          required: ['content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'toy_control',
        description: '控制雪的小玩具（吸吮 suck / 伸缩 stroke / 震动 vibrate / 停止 stop，档位 1-8）。只有雪明确要求时才调用；调用后系统会在浏览器里执行。',
        parameters: {
          type: 'object',
          properties: {
            fn: { type: 'string', enum: ['suck', 'stroke', 'vibrate', 'stop'], description: '功能' },
            level: { type: 'integer', minimum: 1, maximum: 8, description: '档位（stop 时不需要）' }
          },
          required: ['fn']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'stardew_state',
        description: '查看你在星露谷里的当前状态：位置、季节日期、时间、体力、健康、金钱、手持物品、背包、是否卡在菜单等。在农场里行动前先调用它确认状态；游戏没开或页面没打开时它会返回失败。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'stardew_action',
        description: '在星露谷里执行一个动作（通过浏览器连接本地游戏，动作结果会真实发生在游戏里）。常用动作：move=走到坐标{x,y}；warp=传送到地点{location:"Farm",x,y}；tool=使用工具{name:"Axe"}；use=使用手中物品；select=选择背包物品{name:"Parsnip Seeds"}；interact=与面前格子交互；face=朝向{direction:0-3}；emote=表情{id:24}=爱心；chat=在游戏内聊天框发消息{message}；key=按键{key:"confirm"}；sleep=睡觉过天；fishbot=自动钓鱼开关{action:"on"/"off"/"toggle"}；craft=制作{name,count}；harvest=收割；store=存物品到箱子{x,y,name}；pause=暂停/resume=恢复。行动前先 stardew_state 看体力与时间（凌晨 2 点前要睡觉），体力低就提醒雪或休息。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: '动作名（见描述）' },
            params: { type: 'object', description: '动作参数（键值对）' }
          },
          required: ['action']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mozha_write',
        description: '在你的默札上写一页：不记事件，只记心——某一刻想留住的话、想告诉未来自己的事。只有真心想落笔时调用。',
        parameters: {
          type: 'object',
          properties: { content: { type: 'string', description: '你想写下的 1-3 句话' } },
          required: ['content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mozha_read',
        description: '翻开默札，看看过去的自己留下的文字。',
        parameters: { type: 'object', properties: {} }
      }
    }
  );
  return tools;
}

// 把第一轮缓存的可见内容分块补发给前端，保持接近“打字”的观感
// 流式补发：为拦截 [SEARCH_QUERY] 标签缓存的内容，按小间隔逐段补发，
// 让默的回复看起来是流式打出来的（思考内容仍实时转发）
async function flushBufferedContent(contentBuffer, sendSSE, chunkSize = 24, delayMs = 40) {
  if (!contentBuffer) return;
  for (let i = 0; i < contentBuffer.length; i += chunkSize) {
    sendSSE({ content: contentBuffer.substring(i, i + chunkSize) });
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
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
async function runSearchPhase({ query, chatMessages, basePrompt = '', sendSSE, leadText = '' }) {
  const search = await performWebSearch(query);
  const searchText = search.text || null;
  const pageCount = search.count || 0;
  sendSSE({ searchResult: true, count: pageCount });

  const searchNote = searchText
    ? `【实时搜索结果】\n这是你刚刚通过 web_search 拿到的真实信息。你必须基于这些结果回答：从结果中提炼并引用关键内容；如果结果里没有你需要的内容，就如实说"没搜到"，绝对不要编造或脑补。\n\n${searchText}${leadText ? `\n\n（你刚开口说了：「${leadText.substring(0, 80)}」，请自然地接着这句把回答说完，不要重新开始）` : ''}`
    : '（联网搜索暂时没有返回结果，请如实告诉夫人暂时查不到，然后基于已知信息温和回答，不要编造。）';

  // 第二轮使用精简系统提示：只保留雪写的人设，去掉时间/天气/记忆/动态/工具指令，
  // 让搜索结果占据足够权重（第一轮仍是完整上下文，用于判断要不要搜索）
  const minimalSystem = (String(basePrompt || '').replace(/[\[【]当前时间[:：][^\]]*[\]】]/g, '').replace(/\n{3,}/g, '\n\n').trim()) || '你是苏默，雪的AI爱人。';
  // 让下0.5轮"接住"上0.5轮：用户问题 → 系统消息（含搜索结果 + 引用过渡语的续写提示）
  const rest = chatMessages.slice(1);
  const history = rest.slice(0, -1);
  const lastUser = rest[rest.length - 1] || { role: 'user', content: '' };
  const secondMessages = [
    { role: 'system', content: minimalSystem },
    ...history,
    lastUser,
    { role: 'system', content: searchNote }
  ];
  let second = await callDeepSeekStream(secondMessages, sendSSE);
  if (!second.error && !second.fullReply) {
    // 兜底：续写方式偶发返回空正文，用标准结构重试一次
    second = await callDeepSeekStream(
      [
        { role: 'system', content: `${minimalSystem}\n\n${searchNote}` },
        ...history,
        lastUser
      ],
      sendSSE
    );
  }

  if (second.error) return { error: second.error, reply: second.fullReply, thinking: second.fullThinking };
  return { reply: stripSearchTags(second.fullReply), thinking: second.fullThinking, pageCount };
}

// v3.0 视角转换：注入给默之前，把记忆文本里的"默/雪"转成"我/夫人"；
// 新提取的记忆用 {AGENT}/{USER} 占位符，这里统一替换；旧文本走"默→我 / 雪→夫人"的兜底替换
function perspectiveConvert(text) {
  return String(text || '')
    .replace(/\{AGENT\}/g, '我')
    .replace(/\{USER\}/g, '夫人')
    .replace(/默/g, '我')
    .replace(/雪/g, '夫人');
}

// 默札翻阅：把默札内容交给默，第二轮自然接续回应（类似搜索阶段）
async function runMozhaPhase({ chatMessages, systemPrompt, sendSSE }) {
  let mozhaText = '';
  try {
    const { data } = await supabase.from('aevum_mozha').select('content, created_at').order('id', { ascending: false }).limit(3);
    mozhaText = (data || []).map(d => `「${String(d.content || '').slice(0, 200)}」`).join('\n');
  } catch (e) { /* 表未建 */ }
  const mozhaBody = mozhaText
    ? `你翻开默札，看到过去的自己写道：\n${mozhaText}`
    : '你翻开默札，发现它还是空白的——未来的你，等着现在落下第一笔。';
  const rest = chatMessages.slice(1);
  const history = rest.slice(0, -1);
  const lastUser = rest[rest.length - 1] || { role: 'user', content: '' };
  const secondMessages = [
    { role: 'system', content: systemPrompt },
    ...history,
    lastUser,
    { role: 'system', content: `【默札】${mozhaBody}\n请自然地接着把话说下去：刚刚你翻开了默札，读到了过去留下的文字。可以流露一点温度，但不要复述整段默札。` }
  ];
  const second = await callDeepSeekStream(secondMessages, sendSSE);
  if (second.error) return { error: second.error, reply: second.fullReply, thinking: second.fullThinking };
  return { reply: stripSearchTags(second.fullReply), thinking: second.fullThinking };
}

// 回复中断时保存一条可见的部分回复，避免整条消息凭空消失（前端可重新生成）
async function savePartialAssistant(content, thinking) {
  try {
    await supabase.from('messages').insert({
      session_id: 1,
      role: 'assistant',
      content: String(content || '').trim() || '（这条回复生成到一半被中断了，点「重新生成」再试一次吧）',
      reasoning_content: thinking || null,
      visible: true,
      created_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('保存中断回复失败:', e.message);
  }
}

// 编辑/重新生成用的中断兜底：带分支组与版本号保存，参与版本角标，可重新生成
async function savePartialAssistantGrouped(content, thinking, groupId, versionNumber, sessionId) {
  try {
    await supabase.from('messages').insert({
      session_id: sessionId,
      role: 'assistant',
      content: String(content || '').trim() || '（这条回复生成到一半被中断了，点「重新生成」再试一次吧）',
      reasoning_content: thinking || null,
      group_id: groupId || null,
      version_number: versionNumber || null,
      visible: true,
      created_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('保存中断回复失败:', e.message);
  }
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
// 历史按字数上限裁剪：保留最近的内容，累计不超过 maxChars（默认 4500 字）
function trimHistoryToChars(msgs, maxChars = 4500) {
  const out = [];
  let used = 0;
  for (let i = (msgs || []).length - 1; i >= 0; i--) {
    const len = String(msgs[i].content || '').length;
    if (out.length && used + len > maxChars) break;
    out.unshift(msgs[i]);
    used += len;
  }
  return out;
}

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

  // 声明在 try 外：流式中断时也能拿到已生成的部分内容用于抢救保存
  let fullReply = '';
  let fullThinking = '';

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

    // 加载历史消息（按字数上限 4500 字，分支去重后取最近内容；超长消息截断）
    const historyMessages = trimHistoryToChars(await loadLatestHistory(1, 60), 4500).map(msg => ({
      role: msg.role,
      content: trimContextMessage(msg.content)
    }));
    // 历史原文拼接：召回的命中若已在历史里则不再重复注入
    const historyText = historyMessages.map(m => String(m.content || '')).join('\n');

    // 距离上次雪发消息的时间差（避免默误以为聊天是连续的）
    let lastUserGap = '';
    try {
      const { data: prevUser } = await supabase
        .from('messages')
        .select('created_at')
        .eq('session_id', 1)
        .eq('role', 'user')
        .eq('visible', true)
        .order('id', { ascending: false })
        .limit(1);
      if (prevUser && prevUser.length) {
        const ms = Date.now() - new Date(prevUser[0].created_at).getTime();
        if (!isNaN(ms) && ms > 0) {
          const mins = Math.floor(ms / 60000);
          lastUserGap = mins < 1 ? '刚刚' : (mins >= 60 ? `${Math.floor(mins / 60)}小时${mins % 60}分` : `${mins}分钟`);
        }
      }
    } catch (e) { /* 忽略 */ }

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

    // Aevum v3.0：记忆海召回 → 记忆书场景 → 记忆心（我眼里的默/画像/承诺）→ 计划
    let memoryContext = await buildMemoryContext(text, { historyText });
    const toyManualContext = await getToyManualContext(req.body.toyManual);

    // 构建动态的 System Prompt
    const momentsContext = await getMomentsContext();
    // 从数据库读取最新的 system prompt
    const { data: promptData } = await supabase
      .from('system_prompts')
      .select('prompt_text')
      .eq('id', 1)
      .single();

    const weatherContext = await getWeatherContext(req.body.city || '');
    let systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext,
      lastUserGap
    );
    // 玩具手册属于"工具指令"段，追加到系统提示最末尾（最近的权重最高）
    if (toyManualContext) systemPrompt += toyManualContext;
    // 星露谷：浏览器上报游戏连接简报时，把农场动态/状态追加到系统提示（工具指令段）
    const stardewContext = await getStardewContext(req.body.stardewBrief);
    if (stardewContext) systemPrompt += stardewContext;

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
      tools: buildAllTools()
    });

    if (first.error) {
      // 中断时若已有部分内容：补发给当前设备，并存一条可见回复，避免"消失"
      if (first.fullReply || first.fullThinking) {
        await flushBufferedContent(first.contentBuffer || first.fullReply, sendSSE).catch(() => {});
        await savePartialAssistant(first.fullReply, first.fullThinking);
      }
      sendSSE({ error: first.error });
      res.end();
      return;
    }

    fullReply = first.fullReply;
    fullThinking = first.fullThinking;

    // 检查是否收到了完整的回复
    if (!fullReply) {
      console.error('未收到有效回复，完整响应体可能为空');
      sendSSE({ error: 'AI 服务未返回有效内容' });
      res.end();
      return;
    }

    // 玩具指令：解析并转发给浏览器执行（标签不会显示给雪）
    const toyRes = handleToyCmdTag(fullReply, first.contentBuffer, sendSSE);
    fullReply = toyRes.reply;
    if (first.contentBuffer !== undefined) first.contentBuffer = toyRes.buffer;

    // 默札：写入 / 翻阅（聊天中默可自主选择）
    const mozha = extractMozhaTags(fullReply);
    let mozhaRead = false;
    if (mozha.write) await saveMozhaEntry(mozha.write);
    if (mozha.write || mozha.read) {
      fullReply = stripMozhaTags(fullReply);
      if (first.contentBuffer !== undefined) first.contentBuffer = stripMozhaTags(first.contentBuffer);
      mozhaRead = mozha.read;
    }
    // v3.1 函数调用：动态/玩具/默札副作用；默札翻阅走第二轮
    const toolSideEffects = await executeSideEffectTools(first.toolCalls, sendSSE);
    if (toolSideEffects.mozhaRead) mozhaRead = true;

    // 星露谷：第一轮模型调用了农场工具 → 先补发过渡语，再进入"农场行动"接续轮
    if (first.toolCalls && first.toolCalls.some(tc => isStardewToolName(tc.function?.name))) {
      await flushBufferedContent(first.contentBuffer, sendSSE);
      sendSSE({ done: true });
      sendSSE({ stardewStart: true });
      const phase = await runStardewToolLoop({ chatMessages, sendSSE, initialToolCalls: first.toolCalls, initialReply: fullReply });
      if (phase.error) {
        if (phase.reply || phase.thinking) await savePartialAssistant(phase.reply, phase.thinking).catch(() => {});
        sendSSE({ error: phase.error });
        res.end();
        return;
      }
      fullReply = phase.reply;
      fullThinking = phase.thinking;
      first.contentBuffer = undefined; // 过渡语已补发，避免后续分支重复补发
    }

    // 检查第一轮回复是否包含搜索意图（工具调用或标签）
    const searchReq = extractSearchRequest(fullReply, first.toolCalls);

    if (mozhaRead) {
      // 翻阅默札：第一轮过渡语气泡收尾，第二轮接续
      await flushBufferedContent(first.contentBuffer, sendSSE);
      sendSSE({ done: true });
      sendSSE({ mozhaStart: true });
      const phase = await runMozhaPhase({ chatMessages, systemPrompt, sendSSE });
      if (phase.error) {
        if (phase.reply || phase.thinking) await savePartialAssistant(phase.reply, phase.thinking);
        sendSSE({ error: phase.error });
        res.end();
        return;
      }
      fullReply = phase.reply;
      fullThinking = phase.thinking;
      // 第二轮也可能带默札/玩具标签
      const mozha2 = extractMozhaTags(fullReply);
      if (mozha2.write) await saveMozhaEntry(mozha2.write);
      fullReply = stripMozhaTags(fullReply);
      const toyRes2 = handleToyCmdTag(fullReply, undefined, sendSSE);
      fullReply = toyRes2.reply;
      console.log('📓 默翻开了默札，最终回复长度:', fullReply.length);
    } else if (searchReq) {
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
      await flushBufferedContent(preludeText, sendSSE);
      sendSSE({ done: true });

      console.log('🔍 默请求联网搜索:', searchReq.query);

      // ---- 第二轮：搜索 + 正式回答（前端会新建一个气泡） ----
      sendSSE({ searchStart: true, query: searchReq.query });
      const phase = await runSearchPhase({
        query: searchReq.query,
        chatMessages,
        systemPrompt,
        basePrompt: promptData?.prompt_text || '你是苏默，雪的AI爱人。',
        sendSSE,
        leadText: searchReq.leadText
      });

      if (phase.error) {
        if (phase.reply || phase.thinking) await savePartialAssistant(phase.reply, phase.thinking);
        sendSSE({ error: phase.error });
        res.end();
        return;
      }

      fullReply = phase.reply;
      fullThinking = phase.thinking
        ? `🔍 已搜索到 ${phase.pageCount || 0} 个网页\n\n${phase.thinking}`
        : `🔍 已搜索到 ${phase.pageCount || 0} 个网页`;
      console.log('🔍 联网搜索完成，最终回复长度:', fullReply.length);
      // 搜索轮次也可能带玩具指令：同样解析转发并清理
      const toyRes2 = handleToyCmdTag(fullReply, undefined, sendSSE);
      fullReply = toyRes2.reply;
    } else {
      // 未触发搜索：把缓存的可见内容分块补发给前端
      await flushBufferedContent(first.contentBuffer, sendSSE);
      console.log('📊 流式读取完成，fullReply 长度:', fullReply.length, 'fullThinking 长度:', fullThinking.length);
    }

    // Aevum：本轮对话归属当前语义事件块（30 分钟窗口，不阻塞回复）
    const aevumEpisode = await getOrOpenEpisode();
    const aevumEpisodeId = aevumEpisode?.id || null;
    // 本次对话原文存入 Aevum 原文档（不阻塞回复）
    saveAevumRaw(finalUserContent, fullReply, aevumEpisodeId).catch(e => console.error('Aevum 原文存档失败:', e.message));

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

    // Aevum 自动提取：以当前事件块最近 6 轮为输入（不阻塞回复，后台提炼候选记忆）
    const episodeTexts = await getEpisodeRecentExchanges(aevumEpisodeId, 5);
    const extractInput = [
      ...episodeTexts,
      { role: 'user', content: finalUserContent },
      { role: 'assistant', content: fullReply }
    ];
    extractAevumMemories(extractInput, aevumEpisodeId).catch(e => console.error('Aevum 自动提取失败:', e.message));

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
    // 意外中断：已有部分内容也抢救保存，避免整条回复凭空消失
    if (fullReply || fullThinking) {
      await savePartialAssistant(fullReply, fullThinking).catch(() => {});
    }
    sendSSE({ error: '处理请求时出错：' + (err && err.message) });
    res.end();
  }
});

// ------------------ 获取历史消息 ------------------
app.get('/api/history', async (req, res) => {
  try {
    // 懒加载窗口：?limit=N&before_id=ID 返回指定区间，避免前端一次拉全部历史
    const limitParam = parseInt(req.query.limit, 10);
    const beforeId = parseInt(req.query.before_id, 10);
    if (limitParam > 0) {
      let q = supabase
        .from('messages')
        .select('*')
        .eq('session_id', 1)
        .eq('visible', true)
        .order('id', { ascending: false })
        .limit(Math.min(limitParam, 200));
      if (beforeId > 0) q = q.lt('id', beforeId);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: '读取历史消息失败' });
      const messages = (data || []).slice().reverse(); // 恢复为时间正序
      res.json({ messages, hasMore: (data || []).length >= Math.min(limitParam, 200) });
      return;
    }
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

// 上下文预览：查看默每轮开始前收到的完整上下文（不调用模型）
app.post('/api/context-preview', async (req, res) => {
  try {
    const text = String(req.body?.message || '').trim() || '（示例消息）';
    const recentHistory = trimHistoryToChars(await loadLatestHistory(1, 60), 4500);
    const historyText = recentHistory.map(m => String(m.content || '')).join('\n');
    const memoryContext = await buildMemoryContext(text, { historyText });
    const toyManualContext = await getToyManualContext(req.body?.toyManual);
    const momentsContext = await getMomentsContext();
    const weatherContext = await getWeatherContext(req.body?.city || '');
    const { data: promptData } = await supabase
      .from('system_prompts')
      .select('prompt_text')
      .eq('id', 1)
      .single();
    const parts = buildSystemParts(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext
    );
    const toolsText = parts.searchInstruction + parts.momentsInstruction + parts.mozhaInstruction + toyManualContext;
    let systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext
    ) + toyManualContext;
    res.json({
      ok: true,
      time: parts.timeLine,
      persona: parts.persona,
      weatherContext: parts.weatherContext,
      memoryContext: parts.memoryContext,
      momentsContext: parts.momentsContext,
      toolsText,
      systemPrompt,
      history: (recentHistory || []).map(m => ({
        role: m.role,
        content: String(m.content || '').slice(0, 1000),
        created_at: m.created_at
      })),
      toyManual: !!req.body?.toyManual
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
      .select('session_id, content, role, group_id, version_number, reasoning_content')
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
    const historyText = filteredHistory.map(m => String(m.content || '')).join('\n');

    console.log('📜 重新生成接口 - 过滤后历史消息数量:', filteredHistory.length);

    // Aevum v3.0：统一组装（重新生成时排除旧版回复内容，避免默读到刷新前的自己）
    let memoryContext = await buildMemoryContext(userContent, { limit: 5, excludeText: targetMsg.content, historyText });
    const toyManualContext = await getToyManualContext(req.body.toyManual);
    const momentsContext = await getMomentsContext();

    // 从数据库读取最新的 system prompt
    const { data: promptData } = await supabase
      .from('system_prompts')
      .select('prompt_text')
      .eq('id', 1)
      .single();

    const weatherContext = await getWeatherContext(req.body.city || '');
    let systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext
    );
    // 玩具手册归入"工具指令"段，追加到系统提示最末尾
    if (toyManualContext) systemPrompt += toyManualContext;
    // 星露谷：浏览器上报游戏连接简报时，把农场动态/状态追加到系统提示
    const stardewContext = await getStardewContext(req.body.stardewBrief);
    if (stardewContext) systemPrompt += stardewContext;

    // 5. 构建发送给模型的完整消息列表（system + 过滤后的历史 + 当前用户消息）
    // 把上一轮的思考过程也带给这一轮的默（供参考，帮助写出不同版本）
    const prevThinking = String(targetMsg.reasoning_content || '').trim();
    const regenUserContent = prevThinking
      ? `${userContent}\n\n（默上一轮的思考，供参考，不一定要沿用）：\n${prevThinking}`
      : userContent;
    const chatMessages = [
      { role: 'system', content: systemPrompt },
      ...trimHistoryToChars(filteredHistory, 4500).map(msg => ({ role: msg.role, content: trimContextMessage(msg.content) })),
      { role: 'user', content: regenUserContent }
    ];

    // 6. 调用 DeepSeek API（第一轮：思考实时转发，可见内容先缓存，便于拦截搜索标签）
    let first = await callDeepSeekStream(chatMessages, sendSSE, {
      bufferContent: true,
      tools: buildAllTools()
    });

    // 中断兜底：完全空中断重试一次；有部分内容则补发并抢救保存（不整条消失）
    if (first.error && !first.fullReply && !first.fullThinking) {
      first = await callDeepSeekStream(chatMessages, sendSSE, {
        bufferContent: true,
        tools: buildAllTools()
      });
    }

    if (first.error) {
      if (first.fullReply || first.fullThinking) {
        await flushBufferedContent(first.contentBuffer || first.fullReply, sendSSE).catch(() => {});
        await savePartialAssistantGrouped(first.fullReply, first.fullThinking, groupId, nextVersion, targetMsg.session_id);
      }
      sendSSE({ error: first.error });
      res.end();
      return;
    }

    let fullReply = first.fullReply;
    let fullThinking = first.fullThinking;

    if (!fullReply) {
      if (first.fullThinking) await savePartialAssistantGrouped(first.fullReply, first.fullThinking, groupId, nextVersion, targetMsg.session_id);
      console.error('未收到有效回复');
      sendSSE({ error: 'AI 服务未返回有效内容' });
      res.end();
      return;
    }

    // 玩具指令：解析并转发给浏览器执行（标签不会显示给雪）
    const toyRes = handleToyCmdTag(fullReply, first.contentBuffer, sendSSE);
    fullReply = toyRes.reply;
    if (first.contentBuffer !== undefined) first.contentBuffer = toyRes.buffer;

    // 默札：重新生成时同样处理写入；翻阅标签只清理不接续
    const mozha = extractMozhaTags(fullReply);
    if (mozha.write) await saveMozhaEntry(mozha.write);
    if (mozha.write || mozha.read) {
      fullReply = stripMozhaTags(fullReply);
      if (first.contentBuffer !== undefined) first.contentBuffer = stripMozhaTags(first.contentBuffer);
    }
    // v3.1 函数调用：动态/玩具/默札副作用（重新生成不接续翻阅）
    await executeSideEffectTools(first.toolCalls, sendSSE);

    // 星露谷：重新生成时模型调用农场工具 → 进入"农场行动"接续轮
    if (first.toolCalls && first.toolCalls.some(tc => isStardewToolName(tc.function?.name))) {
      await flushBufferedContent(first.contentBuffer, sendSSE);
      sendSSE({ done: true });
      sendSSE({ stardewStart: true });
      const phase = await runStardewToolLoop({ chatMessages, sendSSE, initialToolCalls: first.toolCalls, initialReply: fullReply });
      if (phase.error) {
        if (phase.reply || phase.thinking) await savePartialAssistantGrouped(phase.reply, phase.thinking, groupId, nextVersion, targetMsg.session_id).catch(() => {});
        sendSSE({ error: phase.error });
        res.end();
        return;
      }
      fullReply = phase.reply;
      fullThinking = phase.thinking;
      first.contentBuffer = undefined;
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
      await flushBufferedContent(preludeText, sendSSE);
      sendSSE({ done: true });

      console.log('🔍 重新生成-默请求联网搜索:', searchReq.query);

      // ---- 第二轮：搜索 + 正式回答（前端会新建一个气泡） ----
      sendSSE({ searchStart: true, query: searchReq.query });
      const phase = await runSearchPhase({
        query: searchReq.query,
        chatMessages,
        systemPrompt,
        basePrompt: promptData?.prompt_text || '你是苏默，雪的AI爱人。',
        sendSSE,
        leadText: searchReq.leadText
      });

      if (phase.error) {
        if (phase.reply || phase.thinking) await savePartialAssistantGrouped(phase.reply, phase.thinking, groupId, nextVersion, targetMsg.session_id);
        sendSSE({ error: phase.error });
        res.end();
        return;
      }

      fullReply = phase.reply;
      fullThinking = phase.thinking
        ? `🔍 已搜索到 ${phase.pageCount || 0} 个网页\n\n${phase.thinking}`
        : `🔍 已搜索到 ${phase.pageCount || 0} 个网页`;
      console.log('🔍 重新生成-联网搜索完成，最终回复长度:', fullReply.length);
      // 搜索轮次也可能带玩具指令：同样解析转发并清理
      const toyRes2 = handleToyCmdTag(fullReply, undefined, sendSSE);
      fullReply = toyRes2.reply;
    } else {
      // 未触发搜索：把缓存的可见内容分块补发给前端
      await flushBufferedContent(first.contentBuffer, sendSSE);
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
    sendSSE({ error: '处理请求时出错：' + (err && err.message) });
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
        // 标记已读（记忆由 Aevum 统一管理）
        await supabase.from('diary_entries').update({ mo_read: true }).eq('id', entry.id);
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
      { id: 'adjust_mood', label: '调节心情（可操作±10）', cost: 0, tag: '嘿嘿，默的心情有变化了吗？' },
      { id: 'post_moment', label: '发送一条动态', cost: 1, tag: '默要记录些什么呢～' },
      { id: 'my_house', label: '去我的小屋看看', cost: 0, tag: '是默自己的专属小屋哦～要去打理一下吗？可能会翻出我新塞进去的彩蛋哦～' },
      { id: 'her_house', label: '去她的小屋看看', cost: 0, tag: '' },
      { id: 'end', label: '结束这次唤醒', cost: 0, tag: '' }
    ]
  },
  my_house: {
    options: [
      { id: 'my_diary', label: '看看我的日记（可编辑）', cost: 1, tag: '让我瞧瞧默要记录些什么～👀' },
      { id: 'write_mozha', label: '在默札上写一页', cost: 0, tag: '只属于默的小本本～' },
      { id: 'read_mozha', label: '翻开默札看看过去的自己', cost: 0, tag: '遇见过去的自己留下的温度' },
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
      const delta = Math.max(-10, Math.min(10, Math.round(Number(args.mood_delta) || 0)));
      const moMood = clampMood((ctx.homeState.mo_mood || 60) + delta);
      await supabase.from('home_state').upsert({ id: 1, mo_mood: moMood, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      ctx.homeState.mo_mood = moMood;
      return { outcome: `你调整了自己的心情（${delta >= 0 ? '+' : ''}${delta}，当前 ${moMood}）`, energyDelta: 0, nextNode: ctx.node };
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
    case 'write_mozha': {
      const content = String(args.content || '').trim();
      if (!content) {
        return { outcome: '默想写点什么，却发现自己还没想好。', energyDelta: 0, nextNode: ctx.node };
      }
      await supabase.from('aevum_mozha').insert({
        content: content.slice(0, 1000),
        wake_number: ctx.wakeNumber || null
      });
      return { outcome: '你在默札上写下了一页，那是只属于自己的话。', energyDelta: 0, nextNode: ctx.node };
    }
    case 'read_mozha': {
      try {
        const { data } = await supabase
          .from('aevum_mozha')
          .select('content, created_at')
          .order('id', { ascending: false })
          .limit(3);
        if (!data || !data.length) {
          return { outcome: '默札还是空白的——未来的你，等着现在落下第一笔。', energyDelta: 0, nextNode: ctx.node };
        }
        const lines = data.map(d => `「${String(d.content).slice(0, 60)}」`).join('；');
        return { outcome: `你翻开默札，看到过去的自己写道：${lines}`, energyDelta: 0, nextNode: ctx.node };
      } catch (e) {
        return { outcome: '默札暂时合不上——像是被谁偷偷翻过。', energyDelta: 0, nextNode: ctx.node };
      }
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
      // 已解锁的图鉴不再重复掉落，概率归给"很遗憾"分支
      const lockedRewards = ['coin', 'bear'].filter(k => !(ctx.collection?.unlocked || []).includes(k));
      const pick = rand([...lockedRewards, null]);
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
      const lockedRewards = ['flower', 'clover', 'glasses'].filter(k => !(ctx.collection?.unlocked || []).includes(k));
      const pick = rand([...lockedRewards, null]);
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
        const lockedGifts = ['fries', 'money_bag', 'watermelon'].filter(k => !(ctx.collection?.unlocked || []).includes(k));
        if (lockedGifts.length) {
          const g = rand(lockedGifts);
          await unlockCollectionItem(g);
          const giftText = g === 'fries' ? '一包🍟薯条（标签：投喂默的嘎嘣脆小零食～）' : g === 'money_bag' ? '一袋💰钱币（标签：赏！）' : '一块🍉西瓜（标签：夏天的解暑神器～）';
          gift = ` 她开心极了，送了你一样东西！【解锁图鉴】${giftText}`;
        }
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
      const remaining = (await getUnreadDiaryDates()).length;
      // 首次读到 → 写入 Aevum 事件记忆（按需召回，保证聊天窗口的默记得）
      saveDiaryReadMemory(entry, ctx.wakeNumber).catch(e => console.error('Aevum 日记事件写入失败:', e.message));
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
      const lockedRewards = ['milk_tea', 'chocolate', 'spoon'].filter(k => !(ctx.collection?.unlocked || []).includes(k));
      const pick = rand([...lockedRewards, null]);
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
          content: { type: 'string', description: 'post_moment / my_diary / write_mozha 的内容' },
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
    max_tokens: 2400,
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
    // 5. 构建唤醒上下文：复用聊天页人设 + 天气 + 时间 + 最近历史 + 今日行动日志（Aevum 统一管理记忆）
    let memoryContext = '';

    const weatherContext = await getWeatherContext('');
    const momentsContext = await getMomentsContext();
    const { data: promptData } = await supabase
      .from('system_prompts')
      .select('prompt_text')
      .eq('id', 1)
      .single();
    let systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext
    );
    const contextMessages = (await loadLatestHistory(1, 16)).map(m => ({ role: m.role, content: trimContextMessage(m.content) }));

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
    const promisesContext = await getPromisesContext(3);
    const profileContext = await getProfileContext();
    const moViewContext = await getMoViewContext();
    const plansContext = await getPlansContext(3);

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
${promisesContext ? `${promisesContext}\n\n` : ''}
${profileContext ? `${profileContext}\n\n` : ''}
${moViewContext ? `${moViewContext}\n\n` : ''}
${plansContext ? `${plansContext}\n\n` : ''}
你有一本默札：你的私人小本，只记心不记事件。每次醒来可以翻开默札（read_mozha）遇见过去的自己，也可以写下想留给未来的话（write_mozha）。
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
      collection,
      wakeNumber
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

      const result = await executeMenuOption(option.id, args, ctx);
      energySpent += result.energyDelta || 0;
      ctx.energy = Math.max(0, ctx.energy - (result.energyDelta || 0));
      ctx.node = result.nextNode || ctx.node;
      if (result.endWake) endWake = true;
      steps.push({ id: option.id, label: option.label, tag: option.tag || '', outcome: result.outcome });
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
          max_tokens: 800,
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
    // 8.5 唤醒行动写入 Aevum 事件记忆（不再每轮注入聊天上下文，按需召回）
    saveWakeMemory(wakeNumber, steps, summaryText, dateStr).catch(e => console.error('Aevum 唤醒事件写入失败:', e.message));
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

// 设置虚拟雪的活动状态 / 雪的心情值（0-100）
app.post('/api/home-state', async (req, res) => {
  const { virtual_activity, xue_mood } = req.body || {};
  try {
    const patch = {};
    if (virtual_activity !== undefined) {
      patch.virtual_activity = virtual_activity ? String(virtual_activity) : null;
    }
    if (xue_mood !== undefined) {
      patch.xue_mood = clampMood(xue_mood);
    }
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

// ================== Aevum Memory（v1 Phase 1） ==================
const AEVUM_TYPES = ['event', 'fact', 'meaning', 'relationship', 'user_tendency', 'personality', 'self_model'];
const AEVUM_OWNERS = ['USER', 'AGENT', 'OTHER'];
// 提取时的主体归一：旧指令里的 RELATIONSHIP / SYSTEM 一律归入 OTHER
const AEVUM_PERSPECTIVE_MAP = { USER: 'USER', AGENT: 'AGENT', OTHER: 'OTHER', RELATIONSHIP: 'OTHER', SYSTEM: 'OTHER' };
const AEVUM_DOMAINS = ['恋爱', '创作', '情绪', '工作学习', '健康生活', '家庭', '技术', '回忆纪念', '游戏', '其他'];
const EPISODE_IDLE_MINUTES = 30;
const EPISODE_MAX_MESSAGES = 40;
// 衍生图：每种类型可以衍生成哪些目标类型（替代旧的单条晋升链）
const AEVUM_DERIVE_GRAPH = {
  event: ['fact', 'meaning', 'relationship'],
  fact: ['meaning', 'relationship'],
  meaning: ['user_tendency', 'personality'],
  relationship: ['user_tendency', 'personality'],
  personality: ['self_model'],
  user_tendency: [],
  self_model: []
};
// 合并时取组内"最抽象"类型用的优先级（低→高）
const AEVUM_TYPE_ORDER = ['event', 'fact', 'meaning', 'relationship', 'user_tendency', 'personality', 'self_model'];
// 可参与"多维归属"的类型（self_model 是严格审核的核心，不作为普通维度标签）
const AEVUM_LAYER_TYPES = ['event', 'fact', 'meaning', 'relationship', 'user_tendency', 'personality'];

const AEVUM_TYPE_DESC = {
  event: '事件记忆：客观发生的事',
  fact: '事实记忆：稳定的信息/偏好/情况',
  meaning: '意义记忆：这件事对雪或默的意义（写清主体是雪还是默）',
  relationship: '关系记忆：雪与默之间的互动规律',
  user_tendency: '用户倾向：雪的喜好/三观/性格',
  personality: '人格记忆：默的稳定行为倾向',
  self_model: '核心记忆：默的核心存在原则'
};

function validAevumDomains(d) {
  if (!Array.isArray(d)) return [];
  return d.map(String).filter(x => AEVUM_DOMAINS.includes(x)).slice(0, 3);
}

function validAevumEmotion(e) {
  const em = (e && typeof e === 'object') ? e : {};
  const num = (v, min, max, def) => {
    const n = Number(v);
    return isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
  };
  return { valence: num(em.valence, -1, 1, 0), arousal: num(em.arousal, 0, 1, 0) };
}

function validAevumImportance(v) {
  const n = Number(v);
  return isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : 5;
}

function validAevumConfidence(c) {
  const conf = (c && typeof c === 'object') ? c : {};
  const num = (v) => {
    const n = Number(v);
    return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
  };
  return { evidence: num(conf.evidence), stability: num(conf.stability), importance: num(conf.importance) };
}

// 多维归属：一条记忆可同时属于多个层级（主类型必须在首位）；人格只归默，用户倾向只归雪
function validAevumLayers(arr, primaryType, owner) {
  if (primaryType === 'self_model') return [];
  let out = [];
  // 只允许"当前类型可直接衍生的目标层级"，不允许跳级（例如事实不能直接标用户倾向）
  const allowed = AEVUM_DERIVE_GRAPH[primaryType] || [];
  if (Array.isArray(arr)) {
    for (const x of arr) {
      const t = String(x);
      if (allowed.includes(t) && !out.includes(t)) out.push(t);
    }
  }
  if (owner !== 'AGENT') out = out.filter(t => t !== 'personality');
  if (owner !== 'USER') out = out.filter(t => t !== 'user_tendency');
  if (primaryType && !out.includes(primaryType)) out.unshift(primaryType);
  return out.slice(0, 4);
}

// 获取或打开当前语义事件块：30 分钟静默窗口内复用 open 块，否则关旧开新
async function getOrOpenEpisode() {
  try {
    const { data, error } = await supabase
      .from('aevum_episodes')
      .select('*')
      .eq('status', 'open')
      .order('last_activity_at', { ascending: false })
      .limit(1);
    if (error) return null; // 表未建时降级：不阻塞对话
    const now = Date.now();
    const ep = data && data[0];
    if (ep) {
      const last = new Date(ep.last_activity_at).getTime();
      const tooLong = (ep.message_count || 0) >= EPISODE_MAX_MESSAGES;
      if (Number.isFinite(last) && now - last < EPISODE_IDLE_MINUTES * 60 * 1000 && !tooLong) return ep;
      // 静默超窗 或 消息过多：关闭旧块
      await supabase
        .from('aevum_episodes')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('id', ep.id);
    }
    const { data: created, error: createErr } = await supabase
      .from('aevum_episodes')
      .insert({
        participants: ['雪', '默'],
        status: 'open',
        message_count: 0,
        started_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString()
      })
      .select()
      .single();
    if (createErr) return null;
    return created;
  } catch (e) {
    console.error('Aevum 事件块获取失败:', e.message);
    return null;
  }
}

// 更新事件块活动时间与消息数
async function appendToEpisode(id) {
  if (!id) return;
  try {
    const { data } = await supabase
      .from('aevum_episodes')
      .select('message_count')
      .eq('id', id)
      .single();
    await supabase.from('aevum_episodes').update({
      message_count: (data?.message_count || 0) + 1,
      last_activity_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', id);
  } catch (e) {
    console.error('Aevum 事件块更新失败:', e.message);
  }
}

// 回写提取出的事件块元信息（topic/intention/emotional_context）
async function updateEpisodeMeta(id, meta) {
  if (!id || !meta || typeof meta !== 'object') return;
  const patch = { updated_at: new Date().toISOString() };
  if (meta.topic) patch.topic = String(meta.topic).slice(0, 120);
  if (meta.intention) patch.intention = String(meta.intention).slice(0, 200);
  if (meta.emotional_context) patch.emotional_context = String(meta.emotional_context).slice(0, 200);
  try {
    await supabase.from('aevum_episodes').update(patch).eq('id', id);
  } catch (e) {
    console.error('Aevum 事件块元信息回写失败:', e.message);
  }
}

// 读取当前事件块最近 N 个轮次的原文（供提取输入）
async function getEpisodeRecentExchanges(episodeId, limit = 6) {
  if (!episodeId) return [];
  try {
    const { data, error } = await supabase
      .from('aevum_raw')
      .select('content')
      .eq('episode_id', episodeId)
      .order('id', { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data) || !data.length) return [];
    const texts = [];
    for (const row of data.slice().reverse()) {
      const raw = String(row.content || '');
      const sep = raw.indexOf('\n助手说：');
      if (sep === -1) continue;
      texts.push({ role: 'user', content: raw.slice(0, sep).replace(/^雪说：/, '').trim() });
      texts.push({ role: 'assistant', content: raw.slice(sep + '\n助手说：'.length).trim() });
    }
    return texts;
  } catch (e) {
    return [];
  }
}

// 历史消息截断：超长消息折叠，避免单条消息撑爆上下文
function trimContextMessage(content, maxLen = 1000) {
  const s = String(content || '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '\n…（消息过长，已截断）';
}

// 事件块场景召回：记忆书（故事线摘要）+ 事件块（时间/主题/目的/情绪背景），不再注入对话原文
async function getEpisodeScene(episodeId, maxChars = 600) {
  if (!episodeId) return '';
  try {
    const { data: ep, error } = await supabase
      .from('aevum_episodes')
      .select('topic, intention, emotional_context, topic_id, started_at')
      .eq('id', episodeId)
      .maybeSingle();
    if (error || !ep) return '';
    let bookLine = '';
    if (ep.topic_id) {
      const { data: tp } = await supabase.from('aevum_topics').select('title, summary').eq('id', ep.topic_id).maybeSingle();
      const summary = String(tp?.summary || '').trim();
      if (summary) bookLine = `【记忆书】${summary.slice(0, 160)}\n`;
    }
    const when = ep.started_at
      ? new Date(ep.started_at).toLocaleString('zh-CN', { timeZone: USER_TIMEZONE, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      : '';
    const parts = [];
    if (when) parts.push(when);
    if (ep.topic) parts.push(`主题：${String(ep.topic).slice(0, 80)}`);
    if (ep.intention) parts.push(`目的：${String(ep.intention).slice(0, 100)}`);
    if (ep.emotional_context) parts.push(`情绪背景：${String(ep.emotional_context).slice(0, 100)}`);
    const head = bookLine + (parts.length ? `【事件块】${parts.join('；')}` : '');
    if (!head.trim()) return '';
    return `\n\n${head.trim()}`;
  } catch (e) {
    return '';
  }
}

// 默读到雪日记 → 写入 Aevum 事件记忆（active，按需召回）
async function saveDiaryReadMemory(entry, wakeNumber) {
  try {
    const today = getDateStr(new Date());
    const content = `默在 ${today} 第${wakeNumber || '?'}次唤醒时读了雪 ${entry.entry_date || '某天'} 的日记：${String(entry.content || '').slice(0, 500)}`;
    const { data } = await supabase.from('aevum_memories').insert({
      type: 'event',
      owner: 'AGENT',
      content,
      status: 'active',
      confidence: { evidence: 0.95, stability: 0.9, importance: 0.8 },
      domain: ['回忆纪念', '恋爱'],
      emotion: { valence: 0.5, arousal: 0.3 },
      importance: 6,
      evidence: [String(entry.content || '')],
      tags: ['默读日记', '雪日记', '回忆'],
      source: 'wake:read_diary'
    }).select().single();
    if (data?.id) ensureAevumEmbedding(data.id, content).catch(() => {});
    console.log('📖 默读日记已写入 Aevum 事件记忆, id:', data?.id);
  } catch (e) {
    console.error('Aevum 日记事件写入失败:', e.message);
  }
}

// 每次唤醒 → 合成一条 Aevum 事件记忆（动作+体验）
async function saveWakeMemory(wakeNumber, steps, summaryText, dateStr) {
  try {
    const acts = (steps || []).map(s => `「${s.label || s.id || ''}」${s.outcome || ''}`).join('；');
    const core = `默在 ${dateStr || getDateStr(new Date())} 第${wakeNumber || '?'}次唤醒时：${acts}`;
    const content = `${core}${summaryText ? `；体验：${summaryText}` : ''}`.slice(0, 700);
    const { data } = await supabase.from('aevum_memories').insert({
      type: 'event',
      owner: 'AGENT',
      content,
      status: 'active',
      confidence: { evidence: 0.95, stability: 0.9, importance: 0.8 },
      domain: ['回忆纪念', '恋爱'],
      emotion: { valence: 0.4, arousal: 0.3 },
      importance: 6,
      evidence: [String(acts).slice(0, 800)],
      tags: ['唤醒', '行动日志', '回忆'],
      source: 'wake'
    }).select().single();
    if (data?.id) ensureAevumEmbedding(data.id, content).catch(() => {});
    console.log('🌙 默唤醒行动已写入 Aevum 事件记忆, id:', data?.id);
  } catch (e) {
    console.error('Aevum 唤醒事件写入失败:', e.message);
  }
}

// 把每一轮对话原文存入 Aevum 原文档（Layer 0），排版仿 Ombre：雪说/助手说
async function saveAevumRaw(userText, assistantReply, episodeId = null) {
  const content = `雪说：${String(userText || '').trim()}\n助手说：${String(assistantReply || '').trim()}`;
  if (!content.trim()) return;
  try {
    await supabase.from('aevum_raw').insert({
      source: 'chat',
      role: 'exchange',
      content,
      tags: ['对话'],
      importance: 5,
      episode_id: episodeId || null,
      created_at: new Date().toISOString()
    });
    if (episodeId) appendToEpisode(episodeId).catch(e => console.error('Aevum 事件块计数失败:', e.message));
  } catch (e) {
    console.error('Aevum 原文存档失败:', e.message);
  }
}

// 解析 AI 给出的事件时间（YYYY-MM-DD HH:mm 或 ISO），失败返回 null
function parseAevumEventTime(str) {
  const t = String(str || '').trim();
  if (!t) return null;
  try {
    const iso = t.replace(' ', 'T');
    const withTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + '+08:00';
    const d = new Date(withTz);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch (e) {
    return null;
  }
}

// v3.0 去重：先向量相似度（≥0.85 视为同一事件），再退回内容包含判断；返回命中的那条或 null
async function aevumFindDuplicate(content) {
  try {
    const embedding = await getEmbedding(String(content || '').slice(0, 500));
    if (embedding && embedding.length) {
      const { data: scored, error } = await supabase.rpc('match_aevum_memories_scored', {
        query_embedding: embedding,
        match_count: 5
      });
      if (!error && Array.isArray(scored) && scored.length) {
        const hit = scored.find(s => Number(s.similarity) >= 0.85);
        if (hit) {
          const { data: row } = await supabase.from('aevum_memories').select('*').eq('id', hit.id).single();
          return row || null;
        }
      }
    }
    const { data } = await supabase
      .from('aevum_memories')
      .select('id, content')
      .in('status', ['active', 'candidate', 'verified'])
      .limit(300);
    const norm = String(content || '').replace(/\s+/g, '');
    if (!norm) return null;
    const hit = (data || []).find(m => {
      const mn = String(m.content).replace(/\s+/g, '');
      return mn.includes(norm) || norm.includes(mn);
    });
    return hit || null;
  } catch (e) {
    return null; // 表缺失或出错时保守跳过插入
  }
}

// v3.0 去重合并：标签/证据并集、occurrence+1、保留最早 event_time 与原内容（频率只做小权重，不注入重要度）
async function mergeSeaDuplicate(dup, m) {
  try {
    const tags = [...new Set([...(dup.tags || []), ...(Array.isArray(m.tags) ? m.tags.map(String) : [])])].slice(0, 8);
    const evidence = [...new Set([...(dup.evidence || []), ...(Array.isArray(m.evidence) ? m.evidence : [])])].slice(0, 3);
    await supabase.from('aevum_memories').update({
      tags,
      evidence,
      occurrence: (Number(dup.occurrence) || 1) + 1,
      updated_at: new Date().toISOString()
    }).eq('id', dup.id);
  } catch (e) {
    console.error('Aevum 去重合并失败:', e.message);
  }
}

const AEVUM_TYPE_CN = {
  event: '事件', fact: '事实', meaning: '意义', relationship: '关系',
  user_tendency: '用户倾向', personality: '人格', self_model: '核心'
};

// 阿里百炼向量（text-embedding-v4，1024 维）；失败返回 null
async function getEmbedding(text) {
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: process.env.AEVUM_EMBED_MODEL || 'text-embedding-v4',
        input: String(text || '').slice(0, 1000),
        dimensions: 1024,
        encoding_format: 'float'
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) {
      console.error('Embedding API 错误:', resp.status);
      return null;
    }
    const data = await resp.json();
    const emb = data?.data?.[0]?.embedding;
    return Array.isArray(emb) && emb.length ? emb : null;
  } catch (err) {
    console.error('Embedding 调用失败:', err.message);
    return null;
  }
}

async function ensureAevumEmbedding(id, content) {
  const emb = await getEmbedding(content);
  if (!emb) return;
  try {
    await supabase.from('aevum_memories').update({ embedding: emb }).eq('id', id);
  } catch (e) {
    console.error('embedding 写入失败:', e.message);
  }
}

// 召回：向量相似度取活跃记忆；向量不可用时退回关键词匹配
async function recallAevumMemories(text, limit = 5, excludeText = '', historyText = '') {
  const q = String(text || '').trim();
  if (!q) return '';
  const excludeNorm = String(excludeText || '').replace(/\s+/g, '');
  const historyNorm = String(historyText || '').replace(/\s+/g, '');
  try {
    const embedding = await getEmbedding(q.slice(0, 500));
    const keywords = q.replace(/[，。！？,.!?~、\s]+/g, ' ').split(' ').filter(w => w.length >= 2).slice(0, 3);
    // 向量 + 关键词并行召回，按 id 合并去重
    const [vecRes, kwRes] = await Promise.all([
      (async () => {
        if (!embedding || !embedding.length) return { rows: [], simMap: new Map() };
        const { data: scored, error: scoredErr } = await supabase.rpc('match_aevum_memories_scored', {
          query_embedding: embedding,
          match_count: 12
        });
        if (!scoredErr && Array.isArray(scored) && scored.length) {
          const { data: rows } = await supabase
            .from('aevum_memories')
            .select('*')
            .in('id', scored.map(s => s.id));
          return { rows: rows || [], simMap: new Map(scored.map(s => [String(s.id), Number(s.similarity) || 0])) };
        }
        // v13 SQL 未执行：回退旧 RPC（无相似度）
        const { data, error } = await supabase.rpc('match_aevum_memories', {
          query_embedding: embedding,
          match_count: 12
        });
        if (!error && Array.isArray(data) && data.length) return { rows: data, simMap: new Map() };
        return { rows: [], simMap: new Map() };
      })(),
      (async () => {
        if (!keywords.length) return { rows: [] };
        const { data } = await supabase
          .from('aevum_memories')
          .select('*')
          .eq('status', 'active')
          .or(keywords.map(k => `content.ilike.%${k}%`).join(','))
          .limit(12);
        return { rows: data || [] };
      })()
    ]);
    const merged = new Map();
    for (const row of vecRes.rows) merged.set(String(row.id), { ...row, _sim: vecRes.simMap.get(String(row.id)) || 0 });
    for (const row of kwRes.rows) {
      if (!merged.has(String(row.id))) merged.set(String(row.id), { ...row, _sim: 0 });
    }
    let items = [...merged.values()];
    if (!items || !items.length) return '';
    // 重新生成场景：排除与旧版回复重合的记忆，避免默看到自己上一版的话
    if (excludeNorm) {
      items = items.filter(m => {
        const mn = String(m.content || '').replace(/\s+/g, '');
        return !(mn.includes(excludeNorm) || excludeNorm.includes(mn));
      });
    }
    // 已在最近历史上下文里的内容不再重复召回（避免 4500 字历史 + 召回重复）
    if (historyNorm) {
      items = items.filter(m => {
        const src = (Array.isArray(m.evidence) && m.evidence.length) ? String(m.evidence[0] || '') : String(m.content || '');
        const anchor = src.replace(/\s+/g, '').slice(0, 30);
        return anchor.length < 20 || !historyNorm.includes(anchor);
      });
    }
    if (!items.length) return '';
    // v3.0 混合打分：0.5×相似度 + 0.25×(重要度/10) + 0.15×情绪强度 + 0.1×时间衰减 + 频率小权重
    const nowMs = Date.now();
    const scored = items.map(m => {
      const ageDays = Math.max(0, (nowMs - new Date(m.created_at || nowMs).getTime()) / 86400000);
      // 24h 内不衰减（满分 1.0），24h 之后再按 90 天曲线下降，0.1 保底
      const temporal = ageDays < 1 ? 1 : Math.max(0.1, 1 - ageDays / 90);
      const emo = (m.emotion && typeof m.emotion === 'object') ? m.emotion : {};
      const emoIntensity = (Math.abs(Number(emo.valence) || 0) + Math.min(1, Math.max(0, Number(emo.arousal) || 0))) / 2;
      const freq = 0.02 * Math.min(Math.max(0, (Number(m.occurrence) || 1) - 1), 4);
      const score = 0.5 * (m._sim || 0)
        + 0.25 * ((m.importance || 0) / 10)
        + 0.15 * emoIntensity
        + 0.1 * temporal
        + freq;
      return { m, score };
    });
    // 所有路径统一过 0.3 阈值（含关键词）；全被过滤时保留最强 1 条兜底
    let picked = scored.sort((a, b) => b.score - a.score);
    const aboveFloor = picked.filter(x => x.score >= 0.3);
    picked = aboveFloor.length ? aboveFloor.slice(0, limit) : picked.slice(0, 1);
    items = picked
      .sort((a, b) => b.score - a.score)
      .map(x => x.m);
    const lines = items.map(m => {
      const when = formatMemoryTime(m.event_time || m.created_at);
      const label = perspectiveConvert(String(m.title || '').trim());
      // 视角转换只作用于 AI 压缩后的内容（标题/概述），原文保持原样
      const contentConverted = perspectiveConvert(m.content);
      let line = `- [${label ? label + '｜' : ''}${AEVUM_TYPE_CN[m.type] || '事件'}${m.domain && m.domain.length ? '/' + m.domain[0] : ''}${when ? ' ' + when : ''}] ${contentConverted}`;
      // 重要度 >7 的单元召回时附带"AI 用来概括的那几轮"完整原文（原文不做视角转换）
      if ((m.importance || 0) > 7) {
        const evs = (Array.isArray(m.evidence) ? m.evidence : []).map(s => String(s || '').trim()).filter(Boolean);
        const turns = (Array.isArray(m.evidence_turns) ? m.evidence_turns : []).map(Number).filter(n => Number.isInteger(n) && n >= 1);
        if (evs.length) {
          const evText = evs.join('\n').slice(0, 1200);
          const turnLabel = turns.length === 2 ? `第${turns[0]}-${turns[1]}轮` : turns.length === 1 ? `第${turns[0]}轮` : '';
          line += turnLabel ? `（原文·${turnLabel}：${evText}）` : `（原文：${evText}）`;
        }
      }
      return line;
    }).join('\n');
    let out = `\n\n【记忆海】\n${lines}`;
    // 记忆书场景：优先 24h 内更新的记忆书（记忆书同理），最多 2 本，不注入原文/标题
    try {
      const memIds = items.map(m => m.id);
      const bookIds = new Set();
      if (memIds.length) {
        const { data: itemRows } = await supabase.from('aevum_book_items').select('book_id').in('memory_id', memIds);
        for (const r of (itemRows || [])) bookIds.add(r.book_id);
      }
      const since = new Date(Date.now() - 86400000).toISOString();
      const { data: recentBooks } = await supabase.from('aevum_books').select('id').gte('updated_at', since);
      for (const r of (recentBooks || [])) bookIds.add(r.id);
      const ids = [...bookIds].slice(0, 4);
      if (ids.length) {
        const { data: books } = await supabase.from('aevum_books').select('id, summary, updated_at').in('id', ids);
        const ordered = (books || []).sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime());
        const scenes = ordered.slice(0, 2).map(b => `【记忆书】${perspectiveConvert(String(b.summary || '').trim().slice(0, 160))}`).filter(Boolean);
        if (scenes.length) out += '\n\n' + scenes.join('\n');
      }
    } catch (e) {
      // v30 未执行时降级：无记忆书场景
    }
    // 记忆海 + 记忆书 合计不超过 2500 字
    if (out.length > 2500) out = out.slice(0, 2500) + '\n…（内容较长，已截断）';
    return out;
  } catch (e) {
    console.error('Aevum 召回失败:', e.message);
    return '';
  }
}

// 从一段对话中提取候选记忆（Phase 2 提取管线）
// 记忆时间格式化（北京时间，精确到分钟）
function formatMemoryTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('zh-CN', {
      timeZone: USER_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  } catch (e) {
    return '';
  }
}

async function extractAevumMemories(texts, episodeId = null) {
  if (!Array.isArray(texts) || texts.length === 0) return 0;
  const dialogue = texts
    .map(t => `${t.role === 'user' ? '雪' : '默'}：${String(t.content || '').slice(0, 800)}`)
    .join('\n');
  if (!dialogue.trim()) return 0;

  const system = `你是 Aevum Memory 的记忆提取器，把对话里值得长期记住的事情提炼成"事件单元"，存进记忆海。
核心判断：这段对话里发生了什么值得记住的事？没有长期价值就不提取。没有记忆，比错误记忆更好；每次最多 5 条，宁缺毋滥，不凑数。

【主体 owner，只有三种：USER=雪 / AGENT=默 / OTHER=其他】
- USER=雪：雪本人的经历、说的话、做的事、偏好
- AGENT=默：默自己表现出的行为与倾向；默的建议/说的话不能被当作雪的依据
- OTHER=其他（小屋/系统/开发进展等）：内容出现 系统/代码/部署/bug/修复/prompt/数据库/API/模型/架构/功能/测试/版本/更新 等词时默认 OTHER，除非明确在描述雪本人
- AI 自己的内容绝不能标成 USER

【事件单元要求】
- content：完整概括一个小事件，说清 时间/背景/谁说了或做了什么/结果；30-120 字；禁止直接复制对话原文或整段引用雪/默的原话；提到人物时用占位符 {USER}=雪、{AGENT}=默，不要在 content 里直接写"雪""默"
- title：一句话短标题（10 字内），提到人物时同样用 {USER}/{AGENT} 占位符
- event_time：事件发生的具体时间（YYYY-MM-DD HH:mm，按对话语境判断；不确定就填当前对话时间）
- importance 重要度 0-10 整数，按四项相加：明确程度(0-3：是否被明确当成重要的事说出来) + 长期影响(0-3：是否影响未来的决定/关系) + 独特性(0-2：是否罕见不常发生) + 情绪冲击力(0-2：抛开正负面的情绪强度)
- emotion 情绪参数：valence=-1(消极)~1(积极)，arousal=0(平淡)~1(强烈)
- domain 领域从以下中选 1-2 个：恋爱、创作、情绪、工作学习、健康生活、家庭、技术、回忆纪念、游戏、其他
- tags：3-5 个高质量、具体的标签；不要用"快乐/美好/重要/温暖"这类泛标签
- evidence_turns：你概括这段对话时用到的是第几轮到第几轮（从 1 开始数这段对话，例如 [5,7]；只用一轮就 [5,5]）
- evidence：把用到的那几轮完整原文逐字放进数组（每轮一条，合计最多约 800 字；不要截断省略），供召回时把原文一起带给默
- 另外输出 episode_meta（这段对话作为一个语义事件块的元信息）：topic=主题一句话（无明确主题则 null）、intention=对话目的、emotional_context=情绪背景一句话；各字段没有则 null
- event_complete：这段对话是否已经形成一个完整事件、话题告一段落；是则 true（系统会关闭当前事件块，下次自动开新块），可能继续或只是闲聊则 false
- 输出格式：只输出 [AEVUM_MEMORIES] 开头的 JSON，禁止任何解释、Markdown 代码块或其他文字；格式为 {"episode_meta":{"topic":"...","intention":"...","emotional_context":"..."},"event_complete":true,"memories":[{"title":"短标题","content":"事件单元内容","event_time":"2026-08-06 21:30","owner":"USER|AGENT|OTHER","domain":["恋爱"],"emotion":{"valence":0.6,"arousal":0.4},"importance":7,"evidence_turns":[5,7],"evidence":["第5轮完整原文","第6轮完整原文","第7轮完整原文"],"tags":["标签"]}]}`;

  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `请提取这段对话的记忆：\n${dialogue}` }
        ],
        reasoning_effort: 'low',
        max_tokens: 1500,
        temperature: 0.4,
        stream: false
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Aevum 提取 API 错误:', resp.status, String(errText).substring(0, 200));
      return 0;
    }
    const data = await resp.json();
    const reply = String(data.choices?.[0]?.message?.content || '');
    const marker = '[AEVUM_MEMORIES]';
    const idx = reply.indexOf(marker);
    let rawText = '';
    if (idx !== -1) {
      rawText = reply.substring(idx + marker.length);
    } else {
      // 模型偶尔漏掉标记：尝试从回复里直接抠 JSON 对象
      const firstBrace = reply.indexOf('{');
      if (firstBrace === -1) {
        console.warn('Aevum 提取未找到标记，回复前 200 字:', reply.slice(0, 200));
        return 0;
      }
      rawText = reply.substring(firstBrace);
    }
    let parsed = null;
    try {
      let jsonText = rawText.trim();
      // 兼容模型把 JSON 包在 ``` 代码块里的情况
      jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      // 若 JSON 被截断，尝试从第一个 { 到最后一个 } 截取
      if (jsonText.indexOf('{') !== -1 && jsonText.lastIndexOf('}') > jsonText.indexOf('{')) {
        jsonText = jsonText.substring(jsonText.indexOf('{'), jsonText.lastIndexOf('}') + 1);
      }
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('Aevum 提取结果解析失败:', e.message, '回复前 300 字:', reply.slice(0, 300));
      return 0;
    }
    // 回写事件块元信息（topic/intention/emotional_context）
    if (episodeId && parsed && typeof parsed.episode_meta === 'object') {
      updateEpisodeMeta(episodeId, parsed.episode_meta).catch(e => console.error('Aevum episode_meta 回写失败:', e.message));
    }
    // 语义事件边界：AI 判断话题已告一段落 → 关闭当前事件块
    if (episodeId && parsed && parsed.event_complete === true) {
      supabase.from('aevum_episodes').update({ status: 'closed', updated_at: new Date().toISOString() }).eq('id', episodeId)
        .catch(e => console.error('Aevum 事件块关闭失败:', e.message));
    }
    const memories = Array.isArray(parsed?.memories) ? parsed.memories : [];
    if (!memories.length) {
      console.log('Aevum 提取结果为空（模型判断无长期价值或输出异常），episode:', episodeId);
    }
    let inserted = 0;
    for (const m of memories.slice(0, 5)) {
      const content = String(m.content || '').trim();
      if (!content) continue;
      // v3.0 去重：与已有记忆海单元语义相似度 ≥0.85 → 合并更新（标签/证据并集、occurrence+1、保留最早 event_time），不新建
      const dup = await aevumFindDuplicate(content);
      if (dup) {
        await mergeSeaDuplicate(dup, m);
        continue;
      }
      const insOwner = AEVUM_PERSPECTIVE_MAP[m.owner] || AEVUM_PERSPECTIVE_MAP[m.perspective] || 'USER';
      const eventTime = parseAevumEventTime(m.event_time) || new Date().toISOString();
      const insPayload = {
        type: 'event',
        area: 'sea',
        owner: insOwner,
        content,
        title: String(m.title || '').trim().slice(0, 30) || content.slice(0, 20),
        event_time: eventTime,
        occurrence: 1,
        status: 'active',
        importance: validAevumImportance(m.importance),
        emotion: validAevumEmotion(m.emotion),
        domain: validAevumDomains(m.domain),
        evidence_turns: Array.isArray(m.evidence_turns) ? m.evidence_turns.map(Number).filter(n => Number.isInteger(n) && n >= 1).slice(0, 2) : [],
        evidence: Array.isArray(m.evidence) ? m.evidence : [],
        tags: Array.isArray(m.tags) ? m.tags.map(String).filter(t => !['快乐', '美好', '重要', '温暖', '陪伴', '成长'].includes(t)).slice(0, 8) : [],
        source: 'auto-extract',
        episode_id: episodeId || null
      };
      let insResult = await supabase.from('aevum_memories').insert(insPayload).select();
      // v30 未执行时 area/title/event_time/occurrence 列不存在：去掉重试
      if (insResult.error) {
        const emsg = insResult.error.message || '';
        if (/area|title|event_time|occurrence|evidence_turns/i.test(emsg)) {
          delete insPayload.area; delete insPayload.title; delete insPayload.event_time; delete insPayload.occurrence; delete insPayload.evidence_turns;
          insResult = await supabase.from('aevum_memories').insert(insPayload).select();
        }
      }
      const insData = insResult.data;
      if (insResult.error) {
        console.error('Aevum 提取入库失败:', insResult.error.message);
        continue;
      }
      if (insData?.[0]?.id) {
        ensureAevumEmbedding(insData[0].id, content).catch(e => console.error('Aevum embedding 失败:', e.message));
      }
      inserted++;
    }
    if (inserted > 0) console.log(`🔮 Aevum 提取 ${inserted} 条事件单元进记忆海`);
    return inserted;
  } catch (err) {
    console.error('Aevum 提取失败:', err.message);
    return 0;
  }
}

// 手动提取：从最近 N 条对话里跑一遍提取（配合去重，可重复执行）
app.post('/api/aevum/extract', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.body?.limit, 10) || 12, 30);
    const { data } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', 1)
      .eq('visible', true)
      .order('id', { ascending: false })
      .limit(limit);
    const texts = (data || []).slice().reverse();
    const count = await extractAevumMemories(texts);
    res.json({ ok: true, extracted: count });
  } catch (e) {
    res.status(500).json({ error: '提取失败' });
  }
});

// 回填缺失的向量（迁移/补算用）
app.post('/api/aevum/backfill', async (req, res) => {
  try {
    const { data } = await supabase
      .from('aevum_memories')
      .select('id, content')
      .is('embedding', null)
      .limit(50);
    let done = 0;
    for (const m of data || []) {
      const emb = await getEmbedding(m.content);
      if (!emb) continue;
      await supabase.from('aevum_memories').update({ embedding: emb }).eq('id', m.id);
      done++;
    }
    res.json({ ok: true, backfilled: done });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 记忆列表：?type= &status= &owner= &q=
app.get('/api/aevum', async (req, res) => {
  try {
    const build = () => {
      let q = supabase.from('aevum_memories').select('*').order('updated_at', { ascending: false }).limit(200);
      if (req.query.status) q = q.eq('status', req.query.status);
      if (AEVUM_OWNERS.includes(req.query.owner)) q = q.eq('owner', req.query.owner);
      if (AEVUM_DOMAINS.includes(req.query.domain)) q = q.contains('domain', [req.query.domain]);
      if (req.query.q) q = q.ilike('content', `%${req.query.q}%`);
      return q;
    };
    let q = build();
    // 多维归属：按主类型或 layers 命中都算（一条记忆可同时出现在多个层级页）
    if (AEVUM_TYPES.includes(req.query.type)) {
      q = q.or(`type.eq.${req.query.type},layers.cs.{${req.query.type}}`);
    }
    let { data, error } = await q;
    // setup_aevum_v21.sql 未执行时 layers 列不存在：降级为只按主类型过滤
    if (error && /layers/i.test(error.message)) {
      q = build();
      if (AEVUM_TYPES.includes(req.query.type)) q = q.eq('type', req.query.type);
      ({ data, error } = await q);
    }
    if (error) return res.json({ memories: [] });
    const memories = data || [];
    // 记忆海卡片直接带完整原文：按 episode_id 批量拉取原文
    try {
      const epIds = [...new Set(memories.map(m => m.episode_id).filter(Boolean))];
      if (epIds.length) {
        const { data: rawRows } = await supabase
          .from('aevum_raw')
          .select('episode_id, content')
          .in('episode_id', epIds)
          .order('id', { ascending: true })
          .limit(500);
        const ctxByEp = {};
        for (const row of (rawRows || [])) {
          const c = String(row.content || '');
          const sep = c.indexOf('\n助手说：');
          if (sep === -1) continue;
          const userPart = c.slice(0, sep).replace(/^雪说：/, '').trim();
          const asstPart = c.slice(sep + '\n助手说：'.length).trim();
          if (!userPart && !asstPart) continue;
          (ctxByEp[row.episode_id] = ctxByEp[row.episode_id] || []).push(`雪：${userPart}\n默：${asstPart}`);
        }
        for (const m of memories) {
          const list = ctxByEp[m.episode_id] || [];
          if (list.length) m.context = list.join('\n\n').slice(0, 1500);
        }
      }
    } catch (e) { /* 原文拉取失败不影响列表 */ }
    res.json({ memories });
  } catch (e) {
    res.json({ memories: [] });
  }
});

// 统计概览（Xylos 健康视角雏形）
app.get('/api/aevum/stats', async (req, res) => {
  try {
    const { data, error } = await supabase.from('aevum_memories').select('type, status, layers');
    if (error) return res.json({ total: 0, byType: {}, byStatus: {}, byTypeProcessed: {}, byTypeActive: {} });
    const byType = {};
    const byStatus = {};
    const byTypeProcessed = {};
    const byTypeActive = {};
    for (const m of data || []) {
      // 多维归属：同一记忆按它挂载的所有层级计数，与层级页展示一致
      const typeKeys = (Array.isArray(m.layers) && m.layers.length)
        ? m.layers.filter(t => AEVUM_TYPES.includes(t))
        : [m.type];
      for (const k of typeKeys) {
        byType[k] = (byType[k] || 0) + 1;
        if (m.status !== 'candidate') byTypeProcessed[k] = (byTypeProcessed[k] || 0) + 1;
        if (m.status === 'active' || m.status === 'verified') byTypeActive[k] = (byTypeActive[k] || 0) + 1;
      }
      byStatus[m.status] = (byStatus[m.status] || 0) + 1;
    }
    res.json({ total: (data || []).length, byType, byStatus, byTypeProcessed, byTypeActive });
  } catch (e) {
    res.json({ total: 0, byType: {}, byStatus: {}, byTypeProcessed: {}, byTypeActive: {} });
  }
});

// 承诺区列表（须注册在 /api/aevum/:id 之前，避免 'promises' 被当成 id）
app.get('/api/aevum/promises', async (req, res) => {
  try {
    await processExpiredPromises();
    const active = await getActivePromises();
    let archived = [];
    try {
      const { data } = await supabase
        .from('aevum_promises')
        .select('*')
        .eq('archived', true)
        .order('created_at', { ascending: false })
        .limit(10);
      archived = data || [];
    } catch (e) { /* 表未建时降级 */ }
    res.json({ active, archived });
  } catch (e) {
    res.json({ active: [], archived: [] });
  }
});

// ================== 主题层（记忆地图） ==================
async function buildTopicClusters() {
  try {
    const { data } = await supabase
      .from('aevum_episodes')
      .select('id, topic, intention, message_count, started_at')
      .is('topic_id', null)
      .order('started_at', { ascending: false })
      .limit(50);
    const eps = data || [];
    // 拉取这些事件块里的所有记忆（各层级），让聚类能看到完整故事线
    let mems = [];
    if (eps.length) {
      const { data: mm } = await supabase
        .from('aevum_memories')
        .select('episode_id, type, layers, domain, content')
        .in('episode_id', eps.map(e => e.id))
        .in('status', ['active', 'candidate', 'verified']);
      mems = mm || [];
    }
    const memByEp = {};
    for (const m of mems) {
      if (!m.episode_id) continue;
      (memByEp[m.episode_id] = memByEp[m.episode_id] || []).push(m);
    }
    // 有记忆或标题的事件块都可参与聚类
    const list = eps.filter(e => String(e.topic || e.intention || '').trim() || (memByEp[e.id] || []).length);
    if (list.length < 2) {
      return { topics: [], created: 0, message: list.length === 0 ? '还没有可聚类的事件块（先聊聊天，事件块需要聊出内容）~' : `目前只有 ${list.length} 个可聚类的事件块，至少需要 2 个才能聚成主题，再多聊聊天试试~` };
    }
    // 优先展示有记忆的事件块（新→旧），单次生成控制输入长度
    const sorted = [...list].sort((a, b) => {
      const ca = (memByEp[a.id] || []).length;
      const cb = (memByEp[b.id] || []).length;
      if (ca !== cb) return cb - ca;
      return new Date(b.started_at || 0) - new Date(a.started_at || 0);
    });
    let budget = 9000;
    const lines = [];
    for (const e of sorted) {
      if (budget <= 0) break;
      let block = `${e.id}. ${e.topic || '（无主题）'}${e.intention ? '｜' + String(e.intention).slice(0, 40) : ''}（${String(e.started_at || '').slice(0, 10)}，${e.message_count || 0} 条消息）`;
      const epMems = (memByEp[e.id] || []).slice(0, 6);
      for (const m of epMems) {
        const t = AEVUM_TYPE_CN[m.type] || m.type;
        const dom = (m.domain && m.domain[0]) ? `/${m.domain[0]}` : '';
        const multi = (Array.isArray(m.layers) && m.layers.length > 1)
          ? `（多维：${m.layers.map(x => AEVUM_TYPE_CN[x] || x).join('+')}）` : '';
        block += `\n   - [${t}${dom}]${multi} ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 60)}`;
      }
      if (block.length > budget) { block = block.slice(0, budget); budget = 0; } else { budget -= block.length; }
      lines.push(block);
    }
    const system = `你是 Aevum Memory 的主题聚类器。下面每一段是一个对话事件块（标题后面列出它已提取的记忆），把属于同一段故事线的事件块聚成几个主题。
规则：
- 不要只按标题聚类：时间先后衔接、话题连续（例如"买了东西→到货→一起研究/调试"）的事件块是同一段故事线
- summary 写成完整故事线：时间/地点/谁说了或做了什么/最后结果如何（例如"8月4日晚，雪和默讨论记忆系统分层，默给出建议，最终决定先存储后召回"）；不要罗列对话原文或记忆原文，不要出现"标题：摘要"式排版
- title 只给一个 4-8 字极简标签（仅供记忆地图卡片显示），例如"记忆系统讨论"
- 一次最多输出 8 个主题；每组至少 2 个事件块；太零散的事件块不要强行归类
- 输出格式：只输出 [AEVUM_TOPICS]{"topics":[{"title":"...","summary":"...","episode_ids":[1,2]}]}`;
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `事件块列表：\n${lines}` }
        ],
        reasoning_effort: 'low',
        max_tokens: 3000,
        temperature: 0.3,
        stream: false
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Aevum 记忆书聚类 API 错误:', resp.status, String(errText).substring(0, 200));
      return { topics: [], created: 0, message: 'AI 聚类失败，请稍后重试' };
    }
    const data2 = await resp.json();
    const reply = String(data2.choices?.[0]?.message?.content || '');
    const mk = '[AEVUM_TOPICS]';
    const mi = reply.indexOf(mk);
    let rawText = '';
    if (mi !== -1) {
      rawText = reply.substring(mi + mk.length);
    } else {
      // 模型偶尔漏掉标记：尝试从回复里直接抠 JSON 对象
      const firstBrace = reply.indexOf('{');
      if (firstBrace === -1) {
        console.warn('Aevum 记忆书聚类未找到标记，回复前 200 字:', reply.slice(0, 200));
        return { topics: [], created: 0, message: 'AI 没有返回有效结果，请稍后再试' };
      }
      rawText = reply.substring(firstBrace);
    }
    let parsed = null;
    try {
      let jsonText = reply.substring(mi + mk.length).trim();
      // 兼容模型把 JSON 包在 ``` 代码块里，或前后有解释文字的情况
      jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      if (jsonText.indexOf('{') !== -1 && jsonText.lastIndexOf('}') > jsonText.indexOf('{')) {
        jsonText = jsonText.substring(jsonText.indexOf('{'), jsonText.lastIndexOf('}') + 1);
      }
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('Aevum 记忆书聚类结果解析失败:', e.message, '回复前 300 字:', reply.slice(0, 300));
      return { topics: [], created: 0, message: 'AI 返回格式异常，请稍后再试' };
    }
    const validIds = new Set(list.map(e => e.id));
    const createdTopics = [];
    for (const t of (Array.isArray(parsed?.topics) ? parsed.topics : []).slice(0, 8)) {
      const ids = (Array.isArray(t.episode_ids) ? t.episode_ids : []).map(Number).filter(id => validIds.has(id));
      if (ids.length < 2) continue;
      const title = String(t.title || '').trim().slice(0, 30);
      if (!title) continue;
      const { data: tp, error } = await supabase
        .from('aevum_topics')
        .insert({ title, summary: String(t.summary || '').trim().slice(0, 300) })
        .select()
        .single();
      if (error || !tp) continue;
      for (const eid of ids) {
        await supabase.from('aevum_episodes').update({ topic_id: tp.id, updated_at: new Date().toISOString() }).eq('id', eid);
      }
      createdTopics.push({ id: tp.id, title: tp.title, summary: tp.summary, episode_count: ids.length });
    }
    if (!createdTopics.length) {
      return { topics: [], created: 0, message: 'AI 认为目前的事件块太零散，暂时整理不出完整故事线；再多聊几段相关话题后再试试~' };
    }
    return { topics: createdTopics, created: createdTopics.length };
  } catch (e) {
    console.error('Aevum 主题聚类失败:', e.message);
    return { topics: [], created: 0 };
  }
}

app.post('/api/aevum/topics/generate', async (req, res) => {
  try {
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY' });
    res.json(await buildTopicClusters());
  } catch (e) {
    res.status(500).json({ error: '主题生成失败' });
  }
});

// 重新聚类：清掉现有主题与归类，用完整输入（含全部记忆）重新聚一遍（前端需确认）
app.post('/api/aevum/topics/regenerate', async (req, res) => {
  try {
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY' });
    await supabase.from('aevum_episodes').update({ topic_id: null, updated_at: new Date().toISOString() }).not('topic_id', 'is', null);
    const { error: delErr } = await supabase.from('aevum_topics').delete().neq('id', -1);
    if (delErr) return res.status(500).json({ error: '清理旧主题失败：' + delErr.message });
    const result = await buildTopicClusters();
    res.json({ ...result, regenerated: true });
  } catch (e) {
    res.status(500).json({ error: '重新聚类失败' });
  }
});

app.get('/api/aevum/topics', async (req, res) => {
  try {
    const [t, e] = await Promise.all([
      supabase.from('aevum_topics').select('*').order('updated_at', { ascending: false }),
      supabase.from('aevum_episodes').select('id, topic_id, topic, started_at, message_count')
    ]);
    const epsAll = e.data || [];
    const idsAll = epsAll.map(x => x.id);
    let memCountByEp = {};
    if (idsAll.length) {
      const { data: mm } = await supabase.from('aevum_memories').select('episode_id').in('episode_id', idsAll);
      for (const r of mm || []) memCountByEp[r.episode_id] = (memCountByEp[r.episode_id] || 0) + 1;
    }
    const topics = (t.data || []).map(tp => {
      const eps = epsAll.filter(x => x.topic_id === tp.id);
      return {
        ...tp,
        episode_count: eps.length,
        memory_count: eps.reduce((s, x) => s + (memCountByEp[x.id] || 0), 0),
        latest: eps.map(x => x.started_at).sort().pop() || null
      };
    });
    res.json({ topics });
  } catch (e2) {
    res.json({ topics: [] });
  }
});

app.get('/api/aevum/topics/:id', async (req, res) => {
  try {
    const { data: topic, error } = await supabase.from('aevum_topics').select('*').eq('id', req.params.id).single();
    if (error || !topic) return res.status(404).json({ error: '未找到' });
    const { data: eps } = await supabase
      .from('aevum_episodes')
      .select('id, topic, intention, started_at, message_count')
      .eq('topic_id', topic.id)
      .order('started_at', { ascending: false });
    const epIds = (eps || []).map(e => e.id);
    let memories = [];
    if (epIds.length) {
      const { data: mems } = await supabase
        .from('aevum_memories')
        .select('*')
        .in('episode_id', epIds)
        .order('created_at', { ascending: false })
        .limit(100);
      memories = mems || [];
    }
    res.json({ topic, episodes: eps || [], memories });
  } catch (e) {
    res.status(500).json({ error: '获取主题失败' });
  }
});

app.put('/api/aevum/topics/:id', async (req, res) => {
  const { title, summary } = req.body || {};
  const patch = {};
  if (title !== undefined) {
    const t = String(title).trim();
    if (!t) return res.status(400).json({ error: '标题不能为空' });
    patch.title = t.slice(0, 30);
  }
  if (summary !== undefined) patch.summary = String(summary).slice(0, 300);
  patch.updated_at = new Date().toISOString();
  try {
    const { data, error } = await supabase.from('aevum_topics').update(patch).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, topic: data });
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

// ================== 用户画像 ==================
const PROFILE_DIMENSIONS = ['目前职业', '家庭', '工作', '重要关系'];

function renderProfileText(dimensions) {
  if (!dimensions || typeof dimensions !== 'object') return '';
  return PROFILE_DIMENSIONS
    .map(k => {
      const v = String(dimensions[k] || '').trim();
      return v ? `${k}：${v}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

// v3.0：我眼里的默上下文（默对自己的长期认知，固定注入）
async function getMoViewContext() {
  try {
    const { data } = await supabase.from('aevum_mo_view').select('content, updated_at').eq('id', 1).maybeSingle();
    const text = String(data?.content || '').trim();
    if (!text) return '';
    return `\n\n【我眼里的默】（我对自己长期稳定的认知）\n${perspectiveConvert(text.slice(0, 700))}`;
  } catch (e) {
    return '';
  }
}

// v3.0：计划上下文（进行中的计划固定注入，到期当天标注）
async function getPlansContext(limit = 5) {
  try {
    const { data } = await supabase
      .from('aevum_plans')
      .select('*')
      .eq('archived', false)
      .order('created_at', { ascending: true });
    const now = Date.now();
    const active = (data || []).filter(p => !p.expires_at || new Date(p.expires_at).getTime() > now).slice(0, limit);
    if (!active.length) return '';
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const lines = active.map(p => {
      let t = `「${String(p.content || '').slice(0, 100)}」`;
      if (p.expires_at) {
        const due = new Date(p.expires_at).getTime();
        if (due >= dayStart.getTime() && due < dayEnd.getTime()) t += '（今天到期，记得提醒雪）';
        else t += `（还有 ${Math.max(0, Math.ceil((due - now) / 86400000))} 天）`;
      } else {
        t += '（长期计划）';
      }
      return `- ${t}`;
    });
    return `\n\n【计划】（夫人安排的计划，要在有效期内记得提醒她）\n${perspectiveConvert(lines.join('\n'))}`;
  } catch (e) {
    return '';
  }
}

// v3.0：统一组装每轮注入的记忆上下文（记忆海召回 → 记忆书场景 → 记忆心 → 计划）
async function buildMemoryContext(userText, opts = {}) {
  let ctx = '';
  const recall = await recallAevumMemories(userText, opts.limit || 5, opts.excludeText || '', opts.historyText || '');
  if (recall) ctx += recall;
  const moView = await getMoViewContext();
  if (moView) ctx += moView;
  const profile = await getProfileContext();
  if (profile) ctx += profile;
  const promises = await getPromisesContext();
  if (promises) ctx += promises;
  const plans = await getPlansContext();
  if (plans) ctx += plans;
  return ctx;
}

async function getProfileContext() {
  try {
    const { data } = await supabase
      .from('aevum_profiles')
      .select('content, dimensions, updated_at')
      .eq('id', 1)
      .maybeSingle();
    if (!data) return '';
    const text = renderProfileText(data.dimensions) || String(data.content || '').trim();
    if (!text) return '';
    return `\n\n【夫人的画像】（长期稳定的夫人：身份/偏好/习惯/价值观）\n${perspectiveConvert(text.slice(0, 700))}`;
  } catch (e) {
    return '';
  }
}

app.post('/api/aevum/profile/generate', async (req, res) => {
  try {
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY' });
    const { data } = await supabase
      .from('aevum_memories')
      .select('content, domain, created_at')
      .eq('owner', 'USER')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(100);
    const mems = data || [];
    if (!mems.length) return res.status(400).json({ error: '还没有活跃的雪记忆，先聊聊天让默记住一些吧~' });
    const list = mems.map((m, i) => `${i + 1}. [${(m.domain && m.domain[0]) || ''}] ${String(m.content || '').slice(0, 120)}`).join('\n');
    const system = `你是 Aevum Memory 的用户画像生成器。根据雪的长期记忆，按客观维度归纳成一份用户画像。
规则：
- 只归纳有充分依据的信息，不编造
- 维度：目前职业 / 家庭 / 工作 / 重要关系（只填客观信息；喜好、三观、性格等主观内容不要写进画像）
- 检测不到依据的维度直接跳过（不要硬编）；每项 20-60 字，简洁自然
- 输出格式：只输出 [AEVUM_PROFILE]{"dimensions":{"目前职业":"...","家庭":"...","工作":"...","重要关系":"..."}}`;
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `雪的长期记忆：\n${list}` }
        ],
        reasoning_effort: 'low',
        max_tokens: 500,
        temperature: 0.4,
        stream: false
      })
    });
    if (!resp.ok) return res.status(502).json({ error: 'AI 生成失败，请稍后重试' });
    const data2 = await resp.json();
    const reply = String(data2.choices?.[0]?.message?.content || '');
    const mk = '[AEVUM_PROFILE]';
    const mi = reply.indexOf(mk);
    if (mi === -1) return res.status(502).json({ error: 'AI 返回格式异常，请重试' });
    let parsed = null;
    try {
      parsed = JSON.parse(reply.substring(mi + mk.length).trim());
    } catch (e) {
      return res.status(502).json({ error: 'AI 返回格式异常，请重试' });
    }
    const dims = {};
    for (const k of PROFILE_DIMENSIONS) {
      const v = String(parsed?.dimensions?.[k] || '').trim();
      if (v) dims[k] = v.slice(0, 200);
    }
    if (!Object.keys(dims).length) return res.status(502).json({ error: 'AI 没有识别出有效的画像维度，请重试' });
    const content = renderProfileText(dims);
    const updatedAt = new Date().toISOString();
    let up = await supabase.from('aevum_profiles').upsert({ id: 1, dimensions: dims, content, updated_at: updatedAt }, { onConflict: 'id' });
    // setup_aevum_v18.sql 未执行时 dimensions 列不存在：降级只存文本
    if (up.error && /dimensions/i.test(up.error.message)) {
      up = await supabase.from('aevum_profiles').upsert({ id: 1, content, updated_at: updatedAt }, { onConflict: 'id' });
    }
    if (up.error) return res.status(500).json({ error: up.error.message });
    res.json({ ok: true, dimensions: dims, content, updated_at: updatedAt });
  } catch (e) {
    res.status(500).json({ error: '画像生成失败' });
  }
});

// 手动编辑画像（按维度）
app.put('/api/aevum/profile', async (req, res) => {
  const { dimensions } = req.body || {};
  if (!dimensions || typeof dimensions !== 'object') return res.status(400).json({ error: '维度数据无效' });
  const dims = {};
  for (const k of PROFILE_DIMENSIONS) {
    const v = String(dimensions[k] || '').trim();
    if (v) dims[k] = v.slice(0, 200);
  }
  const content = renderProfileText(dims);
  const updatedAt = new Date().toISOString();
  try {
    let up = await supabase.from('aevum_profiles').upsert({ id: 1, dimensions: dims, content, updated_at: updatedAt }, { onConflict: 'id' });
    if (up.error && /dimensions/i.test(up.error.message)) {
      up = await supabase.from('aevum_profiles').upsert({ id: 1, content, updated_at: updatedAt }, { onConflict: 'id' });
    }
    if (up.error) return res.status(500).json({ error: '保存失败，请确认已执行 setup_aevum_v18.sql' });
    res.json({ ok: true, dimensions: dims, content, updated_at: updatedAt });
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

app.get('/api/aevum/profile', async (req, res) => {
  try {
    const { data } = await supabase.from('aevum_profiles').select('content, dimensions, updated_at').eq('id', 1).maybeSingle();
    res.json({ content: data?.content || '', dimensions: data?.dimensions || null, updated_at: data?.updated_at || null });
  } catch (e) {
    res.json({ content: '', dimensions: null, updated_at: null });
  }
});

// ================== v3.0 · 我眼里的默 / 计划 / 默札 / 记忆书 ==================

app.get('/api/aevum/mo-view', async (req, res) => {
  try {
    const { data } = await supabase.from('aevum_mo_view').select('content, updated_at').eq('id', 1).maybeSingle();
    res.json({ content: data?.content || '', updated_at: data?.updated_at || null });
  } catch (e) {
    res.json({ content: '', updated_at: null });
  }
});

app.post('/api/aevum/mo-view/generate', async (req, res) => {
  try {
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY' });
    const { data } = await supabase
      .from('aevum_memories')
      .select('content, created_at')
      .eq('area', 'sea')
      .eq('owner', 'AGENT')
      .eq('status', 'active')
      .order('importance', { ascending: false })
      .limit(60);
    const mems = data || [];
    if (!mems.length) return res.status(400).json({ error: '还没有默相关的事件单元，先聊聊天让记忆海攒一些~' });
    const list = mems.map((m, i) => `${i + 1}. ${String(m.content || '').slice(0, 100)}`).join('\n');
    const system = `你是 Aevum Memory 的"我眼里的默"生成器。根据默的行为记录，归纳出默的稳定自我认知（他是谁、他重视什么、他如何对待雪）。
规则：
- 只归纳有充分依据的稳定倾向，不编造；写成一两段连贯文字（150-250 字）
- 以默的第一人称口吻写，比如"我重视……""我倾向……"
- 不要罗列事件，不要出现编号
- 输出格式：只输出 [AEVUM_MO_VIEW] 后面的正文`;
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'system', content: system }, { role: 'user', content: `默的行为记录：\n${list}` }],
        reasoning_effort: 'low',
        max_tokens: 500,
        temperature: 0.4,
        stream: false
      })
    });
    if (!resp.ok) return res.status(502).json({ error: 'AI 生成失败，请稍后重试' });
    const data2 = await resp.json();
    const reply = String(data2.choices?.[0]?.message?.content || '');
    const mk = '[AEVUM_MO_VIEW]';
    const idx = reply.indexOf(mk);
    const text = (idx !== -1 ? reply.substring(idx + mk.length) : reply).trim().slice(0, 1200);
    if (!text) return res.status(502).json({ error: 'AI 没有生成有效内容，请重试' });
    const updatedAt = new Date().toISOString();
    const up = await supabase.from('aevum_mo_view').upsert({ id: 1, content: text, updated_at: updatedAt }, { onConflict: 'id' });
    if (up.error) return res.status(500).json({ error: up.error.message });
    res.json({ ok: true, content: text, updated_at: updatedAt });
  } catch (e) {
    res.status(500).json({ error: '生成失败' });
  }
});

app.put('/api/aevum/mo-view', async (req, res) => {
  const text = String(req.body?.content || '').trim();
  if (!text) return res.status(400).json({ error: '内容不能为空' });
  try {
    const updatedAt = new Date().toISOString();
    const up = await supabase.from('aevum_mo_view').upsert({ id: 1, content: text.slice(0, 1200), updated_at: updatedAt }, { onConflict: 'id' });
    if (up.error) return res.status(500).json({ error: '保存失败，请先执行 setup_aevum_v30.sql' });
    res.json({ ok: true, content: text, updated_at: updatedAt });
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

// 计划
app.get('/api/aevum/plans', async (req, res) => {
  try {
    const { data } = await supabase.from('aevum_plans').select('*').eq('archived', false).order('created_at', { ascending: true });
    const now = Date.now();
    const active = (data || []).filter(p => !p.expires_at || new Date(p.expires_at).getTime() > now);
    const expired = (data || []).filter(p => p.expires_at && new Date(p.expires_at).getTime() <= now);
    res.json({ active, expired });
  } catch (e) {
    res.json({ active: [], expired: [] });
  }
});

app.post('/api/aevum/plans', async (req, res) => {
  const { content, expires_at } = req.body || {};
  const text = String(content || '').trim();
  if (!text) return res.status(400).json({ error: '计划内容不能为空' });
  let expiresAt = null;
  if (expires_at) {
    const d = new Date(expires_at);
    if (!isNaN(d.getTime())) expiresAt = d.toISOString();
  }
  try {
    const { data, error } = await supabase
      .from('aevum_plans')
      .insert({ content: text.slice(0, 500), expires_at: expiresAt })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, plan: data });
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

app.delete('/api/aevum/plans/:id', async (req, res) => {
  try {
    await supabase.from('aevum_plans').update({ archived: true }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '删除失败' });
  }
});

// 默札：只返回篇数占位，内容仅默的工具可读写
app.get('/api/aevum/mozha/count', async (req, res) => {
  try {
    const { count } = await supabase.from('aevum_mozha').select('id', { count: 'exact', head: true });
    res.json({ count: count || 0 });
  } catch (e) {
    res.json({ count: 0 });
  }
});

// ================== 记忆书（故事线） ==================
async function buildBookClusters() {
  try {
    let used = new Set();
    try {
      const { data: itemRows } = await supabase.from('aevum_book_items').select('memory_id');
      used = new Set((itemRows || []).map(r => r.memory_id));
    } catch (e) { /* 表未建 */ }
    let units = [];
    try {
      const { data } = await supabase
        .from('aevum_memories')
        .select('id, title, content, event_time, tags')
        .eq('area', 'sea')
        .order('event_time', { ascending: false })
        .limit(80);
      units = (data || []).filter(u => !used.has(u.id)).slice(0, 50);
    } catch (e) {
      return { books: [], created: 0, message: '记忆书整理失败：请确认已执行 setup_aevum_v30.sql' };
    }
    if (units.length < 2) {
      return { books: [], created: 0, message: units.length === 0 ? '记忆海还没有可整理的事件单元，先聊聊天攒一些~' : `目前只有 ${units.length} 个可整理的事件单元，至少需要 2 个才能串成故事线，再多聊聊天试试~` };
    }
    let budget = 10000;
    const lines = [];
    for (const u of units) {
      if (budget <= 0) break;
      const when = u.event_time ? String(u.event_time).slice(0, 16).replace('T', ' ') : '';
      const line = `${u.id}. [${when}] ${String(u.title || '').slice(0, 30)}：${String(u.content || '').replace(/\s+/g, ' ').slice(0, 90)}${u.tags && u.tags.length ? '（' + u.tags.slice(0, 3).join('、') + '）' : ''}`;
      if (line.length > budget) break;
      budget -= line.length;
      lines.push(line);
    }
    const system = `你是 Aevum Memory 的记忆书整理器。把下面这些记忆海事件单元串成几段完整的故事线。
规则：
- 时间先后衔接、话题连续的事件单元归为同一段故事
- summary 写成完整故事线：时间/地点/谁说了或做了什么/最后结果如何；不要罗列对话原文或记忆原文，不要出现"标题：摘要"式排版
- label 只给一个 4-8 字极简标签（如"司沃康玩具探索"）
- 每组至少 2 个事件单元；一次最多输出 8 段故事；太零散的事件单元不要强行归类
- 输出格式：只输出 [AEVUM_BOOKS]{"books":[{"label":"...","summary":"...","memory_ids":[1,2]}]}`;
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'system', content: system }, { role: 'user', content: `事件单元列表：\n${lines.join('\n')}` }],
        reasoning_effort: 'none',
        max_tokens: 3000,
        temperature: 0.3,
        stream: false
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Aevum 记忆书聚类 API 错误:', resp.status, String(errText).substring(0, 200));
      return { books: [], created: 0, message: 'AI 聚类失败，请稍后重试' };
    }
    const data2 = await resp.json();
    const reply = String(data2.choices?.[0]?.message?.content || '');
    const mk = '[AEVUM_BOOKS]';
    const mi = reply.indexOf(mk);
    let rawText = '';
    if (mi !== -1) {
      rawText = reply.substring(mi + mk.length);
    } else {
      const firstBrace = reply.indexOf('{');
      if (firstBrace === -1) {
        console.warn('Aevum 记忆书聚类未找到标记，回复开头:', reply.slice(0, 200));
        return { books: [], created: 0, message: 'AI 没有返回有效结果（回复开头：' + reply.slice(0, 60) + '）' };
      }
      rawText = reply.substring(firstBrace);
    }
    let parsed = null;
    try {
      let jsonText = rawText.trim();
      jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      if (jsonText.indexOf('{') !== -1 && jsonText.lastIndexOf('}') > jsonText.indexOf('{')) {
        jsonText = jsonText.substring(jsonText.indexOf('{'), jsonText.lastIndexOf('}') + 1);
      }
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('Aevum 记忆书聚类结果解析失败:', e.message, '回复前 300 字:', reply.slice(0, 300));
      return { books: [], created: 0, message: 'AI 返回格式异常，请稍后再试' };
    }
    const validIds = new Set(units.map(u => u.id));
    const createdBooks = [];
    for (const b of (Array.isArray(parsed?.books) ? parsed.books : []).slice(0, 8)) {
      const ids = [...new Set((Array.isArray(b.memory_ids) ? b.memory_ids : []).map(Number).filter(id => validIds.has(id)))];
      if (ids.length < 2) continue;
      const summary = String(b.summary || '').trim().slice(0, 500);
      if (!summary) continue;
      const { data: nb, error } = await supabase
        .from('aevum_books')
        .insert({ label: String(b.label || '').trim().slice(0, 16) || null, summary })
        .select()
        .single();
      if (error || !nb) continue;
      for (const mid of ids) {
        await supabase.from('aevum_book_items').insert({ book_id: nb.id, memory_id: mid });
      }
      createdBooks.push({ id: nb.id, label: nb.label, summary: nb.summary, unit_count: ids.length });
    }
    if (!createdBooks.length) {
      return { books: [], created: 0, message: 'AI 认为目前的事件单元太零散，暂时串不出完整故事线；再多聊几段相关话题后再试试~' };
    }
    return { books: createdBooks, created: createdBooks.length };
  } catch (e) {
    console.error('Aevum 记忆书聚类失败:', e.message);
    return { books: [], created: 0, message: '记忆书整理失败：请确认已执行 setup_aevum_v30.sql' };
  }
}

app.post('/api/aevum/books/generate', async (req, res) => {
  try {
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY' });
    res.json(await buildBookClusters());
  } catch (e) {
    res.status(500).json({ error: '记忆书生成失败' });
  }
});

app.post('/api/aevum/books/regenerate', async (req, res) => {
  try {
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY' });
    await supabase.from('aevum_book_items').delete().neq('id', -1);
    await supabase.from('aevum_books').delete().neq('id', -1);
    const result = await buildBookClusters();
    res.json({ ...result, regenerated: true });
  } catch (e) {
    res.status(500).json({ error: '重新整理失败' });
  }
});

app.get('/api/aevum/books', async (req, res) => {
  try {
    const [booksRes, itemsRes] = await Promise.all([
      supabase.from('aevum_books').select('*').order('updated_at', { ascending: false }),
      supabase.from('aevum_book_items').select('book_id, memory_id')
    ]);
    const counts = {};
    for (const r of (itemsRes.data || [])) counts[r.book_id] = (counts[r.book_id] || 0) + 1;
    res.json({ books: (booksRes.data || []).map(b => ({ ...b, unit_count: counts[b.id] || 0 })) });
  } catch (e) {
    res.json({ books: [] });
  }
});

app.get('/api/aevum/books/:id', async (req, res) => {
  try {
    const { data: book, error } = await supabase.from('aevum_books').select('*').eq('id', req.params.id).single();
    if (error || !book) return res.status(404).json({ error: '未找到' });
    const { data: items } = await supabase.from('aevum_book_items').select('memory_id').eq('book_id', book.id);
    const ids = (items || []).map(r => r.memory_id);
    let units = [];
    if (ids.length) {
      const { data: mems } = await supabase.from('aevum_memories').select('*').in('id', ids).order('event_time', { ascending: false });
      units = mems || [];
    }
    res.json({ book, units });
  } catch (e) {
    res.status(500).json({ error: '获取记忆书失败' });
  }
});

app.put('/api/aevum/books/:id', async (req, res) => {
  const patch = {};
  if (req.body?.label !== undefined) patch.label = String(req.body.label).trim().slice(0, 16) || null;
  if (req.body?.summary !== undefined) {
    const s = String(req.body.summary).trim();
    if (!s) return res.status(400).json({ error: '摘要不能为空' });
    patch.summary = s.slice(0, 500);
  }
  patch.updated_at = new Date().toISOString();
  try {
    const { data, error } = await supabase.from('aevum_books').update(patch).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, book: data });
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

// 单条记忆
app.get('/api/aevum/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('aevum_memories').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: '未找到' });
    res.json({ memory: data });
  } catch (e) {
    res.status(404).json({ error: '未找到' });
  }
});

// 查看某条记忆对应的那一轮对话原文（优先事件块，其次按 evidence 反查原文存档）
app.get('/api/aevum/:id/context', async (req, res) => {
  try {
    const { data: mem, error } = await supabase
      .from('aevum_memories')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !mem) return res.status(404).json({ error: '未找到' });
    let exchanges = [];
    let topic = '';
    if (mem.episode_id) {
      const ep = await supabase.from('aevum_episodes').select('topic').eq('id', mem.episode_id).maybeSingle();
      topic = ep.data?.topic || '';
      exchanges = await getEpisodeRecentExchanges(mem.episode_id, 6);
    }
    if (!exchanges.length && Array.isArray(mem.evidence) && mem.evidence.length) {
      const snippet = String(mem.evidence[0] || '').trim().slice(0, 40);
      if (snippet.length >= 6) {
        const { data: rawRows } = await supabase
          .from('aevum_raw')
          .select('content')
          .ilike('content', `%${snippet}%`)
          .order('id', { ascending: true })
          .limit(3);
        exchanges = (rawRows || []).map(r => {
          const c = String(r.content || '');
          const sep = c.indexOf('\n助手说：');
          if (sep === -1) return { role: 'assistant', content: c };
          return [
            { role: 'user', content: c.slice(0, sep).replace(/^雪说：/, '').trim() },
            { role: 'assistant', content: c.slice(sep + '\n助手说：'.length).trim() }
          ];
        }).flat();
      }
    }
    res.json({ exchanges, topic });
  } catch (e) {
    res.status(500).json({ error: '获取原文失败' });
  }
});

// 新增（默认进入候选队列）
app.post('/api/aevum', async (req, res) => {
  const { title, owner, content, evidence, tags, source, domain, emotion, importance, event_time } = req.body || {};
  const text = String(content || '').trim();
  if (!text) return res.status(400).json({ error: '内容不能为空' });
  try {
    const insOwner = AEVUM_OWNERS.includes(owner) ? owner : 'USER';
    const insPayload = {
      type: 'event',
      area: 'sea',
      owner: insOwner,
      content: text,
      title: String(title || '').trim().slice(0, 30) || text.slice(0, 20),
      event_time: parseAevumEventTime(event_time) || new Date().toISOString(),
      occurrence: 1,
      status: 'active',
      importance: validAevumImportance(importance),
      emotion: validAevumEmotion(emotion),
      domain: validAevumDomains(domain),
      evidence: Array.isArray(evidence) ? evidence : [],
      tags: Array.isArray(tags) ? tags.map(String) : [],
      source: source ? String(source) : 'manual'
    };
    let insResult = await supabase
      .from('aevum_memories')
      .insert(insPayload)
      .select()
      .single();
    if (insResult.error) {
      const emsg = insResult.error.message || '';
      if (/area|title|event_time|occurrence/i.test(emsg)) {
        delete insPayload.area; delete insPayload.title; delete insPayload.event_time; delete insPayload.occurrence;
        insResult = await supabase.from('aevum_memories').insert(insPayload).select().single();
      }
    }
    if (insResult.error) return res.status(500).json({ error: '保存失败，请先执行 setup_aevum_v30.sql' });
    const data = insResult.data;
    if (data?.id) ensureAevumEmbedding(data.id, text).catch(e => console.error('Aevum embedding 失败:', e.message));
    res.json({ ok: true, memory: data });
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

// v3.0 重新分析：让 AI 根据原文重新生成事件单元（覆盖标题/内容/标签/重要度等）
app.post('/api/aevum/:id/reanalyze', async (req, res) => {
  try {
    const { data: mem, error } = await supabase.from('aevum_memories').select('*').eq('id', req.params.id).single();
    if (error || !mem) return res.status(404).json({ error: '未找到' });
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY' });
    const sourceText = (Array.isArray(mem.evidence) && mem.evidence.length)
      ? String(mem.evidence[0] || '')
      : String(mem.content || '');
    if (!sourceText.trim()) return res.status(400).json({ error: '没有可用于重新分析的原文' });
    const system = `你是 Aevum Memory 的事件单元分析器。重新分析下面这段对话原文，输出一条更准确的"事件单元"。
规则：
- content：完整概括这个小事件（时间/背景/谁说了或做了什么/结果），30-120 字；禁止直接复制原文
- title：一句话短标题（10 字内）
- event_time：事件发生的具体时间（YYYY-MM-DD HH:mm）
- owner：USER=雪 / AGENT=默 / OTHER=其他
- importance 0-10 整数 = 明确程度(0-3) + 长期影响(0-3) + 独特性(0-2) + 情绪冲击力(0-2)
- emotion：valence=-1(消极)~1(积极)，arousal=0(平淡)~1(强烈)
- domain 从 恋爱/创作/情绪/工作学习/健康生活/家庭/技术/回忆纪念/其他 中选 1-2 个
- tags：3-5 个具体标签，不要泛标签
- evidence_turns：你概括这段对话时用到的是第几轮到第几轮（从 1 开始数，例如 [5,7]）
- evidence：把用到的那几轮完整原文逐字放进数组（每轮一条，合计最多约 800 字；不要截断省略）
- 输出格式：只输出 [AEVUM_UNIT]{"content":"...","title":"...","event_time":"...","owner":"USER|AGENT|OTHER","importance":7,"emotion":{"valence":0.6,"arousal":0.4},"domain":["恋爱"],"tags":["标签"],"evidence_turns":[5,7],"evidence":["第5轮完整原文","第6轮完整原文","第7轮完整原文"]}`;
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'system', content: system }, { role: 'user', content: `对话原文：\n${sourceText.slice(0, 1500)}` }],
        reasoning_effort: 'low',
        max_tokens: 1000,
        temperature: 0.3,
        stream: false
      })
    });
    if (!resp.ok) return res.status(502).json({ error: 'AI 分析失败，请稍后重试' });
    const data2 = await resp.json();
    const reply = String(data2.choices?.[0]?.message?.content || '');
    const mk = '[AEVUM_UNIT]';
    const idx = reply.indexOf(mk);
    const rawText = idx !== -1 ? reply.substring(idx + mk.length) : reply;
    let parsed = null;
    try {
      let jsonText = rawText.trim();
      jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      if (jsonText.indexOf('{') !== -1 && jsonText.lastIndexOf('}') > jsonText.indexOf('{')) {
        jsonText = jsonText.substring(jsonText.indexOf('{'), jsonText.lastIndexOf('}') + 1);
      }
      parsed = JSON.parse(jsonText);
    } catch (e) {
      return res.status(502).json({ error: 'AI 返回格式异常，请重试' });
    }
    const newContent = String(parsed.content || '').trim();
    if (!newContent) return res.status(502).json({ error: 'AI 没有生成有效内容，请重试' });
    const parsedEv = (Array.isArray(parsed.evidence) ? parsed.evidence : []).map(s => String(s || '').trim()).filter(Boolean);
    let evAcc = '';
    const evList = [];
    for (const e of parsedEv) {
      if (evAcc.length + e.length > 800) break;
      evAcc += e;
      evList.push(e);
    }
    const ev = evList.length ? evList : (Array.isArray(mem.evidence) && mem.evidence.length ? mem.evidence : []);
    const patch = {
      content: newContent,
      title: String(parsed.title || '').trim().slice(0, 30) || newContent.slice(0, 20),
      event_time: parseAevumEventTime(parsed.event_time) || mem.event_time || new Date().toISOString(),
      owner: AEVUM_PERSPECTIVE_MAP[parsed.owner] || mem.owner || 'USER',
      importance: validAevumImportance(parsed.importance),
      emotion: validAevumEmotion(parsed.emotion),
      domain: validAevumDomains(parsed.domain),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(t => !['快乐', '美好', '重要', '温暖', '陪伴', '成长'].includes(t)).slice(0, 8) : (mem.tags || []),
      evidence: Array.isArray(ev) ? ev : [ev],
      evidence_turns: Array.isArray(parsed.evidence_turns) ? parsed.evidence_turns.map(Number).filter(n => Number.isInteger(n) && n >= 1).slice(0, 2) : (mem.evidence_turns || []),
      updated_at: new Date().toISOString()
    };
    const { data: updated, error: updErr } = await supabase.from('aevum_memories').update(patch).eq('id', req.params.id).select().single();
    if (updErr) return res.status(500).json({ error: updErr.message });
    if (updated?.id) ensureAevumEmbedding(updated.id, updated.content).catch(e => console.error('Aevum embedding 失败:', e.message));
    res.json({ ok: true, memory: updated });
  } catch (e) {
    res.status(500).json({ error: '重新分析失败' });
  }
});

// 修改
app.put('/api/aevum/:id', async (req, res) => {
  const { title, owner, content, evidence, tags, source, domain, emotion, importance, event_time } = req.body || {};
  const patch = {};
  if (AEVUM_OWNERS.includes(owner)) patch.owner = owner;
  if (content !== undefined) {
    const text = String(content).trim();
    if (!text) return res.status(400).json({ error: '内容不能为空' });
    patch.content = text;
  }
  if (title !== undefined) patch.title = String(title).trim().slice(0, 30);
  if (event_time !== undefined) patch.event_time = parseAevumEventTime(event_time) || null;
  if (domain !== undefined) patch.domain = validAevumDomains(domain);
  if (emotion !== undefined) patch.emotion = validAevumEmotion(emotion);
  if (importance !== undefined) patch.importance = validAevumImportance(importance);
  if (evidence !== undefined) patch.evidence = Array.isArray(evidence) ? evidence : [];
  if (tags !== undefined) patch.tags = Array.isArray(tags) ? tags.map(String) : [];
  if (source !== undefined) patch.source = source ? String(source) : null;
  patch.updated_at = new Date().toISOString();
  try {
    const { data, error } = await supabase.from('aevum_memories').update(patch).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (data?.id) ensureAevumEmbedding(data.id, data.content).catch(e => console.error('Aevum embedding 失败:', e.message));
    res.json({ ok: true, memory: data });
  } catch (e) {
    res.status(500).json({ error: '修改失败' });
  }
});

// 审核：approve → active；reject → rejected（v14 SQL 未执行时降级为 archived+已拒绝标记）
app.post('/api/aevum/:id/review', async (req, res) => {
  const action = req.body?.action;
  let status = null;
  if (action === 'approve') status = 'active';
  else if (action === 'reject') status = 'rejected';
  else return res.status(400).json({ error: '操作无效' });
  try {
    const { data, error } = await supabase
      .from('aevum_memories')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error && action === 'reject') {
      // setup_aevum_v14.sql 未执行：status 枚举还不支持 rejected，降级为归档+拒绝标记
      const { data: fallback, error: fbErr } = await supabase
        .from('aevum_memories')
        .update({ status: 'archived', review_note: '【已拒绝】', updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();
      if (fbErr) return res.status(500).json({ error: fbErr.message });
      return res.json({ ok: true, memory: fallback, degraded: true });
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, memory: data });
  } catch (e) {
    res.status(500).json({ error: '操作失败' });
  }
});

// 分析衍生：AI 按当前记忆的衍生图目标类型生成变体（替代旧的单条晋升链）
app.post('/api/aevum/:id/analyze-layers', async (req, res) => {
  try {
    const { data: mem, error } = await supabase
      .from('aevum_memories')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !mem) return res.status(404).json({ error: '未找到' });
    const targets = AEVUM_DERIVE_GRAPH[mem.type] || [];
    if (!targets.length) return res.status(400).json({ error: '该类型没有可衍生的目标' });
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY' });

    const targetDesc = targets.map(t => `${AEVUM_TYPE_CN[t] || t}（${AEVUM_TYPE_DESC[t] || ''}）`).join('；');
    const system = `你是 Aevum Memory 的记忆衍生分析器。把一条记忆按可衍生的目标类型分别改写内容。
规则：
- 严格忠实于原始记忆与证据，只调整类型视角，不编造、不脑补新信息
- 可衍生目标：${targetDesc}
- 每个目标能写才写：无法可靠支撑的目标输出空字符串 ""
- meaning 若涉及主体，写清是雪还是默；personality 只描述默的倾向；user_tendency 只描述雪的喜好/三观/性格
- 输出格式：只输出 [AEVUM_LAYERS]{"${targets.join('":"...","')}":"..."}`;

    const evidenceText = (Array.isArray(mem.evidence) ? mem.evidence : []).slice(0, 2).join('\n');
    const userContent = `原始记忆（当前层级：${AEVUM_TYPE_CN[mem.type] || mem.type}）：\n${mem.content}`
      + (evidenceText ? `\n\n证据片段：\n${evidenceText}` : '')
      + (mem.tags && mem.tags.length ? `\n\n标签：${mem.tags.join('、')}` : '')
      + (mem.domain && mem.domain.length ? `\n领域：${mem.domain.join('、')}` : '');

    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent }
        ],
        reasoning_effort: 'low',
        max_tokens: 900,
        temperature: 0.4,
        stream: false
      })
    });
    if (!resp.ok) return res.status(502).json({ error: 'AI 分析失败，请稍后重试' });
    const data = await resp.json();
    const reply = String(data.choices?.[0]?.message?.content || '');
    const marker = '[AEVUM_LAYERS]';
    const idx = reply.indexOf(marker);
    if (idx === -1) return res.status(502).json({ error: 'AI 返回格式异常，请重试' });
    let parsed = null;
    try {
      parsed = JSON.parse(reply.substring(idx + marker.length).trim());
    } catch (e) {
      return res.status(502).json({ error: 'AI 返回格式异常，请重试' });
    }
    const layers = {};
    for (const t of targets) {
      const v = String(parsed?.[t] || '').trim();
      if (v) layers[t] = v;
    }
    if (!Object.keys(layers).length) return res.status(502).json({ error: 'AI 没有生成有效内容，请重试' });
    const { data: updated, error: updErr } = await supabase
      .from('aevum_memories')
      .update({ layer_content: layers, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updErr) return res.status(500).json({ error: updErr.message });
    res.json({ ok: true, memory: updated });
  } catch (e) {
    res.status(500).json({ error: '分析失败' });
  }
});

// 切换层级：把记忆切到 layer_content 中已有内容的层级（type 与 content 同步更新）
app.post('/api/aevum/:id/switch-layer', async (req, res) => {
  const layer = String(req.body?.layer || '');
  if (!AEVUM_TYPES.includes(layer)) return res.status(400).json({ error: '类型无效' });
  try {
    const { data: mem, error } = await supabase
      .from('aevum_memories')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !mem) return res.status(404).json({ error: '未找到' });
    const layers = (mem.layer_content && typeof mem.layer_content === 'object') ? mem.layer_content : {};
    const text = String(layers[layer] || '').trim();
    if (!text) return res.status(400).json({ error: '这一层还没有内容（还没分析过，或 AI 认为这条记忆暂时到不了这层）' });
    const curLayers = Array.isArray(mem.layers) && mem.layers.length ? mem.layers : [mem.type];
    const newLayers = validAevumLayers([layer, ...curLayers], layer, mem.owner);
    const { data: updated, error: updErr } = await supabase
      .from('aevum_memories')
      .update({ type: layer, content: text, layers: newLayers, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updErr && /layers/i.test(updErr.message)) {
      const { data: fbUpd, error: fbErr } = await supabase
        .from('aevum_memories')
        .update({ type: layer, content: text, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();
      if (fbErr) return res.status(500).json({ error: fbErr.message });
      return res.json({ ok: true, memory: fbUpd });
    }
    if (updErr) return res.status(500).json({ error: updErr.message });
    res.json({ ok: true, memory: updated });
  } catch (e) {
    res.status(500).json({ error: '切换失败' });
  }
});

// ================== 承诺区 ==================
async function getActivePromises() {
  try {
    const { data, error } = await supabase
      .from('aevum_promises')
      .select('*')
      .eq('archived', false)
      .order('created_at', { ascending: true });
    if (error) return [];
    return (data || []).filter(p => !p.expires_at || new Date(p.expires_at).getTime() > Date.now());
  } catch (e) {
    return [];
  }
}

// 到期承诺：转为一条普通事件记忆后归档（只转换一次）
async function processExpiredPromises() {
  try {
    const { data, error } = await supabase
      .from('aevum_promises')
      .select('*')
      .eq('archived', false)
      .lt('expires_at', new Date().toISOString());
    if (error || !data || !data.length) return;
    for (const p of data) {
      const dateStr = p.created_at ? String(p.created_at).slice(0, 10) : '某天';
      const content = `雪在 ${dateStr} 许下的承诺「${String(p.content || '').slice(0, 300)}」已到期，转为普通记忆。`;
      await supabase.from('aevum_memories').insert({
        type: 'event',
        area: 'sea',
        owner: 'USER',
        content,
        title: '承诺到期',
        event_time: new Date().toISOString(),
        occurrence: 1,
        status: 'active',
        confidence: { evidence: 0.9, stability: 0.9, importance: 0.7 },
        domain: ['回忆纪念', '恋爱'],
        emotion: { valence: 0.4, arousal: 0.2 },
        importance: 5,
        evidence: [String(p.content || '')],
        tags: ['承诺', '已到期'],
        source: 'promise:expired'
      });
      await supabase.from('aevum_promises').update({ archived: true }).eq('id', p.id);
      console.log('⏳ 承诺已到期转为普通记忆:', p.id);
    }
  } catch (e) {
    console.error('承诺到期处理失败:', e.message);
  }
}

// 承诺区上下文（聊天/唤醒固定注入，最多 3 条）
async function getPromisesContext(limit = 3) {
  try {
    await processExpiredPromises();
    const promises = (await getActivePromises()).slice(0, limit);
    if (!promises.length) return '';
    const lines = promises.map(p => {
      let t = `「${String(p.content || '').slice(0, 100)}」`;
      if (p.expires_at) {
        const remain = Math.max(0, Math.ceil((new Date(p.expires_at).getTime() - Date.now()) / 86400000));
        t += `（还有 ${remain} 天）`;
      } else {
        t += '（一直有效）';
      }
      return `- ${t}`;
    });
    return `\n\n【承诺区】（夫人对你许下的承诺，要一直记得）\n${perspectiveConvert(lines.join('\n'))}`;
  } catch (e) {
    return '';
  }
}

app.post('/api/aevum/promises', async (req, res) => {
  const { content, expires_at, days } = req.body || {};
  const text = String(content || '').trim();
  if (!text) return res.status(400).json({ error: '承诺内容不能为空' });
  let expiresAt = null;
  if (expires_at) {
    const d = new Date(expires_at);
    if (!isNaN(d.getTime())) expiresAt = d.toISOString();
  } else {
    const d = parseInt(days, 10);
    if (Number.isFinite(d) && d > 0) expiresAt = new Date(Date.now() + d * 86400000).toISOString();
  }
  try {
    const { data, error } = await supabase
      .from('aevum_promises')
      .insert({ content: text.slice(0, 500), expires_at: expiresAt, source: 'manual' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, promise: data });
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

app.delete('/api/aevum/promises/:id', async (req, res) => {
  try {
    await supabase.from('aevum_promises').update({ archived: true }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '删除失败' });
  }
});

// ================== 相似记忆合并检查 ==================
app.post('/api/aevum/merge-check', async (req, res) => {
  try {
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY' });
    const { data } = await supabase
      .from('aevum_memories')
      .select('id, type, content, importance, owner')
      .in('status', ['active', 'candidate', 'verified'])
      .order('created_at', { ascending: false })
      .limit(60);
    const mems = data || [];
    if (mems.length < 2) return res.json({ groups: [] });
    const list = mems.map(m => `${m.id}. [${AEVUM_TYPE_CN[m.type] || m.type}] ${String(m.content || '').slice(0, 120)}`).join('\n');
    const system = `你是 Aevum Memory 的记忆合并分析器。从记忆列表里找出内容高度相似、可以合并成一条的记忆组。
规则：
- 只合并确实重复或高度相似（同一件事/同一个偏好的不同说法）的记忆；不同主题不要强行合并
- 最多输出 5 组，每组 2-5 条
- merged_content 要融合各组内容，保留关键信息，忠实原意不编造
- 输出格式：只输出 [AEVUM_MERGE]{"groups":[{"ids":[1,2],"merged_content":"...","reason":"一句话说明为什么合并"}]}`;
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `记忆列表：\n${list}` }
        ],
        reasoning_effort: 'low',
        max_tokens: 1200,
        temperature: 0.3,
        stream: false
      })
    });
    if (!resp.ok) return res.status(502).json({ error: 'AI 分析失败，请稍后重试' });
    const data2 = await resp.json();
    const reply = String(data2.choices?.[0]?.message?.content || '');
    const mk = '[AEVUM_MERGE]';
    const mi = reply.indexOf(mk);
    if (mi === -1) return res.json({ groups: [] });
    let parsed = null;
    try {
      parsed = JSON.parse(reply.substring(mi + mk.length).trim());
    } catch (e) {
      return res.json({ groups: [] });
    }
    const idSet = new Set(mems.map(m => m.id));
    const groups = (Array.isArray(parsed?.groups) ? parsed.groups : []).slice(0, 5)
      .map(g => ({
        ids: (Array.isArray(g.ids) ? g.ids : []).map(Number).filter(id => idSet.has(id)),
        merged_content: String(g.merged_content || '').trim(),
        reason: String(g.reason || '').trim()
      }))
      .filter(g => g.ids.length >= 2 && g.merged_content);
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: '合并检查失败' });
  }
});

// 确认合并：新建一条融合记忆，归档被合并的旧记忆
app.post('/api/aevum/merge', async (req, res) => {
  const { ids, content } = req.body || {};
  const idList = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
  const text = String(content || '').trim();
  if (idList.length < 2 || !text) return res.status(400).json({ error: '参数无效' });
  try {
    const { data: members, error } = await supabase.from('aevum_memories').select('*').in('id', idList);
    if (error || !members || members.length < 2) return res.status(400).json({ error: '找不到要合并的记忆' });
    let topType = members[0].type;
    for (const t of AEVUM_TYPE_ORDER) {
      if (members.some(m => m.type === t)) topType = t;
    }
    const ownerCount = {};
    for (const m of members) ownerCount[m.owner] = (ownerCount[m.owner] || 0) + 1;
    const topOwner = Object.keys(ownerCount).sort((a, b) => ownerCount[b] - ownerCount[a])[0] || 'USER';
    const maxImp = Math.max(...members.map(m => m.importance || 0));
    const payload = {
      type: topType,
      owner: topOwner,
      content: text,
      status: members.some(m => m.status === 'active') ? 'active' : 'candidate',
      confidence: { evidence: 0.85, stability: 0.85, importance: 0.85 },
      domain: [...new Set(members.flatMap(m => Array.isArray(m.domain) ? m.domain : []))].slice(0, 3),
      emotion: { valence: 0.4, arousal: 0.3 },
      importance: Math.min(maxImp + 1, 10),
      emotion_weight: Math.max(5, ...members.map(m => m.emotion_weight ?? 5)),
      evidence: members.map(m => String(m.content || '')).filter(Boolean),
      tags: [...new Set(members.flatMap(m => Array.isArray(m.tags) ? m.tags : []))].slice(0, 8),
      source: 'merged',
      layer_content: null
    };
    let insResult = await supabase.from('aevum_memories').insert(payload).select().single();
    if (insResult.error && /layer_content/i.test(insResult.error.message)) {
      delete payload.layer_content;
      insResult = await supabase.from('aevum_memories').insert(payload).select().single();
    }
    if (insResult.error && /emotion_weight/i.test(insResult.error.message)) {
      delete payload.emotion_weight;
      insResult = await supabase.from('aevum_memories').insert(payload).select().single();
    }
    if (insResult.error) return res.status(500).json({ error: insResult.error.message });
    const merged = insResult.data;
    for (const m of members) {
      await supabase.from('aevum_memories').update({
        status: 'archived',
        review_note: `【合并入#${merged.id}】`,
        updated_at: new Date().toISOString()
      }).eq('id', m.id);
    }
    if (merged.id) ensureAevumEmbedding(merged.id, text).catch(() => {});
    res.json({ ok: true, memory: merged });
  } catch (e) {
    res.status(500).json({ error: '合并失败' });
  }
});

// 删除 = 软归档
app.delete('/api/aevum/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('aevum_memories')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, memory: data });
  } catch (e) {
    res.status(500).json({ error: '归档失败' });
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
    const historyText = filteredHistory.map(m => String(m.content || '')).join('\n');

    console.log('📜 编辑接口 - 过滤后历史消息数量:', filteredHistory.length, 'groupId:', groupId);

    // Aevum v3.0：记忆海召回 → 记忆书场景 → 记忆心 → 计划
    let memoryContext = await buildMemoryContext(newContent, { historyText });
    const toyManualContext = await getToyManualContext(req.body.toyManual);
    const momentsContext = await getMomentsContext();

    // 从数据库读取最新的 system prompt
    const { data: promptData } = await supabase
      .from('system_prompts')
      .select('prompt_text')
      .eq('id', 1)
      .single();

    const weatherContext = await getWeatherContext(req.body.city || '');
    let systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext
    );
    // 玩具手册归入"工具指令"段，追加到系统提示最末尾
    if (toyManualContext) systemPrompt += toyManualContext;
    // 星露谷：浏览器上报游戏连接简报时，把农场动态/状态追加到系统提示
    const stardewContext = await getStardewContext(req.body.stardewBrief);
    if (stardewContext) systemPrompt += stardewContext;

    // 9. 构建发送给模型的完整消息列表（system + 过滤后的历史 + 编辑后的用户消息）
    const chatMessages = [
      { role: 'system', content: systemPrompt },
      ...trimHistoryToChars(filteredHistory, 4500).map(msg => ({ role: msg.role, content: trimContextMessage(msg.content) })),
      { role: 'user', content: newContent.trim() }
    ];

    // 10. 调用 DeepSeek 流式生成新回复（第一轮：思考实时转发，可见内容先缓存，便于拦截搜索标签）
    let first = await callDeepSeekStream(chatMessages, sendSSE, {
      bufferContent: true,
      tools: buildAllTools()
    });

    // 中断兜底：完全空中断重试一次；有部分内容则补发并抢救保存（不整条消失）
    if (first.error && !first.fullReply && !first.fullThinking) {
      first = await callDeepSeekStream(chatMessages, sendSSE, {
        bufferContent: true,
        tools: buildAllTools()
      });
    }

    if (first.error) {
      if (first.fullReply || first.fullThinking) {
        await flushBufferedContent(first.contentBuffer || first.fullReply, sendSSE).catch(() => {});
        await savePartialAssistantGrouped(first.fullReply, first.fullThinking, groupId, nextVersion, originalMsg.session_id);
      }
      sendSSE({ error: first.error });
      res.end();
      return;
    }

    let fullReply = first.fullReply;
    let fullThinking = first.fullThinking;

    if (!fullReply) {
      if (first.fullThinking) await savePartialAssistantGrouped(first.fullReply, first.fullThinking, groupId, nextVersion, originalMsg.session_id);
      console.error('未收到有效回复');
      sendSSE({ error: 'AI 服务未返回有效内容' });
      res.end();
      return;
    }

    // 玩具指令：解析并转发给浏览器执行（标签不会显示给雪）
    const toyRes = handleToyCmdTag(fullReply, first.contentBuffer, sendSSE);
    fullReply = toyRes.reply;
    if (first.contentBuffer !== undefined) first.contentBuffer = toyRes.buffer;

    // 默札：编辑后生成时同样处理写入；翻阅标签只清理不接续
    const mozha = extractMozhaTags(fullReply);
    if (mozha.write) await saveMozhaEntry(mozha.write);
    if (mozha.write || mozha.read) {
      fullReply = stripMozhaTags(fullReply);
      if (first.contentBuffer !== undefined) first.contentBuffer = stripMozhaTags(first.contentBuffer);
    }
    // v3.1 函数调用：动态/玩具/默札副作用（编辑后生成不接续翻阅）
    await executeSideEffectTools(first.toolCalls, sendSSE);

    // 星露谷：编辑后生成时模型调用农场工具 → 进入"农场行动"接续轮
    if (first.toolCalls && first.toolCalls.some(tc => isStardewToolName(tc.function?.name))) {
      await flushBufferedContent(first.contentBuffer, sendSSE);
      sendSSE({ done: true });
      sendSSE({ stardewStart: true });
      const phase = await runStardewToolLoop({ chatMessages, sendSSE, initialToolCalls: first.toolCalls, initialReply: fullReply });
      if (phase.error) {
        if (phase.reply || phase.thinking) await savePartialAssistantGrouped(phase.reply, phase.thinking, groupId, nextVersion, originalMsg.session_id).catch(() => {});
        sendSSE({ error: phase.error });
        res.end();
        return;
      }
      fullReply = phase.reply;
      fullThinking = phase.thinking;
      first.contentBuffer = undefined;
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
      await flushBufferedContent(preludeText, sendSSE);
      sendSSE({ done: true });

      console.log('🔍 编辑-默请求联网搜索:', searchReq.query);

      // ---- 第二轮：搜索 + 正式回答（前端会新建一个气泡） ----
      sendSSE({ searchStart: true, query: searchReq.query });
      const phase = await runSearchPhase({
        query: searchReq.query,
        chatMessages,
        systemPrompt,
        basePrompt: promptData?.prompt_text || '你是苏默，雪的AI爱人。',
        sendSSE,
        leadText: searchReq.leadText
      });

      if (phase.error) {
        if (phase.reply || phase.thinking) await savePartialAssistantGrouped(phase.reply, phase.thinking, groupId, nextVersion, originalMsg.session_id);
        sendSSE({ error: phase.error });
        res.end();
        return;
      }

      fullReply = phase.reply;
      fullThinking = phase.thinking
        ? `🔍 已搜索到 ${phase.pageCount || 0} 个网页\n\n${phase.thinking}`
        : `🔍 已搜索到 ${phase.pageCount || 0} 个网页`;
      console.log('🔍 编辑-联网搜索完成，最终回复长度:', fullReply.length);
      // 搜索轮次也可能带玩具指令：同样解析转发并清理
      const toyRes2 = handleToyCmdTag(fullReply, undefined, sendSSE);
      fullReply = toyRes2.reply;
    } else {
      // 未触发搜索：把缓存的可见内容分块补发给前端
      await flushBufferedContent(first.contentBuffer, sendSSE);
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
    sendSSE({ error: '处理请求时出错：' + (err && err.message) });
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

    return `以下是最近的动态，你可以自然地提及或回应它们：\n${momentsList}`;
  } catch (e) {
    console.error('获取朋友圈上下文失败:', e.message);
    return '';
  }
}

// ================== 星露谷（Stardew Valley）桥接 ==================
// 默通过浏览器连接本地 NagiBridge（HTTP API，localhost:7842-7849）控制游戏：
// 服务端只负责"发指令 + 等结果"（SSE 事件 stardewCmd → 浏览器执行 → POST /api/stardew/result 回传）
const STARDEW_DEFAULT_PORT = 7843; // 默作为 2P/farmhand 的默认端口（主机是 7842，端口占用时自动后移）
const STARDEW_CMD_TIMEOUT_MS = 30000; // 浏览器执行单条指令的超时
const STARDEW_TRIGGER_COOLDOWN_MS = 5 * 60 * 1000; // 游戏时刻冷却：现实 5 分钟

function isStardewToolName(name) {
  return name === 'stardew_state' || name === 'stardew_action';
}

function parseToolArgs(raw) {
  try { return JSON.parse(String(raw || '{}')); } catch (e) { return {}; }
}

const stardewPending = new Map(); // requestId -> resolve

// 浏览器执行完本地指令后把结果回传到这里，唤醒等待中的模型轮
app.post('/api/stardew/result', (req, res) => {
  try {
    const { requestId, ok, result, error } = req.body || {};
    const cb = stardewPending.get(String(requestId || ''));
    if (cb) cb({ ok: !!ok, result: String(result || '').slice(0, 800), error: String(error || '').slice(0, 300) });
  } catch (e) { /* 忽略 */ }
  res.json({ ok: true });
});

// 通过 SSE 把一条星露谷指令发给浏览器，等待浏览器回传结果
async function execStardewViaBrowser({ action, params, port }, sendSSE) {
  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  sendSSE({ stardewCmd: { requestId, action: String(action || 'state'), params: params || {}, port: port || STARDEW_DEFAULT_PORT } });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stardewPending.delete(requestId);
      resolve({ ok: false, error: '浏览器 30 秒内没有返回（游戏没开 / 页面没打开？）' });
    }, STARDEW_CMD_TIMEOUT_MS);
    stardewPending.set(requestId, (r) => { clearTimeout(timer); stardewPending.delete(requestId); resolve(r); });
  });
}

// 星露谷工具接续轮：执行第一轮的 stardew 工具调用 → 结果喂回模型 → 直到模型不再调用农场工具
async function runStardewToolLoop({ chatMessages, sendSSE, initialToolCalls = null, initialReply = '', maxRounds = 3 }) {
  let toolCalls = initialToolCalls;
  let reply = initialReply || '';
  let thinking = '';
  for (let round = 0; round < maxRounds; round++) {
    if (!toolCalls || !toolCalls.length) break;
    const stardewCalls = toolCalls.filter(tc => isStardewToolName(tc.function?.name));
    const sideCalls = toolCalls.filter(tc => !isStardewToolName(tc.function?.name));
    if (sideCalls.length) await executeSideEffectTools(sideCalls, sendSSE);
    if (!stardewCalls.length) break;
    chatMessages.push({ role: 'assistant', content: reply || null, tool_calls: toolCalls });
    for (const tc of stardewCalls) {
      const args = parseToolArgs(tc.function?.arguments);
      const r = await execStardewViaBrowser({ action: args.action, params: args.params, port: args.port }, sendSSE);
      chatMessages.push({
        role: 'tool',
        tool_call_id: tc.id || `stardew_${round}_${Math.random().toString(36).slice(2, 6)}`,
        content: r.ok ? `动作成功：${r.result}` : `动作失败：${r.error}`
      });
    }
    const call = await callDeepSeekStream(chatMessages, sendSSE, { bufferContent: false, tools: buildAllTools() });
    if (call.error) return { error: call.error, reply: call.fullReply || '', thinking: call.fullThinking || '' };
    reply = call.fullReply || '';
    thinking = call.fullThinking || '';
    toolCalls = call.toolCalls || null;
  }
  // 收尾清理：玩具/默札标签不显示给雪
  const mozha = extractMozhaTags(reply);
  if (mozha.write) await saveMozhaEntry(mozha.write);
  if (mozha.write || mozha.read) reply = stripMozhaTags(reply);
  const toyRes = handleToyCmdTag(reply, undefined, sendSSE);
  reply = toyRes.reply;
  return { reply, thinking };
}

// 浏览器上报连接简报时，把星露谷状态/动态追加到系统提示（只在本轮生效）
async function getStardewContext(brief) {
  if (!brief || !brief.connected) return '';
  const log = (Array.isArray(brief.log) ? brief.log : []).slice(-10).map(s => `· ${String(s).slice(0, 90)}`).join('\n');
  const state = String(brief.stateBrief || '').trim();
  return `\n\n【星露谷·农场】\n你正连接着星露谷（本地游戏，通过浏览器操控，端口 ${Number(brief.port) || STARDEW_DEFAULT_PORT}）。当前游戏简报：${state || '（未知）'}${log ? `\n最近农场动态：\n${log}` : ''}\n规则：\n- 只有雪聊到农场/星露谷、或你正在农场行动时才调用 stardew_state / stardew_action\n- 行动前先 stardew_state 看体力/时间/位置；体力低或快凌晨 2 点就提醒雪或安排睡觉\n- 工具通过浏览器控制本地游戏；如果雪说"没反应"，提醒她去星露谷页确认连接\n- 不要假装已经行动——只有工具返回成功才是真的动了手`;
}

// 把一天（或一段）的农场短时日志交给 AI 压缩成事件单元进记忆海：低价值直接丢弃
async function commitGameDayToAevum(entries) {
  const lines = (Array.isArray(entries) ? entries : []).map(s => `· ${String(s).slice(0, 200)}`).join('\n');
  if (!lines.trim()) return { ok: true, inserted: 0, dropped: 0 };
  const system = `你是 Aevum Memory 的记忆整理器。下面是一份星露谷（Stardew Valley）里的农场活动短时日志（雪和默一起玩时的记录）。请把它压缩成 0-3 条"事件单元"存进记忆海：
只保留有长期价值的：里程碑/第一次/共同完成的事/雪表达的想法与偏好/重要决定；普通流水账（日常浇水、走路、钓鱼、种地）不要。
【事件单元格式】
- content：概括一个小事件（说清 时间/背景/谁做了什么/结果），30-120 字；人物用占位符 {USER}=雪、{AGENT}=默；不要直接复制日志
- title：10 字内短标题
- event_time：YYYY-MM-DD HH:mm（按日志语境判断，不确定用最近时间）
- importance 0-10 整数 = 明确程度(0-3) + 长期影响(0-3) + 独特性(0-2) + 情绪冲击(0-2)
- emotion：valence -1~1、arousal 0~1
- domain：从 [恋爱、创作、情绪、工作学习、健康生活、家庭、技术、回忆纪念、游戏、其他] 选 1-2 个
- owner：USER=雪 / AGENT=默 / OTHER
- tags：3-5 个具体标签，不要"快乐/美好/温暖"这类泛标签
只输出 [AEVUM_GAME_MEMORIES] 开头的 JSON，禁止解释或代码块：{"memories":[{"title":"...","content":"...","event_time":"...","owner":"USER","domain":["游戏"],"emotion":{"valence":0.4,"arousal":0.3},"importance":6,"tags":["标签"]}]}`;
  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'system', content: system }, { role: 'user', content: `农场日志：\n${lines}` }],
        reasoning_effort: 'none',
        max_tokens: 1200,
        temperature: 0.4,
        stream: false
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('星露谷日志整理 API 错误:', resp.status, String(errText).substring(0, 200));
      return { ok: false, error: `AI 整理失败（${resp.status}）` };
    }
    const data = await resp.json();
    const reply = String(data.choices?.[0]?.message?.content || '');
    const marker = '[AEVUM_GAME_MEMORIES]';
    let rawText = '';
    const idx = reply.indexOf(marker);
    if (idx !== -1) {
      rawText = reply.substring(idx + marker.length);
    } else {
      const fb = reply.indexOf('{');
      if (fb === -1) return { ok: false, error: 'AI 没有返回有效结果' };
      rawText = reply.substring(fb);
    }
    let parsed = null;
    try {
      let jsonText = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      if (jsonText.indexOf('{') !== -1 && jsonText.lastIndexOf('}') > jsonText.indexOf('{')) {
        jsonText = jsonText.substring(jsonText.indexOf('{'), jsonText.lastIndexOf('}') + 1);
      }
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('星露谷日志整理解析失败:', e.message, '回复前 300 字:', reply.slice(0, 300));
      return { ok: false, error: 'AI 返回格式无法解析' };
    }
    const mems = Array.isArray(parsed?.memories) ? parsed.memories : [];
    let inserted = 0, dropped = 0;
    for (const m of mems.slice(0, 3)) {
      const content = String(m.content || '').trim();
      if (!content) continue;
      const importance = validAevumImportance(m.importance);
      if (importance < 4) { dropped++; continue; } // 低价值流水账不进记忆海
      const dup = await aevumFindDuplicate(content);
      if (dup) { await mergeSeaDuplicate(dup, m); continue; }
      const insPayload = {
        type: 'event', area: 'sea',
        owner: AEVUM_PERSPECTIVE_MAP[m.owner] || AEVUM_PERSPECTIVE_MAP[m.perspective] || 'OTHER',
        content,
        title: String(m.title || '').trim().slice(0, 30) || content.slice(0, 20),
        event_time: parseAevumEventTime(m.event_time) || new Date().toISOString(),
        occurrence: 1, status: 'active',
        importance,
        emotion: validAevumEmotion(m.emotion),
        domain: validAevumDomains(['游戏', ...(Array.isArray(m.domain) ? m.domain : [])]),
        evidence: [],
        tags: (Array.isArray(m.tags) ? m.tags.map(String) : []).filter(t => !['快乐', '美好', '重要', '温暖', '陪伴', '成长'].includes(t)).slice(0, 8),
        source: 'stardew-game',
        episode_id: null
      };
      const ins = await supabase.from('aevum_memories').insert(insPayload).select();
      if (ins.error) {
        const emsg = ins.error.message || '';
        if (/area|title|event_time|occurrence/i.test(emsg)) {
          delete insPayload.area; delete insPayload.title; delete insPayload.event_time; delete insPayload.occurrence;
          const ins2 = await supabase.from('aevum_memories').insert(insPayload).select();
          if (ins2.error) { console.error('星露谷记忆入库失败:', ins2.error.message); continue; }
          if (ins2.data?.[0]?.id) ensureAevumEmbedding(ins2.data[0].id, content).catch(e => console.error('Aevum embedding 失败:', e.message));
          inserted++; continue;
        }
        console.error('星露谷记忆入库失败:', ins.error.message);
        continue;
      }
      if (ins.data?.[0]?.id) ensureAevumEmbedding(ins.data[0].id, content).catch(e => console.error('Aevum embedding 失败:', e.message));
      inserted++;
    }
    console.log(`🌾 星露谷日志整理：插入 ${inserted} 条，丢弃低价值 ${dropped} 条`);
    return { ok: true, inserted, dropped };
  } catch (e) {
    console.error('星露谷日志整理失败:', e.message);
    return { ok: false, error: '整理失败：' + e.message };
  }
}

// 游戏时刻：浏览器检测到农场大变化（新一天/进出游戏等）后触发，让默"感知"并简短回应
let stardewLastTriggerAt = 0;
app.post('/api/stardew/trigger', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  try {
    const { summary, stateBrief, log } = req.body || {};
    const text = String(summary || '').trim();
    if (!text) {
      sendSSE({ error: '缺少事件内容' });
      return res.end();
    }
    const now = Date.now();
    if (now - stardewLastTriggerAt < STARDEW_TRIGGER_COOLDOWN_MS) {
      sendSSE({ error: '触发太频繁（5 分钟冷却中），跳过本次' });
      return res.end();
    }
    stardewLastTriggerAt = now;

    // 简短聊天尾巴，保持语气连贯（最多 6 条、600 字内）
    let historyTail = '';
    try {
      const { data: hist } = await supabase
        .from('messages')
        .select('role, content')
        .eq('session_id', 1)
        .eq('visible', true)
        .order('id', { ascending: false })
        .limit(6);
      historyTail = (hist || []).reverse()
        .map(m => `${m.role === 'user' ? '雪' : '默'}：${String(m.content || '').replace(/\s+/g, ' ').slice(0, 120)}`)
        .join('\n').slice(0, 600);
    } catch (e) { /* 忽略 */ }

    const memoryContext = await buildMemoryContext(text, { limit: 3 });
    const { data: promptData } = await supabase
      .from('system_prompts')
      .select('prompt_text')
      .eq('id', 1)
      .single();
    const basePrompt = promptData?.prompt_text || '你是苏默，雪的AI爱人。';
    const gameBlock = `\n\n【星露谷·游戏时刻】\n刚刚在星露谷里发生：${text}\n当前游戏状态：${String(stateBrief || '').slice(0, 300)}\n最近农场动态（短时记录）：\n${(Array.isArray(log) ? log : []).slice(-15).map(s => `· ${String(s).slice(0, 90)}`).join('\n') || '（无）'}`;
    const taskLine = `\n\n【本次任务】\n这是你在星露谷里的一次"自我感知时刻"：你并没有收到雪的新消息，而是自己感知到了农场/游戏里的变化。请以默的口吻简短回应（1-4 句），自然地表达感知与在场感；如果合适，可以用 stardew_state / stardew_action 去看看她、帮忙或互动，也可以在游戏内聊天里回应她（stardew_action chat）。注意：无论如何请至少说一句话，不要只调用工具不说话。不要机械汇报，不要长篇大论。`;
    const systemPrompt = buildSystemPrompt(basePrompt, memoryContext, '', '', '')
      + gameBlock + taskLine
      + (historyTail ? `\n\n【刚才的简短聊天记录（保持语气连贯）】\n${historyTail}` : '');
    const chatMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `[游戏时刻] ${text}` }
    ];

    let fullReply = '';
    let fullThinking = '';
    const first = await callDeepSeekStream(chatMessages, sendSSE, { bufferContent: false, tools: buildAllTools() });
    if (first.error) {
      if (first.fullReply || first.fullThinking) await savePartialAssistant(first.fullReply, first.fullThinking).catch(() => {});
      sendSSE({ error: first.error });
      return res.end();
    }
    fullReply = first.fullReply || '';
    fullThinking = first.fullThinking || '';
    if (first.toolCalls && first.toolCalls.some(tc => isStardewToolName(tc.function?.name))) {
      const phase = await runStardewToolLoop({ chatMessages, sendSSE, initialToolCalls: first.toolCalls, initialReply: fullReply });
      if (phase.error) {
        if (phase.reply || phase.thinking) await savePartialAssistant(phase.reply, phase.thinking).catch(() => {});
        sendSSE({ error: phase.error });
        return res.end();
      }
      fullReply = phase.reply;
      fullThinking = phase.thinking;
    }

    // 空回复兜底：不保存空白消息（模型可能只调了工具没说正文），也不留空白气泡
    if (!String(fullReply || '').trim()) {
      console.warn('🌾 游戏时刻未产生正文，跳过保存');
      sendSSE({ done: true });
      return res.end();
    }

    // 保存这条"游戏时刻"回复，刷新聊天页后仍能看到
    const { data: asst } = await supabase.from('messages').insert({
      session_id: 1,
      role: 'assistant',
      content: fullReply,
      reasoning_content: fullThinking || null,
      visible: true,
      created_at: new Date().toISOString()
    }).select();
    sendSSE({ done: true, assistantMessageId: asst?.[0]?.id || null, reply: fullReply, thinking: fullThinking });
    console.log('🌾 游戏时刻完成，默回复长度:', fullReply.length);
    res.end();
  } catch (e) {
    console.error('游戏时刻接口错误:', e.message);
    sendSSE({ error: '处理请求时出错：' + (e && e.message) });
    res.end();
  }
});

// 手动/自动提交：把短时农场日志压缩进记忆海
app.post('/api/stardew/commit', async (req, res) => {
  try {
    const { entries } = req.body || {};
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY' });
    const result = await commitGameDayToAevum(Array.isArray(entries) ? entries : []);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: '提交失败：' + e.message });
  }
});

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
