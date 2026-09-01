// 诊断：ledger_entries 表结构 + ledger_budget 是否存在 + 最近几条账本
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
  // 1) 表结构（取一行看有哪些列）
  const { data: one, error: e1 } = await supabase.from('ledger_entries').select('*').limit(1);
  console.log('ledger_entries 查询:', e1 ? ('ERR: ' + e1.message) : ('OK, 行数=' + (one || []).length));
  if (!e1) {
    const cols = one && one[0] ? Object.keys(one[0]) : [];
    console.log('现有列:', cols.join(', '));
    console.log('含 category?', cols.includes('category'));
  }
  // 2) 直接插入测试（category 列）——先回滚，只测试能否插入
  const test = await supabase.from('ledger_entries').insert({
    entry_date: '2000-01-01', type: 'expense', amount: 0.01, note: '__diag_test__', category: '其他'
  }).select();
  if (test.error) {
    console.log('插入带 category 失败:', test.error.message);
  } else {
    console.log('插入带 category 成功（测试行 id=' + (test.data && test.data[0] && test.data[0].id) + '）');
    // 清理测试行
    if (test.data && test.data[0] && test.data[0].id) {
      const del = await supabase.from('ledger_entries').delete().eq('id', test.data[0].id);
      console.log('清理测试行:', del.error ? ('ERR: ' + del.error.message) : 'OK');
    }
  }
  // 3) ledger_budget 表
  const { data: bud, error: e3 } = await supabase.from('ledger_budget').select('*').limit(1);
  console.log('ledger_budget:', e3 ? ('ERR: ' + e3.message) : ('OK 行数=' + (bud || []).length));
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
