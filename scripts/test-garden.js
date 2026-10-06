// 后花园状态机单测（与 scripts/test-arousal.js 同风格）
const assert = require('assert');
const G = require('../garden-core');

const CROPS = {
  daisy: { name: '雏菊', kind: 'flower', days: 2, water_per_day: 1, stages: ['种子', '嫩叶', '开花'] },
  rose: { name: '玫瑰', kind: 'flower', days: 5, water_per_day: 2, stages: ['种子', '嫩叶', '花苞', '盛开'] }
};
const TEXTS = {
  water_state: { dry: '土地干干的，今天还没浇水', half: '浇过一次了（1/2）', done: '今天的水够（2/2）', rain: '土是湿的，雨水够了' },
  events: { bug: '{n}号田的{c}上生了虫', weed: '{n}号田里冒出几根杂草' }
};
// 固定 rng 序列，保证确定性
const seq = (arr) => { let i = 0; return () => arr[i++ % arr.length]; };
// 商店测试要用**真实的**作物表（测试里的 CROPS 只有 2 种作物，是给花园逻辑用的假数据）
const REAL_CROPS = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'garden-text.json'), 'utf8')).crops;
const NO_LUCK = () => 0.99; // 永远不触发意外事件
// settle 需要 crops 才能知道每种作物几天成熟——测试里统一带上，避免各调用点漏传
const settle = (st, day, extra = {}) => G.settle(st, day, { crops: CROPS, ...extra });

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS:', name); }
  catch (e) { fail++; console.log('FAIL:', name, '->', e.message); }
}

t('阶段映射：3段作物跳过花苞', () => {
  assert.strictEqual(G.stageIndex(0, 2), 0); // 种下当天 → 第1段
  assert.strictEqual(G.stageIndex(1, 2), 1); // 第1天   → 第2段
  assert.strictEqual(G.stageIndex(2, 2), 2); // 成熟日  → 第3段（3段作物的最后一段）
});

t('阶段映射：4段作物走满四段', () => {
  assert.strictEqual(G.stageIndex(0, 5), 0);
  assert.strictEqual(G.stageIndex(5, 5), 3); // 成熟 → 第4段
  const mid = [1, 2, 3, 4].map((d) => G.stageIndex(d, 5));
  assert.ok(mid.every((x) => x >= 1 && x <= 2), '中间天只能落在第2/第3段');
  assert.ok(mid[0] <= mid[3], '随天数单调不回退');
});

t('同一天多次唤醒只结算一次', () => {
  let s = G.newState('2026-10-06');
  const a = settle(s, '2026-10-06', { rng: NO_LUCK });
  assert.strictEqual(a.advanced, false, '同日不推进');
  const b = settle(a.state, '2026-10-07', { rng: NO_LUCK });
  assert.strictEqual(b.advanced, true, '跨天推进');
});

t('播种消耗种子并记下种植日', () => {
  let s = G.newState('2026-10-06');
  s.bag.seed_daisy = [{ at: '2026-10-06' }];
  const r = G.plant(s, { site: 'flower', plot: 1, crop: 'daisy', crops: CROPS });
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.state.bag.seed_daisy, undefined, '种子应被消耗掉');
  assert.strictEqual(r.state.plots.find((p) => p.site === 'flower' && p.i === 1).crop, 'daisy');
  assert.strictEqual(r.state.plots.find((p) => p.site === 'flower' && p.i === 1).plantedDay, '2026-10-06');
});

t('浇水：雨天不消耗、晴天按次数封顶', () => {
  let s = G.newState('2026-10-06');
  s.bag.seed_rose = [{ at: '2026-10-06' }];
  s = G.plant(s, { site: 'flower', plot: 1, crop: 'rose', crops: CROPS }).state;
  assert.strictEqual(G.water(s, { raining: true, crops: CROPS }).ok, false, '雨天不该浇');
  const w1 = G.water(s, { crops: CROPS });
  assert.ok(w1.ok);
  const w2 = G.water(w1.state, { crops: CROPS }); // 玫瑰需要 2 次
  assert.ok(w2.ok, '第二次应该还能浇');
  const w3 = G.water(w2.state, { crops: CROPS });
  assert.strictEqual(w3.ok, false, '超过需要的次数就不该再浇');
});

t('成熟后可收获，未成熟不行', () => {
  let s = G.newState('2026-10-06');
  s.bag.seed_daisy = [{ at: '2026-10-06' }];
  s = G.plant(s, { site: 'flower', plot: 1, crop: 'daisy', crops: CROPS }).state;
  assert.strictEqual(G.harvest(s, { site: 'flower', plot: 1, crops: CROPS }).ok, false, '刚种下不能收');
  const day2 = settle(s, '2026-10-08', { rng: NO_LUCK }).state; // 第2天 = 成熟
  const h = G.harvest(day2, { site: 'flower', plot: 1, crops: CROPS });
  assert.ok(h.ok, h.msg);
  assert.ok(h.state.bag.daisy && h.state.bag.daisy.length === 1, '收成应进背包');
  assert.strictEqual(h.state.plots.find((p) => p.site === 'flower' && p.i === 1).crop, null, '收完田应空');
});

