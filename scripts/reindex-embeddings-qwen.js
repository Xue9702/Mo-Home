// 全量重算记忆向量：旧 text-embedding-v3 → qwen3.7-text-embedding（同为 1024 维）
// 用法：node scripts/reindex-embeddings-qwen.js [batchSize=100] [limit=全部]
// 断点续跑：已重算的（embedding 匹配新模型）会跳过——通过记录重算时间戳字段不可靠，
// 改为每批打印进度；重复跑会全量重算（幂等但浪费），建议一次跑完。
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

const MODEL = 'qwen3.7-text-embedding';
const DIM = 1024;

async function embed(text) {
  const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DASHSCOPE_API_KEY}` },
    body: JSON.stringify({ model: MODEL, input: String(text || '').slice(0, 800), dimensions: DIM, encoding_format: 'float' }),
    signal: AbortSignal.timeout(20000)
  });
  if (!resp.ok) {
    const t = await resp.text();
    if (resp.status === 429 || /quota|exhausted|Free tier/i.test(t)) {
      console.error('⛔ 额度问题，停止:', t.slice(0, 150));
      process.exit(2);
    }
    console.error('嵌入失败 HTTP', resp.status, t.slice(0, 120));
    return null;
  }
  const data = await resp.json();
  const emb = data?.data?.[0]?.embedding;
  return Array.isArray(emb) && emb.length === DIM ? emb : null;
}

(async () => {
  // 分批取 active 记忆（只重算有内容没向量的 + 全部重建——简单起见全量）
  let offset = 0;
  const BATCH = 50;
  let done = 0, fail = 0, skip = 0;
  while (true) {
    const { data: rows, error } = await supabase
      .from('aevum_memories')
      .select('id, content, title')
      .eq('status', 'active')
      .range(offset, offset + BATCH - 1);
    if (error) { console.error('查询失败:', error.message); break; }
    if (!rows || !rows.length) break;
    offset += rows.length;
    for (const r of rows) {
      const text = String(r.content || r.title || '').trim();
      if (text.length < 2) { skip++; continue; }
      const emb = await embed(text);
      if (!emb) { fail++; continue; }
      const up = await supabase.from('aevum_memories').update({ embedding: emb }).eq('id', r.id);
      if (up.error) { fail++; console.error('写入失败 id=' + r.id, up.error.message); }
      else done++;
    }
    console.log(`进度: 已处理 ${offset} 条 | 成功 ${done} 失败 ${fail} 跳过 ${skip}`);
    // 避免打爆限流
    await new Promise(res => setTimeout(res, 150));
  }
  console.log(`\n✅ 重算完成: 成功 ${done} 失败 ${fail} 跳过 ${skip}`);
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
