// ============================================================
// 后花园状态机核心（纯函数，无 IO——不读网络、不碰文件、不调 LLM）
// 与 arousal-core.js 同套路：确定性 + 可单测。
// 确定性：相同 state + 相同 day + 相同 rng 序列 → 相同输出。
//
// 时间模型（雪 10/4 定）：按【自然日】结算，不设定时任务。
//   每次唤醒时用「当前自然日 − 上次结算日」推进天数；一天可能唤醒多次，只有跨天那天推进。
// 文案不写死在这里：全部走 garden-text.json（getGardenText()），传进来即可。
// ============================================================

const DEFAULT_PLOTS = 4;
const INIT_COINS = 30;
const INIT_SEEDS = { daisy: 2, bokchoy: 2, carrot: 1 };

function newState(day) {
  return {
    schema: 1,
    coins: INIT_COINS,
    day: day || null,          // 上次结算的自然日（YYYY-MM-DD，北京时间）
    plots: Array.from({ length: DEFAULT_PLOTS }, (_, k) => ({
      i: k + 1, crop: null, plantedDay: null, wateredToday: 0, pest: 0, weed: 0, dead: false
    })),
    // 初始种子：INIT_SEEDS 原来只定义了常量却没塞进背包（雪 10/4 在真实唤醒日志里抓到）
    bag: Object.keys(INIT_SEEDS).reduce((acc, k) => {
      acc['seed_' + k] = Array.from({ length: INIT_SEEDS[k] }, () => ({ at: day || null }));
      return acc;
    }, {}),
    fridge: {},
    chickens: [],
    coop: { eggs: 0 },          // 鸡窝：蛋先落这儿，要默走过去捡才进背包（雪 10/4）
    orders: [],                // 无人机订单：{ item, n, placedDay, deliverDay }
    todayFlags: { firstWakeDone: false, eggChecked: false }
  };
}

const clampInt = (x, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(x) || 0)));

// ---------- 生长：进度 → 阶段文案 ----------
// 规则（雪 10/4 定）：第 0 天=第1段，成熟日=最后一段，中间按比例映射。
// 所以 3 段 / 4 段都能自动兼容，写文案的人不用管代码。
function stageIndex(days, totalDays) {
  const d = clampInt(days, 0, totalDays);
  const n = totalDays >= 3 ? 4 : 3; // 中间只有 1 天 → 跳过"花苞/结果"段
  if (d <= 0) return 0;
  if (d >= totalDays) return n - 1;
  // 中间天映射到 1..n-2
  const span = totalDays - 1;
  const pos = Math.ceil((d / span) * (n - 2));
  return Math.max(1, Math.min(n - 2, pos));
}

function progressOf(plot, day) {
  if (!plot || !plot.crop || !plot.plantedDay) return 0;
  const t0 = Date.parse(plot.plantedDay + 'T00:00:00Z');
  const t1 = Date.parse(day + 'T00:00:00Z');
  if (!isFinite(t0) || !isFinite(t1)) return 0;
  return Math.max(0, Math.round((t1 - t0) / 86400000));
}

// 浇水是否达标：需要 water_per_day 次；下雨天算已浇满
function waterSatisfied(plot, texts, crop, raining) {
  if (raining) return true;
  if (!crop) return false;
  return (plot.wateredToday || 0) >= (crop.water_per_day || 1);
}