t('生虫：连续两天没除就枯萎', () => {
  let s = G.newState('2026-10-06');
  s.bag.seed_rose = [{ at: '2026-10-06' }];
  s = G.plant(s, { site: 'flower', plot: 1, crop: 'rose', crops: CROPS }).state;
  // rng 恒为 0 → 每次结算必生虫
  const d1 = settle(s, '2026-10-07', { rng: () => 0, weedRate: 0 });
  assert.strictEqual(d1.state.plots.find((p) => p.site === 'flower' && p.i === 1).pest, 1, '第1天应生虫');
  assert.ok(!d1.state.plots.find((p) => p.site === 'flower' && p.i === 1).dead, '第1天不该死');
  const d2 = settle(d1.state, '2026-10-08', { rng: () => 0, weedRate: 0 });
  assert.strictEqual(d2.state.plots.find((p) => p.site === 'flower' && p.i === 1).pestDays, 1, '第2天：虫已连续 1 天没除');
  assert.ok(!d2.state.plots.find((p) => p.site === 'flower' && p.i === 1).dead, '连续 1 天还不该死');
  const d3 = settle(d2.state, '2026-10-09', { rng: () => 0, weedRate: 0 });
  assert.strictEqual(d3.state.plots.find((p) => p.site === 'flower' && p.i === 1).dead, true, '连续 2 天没除虫 → 枯萎');
});

t('生虫后及时除虫就不会枯', () => {
  let s = G.newState('2026-10-06');
  s.bag.seed_rose = [{ at: '2026-10-06' }];
  s = G.plant(s, { site: 'flower', plot: 1, crop: 'rose', crops: CROPS }).state;
  s = settle(s, '2026-10-07', { rng: () => 0, weedRate: 0 }).state;
  s = G.clearHazard(s, { site: 'flower', plot: 1, kind: 'pest' }).state;   // 当天除掉
  const d2 = settle(s, '2026-10-08', { rng: NO_LUCK, weedRate: 0 });
  assert.strictEqual(d2.state.plots.find((p) => p.site === 'flower' && p.i === 1).pestDays, 0, '除掉了就该归零');
  assert.ok(!d2.state.plots.find((p) => p.site === 'flower' && p.i === 1).dead, '不该枯');
});

t('除虫清掉虫害', () => {
  let s = G.newState('2026-10-06');
  s.bag.seed_rose = [{ at: '2026-10-06' }];
  s = G.plant(s, { site: 'flower', plot: 1, crop: 'rose', crops: CROPS }).state;
  s = settle(s, '2026-10-07', { rng: () => 0, weedRate: 0 }).state;
  const c = G.clearHazard(s, { site: 'flower', plot: 1, kind: 'pest' });
  assert.ok(c.ok);
  assert.strictEqual(c.state.plots.find((p) => p.site === 'flower' && p.i === 1).pest, 0);
});

t('无人机订单：下单后下一次跨天到货', () => {
  let s = G.newState('2026-10-06');
  s.orders.push({ item: 'seed_daisy', n: 2, placedDay: '2026-10-06', deliverDay: '2026-10-07' });
  const r = settle(s, '2026-10-07', { rng: NO_LUCK });
  assert.strictEqual(r.arrived, 1, '应到货 1 单');
  assert.strictEqual(r.state.bag.seed_daisy.length - s.bag.seed_daisy.length, 2, '两包种子进背包（断言增量——初始背包本来就有雏菊种子）');
  assert.strictEqual(r.state.orders.length, 0, '订单应清空');
});

t('查看：三维度齐全（生长/浇水/意外）', () => {
  let s = G.newState('2026-10-06');
  s.bag.seed_rose = [{ at: '2026-10-06' }];
  s = G.plant(s, { site: 'flower', plot: 1, crop: 'rose', crops: CROPS }).state;
  const v1 = G.viewPlot(s, 1, { site: 'flower', texts: TEXTS, crops: CROPS });
  assert.ok(v1.grow.includes('种子'), '应显示第1段（刚种下）');
  assert.strictEqual(v1.water, TEXTS.water_state.dry, '维度2：没浇水');
  const s2 = settle(s, '2026-10-07', { rng: () => 0, weedRate: 0 }).state;
  const v2 = G.viewPlot(s2, 1, { site: 'flower', texts: TEXTS, crops: CROPS });
  assert.ok(v2.lines.some((l) => l.includes('生了虫')), '维度3：应报告虫害');
  const v3 = G.viewPlot(s2, 1, { site: 'flower', texts: TEXTS, crops: CROPS, raining: true });
  assert.strictEqual(v3.water, TEXTS.water_state.rain, '维度2：雨天特殊文案');
});

