// 测后花园：未指定田号时的批量/提示行为
const BASE = 'http://127.0.0.1:3998';
const H = { 'X-Debug-Token': 'localtest123', 'Content-Type': 'application/json; charset=utf-8' };
async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return await r.json();
}
const choose = (node, id, args) => post('/api/debug/wake/choose', { node, option_id: id, args: args || {} });

(async () => {
  console.log('--- 进后花园 ---');
  const g = await choose('root', 'garden', {});
  console.log(g.outcome.split('\n')[0]);

  console.log('\n--- 收获（不带田号，空场地应有清楚提示）---');
  const h = await choose('garden', 'garden_harvest', {});
  console.log(h.outcome.split('\n').slice(0, 2).join('\n'));

  console.log('\n--- 除虫（不带田号）---');
  const p = await choose('garden', 'garden_pest', {});
  console.log(p.outcome.split('\n').slice(0, 2).join('\n'));

  console.log('\n--- 浇水（不带田号）---');
  const w = await choose('garden', 'garden_water', {});
  console.log(w.outcome.split('\n').slice(0, 2).join('\n'));

  console.log('\n--- 收获指定 1 号田 ---');
  const h2 = await choose('garden', 'garden_harvest', { plot: 1 });
  console.log(h2.outcome.split('\n').slice(0, 2).join('\n'));
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
