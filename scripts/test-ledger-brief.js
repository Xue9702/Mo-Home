// 验证 getLedgerBrief 新逻辑：当天有记录 / 无记录两种输出
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
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const month = `${y}-${m}`;
  const today = `${y}-${m}-${d}`;
  const nm = nextMonthStr(month);
  const { data: cur } = await supabase.from('ledger_entries').select('*').gte('entry_date', `${month}-01`).lt('entry_date', `${nm}-01`);
  let income = 0, expense = 0;
  const byCat = {};
  const todayList = [];
  for (const e of (cur || [])) {
    const amt = Number(e.amount) || 0;
    if (e.type === 'income') income += amt;
    else { expense += amt; const c = e.category || '其他'; byCat[c] = (byCat[c] || 0) + amt; }
    if (e.entry_date === today) todayList.push(e);
  }
  const lines = [`本月收入 ${income} 元，已支出 ${expense} 元`];
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length) lines.push('支出大头：' + top.map(([c, v]) => `${c} ${v} 元`).join('、'));

  console.log('今天:', today, '| 当天记录数:', todayList.length);
  if (todayList.length) {
    const ordered = [...todayList].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    lines.push('明细：' + ordered.map(e => `${e.type === 'income' ? '入' : '支'} ${e.amount} 元（${e.category}${e.note ? '：' + e.note : ''}）`).join('；'));
  } else {
    const { data: recent } = await supabase.from('ledger_entries').select('*').order('entry_date', { ascending: false }).order('created_at', { ascending: false }).limit(3);
    const dl = (recent || []).map(e => `${e.entry_date} ${e.type === 'income' ? '入' : '支'} ${e.amount} 元（${e.category}${e.note ? '：' + e.note : ''}）`);
    if (dl.length) lines.push('明细：（今天还没记账，最近几笔：）' + dl.join('；'));
  }
  console.log('\n=== 输出 ===\n【账本】\n' + lines.join('\n'));
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