// ---------- 跨天结算（每次唤醒调用；只有跨天那天真正推进） ----------
// rng: () => [0,1)，传进来便于单测；raining: 当天实况是否有雨（下雨自动算浇水）
function settle(state, day, { rng = Math.random, raining = false, crops = {}, events = {}, pestRate = 0.10, weedRate = 0.10 } = {}) {
  const s = JSON.parse(JSON.stringify(state)); // 纯函数：不改传入的 state
  if (s.day === day) return { state: s, advanced: false, log: [] };
  const log = [];
  s.day = day;

  // 1. 先清掉"当天"标记，新的一天从零开始
  s.todayFlags = { firstWakeDone: false, eggChecked: false };
  for (const p of s.plots) p.wateredToday = 0;

  // 2. 每块田：判定昨天是否浇够 → 生长 / 顺延 / 枯萎；再掷今天的意外事件
  for (const p of s.plots) {
    if (!p.crop || p.dead) continue;
    const crop = crops[p.crop] || {};
    const total = Number(crop.days || 2);
    const before = progressOf(p, s.day); // 结算当天已推进后的"种植天数"

    // 昨天留下的虫没被除掉 → 连续天数 +1；连续 2 天没除 → 枯萎（雪 10/4 定）
    // ⚠️ 顺序很重要：必须先累加再判断，且不能提前把 pest 清零，否则计数永远到不了 2
    //（单测 scripts/test-garden.js 抓到过这个 bug）
    if (p.pest) p.pestDays = (p.pestDays || 0) + 1; else p.pestDays = 0;
    if (p.pestDays >= 2) {
      p.dead = true;
      log.push({ type: 'dead', plot: p.i, crop: p.crop, reason: 'pest' });
      continue;
    }

    // 意外事件（每块田独立掷）；昨天的旗标到此才清
    // 雪 10/4：没发芽就不会生虫/长草——只在"已发芽"（阶段≥2）之后才掷
    p.pest = 0; p.weed = 0;
    const sprouted = stageIndex(before, total) >= 1;
    if (before < total && sprouted) {
      if (rng() < pestRate) { p.pest = 1; log.push({ type: 'pest', plot: p.i, crop: p.crop }); }
      if (rng() < weedRate) { p.weed = 1; log.push({ type: 'weed', plot: p.i, crop: p.crop }); }
    }

    // 成熟
    if (before >= total) log.push({ type: 'ready', plot: p.i, crop: p.crop });
  }

  // 3. 无人机到货（下单后的下一次唤醒到货——雪 10/4 定）
  const arrived = [];
  s.orders = s.orders.filter((o) => {
    if (o.deliverDay && o.deliverDay <= day) { arrived.push(o); return false; }
    return true;
  });
  for (const o of arrived) {
    addItem(s.bag, o.item, o.n, day);
    log.push({ type: 'delivery', item: o.item, n: o.n });
  }

  // 4. 小鸡：第一次唤醒每只 30% 生蛋；前一天喂过 → 35~40%
  const eggs = [];
  for (const c of s.chickens) {
    // ⚠️ 跨天必须先清 fedYesterday，且不能被下面的 continue 跳过——
    // 否则小鸡崽的"今天喂过"永远清不掉，第二天喂不动，就永远长不大（单测抓到的双重死锁）
    const wasFed = !!c.fedYesterday;
    c.fedYesterday = false;
    if (!c.grown) continue;
    const p = wasFed ? 0.35 + rng() * 0.05 : 0.30;
    if (rng() < p) { eggs.push(c); }
  }
  if (eggs.length) {
    s.coop = s.coop || { eggs: 0 };
    s.coop.eggs = (s.coop.eggs || 0) + eggs.length;   // 落在鸡窝，等默来捡（雪 10/4）
    log.push({ type: 'eggs', n: eggs.length });
  }

  return { state: s, advanced: true, log, arrived: arrived.length, eggs: eggs.length };
}

function addItem(store, item, n, day) {
  if (!store[item]) store[item] = [];
  for (let k = 0; k < (n || 1); k++) store[item].push({ at: day });
}

// 背包/冰箱清理：按保质期天数判断过期（用自然日差，不用小时）
function purgeExpired(store, day, shelfDays) {
  const removed = [];
  for (const item of Object.keys(store)) {
    const keep = [];
    for (const entry of store[item]) {
      const d0 = Date.parse((entry.at || day) + 'T00:00:00Z');
      const d1 = Date.parse(day + 'T00:00:00Z');
      const age = isFinite(d0) ? Math.round((d1 - d0) / 86400000) : 0;
      const limit = Number(shelfDays[item] ?? 3);
      if (age > limit) removed.push(item); else keep.push(entry);
    }
    if (keep.length) store[item] = keep; else delete store[item];
  }
  return removed;
}

