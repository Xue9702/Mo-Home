// 全量重算记忆 embedding（模型切换后向量空间变化，旧向量必须重算）
// 用法：node scripts/reindex-embeddings.js
// 用 .env 的 DASHSCOPE_API_KEY（text-embedding-v3）逐条重算 aevum_memories.embedding 写回
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);
const KEY = process.env.DASHSCOPE_API_KEY;
if (!KEY) { console.error('缺少 DASHSCOPE_API_KEY'); process.exit(1); }

async function embed(text) {
  const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({
      model: process.env.AEVUM_EMBED_MODEL || 'text-embedding-v3',
      input: String(text || '').slice(0, 1000),
      dimensions: 1024,
      encoding_format: 'float'
    }),
    signal: AbortSignal.timeout(20000)
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
  const data = await resp.json();
  const emb = data?.data?.[0]?.embedding;
  return Array.isArray(emb) && emb.length ? emb : null;
}

(async () => {
  let offset = 0, done = 0, failed = 0, empty = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('aevum_memories')
      .select('id, content')
      .range(offset, offset + 99);
    if (error) { console.error('查询失败:', error.message); break; }
    if (!data || !data.length) break;
    for (const m of data) {
      const content = String(m.content || '');
      if (!content.trim()) { empty++; continue; }
      try {
        const emb = await embed(content);
        if (!emb) { failed++; continue; }
        const { error: ue } = await supabase.from('aevum_memories').update({ embedding: emb }).eq('id', m.id);
        if (ue) { failed++; } else { done++; }
      } catch (e) {
        failed++;
        if (failed % 20 === 0) console.error('近期失败原因示例:', e.message);
      }
    }
    offset += 100;
    console.log(`进度: 已处理 ${offset} 条，成功 ${done}，失败 ${failed}，空内容 ${empty}`);
    await new Promise(r => setTimeout(r, 200)); // 温和限速
    if (data.length < 100) break;
  }
  console.log(`完成: 共 ${done} 成功 / ${failed} 失败 / ${empty} 空`);
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
