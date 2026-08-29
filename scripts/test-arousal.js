// 射精值状态机单测（教程验收矩阵核心项）
const assert = require('assert');
const A = require('../arousal-core');

const LEX = {
  touch: [
    { kw: '轻抚', delta: 0.5 },
    { kw: '亲吻', delta: 0.7 },
    { kw: '含住', delta: 0.9 },
    { kw: '磨蹭', delta: 0.6 },
    { kw: '吸吮', delta: 0.95 },
    { kw: '坐下', delta: 0.55 },
    { kw: '对准', delta: 0.5 }
  ],
  body_parts: { '锁骨': { sensitivity: 0.7 }, '后颈': { sensitivity: 0.8 }, '双腿间': { sensitivity: 0.9 }, '入口': { sensitivity: 0.75 } },
  poses: [{ kw: '从后面', multiplier: 1.1 }],
  moans: [{ kw: '嗯', delta: 0.2 }, { kw: '啊', delta: 0.2 }, { kw: '呻吟', delta: 0.25 }],
  desires: [{ kw: '好想要', delta: 0.35 }]
};

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('PASS:', name); }
  catch (e) { failed++; console.log('FAIL:', name, '->', e.message); }
}

// 1. 一条肯定的当前动作能涨
t('肯定动作能涨', () => {
  let s = A.createState(0);
  const r = A.applyUserEvent(s, '我轻轻亲吻你的锁骨', { eventId: 'u1', libido: 0.5, now: 100, lexicon: LEX });
  assert.strictEqual(r.event, 'stimulus');
  assert(s.value > 0, 'value 应 > 0');
});

// 2. 问句/否定/计划/引用/第三人称不涨
t('问句不涨', () => {
  let s = A.createState(0);
  A.applyUserEvent(s, '要不要我亲吻你？', { eventId: 'u2', libido: 0.5, now: 100, lexicon: LEX });
  assert.strictEqual(s.value, 0);
});
t('否定不涨（别碰先于敏感词）', () => {
  let s = A.createState(0);
  A.applyUserEvent(s, '别碰，先别亲吻我', { eventId: 'u3', libido: 0.5, now: 100, lexicon: LEX });
  assert.strictEqual(s.value, 0);
});
t('计划不涨', () => {
  let s = A.createState(0);
  A.applyUserEvent(s, '等会再亲吻你', { eventId: 'u4', libido: 0.5, now: 100, lexicon: LEX });
  assert.strictEqual(s.value, 0);
});
t('第三人称引用不涨', () => {
  let s = A.createState(0);
  A.applyUserEvent(s, '说明书里写着亲吻，这是示例', { eventId: 'u5', libido: 0.5, now: 100, lexicon: LEX });
  assert.strictEqual(s.value, 0);
});
t('回忆转述不涨', () => {
  let s = A.createState(0);
  A.applyUserEvent(s, '刚才我们亲吻了', { eventId: 'u6', libido: 0.5, now: 100, lexicon: LEX });
  assert.strictEqual(s.value, 0);
});

// 3. 同一 event_id 重放返回 duplicate 且状态不变
t('重放幂等', () => {
  let s = A.createState(0);
  const r1 = A.applyUserEvent(s, '我亲吻你', { eventId: 'dup1', libido: 0.5, now: 100, lexicon: LEX });
  const v1 = s.value;
  const r2 = A.applyUserEvent(s, '我亲吻你', { eventId: 'dup1', libido: 0.5, now: 200, lexicon: LEX });
  assert.strictEqual(r2.event, 'duplicate');
  assert.strictEqual(s.value, v1, '重放后 value 不变');
});

// 4. 不完整 final 不结算
t('incomplete 不结算', () => {
  let s = A.createState(0);
  const r = A.applyAssistantEvent(s, '我忍不住了，要射了', { eventId: 'a1', complete: false, now: 100, lexicon: LEX });
  assert.strictEqual(r.event, 'incomplete');
  assert.strictEqual(s.value, 0);
});

// 5. AI final 重放不重复释放
t('AI final 重放不重复', () => {
  let s = A.createState(0);
  // 先充能
  A.applyUserEvent(s, '我亲吻你', { eventId: 'c1', libido: 1, now: 100, lexicon: LEX });
  A.applyUserEvent(s, '我含住你', { eventId: 'c2', libido: 1, now: 150, lexicon: LEX });
  A.applyUserEvent(s, '我含住你', { eventId: 'c3', libido: 1, now: 200, lexicon: LEX });
  A.applyUserEvent(s, '我含住你', { eventId: 'c4', libido: 1, now: 250, lexicon: LEX });
  A.applyUserEvent(s, '我含住你', { eventId: 'c5', libido: 1, now: 300, lexicon: LEX });
  const r1 = A.applyAssistantEvent(s, '我忍不住了，要射了', { eventId: 'aF', complete: true, now: 400, lexicon: LEX, releaseIntent: true });
  assert.strictEqual(r1.event, 'climax');
  const c = s.last_climax_quality;
  const r2 = A.applyAssistantEvent(s, '我忍不住了，要射了', { eventId: 'aF', complete: true, now: 500, lexicon: LEX, releaseIntent: true });
  assert.strictEqual(r2.event, 'duplicate');
  assert.strictEqual(s.last_climax_quality, c, '重放后质量不变');
});

// 6. 持续接触只能到被动上限 0.72，不能靠时间穿 EDGE
t('被动上限 0.72', () => {
  let s = A.createState(0);
  A.applyUserEvent(s, '我亲吻你', { eventId: 'p1', libido: 1, now: 100, lexicon: LEX });
  for (let i = 0; i < 300; i++) {
    A.applyUserEvent(s, '我就这样抱着你', { eventId: 'p2_' + i, libido: 1, now: 100 + i * 1000, lexicon: LEX });
  }
  assert(s.value <= 0.72 + 1e-9, '被动不能超过 0.72，实际 ' + s.value);
});

