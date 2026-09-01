// 模拟 executeSideEffectTools 的 ledger_add 分支，验证写入
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

const LEDGER_CATEGORIES = ['住房', '餐饮', '饮品', '零食', '日用', '服饰', '订阅', '交通', '娱乐', '关系', '健康', '学习', '其他'];
const LEDGER_INCOME_CATEGORY = '画稿';
function validLedgerCategory(cat, type) {
  if (type === 'income') return LEDGER_INCOME_CATEGORY;
  return LEDGER_CATEGORIES.includes(String(cat || '')) ? String(cat) : '其他';
}

(async () => {
  // 模拟默调用：支出 奶茶 15
  const args = { type: 'expense', amount: 15, category: '饮品', note: '奶茶' };
  const type = args.type === 'income' ? 'income' : 'expense';
  const amt = Math.round(Number(args.amount) * 100) / 100;
  console.log('参数解析: type=' + type, 'amt=' + amt, 'valid=' + (amt > 0));
  const category = validLedgerCategory(args.category, type);
  console.log('category 解析: ' + category);
  const { error } = await supabase.from('ledger_entries').insert({
    entry_date: new Date().toISOString().slice(0, 10), type, amount: amt, note: String(args.note || '').trim(), category
  });
  console.log('写入:', error ? ('ERR: ' + error.message) : 'OK ✅');
  if (error) process.exit(1);
  // 验证读回
  const { data } = await supabase.from('ledger_entries').select('*').eq('note', '奶茶').limit(1);
  console.log('读回验证:', data && data.length ? ('id=' + data[0].id + ' ' + data[0].type + ' ' + data[0].amount + ' ' + data[0].category) : '未找到');
  // 清理测试数据
  if (data && data.length) {
    const del = await supabase.from('ledger_entries').delete().eq('id', data[0].id);
    console.log('清理测试行:', del.error ? ('ERR: ' + del.error.message) : 'OK');
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
