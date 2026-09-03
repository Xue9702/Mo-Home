// 修正 mem 1047 title 回 Xylos（上一轮 fix-book93 误写成"小屋管家"）
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
  const r = await supabase.from('aevum_memories').update({ title: '{USER}请Xylos配置感受注入词，{AGENT}逐条接收认可' }).eq('id', 1047).select().single();
  console.log(r.error ? ('ERR ' + r.error.message) : ('OK title=' + r.data.title));
})().catch(e => { console.error(e.message); process.exit(1); });
