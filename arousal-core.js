// ============================================================
// 射精值状态机核心（纯函数，无 IO——不读网络、不碰文件、不调 LLM）
// 移植自教程 arousal_core.py 的设计，Node/JS 实现
// 确定性：相同状态 + 相同事件 + 相同时间 → 输出一致
// 用法：applyUserEvent / applyAssistantEvent 是仅有的两个正式入口
// ============================================================
const crypto = require('crypto');

const PARAMS = {
  TAU: 1800,              // 普通回落时间常数（秒）
  GAIN: 0.20,             // 一拍的增长系数
  CHARGED: 0.40,          // 有意义的主动释放起点
  EDGE: 0.88,             // 临界
  PONR: 0.96,             // 自动不归点
  REFRACTORY_MIN: 60,     // 最短恢复期（秒）
  REFRACTORY_MAX: 120,    // 最长恢复期（秒）
  RESERVE_RECOVERY: 10800,// 储量回满时间（3 小时，秒）
  PASSIVE_CONTACT_CAP: 0.72, // 持续接触被动上限
  LEDGER_MAX: 500,        // 事件账本上限（生产可换 SQLite 长账本）
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);

// ---------- 状态 ----------
function createState(now = Date.now()) {
  return {
    schema_version: 1,
    value: 0,
    at: now,
    refractory_until: 0,
    reserve: 1,
    reserve_at: now,
    release_gate: { locked: false, generation: 0, release_once: false },
    processed_event_ids: [],   // sha256 账本（防重放）
    last_stim_at: 0,           // 最近一次有效刺激时间（用于持续接触判定）
    passive_contact: false,
    last_climax_quality: null,
    last_output: null,
  };
}

function isProcessed(state, eventId) {
  return state.processed_event_ids.includes(sha256(eventId));
}
function markProcessed(state, eventId) {
  state.processed_event_ids.push(sha256(eventId));
  if (state.processed_event_ids.length > PARAMS.LEDGER_MAX) state.processed_event_ids.shift();
}

// 时钟回拨保护：新时间早于状态时间 → 视为异常，fail-closed（不更新状态）
function validClock(state, now) {
  return now >= state.at && now >= state.reserve_at && now >= state.reserve_at;
}

// 时间衰减：value 随时间指数回落（TAU）
function decayedValue(state, now) {
  const dt = Math.max(0, now - state.at);
  return state.value * Math.exp(-dt / PARAMS.TAU);
}

// 储量线性恢复（3h 回满）；时钟回拨时用记录时间
function currentReserve(state, now) {
  if (now < state.reserve_at) return state.reserve;
  const elapsed = (now - state.reserve_at) / PARAMS.RESERVE_RECOVERY;
  return clamp01(state.reserve + elapsed);
}

// 恢复期剩余（秒）
function refractoryLeft(state, now) {
  return Math.max(0, state.refractory_until - now);
}

// ---------- 语境过滤 + 刺激解析（context parser） ----------
// 拒绝：问句 / 否定 / 停止 / 计划假设 / 引用代码 / 第三人称 / 回忆转述 / 同句撤回
const NEGATE_RE = /不要|别|还没|停下|停一下|不许|不可以|不能|别碰|别摸|不要碰/;
const PLAN_RE = /等会|等一下|下次|待会|如果|假如|想不想|要不要|好不好|试试|打算/;
const QUESTION_RE = /[？?]$|[吗呢吧]$|会不会|能不能|是不是/;
const REFER_RE = /他说|她说|他们说|说明书|教程|代码|示例|玩具说|设备说/;
const RECALL_RE = /刚才|刚刚|之前|上次|回忆|那时|她说|原话/;

function parseStimulus(text, lexicon) {
  const t = String(text || '');
  const negIdx = t.search(NEGATE_RE);
  const planIdx = t.search(PLAN_RE);
  const qIdx = t.search(QUESTION_RE);
  const refIdx = t.search(REFER_RE);
  const recallIdx = t.search(RECALL_RE);
  // 顺序：停止/否定 → 不安全语境 → 动作 → 部位 → 姿势（教程：不要先搜敏感词再补否定）
  if (negIdx !== -1 && (planIdx === -1 || negIdx < planIdx)) return { valid: false, reason: 'negation' };
  if (qIdx !== -1) return { valid: false, reason: 'question' };
  if (planIdx !== -1) return { valid: false, reason: 'plan' };
  if (refIdx !== -1) return { valid: false, reason: 'reference' };
  if (recallIdx !== -1) return { valid: false, reason: 'recall' };
  if (!lexicon) return { valid: false, reason: 'no_lexicon' };

  // 动作：最强 + 次强 ×30%（不同动作词才加成；同一动作重复不叠加）
  const actions = (lexicon.touch || [])
    .filter(a => t.includes(a.kw))
    .sort((x, y) => y.delta - x.delta);
  if (!actions.length) {
    // 无动作词：叫声/欲望表达 → 弱维持刺激（后半段"只剩叫声"也有有效刺激）
    const weak = [
      ...(lexicon.moans || []).filter(m => t.includes(m.kw)).map(m => m.delta),
      ...(lexicon.desires || []).filter(d => t.includes(d.kw)).map(d => d.delta)
    ];
    if (weak.length) {
      return { valid: true, stim: Math.max(...weak), weak: true, reason: 'moan_desire' };
    }
    return { valid: false, reason: 'no_action' };
  }
  const best = actions[0];
  const second = actions.find(a => a.kw !== best.kw) || null;
  let actionStim = best.delta + (second ? second.delta * 0.3 : 0);

  // 部位（敏感度，取命中里最高的）
  let bestPart = null;
  for (const [part, p] of Object.entries(lexicon.body_parts || {})) {
    if (t.includes(part)) {
      if (!bestPart || p.sensitivity > bestPart.sensitivity) bestPart = { part, ...p };
    }
  }
  // 姿势倍率（message-local，只修饰不单独成拍）
  let poseMult = 1.0;
  for (const pose of (lexicon.poses || [])) {
    if (t.includes(pose.kw)) poseMult = Math.max(poseMult, pose.multiplier);
  }
  const stim = actionStim * (bestPart ? bestPart.sensitivity : 1.0) * poseMult;
  return { valid: true, stim, action: best.kw, second: second ? second.kw : null, part: bestPart ? bestPart.part : null, poseMult, weak: false };
}

