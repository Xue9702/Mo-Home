// 列出候选删除的唤醒记忆书（label 或 summary 以唤醒/小屋探索为主）
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

// 唤醒书特征：summary 以唤醒行动流水为主（多次唤醒/小屋/默札+无实质关系进展）
const WAKE_LABEL = /唤醒|小屋|默札/;
const WAKE_PATTERN = /第\d+次唤醒|多次唤醒|走进小屋|翻开默札|整理书柜|整理床铺/;
// 排除这些真实主题（虽含小屋词但内容是真实的对话/情感/系统）
const KEEP = /情绪系统|账本|记忆系统|炸鸡|金库|电饭煲|番茄|火车|截稿|面壁|关系承诺|命名|改版|雷暴|熬夜作息/;

(async () => {
  const { data: books, error } = await supabase.from('aevum_books').select('id, label, summary');
  if (error) { console.log('查询失败:', error.message); return; }
  const candidates = [];
  for (const b of books || []) {
    const s = String(b.summary || '');
    const l = String(b.label || '');
    if (KEEP.test(s)) continue; // 有真实内容的跳过
    const wakeScore = (s.match(/第\d+次唤醒/g) || []).length
      + (s.match(/唤醒/g) || []).length * 0.5
      + (WAKE_PATTERN.test(s) ? 2 : 0);
    // 高唤醒特征 & 短于一定长度（流水账一般短）或纯小屋流水
    const isWakeBook = wakeScore >= 3 && (WAKE_PATTERN.test(s) || WAKE_LABEL.test(l));
    if (isWakeBook) candidates.push({ id: b.id, label: l, score: Math.round(wakeScore * 10) / 10, len: s.length, s: s.slice(0, 70) });
  }
  console.log('候选唤醒书:', candidates.length, '本');
  for (const c of candidates) console.log(`  id=${c.id} [${c.score}] ${c.label} (${c.len}字) | ${c.s}`);
  // 统计这些书关联的 memory 数量
  if (candidates.length) {
    const { count } = await supabase
      .from('aevum_book_items')
      .select('memory_id', { count: 'exact', head: true })
      .in('book_id', candidates.map(c => c.id));
    console.log('\n关联记忆条目数:', count);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
