// 测试 recall_memory 工具的两种模式（搜索 + 追溯）——复现 executeRecallMemory 逻辑
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);
const USER_TZ = 'Asia/Shanghai';
const formatMemoryTime = (iso) => {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('zh-CN', { timeZone: USER_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) { return ''; }
};
const perspectiveConvert = (t) => String(t || '')
  .replace(/\{AGENT\}/g, '我').replace(/\{USER\}/g, '夫人')
  .replace(/默札/g, '\u0000M\u0000').replace(/苏默/g, '\u0000S\u0000')
  .replace(/默/g, '我').replace(/雪/g, '夫人')
  .replace(/\u0000M\u0000/g, '默札').replace(/\u0000S\u0000/g, '苏默');

async function getEmbedding(text) {
  const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DASHSCOPE_API_KEY}` },
    body: JSON.stringify({ model: 'qwen3.7-text-embedding', input: String(text || '').slice(0, 1000), dimensions: 1024, encoding_format: 'float' }),
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.data?.[0]?.embedding || null;
}

async function recallSearch(query) {
  const q = String(query || '').trim();
  const embedding = await getEmbedding(q);
  let ids = [];
  if (embedding && embedding.length) {
    const { data: scored } = await supabase.rpc('match_aevum_memories_scored', { query_embedding: embedding, match_count: 8 });
    if (Array.isArray(scored) && scored.length) ids = scored.slice(0, 8).map(s => s.id);
  }
  if (!ids.length) {
    const kw = q.replace(/[，。！？,.!?~\s]+/g, '').slice(0, 6);
    const { data } = await supabase.from('aevum_memories').select('id').eq('status', 'active').ilike('content', `%${kw}%`).limit(8);
    ids = (data || []).map(r => r.id);
  }
  const { data: mems } = ids.length ? await supabase.from('aevum_memories').select('*').in('id', ids) : { data: [] };
  if (!mems || !mems.length) return { text: '', found: false };
  const lines = mems.map(m => {
    const when = formatMemoryTime(m.event_time || m.created_at);
    const label = perspectiveConvert(String(m.title || '').trim());
    return `- [${label ? label + '｜' : ''}事件${when ? ' ' + when : ''}] ${perspectiveConvert(String(m.content || '').replace(/\s+/g, ' ').slice(0, 120))}`;
  });
  return { text: '\n' + lines.join('\n'), found: true };
}

async function recallTrace(id) {
  const { data } = await supabase.from('aevum_memories').select('*').eq('id', Number(id)).eq('status', 'active').maybeSingle();
  if (!data) return { text: '', found: false };
  const when = formatMemoryTime(data.event_time || data.created_at);
  let out = `【记忆详情 #${data.id}${when ? ' · ' + when : ''}】\n${perspectiveConvert(data.content)}`;
  const evs = (Array.isArray(data.evidence) ? data.evidence : []).filter(Boolean).slice(0, 2);
  if (evs.length) out += `\n\n（当时对话原文片段：${evs.map(s => String(s).slice(0, 200)).join('\n')}）`;
  return { text: out, found: true };
}

(async () => {
  console.log('=== 模式1：关键词搜索"电饭煲" ===');
  const s1 = await recallSearch('电饭煲');
  console.log(s1.found ? s1.text.slice(0, 400) : '(无结果)');
  console.log('\n=== 模式2：追溯单条(先搜到id) ===');
  // 取一个真实 id
  const { data: anyM } = await supabase.from('aevum_memories').select('id').eq('status', 'active').limit(1).maybeSingle();
  if (anyM) {
    const s2 = await recallTrace(anyM.id);
    console.log(s2.found ? s2.text.slice(0, 300) : '(无结果)');
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
