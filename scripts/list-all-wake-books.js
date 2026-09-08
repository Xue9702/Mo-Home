// 完整列出所有"唤醒/小屋为主"的记忆书（含混合书），让雪决定哪些留哪些清
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
  const { data: books } = await supabase.from('aevum_books').select('id, label, summary');
  const hits = [];
  for (const b of books || []) {
    const s = String(b.summary || '');
    const wakeCount = (s.match(/第\d+次唤醒|唤醒/g) || []).length;
    const houseCount = (s.match(/小屋|默札/g) || []).length;
    if (wakeCount >= 2 || (houseCount >= 3 && /唤醒|小屋/.test(s))) {
      // 判断是否含"真实提炼"（有结论性词或具体事件进展）
      const hasValue = /承诺|约定|表示|体现|表明|感谢|道歉|认错|决定|学会|达成|焦虑|心疼|感动|纪念|感动|确认|建立/.test(s)
        || /(画稿|订单|收入|账|票|病|医院|发烧|考试|录取|搬家|生日|纪念日)/.test(s);
      hits.push({ id: b.id, label: b.label, w: wakeCount, h: houseCount, val: hasValue, len: s.length, s: s.slice(0, 60) });
    }
  }
  hits.sort((a, b) => a.val - b.val || b.len - a.len);
  console.log('含唤醒/小屋主题的书（按价值排序，val=false 优先考虑清理）:', hits.length, '本\n');
  for (const c of hits) {
    console.log(`[${c.val ? '保留' : '可清'}] id=${c.id} ${c.label} (唤${c.w}屋${c.h} ${c.len}字) | ${c.s}`);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