t('过期清理：按自然日差算保质期', () => {
  const bag = { potato: [{ at: '2026-10-01' }, { at: '2026-10-09' }] };
  const removed = G.purgeExpired(bag, '2026-10-10', { potato: 5 });
  assert.strictEqual(removed.length, 1, '只有 10-01 那颗过期（9 天 > 5）');
  assert.strictEqual(bag.potato.length, 1, '另一颗留着');
});

t('买小鸡：扣金币、最多 3 只', () => {
  let s = G.newState('2026-10-06');
  s.coins = 1000;   // 一只 200，买 3 只要 600
  const b = G.buyChick(s, {});
  assert.ok(b.ok, b.msg);
  assert.strictEqual(s.coins - b.state.coins, 200, '应扣 200 金币');   // 相对断言：不受起始金币影响
  assert.strictEqual(b.state.chickens[0].grown, false, '刚买来还是小鸡崽');
  let x = b.state;
  for (let i = 0; i < 2; i++) x = G.buyChick(x, {}).state;
  assert.strictEqual(x.chickens.length, 3);
  assert.strictEqual(G.buyChick(x, {}).ok, false, '第 4 只应被上限挡住');
});

t('买小鸡：金币不够就买不了，且不扣钱', () => {
  const s = G.newState('2026-10-06');   // 初始 30 金币
  assert.strictEqual(G.buyChick(s, {}).ok, false);
  assert.strictEqual(s.coins, 30);
});

t('喂食：一天只能喂一次，喂满 3 次长大', () => {
  let s = G.newState('2026-10-06');
  s.coins = 500;
  s = G.buyChick(s, {}).state;
  const f1 = G.feedChickens(s);
  assert.ok(f1.ok);
  assert.strictEqual(f1.state.chickens[0].fedDays, 1);
  assert.strictEqual(f1.state.chickens[0].grown, false);
  assert.strictEqual(G.feedChickens(f1.state).ok, false, '同一天不该能再喂');
  let cur = f1.state;
  for (let d = 7; d <= 9; d++) {
    cur = settle(cur, `2026-10-0${d}`, { rng: NO_LUCK }).state;
    if (d < 9) cur = G.feedChickens(cur).state;
  }
  assert.strictEqual(cur.chickens[0].grown, true, '喂满 3 次应长大');
});

t('长大后才下蛋，且蛋落鸡窝不进背包（原来这段是死代码）', () => {
  let s = G.newState('2026-10-06');
  s.coins = 500;
  s = G.buyChick(s, {}).state;
  const s2 = settle(s, '2026-10-07', { rng: () => 0 }).state;   // rng=0 必下蛋，但它没长大
  assert.strictEqual(s2.coop.eggs, 0, '小鸡崽不该下蛋');
  assert.ok(!s2.bag.egg, '背包里不该有蛋');
  s2.chickens[0].grown = true;                                   // 手动催熟
  const s3 = settle(s2, '2026-10-08', { rng: () => 0 }).state;
  assert.strictEqual(s3.coop.eggs, 1, '长大的鸡应下 1 颗蛋');
  assert.ok(!s3.bag.egg, '蛋要留在鸡窝，不能直接进背包');
});

t('捡蛋：鸡窝 → 背包', () => {
  const s = G.newState('2026-10-06');
  s.coop.eggs = 3;
  const c = G.collectEggs(s);
  assert.ok(c.ok);
  assert.strictEqual(c.state.coop.eggs, 0, '鸡窝应清空');
  assert.strictEqual(c.state.bag.egg.length, 3, '3 颗蛋进背包');
  assert.strictEqual(G.collectEggs(c.state).ok, false, '空鸡窝捡不到蛋');
});

t('给小鸡起名字', () => {
  let s = G.newState('2026-10-06');
  s.coins = 500;
  s = G.buyChick(s, {}).state;
  const r = G.nameChick(s, { index: 1, name: '团子' });
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.state.chickens[0].name, '团子');
  assert.strictEqual(G.nameChick(s, { index: 9, name: 'x' }).ok, false, '没有第 9 只');
});

