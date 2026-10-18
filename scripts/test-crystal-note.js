// 测水晶球 note 防重复 + 菜单自动隐藏
const BASE = 'http://127.0.0.1:3998';
const H = { 'X-Debug-Token': 'localtest123', 'Content-Type': 'application/json; charset=utf-8' };
async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return await r.json();
}
const choose = (node, id, args) => post('/api/debug/wake/choose', { node, option_id: id, args: args || {} });

(async () => {
  console.log('--- 1. 摸水晶球 ---');
  const c1 = await choose('room', 'crystal', {});
  console.log(c1.outcome.slice(0, 120));
  console.log('下一节点:', c1.nextNode);

  console.log('\n--- 2. 第一次说第一感觉 ---');
  const n1 = await choose('crystal_done', 'crystal_note', { text: '今天有点累，但看到这张牌想笑' });
  console.log(n1.outcome);

  console.log('\n--- 3. 第二次说（应被拒绝） ---');
  const n2 = await choose('crystal_done', 'crystal_note', { text: '再说一遍' });
  console.log(n2.outcome);

  console.log('\n--- 4. 菜单里还有 crystal_note 吗（应为空/没了） ---');
  const st = await post('/api/debug/wake/choose', { node: 'crystal_done', option_id: 'back_root', args: {} });
  const opts = (st.menu && st.menu.options || []).map(o => o.id);
  console.log('crystal_done 菜单项(回主卧后):', opts.join(', '));
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