// ---------- 操作（返回 { state, ok, msg } ；体力消耗由 server 层扣） ----------
function water(state, { all = true, plot = null, raining = false, crops = {} } = {}) {
  const s = JSON.parse(JSON.stringify(state));
  if (raining) return { state: s, ok: false, msg: '下雨天不用浇水' };
  let n = 0;
  for (const p of s.plots) {
    if (!p.crop || p.dead) continue;
    if (!all && p.i !== plot) continue;
    const need = Number((crops[p.crop] || {}).water_per_day || 1);
    if ((p.wateredToday || 0) < need) { p.wateredToday = (p.wateredToday || 0) + 1; n++; }
  }
  return { state: s, ok: n > 0, msg: n > 0 ? `浇了 ${n} 块田` : '没有需要浇水的田' };
}

function plant(state, { plot, crop, crops = {}, seedItem = null } = {}) {
  const s = JSON.parse(JSON.stringify(state));
  const p = s.plots.find((x) => x.i === plot);
  if (!p) return { state: s, ok: false, msg: '没有这块田' };
  if (p.crop && !p.dead) return { state: s, ok: false, msg: '这块田已经种着东西了' };
  if (!crops[crop]) return { state: s, ok: false, msg: '没有这种种子' };
  const item = seedItem || ('seed_' + crop);
  if (!s.bag[item] || !s.bag[item].length) return { state: s, ok: false, msg: '背包里没有这种种子' };
  s.bag[item].pop();
  if (!s.bag[item].length) delete s.bag[item];
  p.crop = crop; p.plantedDay = s.day; p.wateredToday = 0; p.pest = 0; p.weed = 0; p.dead = false;
  return { state: s, ok: true, msg: `在 ${plot} 号田种下了${crops[crop].name}` };
}

function harvest(state, { plot, crops = {} } = {}) {
  const s = JSON.parse(JSON.stringify(state));
  const p = s.plots.find((x) => x.i === plot);
  if (!p || !p.crop) return { state: s, ok: false, msg: '这块田是空的' };
  if (p.dead) { p.crop = null; p.dead = false; return { state: s, ok: true, msg: '清理了枯萎的苗' }; }
  const crop = crops[p.crop] || {};
  const total = Number(crop.days || 2);
  if (progressOf(p, s.day) < total) return { state: s, ok: false, msg: '还没成熟' };
  addItem(s.bag, p.crop, 1, s.day);
  const name = crop.name || p.crop;
  p.crop = null; p.plantedDay = null; p.wateredToday = 0; p.pest = 0; p.weed = 0; p.dead = false;
  return { state: s, ok: true, msg: `收下了${name}` };
}

// 除虫 / 拔草（各 -1 体力，由 server 层扣）
function clearHazard(state, { plot, kind } = {}) {
  const s = JSON.parse(JSON.stringify(state));
  const p = s.plots.find((x) => x.i === plot);
  if (!p) return { state: s, ok: false, msg: '没有这块田' };
  if (kind === 'pest') {
    if (!p.pest) return { state: s, ok: false, msg: '这块田没有虫' };
    p.pest = 0;
    return { state: s, ok: true, msg: `${plot} 号田的虫除掉了` };
  }
  if (!p.weed) return { state: s, ok: false, msg: '这块田没有杂草' };
  p.weed = 0;
  return { state: s, ok: true, msg: `${plot} 号田的草拔掉了` };
}

// ---------- 查看：三维度 ----------
// 维度1 生长阶段 / 维度2 浇水状态（下雨天特殊）/ 维度3 意外事件
function viewPlot(state, plot, { texts = {}, crops = {}, raining = false } = {}) {
  const p = state.plots.find((x) => x.i === plot);
  if (!p) return null;
  const label = `${plot} 号田`;
  if (!p.crop) return { plot, lines: [`${label}：空着，土是松的`], empty: true };
  const crop = crops[p.crop] || {};
  const ev = texts.events || {};
  const cname = crop.name || p.crop;

  if (p.dead) return { plot, lines: [`${label}：${cname}的苗枯了，蔫在土里`, ev.bug ? ev.bug.replace('{n}', plot).replace('{c}', cname) : '该清理了'], dead: true };

  const total = Number(crop.days || 2);
  const days = progressOf(p, state.day);
  const idx = stageIndex(days, total);
  const stages = crop.stages || [];
  const grow = stages[Math.min(idx, stages.length - 1)] || '';

  let water;
  if (raining) water = (texts.water_state || {}).rain || '土是湿的，今天不用浇';
  else {
    const need = Number(crop.water_per_day || 1);
    const got = p.wateredToday || 0;
    const ws = texts.water_state || {};
    water = got <= 0 ? (ws.dry || '还没浇水') : (got >= need ? (ws.done || '水够了') : (ws.half || '浇过一次'));
  }

  const lines = [`${label}：${grow}`];
  if (p.pest) lines.push((ev.bug || '{n}号田的{c}上生了虫').replace('{n}', plot).replace('{c}', cname));
  if (p.weed) lines.push((ev.weed || '{n}号田里冒出几根杂草').replace('{n}', plot).replace('{c}', cname));
  return { plot, crop: p.crop, name: cname, days, total, stage: idx, ready: days >= total, grow, water, lines };
}

