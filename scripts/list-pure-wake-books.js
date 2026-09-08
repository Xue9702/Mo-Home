// 精确列出纯唤醒流水账书（summary 只是行动流水，无提炼/无真实关系进展）
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

// 纯流水特征：summary 主体是"第N次唤醒/去小屋/翻默札/发消息/整理"且
// 没有提炼（无 体现/表明/展现/承诺/约定/表示 这类结论词），且不是真实主题
const PURE_WAKE = /^(默|在)[^。]{0,20}(第\d+次唤醒|唤醒)/; // 开头就是唤醒流水
const CONCLUSION = /体现|表明|展现|承诺|约定|表示|显示|记下|形成|说明|强调/; // 有提炼结论则保留
const REAL_TOPIC = /情绪系统|账本|记忆系统|电饭煲|火车票|截稿|画稿|金库|炸鸡|小屋命名|面壁|雷暴|结膜|番茄牛肉|感冒|发烧|吃药|医院|皮肤|购物|买|做菜|煮|炒/;

(async () => {
  const { data: books } = await supabase.from('aevum_books').select('id, label, summary');
  const cands = [];
  for (const b of books || []) {
    const s = String(b.summary || '');
    if (REAL_TOPIC.test(s)) continue;
    if (CONCLUSION.test(s)) continue;
    const wakeCount = (s.match(/第\d+次唤醒|唤醒/g) || []).length;
    const actionCount = (s.match(/小屋|默札|书柜|床铺|发消息|字条|图鉴/g) || []).length;
    // 唤醒/行动词占比高 = 流水账
    if (wakeCount >= 2 && actionCount >= 2 && wakeCount + actionCount >= 6) {
      cands.push({ id: b.id, label: b.label, w: wakeCount, a: actionCount, len: s.length, s: s.slice(0, 80) });
    }
  }
  console.log('纯唤醒流水账书:', cands.length, '本');
  for (const c of cands) console.log(`  id=${c.id} ${c.label} (唤${c.w} 动${c.a} ${c.len}字) | ${c.s}`);
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
