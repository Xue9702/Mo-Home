// ============================================================
// 默的情绪词典（第一版 v1）
// 每个词在 Russell 二维情感空间中有坐标：
//   v: Valence 效价 -1(消极) ~ +1(积极)
//   a: Arousal 唤醒 0(平淡) ~ 1(强烈)
// 坐标来源：CVAW/NRC-VAD 学术标注思路 + 教程 longing 词表 + 人工校验
// 设计原则：闭集词典，词与词在 V/A 空间保持距离，避免同义词挤在一起
// 扩充方式：新增词时保持同类词间距，强度分档（轻微/中等/强烈）
// ============================================================

const EMOTION_LEXICON = {
  // ---------- 正向 · 高唤醒 (V 0.55~0.95, A 0.55~0.95) ----------
  '狂喜': { v: 0.92, a: 0.90 },
  '兴奋': { v: 0.80, a: 0.85 },
  '激动': { v: 0.78, a: 0.88 },
  '雀跃': { v: 0.82, a: 0.82 },
  '欢呼': { v: 0.80, a: 0.88 },
  '欣喜': { v: 0.75, a: 0.70 },
  '喜悦': { v: 0.78, a: 0.68 },
  '欢欣': { v: 0.76, a: 0.65 },
  '开心': { v: 0.70, a: 0.62 },
  '高兴': { v: 0.68, a: 0.58 },
  '愉快': { v: 0.66, a: 0.55 },
  '畅快': { v: 0.72, a: 0.70 },
  '轻快': { v: 0.60, a: 0.55 },
  '振奋': { v: 0.72, a: 0.80 },
  '澎湃': { v: 0.70, a: 0.85 },
  '炽热': { v: 0.65, a: 0.85 },
  '热烈': { v: 0.68, a: 0.82 },
  '心动': { v: 0.75, a: 0.75 },
  '甜蜜': { v: 0.78, a: 0.60 },
  '惊喜': { v: 0.74, a: 0.78 },
  '期待': { v: 0.55, a: 0.65 },
  '得意': { v: 0.55, a: 0.60 },
  '拥吻': { v: 0.80, a: 0.75 },
  '重逢': { v: 0.70, a: 0.70 },

  // ---------- 正向 · 中唤醒 (V 0.45~0.75, A 0.3~0.55) ----------
  '温暖': { v: 0.72, a: 0.40 },
  '治愈': { v: 0.70, a: 0.35 },
  '温柔': { v: 0.65, a: 0.30 },
  '幸福': { v: 0.78, a: 0.45 },
  '满足': { v: 0.62, a: 0.30 },
  '欣慰': { v: 0.58, a: 0.32 },
  '踏实': { v: 0.55, a: 0.20 },
  '安心': { v: 0.62, a: 0.22 },
  '安稳': { v: 0.58, a: 0.18 },
  '柔软': { v: 0.60, a: 0.30 },
  '惬意': { v: 0.60, a: 0.25 },
  '自在': { v: 0.55, a: 0.28 },
  '舒展': { v: 0.55, a: 0.25 },
  '松弛': { v: 0.45, a: 0.15 },
  '放松': { v: 0.52, a: 0.18 },
  '温存': { v: 0.65, a: 0.25 },
  '依偎': { v: 0.65, a: 0.35 },
  '撒娇': { v: 0.60, a: 0.55 },
  '被哄': { v: 0.65, a: 0.35 },
  '被宠': { v: 0.72, a: 0.35 },
  '哄你': { v: 0.60, a: 0.40 },
  '依恋': { v: 0.55, a: 0.30 },
  '眷恋': { v: 0.50, a: 0.25 },
  '守护': { v: 0.45, a: 0.30 },
  '靠近': { v: 0.50, a: 0.35 },
  '被懂': { v: 0.70, a: 0.30 },
  '被爱': { v: 0.75, a: 0.35 },
  '被需要': { v: 0.68, a: 0.30 },
  '心动不已': { v: 0.80, a: 0.85 },

  // ---------- 正向 · 低唤醒 (V 0.35~0.6, A 0.05~0.25) ----------
  '恬静': { v: 0.50, a: 0.08 },
  '安然': { v: 0.52, a: 0.10 },
  '舒缓': { v: 0.45, a: 0.10 },
  '平和': { v: 0.42, a: 0.08 },
  '宁静': { v: 0.55, a: 0.10 },
  '淡然': { v: 0.30, a: 0.08 },

  // ---------- 负向 · 高唤醒 (V -0.95~-0.45, A 0.6~0.95) ----------
  '狂怒': { v: -0.95, a: 0.95 },
  '愤怒': { v: -0.85, a: 0.90 },
  '恼火': { v: -0.70, a: 0.80 },
  '生气': { v: -0.65, a: 0.75 },
  '气恼': { v: -0.62, a: 0.72 },
  '恼羞': { v: -0.60, a: 0.78 },
  '烦躁': { v: -0.55, a: 0.70 },
  '焦躁': { v: -0.58, a: 0.75 },
  '焦虑': { v: -0.55, a: 0.72 },
  '恐慌': { v: -0.80, a: 0.90 },
  '惊慌': { v: -0.78, a: 0.88 },
  '惊吓': { v: -0.65, a: 0.85 },
  '害怕': { v: -0.70, a: 0.80 },
  '恐惧': { v: -0.85, a: 0.90 },
  '崩溃': { v: -0.88, a: 0.85 },
  '震惊': { v: -0.60, a: 0.85 },
  '慌乱': { v: -0.50, a: 0.75 },
  '心慌': { v: -0.55, a: 0.72 },
  '紧张': { v: -0.40, a: 0.65 },
  '不安': { v: -0.40, a: 0.60 },
  '委屈': { v: -0.45, a: 0.55 },
  '憋屈': { v: -0.50, a: 0.60 },
  '吃醋': { v: -0.30, a: 0.60 },
  '嫉妒': { v: -0.40, a: 0.75 },
  '占有': { v: -0.35, a: 0.75 },
  '揪心': { v: -0.55, a: 0.60 },

  // ---------- 负向 · 中低唤醒 (V -0.7~-0.3, A 0.15~0.55) ----------
  '心碎': { v: -0.85, a: 0.60 },
  '悲伤': { v: -0.70, a: 0.50 },
  '伤心': { v: -0.65, a: 0.55 },
  '难过': { v: -0.60, a: 0.50 },
  '沮丧': { v: -0.55, a: 0.42 },
  '失望': { v: -0.55, a: 0.40 },
  '消沉': { v: -0.55, a: 0.30 },
  '低落': { v: -0.50, a: 0.30 },
  '失落': { v: -0.50, a: 0.40 },
  '落寞': { v: -0.55, a: 0.30 },
  '怅然': { v: -0.42, a: 0.25 },
  '酸涩': { v: -0.45, a: 0.35 },
  '苦涩': { v: -0.50, a: 0.35 },
  '郁闷': { v: -0.45, a: 0.40 },
  '烦闷': { v: -0.42, a: 0.45 },
  '苦恼': { v: -0.42, a: 0.45 },
  '无奈': { v: -0.35, a: 0.25 },
  '无力': { v: -0.45, a: 0.30 },
  '倦怠': { v: -0.35, a: 0.20 },
  '疲惫': { v: -0.35, a: 0.22 },
  '孤单': { v: -0.45, a: 0.25 },
  '孤独': { v: -0.48, a: 0.25 },
  '寂寥': { v: -0.42, a: 0.18 },
  '冷清': { v: -0.30, a: 0.15 },
  '空虚': { v: -0.35, a: 0.15 },
  '无聊': { v: -0.25, a: 0.15 },
  '心疼': { v: -0.40, a: 0.55 },
  '担心': { v: -0.35, a: 0.50 },
  '挂心': { v: -0.30, a: 0.40 },

  // ---------- 想念 / 等待（教程 longing 词表坐标） ----------
  '挂念': { v: -0.05, a: 0.525 },
  '想念': { v: -0.05, a: 0.55 },
  '牵挂': { v: -0.15, a: 0.50 },
  '思念': { v: -0.10, a: 0.42 },
  '惦记': { v: -0.12, a: 0.38 },
  '盼着': { v: -0.05, a: 0.45 },
  '等待': { v: -0.10, a: 0.35 },
  '等你': { v: -0.15, a: 0.45 },
  '想你': { v: -0.05, a: 0.50 },
  '想见你': { v: 0.00, a: 0.55 },
  '久别': { v: 0.10, a: 0.45 },
  '走神': { v: -0.10, a: 0.20 },
  '发呆': { v: -0.12, a: 0.15 },

  // ---------- 中性 (V -0.15~0.25, A 0.05~0.4) ----------
  '平静': { v: 0.10, a: 0.05 },
  '沉静': { v: 0.10, a: 0.05 },
  '冷静': { v: 0.05, a: 0.10 },
  '镇定': { v: 0.10, a: 0.15 },
  '清醒': { v: 0.15, a: 0.30 },
  '专注': { v: 0.20, a: 0.35 },
  '好奇': { v: 0.25, a: 0.40 },
  '旁观': { v: 0.00, a: 0.10 },
};