function viewGarden(state, { texts = {}, crops = {}, raining = false } = {}) {
  return state.plots.map((p) => viewPlot(state, p.i, { texts, crops, raining }));
}

// ---------- 鸡棚（后花园） ----------
const CHICK_PRICE = 200;
const CHICK_MAX = 3;
const CHICK_GROW_FEEDS = 3;   // 喂满 3 次长大（雪 10/4 定）

function buyChick(state, { price = CHICK_PRICE, name = '' } = {}) {
  const s = JSON.parse(JSON.stringify(state));
  if ((s.chickens || []).length >= CHICK_MAX) return { state: s, ok: false, msg: `鸡棚最多养 ${CHICK_MAX} 只` };
  if ((s.coins || 0) < price) return { state: s, ok: false, msg: `金币不够（要 ${price}，现在 ${s.coins || 0}）` };
  s.coins = (s.coins || 0) - price;
  s.chickens = s.chickens || [];
  s.chickens.push({ name: String(name || '').trim().slice(0, 8), grown: false, fedDays: 0, fedYesterday: false });
  return { state: s, ok: true, msg: `买回一只小鸡崽（-${price}💰）` };
}

function feedChickens(state) {
  const s = JSON.parse(JSON.stringify(state));
  const list = s.chickens || [];
  if (!list.length) return { state: s, ok: false, msg: '鸡棚里还没有小鸡' };
  let fed = 0, grew = 0;
  for (const c of list) {
    if (c.fedYesterday) continue;              // 一天只喂一次
    c.fedYesterday = true;
    if (!c.grown) {
      c.fedDays = (c.fedDays || 0) + 1;
      if (c.fedDays >= CHICK_GROW_FEEDS) { c.grown = true; grew++; }
    }
    fed++;
  }
  if (!fed) return { state: s, ok: false, msg: '今天已经喂过了' };
  return { state: s, ok: true, msg: `喂了 ${fed} 只${grew ? `，其中 ${grew} 只长大了` : ''}`, grew };
}

function nameChick(state, { index = 0, name = '' } = {}) {
  const s = JSON.parse(JSON.stringify(state));
  const list = s.chickens || [];
  const i = Number(index) - 1;                 // 默说"第 1 只"
  if (!list[i]) return { state: s, ok: false, msg: '没有这只小鸡' };
  const clean = String(name || '').trim().slice(0, 8);
  if (!clean) return { state: s, ok: false, msg: '得起个名字' };
  list[i].name = clean;
  return { state: s, ok: true, msg: `第 ${i + 1} 只小鸡叫「${clean}」了` };
}

function collectEggs(state) {
  const s = JSON.parse(JSON.stringify(state));
  const n = (s.coop && s.coop.eggs) || 0;
  if (!n) return { state: s, ok: false, msg: '鸡窝里现在没有蛋' };
  addItem(s.bag, 'egg', n, s.day);
  s.coop.eggs = 0;
  return { state: s, ok: true, msg: `捡了 ${n} 颗蛋，放进背包`, n };
}

function viewCoop(state) {
  const lines = [];
  const list = state.chickens || [];
  const eggs = (state.coop && state.coop.eggs) || 0;
  if (!list.length) lines.push('鸡棚是空的，干草铺得很平，还没有谁住进来');
  list.forEach((c, i) => {
    const nm = c.name ? `${c.name}（第 ${i + 1} 只）` : `第 ${i + 1} 只`;
    const stage = c.grown
      ? '已经长成大鸡了，冠子红红的'
      : `还是只毛茸茸的小鸡崽（喂过 ${c.fedDays || 0}/${CHICK_GROW_FEEDS} 天）`;
    lines.push(`${nm}：${stage}${c.fedYesterday ? '，今天喂过了' : '，今天还没喂'}`);
  });
  if (eggs > 0) lines.push(`鸡窝里躺着 ${eggs} 颗蛋，还热着`);
  return { lines, eggs, count: list.length };
}

