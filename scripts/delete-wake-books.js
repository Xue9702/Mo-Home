// 删除纯唤醒流水账记忆书：16/92/98（连带 book_items、book_versions、book_candidates）
// 记忆单元本身保留在记忆海（已由 buildBookClusters 排除 wake，不会再重新成书）
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

const BOOK_IDS = [16, 92, 98];

(async () => {
  for (const id of BOOK_IDS) {
    const { data: book } = await supabase.from('aevum_books').select('id, label').eq('id', id).single();
    if (!book) { console.log(`book ${id}: 不存在`); continue; }
    // 先取关联 memory（仅统计，不删除记忆）
    const { data: items } = await supabase.from('aevum_book_items').select('memory_id').eq('book_id', id);
    // 删除关联、版本、候选、书本体
    await supabase.from('aevum_book_items').delete().eq('book_id', id);
    await supabase.from('aevum_book_versions').delete().eq('book_id', id);
    await supabase.from('aevum_book_candidates').delete().eq('book_id', id);
    const { error } = await supabase.from('aevum_books').delete().eq('id', id);
    console.log(`删除 book ${id}「${book.label}」:`, error ? ('ERR ' + error.message) : ('OK（释放 ' + (items || []).length + ' 条记忆回记忆海）'));
  }
  // 验证
  const { data: left } = await supabase.from('aevum_books').select('id, label').in('id', BOOK_IDS);
  console.log('\n残留:', (left || []).length ? JSON.stringify(left) : '无 ✅');
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