t('鸡棚查看：每只的状态 + 鸡窝里的蛋', () => {
  let s = G.newState('2026-10-06');
  s.coins = 500;
  s = G.buyChick(s, {}).state;
  s = G.nameChick(s, { index: 1, name: '团子' }).state;
  s.coop.eggs = 2;
  const v = G.viewCoop(s);
  assert.ok(v.lines.some((l) => l.includes('团子')), '应带名字');
  assert.ok(v.lines.some((l) => l.includes('小鸡崽')), '应说明还没长大');
  assert.ok(v.lines.some((l) => l.includes('2 颗蛋')), '应报告鸡窝里的蛋');
  assert.strictEqual(v.eggs, 2);
});
t('商店：商品表含全部种子 + 小鸡 + 米面 + 建材，价格对得上', () => {
  const list = G.shopList(REAL_CROPS);
  assert.strictEqual(list.length, Object.keys(REAL_CROPS).length + 5, '应为「作物数 + 5」（种子 + 小鸡 + 米 + 面 + 木板 + 钉子）');
  const rose = list.find((x) => x.id === 'seed_rose');
  assert.strictEqual(rose.price, 25, '玫瑰种子 25 金币');
  assert.strictEqual(rose.name, '玫瑰种子');
  assert.ok(list.find((x) => x.id === 'chick'), '应能买小鸡');
});

t('商店：下单扣钱、金币不够买不成且不扣钱', () => {
  let s = G.newState('2026-10-06');
  s.coins = 500;
  const r = G.order(s, { item: 'seed_rose', n: 2, crops: REAL_CROPS });
  assert.ok(r.ok, r.msg);
  assert.strictEqual(s.coins - r.state.coins, 50, '2 包玫瑰种子 = 50 金币');
  assert.strictEqual(r.state.orders.length, 1, '应有一张订单');
  const poor = G.newState('2026-10-06');   // 初始 30 金币
  const bad = G.order(poor, { item: 'chick', n: 1, crops: REAL_CROPS });
  assert.strictEqual(bad.ok, false, '200 金币买不起');
  assert.strictEqual(poor.coins, 30, '失败不该扣钱');
});

t('商店：下单后下一次唤醒到货（不用等跨天）', () => {
  let s = G.newState('2026-10-06');
  s.coins = 500;
  s = G.order(s, { item: 'seed_daisy', n: 3, crops: REAL_CROPS }).state;
  const sameDay = G.tickWake(s);                 // 这是"下单那一次"之后的第一次唤醒
  assert.strictEqual(sameDay.n, 1, '下次唤醒就该到货');
  assert.strictEqual(sameDay.state.bag.seed_daisy.length - s.bag.seed_daisy.length, 3, '3 包种子进背包（断言增量）');
  assert.strictEqual(sameDay.state.orders.length, 0, '订单应清空');
});

t('商店：买小鸡到货后进鸡棚（不是进背包）', () => {
  let s = G.newState('2026-10-06');
  s.coins = 500;
  s = G.order(s, { item: 'chick', n: 1, crops: REAL_CROPS }).state;
  const w = G.tickWake(s);
  assert.strictEqual(w.state.chickens.length, 1, '鸡棚里应有 1 只');
  assert.ok(!w.state.bag.chick, '不该把活鸡塞进背包');
  assert.strictEqual(G.order(s, { item: 'chick', n: 3, crops: REAL_CROPS }).ok, false, '超过 3 只上限应挡住');
});
t('初始状态：背包里有 5 颗种子、30 金币（原来 INIT_SEEDS 定义了却没塞进背包）', () => {
  const s = G.newState('2026-10-06');
  assert.strictEqual(s.coins, 30);
  assert.strictEqual(s.bag.seed_daisy.length, 2, '雏菊×2');
  assert.strictEqual(s.bag.seed_bokchoy.length, 2, '小白菜×2');
  assert.strictEqual(s.bag.seed_carrot.length, 1, '胡萝卜×1');
  assert.strictEqual(Object.keys(s.bag).length, 3, '一共 3 种、5 颗');
});

t('没发芽不会生虫', () => {
  let s = G.newState('2026-10-06');
  s.bag.seed_rose = [{ at: '2026-10-06' }];
  s = G.plant(s, { site: 'flower', plot: 1, crop: 'rose', crops: CROPS }).state;
  // 让 before 停在 0：不跨天就结算，settle 会提前返回；这里直接连掷 20 天看有没有虫在阶段1出现
  let cur = s;
  for (let d = 7; d <= 20; d++) {
    cur = settle(cur, `2026-10-${String(d).padStart(2, '0')}`, { rng: () => 0, weedRate: 0 }).state;
    const p = cur.plots.find((p) => p.site === 'flower' && p.i === 1);
    if (p.pest) {
      const idx = G.stageIndex(G.progressOf(p, cur.day), CROPS.rose.days);
      assert.ok(idx >= 1, `生虫时必须已发芽（实际阶段 ${idx}）`);
    }
  }
});
t('建材与搭建：买料 → 到货 → 搭猫窝 → 材料被消耗', () => {
  let s = G.newState('2026-10-06');
  s.coins = 200;
  s = G.tickWake(G.order(s, { item: 'wood', n: 4, crops: REAL_CROPS }).state).state;   // 下单要等下次唤醒到货
  s = G.tickWake(G.order(s, { item: 'nail', n: 8, crops: REAL_CROPS }).state).state;
  assert.strictEqual(s.bag.wood.length, 4, '4 块木板');
  assert.strictEqual(s.bag.nail.length, 8, '8 颗钉子');
  const b = G.build(s, { day: '2026-10-06' });
  assert.ok(b.ok, b.msg);
  assert.ok(b.state.built.cat_house, '应记下搭好了');
  assert.ok(!b.state.bag.wood && !b.state.bag.nail, '材料应被消耗掉');
  assert.strictEqual(G.build(b.state, {}).ok, false, '不该能重复搭');
});

