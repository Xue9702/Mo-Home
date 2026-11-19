// 给旧的工具事件补上不可见标记前缀（U+2063），让它们继续按工具事件样式显示
// 背景：2026-11-20 起新工具事件带标记，前端只认带标记的（防默在正文里伪造工具事件）
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);
const MARK = '\u2063';
const PREFIX = '【工具事件】';

(async () => {
  // 分页取所有可能是工具事件的 assistant 消息
  let offset = 0;
  const PAGE = 1000;
  let total = 0, updated = 0, failed = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('messages')
      .select('id, content')
      .eq('role', 'assistant')
      .like('content', PREFIX + '%')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) { console.log('查询失败:', error.message); break; }
    if (!data || !data.length) break;
    total += data.length;
    for (const row of data) {
      const c = String(row.content || '');
      if (c.startsWith(MARK)) continue; // 已有标记
      const { error: uerr } = await supabase.from('messages').update({ content: MARK + c }).eq('id', row.id);
      if (uerr) { failed++; console.log(`  #${row.id} 更新失败: ${uerr.message}`); }
      else updated++;
    }
    offset += PAGE;
    if (data.length < PAGE) break;
  }
  console.log(`扫描到旧工具事件 ${total} 条，已补标记 ${updated} 条，失败 ${failed} 条`);
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