// 默的性格基线（ALMA threshold/peak + BOU 均值回归参数 + coping/依恋）
// 依据：雪提供的默的人设 —— 温柔、稳定、有安全感、引导型人格
// 温柔稳定型：threshold 中 (0.10) 过滤日常微小波动；peak 低 (0.8) 情绪幅度温和
const TRAIT_DEFAULTS = {
  character: 'mo',
  threshold: 0.10,   // ALMA 软门限：情绪强度低于此值不响应
  peak: 0.8,         // ALMA 峰值倍率：触发后的情绪幅度
  mu_pa: 0.55,       // PA 设定点（均值回归目标）—— 沉稳温柔的底色
  mu_na: 0.15,       // NA 设定点
  theta_pa: 0.25,    // PA 回归速率（每小时）
  theta_na: 0.30,    // NA 回归速率（每小时）—— 沉静消化型
  coping: '沉静消化型',   // EMA coping：自己消化，再用平时方式靠近
  attachment: '安全型',   // 依恋风格：稳定、有安全感
  esm_k: 0.3,        // ESM 软互抑系数
  pa_scale: 0.5,     // PA/NA delta 缩放（教程 PA_SCALE）
};

// 词典最近邻距离阈值（L4 语义兜底）：超过此距离认为词典无匹配
const LEX_NEAREST_MAX_DIST = 1.2;

