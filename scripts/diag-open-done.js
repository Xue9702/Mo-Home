// 诊断：电饭煲/Bruno/买米/煮饭相关记忆的 task_status 与内容
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
  console.log('=== 电饭煲/Bruno/米/煮饭 相关记忆 ===');
  const { data } = await supabase.from('aevum_memories')
    .select('*')
    .or('content.ilike.%电饭煲%,content.ilike.%Bruno%,content.ilike.%bruno%,content.ilike.%煮饭%,content.ilike.%买米%,title.ilike.%电饭煲%,title.ilike.%煮饭%')
    .order('created_at', { ascending: false })
    .limit(30);
  for (const mem of data || []) {
    console.log(`\nmem id=${mem.id} owner=${mem.owner} task=${mem.task_status} type=${mem.type} status=${mem.status} imp=${mem.importance}`);
    console.log(`  title: ${mem.title}`);
    console.log(`  content: ${String(mem.content || '').slice(0, 300)}`);
    console.log(`  event_time: ${mem.event_time} created: ${mem.created_at}`);
    if (mem.evidence && mem.evidence.length) console.log(`  evidence[0]: ${String(mem.evidence[0] || '').slice(0, 200)}`);
    if (mem.fulfilled_by && mem.fulfilled_by.length) console.log(`  fulfilled_by: ${mem.fulfilled_by.join(',')}`);
    if (mem.fulfills && mem.fulfills.length) console.log(`  fulfills: ${mem.fulfills.join(',')}`);
  }
  console.log('\n=== 所有 open 任务（未完成承诺） ===');
  const { data: open } = await supabase.from('aevum_memories')
    .select('id, title, content, event_time, owner, created_at')
    .eq('task_status', 'open')
    .order('created_at', { ascending: false })
    .limit(30);
  for (const mem of open || []) {
    console.log(`open id=${mem.id} owner=${mem.owner} time=${mem.event_time}`);
    console.log(`  title: ${mem.title}`);
    console.log(`  content: ${String(mem.content || '').slice(0, 200)}`);
  }
  console.log('\n=== 最近 done 的任务 ===');
  const { data: done } = await supabase.from('aevum_memories')
    .select('id, title, content, event_time, owner, created_at')
    .eq('task_status', 'done')
    .order('done_at', { ascending: false })
    .limit(10);
  for (const mem of done || []) {
    console.log(`done id=${mem.id} owner=${mem.owner} time=${mem.event_time} done_at=${mem.done_at}`);
    console.log(`  title: ${mem.title}`);
    console.log(`  content: ${String(mem.content || '').slice(0, 150)}`);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
