// 测试 getRecentTimelineContext 逻辑（复现）：最近3天对话事件按天压缩
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
  const days = 3, maxPerDay = 3;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data } = await supabase
    .from('aevum_memories')
    .select('id, content, event_time, created_at, source, importance')
    .eq('status', 'active')
    .gte('created_at', since)
    .limit(60);
  console.log('3天内记忆(抽样上限60):', (data || []).length);
  const wake = (data || []).filter(m => m.source === 'wake').length;
  console.log('其中唤醒类(wake):', wake, '→ 时间线会排除');
  const items = (data || []).filter(m => m.source !== 'wake');
  const byDay = {};
  for (const m of items) {
    const t = new Date(m.event_time || m.created_at);
    if (isNaN(t.getTime())) continue;
    const bj = new Date(t.getTime() + 8 * 3600 * 1000);
    const key = `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`;
    (byDay[key] = byDay[key] || []).push(m);
  }
  const dayKeys = Object.keys(byDay).sort().reverse().slice(0, days);
  console.log('\n=== 近期时间线输出预览 ===');
  const todayKey = (() => {
    const bj = new Date(Date.now() + 8 * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}`;
  })();
  for (const key of dayKeys) {
    const dayItems = byDay[key].sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, maxPerDay);
    const whenLabel = key === todayKey ? '今天' : key === dayKeys[1] ? '昨天' : key.slice(5).replace('-', '/');
    const brief = dayItems.map(m => {
      const c = String(m.content || '').replace(/\s+/g, ' ');
      return c.replace(/^\d{4}-\d{2}-\d{2}[\s前半晚中午下午]*/, '').slice(0, 80);
    }).join('；');
    console.log(`${whenLabel}(${key})：${brief.slice(0, 200)}`);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