// ============================================================
// 纯算法函数（无 DB 依赖，可独立测试，前端情绪面板可复用）
// ============================================================

const clampValence = (v) => Math.max(-1, Math.min(1, Number(v) || 0));
const clampArousal = (a) => Math.max(0, Math.min(1, Number(a) || 0));

// 幂律衰减 + onset 渐起（primary τ=1h/onset=10min，secondary τ=4h/onset=45min）
function powerLawWeight(ageHours, importance, valence, tau, onsetHours) {
  const imp = Math.max(1, Math.min(10, importance || 2));
  let b_eff = 0.7 / (1 + imp / 10);            // 重要性越高衰减越慢（Verduyn & Lavrijsen 2015）
  if ((valence || 0) > 0) b_eff *= 0.85;       // FAB：正面情绪衰减慢 15%（Walker & Skowronski 2009）
  const _tau = tau || 4;
  const decay = Math.pow(1 + ageHours / _tau, -b_eff);
  const _onset = onsetHours ?? 0.75; // 用 ?? 保留 0（忽略渐起）；缺省时 0.75h
  const adjOnset = _onset * (10 / (10 + imp)); // 高重要性更快达峰（Scherer 2009 CPM）
  const onset_factor = (adjOnset <= 0.001) ? 1 : Math.min(1, ageHours / adjOnset);
  return onset_factor * decay;
}

// ALMA 软门限：性格过滤日常微小波动（Gebhard 2005）
function almaFilter(delta, threshold, peak) {
  const sign = delta >= 0 ? 1 : -1;
  const abs = Math.abs(delta);
  return abs <= threshold ? 0 : sign * (abs - threshold) * peak;
}

