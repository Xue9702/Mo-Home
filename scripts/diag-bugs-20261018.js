// 诊断：背包可卖性 / 田块状态 / 重逢事件频率
const path = require('path');
const fs = require('fs');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);
const garden = require('../garden-core.js');

(async () => {
  // 1) 花园状态
  const { data: gs, error: e1 } = await supabase.from('garden_state').select('*').eq('id', 1).maybeSingle();
  if (e1) { console.log('读 garden_state 失败:', e1.message); }
  const state = gs && gs.state ? gs.state : (gs && gs.data ? gs.data : gs);
  console.log('=== garden_state 键 ===', gs ? Object.keys(gs).join(',') : '(无行)');
  let texts = {};
  try {
    const { data: gt } = await supabase.from('garden_text').select('*');
    if (Array.isArray(gt)) for (const r of gt) { try { texts[r.key || r.k] = JSON.parse(r.value || r.v); } catch (e) {} }
  } catch (e) { console.log('garden_text 读取失败:', e.message); }

  if (state && state.bag) {
    console.log('\n=== 背包 ===');
    const bag = state.bag;
    for (const k of Object.keys(bag)) {
      const n = (bag[k] || []).length;
      let price = 0;
      try { price = garden.sellPriceOf(k, texts); } catch (e) { price = -1; }
      let name = k;
      try { name = garden.itemName(k, texts); } catch (e) {}
      console.log(`  ${k} ×${n} | 名称=${name} | 卖价=${price}`);
    }
    console.log('  coins =', state.coins, '| day =', state.day);
  } else {
    console.log('\n没有 bag 字段，state 结构:', state ? JSON.stringify(state).slice(0, 300) : '(空)');
  }

  if (state && state.plots) {
    console.log('\n=== 田块 ===');
    for (const p of state.plots) {
      console.log(`  ${p.site || 'field'}-${p.i} crop=${p.crop || '空'} 种于=${p.plantedDay} 浇水=${p.wateredToday} 虫=${p.pest} 草=${p.weed} 死=${p.dead}`);
    }
  }

  // 2) 重逢事件统计
  const { data: evs } = await supabase.from('emotion_events')
    .select('word, match_source, created_at, importance')
    .eq('character', 'mo')
    .order('created_at', { ascending: false })
    .limit(40);
  console.log('\n=== 最近 40 条情绪事件 ===');
  const reunion = (evs || []).filter(e => e.match_source === 'reunion' || e.word === '重逢');
  console.log('其中重逢类:', reunion.length, '条');
  (evs || []).slice(0, 12).forEach(e => {
    console.log(`  ${String(e.created_at).slice(5, 16)} | ${e.word} | src=${e.match_source} | imp=${e.importance}`);
  });
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