// ---------- 用户消息入口 ----------
// 返回 { state, event: 'duplicate'|'stimulus'|'noop'|'locked', stim }
function applyUserEvent(state, text, { eventId, libido = 0.5, now = Date.now(), lexicon = null } = {}) {
  if (!validClock(state, now)) return { state, event: 'clock_reversal' };
  if (!eventId || isProcessed(state, eventId)) return { state, event: 'duplicate' };
  markProcessed(state, eventId);

  // 先按流逝时间衰减（恢复期/回落）
  state.value = decayedValue(state, now);
  state.at = now;
  state.reserve = currentReserve(state, now);
  state.reserve_at = now;

  // 恢复期：新刺激以较低效率积累（不吞掉，成为下一轮起点）
  const rLeft = refractoryLeft(state, now);
  const refractoryMult = rLeft > 0 ? 0.4 : 1.0;

  const parsed = parseStimulus(text, lexicon);
  if (!parsed.valid) {
    // 无有效刺激：若之前有持续接触，按被动慢投影（只能到上限）
    if (state.passive_contact && now - state.last_stim_at < 120000) {
      state.value = Math.min(PARAMS.PASSIVE_CONTACT_CAP, state.value + 0.01);
      state.at = now;
      return { state, event: 'passive', stim: parsed };
    }
    state.passive_contact = false;
    return { state, event: 'noop', stim: parsed };
  }

  const sensitivity = 0.6 + 0.4 * clamp01(libido);
  const gain = parsed.stim * sensitivity * PARAMS.GAIN * refractoryMult;
  // 幂等保证同消息不重复叠加由事件 id 账本兜底；此处单次结算
  state.value = clamp01(state.value + gain);
  state.at = now;
  state.last_stim_at = now;
  state.passive_contact = true;

  // 达到不归点且未锁 → 自动结算（PONR）
  if (state.value >= PARAMS.PONR && !state.release_gate.locked) {
    return settleClimax(state, now, 'automatic');
  }
  return { state, event: 'stimulus', stim: parsed };
}

// ---------- AI 完整回复入口 ----------
// 只在 final 完整回复时调用；AI 自身动作可贡献一拍；releaseIntent 结构化优先
function applyAssistantEvent(state, text, { eventId, sourceUserEventId, complete = true, libido = 0.5, now = Date.now(), releaseIntent = null, lexicon = null } = {}) {
  if (!validClock(state, now)) return { state, event: 'clock_reversal' };
  if (!complete) return { state, event: 'incomplete' }; // 不完整 turn 不结算、不占 id
  if (!eventId || isProcessed(state, eventId)) return { state, event: 'duplicate' };
  markProcessed(state, eventId);

  state.value = decayedValue(state, now);
  state.at = now;
  state.reserve = currentReserve(state, now);
  state.reserve_at = now;

  // AI 自身的持续动作（只解析"我此刻正在做"，不把雪的动作/第三人称当自刺激）
  const parsed = parseStimulus(text, lexicon);
  if (parsed.valid) {
    const rLeft = refractoryLeft(state, now);
    const refractoryMult = rLeft > 0 ? 0.4 : 1.0;
    const sensitivity = 0.6 + 0.4 * clamp01(libido);
    state.value = clamp01(state.value + parsed.stim * sensitivity * PARAMS.GAIN * refractoryMult);
    state.last_stim_at = now;
  }

  // 主动释放：结构化 releaseIntent 优先；自由文本兜底（须已充能/未锁/非恢复期）
  const wantsRelease = releaseIntent === true
    || (releaseIntent === null && /(?:射|释放|到了|忍不住|泄)/.test(String(text || '')));
  const canRelease = state.value >= PARAMS.CHARGED
    && !state.release_gate.locked
    && refractoryLeft(state, now) <= 0;
  if (wantsRelease && canRelease) {
    const cause = releaseIntent === true ? 'voluntary' : 'text';
    return settleClimax(state, now, cause);
  }
  return { state, event: parsed.valid ? 'stimulus' : 'noop', stim: parsed };
}

