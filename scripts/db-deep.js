// 深度诊断：旧记忆书的续写痕迹
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

(async () => {
  console.log('=== 旧记忆书（8/25 前创建）summary 检查 ===');
  const { data: books } = await supabase
    .from('aevum_books').select('id, label, summary, created_at, updated_at')
    .lt('created_at', '2026-08-25').order('id', { ascending: true });
  for (const b of (books || [])) {
    const s = String(b.summary || '');
    const tail = s.slice(-50).replace(/\n/g, ' ');
    console.log('#' + b.id, '[' + (b.label || '') + '] len=' + s.length,
      'created=' + String(b.created_at || '').slice(0, 10), 'updated=' + String(b.updated_at || '').slice(0, 10));
    console.log('   尾:', tail);
  }

  console.log('\n=== 候选的 created_at 时间分布（确认是何时写入的） ===');
  const { data: cands } = await supabase
    .from('aevum_book_candidates').select('book_id, status, created_at')
    .order('created_at', { ascending: false }).limit(20);
  for (const c of (cands || [])) {
    console.log('book', c.book_id, c.status, String(c.created_at || '').slice(0, 16));
  }

  console.log('\n=== 最新生成的记忆书（8/28 自动串联）单元数 vs 摘要长度 ===');
  const { data: newBooks } = await supabase
    .from('aevum_books').select('id, label, summary, created_at')
    .gte('created_at', '2026-08-28').order('id', { ascending: true });
  for (const b of (newBooks || [])) {
    console.log('#' + b.id, '[' + (b.label || '') + '] summary_len=' + String(b.summary || '').length);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
