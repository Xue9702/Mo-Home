// 补齐 model_config 的 thinking_level/creativity 行
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);
(async () => {
  const now = new Date().toISOString();
  for (const [key, value] of [['thinking_level', 'high'], ['creativity', '1']]) {
    const { error } = await supabase
      .from('model_config')
      .upsert({ key, value, updated_at: now }, { onConflict: 'key' });
    console.log(`插入 ${key}=${value}:`, error ? ('ERR ' + error.message) : 'OK ✅');
  }
  const { data: rows } = await supabase.from('model_config').select('*');
  console.log('当前配置:');
  for (const r of rows || []) console.log(`  ${r.key} = ${r.value}`);
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
