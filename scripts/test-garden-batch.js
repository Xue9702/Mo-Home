// 验证新加的批量行为：harvest all / clearHazard all / 未成熟提示
const gc = require('../garden-core.js');
const texts = require('../garden-text.json');
const crops = texts.crops;
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('PASS:', name); } else { fail++; console.log('FAIL:', name, extra || ''); } }

// 造一个场地：field 1 熟的、2 没熟、3 有草、4 有虫
const DAY = '2026-10-18';
let st = gc.newState(DAY);
const findP = (s, site, i) => s.plots.find(p => (p.site || 'field') === site && p.i === i);
findP(st, 'field', 1).crop = 'bokchoy';
findP(st, 'field', 1).plantedDay = '2026-10-10';  // 早就熟了
findP(st, 'field', 2).crop = 'carrot';
findP(st, 'field', 2).plantedDay = DAY;            // 刚种，不熟
findP(st, 'field', 4).pest = 2;
findP(st, 'field', 3).weed = 1;

// 1) harvest 全部：应只收 1 号
const h = gc.harvest(st, { site: 'field', crops, all: true });
ok('harvest all 成功（收到 1 号小白菜）', h.ok && /小白菜/.test(h.msg), h.msg);
ok('harvest all 后 1 号变空', !findP(h.state, 'field', 1).crop);
ok('harvest all 不影响未熟的 2 号', findP(h.state, 'field', 2).crop === 'carrot');

// 2) harvest 无可收时给清楚提示
const h2 = gc.harvest(h.state, { site: 'field', crops, all: true });
ok('harvest all 未熟时提示「都还没成熟」', !h2.ok && /还没成熟/.test(h2.msg), h2.msg);

// 3) 空场地提示
const emptySt = gc.newState(DAY);
const h3 = gc.harvest(emptySt, { site: 'field', crops, all: true });
ok('harvest all 空场地提示「空着」', !h3.ok && /空着/.test(h3.msg), h3.msg);

// 4) pest all：清 4 号虫
const p = gc.clearHazard(st, { site: 'field', kind: 'pest', all: true });
ok('pest all 成功', p.ok && /4 号田/.test(p.msg), p.msg);
ok('pest all 后 4 号没虫', findP(p.state, 'field', 4).pest === 0);

// 5) weed all：清 3 号草
const w = gc.clearHazard(st, { site: 'field', kind: 'weed', all: true });
ok('weed all 成功', w.ok && /3 号田/.test(w.msg), w.msg);

// 6) 指定田号仍按单块处理
const p2 = gc.clearHazard(st, { site: 'field', kind: 'pest', plot: 4 });
ok('指定 plot 仍单块生效', p2.ok && /4 号田/.test(p2.msg), p2.msg);
const p3 = gc.clearHazard(st, { site: 'field', kind: 'pest', plot: 1 });
ok('指定无虫的田提示没虫', !p3.ok && /没有虫/.test(p3.msg), p3.msg);

// 7) 花田批量收（3 畦）
let st2 = gc.newState(DAY);
findP(st2, 'flower', 1).crop = 'daisy'; findP(st2, 'flower', 1).plantedDay = '2026-10-01';
findP(st2, 'flower', 2).crop = 'tulip'; findP(st2, 'flower', 2).plantedDay = '2026-10-01';
const hf = gc.harvest(st2, { site: 'flower', crops, all: true });
ok('花田批量收两样', hf.ok && /雏菊/.test(hf.msg) && /郁金香/.test(hf.msg), hf.msg);

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
