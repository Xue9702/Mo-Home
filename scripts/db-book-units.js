// 查看某本记忆书包含的事件单元（时间/标题）
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);
const id = Number(process.argv[2] || 52);

(async () => {
  const { data: items } = await supabase.from('aevum_book_items').select('memory_id').eq('book_id', id);
  const ids = (items || []).map(r => r.memory_id);
  console.log('书 #' + id + ' 共', ids.length, '个单元');
  if (ids.length) {
    const { data: mems } = await supabase.from('aevum_memories').select('id, title, event_time, created_at').in('id', ids).order('event_time', { ascending: true });
    for (const m of (mems || [])) {
      console.log('  event_time=' + String(m.event_time || '?').slice(0, 16), 'created=' + String(m.created_at || '').slice(0, 16), '[' + (m.title || '（无标题）') + ']');
    }
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
