// 扫描 active 记忆单元里 content/title 含裸 Xylos 或 X 引用的（历史记忆，召回时会穿帮）
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
    .from('aevum_memories')
    .select('id, title, content')
    .or('content.ilike.%Xylos%,content.ilike.%让X%,title.ilike.%Xylos%,content.ilike.%和Xylos%')
    .limit(40);
  console.log('命中', (data || []).length, '条', error ? ('ERR ' + error.message) : '');
  for (const m of data || []) {
    console.log('id=' + m.id, '|', String(m.title || '').slice(0, 40), '|', String(m.content || '').replace(/\s+/g, ' ').slice(0, 100));
  }
})().catch(e => { console.error(e.message); process.exit(1); });
