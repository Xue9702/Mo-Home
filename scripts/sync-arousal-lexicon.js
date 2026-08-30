// 同步私人词表到 Supabase（服务器从库读取，5 分钟缓存）
// 用法：node scripts/sync-arousal-lexicon.js [词表路径(默认 arousal-lexicon.json)]
// 本地词表不入 git；改完词表后跑一次本脚本，线上即可生效
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

const lexiconPath = process.argv[2] || 'E:/Mo-Home/arousal-lexicon.json';
(async () => {
  const data = JSON.parse(fs.readFileSync(lexiconPath, 'utf8'));
  const counts = {
    touch: (data.touch || []).length,
    body_parts: Object.keys(data.body_parts || {}).length,
    poses: (data.poses || []).length,
    moans: (data.moans || []).length,
    desires: (data.desires || []).length
  };
  const { error } = await supabase.from('arousal_lexicon').upsert(
    { id: 1, data, updated_at: new Date().toISOString() },
    { onConflict: 'id' }
  );
  if (error) { console.error('同步失败:', error.message); process.exit(1); }
  console.log('✅ 词表已同步到 Supabase：', JSON.stringify(counts));
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
