// 沙盒实测：送礼给虚拟的雪（并确认好感只在沙盒内存变化）
const BASE = 'http://127.0.0.1:3998';
const H = { 'X-Debug-Token': 'localtest123', 'Content-Type': 'application/json; charset=utf-8' };
async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return await r.json();
}
const choose = (node, id, args) => post('/api/debug/wake/choose', { node, option_id: id, args: args || {} });
const getState = () => fetch(BASE + '/api/debug/wake/state', { headers: H }).then(r => r.json());

(async () => {
  // 先开沙盒（复制真实状态）
  const st = await post('/api/debug/wake/start', { fromReal: true });
  console.log('=== 沙盒开启:', st.ok, '| fromReal:', st.fromReal);
  const s1 = await getState();
  console.log('=== 沙盒 active:', s1.active);

  console.log('\n--- 去她的小屋 → 走近她 ---');
  let r = await choose('root', 'her_house', {});
  console.log(r.outcome);
  r = await choose('her_house', 'virtual_her', {});
  console.log(r.outcome);
  console.log('菜单:', (r.menu.options || []).map(o => o.id).join(', '));

  console.log('\n--- 送她雏菊（中文名）---');
  r = await choose('virtual_her', 'gift_to_her', { content: '雏菊' });
  console.log(r.outcome);

  console.log('\n--- 再送两朵雏菊 ---');
  r = await choose('virtual_her', 'gift_to_her', { item: 'daisy', n: 2 });
  console.log(r.outcome);

  console.log('\n--- 送不存在的东西 ---');
  r = await choose('virtual_her', 'gift_to_her', { content: '玫瑰' });
  console.log(r.outcome);

  console.log('\n--- 不带物品名（应列背包）---');
  r = await choose('virtual_her', 'gift_to_her', {});
  console.log(r.outcome);
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