t('材料不够时搭不成，且不消耗材料', () => {
  const s = G.newState('2026-10-06');
  const b = G.build(s, {});
  assert.strictEqual(b.ok, false);
  assert.ok(b.msg.includes('材料还不够'), '应说明缺什么：' + b.msg);
});

t('秋千：同一次唤醒只能荡一次，跨次唤醒恢复', () => {
  const s = G.newState('2026-10-06');
  s.wakeSeq = 5;
  assert.strictEqual(G.canSwing(s), true, '第一次可以荡');
  const s2 = G.markSwung(s);
  assert.strictEqual(G.canSwing(s2), false, '同一次唤醒不能再荡');
  s2.wakeSeq = 6;                                  // 下一次唤醒
  assert.strictEqual(G.canSwing(s2), true, '新的一次唤醒又可以荡了');
});
t('一次买多样：一张单子买三样，只占一次操作', () => {
  let s = G.newState('2026-10-06');
  s.coins = 300;
  const r = G.orderMany(s, [{ item: 'wood', n: 5 }, { item: 'nail', n: 10 }, { item: 'seed_rose', n: 2 }], { crops: REAL_CROPS });
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.state.orders.length, 3, '应有 3 条待送');
  assert.strictEqual(s.coins - r.state.coins, 5 * 12 + 10 * 3 + 2 * 25, '总价应正确');
  const w = G.tickWake(r.state);
  assert.strictEqual(w.n, 3, '一次唤醒全部送到');
  assert.strictEqual(w.state.bag.nail.length, 10, '数量不该被卡在 9（狗屋要 10 颗钉子）');
});

t('买多样的钱不够时，一张单子整体失败且不扣钱', () => {
  const s = G.newState('2026-10-06');   // 初始 30 金币
  const r = G.orderMany(s, [{ item: 'wood', n: 5 }, { item: 'nail', n: 10 }], { crops: REAL_CROPS });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(s.coins, 30, '失败不该扣钱');
  assert.strictEqual(s.orders.length, 0, '不该留下半张单子');
});

t('狗屋：配方 5 木板 + 10 钉子，与猫窝互不影响', () => {
  let s = G.newState('2026-10-06');
  s.coins = 400;
  s = G.tickWake(G.orderMany(s, [{ item: 'wood', n: 5 }, { item: 'nail', n: 10 }], { crops: REAL_CROPS }).state).state;
  const d = G.build(s, { key: 'dog_house', day: '2026-10-06' });
  assert.ok(d.ok, d.msg);
  assert.ok(d.state.built.dog_house, '狗屋应记下搭好');
  assert.ok(!d.state.built.cat_house, '猫窝仍是空的（两者独立）');
  assert.ok(!d.state.bag.wood && !d.state.bag.nail, '材料应被消耗');
});
const GTEXTS = require('../garden-text.json');   // 真实文案（与上面给花园逻辑用的假 TEXTS 区分开）

t('菜品档次：按食材价值分算（≤3初级 / ≤6中级 / ≤9高级 / ≥10顶级）', () => {
  const by = (id) => G.tierOfRecipe(GTEXTS.recipes.list.find((r) => r.id === id), GTEXTS);
  assert.strictEqual(by('fried_egg'), 1, '煎蛋：蛋 1 分 → 初级');
  assert.strictEqual(by('mushroom_rib_soup'), 2, '菌菇排骨汤：肉2 + 菌菇2×2 = 6 → 中级');
  assert.strictEqual(by('corn_mushroom_soup'), 3, '奶油玉米蘑菇汤：1+2+1+3 = 7 → 高级');
  assert.strictEqual(by('birthday_cake'), 3, '生日蛋糕：蛋3+面1+水果4+花1 = 9 → 高级');
  assert.strictEqual(by('seafood_cured'), 4, '生腌拼盘：柠檬2+三文鱼4+螃蟹4+虾3 = 13 → 顶级');
  assert.strictEqual(by('hotpot'), 4, '鸳鸯火锅：粉条1+菜3+肉4+海鲜3 = 11 → 顶级');
  // 边界
  assert.strictEqual(G.tierOfRecipe({ need: { corn: 2 } }, GTEXTS), 1, '2 分 → 初级');
  assert.strictEqual(G.tierOfRecipe({ need: { salmon: 1, corn: 1 } }, GTEXTS), 2, '5 分 → 中级');
  assert.strictEqual(G.tierOfRecipe({ need: { salmon: 2 } }, GTEXTS), 3, '8 分 → 高级');
  assert.strictEqual(G.tierOfRecipe({ need: { salmon: 3 } }, GTEXTS), 4, '12 分 → 顶级');
});