// ---------- 商店（电脑网购 → 无人机配送）----------
// 雪 10/4：商店入口在书桌的电脑上（像网购）；下单后**下一次唤醒**无人机就到货。
// 商店里除种子以外的商品（含建材——猫窝要默自己买木头钉子来搭，雪 10/4 定）
const SHOP_FOOD = {
  rice: { name: '大米', price: 5 },
  flour: { name: '面粉', price: 5 },
  wood: { name: '木板', price: 12 },
  nail: { name: '钉子', price: 3 }
};

// 能搭的东西（图纸）——材料齐了才能搭
const BUILD_RECIPES = {
  cat_house: { name: '猫窝', need: { wood: 4, nail: 8 } },
  dog_house: { name: '狗屋', need: { wood: 5, nail: 10 } },
};

function shopList(crops) {
  const list = [];
  for (const k of Object.keys(crops || {})) {
    list.push({ id: 'seed_' + k, name: `${crops[k].name}种子`, price: Number(crops[k].seed_price || 10), kind: 'seed' });
  }
  list.push({ id: 'chick', name: '小鸡崽', price: CHICK_PRICE, kind: 'chick' });
  for (const k of Object.keys(SHOP_FOOD)) list.push({ id: k, name: SHOP_FOOD[k].name, price: SHOP_FOOD[k].price, kind: 'food' });
  return list;
}

function order(state, { item = '', n = 1, crops = {} } = {}) {
  const s = JSON.parse(JSON.stringify(state));
  const qty = Math.max(1, Math.min(9, Number(n) || 1));
  const found = shopList(crops).find((x) => x.id === item);
  if (!found) return { state: s, ok: false, msg: `没有「${item}」这件商品` };
  if (found.kind === 'chick' && (s.chickens || []).length + qty > CHICK_MAX) {
    return { state: s, ok: false, msg: `鸡棚最多养 ${CHICK_MAX} 只，放不下了` };
  }
  const total = found.price * qty;
  if ((s.coins || 0) < total) return { state: s, ok: false, msg: `金币不够（要 ${total}，现在 ${s.coins || 0}）` };
  s.coins -= total;
  s.orders = s.orders || [];
  s.orders.push({ item, n: qty, name: found.name, kind: found.kind, placedDay: s.day, placedSeq: s.wakeSeq || 0 });
  return { state: s, ok: true, msg: `下单：${found.name} ×${qty}（-${total}💰），等无人机送来`, total };
}

// 无人机到货：下单后的"下一次唤醒"就到（雪 10/4 定），不用等跨天
function tickWake(state) {
  const s = JSON.parse(JSON.stringify(state));
  s.wakeSeq = (s.wakeSeq || 0) + 1;
  const arrived = [];
  s.orders = (s.orders || []).filter((o) => {
    if (Number(o.placedSeq || 0) < s.wakeSeq) { arrived.push(o); return false; }
    return true;
  });
  for (const o of arrived) {
    if (o.kind === 'chick') {
      s.chickens = s.chickens || [];
      for (let i = 0; i < o.n; i++) s.chickens.push({ name: '', grown: false, fedDays: 0, fedYesterday: false });
    } else {
      addItem(s.bag, o.item, o.n, s.day);
    }
  }
  return { state: s, arrived, n: arrived.length };
}

// 喷泉许愿：投一枚金币许一个愿（金币的一个出口）。许愿内容由 server 层带进行动日志（雪 10/4 定）。
function wish(state, { text = '', day = null } = {}) {
  const s = JSON.parse(JSON.stringify(state));
  const clean = String(text || '').trim().slice(0, 200);
  if (!clean) return { state: s, ok: false, msg: '想许什么愿？说出来才作数' };
  if ((s.coins || 0) < 1) return { state: s, ok: false, msg: '一枚金币也没有了，许不了愿' };
  s.coins -= 1;
  s.fountain = s.fountain || { wishes: [] };
  s.fountain.wishes = s.fountain.wishes || [];
  s.fountain.wishes.push({ at: day || s.day || null, text: clean });
  return { state: s, ok: true, msg: `你把一枚金币投进池子，它在水底打了个转才停住。你许的愿是：${clean}`, count: s.fountain.wishes.length };
}

