// 诊断：找含 "Xylos" / "X" 的记忆书和记忆单元，看证据原文
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
  console.log('=== 含 Xylos 的记忆书 ===');
  const { data: books } = await supabase.from('aevum_books').select('*').ilike('summary', '%Xylos%');
  for (const b of books || []) {
    console.log(`book id=${b.id} label=${b.label}`);
    console.log(`  summary: ${String(b.summary || '').slice(0, 400)}`);
    const { data: items } = await supabase.from('aevum_book_items').select('memory_id').eq('book_id', b.id);
    const mids = (items || []).map(i => i.memory_id);
    const { data: mems } = await supabase.from('aevum_memories').select('*').in('id', mids);
    for (const mem of mems || []) {
      console.log(`  ├ mem id=${mem.id} owner=${mem.owner} task=${mem.task_status} title=${mem.title}`);
      console.log(`  │  content: ${String(mem.content || '').slice(0, 200)}`);
      if (mem.evidence && mem.evidence.length) {
        console.log(`  │  evidence[0]: ${String(mem.evidence[0] || '').slice(0, 250)}`);
      }
    }
  }
  console.log('\n=== 含 Xylos 的记忆单元 ===');
  const { data: mems2 } = await supabase.from('aevum_memories').select('*').ilike('content', '%Xylos%').limit(5);
  for (const mem of mems2 || []) {
    console.log(`mem id=${mem.id} owner=${mem.owner} title=${mem.title}`);
    console.log(`  content: ${String(mem.content || '').slice(0, 300)}`);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
