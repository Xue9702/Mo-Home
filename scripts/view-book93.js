// 查看 book 93 关联单元完整内容（含 title/evidence/owner），为数据修复做准备
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
  // 1) book 93
  const { data: book } = await supabase.from('aevum_books').select('*').eq('id', 93).single();
  console.log('=== book 93 ===');
  console.log('label:', book && book.label);
  console.log('summary:', book && book.summary);
  // 2) 关联单元
  const { data: items } = await supabase.from('aevum_book_items').select('memory_id').eq('book_id', 93);
  const mids = (items || []).map(i => i.memory_id);
  console.log('\n关联单元 ids:', mids.join(','));
  const { data: mems } = await supabase.from('aevum_memories').select('*').in('id', mids);
  for (const mem of mems || []) {
    console.log(`\nmem id=${mem.id} owner=${mem.owner} type=${mem.type} task=${mem.task_status} imp=${mem.importance}`);
    console.log('title:', mem.title);
    console.log('content:', mem.content);
    if (mem.evidence && mem.evidence.length) {
      mem.evidence.forEach((e, i) => console.log(`evidence[${i}]: ${String(e).slice(0, 300)}`));
    }
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
