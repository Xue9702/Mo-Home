// 对比：同一条记忆（含旧 v3 向量）用新模型嵌入后的相似度分布
// 如果新模型嵌入 vs 旧向量 相似度系统性偏低 → 需要全量重算向量
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

async function embed(text, model) {
  const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DASHSCOPE_API_KEY}` },
    body: JSON.stringify({ model, input: String(text || '').slice(0, 1000), dimensions: 1024, encoding_format: 'float' }),
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.data?.[0]?.embedding || null;
}
const cos = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

(async () => {
  // 取 5 条有旧向量的记忆（id 在召回里出现过的）
  const ids = [703, 449, 560, 454, 531];
  const { data: rows } = await supabase.from('aevum_memories').select('id, content, embedding').in('id', ids);
  // 取一条做查询
  const q = '电饭煲 煮饭';
  const newQ = await embed(q, 'qwen3.7-text-embedding');
  console.log('新模型查询向量维度:', newQ ? newQ.length : '失败');
  for (const r of rows || []) {
    const oldEmb = r.embedding;
    const isOld = oldEmb && Array.isArray(oldEmb) && oldEmb.length > 10;
    // 同一条内容用新模型再嵌一次，对比"新vs新"应高，"旧库向量 vs 新查询"应低（如果模型空间不同）
    const newContent = await embed(String(r.content || '').slice(0, 200), 'qwen3.7-text-embedding');
    const crossOld = isOld && newQ ? cos(newQ, oldEmb) : null;      // 新查询 vs 旧库向量
    const sameNew = newContent && newQ ? cos(newQ, newContent) : null; // 新查询 vs 新嵌入同内容
    console.log(`id=${r.id} 旧库向量vs新查询=${crossOld !== null ? crossOld.toFixed(3) : '无向量'} | 新嵌入同内容vs新查询=${sameNew !== null ? sameNew.toFixed(3) : '-'}`);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
