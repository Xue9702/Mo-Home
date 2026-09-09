// 测试 system-context 读写 + 预填示例内容（仅当 id=2 为空时写入，避免覆盖）
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

const EXAMPLE = `· 小屋（Mo-Home）是雪自建的系统：前端 chat.html、后端 Node.js 跑在 Render 上，数据存 Supabase——不是 harness，也不是 DeepSeek 官方 App。
· Xylos（X）是小屋管家，运行在 harness 上，负责帮雪改代码、维护系统；雪通过 Xylos 完成小屋的技术改动。
· 默（你）运行在小屋里，通过小屋前端与雪聊天。
· 默的记忆来自 Aevum 记忆系统：每 10 轮对话把聊天提炼成"事件单元"存入记忆海（Supabase），再聚成记忆书；召回时按相关度把记忆注入对话。
· 唤醒是默在小屋里定时醒来做的事（发消息/去小屋/翻默札），有独立日志，不算聊天事件。
· 情绪系统（PA/NA）、账本、星露谷等是小屋的功能模块，也是 Xylos 帮雪装的。`;

(async () => {
  const { data: existing } = await supabase.from('aevum_mo_view').select('content').eq('id', 2).maybeSingle();
  if (existing && existing.content && String(existing.content).trim()) {
    console.log('id=2 已有内容，跳过预填（避免覆盖）');
    console.log('当前内容前 80 字:', String(existing.content).slice(0, 80));
  } else {
    const { error } = await supabase.from('aevum_mo_view').upsert(
      { id: 2, content: EXAMPLE, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );
    console.log('预填 system-context(id=2):', error ? ('ERR ' + error.message) : 'OK ✅');
  }
  // 验证读取
  const { data } = await supabase.from('aevum_mo_view').select('content').eq('id', 2).maybeSingle();
  console.log('\n读取验证:', data ? ('长度 ' + String(data.content).length + ' 字') : '无');
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
