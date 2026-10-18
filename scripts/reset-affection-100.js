// 把好感值从 10000 改回 100（雪 10/18 要求：从 100 慢慢涨到上限 10000）
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

(async () => {
  const { data: before } = await supabase.from('home_state').select('affection').eq('id', 1).maybeSingle();
  console.log('改前 affection =', before && before.affection);
  if (!before) { console.log('没有 home_state id=1 行'); return; }
  if (Number(before.affection) === 100) { console.log('已经是 100，不用改'); return; }
  const { error } = await supabase.from('home_state')
    .update({ affection: 100, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) { console.log('ERR', error.message); return; }
  const { data: after } = await supabase.from('home_state').select('affection').eq('id', 1).maybeSingle();
  console.log('改后 affection =', after && after.affection);
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
