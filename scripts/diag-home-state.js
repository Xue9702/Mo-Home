// 查 home_state 的好感/心情当前值
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
  const { data, error } = await supabase.from('home_state').select('*').eq('id', 1).maybeSingle();
  if (error) { console.log('ERR', error.message); return; }
  if (!data) { console.log('home_state 无 id=1 行'); return; }
  console.log('=== home_state 当前值 ===');
  for (const k of Object.keys(data)) {
    const v = data[k];
    console.log(' ', k, '=', typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : v);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
