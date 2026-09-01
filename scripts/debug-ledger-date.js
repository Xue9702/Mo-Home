// 验证：lte 用 2026-09-31（非法日期）vs 2026-09-30（合法）
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
  const q1 = await supabase.from('ledger_entries').select('*').gte('entry_date', '2026-09-01').lte('entry_date', '2026-09-31');
  console.log('lte 2026-09-31 (非法):', q1.error ? ('ERR: ' + q1.error.message) : ('行数=' + (q1.data || []).length));
  const q2 = await supabase.from('ledger_entries').select('*').gte('entry_date', '2026-09-01').lte('entry_date', '2026-09-30');
  console.log('lte 2026-09-30 (合法):', q2.error ? ('ERR: ' + q2.error.message) : ('行数=' + (q2.data || []).length));
  const q3 = await supabase.from('ledger_entries').select('*').gte('entry_date', '2026-09-01').lt('entry_date', '2026-10-01');
  console.log('lt 2026-10-01 (下月1日):', q3.error ? ('ERR: ' + q3.error.message) : ('行数=' + (q3.data || []).length));
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