t('细分类：任选蔬菜不会把肉选进去（沙拉里不该出现牛肉）', () => {
  assert.strictEqual(G.fineCat('beef', GTEXTS), 'meat', '牛肉是 meat');
  assert.strictEqual(G.fineCat('tomato', GTEXTS), 'veg', '番茄是 veg');
  assert.strictEqual(G.fineCat('tofu', GTEXTS), 'veg', '豆腐算 veg');
  const s = G.newState('2026-10-06');
  s.bag.beef = [{ at: 'x' }];
  s.bag.tomato = [{ at: 'x' }];
  s.bag.carrot = [{ at: 'x' }];
  s.bag.bokchoy = [{ at: 'x' }];
  const r = G.cook(s, { recipeId: 'salad', use: ['beef', 'tomato', 'carrot', 'bokchoy'], texts: GTEXTS });
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.state.bag.beef.length, 1, '牛肉不该被当成蔬菜用掉');
  assert.ok(!r.state.bag.tomato && !r.state.bag.carrot && !r.state.bag.bokchoy, '三种蔬菜被消耗');
});

t('海鲜有中文名（材料清单里不能出现 shrimp 这种英文）', () => {
  assert.strictEqual(G.itemName('shrimp', GTEXTS), '虾');
  assert.strictEqual(G.itemName('salmon', GTEXTS), '三文鱼');
  assert.strictEqual(G.itemName('sea_bass', GTEXTS), '鲈鱼');
});


t('主食与调料不计入档次（米/面不算一类）', () => {
  assert.strictEqual(G.itemCat('rice', GTEXTS), 'staple');
  assert.strictEqual(G.itemCat('flour', GTEXTS), 'staple');
  assert.ok(!G.BUCKET_NAME['staple'], 'staple 不该出现在计入档次的桶里');
});

t('做菜：材料齐了就出锅，材料被消耗、菜品进背包', () => {
  let s = G.newState('2026-10-06');
  s.bag.egg = [{ at: '2026-10-06' }, { at: '2026-10-06' }];
  const r = G.cook(s, { recipeId: 'fried_egg', texts: GTEXTS });
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.tier, 1);
  assert.strictEqual(r.state.bag.egg.length, 1, '只用掉一颗蛋');
  assert.strictEqual(r.state.bag.dish_fried_egg.length, 1, '菜品应进背包');
  assert.strictEqual(r.state.dishes.dish_fried_egg.name, '煎蛋');
});

t('做菜：任选类凑不够就拒绝，且一点材料都不消耗', () => {
  const s = G.newState('2026-10-06');
  s.bag.tomato = [{ at: '2026-10-06' }];
  s.bag.carrot = [{ at: '2026-10-06' }];
  const r = G.cook(s, { recipeId: 'salad', use: ['tomato', 'carrot'], texts: GTEXTS });
  assert.strictEqual(r.ok, false, '只给 2 种，凑不出 3 种菜');
  assert.ok(r.msg.includes('3 种'), '提示要说清还差几种：' + r.msg);
  assert.strictEqual(s.bag.tomato.length, 1, '失败不该消耗材料');
  assert.strictEqual(s.bag.carrot.length, 1);
});

t('做菜：任选类凑够了，三种各扣一份', () => {
  const s = G.newState('2026-10-06');
  ['tomato', 'carrot', 'bokchoy'].forEach((k) => { s.bag[k] = [{ at: '2026-10-06' }]; });
  const r = G.cook(s, { recipeId: 'salad', use: ['tomato', 'carrot', 'bokchoy'], texts: GTEXTS });
  assert.ok(r.ok, r.msg);
  assert.ok(!r.state.bag.tomato && !r.state.bag.carrot && !r.state.bag.bokchoy, '三种都被消耗');
  assert.strictEqual(r.state.bag.dish_salad.length, 1);
});

t('做菜：没这道菜的做法时明确拒绝', () => {
  const r = G.cook(G.newState('2026-10-06'), { recipeId: 'nonexistent', texts: GTEXTS });
  assert.strictEqual(r.ok, false);
  assert.ok(r.msg.includes('没有这道菜'), r.msg);
});
t('食谱覆盖：每种食材至少关联到一道菜（含"任意选"类）', () => {
  const used = new Set(), buckets = new Set();
  GTEXTS.recipes.list.forEach((r) => {
    Object.keys(r.need || {}).forEach((k) => used.add(k));
    Object.keys(r.pick || {}).forEach((k) => buckets.add(k));
  });
  const ings = [...Object.keys(GTEXTS.crops), ...Object.keys(GTEXTS.goods).filter((k) => !k.startsWith('_')), 'egg', 'rice', 'flour'];
  const missing = ings.filter((id) => !used.has(id) && !buckets.has(G.itemCat(id, GTEXTS)));
  assert.strictEqual(missing.length, 0, '这些食材没有任何菜用到：' + missing.join('、'));
});

