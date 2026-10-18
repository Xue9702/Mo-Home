// 生成给雪看的物品大全（分类 + 卖价 + 送礼好感增益）
const fs = require('fs');
const texts = JSON.parse(fs.readFileSync('E:/Mo-Home 1/garden-text.json', 'utf8'));
const crops = texts.crops || {};
const fish = (texts.fish && texts.fish.kinds) || {};
const goods = Object.fromEntries(Object.entries(texts.goods || {}).filter(([k]) => !k.startsWith('_')));
const recipes = (texts.recipes && texts.recipes.list) || [];

const gain = (price) => price > 0 ? Math.max(2, Math.round(price / 5)) : 2;

const groups = {
  '🌸 花（花田）': Object.entries(crops).filter(([, c]) => c.kind === 'flower'),
  '🥬 菜（菜田）': Object.entries(crops).filter(([, c]) => c.kind === 'veg'),
  '🍄 菌菇（菌床）': Object.entries(crops).filter(([, c]) => c.kind === 'mushroom'),
  '🍓 水果（菜田）': Object.entries(crops).filter(([, c]) => c.kind === 'fruit')
};

for (const [title, list] of Object.entries(groups)) {
  console.log('\n### ' + title + '（' + list.length + ' 种）\n');
  console.log('| 名称 | 种几天 | 卖价 | 送她好感 |');
  console.log('|---|---|---|---|');
  for (const [id, c] of list) {
    console.log(`| ${c.name || id} | ${c.days || '-'} 天 | ${c.sell_price || 0}💰 | +${gain(c.sell_price || 0)} |`);
  }
}

console.log('\n### 🐟 鱼（4 种 × 三档品相）\n');
console.log('| 名称 | 幼小 | 正常 | 肥 |');
console.log('|---|---|---|---|');
for (const [id, f] of Object.entries(fish)) {
  const sp = f.sell || {};
  console.log(`| ${f.name || id} | ${sp.small || 0}💰(+${gain(sp.small)}) | ${sp.normal || 0}💰(+${gain(sp.normal)}) | ${sp.fat || 0}💰(+${gain(sp.fat)}) |`);
}

console.log('\n### 🥚 鸡蛋 / 🧱 材料 / 食材\n');
console.log('| 物品 | 卖价 | 送她好感 | 说明 |');
console.log('|---|---|---|---|');
console.log(`| 鸡蛋 | 15💰 | +3 | 鸡棚捡 |`);
console.log(`| 豆腐 / 牛肉 / 猪肉 / 鸡肉 / 粉条 / 面饼 | 卖不了 | +2 | 做饭材料（商店买或成品） |`);
console.log(`| 木板 / 钉子 | 卖不了 | +2 | 建造用（猫窝/狗屋） |`);
console.log(`| 各种种子 | 卖不了 | +2 | 播种用 |`);

console.log('\n### 🍳 能做的菜（' + recipes.length + ' 道）\n');
console.log('| 菜名 | 材料 |');
console.log('|---|---|');
for (const r of recipes) {
  const need = Object.entries(r.need || {}).map(([k, v]) => `${k}×${v}`).join('、');
  const pick = r.pick ? `（另任选${r.pick.n || 1}种 ${(r.pick.from || []).join('/')}）` : '';
  console.log(`| ${r.name || r.id} | ${need}${pick} |`);
}
