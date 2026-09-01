// 诊断：直接查 Supabase 里 ledger_entries 表，确认 9 月数据是否真的写进去了
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
  // 全部数据（按日期倒序）
  const { data, error } = await supabase
    .from('ledger_entries')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) { console.log('查询失败:', error.message); process.exit(1); }
  console.log('最近 20 条账本记录:');
  for (const e of data || []) {
    console.log(`  id=${e.id} ${e.entry_date} ${e.type} ${e.amount} "${e.note}" cat=${e.category} created=${e.created_at}`);
  }
  // 9 月统计
  const { data: sep } = await supabase
    .from('ledger_entries')
    .select('*')
    .gte('entry_date', '2026-09-01')
    .lte('entry_date', '2026-09-30');
  let inc = 0, exp = 0;
  for (const e of sep || []) { if (e.type === 'income') inc += Number(e.amount) || 0; else exp += Number(e.amount) || 0; }
  console.log(`\n9 月统计: 收入=${inc} 支出=${exp} 条数=${(sep || []).length}`);
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