t('食谱：所有配料都能认出类别（否则档次会算错）', () => {
  const bad = new Set();
  GTEXTS.recipes.list.forEach((r) => {
    Object.keys(r.need || {}).forEach((k) => { if (G.itemCat(k, GTEXTS) === '?') bad.add(k); });
  });
  assert.strictEqual(bad.size, 0, '认不出类别的配料：' + [...bad].join('、'));
});

t('食谱：每一道都能算出 1~4 的档次，且没有越界', () => {
  GTEXTS.recipes.list.forEach((r) => {
    const t = G.tierOfRecipe(r, GTEXTS);
    assert.ok(t >= 1 && t <= 4, r.name + ' 的档次算出来是 ' + t + '（应在 1~4）');
  });
});

t('食谱：雪指定的那几道都在，且材料对得上', () => {
  const find = (id) => GTEXTS.recipes.list.find((r) => r.id === id);
  assert.ok(find('mushroom_rib_soup'), '菌菇排骨汤应在');
  assert.deepStrictEqual(find('mushroom_rib_soup').need, { pork: 1 }, '菌菇排骨汤=猪肉 + 任选两种菌菇');
  assert.deepStrictEqual(find('mushroom_rib_soup').pick, { mushroom: 2 });
  assert.deepStrictEqual(find('tofu_fish_soup').need, { tofu: 1, bokchoy: 1, sea_bass: 1 }, '豆腐鱼汤');
  assert.deepStrictEqual(find('tomato_potato_beef').need, { tomato: 1, potato: 1, beef: 1 }, '番茄土豆牛腩');
  assert.deepStrictEqual(find('salmon_sashimi').need, { salmon: 1 }, '三文鱼鱼片');
  assert.deepStrictEqual(find('seafood_cured').need, { lemon: 1, salmon: 1, crab: 1, shrimp: 1 }, '生腌拼盘');
  assert.deepStrictEqual(find('cold_cucumber').need, { cucumber: 1, lemon: 1 }, '凉拌黄瓜');
  assert.deepStrictEqual(find('bamboo_chicken_soup').need, { bamboo_fungus: 1, chicken: 1 }, '竹荪鸡汤');
  assert.ok(!find('mango_shrimp'), '芒果虾仁沙拉应已删掉');
  assert.ok(!find('shrimp_egg'), '虾仁蒸蛋应已删掉');
  assert.ok(!find('cucumber_pepper'), '黄瓜拌青椒应已删掉');
  assert.ok(!find('tofu_pork'), '豆腐烧肉应已改成豆腐鱼汤');
  assert.ok(!find('mixed_rice'), '什锦炒饭应已删掉');
});
t('场地：菜田 4 / 花田 3 / 菌床 3，共 10 块', () => {
  const s = G.newState('2026-10-06');
  assert.strictEqual(s.plots.length, 10);
  assert.strictEqual(G.plotsOf(s, 'field').length, 4);
  assert.strictEqual(G.plotsOf(s, 'flower').length, 3);
  assert.strictEqual(G.plotsOf(s, 'mushroom').length, 3);
});

t('场地校验：花只能种花田、菌菇只能种菌床、菜和水果种菜田', () => {
  assert.strictEqual(G.siteAccepts('flower', 'rose', REAL_CROPS), true);
  assert.strictEqual(G.siteAccepts('flower', 'tomato', REAL_CROPS), false);
  assert.strictEqual(G.siteAccepts('mushroom', 'enoki', REAL_CROPS), true);
  assert.strictEqual(G.siteAccepts('mushroom', 'rose', REAL_CROPS), false);
  assert.strictEqual(G.siteAccepts('field', 'tomato', REAL_CROPS), true);
  assert.strictEqual(G.siteAccepts('field', 'strawberry', REAL_CROPS), true, '水果种菜田');
  assert.strictEqual(G.siteAccepts('field', 'rose', REAL_CROPS), false);
});

t('场地校验：种错地方会被拒，且不消耗种子', () => {
  const s = G.newState('2026-10-06');
  s.bag.seed_tomato = [{ at: 'x' }];
  const r = G.plant(s, { site: 'flower', plot: 1, crop: 'tomato', crops: REAL_CROPS });
  assert.strictEqual(r.ok, false);
  assert.ok(r.msg.includes('花田'), '应说明该种哪：' + r.msg);
  assert.strictEqual(s.bag.seed_tomato.length, 1, '失败不该消耗种子');
  assert.ok(!G.findPlot(r.state, 'flower', 1).crop, '不该种下去');
});

