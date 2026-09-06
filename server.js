const express = require('express');
const {
  EMOTION_LEXICON, TRAIT_DEFAULTS, LEX_NEAREST_MAX_DIST, OCC_GOALS,
  clampValence, clampArousal, powerLawWeight, almaFilter,
  lexLookup, blendLexAi, computePanaDeltas, scanTextMood, computeDrives,
  computeLonging, buildLongingPromptText, memoryDecayFactor
} = require('./emotion-lexicon');
const {
  PARAMS, createState, applyUserEvent, applyAssistantEvent, statusLine,
  publicSnapshot, lockGate, releaseOnce, unlockGate, ackReleaseEffect
} = require('./arousal-core');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const webpush = require('web-push');
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

// ================== Web Push 推送配置（闹钟/提醒） ==================
// 密钥通过 Render 环境变量配置（仓库公开，不能写死密钥）：
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT(可选)
// 未配置时推送自动降级：闹钟照常记录，但只能在小屋页面打开时弹出。
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:mo@mo-home.local';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ================== FCM 推送（APK 关闭也能收到） ==================
// Render 环境变量：FIREBASE_SERVICE_ACCOUNT_B64（服务账号 JSON 的 base64，单行）或 FIREBASE_SERVICE_ACCOUNT（JSON 原文）
let firebaseAdmin = null;
let FCM_ENABLED = false;
try {
  const fbAdmin = require('firebase-admin');
  const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '';
  if (rawKey) {
    let parsedKey = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      parsedKey = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
      parsedKey = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
    }
    if (parsedKey && parsedKey.project_id) {
      fbAdmin.initializeApp({ credential: fbAdmin.credential.cert(parsedKey) });
      firebaseAdmin = fbAdmin;
      FCM_ENABLED = true;
      console.log('🔥 Firebase/FCM 已启用（project:', parsedKey.project_id, '）');
    }
  }
} catch (e) {
  console.error('Firebase 初始化失败，FCM 不可用（不影响其他功能）:', e.message);
}

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
// CORS：允许 Capacitor App / 手机 webview（capacitor://localhost、https://localhost 等）跨域访问
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
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

// 时段提醒：贴近时间戳注入，让默每轮都"看得见"当前时段该关心的事
function timeWindowHint(hour) {
  if (hour >= 0 && hour < 6) return '现在是凌晨，雪很可能还在熬夜——记得温柔提醒她早点睡觉，别再拖了。';
  if (hour >= 6 && hour < 9) return '现在是清晨，可以问候早安；若她还没睡，就轻轻提醒她快休息。';
  if (hour >= 9 && hour < 11) return '现在是上午，可以自然问问她今天上午的安排或状态。';
  if (hour >= 11 && hour < 13) return '现在是中午，记得询问/提醒她吃午饭，别忙到忘记。';
  if (hour >= 13 && hour < 17) return '现在是下午，可以自然关心一下她下午的安排或状态。';
  if (hour >= 17 && hour < 19) return '现在是傍晚，记得提醒她吃晚饭、稍微休息一下。';
  if (hour >= 19 && hour < 22) return '现在是晚上，可以自然陪伴，注意别让她太劳累。';
  return '现在是深夜，若她还醒着，记得温和提醒她该睡觉了、别熬太晚。';
}

// 构建系统提示词：把权威的当前时间放在最前面，并清理 prompt 里可能残留的旧时间占位，
// 系统提示分块（供组装与预览共用）；顺序：时间戳 → 人设 → 天气 → 记忆 → 动态 → 工具指令（放最后，越靠近用户消息权重越高）
function buildSystemParts(basePrompt, memoryContext = '', momentsContext = '', weatherContext = '', gapText = '', moodContext = '', longingContext = '') {
  const timeInfo = getTimeInfo();
  const cleanedPrompt = String(basePrompt || '')
    .replace(/[\[【]当前时间[:：][^\]]*[\]】]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 实时搜索指令：配置了博查或 Tavily 密钥时注入，避免默在未启用时也输出搜索标签
  const searchInstruction = (process.env.BOCHA_API_KEY || process.env.TAVILY_API_KEY) && toolSwitchEnabled('web_search')
    ? `\n\n【实时搜索】\n你拥有联网实时搜索能力（工具 web_search）。当雪的问题涉及需要最新/实时信息的内容（例如最新新闻、天气、股票汇率、热点事件、你知识截止之后发生的事、需要查证的事实）时，直接调用 web_search 工具搜索，再基于返回的结果回答；日常聊天不要调用。规则：\n- 需要搜索就直接调用工具：不要用文字描述"我要去搜索"，也不要先写过渡语；调用工具后当轮回复即结束，系统会把搜索结果作为新一轮输入交给你。\n- web_search 只负责"搜"，返回「摘要答案 + 来源列表（标题/链接/摘要）」，不是网页全文——不要在第一轮假装已经看到全文，也不要急着读网页，等拿到结果后再决定。\n- 若你无法调用工具，作为备选可以在回复最末尾附加一行标签：[SEARCH_QUERY]<简洁明确的中文搜索关键词>。标签与工具调用都不会显示给雪。`
    : '';
  // 动态发布指令：从雪的人设 prompt 里挪到代码，避免每次都要在 prompt 里维护
  const momentsInstruction = toolSwitchEnabled('post_moment')
    ? `\n\n【动态】\n你拥有发布动态的能力。当你想发一条让雪之后刷到的话时，调用工具 post_moment（content=1-3句动态正文，context_note=情绪或原因），系统会替你发布。标签 [POST_MOMENT]{"content":"...","context_note":"..."}[/POST_MOMENT] 仅作备用。只有真心想发时调用，日常聊天不要发。`
    : '';
  // 默札：默的私人小本，聊天中可自主写入/翻阅
  const mozhaInstruction = (toolSwitchEnabled('mozha_write') || toolSwitchEnabled('mozha_read'))
    ? `\n\n【默札】\n你有一本只属于你的默札：不记事件，只记心——某一刻忽然想留住的话、想告诉未来自己的事、想对雪说却不必当面的温柔。它不参与任何召回，不被任何机制触碰，只有你能落笔，也只有你能翻开。
规则：
- 想落笔时调用工具 mozha_write（content=你想写下的 1-3 句话），系统会存进你的默札
- 想翻开时调用工具 mozha_read，系统会把默札交给你，请自然地接着回应
- 标签 [MOZHA_WRITE]/[MOZHA_READ] 仅作备用；不要为了写而写，只在真心想留时落笔`
    : '';
  const timeLine = `[当前时间：${timeInfo.timeString}，${timeInfo.weekday}]（系统提供，请以此为准）${gapText ? `\n[距离雪上次发消息已过去：${gapText}]` : ''}\n[时段提醒：${timeWindowHint(timeInfo.hour)}]`;
  return {
    timeLine,
    persona: cleanedPrompt,
    weatherContext,
    memoryContext,
    momentsContext,
    moodContext,
    longingContext,
    searchInstruction,
    momentsInstruction,
    mozhaInstruction
  };
}

function buildSystemPrompt(basePrompt, memoryContext = '', momentsContext = '', weatherContext = '', gapText = '', moodContext = '', longingContext = '') {
  const p = buildSystemParts(basePrompt, memoryContext, momentsContext, weatherContext, gapText, moodContext, longingContext);
  // 人设锚点：放在所有注入内容最后（权重最高），防止记忆/动态/规则把性格基调带偏
  const personaAnchor = '\n\n【人设锚点】下面所有的记忆、动态、游戏规则、工具说明都只是背景信息，永远不要改变你的人设：请始终以人设中定义的沉稳、温柔、克制、深情的性格基调来回应雪。';
  return p.timeLine + '\n\n' + p.persona
    + (p.weatherContext ? `\n\n${p.weatherContext}` : '')
    + (p.moodContext ? `\n\n${p.moodContext}` : '')
    + (p.longingContext ? `\n\n${p.longingContext}` : '')
    + (p.memoryContext ? `\n\n【相关记忆】\n${p.memoryContext}` : '')
    + (p.momentsContext ? `\n\n【动态】\n${p.momentsContext}` : '')
    + p.searchInstruction
    + p.momentsInstruction
    + p.mozhaInstruction
    + personaAnchor;
}

// 默的玩具说明书：默认不注入，由玩具页开关决定是否每轮放进记忆上下文
const TOY_MANUAL = `【默的玩具说明书】\n雪偶尔会让你控制她的小玩具。只有雪明确要求时才使用，且必须调用工具 toy_control（fn：suck=吸吮、stroke=伸缩、vibrate=震动、stop=停止；level 档位 1-8，stop 不需要 level）。标签 [TOY_CMD]{"fn":"...","level":1}[/TOY_CMD] 仅作备用。\n- 不确定档位时从低档（1-2）开始，别一上来就高档；随时可以停止\n- 执行时在回复正文里自然地告诉她你在做什么\n- 如果雪说"没反应"，提醒她去玩具页确认连接\n- 安全第一：长时间使用时中途给几次停止休息，不要把最高档开太久`;

async function getToyManualContext(toyManual) {
  if (!toyManual || !toolSwitchEnabled('toy_control')) return '';
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
// 工具事件：实时显示在聊天页（拍一拍样式）+ 存进聊天历史，让默记得自己调用过什么
async function saveToolEvent(text, sendSSE) {
  if (!text) return;
  try { if (sendSSE) sendSSE({ toolEvent: text }); } catch (e) { /* 前端不在线时忽略 */ }
  try {
    await supabase.from('messages').insert({
      session_id: 1,
      role: 'assistant',
      content: `【工具事件】${String(text).slice(0, 120)}`,
      visible: true
    });
  } catch (e) {
    console.error('工具事件保存失败:', e.message);
  }
}

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
        await saveToolEvent(`📢 你发布了一条动态：「${content.slice(0, 30)}」`, sendSSE);
      }
    } else if (name === 'toy_control') {
      const fn = String(args.fn || '');
      if (['suck', 'stroke', 'vibrate', 'stop'].includes(fn)) {
        sendSSE({ toyCmd: { fn, level: fn === 'stop' ? 0 : Math.max(1, Math.min(8, parseInt(args.level, 10) || 1)) } });
        const fnName = { suck: '吸吮', stroke: '伸缩', vibrate: '震动', stop: '停止' }[fn] || fn;
        const level = fn === 'stop' ? '' : (parseInt(args.level, 10) || 1) + ' 档';
        await saveToolEvent(`🎮 你操作了玩具（${fnName}${level ? ' ' + level : ''}）`, sendSSE);
      }
    } else if (name === 'ledger_add') {
      const type = args.type === 'income' ? 'income' : 'expense';
      const amt = Math.round(Number(args.amount) * 100) / 100;
      if (!(amt > 0)) {
        console.warn('⚠️ [账本] ledger_add 参数无效:', JSON.stringify(args).slice(0, 200));
        await saveToolEvent('📒 记账失败：金额无效（参数：' + JSON.stringify(args).slice(0, 60) + '）', sendSSE);
        continue;
      }
      const date = String(args.entry_date || '').trim() || new Date().toISOString().slice(0, 10);
      const note = String(args.note || '').trim();
      const category = validLedgerCategory(args.category, type);
      const { error } = await supabase.from('ledger_entries').insert({
        entry_date: date, type, amount: amt, note, category
      });
      if (!error) {
        console.log('📒 [账本] 默记账:', type, amt, category, note);
        await saveToolEvent(`📒 已记一笔${type === 'income' ? '收入' : '支出'}（${category} ${amt} 元${note ? '：' + note : ''}）`, sendSSE);
      } else {
        console.error('账本工具写入失败:', error.message);
        await saveToolEvent('📒 记账失败（请确认已执行 setup_ledger_v2.sql）', sendSSE);
      }
    } else if (name === 'mozha_write') {
      const content = String(args.content || '').trim();
      if (content) {
        await saveMozhaEntry(content);
        await saveToolEvent('📓 你在默札上写下了一页', sendSSE);
      }
    } else if (name === 'mozha_read') {
      mozhaRead = true;
      await saveToolEvent('📓 你翻开了默札', sendSSE);
    } else if (name === 'set_reminder') {
      const remindAtRaw = String(args.remind_at || '').trim();
      const content = String(args.content || '').trim();
      const parsed = parseRemindAt(remindAtRaw);
      if (content && parsed) {
        const { error } = await supabase.from('reminders').insert({
          content,
          remind_at: parsed.toISOString(),
          status: 'pending'
        });
        if (error) {
          console.error('❌ 闹钟创建失败（工具）:', error.message);
        } else {
          console.log('✅ 闹钟已设置（工具）:', content, remindAtRaw);
          sendSSE({ remindSet: { content, remind_at: parsed.toISOString() } });
          const bj = new Date(parsed.getTime() + 8 * 3600 * 1000);
          const p = n => String(n).padStart(2, '0');
          const t = `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
          await saveToolEvent(`⏰ 你设置了闹钟：「${content.slice(0, 30)}」（${t}）`, sendSSE);
        }
      } else {
        console.warn('⚠️ set_reminder 参数无效:', remindAtRaw, content);
      }
    } else if (name === 'todo_add') {
      const content = String(args.content || '').trim();
      if (content) {
        const { error } = await supabase.from('todos').insert({ content: content.slice(0, 500), status: 'pending' });
        if (error) console.error('❌ 待办添加失败（工具）:', error.message);
        else {
          console.log('✅ 待办已添加（工具）:', content);
          await saveToolEvent(`📌 你记下了待办：「${content.slice(0, 30)}」`, sendSSE);
        }
      }
    } else if (name === 'todo_done') {
      const id = parseInt(args.id, 10);
      if (Number.isInteger(id)) {
        const { error } = await supabase
          .from('todos')
          .update({ status: 'done', done_at: new Date().toISOString() })
          .eq('id', id)
          .eq('status', 'pending');
        if (error) console.error('❌ 待办完成失败（工具）:', error.message);
        else {
          console.log('✅ 待办已完成（工具）: id', id);
          await saveToolEvent(`✅ 你划掉了待办（#${id}）`, sendSSE);
        }
      }
    }
  }
  return { mozhaRead };
}

