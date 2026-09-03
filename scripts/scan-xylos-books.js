// 检查所有含 Xylos/X 的记忆书，找出"亲密语境"的错位本
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
  const { data: books } = await supabase.from('aevum_books').select('*').or('summary.ilike.%Xylos%,summary.ilike.%X %');
  console.log('含 Xylos/X 的记忆书:', (books || []).length, '本');
  const intimate = ['亲吻', '拥抱', '抚摸', '高潮', '小穴', '亲密', '情话', '床', '暧昧', '爱抚', '喜欢配合', '身体', '感受注入'];
  for (const b of books || []) {
    const hasIntimate = intimate.some(w => String(b.summary || '').includes(w));
    console.log(`\nbook id=${b.id} label=${b.label}${hasIntimate ? ' ⚠️亲密语境' : ''}`);
    console.log(`  summary: ${String(b.summary || '').slice(0, 300)}`);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