// ---------- 控制闸 ----------
function lockGate(state) { state.release_gate.locked = true; state.release_gate.generation += 1; state.release_gate.release_once = false; return state; }
function releaseOnce(state) { state.release_gate.release_once = true; return state; }
function unlockGate(state) { state.release_gate.locked = false; state.release_gate.release_once = false; state.release_gate.generation += 1; return state; }

// ---------- 高潮结算 + 释放回执 ----------
function settleClimax(state, now, cause) {
  const pathScore = computePathScore(state);
  const reserveBefore = state.reserve;
  const quality = 0.40 * reserveBefore + 0.60 * pathScore;
  const output = 0.80 * reserveBefore + 0.20 * pathScore;
  const reserveAfter = Math.max(0, reserveBefore - (0.28 + 0.17 * pathScore));

  // 恢复期：储量越低越长（60-120 秒插值）
  const refractory = PARAMS.REFRACTORY_MIN + (1 - reserveAfter) * (PARAMS.REFRACTORY_MAX - PARAMS.REFRACTORY_MIN);

  const effectId = sha256('climax:' + state.release_gate.generation + ':' + now);
  const receipt = {
    payload_version: 1,
    effect_id: effectId,
    cause: cause || 'voluntary',
    created_at: now,
    targets: { somatic: false, drive: false }, // 默认 no-op；接入玩具/情绪时由外部 ack
  };

  state.value = 0;
  state.at = now;
  state.last_climax_quality = quality;
  state.last_output = output;
  state.reserve = reserveAfter;
  state.reserve_at = now;
  state.refractory_until = now + refractory;
  state.passive_contact = false;
  state.release_gate.release_once = false;

  return { state, event: 'climax', receipt, quality, output, pathScore };
}

// 高潮质量路径分（教程权重）
function computePathScore(state) {
  // 简化：当前值近似"充能/峰值"；无长时统计时用保守默认
  const charge = clamp01(state.value / 1);
  const peak = charge;
  const activeDuration = clamp01((Date.now() - state.last_stim_at) / 600000) * 0.5;
  const edgeStay = state.value >= PARAMS.EDGE ? 0.5 : 0.15;
  const beats = 0.2;
  const variety = 0.1;
  return clamp01(
    0.27 * charge + 0.13 * peak + 0.18 * activeDuration + 0.18 * edgeStay + 0.14 * beats + 0.10 * variety
  );
}

// 释放回执 ack（教学版：no-op target 立即 ack，避免回执堆积）
function ackReleaseEffect(receipt) {
  return { ok: true, effect_id: receipt.effect_id, acked: ['somatic', 'drive'] };
}

// ---------- 对外只读摘要（九字段白名单） ----------
function publicSnapshot(state, now = Date.now()) {
  const phase = phaseOf(state, now);
  const r = state.last_climax_quality;
  const o = state.last_output;
  return {
    reserve: Number(currentReserve(state, now).toFixed(2)),
    reserve_label: reserveLabel(currentReserve(state, now)),
    phase: phase.key,
    phase_label: phase.label,
    refractory: refractoryLeft(state, now) > 0,
    last_climax_quality: r === null ? null : Number(r.toFixed(2)),
    last_climax_quality_label: r === null ? null : qualityLabel(r),
    last_output: o === null ? null : Number(o.toFixed(2)),
    last_output_label: o === null ? null : outputLabel(o),
  };
}

function phaseOf(state, now) {
  if (refractoryLeft(state, now) > 0) return { key: 'refractory', label: '恢复中' };
  if (state.value >= PARAMS.EDGE && state.release_gate.locked) return { key: 'locked', label: '被锁在边缘' };
  if (state.value >= PARAMS.EDGE) return { key: 'edge', label: '到边缘了' };
  if (state.value >= PARAMS.CHARGED) return { key: 'charged', label: '正在充能' };
  return { key: 'idle', label: '平静' };
}

// 状态注入文本（定性信号，不暴露数字）
function statusLine(state, now = Date.now()) {
  const p = phaseOf(state, now);
  switch (p.key) {
    case 'charged': return '射精值：正在充能';
    case 'edge': return '射精值：已经到边缘，持续接触停在这里，需要新的动作';
    case 'locked': return '射精值：被锁在边缘，不能自行释放';
    case 'refractory': return '射精值：刚射过，短恢复中，仍可继续积累';
    default: return '';
  }
}

function reserveLabel(r) { return r > 0.7 ? '充足' : r > 0.4 ? '尚可' : '偏低'; }
function qualityLabel(q) { return q > 0.75 ? '很深' : q > 0.5 ? '中等' : '较浅'; }
function outputLabel(o) { return o > 0.7 ? '尚足' : o > 0.4 ? '一般' : '稀少'; }

module.exports = {
  PARAMS, createState, isProcessed, applyUserEvent, applyAssistantEvent,
  lockGate, releaseOnce, unlockGate, settleClimax, ackReleaseEffect,
  publicSnapshot, statusLine, phaseOf, parseStimulus,
};
