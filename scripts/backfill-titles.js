// 批量补标题：提取时 AI 常给空字符串标题，且 v30 迁移只补 NULL 不补 ''。
// 把空标题统一补为内容前 20 字（幂等，只处理 title IS NULL 或空串的）。
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

(async () => {
  // 拉取空标题的记忆（分页）
  let offset = 0, fixed = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('aevum_memories')
      .select('id, content, title')
      .or('title.is.null,title.eq.')
      .range(offset, offset + 199);
    if (error) { console.error('查询失败:', error.message); break; }
    if (!data || !data.length) break;
    const updates = data.map(m => ({
      id: m.id,
      title: String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 20)
    })).filter(u => u.title);
    for (const u of updates) {
      const { error: ue } = await supabase.from('aevum_memories').update({ title: u.title }).eq('id', u.id);
      if (!ue) fixed++;
    }
    console.log('本批', data.length, '条，已补', updates.length);
    offset += 200;
    if (data.length < 200) break;
  }
  console.log('完成，共补标题', fixed, '条');
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