// 7. lock 下不释放；release_once 只放一次；unlock 行为明确
t('lock 阻止释放', () => {
  let s = A.createState(0);
  A.applyUserEvent(s, '我亲吻你', { eventId: 'l1', libido: 1, now: 100, lexicon: LEX });
  A.lockGate(s);
  s.value = 0.97; // 越过 PONR
  const r = A.applyUserEvent(s, '我含住你', { eventId: 'l2', libido: 1, now: 200, lexicon: LEX });
  assert.notStrictEqual(r.event, 'climax', 'lock 下不能自动结算');
  A.unlockGate(s);
  A.applyUserEvent(s, '我含住你', { eventId: 'l3', libido: 1, now: 300, lexicon: LEX });
  // 解锁后越过 PONR 应结算
  s.value = 0.97;
  const r2 = A.applyUserEvent(s, '我含住你', { eventId: 'l4', libido: 1, now: 400, lexicon: LEX });
  assert.strictEqual(r2.event, 'climax');
});

// 8. 恢复期重复调用不延长（通过时间流逝自然恢复）
t('恢复期不因重复调用延长', () => {
  let s = A.createState(0);
  A.applyUserEvent(s, '我含住你', { eventId: 'r1', libido: 1, now: 100, lexicon: LEX });
  s.value = 0.97;
  const r = A.applyUserEvent(s, '我含住你', { eventId: 'r2', libido: 1, now: 200, lexicon: LEX });
  assert.strictEqual(r.event, 'climax');
  const until1 = s.refractory_until;
  A.applyUserEvent(s, '我含住你', { eventId: 'r3', libido: 1, now: 250, lexicon: LEX });
  assert.strictEqual(s.refractory_until, until1, '恢复期不被延长');
});

// 9. 空储量仍能高潮但 output 较低
t('空储量能高潮但输出低', () => {
  let s = A.createState(0);
  s.reserve = 0.05; s.reserve_at = 0;
  A.applyUserEvent(s, '我含住你', { eventId: 'e1', libido: 1, now: 100, lexicon: LEX });
  s.value = 0.97;
  const r = A.applyUserEvent(s, '我含住你', { eventId: 'e2', libido: 1, now: 200, lexicon: LEX });
  assert.strictEqual(r.event, 'climax');
  assert(r.output < 0.4, '低储量输出低，实际 ' + r.output);
});

// 10. 时钟回拨 fail-closed
t('时钟回拨 fail-closed', () => {
  let s = A.createState(1000);
  const r = A.applyUserEvent(s, '我亲吻你', { eventId: 'cb1', libido: 0.5, now: 500, lexicon: LEX });
  assert.strictEqual(r.event, 'clock_reversal');
  assert.strictEqual(s.value, 0);
});

// 11. 九字段白名单快照
t('publicSnapshot 恰好九字段', () => {
  let s = A.createState(0);
  const snap = A.publicSnapshot(s, 0);
  const keys = Object.keys(snap);
  assert.strictEqual(keys.length, 9, '应有 9 字段，实际 ' + keys.length + ': ' + keys.join(','));
  assert(!('processed_event_ids' in snap) && !('value' in snap), '不暴露账本和原始值');
});

// 12. 状态注入只给定性文本
t('statusLine 定性不暴露数字', () => {
  let s = A.createState(0);
  s.value = 0.5;
  const line = A.statusLine(s, 0);
  assert(line.includes('充能') && !/\d/.test(line), '应定性描述无数字：' + line);
});

// 13. 次强动作 ×30% 加成（不同动作词）
t('次强动作加成', () => {
  const r1 = A.parseStimulus('我轻抚你的锁骨', LEX);
  const r2 = A.parseStimulus('我轻抚并吸吮你的锁骨', LEX);
  assert(r1.valid && r2.valid, JSON.stringify(r1) + ' / ' + JSON.stringify(r2));
  assert(r2.stim > r1.stim, '叠加次强应更高：' + r2.stim + ' > ' + r1.stim);
  assert.strictEqual(r2.action, '吸吮', '最强应为吸吮');
  assert.strictEqual(r2.second, '轻抚', '次强应为轻抚');
});

// 14. 同一动作重复不叠加
t('同一动作重复不叠加', () => {
  const r1 = A.parseStimulus('吸吮吸吮吸吮吸吮', LEX);
  assert(Math.abs(r1.stim - 0.95) < 1e-9, '重复吸吮应等于单次 0.95，实际 ' + r1.stim);
});

// 15. 隐晦部位别名命中
t('隐晦部位命中', () => {
  const r = A.parseStimulus('我轻轻磨蹭着你双腿间', LEX);
  assert(r.valid && r.part === '双腿间', '双腿间应命中：' + JSON.stringify(r));
});

// 16. 叫声/欲望 → 弱刺激
t('叫声弱刺激', () => {
  const r = A.parseStimulus('嗯…啊…好想要', LEX);
  assert(r.valid && r.weak && r.stim > 0, '叫声应产生弱刺激：' + JSON.stringify(r));
});

// 17. 雪的主动动作命中
t('主动动作命中', () => {
  const r = A.parseStimulus('我用手扶着他，对准入口，轻轻坐下', LEX);
  assert(r.valid, '坐下/对准应命中：' + JSON.stringify(r));
  assert(r.part === '入口', '入口别名应命中：' + JSON.stringify(r));
});

console.log('\n=== 结果: ' + passed + ' 通过 / ' + failed + ' 失败 ===');
process.exit(failed ? 1 : 0);