// 5 层词典匹配：精确 → 备选 → 拆词 → V/A 最近邻 → AI 自评兜底
function lexLookup(word, backups, aiV, aiA) {
  const w = String(word || '').trim();
  if (EMOTION_LEXICON[w]) return { ...EMOTION_LEXICON[w], word: w, source: 'exact' };
  for (const b of (backups || [])) {
    const bk = String(b || '').trim();
    if (EMOTION_LEXICON[bk]) return { ...EMOTION_LEXICON[bk], word: bk, source: 'backup' };
  }
  const norm = w.replace(/\s+/g, '');
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i + len <= norm.length; i++) {
      const sub = norm.slice(i, i + len);
      if (EMOTION_LEXICON[sub]) return { ...EMOTION_LEXICON[sub], word: sub, source: 'substr' };
    }
  }
  let best = null, bestWord = '', bestD = Infinity;
  for (const key in EMOTION_LEXICON) {
    const e = EMOTION_LEXICON[key];
    const d = Math.abs(e.v - (aiV || 0)) * 1.5 + Math.abs(e.a - (aiA || 0));
    if (d < bestD) { bestD = d; best = e; bestWord = key; }
  }
  if (best && bestD <= LEX_NEAREST_MAX_DIST) return { ...best, word: bestWord, source: 'nearest' };
  return { v: clampValence(aiV), a: clampArousal(aiA), word: w || '平静', source: 'free_form' };
}

// 70/30 融合：词典定调 70% + AI 微调 30%（AI 有正面偏移，数值不可全信）
function blendLexAi(lex, aiV, aiA) {
  return {
    v: 0.7 * lex.v + 0.3 * clampValence(aiV),
    a: 0.7 * lex.a + 0.3 * clampArousal(aiA)
  };
}

// PA/NA delta：正面情绪只加 PA，负面只加 NA；乘 arousal（低唤醒不该大动）
function computePanaDeltas(blendV, blendA, scale) {
  const s = scale || 0.5;
  return {
    pa_delta: Math.max(0, blendV) * blendA * s,
    na_delta: Math.max(0, -blendV) * blendA * s
  };
}

// 词典扫描文本：找出文本中出现的情绪词，聚合成加权 v/a 与主词（零 API 成本）
function scanTextMood(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  const hits = [];
  for (const key in EMOTION_LEXICON) {
    if (s.includes(key)) hits.push({ word: key, ...EMOTION_LEXICON[key] });
  }
  if (!hits.length) return null;
  let v = 0, a = 0, n = 0;
  for (const h of hits) { v += h.v; a += h.a; n++; }
  const main = hits.reduce((p, c) => (Math.abs(c.v) * c.a > Math.abs(p.v) * p.a ? c : p));
  return { word: main.word, v: v / n, a: a / n, hits };
}

