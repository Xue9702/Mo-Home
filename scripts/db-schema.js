// 查看真实表结构：取各表一条样本行 + 关键列
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

const tables = ['aevum_memories', 'aevum_raw', 'aevum_episodes', 'aevum_books', 'aevum_book_items',
  'aevum_book_candidates', 'aevum_book_versions', 'aevum_memory_links', 'aevum_mo_view',
  'aevum_plans', 'aevum_mozha', 'aevum_topics'];

(async () => {
  for (const t of tables) {
    const { data, error } = await supabase.from(t).select('*').limit(1);
    if (error) { console.log(t, '=> 查询失败:', error.message); continue; }
    if (!data || !data.length) { console.log(t, '=> 空表（列未知）'); continue; }
    const row = data[0];
    const cols = Object.keys(row);
    console.log('\n==', t, '== 列:', cols.join(', '));
    // 显示几个关键字段的类型样例
    for (const c of cols) {
      const v = row[c];
      const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      const sample = v === null ? '' : (typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 40));
      console.log('   ', c, ':', type, sample);
    }
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
