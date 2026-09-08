// 统计唤醒相关记忆：source/内容特征在记忆海和记忆书里的占比
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
  // 1) 全部 active 记忆按天统计 + 找出唤醒特征内容
  const { data, error } = await supabase.from('aevum_memories').select('id, title, content, created_at, event_time').eq('status', 'active');
  console.log('active 记忆总数:', (data || []).length, error ? error.message : '');
  // 唤醒特征：内容含"第N次唤醒"或"唤醒时"等
  const wakeLike = (data || []).filter(m => /第\s*\d+\s*次唤醒|唤醒|醒来后|第\d+次/.test(String(m.title || '') + String(m.content || '')));
  console.log('疑似唤醒类记忆:', wakeLike.length);
  // 抽样展示最近几条
  const sorted = [...(data || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  console.log('\n最近 15 条记忆（看有哪些是唤醒类）:');
  for (const m of sorted.slice(0, 15)) {
    const isWake = /第\s*\d+\s*次唤醒|唤醒|醒来后|第\d+次/.test(String(m.title || '') + String(m.content || ''));
    console.log(`  [${isWake ? '唤醒' : '    '}] id=${m.id} ${String(m.created_at || '').slice(0, 16)} | ${String(m.title || m.content || '').slice(0, 50)}`);
  }
  // 2) 记忆书里含唤醒内容的
  const { data: books } = await supabase.from('aevum_books').select('id, label, summary');
  const wakeBooks = (books || []).filter(b => /唤醒|小屋|第\d+次/.test(String(b.summary || '') + String(b.label || '')));
  console.log('\n记忆书总数:', (books || []).length, '| 含唤醒/小屋主题的:', wakeBooks.length);
  for (const b of wakeBooks) console.log(`  book id=${b.id} label=${b.label} | ${String(b.summary || '').slice(0, 80)}`);
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
