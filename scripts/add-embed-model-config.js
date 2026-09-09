// 补齐 model_config 表的 embed_model 行（旧版 SQL 只插了 main/task）
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
  const { data, error } = await supabase
    .from('model_config')
    .upsert({ key: 'embed_model', value: 'qwen3.7-text-embedding', updated_at: new Date().toISOString() }, { onConflict: 'key' });
  console.log('插入 embed_model:', error ? ('ERR ' + error.message) : 'OK ✅');
  const { data: rows } = await supabase.from('model_config').select('*');
  console.log('当前配置:');
  for (const r of rows || []) console.log(`  ${r.key} = ${r.value}`);
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
