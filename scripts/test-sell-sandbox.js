// 用 UTF-8 正确调用本地沙盒接口，测售卖的自然语言解析
const BASE = 'http://127.0.0.1:3998';
const TOKEN = 'localtest123';
const H = { 'X-Debug-Token': TOKEN, 'Content-Type': 'application/json; charset=utf-8' };

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return await r.json();
}

async function choose(node, optionId, args) {
  return post('/api/debug/wake/choose', { node, option_id: optionId, args: args || {} });
}

(async () => {
  // 先回到 sell 节点并确认背包
  const list = await choose('sell', 'sell', {});
  console.log('=== 卖前清单 ===\n' + list.outcome + '\n');

  const cases = [
    { name: '卖雏菊（不带"卖"字更好，但先测原样）', args: { content: '卖雏菊' } },
    { name: '雏菊（纯名）', args: { content: '雏菊' } },
    { name: '把小白菜卖掉', args: { content: '把小白菜卖掉' } },
    { name: '卖3份胡萝卜', args: { content: '卖3份胡萝卜' } },
    { name: '卖钻石（不存在）', args: { content: '卖钻石' } }
  ];
  for (const c of cases) {
    const r = await choose('sell', 'sell_item', c.args);
    console.log(`--- ${c.name} ---\n${r.outcome}\n`);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