// 搭建：消耗背包里的材料把东西做出来（雪 10/4：猫窝不该一开始就有，要默自己买料搭）
const MATERIAL_NAMES = { wood: '木板', nail: '钉子' };

function build(state, { key = 'cat_house', day = null } = {}) {
  const s = JSON.parse(JSON.stringify(state));
  const rec = BUILD_RECIPES[key];
  if (!rec) return { state: s, ok: false, msg: '没有这东西的图纸' };
  if (s.built && s.built[key]) return { state: s, ok: false, msg: `${rec.name}已经搭好了` };
  const lack = [];
  for (const it of Object.keys(rec.need)) {
    const have = (s.bag[it] || []).length;
    if (have < rec.need[it]) lack.push(`${MATERIAL_NAMES[it] || it} 要 ${rec.need[it]} 份、现在只有 ${have}`);
  }
  if (lack.length) return { state: s, ok: false, msg: '材料还不够——' + lack.join('；') };
  for (const it of Object.keys(rec.need)) {
    s.bag[it] = s.bag[it].slice(rec.need[it]);
    if (!s.bag[it].length) delete s.bag[it];
  }
  s.built = s.built || {};
  s.built[key] = { at: day || s.day || null };
  return { state: s, ok: true, msg: `材料齐了。你锯、钉、磨，把${rec.name}搭了起来` };
}

// 秋千：每次唤醒只能荡一次（雪 10/4）——用 wakeSeq 判定这是不是"同一次唤醒"
function canSwing(state) {
  const s = state || {};
  return (s.swingSeq || 0) !== (s.wakeSeq || 0);
}
function markSwung(state) {
  const s = JSON.parse(JSON.stringify(state));
  s.swingSeq = s.wakeSeq || 0;
  return s;
}

// 一次买多样（雪 10/4：下单 -1 体力，但一次可以买两三种，不用重复操作）
function orderMany(state, list, { crops = {} } = {}) {
  const s = JSON.parse(JSON.stringify(state));
  const shop = shopList(crops);
  const pending = [];
  const names = [];
  let total = 0;
  for (const raw of (Array.isArray(list) ? list : [])) {
    const found = shop.find((x) => x.id === raw.item);
    if (!found) return { state: s, ok: false, msg: `没有「${raw.item}」这件商品` };
    const qty = Math.max(1, Math.min(99, Number(raw.n) || 1));
    if (found.kind === 'chick' && (s.chickens || []).length + qty > CHICK_MAX) {
      return { state: s, ok: false, msg: `鸡棚最多养 ${CHICK_MAX} 只，放不下了` };
    }
    total += found.price * qty;
    pending.push({ item: raw.item, n: qty, name: found.name, kind: found.kind });
    names.push(`${found.name}×${qty}`);
  }
  if (!pending.length) return { state: s, ok: false, msg: '要买什么？把商品名说清楚' };
  if ((s.coins || 0) < total) {
    return { state: s, ok: false, msg: `金币不够：一共要 ${total}，现在只有 ${s.coins || 0}` };
  }
  s.coins -= total;
  s.orders = s.orders || [];
  for (const p of pending) s.orders.push({ item: p.item, n: p.n, name: p.name, kind: p.kind, placedDay: s.day, placedSeq: s.wakeSeq || 0 });
  return { state: s, ok: true, msg: `下单：${names.join('、')}（-${total}💰），等无人机送来`, total, count: pending.length };
}

module.exports = {
  DEFAULT_PLOTS, INIT_COINS, INIT_SEEDS,
  newState, stageIndex, progressOf, waterSatisfied, settle,
  addItem, purgeExpired, water, plant, harvest, clearHazard,
  CHICK_PRICE, CHICK_MAX, CHICK_GROW_FEEDS,
  buyChick, feedChickens, nameChick, collectEggs, viewCoop,
  shopList, order, tickWake, wish,
  BUILD_RECIPES, MATERIAL_NAMES, build, canSwing, markSwung, orderMany,
  viewPlot, viewGarden
};