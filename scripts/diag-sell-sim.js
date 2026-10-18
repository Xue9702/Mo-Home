// 模拟默的售卖流程：真实背包 + 真实文案源 → 看能不能卖
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);
const gardenCore = require('../garden-core.js');
const texts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'garden-text.json'), 'utf8'));

(async () => {
  const { data: gs } = await supabase.from('garden_state').select('state').eq('id', 1).maybeSingle();
  const state = gs && gs.state;
  if (!state) { console.log('读不到 garden_state'); return; }
  console.log('=== 模拟「卖东西」清单（sell 菜单） ===');
  const sellable = Object.keys(state.bag || {}).map(k => ({ id: k, n: (state.bag[k] || []).length, price: gardenCore.sellPriceOf(k, texts) })).filter(x => x.price > 0);
  if (!sellable.length) {
    console.log('❌ 清单为空 → 默会看到「背包里没有能卖的东西」');
    for (const k of Object.keys(state.bag || {})) {
      console.log('   ', k, '| price =', gardenCore.sellPriceOf(k, texts), '| crops表里有吗:', !!(texts.crops || {})[k]);
    }
  } else {
    for (const x of sellable) console.log('   ', gardenCore.itemName(x.id, texts), '×' + x.n, x.price + '💰');
  }

  console.log('\n=== 模拟「卖一份雏菊」 ===');
  const r = gardenCore.sellItem(state, { item: 'daisy', texts });
  console.log('ok:', r.ok, '| msg:', r.msg, '| 新金币:', r.state ? r.state.coins : '?');

  console.log('\n=== 模拟卖中文名「小白菜」 ===');
  const r2 = gardenCore.sellItem(state, { item: 'bokchoy', texts });
  console.log('ok:', r2.ok, '| msg:', r2.msg);

  console.log('\n=== 检查 texts 关键字段 ===');
  console.log('crops 键数:', Object.keys(texts.crops || {}).length);
  console.log('goods（成品/其它）键数:', Object.keys(texts.goods || {}).length);
  console.log('egg 卖价:', gardenCore.sellPriceOf('egg', texts));
  const fishKeys = Object.keys(state.bag || {}).filter(k => k.startsWith('fish_'));
  console.log('背包鱼:', fishKeys.length ? fishKeys.join(',') : '(无)');
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