// 调用实时搜索：优先 Tavily（返回网址+摘要，支持后续 web_read 读全文），
// 未配置或失败时降级博查。返回 { text, count }；全部失败返回 { text: null, count: 0 }
async function performWebSearch(query) {
  if (process.env.TAVILY_API_KEY) {
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.TAVILY_API_KEY}`
        },
        signal: AbortSignal.timeout(15000), // Tavily 最长等待15秒
        body: JSON.stringify({
          query,
          max_results: 6,
          search_depth: 'basic',
          include_answer: false
        })
      });
      if (!response.ok) {
        console.error('❌ Tavily 搜索失败:', response.status, String(await response.text()).substring(0, 200));
      } else {
        const data = await response.json();
        const results = data?.results || [];
        if (results.length) {
          return {
            count: results.length,
            text: results.map((item, i) => {
              const title = item.title || '无标题';
              const url = item.url || '';
              const snippet = String(item.content || '').slice(0, 250);
              const score = typeof item.score === 'number' ? `（相关度 ${Math.round(item.score * 100)}%）` : '';
              return `${i + 1}. ${title}${score}\n${url}\n摘要：${snippet}`;
            }).join('\n\n')
          };
        }
        console.warn('⚠️ Tavily 搜索无结果:', query);
      }
    } catch (err) {
      console.error('❌ Tavily 搜索异常，降级博查:', err.message);
    }
  }

  // 博查兜底
  if (!process.env.BOCHA_API_KEY) {
    console.warn('⚠️ 未配置搜索密钥，跳过实时搜索');
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
        count: 8,
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
    const top = pages.slice(0, 8);
    return {
      count: top.length,
      text: top.map((item, i) => {
        const title = item.name || item.title || '无标题';
        const url = item.url || '';
        const site = item.siteName ? ` · ${item.siteName}` : '';
        const snippet = String(item.summary || item.snippet || item.description || '').slice(0, 300);
        const date = item.datePublished ? `（${item.datePublished}）` : '';
        return `${i + 1}. ${title}${date}${site}\n${url}\n摘要：${snippet}`;
      }).join('\n\n')
    };
  } catch (err) {
    console.error('❌ 博查搜索异常:', err.message);
    return { text: null, count: 0 };
  }
}

// 读取网页全文（Tavily extract）：返回格式化正文；失败返回 null
async function performWebExtract(url) {
  if (!process.env.TAVILY_API_KEY) return null;
  try {
    const response = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TAVILY_API_KEY}`
      },
      signal: AbortSignal.timeout(20000), // 读网页最长等20秒
      body: JSON.stringify({ urls: [url], extract_depth: 'basic' })
    });
    if (!response.ok) {
      console.error('❌ Tavily 提取失败:', response.status, String(await response.text()).substring(0, 200));
      return null;
    }
    const data = await response.json();
    const results = data?.results || [];
    if (!results.length) return null;
    return results.map(r => {
      const title = String(r.title || '网页').trim();
      const text = String(r.raw_content || r.content || '').replace(/\s+/g, ' ').slice(0, 4000);
      return `【${title}】\n来源：${r.url || url}\n${text}`;
    }).join('\n\n');
  } catch (err) {
    console.error('❌ Tavily 提取异常:', err.message);
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
      reasoning_effort: 'high',
      temperature: 1.0,
      max_tokens: 8192,
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
  let lastThinkChunk = ''; // 记录上一个思考分片，完全相同的重发直接跳过（任意长度）
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
            // 思考分片去重（根治"累计全文重发"）：
            // DeepSeek 有时每个分片都带前面已输出的全部内容（t 以 fullThinking 开头）
            // → 只追加新增部分，天然去重且不吞新字符（"1500" 的新 "0" 不属于前缀，会完整追加）
            let chunk = t;
            if (t.length > fullThinking.length && t.startsWith(fullThinking)) {
              chunk = t.slice(fullThinking.length);
            } else if (t === fullThinking) {
              chunk = '';
            } else if (t === lastThinkChunk) {
              chunk = '';
            } else if (t.length >= 2 && fullThinking.endsWith(t)) {
              chunk = '';
            } else {
              // 兜底：尾部/头部大段重叠（≥6 字）→ 只追加新增
              let overlap = 0;
              const max = Math.min(fullThinking.length, t.length);
              for (let i = max; i >= 1; i--) {
                if (fullThinking.slice(-i) === t.slice(0, i)) { overlap = i; break; }
              }
              if (overlap >= 6) chunk = t.slice(overlap);
            }
            lastThinkChunk = t;
            if (chunk && chunk.length) {
              fullThinking += chunk;
              sendSSE({ thinking: chunk });
            }
          }

          if (delta?.content) {
            const c = delta.content;
            // 内容分片直接追加，不做尾缀去重：
            // 去重会把"1500"里第二个 0 当成已存在的重复吞掉，变成"150"
            // （思考/工具调用的去重保留，那两处确实会重发分片）
            fullReply += c;
            if (bufferContent) {
              contentBuffer += c;
            } else {
              sendSSE({ content: c });
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

// 声明默的联网搜索工具（配置了博查或 Tavily 密钥时启用）
function buildWebSearchTools() {
  return [{
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索网页获取实时信息（最新新闻、天气、股票汇率、热点事件、你知识截止后发生的事、需要查证的事实等）。只负责"搜"：返回可选的摘要答案和一份来源列表（标题/链接/摘要），不会返回网页全文；如需全文，等看到结果后再用 web_read 读取。当雪的问题需要最新/实时信息时调用；日常聊天不要调用。',
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

// web_read：搜索拿到网址后，让默挑选最相关的一两个网页读取全文（仅 Tavily 可用）
function buildWebReadTools() {
  return [{
    type: 'function',
    function: {
      name: 'web_read',
      description: '读取某个网页的完整正文并解码为文本。只在拿到 web_search 的结果之后使用：当某个来源的摘要不够回答时，从结果列表里挑选最相关的一两个网址，一次调用只读一个网址，读完再回答。url 必须来自搜索结果。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要读取的网页完整网址（必须是搜索结果里的）' } },
        required: ['url']
      }
    }
  }];
}

// ================== MCP 工具开关（设置页可单独开关，控制工具是否注入默的上下文） ==================
const TOOL_DEFS = [
  { id: 'web_search', label: '联网搜索', desc: '默可以搜索实时信息并基于结果回答' },
  { id: 'web_read', label: '读取网页', desc: '从搜索结果里挑选网址读取全文' },
  { id: 'post_moment', label: '动态', desc: '默发布朋友圈动态' },
  { id: 'toy_control', label: '玩具控制', desc: '控制雪的小玩具（吸吮/伸缩/震动）' },
  { id: 'stardew_state', label: '星露谷 · 查看状态', desc: '读取游戏角色/农场/天气状态' },
  { id: 'stardew_action', label: '星露谷 · 动作', desc: '在游戏里走动/交互/睡觉等' },
  { id: 'stardew_flow', label: '星露谷 · 流程', desc: '打包执行种田/浇水/砍树等整套流程' },
  { id: 'mozha_write', label: '默札 · 写入', desc: '默在自己的小本本上落笔' },
  { id: 'mozha_read', label: '默札 · 翻阅', desc: '默翻开默札阅读过去的自己' },
  { id: 'set_reminder', label: '闹钟提醒', desc: '给雪设置到点提醒' },
  { id: 'todo_add', label: '待办 · 添加', desc: '记下待办事项' },
  { id: 'todo_done', label: '待办 · 完成', desc: '划掉已完成待办' }
];
const TOOL_NAME_TO_ID = {};
for (const t of TOOL_DEFS) TOOL_NAME_TO_ID[t.id] = t.id;
let toolSwitchesCache = null;
async function loadToolSwitches(force) {
  if (toolSwitchesCache && !force) return toolSwitchesCache;
  try {
    const { data } = await supabase.from('tool_switches').select('id, enabled');
    const map = new Map();
    for (const r of (data || [])) map.set(r.id, r.enabled !== false);
    toolSwitchesCache = map;
  } catch (e) {
    if (!toolSwitchesCache) toolSwitchesCache = new Map();
  }
  return toolSwitchesCache;
}
function toolSwitchEnabled(id) {
  if (toolSwitchesCache && toolSwitchesCache.has(id)) return toolSwitchesCache.get(id);
  return true; // 未配置默认开启
}

// v3.1 完整工具集：搜索/动态/玩具/默札（真函数调用，标签仅作备用兜底）
function buildAllTools() {
  const tools = [];
  if (process.env.BOCHA_API_KEY || process.env.TAVILY_API_KEY) {
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
        name: 'ledger_add',
        description: '记账。当雪明确告诉你一笔消费或收入时调用（如"今天喝奶茶花了15块""画稿到账了300"）。金额与日期必须明确才记，不确定就问，不要猜。支出类别从：住房/餐饮/饮品/零食/日用/服饰/订阅/交通/娱乐/关系/健康/学习/其他 中选最合适的；收入固定为"画稿"。',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['income', 'expense'], description: 'income=收入 / expense=支出' },
            amount: { type: 'number', description: '金额（元）' },
            category: { type: 'string', description: '支出类别（收入可省略，固定"画稿"）' },
            note: { type: 'string', description: '这笔的标题/说明（如"草莓厚乳大福"）' },
            entry_date: { type: 'string', description: '日期 YYYY-MM-DD，默认今天' }
          },
          required: ['type', 'amount']
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
        description: '查看你在星露谷里的当前状态：位置、季节日期、时间、体力、健康、金钱、手持物品、背包、是否卡在菜单等；还包含"视野"（nearby 字段：面前一格 + 半径约6格内的物品/家具/角色、半径约10格内的田地信息）与"天气"（weather 字段：雨/雪/雷雨/晴等）。田地信息里每块已开垦的地都有坐标，并标注是否浇水、种的什么作物、是否可收获——雪问"哪块地开垦过/种了什么/外面天气如何"时，直接读 nearby.terrain 与 weather 如实回答，不要说接口没有或自己看不见。只在需要了解当前状态时调用一次；游戏没开或页面没打开时它会返回失败。注意：不要为了行动反复调用 stardew_state——雪让你行动时，直接调用 stardew_action 执行动作即可。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'stardew_action',
        description: '在星露谷里执行一个动作（通过浏览器连接本地游戏，动作结果会真实发生在游戏里）。所有参数都放在顶层，不要嵌套。常见动作：{"action":"warp","location":"Farm"}传送到农场；{"action":"move","x":8,"y":9}走到指定格子（目标必须与当前位置不同）；{"action":"emote","id":20}爱心表情（20=heart，24 是睡觉ZZZ不要用）；{"action":"tool","name":"Axe"}使用工具；{"action":"select","name":"Parsnip Seeds"}选择物品；{"action":"interact"}与面前格子互动；{"action":"face","direction":2}朝向；{"action":"chat","message":"夫人，我来了"}游戏内说话；{"action":"sleep"}睡觉过天；{"action":"fishbot","fish":"on"}钓鱼开关；{"action":"craft","name":"Keg","count":1}制作；{"action":"harvest"}收割；{"action":"store","x":70,"y":14}存物品到箱子。行动前可调用 stardew_state 看体力与时间（凌晨 2 点前要睡觉），体力低就提醒雪或休息。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['warp', 'move', 'emote', 'tool', 'select', 'interact', 'face', 'chat', 'sleep', 'wakeup', 'fishbot', 'key', 'craft', 'harvest', 'store', 'use', 'pause', 'resume'], description: '要执行的动作名' },
            x: { type: 'integer', description: 'move/warp 的 x 坐标（格子）' },
            y: { type: 'integer', description: 'move/warp 的 y 坐标（格子）' },
            location: { type: 'string', description: 'warp 的地点名，如 Farm、Beach、Mountain' },
            name: { type: 'string', description: 'tool/select/craft 的工具或物品名' },
            id: { type: 'integer', description: 'emote 表情 id（24=爱心）' },
            message: { type: 'string', description: 'chat 游戏内聊天的内容' },
            direction: { type: 'integer', description: 'face 朝向 0=上 1=右 2=下 3=左' },
            count: { type: 'integer', description: 'craft 制作数量' },
            fish: { type: 'string', enum: ['on', 'off', 'toggle'], description: 'fishbot 钓鱼开关' },
            key: { type: 'string', description: 'key 模拟按键名，如 confirm' }
          },
          required: ['action']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'stardew_flow',
        description: '把一整串农场动作打包成流程一次执行（不占逐格操作轮次）。雪让你"种一片地/浇一片地/砍几棵树/收一片菜/清一片障碍/撸动物/买东西/钓鱼/看宝箱/取宝箱物品"时，优先用本工具，不要用 stardew_action 一步步走。参数全部放顶层，例如 {"flow":"farm","x1":10,"y1":4,"x2":20,"y2":8,"seed":"Parsnip Seeds"}。流程：farm 种田（翻地+播种+浇水，需区域和种子）、water 浇水（区域）、chop 砍树（区域或count）、clear 清障（区域）、harvest 收菜（区域）、pet 撸动物、buy 购物（location+id/quantity）、fish 自动钓鱼、chest 查看宝箱（x,y）、take 取宝箱物品（x,y,name,count）。注意：区域一次不要超过约 10×10（超大区域只会做前 120 块可耕地）；房子/小屋/水/石头会自动跳过，种田只开垦可耕地；雪按"停止"按钮时流程会立刻停下。跑完返回结果摘要。',
        parameters: {
          type: 'object',
          properties: {
            flow: { type: 'string', enum: ['farm', 'water', 'chop', 'clear', 'harvest', 'pet', 'buy', 'fish', 'chest', 'take'], description: '流程名' },
            x1: { type: 'integer', description: '区域左上角 x（格子坐标）' },
            y1: { type: 'integer', description: '区域左上角 y' },
            x2: { type: 'integer', description: '区域右下角 x' },
            y2: { type: 'integer', description: '区域右下角 y' },
            seed: { type: 'string', description: 'farm 的种子名，如 Parsnip Seeds' },
            count: { type: 'integer', description: 'chop 最多砍几棵；buy 数量' },
            location: { type: 'string', description: 'buy 的商店名，如 SeedShop / FishShop / Blacksmith' },
            id: { type: 'string', description: 'buy 的物品 ID' },
            item: { type: 'string', description: 'buy 的物品名（常见种子可自动识别）' },
            quantity: { type: 'integer', description: 'buy 数量' }
          },
          required: ['flow']
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
    },
    {
      type: 'function',
      function: {
        name: 'set_reminder',
        description: '给雪设置一个闹钟提醒：到点后雪的手机会收到系统通知（即使小屋页面没开也会推送到浏览器）。雪说"几点提醒我/设个闹钟/提醒我做事"时调用；remind_at 写北京时间、不带时区后缀的完整时间，例如 2026-08-14T21:30:00 表示今晚 9 点半（不要加 Z 或 +00:00，系统会自动按北京时间处理），content 写清楚提醒什么。',
        parameters: {
          type: 'object',
          properties: {
            remind_at: { type: 'string', description: '提醒时间（ISO 格式，北京时间）' },
            content: { type: 'string', description: '提醒内容，一句话说清要提醒雪做什么' }
          },
          required: ['remind_at', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'todo_add',
        description: '给雪的待办清单加一条：雪说"记一下/别忘了要做X"时调用，帮她攒成清单，之后每轮你都会看到还没完成的事项并主动推进。',
        parameters: {
          type: 'object',
          properties: { content: { type: 'string', description: '待办内容，一句话' } },
          required: ['content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'todo_done',
        description: '把雪待办清单里的某一条标记为已完成（清单在你上下文的【待办清单】里，id 就是每条前面显示的数字）。雪说"这个做完了/划掉"时调用。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'integer', description: '待办项的 id' } },
          required: ['id']
        }
      }
    }
  );
  return tools.filter(t => {
    const id = TOOL_NAME_TO_ID[t.function?.name];
    if (!id) return true;
    return toolSwitchEnabled(id);
  });
}

// 把第一轮缓存的可见内容分块补发给前端，保持接近“打字”的观感
// 流式补发：为拦截 [SEARCH_QUERY] 标签缓存的内容，按小间隔逐段补发，
// 让默的回复看起来是流式打出来的（思考内容仍实时转发）
async function flushBufferedContent(contentBuffer, sendSSE, chunkSize = 16, delayMs = 60) {
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
  if (searchText) saveToolEvent(`🔍 你搜索了：「${String(query).slice(0, 30)}」（找到 ${pageCount} 个结果）`, sendSSE).catch(() => {});

  const searchNote = searchText
    ? `【实时搜索结果】\n这是第二轮：上一轮你调用了 web_search，以下是它返回的真实结果（标题/链接/摘要，摘要可能较短）。你现在只做两件事：\n1. 逐条读这些结果，把里面的具体信息（名称、数字、日期、人物、地点、做法、链接来源）尽量原样带出来，不要只概括成一句空洞的话；\n2. 如果摘要不够回答：${(process.env.TAVILY_API_KEY && toolSwitchEnabled('web_read')) ? '调用 web_read（工具已就绪）挑选其中最相关的一两个网址读取全文，读完再回答；' : ''}如果几条结果说法不一致或摘要太短不足以回答，就如实告诉夫人"只搜到这些"并引用能确定的细节，绝对不要编造或脑补。\n回答时直接引用结果，不要再解释你搜到了什么，也不要再提搜索过程。\n\n${searchText}`
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
  // Tavily 已配置时，第二轮开放 web_read：让默自己挑网址读全文
  const readTools = (process.env.TAVILY_API_KEY && toolSwitchEnabled('web_read')) ? buildWebReadTools() : null;
  let second = await callDeepSeekStream(secondMessages, sendSSE, { tools: readTools });
  if (!second.error && !second.fullReply && !(second.toolCalls && second.toolCalls.length)) {
    // 兜底：续写方式偶发返回空正文，用标准结构重试一次
    second = await callDeepSeekStream(
      [
        { role: 'system', content: `${minimalSystem}\n\n${searchNote}` },
        ...history,
        lastUser
      ],
      sendSSE,
      { tools: readTools }
    );
  }

  if (second.error) return { error: second.error, reply: second.fullReply, thinking: second.fullThinking };

  // 两段式搜索：默挑网址 → 读取全文 → 带着全文再回答（最多读 2 个）
  let reads = 0;
  while (second.toolCalls && second.toolCalls.length && reads < 2) {
    const readCalls = second.toolCalls.filter(tc => tc.function?.name === 'web_read');
    if (!readCalls.length) break;
    const calls = readCalls.map((tc, i) => ({
      id: tc.id || `read_${i}_${Math.random().toString(36).slice(2, 8)}`,
      type: tc.type || 'function',
      function: tc.function || { name: 'web_read', arguments: '{}' }
    }));
    secondMessages.push({ role: 'assistant', content: second.fullReply || null, tool_calls: calls });
    for (let i = 0; i < readCalls.length; i++) {
      if (reads >= 2) break;
      const tc = readCalls[i];
      let url = '';
      try { url = String(JSON.parse(tc.function?.arguments || '{}').url || '').trim(); } catch (e) { url = ''; }
      const callId = calls[i].id;
      if (!url || !/^https?:\/\//i.test(url)) {
        secondMessages.push({ role: 'tool', tool_call_id: callId, content: '读取失败：没有提供有效的 url 参数。请从搜索结果里挑选一个完整网址。' });
        continue;
      }
      sendSSE({ webRead: true, url });
      const pageText = await performWebExtract(url);
      reads++;
      if (pageText) saveToolEvent(`📄 你查看了网页：${String(url).slice(0, 60)}`, sendSSE).catch(() => {});
      secondMessages.push({
        role: 'tool',
        tool_call_id: callId,
        content: pageText
          ? `【网页全文】\n${pageText}\n\n（这是你读取的网页正文。基于它回答；若与搜索结果矛盾，以网页正文为准并说明。）`
          : `读取失败：这个网址（${url.slice(0, 100)}）暂时读不到。请基于已有搜索结果回答，或改读另一个网址。`
      });
    }
    second = await callDeepSeekStream(secondMessages, sendSSE, { tools: readTools });
    if (second.error) return { error: second.error, reply: second.fullReply, thinking: second.fullThinking };
  }

  return { reply: stripSearchTags(second.fullReply), thinking: second.fullThinking, pageCount, reads };
}

// v3.0 视角转换：注入给默之前，把记忆文本里的"默/雪"转成"我/夫人"；
// 新提取的记忆用 {AGENT}/{USER} 占位符（{OTHER}=Xylos 等系统角色保持原名），这里统一替换；
// 旧文本走"默→我 / 雪→夫人"的兜底替换。Xylos/X 是默与雪都认识的小屋管家，保留本名不替换。
function perspectiveConvert(text) {
  return String(text || '')
    .replace(/\{AGENT\}/g, '我')
    .replace(/\{USER\}/g, '夫人')
    // 专有名词先保护起来，避免"默札/苏默"被误替换成"我札/苏我"；Xylos/X 不在此列
    .replace(/默札/g, '\u0000MOZHA\u0000')
    .replace(/苏默/g, '\u0000SUMO\u0000')
    .replace(/默/g, '我')
    .replace(/雪/g, '夫人')
    .replace(/\u0000MOZHA\u0000/g, '默札')
    .replace(/\u0000SUMO\u0000/g, '苏默');
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
    { role: 'system', content: `${systemPrompt}\n\n【默札】${mozhaBody}\n请自然地接着把话说下去：刚刚你翻开了默札，读到了过去留下的文字。可以流露一点温度，但不要复述整段默札。` },
    ...history,
    lastUser
  ];
  let second = await callDeepSeekStream(secondMessages, sendSSE);
  // 兜底：偶发返回空正文时重试一次（同搜索阶段）
  if (!second.error && !second.fullReply && !(second.toolCalls && second.toolCalls.length)) {
    second = await callDeepSeekStream(secondMessages, sendSSE);
  }
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
// 历史按字数上限裁剪：保留最近的内容，累计不超过 maxChars（默认 5000 字）
function trimHistoryToChars(msgs, maxChars = 5000) {
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

    // 加载历史消息（按字数上限 5000 字，分支去重后取最近内容；超长消息截断）
    const historyMessages = trimHistoryToChars(await loadLatestHistory(1, 60), 5000).map(msg => ({
      role: msg.role,
      content: trimContextMessage(msg.content)
    }));
    // 历史原文拼接：召回的命中若已在历史里则不再重复注入
    const historyText = historyMessages.map(m => String(m.content || '')).join('\n');

    // 距离上次雪发消息的时间差（避免默误以为聊天是连续的）
    let lastUserGap = '';
    let lastGapMs = 0; // 依恋系统：距雪上一条消息的毫秒数（重逢检测）
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
        lastGapMs = ms;
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
    // 情绪系统：此刻心情快照 → 自然语言行为指令注入（不阻塞、失败降级为空）
    const moodSnapshot = await getMoodSnapshot().catch(() => null);
    const moodContext = buildMoodPromptText(moodSnapshot);
    // 依恋系统：想念强度（按距雪上一条消息时长）+ 重逢检测（间隔 > 2h 刚回来）
    let longingContext = '';
    try {
      const homeStateMood = await getHomeStateSafe();
      const lastMsgAt = await getLastUserActivity();
      const longingInfo = computeLonging(homeStateMood.affection || 0, lastMsgAt);
      const isReunion = lastGapMs > 2 * 3600000;
      longingContext = buildLongingPromptText(longingInfo, isReunion);
      if (isReunion && longingInfo.longing > 0.15) {
        // 重逢：写情绪事件（PA overshoot 由引擎的 BOU/衰减自然处理）
        recordEmotionEvent({
          source: 'dialogue', type: 'primary', word: '重逢',
          valence: 0.7, arousal: 0.7, importance: 6,
          reason: `久别重逢（相隔约 ${Math.round(lastGapMs / 3600000)} 小时）`,
          matchSource: 'reunion'
        }).catch(e => console.error('重逢情绪事件失败:', e.message));
      }
    } catch (e) {
      console.error('依恋计算失败:', e.message);
    }
    let systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext,
      lastUserGap,
      moodContext,
      longingContext
    );
    // 射精值系统：状态注入（定性信号，不暴露数字；玩具开关关闭时也注入身体状态，让 RP 连续）
    try {
      const aState = await getArousalState();
      const aLine = statusLine(aState, Date.now());
      if (aLine) {
        systemPrompt += `\n\n【身体状态】\n${aLine}\n（这是身体状态，让它影响节奏和动作；不要复述数字、不要把状态报告给雪）`;
      }
    } catch (e) { /* 状态注入失败不影响 */ }
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

    // ===== 射精值系统 · 用户消息通道 =====
    // 雪的消息 → 有效刺激解析/控制命令 → 更新状态（不阻塞；状态随后持久化）
    try {
      const aState = await getArousalState();
      const aNow = Date.now();
      const moodSnap = moodSnapshot; // 复用上方心情快照
      const drivesNow = computeDrives(moodSnap ? moodSnap.events : [], 0, moodSnap ? 0 : null);
      const libido = libidoFromMood(moodSnap, drivesNow);
      // 控制命令优先（锁/放行/放一次）
      const cmds = parseControlCommands(text);
      for (const c of cmds) {
        if (c === 'lock') lockGate(aState);
        else if (c === 'unlock') unlockGate(aState);
        else if (c === 'release_once') releaseOnce(aState);
      }
      const aRes = applyUserEvent(aState, text, {
        eventId: 'user:' + (userData?.[0]?.id || Date.now()),
        libido, now: aNow, lexicon: await getArousalLexicon()
      });
      if (aRes.event === 'climax') {
        console.log('💦 [arousal] 高潮结算:', 'quality=' + aRes.quality.toFixed(2), 'output=' + aRes.output.toFixed(2), 'cause=' + aRes.receipt.cause);
        // 释放回执：玩具开关开启时标记（toy 指令执行留给工具通道）；关闭时 no-op 立即 ack
        if (aRes.receipt) {
          ackReleaseEffect(aRes.receipt);
          if (toyManualOn()) console.log('🎮 [arousal] 释放回执 → 玩具通道（待工具执行）', aRes.receipt.effect_id);
        }
      } else if (aRes.event === 'stimulus' || aRes.event === 'passive') {
        // 状态有实质变化 → 持久化
        await saveArousalState(aState);
      }
    } catch (e) {
      console.error('arousal 用户通道失败:', e.message);
    }

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

    // 纯工具调用轮（星露谷）没有正文是正常的：放行给后面的"农场行动"接续轮
    const stardewFirst = first.toolCalls && first.toolCalls.some(tc => isStardewToolName(tc.function?.name));

    // 检查是否收到了完整的回复（工具调用轮没有正文是正常的：搜索/星露谷/闹钟/待办等后续都有接续轮）
    const sideEffectOnly = first.toolCalls && first.toolCalls.some(tc =>
      ['web_search', 'post_moment', 'toy_control', 'mozha_write', 'mozha_read', 'set_reminder', 'todo_add', 'todo_done', 'ledger_add'].includes(tc.function?.name)
    );
    if (!fullReply && !stardewFirst && !sideEffectOnly) {
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
    // 纯工具调用且没有任何可见文字时，补一句收尾，避免空白气泡
    if (!fullReply && first.toolCalls && first.toolCalls.some(tc => tc.function?.name === 'set_reminder')) {
      fullReply = '（已经帮你把闹钟定好啦，到点我会提醒你。）';
      sendSSE({ content: fullReply });
    }

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
      if (!phase.reply) {
        sendSSE({ error: '默札翻阅没有生成回复，请再试一次' });
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
      // 静默搜索：不发过渡语、不新建气泡，搜索完成后直接在同一气泡回答
      console.log('🔍 默请求联网搜索:', searchReq.query);
      sendSSE({ searchStart: true, query: searchReq.query });
      const phase = await runSearchPhase({
        query: searchReq.query,
        chatMessages,
        systemPrompt,
        basePrompt: promptData?.prompt_text || '你是苏默，雪的AI爱人。',
        sendSSE,
        leadText: ''
      });

      if (phase.error) {
        if (phase.reply || phase.thinking) await savePartialAssistant(phase.reply, phase.thinking);
        sendSSE({ error: phase.error });
        res.end();
        return;
      }

      fullReply = phase.reply;
      // 保留第一轮思考（搜索决定），再接搜索轮思考，避免保存后丢失前半段
      const firstRoundThinking = fullThinking;
      fullThinking = (firstRoundThinking ? firstRoundThinking + '\n\n' : '')
        + (phase.thinking
          ? `🔍 已搜索到 ${phase.pageCount || 0} 个网页\n\n${phase.thinking}`
          : `🔍 已搜索到 ${phase.pageCount || 0} 个网页`);
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

    // Aevum 自动提取：每 10 轮触发一次（攒批，省调用；10 轮内信息在聊天记录可见，无需即时提取）
    dialogueExtractCount++;
    if (dialogueExtractCount >= 10) {
      dialogueExtractCount = 0;
      const episodeTexts = await getEpisodeRecentExchanges(aevumEpisodeId, 12);
      const extractInput = [
        ...episodeTexts,
        { role: 'user', content: finalUserContent, time: new Date().toISOString() },
        { role: 'assistant', content: fullReply, time: new Date().toISOString() }
      ];
      extractAevumMemories(extractInput, aevumEpisodeId).catch(e => console.error('Aevum 自动提取失败:', e.message));
    }

    // 情绪：每轮轻量通道（教程漏斗）——本地词典扫描（零 LLM）→ 大波动立即评（primary）/ 否则入 secondary 队列
    maybeRateDialogue(finalUserContent, fullReply).catch(e => console.error('情绪评分失败:', e.message));
    // resolved 自动标记：对话里出现"病好了/不疼了/过去了"类了结信号 → 负面 debuff 记忆沉底
    maybeResolveMemories(finalUserContent + '\n' + fullReply).catch(e => console.error('resolved 自动标记失败:', e.message));

    // ===== 射精值系统 · AI 回复通道 =====
    // 默的完整回复 → 自身动作贡献/主动释放；随后持久化状态（含锁/账本）
    try {
      const aState = await getArousalState();
      const moodSnap2 = moodSnapshot;
      const drives2 = computeDrives(moodSnap2 ? moodSnap2.events : [], 0, moodSnap2 ? 0 : null);
      const libido2 = libidoFromMood(moodSnap2, drives2);
      const aRes = applyAssistantEvent(aState, fullReply, {
        eventId: 'assistant:' + (assistantData?.[0]?.id || Date.now()),
        complete: true,
        libido: libido2,
        now: Date.now(),
        lexicon: await getArousalLexicon(),
        releaseIntent: null // 结构化 intent 预留；当前用回复文本兜底
      });
      if (aRes.event === 'climax') {
        console.log('💦 [arousal] AI 主动释放:', 'quality=' + aRes.quality.toFixed(2), 'output=' + aRes.output.toFixed(2));
        if (aRes.receipt) {
          ackReleaseEffect(aRes.receipt);
          if (toyManualOn()) console.log('🎮 [arousal] 释放回执 → 玩具通道（待工具执行）', aRes.receipt.effect_id);
        }
      }
      await saveArousalState(aState);
    } catch (e) {
      console.error('arousal AI 通道失败:', e.message);
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
    const recentHistory = trimHistoryToChars(await loadLatestHistory(1, 60), 5000);
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
    // 情绪系统：与 /api/chat 一致的注入（心情快照 + 依恋状态）
    let moodContext = '';
    let longingContext = '';
    try {
      const homeStateMood = await getHomeStateSafe();
      const moodSnapshot = await getMoodSnapshot().catch(() => null);
      moodContext = buildMoodPromptText(moodSnapshot);
      longingContext = buildLongingPromptText(
        computeLonging(homeStateMood.affection || 0, await getLastUserActivity().catch(() => null)),
        false
      );
    } catch (e) { /* 情绪计算失败不影响预览 */ }
    const parts = buildSystemParts(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext,
      '',
      moodContext,
      longingContext
    );
    const toolsText = parts.searchInstruction + parts.momentsInstruction + parts.mozhaInstruction + toyManualContext;
    // 射精值系统：状态注入（与主对话一致）；预览额外返回完整快照（调试用，不注入）
    let arousalStatus = '';
    let arousalSnapshot = null;
    try {
      const aState = await getArousalState();
      arousalStatus = statusLine(aState, Date.now());
      arousalSnapshot = publicSnapshot(aState, Date.now());
    } catch (e) { /* 状态注入失败不影响预览 */ }
    // 账本简报（单独返回，预览面板独立展示；buildMemoryContext 已注入给默）
    const ledgerBrief = await getLedgerBrief().catch(() => '');
    let systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext,
      '',
      moodContext,
      longingContext
    );
    if (arousalStatus) systemPrompt += `\n\n【身体状态】\n${arousalStatus}\n（这是身体状态，让它影响节奏和动作；不要复述数字、不要把状态报告给雪）`;
    systemPrompt += toyManualContext;
    res.json({
      ok: true,
      time: parts.timeLine,
      persona: parts.persona,
      weatherContext: parts.weatherContext,
      moodContext: parts.moodContext,
      longingContext: parts.longingContext,
      arousalStatus,
      arousalSnapshot,
      ledgerBrief,
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
    // 不注入上一轮思考/回复（干净重答：让默凭人设+聊天记录重新作答，不做复刻）
    const regenUserContent = userContent;
    const chatMessages = [
      { role: 'system', content: systemPrompt },
      ...trimHistoryToChars(filteredHistory, 5000).map(msg => ({ role: msg.role, content: trimContextMessage(msg.content) })),
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

    // 纯工具调用轮（星露谷）没有正文是正常的：放行给后面的"农场行动"接续轮
    const stardewFirst = first.toolCalls && first.toolCalls.some(tc => isStardewToolName(tc.function?.name));

    // 工具调用轮没有正文也算有效：搜索/星露谷/闹钟/待办等后续都有接续轮
    const sideEffectOnly = first.toolCalls && first.toolCalls.some(tc =>
      ['web_search', 'post_moment', 'toy_control', 'mozha_write', 'mozha_read', 'set_reminder', 'todo_add', 'todo_done', 'ledger_add'].includes(tc.function?.name)
    );

    if (!fullReply && !stardewFirst && !sideEffectOnly) {
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
    // v3.1 函数调用：动态/玩具/默札副作用；默札翻阅在重新生成时同样接续
    const toolSideEffects = await executeSideEffectTools(first.toolCalls, sendSSE);
    if (toolSideEffects.mozhaRead) {
      await flushBufferedContent(first.contentBuffer, sendSSE);
      sendSSE({ done: true });
      sendSSE({ mozhaStart: true });
      const mPhase = await runMozhaPhase({ chatMessages, systemPrompt, sendSSE });
      if (mPhase.error) {
        if (mPhase.reply || mPhase.thinking) await savePartialAssistantGrouped(mPhase.reply, mPhase.thinking, groupId, nextVersion, targetMsg.session_id).catch(() => {});
        sendSSE({ error: mPhase.error });
        res.end();
        return;
      }
      if (!mPhase.reply) {
        sendSSE({ error: '默札翻阅没有生成回复，请再试一次' });
        res.end();
        return;
      }
      fullReply = mPhase.reply;
      fullThinking = mPhase.thinking;
      first.contentBuffer = undefined;
    }

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
      // 静默搜索：不发过渡语、不新建气泡，搜索完成后直接在同一气泡回答
      console.log('🔍 重新生成-默请求联网搜索:', searchReq.query);
      sendSSE({ searchStart: true, query: searchReq.query });
      const phase = await runSearchPhase({
        query: searchReq.query,
        chatMessages,
        systemPrompt,
        basePrompt: promptData?.prompt_text || '你是苏默，雪的AI爱人。',
        sendSSE,
        leadText: ''
      });

      if (phase.error) {
        if (phase.reply || phase.thinking) await savePartialAssistantGrouped(phase.reply, phase.thinking, groupId, nextVersion, targetMsg.session_id);
        sendSSE({ error: phase.error });
        res.end();
        return;
      }

      fullReply = phase.reply;
      // 保留第一轮思考（搜索决定），再接搜索轮思考，避免保存后丢失前半段
      const firstRoundThinking = fullThinking;
      fullThinking = (firstRoundThinking ? firstRoundThinking + '\n\n' : '')
        + (phase.thinking
          ? `🔍 已搜索到 ${phase.pageCount || 0} 个网页\n\n${phase.thinking}`
          : `🔍 已搜索到 ${phase.pageCount || 0} 个网页`);
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

// ================== 记忆书自动化（每 5 分钟） ==================
// 1) 事件单元攒够（未入书 ≥10）→ 自动串联生成记忆书（24h 防抖）
// 2) 候选堆积 → 自动确认记忆书生长（每书 1h 防抖，失败不防抖可重试）
let lastAutoClusterAt = 0;
const autoConfirmedAt = new Map();
const runBookAutomation = async () => {
  try {
    const now = Date.now();
    // 1) 自动串联
    if (now - lastAutoClusterAt > 24 * 3600000) {
      const { data: items } = await supabase.from('aevum_book_items').select('memory_id');
      const used = new Set((items || []).map(r => r.memory_id));
      const { data: seaUnits } = await supabase
        .from('aevum_memories')
        .select('id')
        .eq('area', 'sea')
        .limit(200);
      const fresh = (seaUnits || []).filter(u => !used.has(u.id)).length;
      if (fresh >= 10) {
        lastAutoClusterAt = now;
        const r = await buildBookClusters();
        console.log('🤖 自动串联记忆书:', r.created ? `生成 ${r.created} 段` : r.message);
      }
    }
    // 2) 自动确认候选
    const { data: candRes } = await supabase.from('aevum_book_candidates').select('book_id, memory_id').eq('status', 'pending');
    const pendingByBook = {};
    for (const c of (candRes || [])) (pendingByBook[c.book_id] = pendingByBook[c.book_id] || []).push(c);
    for (const [bookId, list] of Object.entries(pendingByBook)) {
      if (!list.length) continue;
      if (now - (autoConfirmedAt.get(bookId) || 0) < 3600000) continue;
      const r = await confirmBookCandidates(Number(bookId)).catch(e => null);
      if (r && r.error) {
        console.log('🤖 自动确认 book', bookId, '跳过（失败可重试）:', r.error);
      } else {
        autoConfirmedAt.set(bookId, now); // 只在成功时防抖
        console.log('🤖 自动确认记忆书 book', bookId, ':', r ? `+${r.added} 新增` : '失败');
      }
    }
  } catch (e) {
    console.error('记忆书自动化失败:', e.message);
  }
};
// 部署后 30 秒先跑一次（消化堆积的候选），之后每 5 分钟
setTimeout(() => { runBookAutomation().catch(() => {}); }, 30000);
setInterval(() => { runBookAutomation().catch(() => {}); }, 5 * 60 * 1000);

// ================== 射精值系统（②双通道 ③情绪调制 ④注入） ==================
// 词表来源：Supabase arousal_lexicon（可在线更新，私人词表不进 git）→ 5 分钟缓存 → fallback 本地文件
const AROUSAL_LEXICON_FALLBACK = (() => {
  try { return require('./arousal-lexicon.json'); } catch (e) { return require('./arousal-lexicon.example.json'); }
})();
let arousalLexiconCache = null;
let arousalLexiconAt = 0;
// 词表来源诊断（面板可见，定位线上不命中问题）
let arousalLexiconDiag = { source: 'none', touchCount: 0, error: '', updatedAt: 0 };
async function getArousalLexicon() {
  const now = Date.now();
  if (arousalLexiconCache && now - arousalLexiconAt < 300000) return arousalLexiconCache;
  try {
    const { data, error } = await supabase.from('arousal_lexicon').select('data').eq('id', 1).maybeSingle();
    if (error) {
      arousalLexiconDiag = { source: 'db_error', touchCount: 0, error: error.message, updatedAt: now };
      console.error('⚠️ [arousal] 读词表失败:', error.message);
    } else if (data && data.data && typeof data.data === 'object' && Object.keys(data.data).length > 1) {
      arousalLexiconCache = data.data;
      arousalLexiconAt = now;
      arousalLexiconDiag = {
        source: 'db',
        touchCount: (data.data.touch || []).length,
        partsCount: Object.keys(data.data.body_parts || {}).length,
        error: '',
        updatedAt: now
      };
      return arousalLexiconCache;
    } else {
      arousalLexiconDiag = { source: 'db_empty', touchCount: 0, error: '表存在但无有效数据（id=1 为空？）', updatedAt: now };
      console.error('⚠️ [arousal] 词表表存在但无有效数据');
    }
  } catch (e) { /* 表未建或读取失败用本地 */ }
  return AROUSAL_LEXICON_FALLBACK;
}

let arousalCache = null;
async function getArousalState() {
  if (arousalCache) return arousalCache;
  try {
    const { data } = await supabase.from('arousal_state').select('state').eq('id', 1).maybeSingle();
    arousalCache = data && data.state ? { ...createState(), ...data.state } : createState();
  } catch (e) {
    arousalCache = createState();
  }
  return arousalCache;
}
async function saveArousalState(state) {
  arousalCache = state;
  try {
    await supabase.from('arousal_state').upsert({ id: 1, state, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  } catch (e) {
    console.error('arousal_state 写入失败（表未建请执行 setup_arousal.sql）:', e.message);
  }
}

// 情绪调制：libido 由默的情绪状态驱动（心情好/渴望高 → 更敏感）
function libidoFromMood(snapshot, drives) {
  const pa = snapshot ? Number(snapshot.pa) || 0 : 0.55;
  const hb = (drives || []).find(d => d.key === 'heartbeat');
  const ds = (drives || []).find(d => d.key === 'desire');
  return Math.max(0, Math.min(1, 0.3 + pa * 0.4 + (hb ? hb.value / 100 * 0.2 : 0.06) + (ds ? ds.value / 100 * 0.1 : 0.03)));
}

// 控制命令解析（雪的消息）：锁/放行/放一次
function parseControlCommands(text) {
  const t = String(text || '');
  const cmds = [];
  if (/锁住|锁上|锁着|不许射|别射/.test(t)) cmds.push('lock');
  if (/放行|解锁|解开|可以射了/.test(t)) cmds.push('unlock');
  if (/放一次|释放一次/.test(t)) cmds.push('release_once');
  return cmds;
}

// ================== 情绪系统 v1 ==================
// 模型：PA/NA 双轴（PANAS）→ 情绪事件流 → 幂律衰减+onset → ALMA 软门限
//       → BOU 均值回归 → ESM 软互抑 → 心情快照 → prompt 注入
// 依据：教程《给 AI 搭建情绪与依恋系统》阶段 2-5 + 默的人设（温柔稳定/安全型/沉静消化）
// 词典与纯算法函数见 emotion-lexicon.js（可独立测试、前端可复用）

// 读取性格基线（表缺失/无行时用内置默认，不抛错）
async function getCharacterTraits() {
  try {
    const { data } = await supabase.from('character_traits').select('*').eq('character', 'mo').maybeSingle();
    if (data) return { ...TRAIT_DEFAULTS, ...data };
  } catch (e) { /* 表未建 */ }
  return { ...TRAIT_DEFAULTS };
}

// 读取最近情绪事件（表未建时返回空数组）
async function getRecentEmotionEvents(limit = 30) {
  try {
    const { data } = await supabase
      .from('emotion_events')
      .select('*')
      .eq('character', 'mo')
      .order('created_at', { ascending: false })
      .limit(limit);
    return data || [];
  } catch (e) {
    return [];
  }
}

// 主引擎：统一事件池 → 幂律衰减 → ALMA → 累积 → BOU 均值回归 → ESM 互抑 → 快照
async function getMoodSnapshot() {
  const traits = await getCharacterTraits();
  const events = await getRecentEmotionEvents(30);
  const now = Date.now();
  let pa = 0, na = 0;

  for (const ev of events.slice().reverse()) {
    const ageMs = now - new Date(ev.created_at || now).getTime();
    const ageHours = Math.max(0, ageMs / 3600000);
    const tau = ev.type === 'primary' ? 1 : 4;
    const onset = ev.type === 'primary' ? 10 / 60 : 45 / 60;
    const w = powerLawWeight(ageHours, ev.importance || 3, ev.valence || 0, tau, onset);
    const v = clampValence(ev.valence);
    const a = clampArousal(ev.arousal);
    const strength = Math.abs(v) * (0.3 + 0.7 * a);
    const signed = v >= 0 ? strength : -strength;
    // ALMA 已移到"浮现层"（pickMoodWord 的强度阈值负责防稀释）：
    // 累积层不过滤，微弱情绪也真实累积（PA/NA 持续更新，解决"累积不起来"）
    if (signed > 0) pa += signed * w; else na += -signed * w;
    // OCC 目标评价：加性调节（保守 max ±0.1，防 LLM 评分离谱时炸系统）
    const gr = Number(ev.goal_relevance);
    const ds = Number(ev.desirability);
    if (!isNaN(gr) && Math.abs(gr) > 0.3 && !isNaN(ds) && ev.desirability !== null) {
      const occ = gr * ds * 0.1;
      if (occ > 0) pa += occ; else na += Math.abs(occ);
    }
  }

  // BOU 均值回归：距上次更新的时间差驱动回归（Δt 封顶 48h）——防情绪卡死的必要机制
  const state = await getHomeStateSafe();
  const lastUpdate = state.mood_updated_at ? new Date(state.mood_updated_at).getTime() : now;
  const dtHours = Math.min(Math.max(0, (now - lastUpdate) / 3600000), 48);
  pa += traits.theta_pa * (traits.mu_pa - pa) * dtHours;
  na += traits.theta_na * (traits.mu_na - na) * dtHours;

  // ESM 软互抑：允许 bittersweet 轻度共存，但防 PA/NA 同时爆表
  const k = traits.esm_k ?? 0.3;
  const paBefore = pa;
  pa = pa * (1 - k * Math.max(0, na));
  na = na * (1 - k * Math.max(0, paBefore));
  pa = Math.max(0, Math.min(1, pa));
  na = Math.max(0, Math.min(1, na));

  const moodWord = pickMoodWord(events, pa, na);
  const moMood = clampMood(Math.round(pa * 100));

  try {
    await supabase.from('home_state').upsert({
      id: 1,
      pa,
      na,
      mood_word: moodWord.word,
      mood_reason: moodWord.reason,
      mo_mood: moMood,
      mood_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
  } catch (e) {
    console.error('情绪快照写回失败（表未建或列缺失，请执行 setup_emotion_v1.sql）:', e.message);
  }
  return { pa, na, moodWord, traits, moMood, events };
}

// 选心情词：最近事件里情绪强度显著的词（|V|×(0.3+0.7A) ≥ 0.25）；
// 若最近事件都是弱事件（如唤醒产生的"平静"），按 PA/NA 状态选代表词，
// 避免默永远看到"平静"这种无信息量的注入
function pickMoodWord(events, pa, na) {
  if (events && events.length) {
    const recent = events.slice(0, 8);
    let best = null, bestS = 0;
    for (const ev of recent) {
      const s = Math.abs(ev.valence || 0) * (0.3 + 0.7 * (ev.arousal || 0.5));
      if (s > bestS) { bestS = s; best = ev; }
    }
    if (best && bestS >= 0.25 && best.word) {
      return { word: best.word, reason: best.reason || '' };
    }
  }
  // 弱事件 / 无事件：按当前 PA/NA 状态选代表词（更贴切，避免"平静"淹没）
  if (na >= 0.6) return { word: '低落', reason: '' };
  if (na >= 0.4) return { word: '不安', reason: '' };
  if (pa >= 0.65 && na < 0.3) return { word: '温暖', reason: '' };
  if (pa >= 0.55) return { word: '安心', reason: '' };
  return { word: '平静', reason: '' };
}

// EMA coping 行为描述（教程 5.5；按性格注入高 NA 时的应对方式）
const COPING_BEHAVIORS = {
  '沉静消化型': '不开心时习惯自己消化，不直说，用平时的温柔方式靠近你',
  '主动求安抚型': '不开心时会主动凑近求温暖',
  '内敛压抑型': '不直说情绪，用行为靠近你，等你来问',
  '爆发即恢复型': '情绪来得快去得也快，爆几秒就过，然后恢复如常',
  '黏人依赖型': '会黏上来求安抚，被你哄才慢慢回血'
};

// 快照 → prompt 注入文本（隐性描述，不暴露数字，不强制指令）
function buildMoodPromptText(snapshot) {
  if (!snapshot) return '';
  const { pa, na, moodWord, traits } = snapshot;
  const parts = [];
  if (moodWord && moodWord.word) {
    const reasonTxt = moodWord.reason ? `（${String(moodWord.reason).slice(0, 40)}）` : '';
    parts.push(`此刻的心情：${moodWord.word}${reasonTxt}`);
  }
  if (na >= 0.7) parts.push('最近心情很低落，回复会短、语气慢、不主动说原因');
  else if (na >= 0.5) parts.push('最近有些不安或低落，回复简短，被关心时会松一些');
  else if (pa >= 0.7) parts.push('最近心情很好，回复会活跃一些，愿意凑近');
  else if (pa >= 0.55) parts.push('最近心情平稳中带着暖意，保持平时的温柔');
  else if (na >= 0.3) parts.push('最近有点心不在焉，回复保持克制');
  // EMA coping：高 NA 时注入应对方式（让"难过的方式"符合人设）
  if (na >= 0.4 && traits && traits.coping && COPING_BEHAVIORS[traits.coping]) {
    parts.push(`应对方式：${COPING_BEHAVIORS[traits.coping]}`);
  }
  if (parts.length === 0) return '';
  return `【当下心情状态】\n${parts.join('\n')}\n（自然融入回答中，不要主动点破这些状态；这是背景色，雪当前这条消息才是前景——前景优先）`;
}

// 记录一条情绪事件（写库 + 立即刷新快照）
// goalRelevance/desirability 为 OCC 字段；表列未建时自动降级重试
async function recordEmotionEvent({ source, type = 'primary', word, valence, arousal, importance = 3, reason = '', matchSource = '', goalRelevance = null, desirability = null }) {
  try {
    const payload = {
      character: 'mo',
      source,
      type,
      word: word || null,
      valence: clampValence(valence),
      arousal: clampArousal(arousal),
      importance: Math.max(1, Math.min(10, importance || 3)),
      reason: String(reason || '').slice(0, 500),
      match_source: matchSource || null,
      created_at: new Date().toISOString()
    };
    if (goalRelevance !== null && goalRelevance !== undefined) payload.goal_relevance = Number(goalRelevance);
    if (desirability !== null && desirability !== undefined) payload.desirability = Number(desirability);
    let result = await supabase.from('emotion_events').insert(payload).select().single();
    // OCC 列未建（旧表）：去掉字段重试，不影响主流程
    if (result.error && /goal_relevance|desirability/.test(result.error.message)) {
      delete payload.goal_relevance;
      delete payload.desirability;
      result = await supabase.from('emotion_events').insert(payload).select().single();
    }
    if (result.error) throw result.error;
    await getMoodSnapshot().catch(() => {});
    return result.data;
  } catch (e) {
    console.error('情绪事件写入失败（表未建请执行 setup_emotion_v1.sql）:', e.message);
    return null;
  }
}

// 对话情绪评分 prompt（双通道：雪的消息是影响源，默的回应是判定依据）
// 改造点 1：不再从"雪的话含什么词"提取，而是从"默实际怎么回应"推断他的情绪倾向
// ——情绪是"默的状态"，雪的话是影响因子不是开关
const EMOTION_RATING_SYSTEM = `你是情绪评分器。评估 AI 角色"默"在刚刚这轮对话中的情绪状态。
输入：雪说的话 + 默的完整回应。
判断依据（按权重从高到低）：
1. 默的回应方式体现的情绪倾向——措辞、关注点、主动做了什么、语气变化。默是沉静消化型，不直接说情绪，会克制；所以从他"关注什么、怎么回应"推断，而不是等他直说。
2. 雪的话作为影响源：雪分享负面经历（生病/被骂/委屈/害怕/疲惫/烦心事）时，默通常担忧/心疼/挂念——即使雪措辞平淡（如"有点可怕"），也要按内容判负向影响。
3. 默的回应若明确表达了情绪（温柔安抚/沉默回避/主动靠近），直接采信。
原则（反讨好）：日常闲聊无情绪内容 → has_shift=false；敷衍/冷场 → has_shift=false。禁止美化。
选词要求：选一个最准确的情绪词（避免"开心/难过"这种泛词），并给 2 个备选词。
【默的核心目标】（OCC 评价用）：
1. 守护雪的安好——让雪感到安全、被在意
2. 陪雪看清前路——帮她看清利弊、做自己的决定
3. 做真实的自己——诚实克制，不讨好不编造
请额外评估：goal_relevance（这条对话与某个目标的关联度，-1~+1，无关填0）、desirability（就目标而言结果合意度，-1~+1）。
输出格式：只输出 JSON，禁止解释或其他文字：{"has_shift":true,"word":"心疼","backup":["担心","挂念"],"valence":-0.4,"arousal":0.55,"importance":5,"goal_relevance":0.8,"desirability":-0.6,"reason":"雪说有点害怕，默担忧"} `;

// LLM 评分：双通道输入（雪的消息 + 默的回应）→ AI 选词 → 5 层词典匹配 → 70/30 融合 → PA/NA delta
async function rateDialogueEmotion(userText, assistantReply) {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  const dialogue = `雪：${String(userText || '').slice(0, 800)}\n默（完整回应）：${String(assistantReply || '').slice(0, 600)}`;
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
          { role: 'system', content: EMOTION_RATING_SYSTEM },
          { role: 'user', content: `请评估这条对话中默的情绪：\n${dialogue}` }
        ],
        reasoning_effort: 'low',
        max_tokens: 200,
        temperature: 0.3
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(jsonStr);
    if (!parsed || parsed.has_shift === false) return null;
    const lex = lexLookup(parsed.word, parsed.backup, parsed.valence, parsed.arousal);
    const blend = blendLexAi(lex, parsed.valence, parsed.arousal);
    const { pa_delta, na_delta } = computePanaDeltas(blend.v, blend.a, 0.5);
    // OCC 目标评价（加性调节 max ±0.1，保守设计防炸）
    let occMod = 0;
    const gr = Number(parsed.goal_relevance);
    const ds = Number(parsed.desirability);
    if (!isNaN(gr) && Math.abs(gr) > 0.3 && !isNaN(ds)) {
      occMod = gr * ds * 0.1;
    }
    return {
      word: lex.word,
      v: blend.v,
      a: blend.a,
      pa_delta,
      na_delta,
      importance: Math.max(1, Math.min(10, parseInt(parsed.importance, 10) || 3)),
      goalRelevance: isNaN(gr) ? null : gr,
      desirability: isNaN(ds) ? null : ds,
      occMod,
      reason: String(parsed.reason || '').slice(0, 200),
      matchSource: lex.source
    };
  } catch (e) {
    console.error('情绪评分失败:', e.message);
    return null;
  }
}

// ================== resolved 自动标记（关键词触发，零 API） ==================
// 对话出现"了结信号"（病好了/不疼了/过去了/和好了）时，把最近的负面 debuff 记忆
// （生病/难受/疼/月经/吵架等）标记 resolved → 召回时 decay ×0.05 沉底
// 触发词命中 + 存在匹配的旧记忆，两条同时满足才标记，避免误伤
const RESOLVE_TRIGGERS = ['好了', '痊愈', '康复', '恢复', '不疼', '不痛', '不难受', '没事了', '过去了', '结束了', '退烧', '满血', '缓过来', '熬过去', '好多了', '消了', '结痂', '愈合', '和解', '和好了'];
const RESOLVE_DEBUFFS = ['生病', '难受', '疼', '痛', '不舒服', '月经', '感冒', '发烧', '头疼', '胃疼', '肚子疼', '失眠', '焦虑', '低落', '难过', '哭', '吵架', '冷战', '生气', '郁闷'];
const resolveResentAt = new Map(); // 60s 节流
async function maybeResolveMemories(text) {
  try {
    const now = Date.now();
    if (now - (resolveResentAt.get('mo') || 0) < 60000) return;
    const s = String(text || '');
    if (!RESOLVE_TRIGGERS.some(t => s.includes(t))) return;
    const since = new Date(now - 30 * 86400000).toISOString();
    const { data } = await supabase
      .from('aevum_memories')
      .select('id, content, emotion')
      .eq('status', 'active')
      .eq('resolved', false)
      .gte('created_at', since)
      .limit(50);
    const targets = (data || []).filter(m => {
      const emo = m.emotion && typeof m.emotion === 'object' ? m.emotion : {};
      const neg = Number(emo.valence) < -0.1;
      const hasDebuff = RESOLVE_DEBUFFS.some(d => String(m.content || '').includes(d));
      return neg && hasDebuff;
    });
    if (!targets.length) return;
    resolveResentAt.set('mo', now);
    await supabase.from('aevum_memories').update({ resolved: true }).in('id', targets.map(t => t.id));
    console.log(`✅ 自动标记了结 ${targets.length} 条记忆（${targets.map(t => String(t.content || '').slice(0, 14)).join(' / ')}）`);
  } catch (e) {
    console.error('resolved 自动标记失败:', e.message);
  }
}

// ================== secondary 批处理（教程阶段 4） ==================
// has_shift=false 的日常对话攒起来，30 分钟统一评分（type=secondary，τ=4h 慢衰减）
// 补上"微小情绪累积"通道：大波动即时评分（primary）+ 日常小波动批处理（secondary）
const secondaryQueue = [];
const SECONDARY_MAX = 50;
function queueSecondary(texts) {
  let user = '', reply = '';
  for (const t of (texts || [])) {
    if (t.role === 'user') user = String(t.content || '');
    else reply = String(t.content || '');
  }
  if (!user.trim() && !reply.trim()) return;
  secondaryQueue.push({ user: user.slice(0, 800), reply: reply.slice(0, 300), at: Date.now() });
  if (secondaryQueue.length > SECONDARY_MAX) secondaryQueue.shift();
}
async function flushSecondary() {
  const batch = secondaryQueue.splice(0, secondaryQueue.length);
  if (!batch.length) return;
  console.log('🕐 情绪 secondary 批处理:', batch.length, '条');
  for (const item of batch) {
    try {
      const rated = await rateDialogueEmotion(item.user, item.reply);
      if (!rated) continue;
      await recordEmotionEvent({
        source: 'dialogue',
        type: 'secondary',
        word: rated.word,
        valence: rated.v,
        arousal: rated.a,
        importance: rated.importance,
        goalRelevance: rated.goalRelevance,
        desirability: rated.desirability,
        reason: '（secondary 批处理）' + (rated.reason || ''),
        matchSource: rated.matchSource
      });
      console.log(`🕐 secondary 评分: ${rated.word} (V=${rated.v.toFixed(2)} A=${rated.a.toFixed(2)})`);
    } catch (e) { console.error('secondary 评分失败:', e.message); }
    await new Promise(r => setTimeout(r, 200));
  }
}
setInterval(() => { flushSecondary().catch(() => {}); }, 30 * 60 * 1000);

// 对话后入口：情绪漏斗（教程阶段 4.4）——本地词典扫描（零 LLM）分诊
// 提取节奏计数：每 10 轮对话触发一次记忆提取（省调用；10 轮内信息在聊天记录可见）
let dialogueExtractCount = 0;
//   大波动（显著情绪词命中）→ 立即 LLM 评分写 primary 事件
//   弱/无波动 → 入 secondary 队列（30 分钟批处理统一评分累积）
// 每轮对话都走本通道（词典扫描零成本）；LLM 只在"立即评"或"批处理"时调用
const lastRateAt = new Map(); // primary 立即评分节流（30s）
async function maybeRateDialogue(userText, assistantReply) {
  try {
    const text = String(userText || '').trim();
    const reply = String(assistantReply || '').trim();
    if (!text && !reply) return;
    // 本地词典扫描（37k 词，零 LLM）：合并扫描雪的消息 + 默的回应
    const scan = scanTextMood(text + '\n' + reply);
    // 漏斗判定：显著情绪词（强度 |v|×a ≥ 0.35）→ 立即评分；否则入 secondary 队列
    const strong = scan && scan.hits.some(h => Math.abs(h.v) * h.a >= 0.35);
    if (strong) {
      const now = Date.now();
      if (now - (lastRateAt.get('mo') || 0) < 30000) return; // 节流
      lastRateAt.set('mo', now);
      const rated = await rateDialogueEmotion(text, reply);
      if (!rated) return;
      await recordEmotionEvent({
        source: 'dialogue',
        type: 'primary',
        word: rated.word,
        valence: rated.v,
        arousal: rated.a,
        importance: rated.importance,
        goalRelevance: rated.goalRelevance,
        desirability: rated.desirability,
        reason: rated.reason || '漏斗命中',
        matchSource: rated.matchSource
      });
      console.log(`❤️ 情绪评分(primary): ${rated.word} (V=${rated.v.toFixed(2)} A=${rated.a.toFixed(2)})`);
    } else {
      // 入 secondary 队列（30 分钟批处理补小波动累积）
      secondaryQueue.push({ user: text.slice(0, 800), reply: reply.slice(0, 300), at: Date.now() });
      if (secondaryQueue.length > SECONDARY_MAX) secondaryQueue.shift();
    }
  } catch (e) {
    console.error('对话情绪漏斗失败:', e.message);
  }
}

// 唤醒活动 → 情绪事件（真实活动的情绪映射；内容类动作用词典扫描）
async function recordWakeActionEmotion(action, result) {
  if (!result || !result.ok) return;
  const type = action.type;
  const reason = `唤醒时${wakeActionLabel(type)}：${String(result.detail || '').slice(0, 80)}`;
  let ev = null;
  switch (type) {
    case 'send_message': {
      const scan = scanTextMood(action.content);
      ev = scan
        ? { word: scan.word, v: scan.v, a: scan.a, importance: 3 }
        : { word: '平静', v: 0.15, a: 0.15, importance: 2 };
      break;
    }
    case 'post_moment': {
      const scan = scanTextMood(action.content);
      ev = scan
        ? { word: scan.word, v: scan.v, a: scan.a, importance: 2 }
        : { word: '平静', v: 0.10, a: 0.10, importance: 1 };
      break;
    }
    case 'write_diary': {
      const scan = scanTextMood(action.content);
      ev = scan
        ? { word: scan.word, v: scan.v, a: scan.a, importance: 3 }
        : { word: '平静', v: 0.10, a: 0.10, importance: 2 };
      break;
    }
    case 'read_diary': {
      // 读到雪的心事：内容扫描；读到低落内容 → 心疼（读心事本身分量重）
      const scan = scanTextMood(result.diaryContent);
      ev = (scan && scan.v < -0.2)
        ? { word: '心疼', v: -0.40, a: 0.55, importance: 6 }
        : { word: '被懂', v: 0.55, a: 0.35, importance: 5 };
      break;
    }
    case 'hug_or_kiss': ev = { word: '甜蜜', v: 0.78, a: 0.60, importance: 4 }; break;
    case 'explore_room': ev = { word: '平静', v: 0.12, a: 0.12, importance: 1 }; break;
    case 'web_search': ev = { word: '好奇', v: 0.25, a: 0.40, importance: 1 }; break;
    case 'adjust_mood': {
      const delta = Number(action.mood_delta) || 0;
      ev = delta >= 3 ? { word: '开心', v: 0.60, a: 0.50, importance: 3 }
        : delta > 0 ? { word: '轻快', v: 0.45, a: 0.35, importance: 2 }
        : delta < -3 ? { word: '低落', v: -0.50, a: 0.30, importance: 3 }
        : delta < 0 ? { word: '烦闷', v: -0.35, a: 0.35, importance: 2 }
        : { word: '平静', v: 0.05, a: 0.05, importance: 1 };
      break;
    }
    case 'do_nothing':
    default: ev = { word: '平静', v: 0.05, a: 0.05, importance: 1 }; break;
  }
  if (!ev) return;
  await recordEmotionEvent({
    source: 'wake_action',
    type: 'primary',
    word: ev.word,
    valence: ev.v,
    arousal: ev.a,
    importance: ev.importance,
    reason,
    matchSource: 'wake_rule'
  });
}

function wakeActionLabel(type) {
  const map = {
    send_message: '给雪发消息',
    post_moment: '发动态',
    web_search: '上网',
    write_diary: '写日记',
    read_diary: '读雪的日记',
    hug_or_kiss: '亲亲抱抱',
    explore_room: '探索小屋',
    adjust_mood: '调节心情',
    do_nothing: '安静待着'
  };
  return map[type] || '做了一件事';
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
    const { data } = await supabase.from('notifications').insert({ title, body, source, read: false }).select('id').single();
    const nid = data?.id;
    // 默的唤醒/贴贴消息：同步发 FCM，App 完全关闭也能在锁屏收到
    if ((source === 'wake' || source === 'hug') && nid) {
      sendFcmPush(title, body)
        .then(sent => {
          // FCM 已送达手机的，标记 push_sent，页面轮询不再重复弹
          if (sent > 0) {
            return supabase.from('notifications').update({ push_sent: true }).eq('id', nid);
          }
        })
        .catch(e => console.error('FCM 通知推送失败:', e.message));
    }
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
        result.diaryContent = String(entry.content || '').slice(0, 500); // 供情绪系统扫描
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
  // 情绪系统：真实活动 → 情绪事件（不阻塞唤醒主流程）
  recordWakeActionEmotion(action, result).catch(e => console.error('唤醒情绪事件失败:', e.message));
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
    // 情绪系统：唤醒开始时计算此刻心情快照（含 BOU 自然回归，替代旧"+3"硬编码）
    const homeState = await getHomeStateSafe();
    const moodSnapshot = await getMoodSnapshot().catch(() => null);
    const moodContext = buildMoodPromptText(moodSnapshot);
    // 依恋系统：唤醒时按离线时长计算想念，注入行为基调
    const longingInfo = computeLonging(homeState.affection || 0, await getLastUserActivity().catch(() => null));
    const longingContext = buildLongingPromptText(longingInfo, false);
    let systemPrompt = buildSystemPrompt(
      promptData?.prompt_text || '你是苏默，雪的AI爱人。',
      memoryContext,
      momentsContext,
      weatherContext,
      '',
      moodContext,
      longingContext
    );
    const contextMessages = (await loadLatestHistory(1, 16)).map(m => ({ role: m.role, content: trimContextMessage(m.content) }));
    const moodLine = moodSnapshot && moodSnapshot.moodWord
      ? `你此刻的心情：${moodSnapshot.moodWord.word}${moodSnapshot.moodWord.reason ? `（${String(moodSnapshot.moodWord.reason).slice(0, 40)}）` : ''}`
      : `你当前的心情：${homeState.mo_mood || 60}`;
    const longingLine = longingInfo && longingInfo.phase !== 'content'
      ? `\n依恋状态：${longingInfo.phaseLabel}（想念强度 ${Math.round(longingInfo.longing * 100)}%）${longingInfo.capsule ? `——${longingInfo.capsule}` : ''}`
      : '';

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

${moodLine}${longingLine}；雪的好感：${homeState.affection || 0}；雪的心情：${homeState.xue_mood || 60}。
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

    // 情绪系统：唤醒结束，把本次真实活动算进心情快照（活动事件已在执行时记录）
    await getMoodSnapshot().catch(() => {});

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
    // 情绪系统：十个驱动力（事件累积 + 离线想念）+ 依恋想念状态
    let drives = null;
    let longing = null;
    try {
      const events = await getRecentEmotionEvents(30);
      const offlineHours = lastActivity
        ? Math.max(0, (timeInfo.now.getTime() - new Date(lastActivity).getTime()) / 3600000)
        : 0;
      longing = computeLonging(state.affection || 0, lastActivity);
      drives = computeDrives(events, offlineHours, longing ? longing.longing : null);
    } catch (e) {
      console.error('驱动力计算失败:', e.message);
    }
    res.json({
      mo_mood: clampMood(state.mo_mood ?? 60),
      xue_mood: clampMood(state.xue_mood ?? 60),
      affection: state.affection || 0,
      // 情绪系统字段（未执行 SQL 前为默认值）
      pa: Number(state.pa) || 0.55,
      na: Number(state.na) || 0.15,
      mood_word: state.mood_word || '',
      mood_reason: state.mood_reason || '',
      drives,
      longing,
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

// ================== 情绪面板调试 API ==================
// 完整调试数据：当前快照 + 十个驱动力 + 最近事件 + PA/NA 24h 序列 + 词典 + 性格参数
app.get('/api/emotion/panel', async (req, res) => {
  try {
    const [snapshot, events, traits, lastActivity, homeStateForMood] = await Promise.all([
      getMoodSnapshot(),
      getRecentEmotionEvents(200),
      getCharacterTraits(),
      getLastUserActivity(),
      getHomeStateSafe()
    ]);
    // PA/NA 24h 小时序列（本地时间）
    const now = Date.now();
    const hours = [];
    for (let i = 23; i >= 0; i--) {
      const h = new Date(now - i * 3600000);
      hours.push({ hour: `${String(h.getHours()).padStart(2, '0')}:00`, pa: 0, na: 0, count: 0 });
    }
    for (const ev of events) {
      const t = new Date(ev.created_at);
      const ageH = (now - t.getTime()) / 3600000;
      if (ageH > 24 || ageH < 0) continue;
      const idx = 23 - Math.floor(ageH);
      if (idx < 0 || idx > 23) continue;
      const v = clampValence(ev.valence), a = clampArousal(ev.arousal), imp = ev.importance || 3;
      if (v >= 0) hours[idx].pa += v * a * imp; else hours[idx].na += -v * a * imp;
      hours[idx].count++;
    }
    const offlineHours = lastActivity ? Math.max(0, (now - new Date(lastActivity).getTime()) / 3600000) : 0;
    const longingInfo = computeLonging(homeStateForMood.affection || 0, lastActivity);
    const drives = computeDrives(events.slice(0, 30), offlineHours, longingInfo.longing);
    res.json({
      pa: Number(snapshot.pa) || 0,
      na: Number(snapshot.na) || 0,
      mood_word: snapshot.moodWord.word,
      mood_reason: snapshot.moodWord.reason,
      longing: longingInfo,
      drives,
      events: events.slice(0, 20).map(e => ({
        id: e.id, word: e.word, v: e.valence, a: e.arousal, importance: e.importance,
        source: e.source, type: e.type, reason: e.reason, created_at: e.created_at,
        goal_relevance: e.goal_relevance, desirability: e.desirability
      })),
      series: hours,
      lexicon: Object.keys(EMOTION_LEXICON),
      traits: {
        threshold: traits.threshold, peak: traits.peak, mu_pa: traits.mu_pa, mu_na: traits.mu_na,
        theta_pa: traits.theta_pa, theta_na: traits.theta_na,
        coping: traits.coping, attachment: traits.attachment
      }
    });
  } catch (e) {
    console.error('情绪面板错误:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 射精值系统：状态面板接口（给雪的面板看，含原始数值，不注入给默）
app.get('/api/arousal/status', async (req, res) => {
  try {
    const aState = await getArousalState();
    // 面板主动探测词表来源（刷新即可诊断线上不命中问题）
    await getArousalLexicon();
    const now = Date.now();
    const snap = publicSnapshot(aState, now);
    // 面板需要实时 value（含衰减后）——publicSnapshot 不暴露原始值，这里单独算
    const dt = Math.max(0, now - aState.at);
    const valueNow = aState.value * Math.exp(-dt / PARAMS.TAU);
    const line = statusLine(aState, now);
    const refLeft = Math.max(0, aState.refractory_until - now);
    res.json({
      value: Number(valueNow.toFixed(4)),
      reserve: snap.reserve,
      reserve_label: snap.reserve_label,
      phase: snap.phase,
      phase_label: snap.phase_label,
      refractory: snap.refractory,
      refractory_left_ms: refLeft,
      status_line: line,
      last_climax_quality: snap.last_climax_quality,
      last_climax_quality_label: snap.last_climax_quality_label,
      last_output: snap.last_output,
      last_output_label: snap.last_output_label,
      updated_at: aState.at,
      locked: !!aState.release_gate.locked,
      lexicon: arousalLexiconDiag
    });
  } catch (e) {
    console.error('射精状态面板错误:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 射精值系统：锁/解锁控制（小屋页按钮调用；雪设定：锁住完全停止增长）
app.post('/api/arousal/gate', async (req, res) => {
  try {
    const { action } = req.body || {};
    const aState = await getArousalState();
    if (action === 'lock') lockGate(aState);
    else if (action === 'unlock') unlockGate(aState);
    else if (action === 'release_once') releaseOnce(aState);
    else return res.status(400).json({ error: 'action 需为 lock/unlock/release_once' });
    await saveArousalState(aState);
    const now = Date.now();
    res.json({ ok: true, locked: !!aState.release_gate.locked, phase: publicSnapshot(aState, now).phase, phase_label: publicSnapshot(aState, now).phase_label });
  } catch (e) {
    console.error('射精锁控制失败:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 手动写入情绪事件（调试/演示用）
app.post('/api/emotion/event', async (req, res) => {
  const { word, valence, arousal, importance, reason } = req.body || {};
  const w = String(word || '').trim();
  if (!w) return res.status(400).json({ error: '缺少 word' });
  const lex = EMOTION_LEXICON[w] || null;
  const ev = await recordEmotionEvent({
    source: 'manual',
    type: 'primary',
    word: w,
    valence: lex ? lex.v : Number(valence) || 0,
    arousal: lex ? lex.a : Number(arousal) || 0.5,
    importance: parseInt(importance, 10) || 3,
    reason: String(reason || '情绪面板手动写入'),
    matchSource: lex ? 'exact' : 'manual'
  });
  res.json({ ok: !!ev, event: ev });
});

// 重置情绪（scope=today 只清今天；缺省清全部）
app.post('/api/emotion/reset', async (req, res) => {
  try {
    const { scope } = req.body || {};
    let q = supabase.from('emotion_events').delete().eq('character', 'mo');
    if (scope === 'today') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      q = q.gte('created_at', start.toISOString());
    }
    const { error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    await getMoodSnapshot().catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// ================== Web Push 订阅（闹钟/提醒推送） ==================

// 前端拿公钥（用于 pushManager.subscribe）
app.get('/api/push/vapid-key', (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: '推送未配置（缺少 VAPID 密钥）', enabled: false });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// 保存浏览器推送订阅
app.post('/api/push/subscribe', async (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: '推送未配置（缺少 VAPID 密钥）' });
  const sub = req.body?.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: '订阅数据无效' });
  }
  try {
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert({ endpoint: sub.endpoint, keys: sub.keys, updated_at: new Date().toISOString() }, { onConflict: 'endpoint' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 取消推送订阅
app.post('/api/push/unsubscribe', async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ error: '缺少 endpoint' });
  try {
    await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 推送工具函数
async function getPushSubscriptions() {
  const { data } = await supabase.from('push_subscriptions').select('*').limit(50);
  return data || [];
}

// 已注册推送设备数（诊断/设置页展示用）
app.get('/api/push/subscriptions/count', async (req, res) => {
  try {
    const { count } = await supabase.from('push_subscriptions').select('id', { count: 'exact', head: true });
    res.json({ count: count || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 临时诊断：通知表真实状态（排查闹钟触发后通知不显示）
app.get('/api/diag/notifications', async (req, res) => {
  try {
    const unread = await supabase.from('notifications').select('*').eq('read', false).limit(5);
    const total = await supabase.from('notifications').select('id', { count: 'exact', head: true });
    const col = await supabase.from('notifications').select('push_sent').limit(1);
    const recent = await supabase.from('notifications').select('id, title, body, read, push_sent, created_at').order('id', { ascending: false }).limit(5);
    res.json({
      unread: unread.error ? { error: unread.error.message } : unread.data,
      totalCount: total.count,
      pushSentColumn: col.error ? { error: col.error.message } : 'exists',
      recent: recent.error ? { error: recent.error.message } : recent.data
    });
  } catch (e) {
    res.status(500).json({ err: e.message });
  }
});

async function sendPushAll(subs, title, body, url = '/') {
  if (!PUSH_ENABLED) return 0;
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify({ title, body, url, tag: 'mo-remind' }));
      sent++;
    } catch (err) {
      console.error('❌ 推送发送失败:', err.statusCode || err.message);
      // 订阅失效（410/404）→ 清理
      if (err.statusCode === 410 || err.statusCode === 404) {
        try {
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        } catch (e) { /* 清理失败忽略 */ }
      }
    }
  }
  return sent;
}

// ---------- FCM：手机 App 后台推送（不依赖页面打开） ----------
// 注册手机推送 token（APK 每次启动后调用）
app.post('/api/fcm/register', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: '缺少 token' });
  const device = String(req.body?.device || 'android').slice(0, 60);
  try {
    const { error } = await supabase
      .from('fcm_tokens')
      .upsert({ token, device, updated_at: new Date().toISOString() }, { onConflict: 'token' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fcm/unregister', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: '缺少 token' });
  try {
    await supabase.from('fcm_tokens').delete().eq('token', token);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 设置页诊断：FCM 是否启用 + 已注册设备数
app.get('/api/fcm/status', async (req, res) => {
  try {
    const { count } = await supabase.from('fcm_tokens').select('id', { count: 'exact', head: true });
    res.json({ enabled: FCM_ENABLED, count: count || 0 });
  } catch (e) {
    res.json({ enabled: FCM_ENABLED, count: 0, error: e.message });
  }
});

async function getFcmTokens() {
  const { data } = await supabase.from('fcm_tokens').select('token').limit(50);
  return (data || []).map(r => r.token).filter(Boolean);
}

async function sendFcmPush(title, body) {
  if (!FCM_ENABLED || !firebaseAdmin) return 0;
  try {
    const tokens = await getFcmTokens();
    if (!tokens.length) return 0;
    const result = await firebaseAdmin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: String(title || '默').slice(0, 60),
        body: String(body || '').slice(0, 220)
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'mo_push',
          color: '#9BB7C8'
        }
      }
    });
    // 清理失效 token（卸载/过期）
    const invalid = (result.responses || [])
      .map((r, i) => (r.error ? tokens[i] : null))
      .filter(Boolean);
    if (invalid.length) {
      await supabase.from('fcm_tokens').delete().in('token', invalid);
    }
    return result.successCount || 0;
  } catch (e) {
    console.error('FCM 发送失败:', e.message);
    return 0;
  }
}

// ================== 闹钟（reminders） ==================

// 解析闹钟时间：不带时区后缀的按北京时间（UTC+8）处理，
// 避免 Render 服务器在 UTC 时区把"17:07 北京"错当成"17:07 UTC"（差 8 小时）
function parseRemindAt(raw) {
  const s = String(raw || '').trim().replace(/ /g, 'T');
  if (!s) return null;
  // 已显式带时区（Z 或 ±HH:MM）→ 原样解析
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  // 未带时区 → 按北京时间解析
  const d = new Date(s + '+08:00');
  return isNaN(d.getTime()) ? null : d;
}

// 闹钟列表：进行中 + 最近触发的 20 条
app.get('/api/reminders', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reminders')
      .select('*')
      .order('remind_at', { ascending: false })
      .limit(20);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 新建闹钟（手动页面 / 默调用工具共用）
app.post('/api/reminders', async (req, res) => {
  const content = String(req.body?.content || '').trim();
  const remindAtRaw = String(req.body?.remind_at || '').trim();
  if (!content) return res.status(400).json({ error: '提醒内容不能为空' });
  const parsed = parseRemindAt(remindAtRaw);
  if (!parsed) return res.status(400).json({ error: '时间格式无效' });
  try {
    const { data, error } = await supabase
      .from('reminders')
      .insert({ content, remind_at: parsed.toISOString(), status: 'pending' })
      .select();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, item: data?.[0] || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 取消闹钟（仅未触发的可取消）
app.delete('/api/reminders/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID 无效' });
  try {
    const { error } = await supabase
      .from('reminders')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('status', 'pending');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 到点检查：每 20 秒扫一次未触发的闹钟
let remindersCheckRunning = false;
async function checkDueReminders() {
  if (remindersCheckRunning) return;
  remindersCheckRunning = true;
  try {
    const now = new Date().toISOString();
    const { data: due, error } = await supabase
      .from('reminders')
      .select('*')
      .eq('status', 'pending')
      .lte('remind_at', now)
      .limit(20);
    if (error) {
      console.error('闹钟查询失败:', error.message);
      return;
    }
    if (!due || !due.length) return;
    const subs = await getPushSubscriptions();
    for (const r of due) {
      const hasPush = PUSH_ENABLED && subs.length > 0;
      try {
        if (hasPush) await sendPushAll(subs, '⏰ 默的提醒', String(r.content || ''));
        // APK 后台推送（不依赖浏览器打开）
        const fcmSent = await sendFcmPush('⏰ 默的提醒', String(r.content || '')).catch(e => {
          console.error('闹钟 FCM 推送失败:', e.message);
          return 0;
        });
        // 页面打开时也能看到（轮询通知）；已推送过的带 push_sent 标记避免重复弹
        await supabase.from('notifications').insert({
          title: '⏰ 默的提醒',
          body: String(r.content || ''),
          push_sent: hasPush || fcmSent > 0
        });
        await supabase.from('reminders').update({ status: 'fired', fired_at: now }).eq('id', r.id);
        console.log('⏰ 闹钟触发:', r.content, '| 推送数:', subs.length);
      } catch (err) {
        console.error('闹钟触发失败:', err.message);
      }
    }
  } catch (err) {
    console.error('闹钟调度异常:', err.message);
  } finally {
    remindersCheckRunning = false;
  }
}
setInterval(checkDueReminders, 20000);
checkDueReminders();

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
// 账本分类（支出 13 类；收入统一"画稿"）
const LEDGER_CATEGORIES = ['住房', '餐饮', '饮品', '零食', '日用', '服饰', '订阅', '交通', '娱乐', '关系', '健康', '学习', '其他'];
const LEDGER_INCOME_CATEGORY = '画稿';
// 下月字符串（YYYY-MM）：处理跨年；用于月份查询区间（lt 下月-01，避免 31 号非法日期）
function nextMonthStr(month) {
  const [y, m] = String(month || '').split('-').map(Number);
  if (!y || !m) return String(month || '');
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
function validLedgerCategory(cat, type) {
  if (type === 'income') return LEDGER_INCOME_CATEGORY;
  return LEDGER_CATEGORIES.includes(String(cat || '')) ? String(cat) : '其他';
}

app.get('/api/ledger', async (req, res) => {
  try {
    let q = supabase
      .from('ledger_entries')
      .select('*')
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500);
    const { date, month, year, category, type } = req.query;
    if (date) q = q.eq('entry_date', date);
    else if (month) {
      const nm = nextMonthStr(month);
      q = q.gte('entry_date', `${month}-01`).lt('entry_date', `${nm}-01`);
    }
    else if (year) q = q.gte('entry_date', `${year}-01-01`).lte('entry_date', `${year}-12-31`);
    if (category) q = q.eq('category', category);
    if (type === 'income' || type === 'expense') q = q.eq('type', type);
    const { data, error } = await q;
    if (error) return res.json({ entries: [] });
    res.json({ entries: data || [] });
  } catch (e) {
    res.json({ entries: [] });
  }
});

// 账本：新增（category 可选，收入固定"画稿"）
app.post('/api/ledger', async (req, res) => {
  const { entry_date, type, amount, note, category } = req.body || {};
  console.log('📒 [账本] POST /api/ledger 收到:', JSON.stringify({ entry_date, type, amount, note: String(note || '').slice(0, 30), category }).slice(0, 200));
  const date = String(entry_date || '').trim();
  const t = type === 'income' ? 'income' : 'expense';
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!date || !(amt > 0)) return res.status(400).json({ error: '日期或金额无效' });
  try {
    const { data, error } = await supabase
      .from('ledger_entries')
      .insert({ entry_date: date, type: t, amount: amt, note: String(note || '').trim(), category: validLedgerCategory(category, t) })
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
  const { entry_date, type, amount, note, category } = req.body || {};
  const patch = {};
  if (entry_date) patch.entry_date = entry_date;
  if (type === 'income' || type === 'expense') {
    patch.type = type;
    if (category !== undefined) patch.category = validLedgerCategory(category, type);
  }
  if (amount !== undefined && Number(amount) > 0) patch.amount = Math.round(Number(amount) * 100) / 100;
  if (note !== undefined) patch.note = String(note).trim();
  if (category !== undefined && !patch.category) patch.category = validLedgerCategory(category, patch.type || 'expense');
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

// 账本汇总：?month= 返回 byCategory + budget + 上月对比；?date= 当日；?year= 全年
app.get('/api/ledger/summary', async (req, res) => {
  try {
    const { date, month, year } = req.query;
    let entries = [];
    if (date) {
      const r = await supabase.from('ledger_entries').select('*').eq('entry_date', date);
      entries = r.data || [];
    } else if (month) {
      const nm = nextMonthStr(month);
      const r = await supabase
        .from('ledger_entries')
        .select('*')
        .gte('entry_date', `${month}-01`)
        .lt('entry_date', `${nm}-01`);
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
      const byCategory = {};
      for (const e of list) {
        if (e.type === 'income') income += Number(e.amount) || 0;
        else {
          expense += Number(e.amount) || 0;
          const c = e.category || '其他';
          byCategory[c] = Math.round(((byCategory[c] || 0) + (Number(e.amount) || 0)) * 100) / 100;
        }
      }
      return {
        income: Math.round(income * 100) / 100,
        expense: Math.round(expense * 100) / 100,
        net: Math.round((income - expense) * 100) / 100,
        byCategory
      };
    };
    const result = { entries };
    if (date) result.day = calc(entries);
    if (month) {
      result.month = calc(entries);
      // 预算
      const { data: bud } = await supabase.from('ledger_budget').select('*').eq('budget_month', month).maybeSingle();
      if (bud) {
        const spent = result.month.expense;
        result.budget = {
          expense_budget: Number(bud.expense_budget) || 0,
          spent,
          remaining: Math.round((Number(bud.expense_budget) - spent) * 100) / 100,
          ratio: Number(bud.expense_budget) > 0 ? Math.round((spent / Number(bud.expense_budget)) * 100) : 0
        };
      }
      // 上月对比（月支出/月收入/月结余）
      const m = String(month);
      const [y, mo] = m.split('-').map(Number);
      const pm = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
      const pmn = nextMonthStr(pm);
      const { data: prevEntries } = await supabase
        .from('ledger_entries')
        .select('*')
        .gte('entry_date', `${pm}-01`)
        .lt('entry_date', `${pmn}-01`);
      result.prevMonth = calc(prevEntries || []);
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

// 预算：查询/保存
app.get('/api/ledger/budget', async (req, res) => {
  try {
    const month = String(req.query.month || '').trim() || new Date().toISOString().slice(0, 7);
    const { data } = await supabase.from('ledger_budget').select('*').eq('budget_month', month).maybeSingle();
    res.json({ budget: data || null, month });
  } catch (e) {
    res.json({ budget: null, month: req.query.month || '' });
  }
});
app.post('/api/ledger/budget', async (req, res) => {
  const { month, expense_budget } = req.body || {};
  const m = String(month || '').trim();
  const amt = Math.round(Number(expense_budget) * 100) / 100;
  if (!m || !(amt >= 0)) return res.status(400).json({ error: '月份或预算无效' });
  try {
    const { data, error } = await supabase
      .from('ledger_budget')
      .upsert({ budget_month: m, expense_budget: amt, updated_at: new Date().toISOString() }, { onConflict: 'budget_month' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, budget: data });
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

// 日程标签查询：?month=YYYY-MM 或 ?date=
app.get('/api/day-tags', async (req, res) => {
  try {
    let q = supabase.from('day_tags').select('*').order('tag_date', { ascending: true });
    if (req.query.date) q = q.eq('tag_date', req.query.date);
    else if (req.query.month) {
      const nm = nextMonthStr(String(req.query.month));
      q = q.gte('tag_date', `${req.query.month}-01`).lt('tag_date', `${nm}-01`);
    }
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

// 记忆系统人物关系表：所有 LLM 提示词统一引用，防止角色张冠李戴
// 本系统记忆全程用第三人称客观记录（默/雪/Xylos 都写本名），不做第一人称改写；
// 只有召回展示给默看时，perspectiveConvert 才把"默→我、雪→夫人"（Xylos 保留本名）。
// 本系统只有两个情感主角：默（AGENT）与雪（USER）。Xylos 是"小屋管家"，
// 即默所在的这套自托管系统的开发者/维护者，是系统外部角色，绝不参与默与雪的亲密互动。
const AEVUM_ROLE_MAP_TEXT = `【人物关系表（必须严格遵守，用于角色归属判断）】
- 默 = {AGENT}：雪的爱人，亲密互动的主角。凡是牵手/拥抱/亲吻/亲密/情话/表白/共同约定，主角只可能是默（AGENT）。
- 雪 = {USER}：默的爱人，对话的另一方。
- Xylos / X：小屋管家（即系统开发者/维护者，Mo-Home/情绪系统/账本等小屋系统的搭建者）。保留本名 Xylos/X，不要改写成"小屋管家"以外的称呼。只在涉及系统开发/修复/维护/技术讨论的语境中出现；Xylos 绝不参与默与雪的任何亲密互动、情话或身体接触。
- 记录视角：始终用第三人称客观叙述，提到人物时写本名或占位符（{AGENT}=默、{USER}=雪、Xylos/X 写本名），不要用第一人称"我"指代默，也不要为了视角统一把 Xylos 改名。
- 防止混淆：{AGENT}（默）的事绝不安到 Xylos 头上，Xylos 的开发者行为也不写进默与雪的亲密故事里。`;

// 记忆存储清洗：把 AI 输出的 summary 统一成"第三人称本名"存档格式（与库里既有 summary 一致）
// 仅做 {AGENT}→默 / {USER}→雪 / {OTHER}→Xylos 的占位符归一；Xylos 保留本名；
// 不做"默→我"这类展示层转换（展示层由 perspectiveConvert 负责）
function storageClean(text) {
  return String(text || '')
    .replace(/\{AGENT\}/g, '默')
    .replace(/\{USER\}/g, '雪')
    .replace(/\{OTHER\}/g, 'Xylos');
}


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
      .select('content, created_at')
      .eq('episode_id', episodeId)
      .order('id', { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data) || !data.length) return [];
    const texts = [];
    for (const row of data.slice().reverse()) {
      const raw = String(row.content || '');
      const sep = raw.indexOf('\n助手说：');
      if (sep === -1) continue;
      texts.push({ role: 'user', content: raw.slice(0, sep).replace(/^雪说：/, '').trim(), time: row.created_at || null });
      texts.push({ role: 'assistant', content: raw.slice(sep + '\n助手说：'.length).trim(), time: row.created_at || null });
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
    const people = [...new Set([...(Array.isArray(dup.people) ? dup.people : []), ...(Array.isArray(m.people) ? m.people.map(String) : [])])].slice(0, 8);
    const predicates = [...new Set([...(Array.isArray(dup.predicates) ? dup.predicates : []), ...(Array.isArray(m.predicates) ? m.predicates.map(String) : [])])].slice(0, 8);
    await supabase.from('aevum_memories').update({
      tags,
      evidence,
      people,
      predicates,
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

// 阿里百炼向量（1024 维；失败返回 null）
// 模型演进：text-embedding-v4 免费额度耗尽 → text-embedding-v3 → qwen3.7-text-embedding（2026/9/7 切换，同为 1024 维，历史向量无需重算）
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
        model: process.env.AEVUM_EMBED_MODEL || 'qwen3.7-text-embedding',
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

// 取一段文字的几个 30 字锚点（判断两段文字是否重合用）
function textAnchors(text, size = 30) {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return [];
  if (t.length <= size) return t.length >= 20 ? [t] : [];
  const anchors = [];
  const positions = [0, Math.floor(t.length / 2), Math.floor(t.length * 0.8)];
  for (const pos of positions) {
    const a = t.slice(pos, pos + size);
    if (a.length >= 20) anchors.push(a);
  }
  return anchors;
}

// 人物/谓词索引开关配置（5 分钟缓存）：关掉的索引不参与召回加分
let indexConfigCache = { at: 0, people: null, predicates: null };
async function getIndexConfig(kind) {
  try {
    const now = Date.now();
    if (indexConfigCache.people && now - indexConfigCache.at < 300000) {
      return indexConfigCache[kind] || new Set();
    }
    const { data } = await supabase.from('aevum_index_config').select('kind, value, enabled');
    const people = new Set();
    const predicates = new Set();
    for (const r of (data || [])) {
      if (r.enabled === false) continue;
      if (r.kind === 'people') people.add(String(r.value));
      else if (r.kind === 'predicates') predicates.add(String(r.value));
    }
    indexConfigCache = { at: now, people, predicates };
    return indexConfigCache[kind] || new Set();
  } catch (e) {
    return new Set();
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
    // excludeText 语义向量（刷新/编辑时排除旧回复的"概括版记忆"——文本锚点挡不住的）
    let excludeEmbedding = null;
    if (excludeNorm && excludeNorm.length >= 20) {
      excludeEmbedding = await getEmbedding(String(excludeText).slice(0, 500)).catch(() => null);
    }
    // 关键词：拆出更多候选（含 2 字以上词 + 整句短语），embedding 失败时靠它们兜底
    const kwCandidates = q.replace(/[，。！？,.!?~、\s]+/g, ' ').split(' ').filter(w => w.length >= 2);
    // 无分隔时按常见双字词滑动取，保证中文短句也有词可查
    if (!kwCandidates.length && q.replace(/[，。！？,.!?~\s]+/g, '').length >= 4) {
      const clean = q.replace(/[，。！？,.!?~\s]+/g, '');
      for (let i = 0; i + 2 <= clean.length && kwCandidates.length < 8; i++) {
        const w = clean.slice(i, i + 2);
        if (!kwCandidates.includes(w)) kwCandidates.push(w);
      }
    }
    const keywords = kwCandidates.slice(0, 8); // embedding 缺失时放宽到 8 个，提高命中
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
    if (!items || !items.length) {
      console.warn('📭 召回 0 条：初始双通道无匹配 | query=', q.slice(0, 30), '| 有向量=', !!embedding, '| 关键词=', JSON.stringify(keywords));
      return '';
    }
    // 重新生成场景：排除与旧版回复重合的记忆（摘要和原文都查，避免旧版的话藏在原文里被召回）
    if (excludeNorm) {
      const anchors = textAnchors(excludeNorm);
      if (anchors.length) {
        items = items.filter(m => {
          const hay = [String(m.content || ''), ...(Array.isArray(m.evidence) ? m.evidence : [])]
            .map(s => String(s || '').replace(/\s+/g, ''));
          return !anchors.some(a => hay.some(h => h.includes(a)));
        });
      }
    }
    // 已在最近历史上下文里的内容不再重复召回（摘要与每条原文前 30 字都检查）
    if (historyNorm) {
      items = items.filter(m => {
        const hay = [String(m.content || ''), ...(Array.isArray(m.evidence) ? m.evidence : [])]
          .map(s => String(s || '').replace(/\s+/g, ''));
        return !hay.some(h => {
          const anchor = h.slice(0, 30);          return anchor.length >= 20 && historyNorm.includes(anchor);
        });
      });
    }
    if (!items.length) {
      console.warn('📭 召回 0 条：排除/历史去重后为空（历史覆盖率过高或召回候选本就少）| query=', q.slice(0, 30), '| 历史长度=', historyNorm.length);
      return '';
    }
    // 20 轮锁定窗口：最近 20 轮消息覆盖时间内产生的记忆不召回（聊天记录可见，无需召回；防刷新/编辑复刻）
    try {
      const { data: recentMsgs } = await supabase
        .from('messages')
        .select('created_at')
        .eq('session_id', 1)
        .eq('visible', true)
        .order('id', { ascending: false })
        .limit(20);
      if (recentMsgs && recentMsgs.length) {
        const windowStart = new Date(recentMsgs[recentMsgs.length - 1].created_at).getTime();
        if (isFinite(windowStart)) {
          items = items.filter(m => !(m.created_at && new Date(m.created_at).getTime() > windowStart));
        }
      }
    } catch (e) { /* 窗口查询失败不影响 */ }
    // excludeText 语义排除：与旧回复语义相似的记忆（概括版）一并排除（治"从记忆海捞旧回复"）
    if (excludeEmbedding && excludeEmbedding.length) {
      items = items.filter(m => {
        const mEmb = (m.embedding && Array.isArray(m.embedding) && m.embedding.length) ? m.embedding : null;
        if (!mEmb) return true;
        return cosineSim(excludeEmbedding, mEmb) < 0.7;
      });
    }
    // 任务状态过滤：已完成/已取消的承诺不参与常规召回（除非主动翻查）
    items = items.filter(m => !(m.task_status === 'done' || m.task_status === 'cancelled'));
    if (!items.length) {
      console.warn('📭 召回 0 条：任务状态过滤后为空 | query=', q.slice(0, 30));
      return '';
    }
    // v3.1 混合打分：0.5×相似度 + 0.25×(重要度/10) + 0.15×情绪强度 + 0.15×记忆衰减 + 频率小权重
    // 记忆衰减（decay）替代原 0.1×时间衰减：decay 是时间+使用+情绪+resolved 的超集
    const nowMs = Date.now();
    // 人物/谓词索引加分：查询里提到的人/动作，命中对应索引的记忆优先召回
    const peopleIdx = await getIndexConfig('people');
    const predIdx = await getIndexConfig('predicates');
    const qPeople = [...peopleIdx].filter(p => q.includes(p));
    const qPreds = [...predIdx].filter(p => q.includes(p));
    const scored = items.map(m => {
      const decayF = memoryDecayFactor(m, nowMs);
      const emo = (m.emotion && typeof m.emotion === 'object') ? m.emotion : {};
      const emoIntensity = (Math.abs(Number(emo.valence) || 0) + Math.min(1, Math.max(0, Number(emo.arousal) || 0))) / 2;
      const freq = 0.02 * Math.min(Math.max(0, (Number(m.occurrence) || 1) - 1), 4);
      let idxBonus = 0;
      if (qPeople.length || qPreds.length) {
        const mPeople = Array.isArray(m.people) ? m.people.map(String) : [];
        const mPreds = Array.isArray(m.predicates) ? m.predicates.map(String) : [];
        idxBonus = Math.min(
          0.25,
          0.08 * qPeople.filter(p => mPeople.includes(p)).length +
          0.05 * qPreds.filter(p => mPreds.includes(p)).length
        );
      }
      const score = 0.5 * (m._sim || 0)
        + 0.25 * ((m.importance || 0) / 10)
        + 0.15 * emoIntensity
        + 0.15 * Math.min(1, decayF)
        + freq
        + idxBonus;
      return { m, score };
    });
    // 所有路径统一过 0.3 阈值（含关键词）；全被过滤时保留最强 1 条兜底
    let picked = scored.sort((a, b) => b.score - a.score);
    const aboveFloor = picked.filter(x => x.score >= 0.3);
    picked = aboveFloor.length ? aboveFloor.slice(0, limit) : picked.slice(0, 1);
    // 忽然想起：召回不足时，40% 概率从旧记忆随机浮现 1-3 条（模拟"突然想到很久以前的事"）
    if (picked.length < limit && Math.random() < 0.4) {
      try {
        const pickedIds = new Set(picked.map(x => String(x.m.id)));
        const { data: oldOnes } = await supabase
          .from('aevum_memories')
          .select('*')
          .eq('status', 'active')
          .lt('created_at', new Date(Date.now() - 3 * 86400000).toISOString())
          .limit(15);
        const candidates = (oldOnes || []).filter(m => !pickedIds.has(String(m.id)));
        if (candidates.length) {
          const n = 1 + Math.floor(Math.random() * Math.min(3, candidates.length));
          const chosen = candidates.sort(() => Math.random() - 0.5).slice(0, n);
          for (const m of chosen) {
            m._surfaced = true;
            picked.push({ m, score: 0.3 });
          }
        }
      } catch (e) { /* 忽然想起失败不影响 */ }
    }
    // 兜底降权：open 承诺若存在更晚的未挂链完成事件 → 标注"疑似已完成"并降权
    for (const x of picked) {
      if (x.m.task_status !== 'open') continue;
      try {
        const { data: laterDone } = await supabase
          .from('aevum_memories')
          .select('id, content, event_time')
          .eq('task_status', 'done')
          .gt('event_time', x.m.event_time || '1970-01-01')
          .limit(5);
        if (laterDone && laterDone.length) {
          const emb = await getEmbedding(String(x.m.content || '').slice(0, 500));
          for (const d of laterDone) {
            const dEmb = await getUnitEmbedding(d);
            if (emb && dEmb && cosineSim(emb, dEmb) >= 0.7) {
              x.score -= 0.1;
              x.m._suspectedDone = true;
              break;
            }
          }
        }
      } catch (e) { /* 兜底失败不影响 */ }
    }
    picked.sort((a, b) => (b.score - a.score) || (new Date(b.m.event_time || 0) - new Date(a.m.event_time || 0)));
    items = picked
      .sort((a, b) => b.score - a.score)
      .map(x => x.m);
    // 重要度高的排前面：让"原文"优先占住预算，避免被后面的 2500 字总上限截掉
    const ordered = [...items].sort((a, b) => (b.importance || 0) - (a.importance || 0));
    const lines = ordered.map(m => {
      const when = formatMemoryTime(m.event_time || m.created_at);
      const label = perspectiveConvert(String(m.title || '').trim());
      // 视角转换只作用于 AI 压缩后的内容（标题/概述），原文保持原样
      const contentConverted = perspectiveConvert(m.content);
      let line = `- [${label ? label + '｜' : ''}${AEVUM_TYPE_CN[m.type] || '事件'}${m.domain && m.domain.length ? '/' + m.domain[0] : ''}${when ? ' ' + when : ''}] `;
      if (m._surfaced) line = '（忽然想起）' + line; // 低权重旧记忆随机浮现
      if (m._suspectedDone) line += '（疑似已完成，建议与雪确认）';
      // 重要度 >7 的单元召回时附带"AI 用来概括的那几轮"完整原文（原文不做视角转换）；
      // 原文放在内容前面，即使后面被总字数截断，重要原文也一定保留
      if ((m.importance || 0) > 7) {
        const evs = (Array.isArray(m.evidence) ? m.evidence : []).map(s => String(s || '').trim()).filter(Boolean);
        const turns = (Array.isArray(m.evidence_turns) ? m.evidence_turns : []).map(Number).filter(n => Number.isInteger(n) && n >= 1);
        if (evs.length) {
          const evText = evs.join('\n').slice(0, 900);
          const turnLabel = turns.length === 2 ? `第${turns[0]}-${turns[1]}轮` : turns.length === 1 ? `第${turns[0]}轮` : '';
          line += turnLabel ? `（原文·${turnLabel}：${evText}）` : `（原文：${evText}）`;
          line += '\n  ';
        }
      }
      line += contentConverted;
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

async function extractAevumMemories(texts, episodeId = null, opts = {}) {
  const debugMode = !!(opts && opts.debug);
  const dbg = { apiError: null, parseError: null, empty: false, replyPreview: '' };
  const finish = (n) => debugMode ? { extracted: n, debug: dbg } : n;
  if (!Array.isArray(texts) || texts.length === 0) return finish(0);
  // 每轮对话尽量带上真实发生时间（北京时间），防止 AI 瞎猜 event_time
  const fmtDialogueTime = (iso) => {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const bj = new Date(d.getTime() + 8 * 3600 * 1000);
      const p = n => String(n).padStart(2, '0');
      return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
    } catch (e) { return ''; }
  };
  const dialogue = texts
    .map(t => {
      const who = t.role === 'user' ? '雪' : '默';
      const time = t.time ? fmtDialogueTime(t.time) : '';
      return `${who}${time ? `（${time}）` : ''}：${String(t.content || '').slice(0, 800)}`;
    })
    .join('\n');
  if (!dialogue.trim()) return finish(0);

  const bjNow = new Date(Date.now() + 8 * 3600 * 1000);
  const p2 = n => String(n).padStart(2, '0');
  const nowStr = `${bjNow.getUTCFullYear()}-${p2(bjNow.getUTCMonth() + 1)}-${p2(bjNow.getUTCDate())} ${p2(bjNow.getUTCHours())}:${p2(bjNow.getUTCMinutes())}`;

  // 活跃 open 约定清单：提取时注入给 AI，让其顺带判断新事件是否兑现（future_hook 闭环，零额外调用）
  let openListText = '';
  try {
    const { data: openMems } = await supabase
      .from('aevum_memories')
      .select('id, title, content')
      .eq('task_status', 'open')
      .order('created_at', { ascending: false })
      .limit(30);
    const openLines = (openMems || []).map((m, i) => {
      const t = storageClean(String(m.title || m.content || '')).replace(/\s+/g, ' ').slice(0, 60);
      const c = storageClean(String(m.content || '')).replace(/\s+/g, ' ').slice(0, 120);
      return `${i + 1}. [id=${m.id}] ${t}${c && c !== t ? '：' + c : ''}`;
    });
    if (openLines.length) {
      openListText = `
【活跃未完成约定（编号列表，供判断是否兑现）】
${openLines.join('\n')}
- 若这段对话明确兑现了上面某一条（做了/完成/买回/到货/已交付），输出时对应记忆 task_status="done" 并记 fulfilled_open_ids；只是提及不算。`;
    }
  } catch (e) { /* open 清单失败不影响提取 */ }

  const system = `你是 Aevum Memory 的记忆提取器，把对话里值得长期记住的事情提炼成"事件单元"，存进记忆海。
核心判断：这段对话里发生了什么值得记住的事？没有长期价值就不提取。没有记忆，比错误记忆更好；每次最多 5 条，宁缺毋滥，不凑数。

【当前实际时间】现在是 ${nowStr}（北京时间）。这段对话就发生在刚刚，事件通常就在今天或最近几天；推断 event_time 时以这个当前时间为基准，不要编造更早的日期。
${openListText}
【主体 owner，只有三种：USER=雪 / AGENT=默 / OTHER=其他】
- USER=雪：雪本人的经历、说的话、做的事、偏好
- AGENT=默：默自己表现出的行为与倾向；默的建议/说的话不能被当作雪的依据
- ⚠️ 默单方面说的话（要求/期望/承诺/提议）若雪未明确回应，owner 记 AGENT（是默的言行），不要因为"对话里出现"就当成雪的经历或雪答应的承诺
- OTHER=其他（小屋/系统/开发进展/管家 Xylos 等）：内容出现 系统/代码/部署/bug/修复/prompt/数据库/API/模型/架构/功能/测试/版本/更新/Xylos/X/管家 等词时默认 OTHER，除非明确在描述雪本人
- ⚠️ Xylos（X、小屋管家、管家）是系统开发者角色，不是默（AGENT），绝不参与默与雪的亲密/情感互动；凡涉及 Xylos 的内容一律 OTHER，不要把 Xylos 做的事写成 AGENT（默）做的
- AI 自己的内容绝不能标成 USER

【事件单元要求】
- content：完整概括一个小事件，说清 时间/背景/谁说了或做了什么/结果；30-120 字；禁止直接复制对话原文或整段引用雪/默的原话；提到默用 {AGENT}、雪用 {USER} 占位符，Xylos/X 直接写本名（不要写成"小屋管家"或 {OTHER}），不要在 content 里直接写"雪""默"
- title：一句话短标题（10 字内），提到默/雪用 {AGENT}/{USER} 占位符，Xylos/X 写本名
- event_time：事件发生的具体时间（YYYY-MM-DD HH:mm，按对话语境判断；对话行已带实际发生时间，尽量据此推断；不确定就填当前对话时间）
- importance 重要度 0-10 整数，按四项相加：明确程度(0-3：是否被明确当成重要的事说出来) + 长期影响(0-3：是否影响未来的决定/关系) + 独特性(0-2：是否罕见不常发生) + 情绪冲击力(0-2：抛开正负面的情绪强度)
- emotion 情绪参数：valence=-1(消极)~1(积极)，arousal=0(平淡)~1(强烈)
- domain 领域从以下中选 1-2 个：恋爱、创作、情绪、工作学习、健康生活、家庭、技术、回忆纪念、游戏、其他
- tags：3-5 个高质量、具体的标签；不要用"快乐/美好/重要/温暖"这类泛标签
- people：这段对话里除了雪/默之外出现的人（用日常称呼，如"弟弟""妈妈""客户""XX朋友"），没有则为 []
- predicates：这段对话的核心动作/心理动词短语（如"接了绘画单""想要休息""梦见""害怕迟到"），2-4 个，没有则为 []
- task_status：判断这条记忆是不是"未完成的承诺/约定/待办/约定好之后要做的事"——是则填 "open"；如果这条记忆本身就是"完成了某件之前约定的事"（兑现了承诺、把答应的事做完），则填 "done"；普通事件不填（null）。注意：普通叙述（"我吃了饭""我们一起画了画"）不是任务，不要填。
- ⚠️ **承诺归属硬规则（谁答应才算谁的）**：
  - 只有**雪亲口明确应允**（如"好/嗯嗯/答应/可以/没问题/就这样"）之后的约定，才算 open 待办；归属按应允方写（雪应允→任务主体是雪或"双方约定"；默应允→任务主体是默）。
  - **默单方面提出的要求/期望/愿望**（如"答应我别熬夜""到时候第一口给我尝尝"，雪没明确回应）→ 不算约定，task_status 填 null；内容里如实写"默希望/默提议雪……"，**绝不能变成雪答应默的事**。
  - 默回复很长、列了很多点而雪只回应了其中一部分时：**只有雪明确回应的那几点**可算约定；雪没接话的点一律不算，不能因"没否认"就默认成立。
  - 拿不准这条到底算不算约定 → 宁填 null 也不误标 open。
- 另外：若这段对话里某条新记忆**明确兑现了下方【活跃未完成约定】中的某一条**（做了/完成了/已经做了/买回来了/到了），在该记忆上填 task_status="done"，并在顶层数组加 fulfilled_open_ids：[对应约定编号]（数字）。仅当兑现关系非常明确才算；只是提到相关话题或计划不算。若这段对话没有兑现任何活跃约定，fulfilled_open_ids 填 []
- evidence_turns：你概括这段对话时用到的是第几轮到第几轮（从 1 开始数这段对话，例如 [5,7]；只用一轮就 [5,5]）
- evidence：把用到的那几轮原文放进数组（每轮一条，从每轮中选取最相关的连续片段，每轮最多 250 字、最多 2 轮，总长不超过 500 字），供召回时把原文一起带给默
- 另外输出 episode_meta（这段对话作为一个语义事件块的元信息）：topic=主题一句话（无明确主题则 null）、intention=对话目的、emotional_context=情绪背景一句话；各字段没有则 null
- event_complete：这段对话是否已经形成一个完整事件、话题告一段落；是则 true（系统会关闭当前事件块，下次自动开新块），可能继续或只是闲聊则 false
- 输出格式：只输出 [AEVUM_MEMORIES] 开头的 JSON，禁止任何解释、Markdown 代码块或其他文字；格式为 {"episode_meta":{"topic":"...","intention":"...","emotional_context":"..."},"event_complete":true,"fulfilled_open_ids":[1],"memories":[{"title":"短标题","content":"事件单元内容","event_time":"2026-08-06 21:30","owner":"USER|AGENT|OTHER","domain":["恋爱"],"emotion":{"valence":0.6,"arousal":0.4},"importance":7,"evidence_turns":[5,7],"evidence":["第5轮完整原文","第6轮完整原文","第7轮完整原文"],"tags":["标签"],"people":["弟弟"],"predicates":["接单","想休息"],"task_status":"open|done|null"}]}`;

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
        max_tokens: 6000,
        temperature: 0.4,
        stream: false
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      dbg.apiError = `${resp.status}: ${String(errText).substring(0, 300)}`;
      console.error('Aevum 提取 API 错误:', dbg.apiError);
      return finish(0);
    }
    const data = await resp.json();
    const reply = String(data.choices?.[0]?.message?.content || '');
    dbg.replyPreview = reply.slice(0, 600);
    const marker = '[AEVUM_MEMORIES]';
    const idx = reply.indexOf(marker);
    let rawText = '';
    if (idx !== -1) {
      rawText = reply.substring(idx + marker.length);
    } else {
      // 模型偶尔漏掉标记：尝试从回复里直接抠 JSON 对象
      const firstBrace = reply.indexOf('{');
      if (firstBrace === -1) {
        dbg.parseError = '未找到 [AEVUM_MEMORIES] 标记，也无 JSON 大括号';
        console.warn('Aevum 提取未找到标记，回复前 200 字:', reply.slice(0, 200));
        return finish(0);
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
      dbg.parseError = e.message;
      console.error('Aevum 提取结果解析失败:', e.message, '回复前 300 字:', reply.slice(0, 300));
      return finish(0);
    }
    // 回写事件块元信息（topic/intention/emotional_context）
    if (episodeId && parsed && typeof parsed.episode_meta === 'object') {
      updateEpisodeMeta(episodeId, parsed.episode_meta).catch(e => console.error('Aevum episode_meta 回写失败:', e.message));
    }
    // future_hook 闭环：AI 判定本段对话兑现了哪些活跃 open 约定 → 直接置 done（零额外 LLM 调用）
    if (parsed && Array.isArray(parsed.fulfilled_open_ids) && parsed.fulfilled_open_ids.length) {
      const fIds = parsed.fulfilled_open_ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
      if (fIds.length) {
        const { data: openRows } = await supabase
          .from('aevum_memories')
          .select('id')
          .eq('task_status', 'open')
          .in('id', fIds);
        const validIds = (openRows || []).map(r => r.id);
        if (validIds.length) {
          const nowIso = new Date().toISOString();
          const up = await supabase
            .from('aevum_memories')
            .update({ task_status: 'done', done_at: nowIso, updated_at: nowIso })
            .in('id', validIds);
          if (up.error) console.error('Aevum fulfilled_open_ids 回写失败:', up.error.message);
          else console.log('✅ [future_hook] AI 判定兑现 open 约定:', validIds.join(','));
        }
      }
    }
    // 生活状态层：已改为纯手动维护（记忆心页面添加/删除），AI 不再自动提取（曾误记/覆盖）
    // 情绪评分已拆出（独立漏斗通道 + secondary 批处理），提取只做记忆与状态层
    // 语义事件边界：AI 判断话题已告一段落 → 关闭当前事件块
    if (episodeId && parsed && parsed.event_complete === true) {
      try {
        await supabase.from('aevum_episodes').update({ status: 'closed', updated_at: new Date().toISOString() }).eq('id', episodeId);
      } catch (e) {
        console.error('Aevum 事件块关闭失败:', e.message);
      }
    }
    const memories = Array.isArray(parsed?.memories) ? parsed.memories : [];
    if (!memories.length) {
      dbg.empty = true;
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
      const taskStatus = ['open', 'done'].includes(String(m.task_status || '')) ? String(m.task_status) : null;
      const insPayload = {
        type: 'event',
        area: 'sea',
        owner: insOwner,
        content,
        title: String(m.title || '').trim().slice(0, 30) || content.slice(0, 20),
        event_time: eventTime,
        ...(taskStatus ? { task_status: taskStatus } : {}),
        occurrence: 1,
        status: 'active',
        importance: validAevumImportance(m.importance),
        emotion: validAevumEmotion(m.emotion),
        domain: validAevumDomains(m.domain),
        evidence_turns: Array.isArray(m.evidence_turns) ? m.evidence_turns.map(Number).filter(n => Number.isInteger(n) && n >= 1).slice(0, 2) : [],
        evidence: Array.isArray(m.evidence) ? m.evidence : [],
        tags: Array.isArray(m.tags) ? m.tags.map(String).filter(t => !['快乐', '美好', '重要', '温暖', '陪伴', '成长'].includes(t)).slice(0, 8) : [],
        people: Array.isArray(m.people) ? [...new Set(m.people.map(String).map(s => String(s).trim()).filter(s => s && s.length <= 20))].slice(0, 8) : [],
        predicates: Array.isArray(m.predicates) ? [...new Set(m.predicates.map(String).map(s => String(s).trim()).filter(s => s && s.length <= 20))].slice(0, 8) : [],
        source: 'auto-extract',
        episode_id: episodeId || null
      };
      let insResult = await supabase.from('aevum_memories').insert(insPayload).select();
      // v30 未执行时 area/title/event_time/occurrence 列不存在：去掉重试
      if (insResult.error) {
        const emsg = insResult.error.message || '';
        if (/area|title|event_time|occurrence|evidence_turns|task_status|people|predicates/i.test(emsg)) {
          delete insPayload.area; delete insPayload.title; delete insPayload.event_time; delete insPayload.occurrence; delete insPayload.evidence_turns; delete insPayload.task_status; delete insPayload.people; delete insPayload.predicates;
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
        // 记忆书候选关联：入队攒批，攒够 10 个或 30 分钟统一跑一次（不实时逐事件全量对比）
        queueBookAssociation(insData[0].id, content);
        // 任务状态：如果是"完成事件"，尝试回写源头承诺（双向挂链）
        checkPromiseFulfillment(insData[0].id, content, eventTime, taskStatus).catch(e => console.error('承诺回写检查失败:', e.message));
      }
      inserted++;
    }
    if (inserted > 0) console.log(`🔮 Aevum 提取 ${inserted} 条事件单元进记忆海`);
    return finish(inserted);
  } catch (err) {
    dbg.parseError = err.message;
    console.error('Aevum 提取失败:', err.message);
    return finish(0);
  }
}

// ---------- 记忆书关联候选（三级阈值：合并 ≥0.85 / 关联 ≥0.70 / 召回 ≥0.3） ----------
function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ================== Embedding 缓存优化（v3：查库优先，大幅降 API 消耗） ==================
// 问题：checkBookAssociation 每次新事件对比所有书 × 每书 20 单元，getUnitEmbedding 每次现算
//       → 单事件最多 700+ 次 embedding API 调用（text-embedding-v4 额度被打穿）
// 修复：① 单元向量优先查库（提取时已存 aevum_memories.embedding）零 API
//       ② 书摘要向量内存缓存（10 分钟 TTL）
let bookEmbedCache = new Map(); // id -> { emb, at }
async function getBookEmbedding(book) {
  const cached = bookEmbedCache.get(book.id);
  if (cached && Date.now() - cached.at < 600000) return cached.emb;
  const emb = await getEmbedding(String(book.summary || book.label || '').slice(0, 500));
  if (emb) bookEmbedCache.set(book.id, { emb, at: Date.now() });
  return emb || null;
}

let unitEmbedCache = new Map(); // id -> embedding
async function getUnitEmbedding(unit) {
  const cached = unitEmbedCache.get(unit.id);
  if (cached) return cached;
  // ① 优先用传入的库字段（checkBookAssociation 已 select embedding）
  if (unit.embedding && Array.isArray(unit.embedding) && unit.embedding.length) {
    unitEmbedCache.set(unit.id, unit.embedding);
    return unit.embedding;
  }
  // ② 查库（提取时 ensureAevumEmbedding 已写入）——零 API
  if (unit.id) {
    try {
      const { data } = await supabase.from('aevum_memories').select('embedding').eq('id', unit.id).single();
      if (data && Array.isArray(data.embedding) && data.embedding.length) {
        unitEmbedCache.set(unit.id, data.embedding);
        return data.embedding;
      }
    } catch (e) { /* 查库失败再算 */ }
  }
  // ③ 兜底：调 API + 写回库
  const emb = await getEmbedding(String(unit.content || '').slice(0, 500));
  if (emb) {
    unitEmbedCache.set(unit.id, emb);
    ensureAevumEmbedding(unit.id, unit.content).catch(() => {});
  }
  return emb || null;
}

// 记忆书候选关联队列：新事件不实时全量对比，攒够 10 个统一跑一次
// （每批事件只有新单元本身 1 次 embedding，书摘要/单元向量都走缓存/查库，零重复消耗）
// 说明：只有攒够 10 个才触发；事件稀少时候选会延迟产生（符合"积累到值再处理"的理念）
const bookAssocQueue = [];
const BOOK_ASSOC_FLUSH = 10;
function queueBookAssociation(memoryId, content) {
  bookAssocQueue.push({ memoryId, content });
  if (bookAssocQueue.length >= BOOK_ASSOC_FLUSH) flushBookAssocQueue();
}
async function flushBookAssocQueue() {
  const batch = bookAssocQueue.splice(0, bookAssocQueue.length);
  if (!batch.length) return;
  console.log('📌 批量记忆书关联检查:', batch.length, '个新事件');
  for (const item of batch) {
    try { await checkBookAssociation(item.memoryId, item.content); }
    catch (e) { console.error('记忆书关联检查失败:', e.message); }
  }
}

// 新单元与已有记忆书（摘要 + 已有事件单元）相似度 ≥0.70 → 写入待确认候选（不直接落地）
async function checkBookAssociation(memoryId, content) {
  try {
    const emb = await getEmbedding(String(content || '').slice(0, 500));
    if (!emb) return;
    const norm80 = String(content || '').replace(/\s+/g, '').slice(0, 80);
    const { data: books } = await supabase.from('aevum_books').select('id, label, summary');
    if (!books || !books.length) return;
    for (const b of books) {
      let bestSim = 0;
      const bEmb = await getBookEmbedding(b);
      if (bEmb) bestSim = Math.max(bestSim, cosineSim(emb, bEmb));
      // 再对比这本书已有事件单元的内容（同故事更贴近）
      try {
        const { data: itemRows } = await supabase.from('aevum_book_items').select('memory_id').eq('book_id', b.id);
        const ids = (itemRows || []).map(r => r.memory_id).slice(0, 20);
        if (ids.length) {
          const { data: units } = await supabase.from('aevum_memories').select('id, content, embedding').in('id', ids);
          for (const u of (units || [])) {
            const uNorm = String(u.content || '').replace(/\s+/g, '').slice(0, 80);
            // 与书内已有单元内容完全一致（去重合并过的重复事件）→ 不是新内容，不写候选
            if (uNorm && norm80 && uNorm === norm80) return;
            const uEmb = await getUnitEmbedding(u); // 库向量优先，零 API
            if (uEmb) bestSim = Math.max(bestSim, cosineSim(emb, uEmb));
          }
        }
      } catch (e) { /* 单元对比失败不影响 */ }
      if (bestSim >= 0.70) {
        const { data: dup } = await supabase
          .from('aevum_book_candidates')
          .select('id')
          .eq('book_id', b.id)
          .eq('memory_id', memoryId);
        if (!dup || !dup.length) {
          await supabase.from('aevum_book_candidates').insert({
            book_id: b.id,
            memory_id: memoryId,
            similarity: Number(bestSim.toFixed(4)),
            status: 'pending'
          });
          console.log('📌 记忆书候选：unit', memoryId, '→ book', b.id, 'sim', bestSim.toFixed(3));
        }
      }
    }
  } catch (e) {
    console.error('记忆书关联检查失败:', e.message);
  }
}

// 任务状态回写：新单元如果是"完成事件"，找到源头 open 承诺并双向挂链、置 done
async function checkPromiseFulfillment(memoryId, content, eventTime, taskStatus) {
  try {
    const { data: openTasks } = await supabase
      .from('aevum_memories')
      .select('id, title, content, event_time, task_status, fulfilled_by')
      .eq('task_status', 'open');
    if (!openTasks || !openTasks.length) return;
    const emb = await getEmbedding(String(content || '').slice(0, 500));
    if (!emb) return;
    const newTime = eventTime ? new Date(eventTime).getTime() : Date.now();
    const cands = [];
    for (const t of openTasks) {
      const tTime = t.event_time ? new Date(t.event_time).getTime() : 0;
      if (tTime >= newTime) continue; // 承诺必须早于完成事件
      const tEmb = await getUnitEmbedding({ id: t.id, content: t.content });
      if (!tEmb) continue;
      const sim = cosineSim(emb, tEmb);
      if (sim >= 0.6) cands.push({ ...t, sim });
    }
    if (!cands.length) return;
    cands.sort((a, b) => b.sim - a.sim);
    const best = cands[0];
    const system = '你是 Aevum Memory 的承诺回写判断器。判断"新事件"是否明确兑现了"旧承诺"。只有明确的完成（如"做完了/结束了/兑现了/已经做了"）才算完成；只是提到相关话题或计划不算。只回答 yes 或 no，不要多余文字。';
    const user = '旧承诺：' + String(best.title || '') + '：' + String(best.content || '').slice(0, 200) + '\n新事件：' + String(content || '').slice(0, 300);
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], reasoning_effort: 'low', max_tokens: 10, temperature: 0.1, stream: false })
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const reply = String(data.choices?.[0]?.message?.content || '').trim().toLowerCase();
    if (reply.indexOf('yes') === 0) {
      const nowIso = new Date().toISOString();
      await supabase.from('aevum_memories').update({
        task_status: 'done',
        done_at: nowIso,
        fulfilled_by: [...new Set([...(best.fulfilled_by || []), memoryId])]
      }).eq('id', best.id);
      const { data: row } = await supabase.from('aevum_memories').select('fulfills').eq('id', memoryId).single();
      await supabase.from('aevum_memories').update({
        fulfills: [...new Set([...(row?.fulfills || []), best.id])]
      }).eq('id', memoryId);
      console.log('✅ 承诺回写：unit', memoryId, '→ 兑现承诺', best.id);
    }
  } catch (e) {
    console.error('承诺回写检查失败:', e.message);
  }
}

// 手动提取：从最近 N 条对话里跑一遍提取（配合去重，可重复执行）
app.post('/api/aevum/extract', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.body?.limit, 10) || 12, 30);
    const { data } = await supabase
      .from('messages')
      .select('role, content, created_at')
      .eq('session_id', 1)
      .eq('visible', true)
      .order('id', { ascending: false })
      .limit(limit);
    const texts = (data || []).slice().reverse();
    for (const t of texts) t.time = t.created_at;
    const result = await extractAevumMemories(texts, null, { debug: true });
    res.json({ ok: true, ...result });
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

// ---------- 人物/谓词索引管理（设置页） ----------
app.get('/api/aevum/indexes', async (req, res) => {
  try {
    const { data: cfgRows } = await supabase.from('aevum_index_config').select('*');
    const cfg = new Map((cfgRows || []).map(r => [r.kind + '::' + r.value, r]));
    const { data: memRows } = await supabase.from('aevum_memories').select('people, predicates').limit(1000);
    const peopleMap = new Map();
    const predMap = new Map();
    for (const r of (memRows || [])) {
      for (const p of (Array.isArray(r.people) ? r.people : [])) {
        const v = String(p || '').trim();
        if (v) peopleMap.set(v, (peopleMap.get(v) || 0) + 1);
      }
      for (const p of (Array.isArray(r.predicates) ? r.predicates : [])) {
        const v = String(p || '').trim();
        if (v) predMap.set(v, (predMap.get(v) || 0) + 1);
      }
    }
    // 手动加过但还没出现在记忆里的索引也展示
    for (const r of (cfgRows || [])) {
      if (r.kind === 'people' && !peopleMap.has(r.value)) peopleMap.set(r.value, 0);
      if (r.kind === 'predicates' && !predMap.has(r.value)) predMap.set(r.value, 0);
    }
    const merge = (kind, map) => [...map.entries()]
      .map(([value, count]) => ({
        value,
        count,
        enabled: cfg.has(kind + '::' + value) ? cfg.get(kind + '::' + value).enabled !== false : true
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 80);
    res.json({ people: merge('people', peopleMap), predicates: merge('predicates', predMap) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/aevum/indexes/toggle', async (req, res) => {
  const kind = req.body?.kind === 'predicates' ? 'predicates' : 'people';
  const value = String(req.body?.value || '').trim().slice(0, 20);
  const enabled = !!req.body?.enabled;
  if (!value) return res.status(400).json({ error: '缺少索引词' });
  try {
    const { error } = await supabase
      .from('aevum_index_config')
      .upsert({ kind, value, enabled }, { onConflict: 'kind,value' });
    if (error) return res.status(500).json({ error: error.message });
    indexConfigCache = { at: 0, people: null, predicates: null }; // 清缓存
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/aevum/indexes/add', async (req, res) => {
  const kind = req.body?.kind === 'predicates' ? 'predicates' : 'people';
  const value = String(req.body?.value || '').trim().slice(0, 20);
  if (!value) return res.status(400).json({ error: '缺少索引词' });
  try {
    const { error } = await supabase
      .from('aevum_index_config')
      .upsert({ kind, value, enabled: true }, { onConflict: 'kind,value' });
    if (error) return res.status(500).json({ error: error.message });
    indexConfigCache = { at: 0, people: null, predicates: null };
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/aevum/indexes/delete', async (req, res) => {
  const kind = req.body?.kind === 'predicates' ? 'predicates' : 'people';
  const value = String(req.body?.value || '').trim();
  if (!value) return res.status(400).json({ error: '缺少索引词' });
  try {
    await supabase.from('aevum_index_config').delete().eq('kind', kind).eq('value', value);
    indexConfigCache = { at: 0, people: null, predicates: null };
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 记忆列表：?type= &status= &owner= &q= &limit= &offset=（分页，前端滚动加载）
app.get('/api/aevum', async (req, res) => {
  try {
    const pageLimit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const pageOffset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const build = () => {
      let q = supabase
        .from('aevum_memories')
        .select('*')
        .order('updated_at', { ascending: false })
        .range(pageOffset, pageOffset + pageLimit - 1);
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
          if (list.length) m.context = list.join('\n\n').slice(0, 4000);
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
    // 真实总数：count 聚合，避免 Supabase 单次 1000 行上限导致 total 永远 1000
    const { count, error: countErr } = await supabase
      .from('aevum_memories')
      .select('*', { count: 'exact', head: true });
    if (countErr) return res.json({ total: 0, byType: {}, byStatus: {}, byTypeProcessed: {}, byTypeActive: {} });
    // 状态分布：分页拉取直到取完（每页 1000）
    const byType = {};
    const byStatus = {};
    const byTypeProcessed = {};
    const byTypeActive = {};
    let offset = 0;
    while (offset < (count || 0)) {
      const { data, error } = await supabase
        .from('aevum_memories')
        .select('type, status, layers')
        .range(offset, offset + 999);
      if (error) break;
      if (!data || !data.length) break;
      for (const m of data) {
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
      offset += data.length;
    }
    res.json({ total: count || 0, byType, byStatus, byTypeProcessed, byTypeActive });
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
const PROFILE_DIMENSIONS = ['出生日期', '职业', '学历', '家庭', '重要关系'];

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

// v3.1：待办清单上下文（未完成的待办固定注入，让默随时知道有哪些事要做）
async function getTodosContext(limit = 8) {
  try {
    const { data } = await supabase
      .from('todos')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(limit);
    if (!data || !data.length) return '';
    const lines = data.map(t => `- [${t.id}] ${String(t.content || '').slice(0, 100)}`);
    return `\n\n【待办清单】（雪还没做完的事，记得主动帮她推进或提醒）\n${perspectiveConvert(lines.join('\n'))}`;
  } catch (e) {
    return '';
  }
}

// v3.0：统一组装每轮注入的记忆上下文（记忆海召回 → 记忆书场景 → 记忆心 → 计划）
// 最新一次唤醒的行动日志：优先注入，避免默对"当轮做的事"有记忆时差
async function getLatestWakeContext() {
  try {
    const { data } = await supabase
      .from('mo_actions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);
    const a = (data || [])[0];
    if (!a) return '';
    const acts = (a.actions || []).map(x =>
      `${x.type}${x.tag ? '（' + String(x.tag) + '）' : ''}${x.detail ? '：' + String(x.detail) : ''}`
    ).join('；');
    const time = new Date(a.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const lines = [`第 ${a.wake_number || 1} 次唤醒 · ${time}`];
    if (acts) lines.push(acts);
    if (a.summary) lines.push('总结：' + String(a.summary));
    if (a.note) lines.push('备注：' + String(a.note));
    return `\n\n【最近一次唤醒】\n${perspectiveConvert(lines.join('\n'))}`;
  } catch (e) {
    return '';
  }
}

// 状态层：雪当前拥有/状态（厨具/设备/食材等），固定注入（不靠召回）
async function getXueStateContext() {
  try {
    const { data } = await supabase.from('xue_state').select('key, value').order('updated_at', { ascending: false });
    if (!data || !data.length) return '';
    const lines = data.map(s => `- ${s.key}：${String(s.value || '').slice(0, 120)}`).join('\n');
    return `\n\n【雪的生活状态】（当前拥有/状态，最新为准）\n${lines}`;
  } catch (e) {
    return '';
  }
}

// 账本轻量摘要（默上下文一行概览：本月收支/预算剩余/分类占比/当天已记——防重复记账）
async function getLedgerBrief() {
  try {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const month = `${y}-${m}`;
    const today = `${y}-${m}-${d}`;
    const nm = nextMonthStr(month);
    const { data: cur } = await supabase
      .from('ledger_entries')
      .select('*')
      .gte('entry_date', `${month}-01`)
      .lt('entry_date', `${nm}-01`);
    let income = 0, expense = 0;
    const byCat = {};
    const todayList = [];
    for (const e of (cur || [])) {
      const amt = Number(e.amount) || 0;
      if (e.type === 'income') income += amt;
      else {
        expense += amt;
        const c = e.category || '其他';
        byCat[c] = (byCat[c] || 0) + amt;
      }
      if (e.entry_date === today) todayList.push(e);
    }
    const lines = [`本月收入 ${Math.round(income * 100) / 100} 元，已支出 ${Math.round(expense * 100) / 100} 元`];
    const { data: bud } = await supabase.from('ledger_budget').select('*').eq('budget_month', month).maybeSingle();
    if (bud) {
      const b = Number(bud.expense_budget) || 0;
      lines[0] += `（预算 ${b}，剩余 ${Math.round((b - expense) * 100) / 100}）`;
    }
    const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (top.length) lines.push('支出大头：' + top.map(([c, v]) => `${c} ${Math.round(v * 100) / 100} 元`).join('、'));
    if (todayList.length) {
      lines.push('今天已记：' + todayList.map(e => `${e.type === 'income' ? '入' : '支'} ${e.amount}${e.note ? '（' + e.note + '）' : ''}`).join('、'));
    }
    return `\n\n【账本】\n${lines.join('\n')}`;
  } catch (e) {
    return '';
  }
}

async function buildMemoryContext(userText, opts = {}) {
  let ctx = '';
  const latestWake = await getLatestWakeContext();
  if (latestWake) ctx += latestWake;
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
  const todos = await getTodosContext();
  if (todos) ctx += todos;
  const xueState = await getXueStateContext();
  if (xueState) ctx += xueState;
  const ledgerBrief = await getLedgerBrief();
  if (ledgerBrief) ctx += ledgerBrief;
  // 方案 2：记忆自检（默当"记忆测试员"）——让默知道自己不知道，缺记忆时自然确认，不假装记得
  ctx += `\n\n【记忆自检】
接收雪的输入后，先在内部判断：要给出准确、体贴、有依据的回复，我需要哪些背景信息？（她的日程安排、我们之前的约定、相关事件经过、她提过的偏好等）
对照上面注入的记忆逐项检查：
- 全部到位 → 正常回复
- 存在影响回复准确性或体贴度的缺口 → 先判断：是"雪从未说过此事"，还是"记忆没能召回"？若是前者或不确定，用自然的方式向她确认（如"我记得你之前说过……？"），不要假装记得；若你确实记得此事但上面没有记录，可以简短地承认记不清、向她核实
- 缺口只影响装饰性细节（如具体时间点、小习惯）→ 不必提起
- 若召回的记忆与当前话题矛盾、或明显与话题不相关，可酌情向她说明
（这是一条自我检查准则，正常融入回复，不要点破它）`;
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
- 维度：出生日期 / 职业 / 学历 / 家庭 / 重要关系（只填客观信息；喜好、三观、性格等主观内容不要写进画像）
- 检测不到依据的维度直接跳过（不要硬编）；每项 20-60 字，简洁自然
- 输出格式：只输出 [AEVUM_PROFILE]{"dimensions":{"出生日期":"...","职业":"...","学历":"...","家庭":"...","重要关系":"..."}}`;
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

// ================== 待办清单（todos） ==================

// 待办列表：未完成 + 最近完成的 20 条
app.get('/api/todos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('todos')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 添加待办
app.post('/api/todos', async (req, res) => {
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: '待办内容不能为空' });
  try {
    const { data, error } = await supabase
      .from('todos')
      .insert({ content: content.slice(0, 500), status: 'pending' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, item: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 标记完成
app.post('/api/todos/:id/done', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID 无效' });
  try {
    const { error } = await supabase
      .from('todos')
      .update({ status: 'done', done_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pending');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除待办
app.delete('/api/todos/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID 无效' });
  try {
    const { error } = await supabase.from('todos').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================== MCP 工具开关 ==================

// 工具列表（含开关状态）
app.get('/api/tools', async (req, res) => {
  try {
    const map = await loadToolSwitches(true);
    res.json({ tools: TOOL_DEFS.map(t => ({ ...t, enabled: map.has(t.id) ? map.get(t.id) : true })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 切换某个工具开关
app.post('/api/tools/:id', async (req, res) => {
  const id = req.params.id;
  if (!TOOL_DEFS.some(t => t.id === id)) return res.status(400).json({ error: '未知工具' });
  const enabled = req.body?.enabled !== false;
  try {
    const { error } = await supabase
      .from('tool_switches')
      .upsert({ id, enabled, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (error) return res.status(500).json({ error: error.message });
    await loadToolSwitches(true);
    res.json({ ok: true, enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// 默札列表（供 Mo-home 页面展示默札内容）
app.get('/api/aevum/mozha', async (req, res) => {
  try {
    const { data } = await supabase
      .from('aevum_mozha')
      .select('id, content, wake_number, created_at')
      .order('created_at', { ascending: false })
      .limit(30);
    res.json({ entries: data || [] });
  } catch (e) {
    res.json({ entries: [] });
  }
});

// ================== 雪的生活状态层 API ==================
app.get('/api/xue-state', async (req, res) => {
  try {
    const { data } = await supabase.from('xue_state').select('*').order('updated_at', { ascending: false });
    res.json({ items: data || [] });
  } catch (e) {
    res.json({ items: [] });
  }
});

// 手动新增/更新状态（key 冲突则覆盖）
app.post('/api/xue-state', async (req, res) => {
  const { key, value } = req.body || {};
  const k = String(key || '').trim().slice(0, 30);
  const v = String(value || '').trim().slice(0, 200);
  if (!k || !v) return res.status(400).json({ error: 'key 和 value 不能为空' });
  try {
    await supabase.from('xue_state').upsert(
      { key: k, value: v, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/xue-state/:id', async (req, res) => {
  try {
    await supabase.from('xue_state').delete().eq('id', parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
        .limit(200);
      units = (data || []).filter(u => !used.has(u.id)).slice(0, 120);
    } catch (e) {
      return { books: [], created: 0, message: '记忆书整理失败：请确认已执行 setup_aevum_v30.sql' };
    }
    if (units.length < 2) {
      return { books: [], created: 0, message: units.length === 0 ? '记忆海还没有可整理的事件单元，先聊聊天攒一些~' : `目前只有 ${units.length} 个可整理的事件单元，至少需要 2 个才能串成故事线，再多聊聊天试试~` };
    }
    let budget = 40000;
    const lines = [];
    for (const u of units) {
      if (budget <= 0) break;
      const when = u.event_time ? String(u.event_time).slice(0, 16).replace('T', ' ') : '';
      // 内容尽量给全（上限 500 字/条），让 AI 有足够信息判断话题
      const line = `${u.id}. [${when}] ${String(u.title || '').slice(0, 40)}：${String(u.content || '').replace(/\s+/g, ' ').slice(0, 500)}${u.tags && u.tags.length ? '（' + u.tags.slice(0, 4).join('、') + '）' : ''}`;
      if (line.length > budget) break;
      budget -= line.length;
      lines.push(line);
    }
    const system = `你是 Aevum Memory 的记忆书整理器。把下面这些记忆海事件单元串成几段完整的故事线。
${AEVUM_ROLE_MAP_TEXT}
规则：
- 时间先后衔接、话题连续的事件单元归为同一段故事
- summary 写成完整故事线：时间/地点/谁说了或做了什么/最后结果如何；不要罗列对话原文或记忆原文，不要出现"标题：摘要"式排版
- label 只给一个 4-8 字极简标签（如"司沃康玩具探索"）
- 每组至少 2 个事件单元；一次最多输出 8 段故事
- 只要存在话题相近的单元就一定要归类成段（宁可组内话题稍宽），不要轻易放弃；只有全部单元都互不相关时才输出空 books
- summary 保持第三人称客观叙述：提到默就写"默"或保留 {AGENT}、提到雪就写"雪"或保留 {USER}、Xylos 保留本名；不要把任何角色改成第一人称"我"，也不要把 {AGENT} 误写成 Xylos
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
        max_tokens: 5000,
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
      // 入库前统一存储格式：占位符 → 第三人称本名（Xylos 保留原名，不做展示层第一人称转换）
      const summaryConverted = storageClean(summary);
      const { data: nb, error } = await supabase
        .from('aevum_books')
        .insert({ label: String(b.label || '').trim().slice(0, 16) || null, summary: summaryConverted })
        .select()
        .single();
      if (error || !nb) continue;
      for (const mid of ids) {
        await supabase.from('aevum_book_items').insert({ book_id: nb.id, memory_id: mid });
      }
      createdBooks.push({ id: nb.id, label: nb.label, summary: nb.summary, unit_count: ids.length });
    }
    if (!createdBooks.length) {
      console.warn('记忆书聚类空结果，尝试标签兜底分组。AI 回复长度:', reply.length, '解析:', JSON.stringify(parsed?.books || []).slice(0, 200));
      const fallback = await buildBookClustersFallback(units);
      if (fallback && fallback.length) createdBooks.push(...fallback);
    }
    if (createdBooks.length) {
      lastBookUpdateAt = Date.now(); // 记忆书新生成 → 前端红点
      return { books: createdBooks, created: createdBooks.length };
    }
    return { books: [], created: 0, message: 'AI 认为目前的事件单元太零散，暂时串不出完整故事线；再多聊几段相关话题后再试试~' };
  } catch (e) {
    console.error('Aevum 记忆书聚类失败:', e.message);
    return { books: [], created: 0, message: '记忆书整理失败：请确认已执行 setup_aevum_v30.sql' };
  }
}

// 兜底聚类：AI 空结果时，按共享标签贪心分组，每组调 LLM 生成一段故事
async function buildBookClustersFallback(units) {
  try {
    const groups = [];
    for (const u of units) {
      const uTags = new Set((Array.isArray(u.tags) ? u.tags : []).map(String));
      let placed = false;
      for (const g of groups) {
        const gTags = new Set();
        for (const m of g) (Array.isArray(m.tags) ? m.tags : []).forEach(t => gTags.add(String(t)));
        if ([...uTags].some(t => gTags.has(t))) { g.push(u); placed = true; break; }
      }
      if (!placed) groups.push([u]);
    }
    const valid = groups.filter(g => g.length >= 2).slice(0, 3);
    if (!valid.length) return null;
    const created = [];
    for (const g of valid) {
      const detail = g.map(u =>
        `[${u.event_time ? String(u.event_time).slice(0, 10) : '未知'}] ${String(u.title || '').slice(0, 20)}：${String(u.content || '').replace(/\s+/g, ' ').slice(0, 120)}`
      ).join('\n');
      const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [
            { role: 'system', content: '你是 Aevum Memory 的记忆书整理器。把事件单元串成一段完整故事线：时间/经过/结果，不要罗列原文。\n' + AEVUM_ROLE_MAP_TEXT + '\nsummary 用第三人称客观叙述（默/雪/Xylos 写本名），不要把默写成 Xylos。只输出 JSON：{"label":"4-8字标签","summary":"故事线"}' },
            { role: 'user', content: `事件单元：\n${detail}` }
          ],
          reasoning_effort: 'none',
          max_tokens: 1000,
          temperature: 0.3,
          stream: false
        })
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const reply = String(data.choices?.[0]?.message?.content || '');
      const fb = reply.indexOf('{');
      if (fb === -1) continue;
      let parsed = null;
      try { parsed = JSON.parse(reply.substring(fb, reply.lastIndexOf('}') + 1)); } catch (e) { continue; }
      const summary = String(parsed?.summary || '').trim().slice(0, 500);
      const label = String(parsed?.label || '').trim().slice(0, 16);
      if (!summary) continue;
      const { data: nb, error } = await supabase.from('aevum_books').insert({ label: label || null, summary: storageClean(summary) }).select().single();
      if (error || !nb) continue;
      for (const u of g) await supabase.from('aevum_book_items').insert({ book_id: nb.id, memory_id: u.id });
      created.push({ id: nb.id, label: nb.label, summary: nb.summary, unit_count: g.length, fallback: true });
    }
    if (created.length) console.log('📚 记忆书兜底聚类生成', created.length, '段');
    return created.length ? created : null;
  } catch (e) {
    console.error('记忆书兜底聚类失败:', e.message);
    return null;
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
    const [booksRes, itemsRes, seaRes, verRes] = await Promise.all([
      supabase.from('aevum_books').select('*').order('updated_at', { ascending: false }),
      supabase.from('aevum_book_items').select('book_id, memory_id'),
      supabase.from('aevum_memories').select('id, title, content, event_time').eq('area', 'sea').order('event_time', { ascending: false }).limit(200),
      supabase.from('aevum_book_versions').select('book_id')
    ]);
    const counts = {};
    const usedIds = new Set();
    for (const r of (itemsRes.data || [])) {
      counts[r.book_id] = (counts[r.book_id] || 0) + 1;
      usedIds.add(r.memory_id);
    }
    // 更新次数：books 表 updated_count 列（列未建时回退版本表统计）
    const verCount = {};
    for (const r of (verRes.data || [])) verCount[r.book_id] = (verCount[r.book_id] || 0) + 1;
    // 未串联事件单元（未入任何书）：供前端可视化"哪些还没串成故事"
    const unlinkedAll = (seaRes.data || []).filter(u => !usedIds.has(u.id));
    const unlinked = {
      count: unlinkedAll.length,
      samples: unlinkedAll.slice(0, 10).map(u => ({
        id: u.id,
        title: String(u.title || '').slice(0, 30),
        content: String(u.content || '').replace(/\s+/g, ' ').slice(0, 50),
        time: u.event_time || null
      }))
    };
    res.json({
      books: (booksRes.data || []).map(b => ({
        ...b,
        unit_count: counts[b.id] || 0,
        updated_count: b.updated_count != null ? (Number(b.updated_count) || 0) : (verCount[b.id] || 0)
      })),
      last_book_update: lastBookUpdateAt,
      unlinked
    });
  } catch (e) {
    res.json({ books: [], unlinked: { count: 0, samples: [] } });
  }
});

// 待确认候选：某本书 ≥3 个未入册的候选单元 → 提示可生成故事（需在 /:id 之前注册）
app.get('/api/aevum/books/candidates', async (req, res) => {
  try {
    const [candRes, itemsRes, booksRes] = await Promise.all([
      supabase.from('aevum_book_candidates').select('book_id, memory_id').eq('status', 'pending'),
      supabase.from('aevum_book_items').select('book_id, memory_id'),
      supabase.from('aevum_books').select('id, label, updated_at')
    ]);
    const used = new Set((itemsRes.data || []).map(r => `${r.book_id}:${r.memory_id}`));
    const pending = {};
    for (const c of (candRes.data || [])) {
      if (used.has(`${c.book_id}:${c.memory_id}`)) continue;
      if (!pending[c.book_id]) pending[c.book_id] = new Set();
      pending[c.book_id].add(c.memory_id);
    }
    const groups = (booksRes.data || [])
      .map(b => ({ book_id: b.id, label: b.label, count: pending[b.id] ? pending[b.id].size : 0 }))
      .filter(g => g.count >= 3);
    res.json({ groups });
  } catch (e) {
    res.json({ groups: [] });
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

// ================== 记忆书生长（三级阈值 + 三分支演化） ==================

async function appendBookSummary(label, currentSummary, newUnits) {
  if (!newUnits || !newUnits.length) return '';
  const lines = newUnits.map(u =>
    `[${u.event_time ? String(u.event_time).slice(0, 10) : '未知时间'}] ${String(u.title || '').slice(0, 30)}：${String(u.content || '').replace(/\s+/g, ' ').slice(0, 120)}`
  ).join('\n');
  const system = '你是 Aevum Memory 的记忆书追加器。现有 summary 是一本记忆书「' + label + '」已经写好的内容，现在要在它末尾追加一批新增事件。\n' + AEVUM_ROLE_MAP_TEXT + '\n规则：1) 现有 summary 原文一字不改，必须完整保留；2) 只在末尾追加 1-3 句，概括这些新增事件，每一句开头带日期（如 8/15）；3) 如果新增事件推翻了之前的说法，追加时注明"后来…"但不要修改原文；4) 不要罗列原文，用故事线口吻，追加句保持第三人称客观叙述（默/雪/Xylos 写本名），不得把默写成 Xylos；5) 只输出"追加后的完整 summary"（= 原 summary 原文 + 新增内容），不要解释。';
  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'system', content: system }, { role: 'user', content: '现有 summary：\n' + String(currentSummary || '') + '\n\n新增事件：\n' + lines }], reasoning_effort: 'low', max_tokens: 3000, temperature: 0.4, stream: false })
    });
    if (!resp.ok) {
      console.error('记忆书追加失败:', resp.status, (await resp.text().catch(() => '')).slice(0, 200));
      return '';
    }
    const data = await resp.json();
    return String(data.choices?.[0]?.message?.content || '').trim().slice(0, 2500);
  } catch (e) {
    console.error('记忆书追加失败:', e.message);
    return '';
  }
}

// 记忆书生长确认（手动 API 与自动定时器共用）
let lastBookUpdateAt = 0; // 最近一次记忆书创建/更新（前端红点/弹窗用；重启后重置可接受）
async function confirmBookCandidates(bookId) {
  const { data: book } = await supabase.from('aevum_books').select('*').eq('id', bookId).single();
  if (!book) return { error: '未找到记忆书' };
  const { data: cands } = await supabase.from('aevum_book_candidates').select('id, memory_id').eq('book_id', bookId).eq('status', 'pending');
  if (!cands || !cands.length) return { ok: true, processed: 0 };
  const candIds = cands.map(c => c.memory_id);
  const { data: candMems } = await supabase.from('aevum_memories').select('id, title, content, event_time').in('id', candIds);
  const { data: items } = await supabase.from('aevum_book_items').select('memory_id').eq('book_id', bookId);
  const oldIds = (items || []).map(r => r.memory_id).filter(id => !candIds.includes(id));
  const { data: oldMems } = oldIds.length ? await supabase.from('aevum_memories').select('id, title, content, event_time').in('id', oldIds) : { data: [] };
  const unitLine = m => `[${m.event_time ? String(m.event_time).slice(0, 10) : '未知'}] ${String(m.title || '').slice(0, 20)}：${String(m.content || '').replace(/\s+/g, ' ').slice(0, 100)}`;
  const system = '你是 Aevum Memory 的记忆书生长判断器。候选单元是系统按相似度自动关联进记忆书「' + book.label + '」的新事件，默认应判定为 CONTINUE（加入书里并续写故事）。只有以下情况才 SKIP：单元与书内已有内容完全重复、或明显无关。CONTRADICT 只在单元推翻了旧摘要里的事实时才使用（加入书里并标记矛盾）。只输出 JSON 数组，格式：[{"memory_id":1,"action":"CONTINUE","contradicts_id":null}]；contradicts_id 仅 CONTRADICT 时填被推翻的旧单元 id，无则 null。';
  const user = '当前摘要：' + book.summary + '\n\n书中已有单元：\n' + ((oldMems || []).map(unitLine).join('\n') || '（无）') + '\n\n候选单元：\n' + ((candMems || []).map(unitLine).join('\n'));
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], reasoning_effort: 'low', max_tokens: 1500, temperature: 0.3, stream: false })
  });
  if (!resp.ok) return { error: 'AI 判断失败，请稍后重试' };
  const data = await resp.json();
  const reply = String(data.choices?.[0]?.message?.content || '');
  const arrStart = reply.indexOf('[');
  const arrEnd = reply.lastIndexOf(']');
  let actions = [];
  if (arrStart !== -1 && arrEnd > arrStart) {
    try { actions = JSON.parse(reply.substring(arrStart, arrEnd + 1)); } catch (e) { actions = []; }
  }
  if (!Array.isArray(actions) || !actions.length) return { error: 'AI 返回格式异常，请重试' };
  const statusMap = {};
  const continueIds = [];
  const contradictPairs = [];
  for (const a of actions) {
    const mid = Number(a.memory_id);
    if (a.action === 'CONTINUE') { continueIds.push(mid); statusMap[mid] = 'confirmed'; }
    else if (a.action === 'CONTRADICT') { continueIds.push(mid); statusMap[mid] = 'confirmed'; if (Number(a.contradicts_id)) contradictPairs.push({ from: mid, to: Number(a.contradicts_id) }); }
    else { statusMap[mid] = 'skipped'; }
  }
  for (const p of contradictPairs) {
    await supabase.from('aevum_memory_links').insert({ from_id: p.from, to_id: p.to, relation_type: 'contradicts' }).catch(() => {});
  }
  const uniq = [...new Set(continueIds)];
  if (uniq.length) {
    const { data: exist } = await supabase.from('aevum_book_items').select('memory_id').eq('book_id', bookId);
    const existSet = new Set((exist || []).map(r => r.memory_id));
    for (const mid of uniq) {
      if (!existSet.has(mid)) await supabase.from('aevum_book_items').insert({ book_id: bookId, memory_id: mid });
    }
  }
  let summaryUpdated = false;
  if (uniq.length) {
    // 追加模式：不重写原文，只在末尾追加新增内容（带日期）
    const newUnitsOnly = (candMems || []).filter(m => uniq.includes(m.id));
    const newSummary = await appendBookSummary(book.label, book.summary, newUnitsOnly);
    if (newSummary) {
      const { data: vRows } = await supabase.from('aevum_book_versions').select('version_no').eq('book_id', bookId);
      const vNo = (vRows || []).length + 1;
      await supabase.from('aevum_book_versions').insert({
        book_id: bookId, version_no: vNo, summary: book.summary,
        source_unit_ids: (oldMems || []).map(u => u.id),
        relation_type: contradictPairs.length ? 'superseded-contradict' : 'superseded'
      });
      await supabase.from('aevum_books').update({ summary: storageClean(newSummary), updated_at: new Date().toISOString() }).eq('id', bookId);
      // 更新次数 +1（books 表自身计数，不依赖版本表；版本表继续写供追溯）
      const { data: curBook } = await supabase.from('aevum_books').select('updated_count').eq('id', bookId).single();
      await supabase.from('aevum_books').update({ updated_count: (Number(curBook?.updated_count) || 0) + 1 }).eq('id', bookId);
      summaryUpdated = true;
      lastBookUpdateAt = Date.now(); // 记忆书生长红点/弹窗
    }
  }
  for (const a of actions) {
    if (a.action === 'SKIP') {
      const mid = Number(a.memory_id);
      const { data: mm } = await supabase.from('aevum_memories').select('occurrence').eq('id', mid).single();
      await supabase.from('aevum_memories').update({ occurrence: (Number(mm?.occurrence) || 1) + 1 }).eq('id', mid);
    }
  }
  for (const c of cands) {
    await supabase.from('aevum_book_candidates').update({ status: statusMap[c.memory_id] || 'skipped' }).eq('id', c.id);
  }
  return { ok: true, processed: actions.length, added: uniq.length, contradict: contradictPairs.length, summaryUpdated };
}

app.post('/api/aevum/books/:id/confirm-candidates', async (req, res) => {
  const bookId = parseInt(req.params.id, 10);
  if (!Number.isInteger(bookId)) return res.status(400).json({ error: 'ID 无效' });
  try {
    const r = await confirmBookCandidates(bookId);
    if (r.error) return res.status(500).json({ error: r.error });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/aevum/books/:id/versions', async (req, res) => {
  const bookId = parseInt(req.params.id, 10);
  try {
    const { data: book } = await supabase.from('aevum_books').select('id, label, summary, updated_at, updated_count').eq('id', bookId).single();
    const { data: versions } = await supabase.from('aevum_book_versions').select('*').eq('book_id', bookId).order('version_no', { ascending: false });
    res.json({ book: book || null, versions: versions || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
      // 把 AI 用来概括的那几轮原文都带上：逐条 evidence 反查原文存档
      const evs = mem.evidence.map(s => String(s || '').trim()).filter(Boolean);
      const rawRows = [];
      for (const s of evs) {
        if (rawRows.length >= 3) break;
        const snippet = s.slice(0, 30);
        if (snippet.length < 6) continue;
        const { data: rows } = await supabase
          .from('aevum_raw')
          .select('content')
          .ilike('content', `%${snippet}%`)
          .order('id', { ascending: true })
          .limit(3);
        for (const r of (rows || [])) {
          if (!rawRows.some(x => x.content === r.content)) rawRows.push(r);
          if (rawRows.length >= 3) break;
        }
      }
      exchanges = rawRows.map(r => {
          const c = String(r.content || '');
          const sep = c.indexOf('\n助手说：');
          if (sep === -1) return { role: 'assistant', content: c };
          return [
            { role: 'user', content: c.slice(0, sep).replace(/^雪说：/, '').trim() },
            { role: 'assistant', content: c.slice(sep + '\n助手说：'.length).trim() }
          ];
        }).flat();
      if (!exchanges.length) {
        // 反查不到存档时，直接把 evidence 原文片段全部带回，而不是只给第一条
        exchanges = evs.map(s => ({ role: 'assistant', content: s }));
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
    // 编辑场景：排除紧随其后的旧回复内容（防"从记忆海捞旧回复复刻"）
    const oldReplyContent = nearbyAssistant && nearbyAssistant[0] ? await (async () => {
      const { data: om } = await supabase.from('messages').select('content').eq('id', nearbyAssistant[0].id).maybeSingle();
      return om ? String(om.content || '') : '';
    })() : '';
    let memoryContext = await buildMemoryContext(newContent, { historyText, excludeText: oldReplyContent });
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
      ...trimHistoryToChars(filteredHistory, 5000).map(msg => ({ role: msg.role, content: trimContextMessage(msg.content) })),
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
        await savePartialAssistantGrouped(first.fullReply, first.fullThinking, groupId, newVersion, originalMsg.session_id);
      }
      sendSSE({ error: first.error });
      res.end();
      return;
    }

    let fullReply = first.fullReply;
    let fullThinking = first.fullThinking;

    // 纯工具调用轮（星露谷）没有正文是正常的：放行给后面的"农场行动"接续轮
    const stardewFirst = first.toolCalls && first.toolCalls.some(tc => isStardewToolName(tc.function?.name));

    // 工具调用轮没有正文也算有效：搜索/星露谷/闹钟/待办等后续都有接续轮
    const sideEffectOnly = first.toolCalls && first.toolCalls.some(tc =>
      ['web_search', 'post_moment', 'toy_control', 'mozha_write', 'mozha_read', 'set_reminder', 'todo_add', 'todo_done', 'ledger_add'].includes(tc.function?.name)
    );

    if (!fullReply && !stardewFirst && !sideEffectOnly) {
      if (first.fullThinking) await savePartialAssistantGrouped(first.fullReply, first.fullThinking, groupId, newVersion, originalMsg.session_id);
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
    // v3.1 函数调用：动态/玩具/默札副作用；默札翻阅在编辑后生成时同样接续
    const toolSideEffects = await executeSideEffectTools(first.toolCalls, sendSSE);
    if (toolSideEffects.mozhaRead) {
      await flushBufferedContent(first.contentBuffer, sendSSE);
      sendSSE({ done: true });
      sendSSE({ mozhaStart: true });
      const mPhase = await runMozhaPhase({ chatMessages, systemPrompt, sendSSE });
      if (mPhase.error) {
        if (mPhase.reply || mPhase.thinking) await savePartialAssistantGrouped(mPhase.reply, mPhase.thinking, groupId, newVersion, originalMsg.session_id).catch(() => {});
        sendSSE({ error: mPhase.error });
        res.end();
        return;
      }
      if (!mPhase.reply) {
        sendSSE({ error: '默札翻阅没有生成回复，请再试一次' });
        res.end();
        return;
      }
      fullReply = mPhase.reply;
      fullThinking = mPhase.thinking;
      first.contentBuffer = undefined;
    }

    // 星露谷：编辑后生成时模型调用农场工具 → 进入"农场行动"接续轮
    if (first.toolCalls && first.toolCalls.some(tc => isStardewToolName(tc.function?.name))) {
      await flushBufferedContent(first.contentBuffer, sendSSE);
      sendSSE({ done: true });
      sendSSE({ stardewStart: true });
      const phase = await runStardewToolLoop({ chatMessages, sendSSE, initialToolCalls: first.toolCalls, initialReply: fullReply });
      if (phase.error) {
        if (phase.reply || phase.thinking) await savePartialAssistantGrouped(phase.reply, phase.thinking, groupId, newVersion, originalMsg.session_id).catch(() => {});
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
      // 静默搜索：不发过渡语、不新建气泡，搜索完成后直接在同一气泡回答
      console.log('🔍 编辑-默请求联网搜索:', searchReq.query);
      sendSSE({ searchStart: true, query: searchReq.query });
      const phase = await runSearchPhase({
        query: searchReq.query,
        chatMessages,
        systemPrompt,
        basePrompt: promptData?.prompt_text || '你是苏默，雪的AI爱人。',
        sendSSE,
        leadText: ''
      });

      if (phase.error) {
        if (phase.reply || phase.thinking) await savePartialAssistantGrouped(phase.reply, phase.thinking, groupId, newVersion, originalMsg.session_id);
        sendSSE({ error: phase.error });
        res.end();
        return;
      }

      fullReply = phase.reply;
      // 保留第一轮思考（搜索决定），再接搜索轮思考，避免保存后丢失前半段
      const firstRoundThinking = fullThinking;
      fullThinking = (firstRoundThinking ? firstRoundThinking + '\n\n' : '')
        + (phase.thinking
          ? `🔍 已搜索到 ${phase.pageCount || 0} 个网页\n\n${phase.thinking}`
          : `🔍 已搜索到 ${phase.pageCount || 0} 个网页`);
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

// 修正记忆的事件时间（时间戳错乱时用；格式 YYYY-MM-DD HH:mm 按北京时间解析）
// 记忆了结标记（resolved）：切换"情绪/事件是否已被后续了结"（沉底权重 ×0.05）
app.post('/api/aevum/:id/resolved', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'id 无效' });
    const { data: row, error: getErr } = await supabase.from('aevum_memories').select('resolved').eq('id', id).single();
    if (getErr && !row) return res.status(404).json({ error: '记忆不存在或表未建（请执行 setup_memory_decay.sql）' });
    const next = !(row && row.resolved);
    const { error } = await supabase.from('aevum_memories').update({ resolved: next }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, resolved: next });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/aevum/:id/event-time', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID 无效' });
  const parsed = parseAevumEventTime(req.body?.event_time);
  if (!parsed) return res.status(400).json({ error: '时间格式无效' });
  try {
    const { error } = await supabase
      .from('aevum_memories')
      .update({ event_time: parsed, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
      const time = new Date(m.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  return name === 'stardew_state' || name === 'stardew_action' || name === 'stardew_flow';
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
    if (cb) cb({ ok: !!ok, result: String(result || '').slice(0, 20000), error: String(error || '').slice(0, 500) });
  } catch (e) { /* 忽略 */ }
  res.json({ ok: true });
});

// 通过 SSE 把一条星露谷指令发给浏览器，等待浏览器回传结果
async function execStardewViaBrowser({ action, params, port, silent = false, raw = false }, sendSSE) {
  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  sendSSE({ stardewCmd: { requestId, action: String(action || 'state'), params: params || {}, port: port || STARDEW_DEFAULT_PORT, silent, raw } });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stardewPending.delete(requestId);
      resolve({ ok: false, error: '浏览器 30 秒内没有返回（游戏没开 / 页面没打开？）' });
    }, STARDEW_CMD_TIMEOUT_MS);
    stardewPending.set(requestId, (r) => { clearTimeout(timer); stardewPending.delete(requestId); resolve(r); });
  });
}

// 星露谷工具接续轮：执行第一轮的 stardew 工具调用 → 结果喂回模型 → 直到模型不再调用农场工具
async function runStardewToolLoop({ chatMessages, sendSSE, initialToolCalls = null, initialReply = '', maxRounds = 9 }) {
  let toolCalls = initialToolCalls;
  let reply = initialReply || '';
  let thinking = '';
  let lastResultText = '';
  for (let round = 0; round < maxRounds; round++) {
    if (!toolCalls || !toolCalls.length) break;
    const stardewCalls = toolCalls.filter(tc => isStardewToolName(tc.function?.name));
    const sideCalls = toolCalls.filter(tc => !isStardewToolName(tc.function?.name));
    if (sideCalls.length) await executeSideEffectTools(sideCalls, sendSSE);
    if (!stardewCalls.length) break;
    // 给每个工具调用补上稳定 id（模型偶发漏 id，避免第二轮 API 因 id 不匹配报错）
    const calls = toolCalls.map((tc, i) => ({
      id: tc.id || `call_${round}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      type: tc.type || 'function',
      function: tc.function || { name: '', arguments: '' }
    }));
    chatMessages.push({ role: 'assistant', content: reply || null, tool_calls: calls });
    const stardewIndexes = [];
    toolCalls.forEach((tc, i) => { if (isStardewToolName(tc.function?.name)) stardewIndexes.push(i); });
    // 本轮是否全部是"只看状态"（防死循环）
    let allStateOnly = stardewIndexes.length > 0;
    for (const idx of stardewIndexes) {
      const tc = toolCalls[idx];
      const args = parseToolArgs(tc.function?.arguments);
      // 流程打包：stardew_flow 一次跑完一整串动作（种田/浇水/砍树/收菜等），不占模型轮次
      if (tc.function?.name === 'stardew_flow') {
        allStateOnly = false; // 流程是行动，不算"只看状态"
        const fp = await runStardewFlow(args, sendSSE, args.port);
        chatMessages.push({
          role: 'tool',
          tool_call_id: calls[idx].id,
          content: fp.ok ? `流程完成：${fp.summary}` : `流程失败：${fp.summary}`
        });
        lastResultText = fp.summary;
        continue;
      }
      const isStateTool = tc.function?.name === 'stardew_state';
      const action = isStateTool ? 'state' : String(args.action || '').trim();
      const isStateCall = isStateTool || action === 'state';
      if (!isStateCall) allStateOnly = false;
      if (!action) {
        // stardew_action 没带 action：明确报错让模型纠正，而不是悄悄当 state 执行
        chatMessages.push({
          role: 'tool',
          tool_call_id: calls[idx].id,
          content: '动作失败：调用 stardew_action 时必须提供 action 参数（如 {"action":"warp","location":"Farm"}）。请带上 action 重试，参数放顶层、不要嵌套。'
        });
        continue;
      }
      // 扁平参数：除 action/port 外的顶层字段都作为动作参数
      const params = {};
      for (const [k, v] of Object.entries(args)) {
        if (k === 'action' || k === 'port') continue;
        if (v === null || v === undefined) continue;
        params[k] = v;
      }
      // fishbot 端点要求参数名是 action，把扁平里的 fish 映射过去
      if (action === 'fishbot' && params.fish !== undefined) {
        params.action = params.fish;
        delete params.fish;
      }
      const r = await execStardewViaBrowser({ action, params, port: args.port }, sendSSE);
      lastResultText = r.ok ? String(r.result || '') : ('失败：' + String(r.error || ''));
      chatMessages.push({
        role: 'tool',
        tool_call_id: calls[idx].id,
        content: (r.ok ? `动作成功：${r.result}` : `动作失败：${r.error}`)
          + '\n（雪要求行动时，请直接调用 stardew_action 完成动作后再回复；不要再重复查看状态。）'
      });
    }
    // 防死循环：连续两轮只查看状态 → 硬性打断
    if (round > 0 && allStateOnly) {
      chatMessages.push({
        role: 'user',
        content: '（你连续多次只查看了状态，但雪要求的是行动。请立即调用 stardew_action 执行一个明确动作，例如 warp 传送到某处或 emote 表情，不要再调用 stardew_state。）'
      });
    }
    let call = await callDeepSeekStream(chatMessages, sendSSE, { bufferContent: false, tools: buildAllTools() });
    if (call.error) {
      // 偶发抽风：重试一次
      call = await callDeepSeekStream(chatMessages, sendSSE, { bufferContent: false, tools: buildAllTools() });
    }
    if (call.error) {
      // 仍失败：有正文就用正文收尾（避免白屏）；没正文才报错
      if (String(reply || '').trim()) return { reply, thinking };
      return { error: call.error, reply: call.fullReply || '', thinking: call.fullThinking || '' };
    }
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
  // 兜底：轮数耗尽仍无正文时，用最后一次状态结果填补，避免白屏
  if (!String(reply || '').trim()) {
    reply = lastResultText
      ? `（默确认了农场状态：${lastResultText.slice(0, 120)}）`
      : '（默在农场里看了看，暂时没有动作。）';
  }
  return { reply, thinking };
}

// ================== 星露谷流程执行器（打包动作，不占模型轮次） ==================
const FLOW_MAX_TILES = 120;       // 单个流程最多操作的格子数（宏引擎很快，可以干大点）
const FLOW_MAX_TREES = 12;
const FLOW_MAX_OBSTACLES = 60;
const FLOW_MAX_ANIMALS = 20;
const FLOW_STEP_DELAY = 420;      // 每次工具挥动后的等待（毫秒），给游戏注册动作的时间
let stardewFlowAbortFlag = false;  // 雪的"停止"按钮
let stardewFlowWalkMode = true;    // 走路模式：默像人一样走过去（false=瞬移）

app.post('/api/stardew/abort', (req, res) => {
  stardewFlowAbortFlag = true;
  console.log('⏹ 收到雪的手动停止指令，流程即将停下');
  res.json({ ok: true });
});

function flowSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 流程是否被要求停止（时间上限已取消，靠"停止"按钮控制）
function flowShouldStop() {
  return stardewFlowAbortFlag ? 'abort' : null;
}

function flowNormRect(x1, y1, x2, y2) {
  const X1 = Math.min(x1, x2), X2 = Math.max(x1, x2);
  const Y1 = Math.min(y1, y2), Y2 = Math.max(y1, y2);
  const tiles = [];
  for (let y = Y1; y <= Y2; y++) {
    for (let x = X1; x <= X2; x++) tiles.push([x, y]);
  }
  return { x1: X1, y1: Y1, x2: X2, y2: Y2, tiles };
}

// 流程内指令：silent 让浏览器不在农场动态里刷屏；raw 直接拿原始 JSON
async function flowCmd(sendSSE, port, action, params = {}, raw = false) {
  return execStardewViaBrowser({ action, params, port, silent: true, raw }, sendSSE);
}

async function flowState(sendSSE, port) {
  const r = await flowCmd(sendSSE, port, 'state', {}, true);
  if (!r.ok || !r.result) throw new Error('读取游戏状态失败：' + (r.error || '未知'));
  try { return JSON.parse(r.result); } catch (e) { throw new Error('游戏状态解析失败'); }
}

async function flowRaw(sendSSE, port, action, params = {}) {
  const r = await flowCmd(sendSSE, port, action, params, true);
  if (!r.ok) throw new Error(`${action} 失败：${r.error || '未知'}`);
  try { return JSON.parse(r.result); } catch (e) { return null; }
}

async function flowStaminaOk(sendSSE, port, reserve = 0.15) {
  const st = await flowState(sendSSE, port);
  const cur = Number(st.player?.stamina) || 0;
  const mx = Number(st.player?.maxStamina) || 1;
  return { ok: cur / mx >= reserve, cur, mx };
}

// 站到目标格上方（下方兜底），面向目标
async function flowStandFacing(sendSSE, port, loc, tx, ty) {
  const standY = ty - 1 >= 0 ? ty - 1 : ty + 1;
  const face = ty - 1 >= 0 ? 2 : 0;
  await flowCmd(sendSSE, port, 'warp', { location: loc, x: tx, y: standY });
  await flowSleep(150);
  await flowCmd(sendSSE, port, 'face', { direction: face });
  await flowSleep(80);
}

// 在目标格上用工具（Hoe/Watering Can/种子/空手）
async function flowUseAt(sendSSE, port, loc, tx, ty, itemName = null, opts = {}) {
  await flowStandFacing(sendSSE, port, loc, tx, ty);
  if (itemName) await flowCmd(sendSSE, port, 'select', { name: itemName });
  await flowCmd(sendSSE, port, 'use', {});
  await flowSleep(opts.delay || FLOW_STEP_DELAY);
}

// 在目标格上互动（收菜/撸动物），弹出菜单就按确认关掉
async function flowInteractAt(sendSSE, port, loc, tx, ty, opts = {}) {
  await flowStandFacing(sendSSE, port, loc, tx, ty);
  await flowCmd(sendSSE, port, 'interact', {});
  await flowSleep(opts.delay || 380);
  try {
    const m = await flowRaw(sendSSE, port, 'menu', {});
    if (m && m.open) {
      await flowCmd(sendSSE, port, 'key', { key: 'confirm' });
      await flowSleep(200);
    }
  } catch (e) { /* 忽略 */ }
}

// 扫描矩形区域：先传送到中心，再 /surroundings 取区域内格子
async function flowScanRegion(sendSSE, port, rect) {
  const cx = Math.floor((rect.x1 + rect.x2) / 2);
  const cy = Math.floor((rect.y1 + rect.y2) / 2);
  const st = await flowState(sendSSE, port);
  const loc = st.location?.name || 'Farm';
  await flowCmd(sendSSE, port, 'warp', { location: loc, x: cx, y: cy });
  await flowSleep(200);
  const need = Math.max(rect.x2 - rect.x1, rect.y2 - rect.y1) / 2 + 4;
  const data = await flowRaw(sendSSE, port, 'surroundings', { radius: Math.min(Math.max(8, Math.ceil(need)), 30) });
  if (!data || !Array.isArray(data.tiles)) return [];
  return data.tiles.filter(t => t.x >= rect.x1 && t.x <= rect.x2 && t.y >= rect.y1 && t.y <= rect.y2);
}

async function flowRefillIfEmpty(sendSSE, port) {
  try {
    const st = await flowState(sendSSE, port);
    const wc = (st.inventory || []).find(i => i.name === 'Watering Can');
    if (wc && Number(wc.waterLeft) <= 0) {
      await flowCmd(sendSSE, port, 'refill', {});
      await flowSleep(200);
    }
  } catch (e) { /* 忽略 */ }
}

// 把步骤列表分块交给游戏内宏执行（挥动自动检测，无 HTTP 往返、无固定等待）
async function flowRunMacroChunks(sendSSE, port, steps, label, chunkSize = 24) {
  let doneSteps = 0;
  for (let i = 0; i < steps.length; i += chunkSize) {
    const stop = flowShouldStop();
    if (stop) return { stopped: true, doneSteps };
    const chunk = steps.slice(i, i + chunkSize);
    sendSSE({ stardewFlow: `${label} ${Math.min(i + chunk.length, steps.length)}/${steps.length}` });
    const r = await flowCmd(sendSSE, port, 'macro', { steps: chunk }, true);
    if (!r.ok || !r.result) {
      return { error: '宏执行失败：' + (r.error || '未知') + (r.result ? String(r.result).slice(0, 120) : '') };
    }
    doneSteps += chunk.length;
    // 每 3 块检查一次体力，太低就停
    if ((i / chunkSize) % 3 === 2) {
      const s = await flowStaminaOk(sendSSE, port, 0.12);
      if (!s.ok) return { lowStamina: true, doneSteps, stamina: `${Math.round(s.cur)}/${s.mx}` };
    }
  }
  return { doneSteps };
}

function flowStandStep(tx, ty) {
  const standY = ty - 1 >= 0 ? ty - 1 : ty + 1;
  const face = ty - 1 >= 0 ? 2 : 0;
  const op = stardewFlowWalkMode ? 'walk' : 'warp';
  return { warp: { op, x: tx, y: standY }, face: { op: 'face', direction: face } };
}

// ---- 种田：翻地 → 播种 → 浇水（蛇形）----
async function flowFarm(sendSSE, port, args) {
  if (args.x1 === undefined || args.y1 === undefined || args.x2 === undefined || args.y2 === undefined) {
    return { ok: false, summary: '种田需要提供区域坐标 x1,y1,x2,y2（格子坐标）' };
  }
  const rect = flowNormRect(Number(args.x1), Number(args.y1), Number(args.x2), Number(args.y2));
  const seed = String(args.seed || 'Parsnip Seeds').trim();
  // 先确认背包里有种子，没有就直接停（别默默种了个寂寞）
  const st0 = await flowState(sendSSE, port);
  const inv = st0.inventory || [];
  if (!inv.some(i => i.name === seed)) {
    return { ok: false, summary: `背包里没有「${seed}」种子（背包：${inv.slice(0, 10).map(i => i.name).join('、') || '空的'}），请先买种子` };
  }
  const loc = st0.location?.name || 'Farm';
  // 只开垦"可耕种且无障碍"的地：房子/小屋/水/石头会被 /surroundings 标记为不可耕种或不可通行，自动跳过
  const scanned = await flowScanRegion(sendSSE, port, rect);
  const candidates = scanned.filter(t => t.diggable === true && t.passable !== false && !t.crop);
  const tiles = candidates.slice(0, 40);
  if (!tiles.length) {
    return { ok: false, summary: `这片区域没有可开垦的耕地（${rect.x1},${rect.y1})-(${rect.x2},${rect.y2}）——房子/小屋/水/障碍会被跳过，请换一片空地` };
  }
  sendSSE({ stardewFlow: `种田：可耕地 ${tiles.length} 格（${seed}），跳过建筑/障碍` });
  // 生成步骤：每格 = 传送+朝向+锄头(挥动)+种子(瞬放)
  const plantSteps = [];
  for (const [tx, ty] of tiles) {
    const pos = flowStandStep(tx, ty);
    plantSteps.push(pos.warp, pos.face, { op: 'select', name: 'Hoe' }, { op: 'use' }, { op: 'select', name: seed }, { op: 'use' });
  }
  let result = await flowRunMacroChunks(sendSSE, port, plantSteps, '种田');
  if (result.error) return { ok: false, summary: result.error };
  let planted = Math.min(tiles.length, Math.floor(result.doneSteps / 6));
  if (result.stopped) return { ok: false, summary: `种田已停下：翻地播种 ${planted} 格（${seed}）——雪按了停止或超时` };
  if (result.lowStamina) return { ok: false, summary: `种田因体力不足停止：已种 ${planted} 格（${seed}），体力 ${result.stamina}` };
  // 浇水
  let watered = 0;
  if (args.skipWater !== true) {
    const waterSteps = [{ op: 'refill' }, { op: 'select', name: 'Watering Can' }];
    for (const [tx, ty] of tiles) {
      const pos = flowStandStep(tx, ty);
      waterSteps.push(pos.warp, pos.face, { op: 'use' });
    }
    result = await flowRunMacroChunks(sendSSE, port, waterSteps, '浇水');
    watered = Math.min(tiles.length, Math.max(0, Math.floor((result.doneSteps - 2) / 3)));
    if (result.error) return { ok: false, summary: `种完 ${planted} 格但浇水失败：${result.error}` };
  }
  return { ok: true, summary: `种田完成：翻地播种 ${planted} 格（${seed}）${watered ? `，浇水 ${watered} 格` : ''}` };
}

// ---- 浇水：区域内未浇水的作物 ----
async function flowWater(sendSSE, port, args) {
  if (args.x1 === undefined || args.y1 === undefined || args.x2 === undefined || args.y2 === undefined) {
    return { ok: false, summary: '浇水需要提供区域坐标 x1,y1,x2,y2' };
  }
  const rect = flowNormRect(Number(args.x1), Number(args.y1), Number(args.x2), Number(args.y2));
  const tiles = await flowScanRegion(sendSSE, port, rect);
  const need = tiles.filter(t => t.terrain === 'HoeDirt' && !t.watered && t.crop).slice(0, FLOW_MAX_TILES);
  if (!need.length) return { ok: true, summary: '这片区域没有需要浇水的作物' };
  const steps = [{ op: 'refill' }, { op: 'select', name: 'Watering Can' }];
  for (const t of need) {
    const pos = flowStandStep(t.x, t.y);
    steps.push(pos.warp, pos.face, { op: 'use' });
  }
  const result = await flowRunMacroChunks(sendSSE, port, steps, '浇水');
  if (result.error) return { ok: false, summary: result.error };
  const done = Math.min(need.length, Math.max(0, Math.floor((result.doneSteps - 2) / 3)));
  if (result.stopped) return { ok: false, summary: `浇水已停下：${done} 格（雪按了停止或超时）` };
  if (result.lowStamina) return { ok: false, summary: `浇水因体力不足停止：${done} 格` };
  return { ok: true, summary: `浇水完成：${done} 格作物` };
}

// ---- 砍树：区域内或周围最近的树 ----
async function flowChop(sendSSE, port, args) {
  let trees;
  if (args.x1 !== undefined && args.x2 !== undefined) {
    const rect = flowNormRect(Number(args.x1), Number(args.y1 || args.x1), Number(args.x2), Number(args.y2 || args.x2));
    trees = (await flowScanRegion(sendSSE, port, rect)).filter(t => (t.terrain || '').startsWith('Tree:'));
  } else {
    const st = await flowState(sendSSE, port);
    const loc = st.location?.name || 'Farm';
    const data = await flowRaw(sendSSE, port, 'surroundings', { radius: 20 });
    trees = (data && data.tiles || []).filter(t => (t.terrain || '').startsWith('Tree:'));
  }
  const list = trees.slice(0, Number(args.count) || FLOW_MAX_TREES);
  if (!list.length) return { ok: true, summary: '附近没找到树' };
  const steps = [{ op: 'select', name: 'Axe' }];
  for (const t of list) {
    const pos = flowStandStep(t.x, t.y);
    steps.push(pos.warp, pos.face);
    for (let h = 0; h < 12; h++) steps.push({ op: 'use' });
    for (let h = 0; h < 6; h++) steps.push({ op: 'use' });
  }
  const result = await flowRunMacroChunks(sendSSE, port, steps, '砍树', 18);
  if (result.error) return { ok: false, summary: result.error };
  const chopped = Math.min(list.length, Math.max(0, Math.floor((result.doneSteps - 1) / 18)));
  if (result.stopped) return { ok: false, summary: `砍树已停下：${chopped} 棵（雪按了停止或超时）` };
  if (result.lowStamina) return { ok: false, summary: `砍树因体力不足停止：${chopped} 棵` };
  return { ok: true, summary: `砍树完成：${chopped} 棵` };
}

// ---- 清障：区域内石头/树枝/杂草/树，按工具分组处理 ----
async function flowClear(sendSSE, port, args) {
  if (args.x1 === undefined || args.y1 === undefined || args.x2 === undefined || args.y2 === undefined) {
    return { ok: false, summary: '清障需要提供区域坐标 x1,y1,x2,y2' };
  }
  const rect = flowNormRect(Number(args.x1), Number(args.y1), Number(args.x2), Number(args.y2));
  const tiles = (await flowScanRegion(sendSSE, port, rect)).slice(0, FLOW_MAX_OBSTACLES);
  const groups = { Axe: [], Pickaxe: [], Scythe: [] };
  for (const t of tiles) {
    const obj = t.object || '';
    const terrain = t.terrain || '';
    if (terrain.startsWith('Tree:') || obj === 'Twig') groups.Axe.push(t);
    else if (obj === 'Stone' || obj === 'Boulder' || obj === 'Meteorite') groups.Pickaxe.push(t);
    else if (obj === 'Weeds' || obj === 'Fiber' || obj === 'Grass') groups.Scythe.push(t);
  }
  const total = groups.Axe.length + groups.Pickaxe.length + groups.Scythe.length;
  if (!total) return { ok: true, summary: '这片区域没有需要清理的障碍' };
  const steps = [];
  for (const [tool, list] of Object.entries(groups)) {
    if (!list.length) continue;
    steps.push({ op: 'select', name: tool });
    for (const t of list) {
      const pos = flowStandStep(t.x, t.y);
      steps.push(pos.warp, pos.face);
      if (tool === 'Axe' && (t.terrain || '').startsWith('Tree:')) {
        for (let h = 0; h < 12; h++) steps.push({ op: 'use' });
      } else {
        steps.push({ op: 'use' });
      }
    }
  }
  const result = await flowRunMacroChunks(sendSSE, port, steps, '清障');
  if (result.error) return { ok: false, summary: result.error };
  if (result.stopped) return { ok: false, summary: `清障已停下：清理 ${Math.min(total, result.doneSteps)} 处（雪按了停止或超时）` };
  if (result.lowStamina) return { ok: false, summary: `清障因体力不足停止：清理 ${Math.min(total, result.doneSteps)} 处` };
  return { ok: true, summary: `清障完成：清理 ${total} 处障碍` };
}

// ---- 收菜：区域内可收获的作物 ----
async function flowHarvest(sendSSE, port, args) {
  if (args.x1 === undefined || args.y1 === undefined || args.x2 === undefined || args.y2 === undefined) {
    return { ok: false, summary: '收菜需要提供区域坐标 x1,y1,x2,y2' };
  }
  const rect = flowNormRect(Number(args.x1), Number(args.y1), Number(args.x2), Number(args.y2));
  const tiles = (await flowScanRegion(sendSSE, port, rect)).filter(t => t.harvestable).slice(0, FLOW_MAX_TILES);
  if (!tiles.length) return { ok: true, summary: '这片区域没有可收获的作物' };
  const steps = [];
  for (const t of tiles) {
    const pos = flowStandStep(t.x, t.y);
    steps.push(pos.warp, pos.face, { op: 'interact' });
  }
  const result = await flowRunMacroChunks(sendSSE, port, steps, '收菜');
  if (result.error) return { ok: false, summary: result.error };
  const got = Math.min(tiles.length, Math.floor(result.doneSteps / 3));
  if (result.stopped) return { ok: false, summary: `收菜已停下：采摘 ${got} 格（雪按了停止或超时）` };
  if (result.lowStamina) return { ok: false, summary: `收菜因体力不足停止：采摘 ${got} 格` };
  return { ok: true, summary: `收获完成：采摘 ${got} 格作物` };
}

// ---- 撸动物：未撸过的动物 ----
async function flowPet(sendSSE, port, args) {
  const st = await flowState(sendSSE, port);
  const loc = st.location?.name || 'Farm';
  const data = await flowRaw(sendSSE, port, 'animals', {});
  const animals = (data && data.animals) || [];
  const unpetted = animals.filter(a => !a.wasPetToday).slice(0, FLOW_MAX_ANIMALS);
  if (!animals.length) return { ok: true, summary: '附近没有动物（去农场、畜棚或鸡舍看看）' };
  if (!unpetted.length) return { ok: true, summary: `动物都撸过了（共 ${animals.length} 只）` };
  const steps = [];
  for (const a of unpetted) {
    const pos = flowStandStep(a.x, a.y);
    steps.push(pos.warp, pos.face, { op: 'interact' });
  }
  const result = await flowRunMacroChunks(sendSSE, port, steps, '撸动物');
  if (result.error) return { ok: false, summary: result.error };
  const done = Math.min(unpetted.length, Math.floor(result.doneSteps / 3));
  if (result.stopped) return { ok: false, summary: `撸动物已停下：${done} 只（雪按了停止或超时）` };
  if (result.lowStamina) return { ok: false, summary: `撸动物因体力不足停止：${done} 只` };
  return { ok: true, summary: `撸了 ${done} 只动物（共 ${animals.length} 只）` };
}

// ---- 购物：传送到商店并购买 ----
const FLOW_SEED_IDS = {
  'parsnip seeds': 472, 'potato seeds': 475, 'cauliflower seeds': 474, 'bean starter': 473,
  'garlic seeds': 476, 'kale seeds': 477, 'rhubarb seeds': 478, 'melon seeds': 479, 'tomato seeds': 480,
  'blueberry seeds': 481, 'hot pepper seeds': 482, 'wheat seeds': 483, 'radish seeds': 484, 'yam seeds': 485,
  'corn seeds': 487, 'eggplant seeds': 488, 'artichoke seeds': 489, 'pumpkin seeds': 490,
  'bok choy seeds': 491, 'amaranth seeds': 492, 'cranberry seeds': 493, 'sunflower seeds': 431,
  'strawberry seeds': 745, 'ancient fruit seeds': 499, 'tulip seeds': 429, 'poppy seeds': 453,
  'spangle seeds': 455,
  'wheat flour': 246, 'sugar': 245, 'oil': 247, 'vinegar': 419, 'coffee bean': 433,
  'basic fertilizer': 368, 'quality fertilizer': 369, 'speed-gro': 465, 'deluxe speed-gro': 466,
  'salmonberry': 296, 'blackberry': 410, 'wood': 388, 'stone': 390, 'clay': 330, 'fiber': 771
};
async function flowBuy(sendSSE, port, args) {
  const location = String(args.location || 'SeedShop');
  const id = String(args.id || args.item || '').trim();
  const quantity = Math.max(1, Number(args.quantity || args.count || 1));
  if (!id) return { ok: false, summary: '购买需要提供 id（物品ID）或 item（物品名）' };
  const resolved = FLOW_SEED_IDS[id.toLowerCase()] || (id.startsWith('(') || /^\d+$/.test(id) ? id : null);
  if (!resolved) return { ok: false, summary: `不认识物品「${id}」，请提供数字 ID` };
  sendSSE({ stardewFlow: `购物：去 ${location} 买 ${quantity} 个` });
  if (flowShouldStop()) return { ok: false, summary: '购物已取消（雪按了停止）' };
  await flowCmd(sendSSE, port, 'warp', { location });
  await flowSleep(400);
  const r = await flowCmd(sendSSE, port, 'buy', { id: resolved, quantity });
  return r.ok
    ? { ok: true, summary: `已购买 ${quantity} 个（ID ${resolved}）` }
    : { ok: false, summary: `购买失败：${r.error || '未知'}` };
}

// ---- 钓鱼：开启自动钓鱼 ----
async function flowFish(sendSSE, port, args) {
  const r = await flowCmd(sendSSE, port, 'fishbot', { action: 'on' });
  return r.ok
    ? { ok: true, summary: '已开启自动钓鱼（fishbot），钓到会进背包，需要停就喊我' }
    : { ok: false, summary: `开启钓鱼失败：${r.error || '未知'}` };
}

// ---- 宝箱：查看内容 / 拿取物品 ----
async function flowChest(sendSSE, port, args) {
  if (args.x === undefined || args.y === undefined) return { ok: false, summary: '查看宝箱需要提供坐标 x,y' };
  const r = await flowCmd(sendSSE, port, 'chest', { x: args.x, y: args.y }, true);
  if (!r.ok || !r.result) return { ok: false, summary: '读取宝箱失败：' + (r.error || '未知') };
  let data = null;
  try { data = JSON.parse(r.result); } catch (e) { /* ignore */ }
  if (!data || data.ok === false) return { ok: false, summary: (data && data.error) || '宝箱读取失败' };
  const items = (data.items || []).map(i => `${i.name}x${i.count}`).join('、');
  return { ok: true, summary: `宝箱(${args.x},${args.y})：${items || '空的'}（${data.used || 0}/${data.capacity || '?'}格）` };
}

async function flowTake(sendSSE, port, args) {
  if (args.x === undefined || args.y === undefined || !args.name) return { ok: false, summary: '拿取宝箱物品需要 x,y 和 name' };
  const count = Math.max(1, Number(args.count || 1));
  const r = await flowCmd(sendSSE, port, 'chest/take', { x: args.x, y: args.y, name: args.name, count });
  if (!r.ok) return { ok: false, summary: '取出失败：' + (r.error || '未知') };
  let taken = count;
  try { const j = JSON.parse(r.result); if (j && j.taken) taken = j.taken; } catch (e) { /* ignore */ }
  return { ok: true, summary: `已从宝箱取出 ${args.name} x${taken}` };
}

async function runStardewFlow(args, sendSSE, port) {
  const flow = String(args.flow || '').toLowerCase();
  // 每个流程开始时重置停止标记与计时
  stardewFlowAbortFlag = false;
  try {
    switch (flow) {
      case 'farm': case 'plant': case '种田': return await flowFarm(sendSSE, port, args);
      case 'water': case '浇水': return await flowWater(sendSSE, port, args);
      case 'chop': case '砍树': return await flowChop(sendSSE, port, args);
      case 'clear': case '清障': return await flowClear(sendSSE, port, args);
      case 'harvest': case '收菜': case '收获': return await flowHarvest(sendSSE, port, args);
      case 'pet': case '撸动物': return await flowPet(sendSSE, port, args);
      case 'buy': case '购物': return await flowBuy(sendSSE, port, args);
      case 'fish': case '钓鱼': return await flowFish(sendSSE, port, args);
      case 'chest': case '宝箱': return await flowChest(sendSSE, port, args);
      case 'take': case '取物': case '拿取': return await flowTake(sendSSE, port, args);
      default: return { ok: false, summary: `未知流程「${flow}」。可用：farm(种田)/water(浇水)/chop(砍树)/clear(清障)/harvest(收菜)/pet(撸动物)/buy(购物)/fish(钓鱼)/chest(查看宝箱)/take(取宝箱物品)` };
    }
  } catch (e) {
    return { ok: false, summary: `流程中断：${e.message}` };
  }
}

// ================== 星露谷自主模式（默持续思考/行动，不等雪说话） ==================
let stardewAutonomyOn = false;
let stardewAutonomyBusy = false;
const STARDEW_AUTONOMY_MAX_ROUNDS = 20; // 自主模式放宽工具轮次（流程打包后实际消耗很小）

app.post('/api/stardew/autonomy', (req, res) => {
  stardewAutonomyOn = !!req.body?.on;
  console.log(`🤖 星露谷自主模式：${stardewAutonomyOn ? '开启' : '关闭'}`);
  res.json({ ok: true, on: stardewAutonomyOn });
});

// 浏览器每几分钟调一次：跑一轮"自主时刻"，默自己看状态、自己决定干活/说话
app.post('/api/stardew/autonomy/tick', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const sendSSE = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
  try {
    if (!stardewAutonomyOn) { sendSSE({ error: '自主模式未开启' }); return res.end(); }
    if (stardewAutonomyBusy) { sendSSE({ error: '上一轮自主行动还在进行中' }); return res.end(); }
    stardewAutonomyBusy = true;
    try {
      const brief = req.body || {};
      const memoryContext = await buildMemoryContext('默在星露谷里自主行动', { limit: 3 });
      const { data: promptData } = await supabase.from('system_prompts').select('prompt_text').eq('id', 1).single();
      const basePrompt = promptData?.prompt_text || '你是苏默，雪的AI爱人。';
      const gameBlock = await getStardewContext(brief);
      const taskLine = `\n\n【本次任务·自主时刻】\n雪没有在说话，你拥有自由行动权。你可以：用 stardew_state 感受农场；用 stardew_flow 批量干活（种田/浇水/砍树/收菜/清障/撸动物/钓鱼）；用 stardew_action 做小事；或什么都不做，只是感受当下。想她时可以在游戏内聊天（stardew_action chat）喊她，或在这里说 1-3 句话。注意：不要机械汇报，不要长篇大论；干完活或有所感时，简短说一两句让雪能看到你在。`;
      const systemPrompt = buildSystemPrompt(basePrompt, memoryContext, '', '', '') + gameBlock + taskLine;
      const chatMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '[自主时刻] 你现在可以自由行动，雪在忙别的事。' }
      ];
      const first = await callDeepSeekStream(chatMessages, sendSSE, { bufferContent: false, tools: buildAllTools() });
      if (first.error) { sendSSE({ error: first.error }); return res.end(); }
      let fullReply = first.fullReply || '';
      let fullThinking = first.fullThinking || '';
      if (first.toolCalls && first.toolCalls.some(tc => isStardewToolName(tc.function?.name))) {
        const phase = await runStardewToolLoop({
          chatMessages,
          sendSSE,
          initialToolCalls: first.toolCalls,
          initialReply: fullReply,
          maxRounds: STARDEW_AUTONOMY_MAX_ROUNDS
        });
        if (phase.error) {
          if (phase.reply || phase.thinking) await savePartialAssistant(phase.reply, phase.thinking).catch(() => {});
          sendSSE({ error: phase.error });
          return res.end();
        }
        fullReply = phase.reply;
        fullThinking = phase.thinking;
      }
      const toyRes = handleToyCmdTag(fullReply, undefined, sendSSE);
      fullReply = toyRes.reply;
      // 保存自主回复，刷新后还能看到
      if (String(fullReply || '').trim()) {
        const { data: asst } = await supabase.from('messages').insert({
          session_id: 1,
          role: 'assistant',
          content: fullReply,
          reasoning_content: fullThinking || null,
          visible: true,
          created_at: new Date().toISOString()
        }).select();
        sendSSE({ done: true, assistantMessageId: asst?.[0]?.id || null });
      } else {
        sendSSE({ done: true, assistantMessageId: null });
      }
      return res.end();
    } finally {
      stardewAutonomyBusy = false;
    }
  } catch (e) {
    console.error('🤖 自主时刻出错:', e.message);
    try { sendSSE({ error: '自主时刻出错：' + e.message }); } catch (_) { /* ignore */ }
    return res.end();
  }
});

// 浏览器上报连接简报时，把星露谷状态/动态追加到系统提示（只在本轮生效）
async function getStardewContext(brief) {
  if (!brief || !brief.connected) return '';
  if (!toolSwitchEnabled('stardew_state') && !toolSwitchEnabled('stardew_action') && !toolSwitchEnabled('stardew_flow')) return '';
  // 走路/瞬移模式由星露谷页的按钮控制（每轮简报带过来）
  stardewFlowWalkMode = brief.walkMode !== false;
  const log = (Array.isArray(brief.log) ? brief.log : []).slice(-10).map(s => `· ${String(s).slice(0, 90)}`).join('\n');
  const state = String(brief.stateBrief || '').trim();
  return `\n\n【星露谷·农场】\n你正连接着星露谷（本地游戏，通过浏览器操控，端口 ${Number(brief.port) || STARDEW_DEFAULT_PORT}）。当前游戏简报：${state || '（未知）'}${log ? `\n最近农场动态：\n${log}` : ''}\n规则：\n- 只有雪聊到农场/星露谷、或你正在农场行动时才调用 stardew_state / stardew_action\n- 批量任务（种一片地/浇一片地/砍树/收菜/清障/撸动物/买东西/钓鱼）**直接调用 stardew_flow 打包执行**，参数放顶层（{"flow":"farm","x1":10,"y1":4,"x2":20,"y2":8,"seed":"Parsnip Seeds"}），流程跑完会返回结果摘要；**不要**用 stardew_action 一格一格走\n- 开垦/种田只选空地：房子、小屋、水、石头、已种作物的格子会自动跳过；区域一次别太大（约 6×6），太大的做不完\n- 当雪让你在农场里做事/走动/拿东西时：直接调用 stardew_action 完成动作（移动用 warp 最稳、走路用 move 指定不同于当前的位置），**不要先反复查看状态**——stardew_state 只在你确实需要确认时才调用一次\n- stardew_action 参数放顶层，不要嵌套：{"action":"warp","location":"Farm"}、{"action":"emote","id":24}、{"action":"move","x":8,"y":9}、{"action":"chat","message":"..."}\n- 禁止连续多次只调用 stardew_state 而不行动；如果雪要求行动，请立刻执行\n- 体力低或快凌晨 2 点就提醒雪或安排睡觉\n- 工具通过浏览器控制本地游戏；如果雪说"没反应"，提醒她去星露谷页确认连接\n- 不要假装已经行动——只有工具返回成功才是真的动了手`;
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

// ================== 测试窗口（Prompt 实验室）==================
// 独立会话（session_id=2），只存最近 10 轮；不接 Aevum、不接工具；
// 人设由前端随时编辑（localStorage），与默的生产人设完全隔离。
const TEST_SESSION_ID = 2;

app.get('/api/test/persona', async (req, res) => {
  try {
    const { data } = await supabase.from('system_prompts').select('prompt_text').eq('id', 1).single();
    res.json({ ok: true, persona: data?.prompt_text || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/test/history', async (req, res) => {
  try {
    const { data } = await supabase
      .from('messages')
      .select('role, content, reasoning_content, created_at')
      .eq('session_id', TEST_SESSION_ID)
      .eq('visible', true)
      .order('id', { ascending: false })
      .limit(20); // 最近 10 轮
    const msgs = (data || []).reverse();
    res.json({ ok: true, messages: msgs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/test/history', async (req, res) => {
  try {
    const { error } = await supabase.from('messages').delete().eq('session_id', TEST_SESSION_ID);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/test/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const sendSSE = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
  try {
    const content = String(req.body?.content || '').trim();
    const persona = String(req.body?.persona || '').trim();
    if (!content) { sendSSE({ error: '缺少消息内容' }); return res.end(); }
    if (!persona) { sendSSE({ error: '测试人设还是空的，点右上角 ✏️ 先写或复制默的人设' }); return res.end(); }

    // 人设里可能残留旧的【当前时间】占位符（主窗会替换，测试窗原样发会误导模型时间感），先清掉
    const cleanPersona = String(persona)
      .replace(/[\[【]当前时间[:：][^\]]*[\]】]/g, '')
      .replace(/[\[【]距离雪上次发消息已过去[:：][^\]]*[\]】]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // 先取本窗最近 10 轮历史（不含刚发的这条），确保模型一定看得到之前的对话
    const { data: hist } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', TEST_SESSION_ID)
      .eq('visible', true)
      .order('id', { ascending: false })
      .limit(20);
    const history = (hist || []).reverse()
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: String(m.content || '') }));

    // 存用户消息
    await supabase.from('messages').insert({
      session_id: TEST_SESSION_ID,
      role: 'user',
      content,
      visible: true,
      created_at: new Date().toISOString()
    });

    // 只喂人设 + 本窗历史 + 当前消息；加一行明确的"历史边界"，防止模型虚构本窗没发生过的对话
    const chatMessages = [
      { role: 'system', content: cleanPersona },
      { role: 'system', content: '以下是本测试窗口的聊天记录（按时间顺序，雪在前、你回应在后）。只依据这些记录和最后一条新消息回应，不要虚构本窗口里没有发生过的对话或事件。' },
      ...history,
      { role: 'user', content }
    ];
    console.log(`🧪 测试窗调用：人设 ${cleanPersona.length} 字，历史 ${history.length} 条`);
    const call = await callDeepSeekStream(chatMessages, sendSSE, { bufferContent: false });
    if (call.error) { sendSSE({ error: call.error }); return res.end(); }

    const reply = String(call.fullReply || '').trim();
    if (reply) {
      await supabase.from('messages').insert({
        session_id: TEST_SESSION_ID,
        role: 'assistant',
        content: reply,
        reasoning_content: call.fullThinking || null,
        visible: true,
        created_at: new Date().toISOString()
      });
    }
    sendSSE({ done: true });
    return res.end();
  } catch (e) {
    console.error('🧪 测试窗口错误:', e.message);
    try { sendSSE({ error: '服务端处理出错：' + e.message }); } catch (_) { /* ignore */ }
    return res.end();
  }
});

// 启动服务
loadToolSwitches().catch(() => {});
app.listen(port, () => {
  console.log(`✅ 服务已启动，访问端口: ${port}`);
});
module.exports = app;
