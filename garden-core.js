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
    bag: {},                   // 背包：{ item: [{ at: 'ISO' }] } 按"获得时间"逐个记，保质期用时间差算
    fridge: {},
    chickens: [],
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
    p.pest = 0; p.weed = 0;
    if (before < total) {
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
    if (!c.grown) continue;
    const p = c.fedYesterday ? 0.35 + rng() * 0.05 : 0.30;
    if (rng() < p) { eggs.push(c); }
    c.fedYesterday = false;
  }
  if (eggs.length) {
    addItem(s.bag, 'egg', eggs.length, day);
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

module.exports = {
  DEFAULT_PLOTS, INIT_COINS, INIT_SEEDS,
  newState, stageIndex, progressOf, waterSatisfied, settle,
  addItem, purgeExpired, water, plant, harvest, clearHazard,
  viewPlot, viewGarden
};
