// 用 qwen3.7-text-embedding 测向量召回全链路：嵌入 → RPC match → 返回
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

async function getEmbedding(text) {
  const key = process.env.DASHSCOPE_API_KEY;
  const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: 'qwen3.7-text-embedding', input: String(text || '').slice(0, 1000), dimensions: 1024, encoding_format: 'float' }),
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) { console.log('嵌入 HTTP', resp.status, String(await resp.text()).slice(0, 150)); return null; }
  const data = await resp.json();
  const emb = data?.data?.[0]?.embedding;
  return Array.isArray(emb) && emb.length ? emb : null;
}

(async () => {
  const q = '电饭煲煮饭';
  const emb = await getEmbedding(q);
  console.log('嵌入维度:', emb ? emb.length : '失败');
  if (!emb) return;
  const { data: scored, error } = await supabase.rpc('match_aevum_memories_scored', {
    query_embedding: emb, match_count: 5
  });
  console.log('RPC:', error ? ('ERR ' + error.message) : ('OK 返回 ' + (scored || []).length + ' 条'));
  for (const s of (scored || []).slice(0, 5)) {
    console.log(`  id=${s.id} sim=${Number(s.similarity).toFixed(3)}`);
  }
  if ((scored || []).length) {
    const { data: rows } = await supabase.from('aevum_memories').select('id, title, content').in('id', scored.map(s => s.id));
    for (const r of rows || []) console.log(`  → ${r.id}: ${String(r.content || '').slice(0, 60)}`);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
