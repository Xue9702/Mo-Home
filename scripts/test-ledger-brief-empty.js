// 验证"当天无记录"分支：用 2026-09-07（若那天无记录则走最近3条）
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);
const nextMonthStr = (month) => { const [y, m] = String(month).split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

(async () => {
  const today = '2026-09-07'; // 固定测试日（假设无记录）
  const month = '2026-09';
  const nm = nextMonthStr(month);
  const { data: cur } = await supabase.from('ledger_entries').select('*').gte('entry_date', `${month}-01`).lt('entry_date', `${nm}-01`);
  const todayList = (cur || []).filter(e => e.entry_date === today);
  console.log('测试日:', today, '| 当天记录数:', todayList.length);
  const { data: recent } = await supabase.from('ledger_entries').select('*').order('entry_date', { ascending: false }).order('created_at', { ascending: false }).limit(3);
  console.log('最近 3 条（应有日期+备注）:');
  for (const e of recent || []) {
    console.log(`  ${e.entry_date} ${e.type === 'income' ? '入' : '支'} ${e.amount} 元（${e.category}${e.note ? '：' + e.note : ''}）`);
  }
  console.log('\n✅ 若上面 3 条带日期与备注 → 无记录分支逻辑正确');
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
