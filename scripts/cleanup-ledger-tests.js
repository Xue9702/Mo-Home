// 清理测试数据：id=5(测试炒饭), id=6(??), id=7(test), id=9(重复331保留1条)
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
  // 先展示将要删的
  const ids = [5, 6, 7, 9];
  const { data } = await supabase.from('ledger_entries').select('*').in('id', ids);
  console.log('待清理:');
  for (const e of data || []) console.log(`  id=${e.id} ${e.entry_date} ${e.type} ${e.amount} "${e.note}"`);
  for (const id of ids) {
    const { error } = await supabase.from('ledger_entries').delete().eq('id', id);
    console.log(`删除 id=${id}:`, error ? ('ERR ' + error.message) : 'OK');
  }
  // 验证
  const { data: left } = await supabase.from('ledger_entries').select('*').order('id');
  console.log('\n剩余记录:');
  for (const e of left || []) console.log(`  id=${e.id} ${e.entry_date} ${e.type} ${e.amount} "${e.note}" cat=${e.category}`);
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