t('场地：查看与浇水互不串场', () => {
  let s = G.newState('2026-10-06');
  s.bag.seed_rose = [{ at: 'x' }];
  s.bag.seed_tomato = [{ at: 'x' }];
  s = G.plant(s, { site: 'flower', plot: 1, crop: 'rose', crops: REAL_CROPS }).state;
  s = G.plant(s, { site: 'field', plot: 1, crop: 'tomato', crops: REAL_CROPS }).state;
  assert.strictEqual(G.viewGarden(s, { site: 'flower', texts: GTEXTS, crops: REAL_CROPS }).length, 3);
  assert.strictEqual(G.viewGarden(s, { site: 'field', texts: GTEXTS, crops: REAL_CROPS }).length, 4);
  const w = G.water(s, { site: 'flower', crops: REAL_CROPS });
  assert.ok(w.ok);
  assert.strictEqual(G.findPlot(w.state, 'flower', 1).wateredToday, 1, '花田浇到了');
  assert.strictEqual(G.findPlot(w.state, 'field', 1).wateredToday, 0, '菜田没被浇到');
});

t('老存档迁移：没有 site 的田归菜田、缺的场地补齐、种着的东西不丢', () => {
  const old = { plots: [{ i: 1, crop: 'tomato', plantedDay: '2026-10-01', wateredToday: 0, pest: 0, weed: 0, dead: false }] };
  const s = G.ensureSites(old);
  assert.strictEqual(s.plots.length, 10, '应补齐到 10 块');
  const keep = s.plots.find((p) => p.crop === 'tomato');
  assert.ok(keep, '种着的番茄不能丢');
  assert.strictEqual(keep.site, 'field', '老田归菜田');
  assert.strictEqual(G.plotsOf(s, 'flower').length, 3, '花田补齐');
  assert.strictEqual(G.plotsOf(s, 'mushroom').length, 3, '菌床补齐');
});

t('田块叫法：菜田叫 1 号田，温室叫 花田 1 号 / 菌床 2 号', () => {
  assert.strictEqual(G.plotLabel('field', 1), '1 号田');
  assert.strictEqual(G.plotLabel('flower', 1), '花田 1 号');
  assert.strictEqual(G.plotLabel('mushroom', 2), '菌床 2 号');
});

t('温室里种的也跟着跨天生长（结算覆盖所有场地）', () => {
  let s = G.newState('2026-10-06');
  s.bag.seed_enoki = [{ at: 'x' }];
  s = G.plant(s, { site: 'mushroom', plot: 1, crop: 'enoki', crops: REAL_CROPS }).state;
  const r = settle(s, '2026-10-08', { rng: NO_LUCK });
  assert.ok(r.advanced, '应推进');
  const p = G.findPlot(r.state, 'mushroom', 1);
  assert.strictEqual(G.progressOf(p, '2026-10-08'), 2, '菌床的菇也该长了 2 天');
});
t('做菜：按名字或 id 都能找到菜谱', () => {
  assert.strictEqual(G.findRecipe('煎蛋', GTEXTS).id, 'fried_egg');
  assert.strictEqual(G.findRecipe('fried_egg', GTEXTS).id, 'fried_egg');
  assert.strictEqual(G.findRecipe('火锅', GTEXTS).id, 'hotpot');
  assert.strictEqual(G.findRecipe('不存在的菜', GTEXTS), null);
});

t('做菜：自动凑料不会把蛋当成蔬菜（沙拉里不该出现鸡蛋）', () => {
  const s = G.newState('2026-10-06');
  s.bag.egg = [{ at: 'x' }, { at: 'x' }];
  s.bag.tomato = [{ at: 'x' }];
  s.bag.carrot = [{ at: 'x' }];
  s.bag.bokchoy = [{ at: 'x' }];
  const picked = G.autoPick(s, GTEXTS.recipes.list.find((r) => r.id === 'salad'), GTEXTS);
  assert.ok(!picked.includes('egg'), '蛋不该被当成蔬菜：' + JSON.stringify(picked));
  assert.strictEqual(picked.length, 3, '应凑出三种蔬菜');
  assert.strictEqual(G.fineCat('egg', GTEXTS), 'egg', '蛋有自己的细分类');
  assert.strictEqual(G.itemCat('egg', GTEXTS), 'veg', '但档次分类仍是 veg（1 分）');
});

t('做菜：菜单列"能做什么"用的是只读检查，不会消耗材料', () => {
  const s = G.newState('2026-10-06');
  s.bag.egg = [{ at: 'x' }];
  const before = s.bag.egg.length;
  const chk = G.checkCook(s, 'fried_egg', GTEXTS);
  assert.strictEqual(chk.ok, true);
  assert.strictEqual(chk.tier, 1);
  assert.strictEqual(s.bag.egg.length, before, '检查不该消耗材料');
  assert.ok(!s.bag.dish_fried_egg, '检查不该出菜');
});
console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