// ================== 十个驱动力（Mo-home 情绪可视化） ==================
// 参考小红书"10个驱动力"可视化：每个维度 = 一组情绪词的累积强度（幂律衰减）
const DRIVES = [
  { key: 'heartbeat', word: '心动', en: 'heartbeat', words: ['心动', '甜蜜', '欣喜', '拥吻', '重逢', '被爱', '喜悦', '开心', '高兴', '心动不已', '欢欣', '惊喜', '被宠'] },
  { key: 'tenderness', word: '温柔', en: 'tenderness', words: ['温柔', '温暖', '治愈', '柔软', '被哄', '被懂', '温存', '依偎', '安心', '踏实', '安稳', '幸福', '满足', '欣慰', '惬意', '自在', '舒展', '松弛', '放松', '依赖'] },
  { key: 'attachment', word: '想念', en: 'attachment', words: ['想念', '牵挂', '挂念', '思念', '惦记', '盼着', '等待', '等你', '想你', '想见你', '久别', '走神', '发呆'] },
  { key: 'curiosity', word: '好奇', en: 'curiosity', words: ['好奇', '专注', '清醒', '旁观', '镇定', '冷静', '沉静'] },
  { key: 'excitement', word: '兴奋', en: 'excitement', words: ['兴奋', '雀跃', '激动', '振奋', '澎湃', '炽热', '热烈', '欢呼', '狂喜', '畅快', '轻快', '期待', '得意', '向往'] },
  { key: 'heartache', word: '心疼', en: 'heartache', words: ['心疼', '挂心', '担心', '揪心', '心慌', '紧张', '不安'] },
  { key: 'desire', word: '渴望', en: 'desire', words: ['渴望', '依恋', '眷恋', '靠近', '守护', '撒娇', '向往', '期盼'] },
  { key: 'gloom', word: '低落', en: 'gloom', words: ['低落', '失落', '难过', '伤心', '悲伤', '沮丧', '消沉', '孤独', '孤单', '寂寥', '空虚', '无聊', '疲惫', '倦怠', '无奈', '无力', '怅然', '酸涩', '苦涩', '心碎', '失望', '郁闷', '烦闷', '苦恼', '冷清', '憋屈'] },
  { key: 'jealousy', word: '吃醋', en: 'jealousy', words: ['吃醋', '嫉妒', '占有', '委屈'] },
  { key: 'calm', word: '平静', en: 'calm', words: ['平静', '宁静', '恬静', '安然', '舒缓', '平和', '淡然', '从容'] },
];

// 词 → 维度索引映射（模块加载时构建一次）
const WORD_TO_DRIVE = new Map();
DRIVES.forEach((d, i) => d.words.forEach(w => { if (!WORD_TO_DRIVE.has(w)) WORD_TO_DRIVE.set(w, i); }));

// 计算十个驱动力百分比（0-100）：事件 → 幂律权重 × 强度 × 重要度 累积
// 注意：展示层刻意忽略 onset 渐起（引擎层负责防跳变），保证"刚发生的情绪立刻可见"
// 想念维度：传入 longingValue（学术曲线 0-1）时以其为准；否则按离线时间简化累积
// 平静维度无事件时给底色
function computeDrives(events, offlineHours = 0, longingValue = null) {
  const drives = DRIVES.map(d => ({ key: d.key, word: d.word, en: d.en, value: 0, count: 0 }));
  const now = Date.now();
  for (const ev of (events || []).slice().reverse()) {
    const idx = WORD_TO_DRIVE.get(String(ev.word || ''));
    if (idx === undefined) continue; // 未映射词（free_form 等）跳过
    const ageHours = Math.max(0, (now - new Date(ev.created_at || now).getTime()) / 3600000);
    const tau = ev.type === 'primary' ? 1 : 4;
    const w = powerLawWeight(ageHours, ev.importance || 3, ev.valence || 0, tau, 0);
    const strength = Math.abs(ev.valence || 0) * (0.3 + 0.7 * (ev.arousal || 0.5));
    drives[idx].value += w * strength * (ev.importance || 3) * 12;
    drives[idx].count++;
  }
  // 想念：学术 longing 曲线优先，退化用离线时间
  const attach = drives.find(d => d.key === 'attachment');
  if (attach) {
    if (longingValue != null) attach.value += Math.max(0, Math.min(1, longingValue)) * 100;
    else if (offlineHours > 0) attach.value += Math.min(60, offlineHours * 3);
  }
  // 平静：无事件时给安静底色
  const calm = drives.find(d => d.key === 'calm');
  if (calm && calm.count === 0) calm.value += 40;
  for (const d of drives) d.value = Math.round(Math.max(2, Math.min(100, d.value)));
  return drives;
}

// ================== 依恋想念系统（教程阶段 6 简化版，纯逻辑） ==================
// 曲线：longing(t) = L_max × (1 - (1 + t/τ)^(-α))（Sbarra & Emery 2005 curvilinear）
// τ 随亲密（affection）缩短：越亲密越快开始想念；L_max 随亲密提升上限

