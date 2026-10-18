// 诊断：garden_text 表里的 crops 是否带 sell_price（售卖全 0 的嫌疑根因）
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

(async () => {
  const { data, error } = await supabase.from('garden_text').select('data, updated_at').eq('id', 1).maybeSingle();
  if (error) { console.log('ERR', error.message); return; }
  if (!data) { console.log('garden_text 无 id=1 行（会回退本地文件）'); return; }
  const d = data.data || {};
  console.log('updated_at:', data.updated_at);
  console.log('顶层键:', Object.keys(d).join(','));
  const c = d.crops || {};
  console.log('crops 数量:', Object.keys(c).length);
  for (const k of Object.keys(c).slice(0, 6)) {
    console.log(' ', k, '| sell_price:', c[k].sell_price, '| name:', c[k].name);
  }
  const withPrice = Object.keys(c).filter(k => Number(c[k].sell_price) > 0).length;
  console.log('有卖价的:', withPrice, '/', Object.keys(c).length);
  // 与本地文件对比
  const local = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'garden-text.json'), 'utf8'));
  const lc = local.crops || {};
  console.log('本地文件 crops:', Object.keys(lc).length, '| 有卖价:', Object.keys(lc).filter(k => Number(lc[k].sell_price) > 0).length);
  const missing = Object.keys(lc).filter(k => !c[k]);
  console.log('DB 缺的作物（本地有 DB 没有）:', missing.length, missing.slice(0, 10).join(','));
  const noPrice = Object.keys(c).filter(k => !(Number(c[k].sell_price) > 0));
  console.log('DB 里没卖价的作物:', noPrice.length, noPrice.slice(0, 12).join(','));
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