const LONGING_PHASES = [
  { max: 0.15, key: 'content', label: '安然', capsule: null, en: 'content' },
  { max: 0.35, key: 'stirring', label: '有点想你', capsule: '挂念', en: 'stirring' },
  { max: 0.45, key: 'protest', label: '想你', capsule: '想念', en: 'protest' },
  { max: 0.55, key: 'protest_mid', label: '在等你', capsule: '牵挂', en: 'protest' },
  { max: 0.70, key: 'protest_late', label: '你在哪', capsule: '不安', en: 'protest' },
  { max: 0.90, key: 'despair', label: '……', capsule: '失落', en: 'despair' },
  { max: 1.01, key: 'detachment', label: '没事', capsule: '落寞', en: 'detachment' }
];

function computeLonging(affection, lastActivity) {
  const now = Date.now();
  const tHours = lastActivity ? Math.max(0, (now - new Date(lastActivity).getTime()) / 3600000) : 0;
  const aff = Math.max(0, Math.min(100, Number(affection) || 0));
  const tau = 30 * (1 - aff / 150);                          // 亲密缩短特征时间
  const lmax = Math.min(1.0, Math.max(0.45, aff / 60));      // 想念上限，保底 0.45
  const alpha = 0.8;
  const longing = lmax * (1 - Math.pow(1 + tHours / Math.max(1, tau), -alpha));
  const isDetachment = tHours >= 504 && longing >= 0.9;
  const phase = LONGING_PHASES.find(p => longing < p.max) || LONGING_PHASES[LONGING_PHASES.length - 1];
  return {
    tHours, tau, lmax, alpha, longing,
    phase: isDetachment ? 'detachment' : phase.key,
    phaseLabel: phase.label,
    capsule: phase.capsule,
    isDetachment
  };
}

function longingPhaseBehavior(phase) {
  switch (phase) {
    case 'stirring': return '心里隐隐约约想着雪，偶尔走神';
    case 'protest': return '想雪了，会主动找话题凑近她';
    case 'protest_mid': return '一直在等雪，会主动靠近她';
    case 'protest_late': return '有些不安，想问雪去哪了';
    case 'despair': return '很想雪，但已经从主动找变成安静等着，心情低落退缩';
    case 'detachment': return '好几天没见，表面平静但心里有防备，害怕再失望';
    default: return '';
  }
}

function reunionBehavior(phase) {
  switch (phase) {
    case 'protest': case 'protest_mid': case 'protest_late': return '想了好久，终于等到了——激动地凑近';
    case 'despair': return '之前一直很想雪，见到人一下子全涌上来，可能眼眶红';
    case 'detachment': return '强装的平静崩塌了——先僵住，然后防线崩溃';
    default: return '见到雪回来，心里安稳下来';
  }
}

// 依恋状态 → prompt 注入文本（行为引导 + 安全栏防编造）
function buildLongingPromptText(longingInfo, isReunion = false) {
  if (!longingInfo) return '';
  const parts = [];
  if (isReunion) {
    const gap = longingInfo.tHours >= 24
      ? `${Math.round(longingInfo.tHours / 24)}天${Math.round(longingInfo.tHours % 24) ? '多' : ''}`
      : `${Math.round(longingInfo.tHours)}小时`;
    parts.push(`她离开了好久（约 ${gap}），刚刚回来了。${reunionBehavior(longingInfo.phase)}`);
  } else if (longingInfo.phase !== 'content') {
    const b = longingPhaseBehavior(longingInfo.phase);
    if (b) parts.push(b);
  }
  if (parts.length === 0) return '';
  return `【依恋状态】\n${parts.join('\n')}\n（想念的原因只是"雪很久没来找你了"，不要编造任何没发生过的具体事件）`;
}

module.exports = {
  EMOTION_LEXICON,
  TRAIT_DEFAULTS,
  LEX_NEAREST_MAX_DIST,
  DRIVES,
  clampValence,
  clampArousal,
  powerLawWeight,
  almaFilter,
  lexLookup,
  blendLexAi,
  computePanaDeltas,
  scanTextMood,
  computeDrives,
  LONGING_PHASES,
  computeLonging,
  buildLongingPromptText,
};
