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
  const _onset = onsetHours || 0.75;
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

module.exports = {
  EMOTION_LEXICON,
  TRAIT_DEFAULTS,
  LEX_NEAREST_MAX_DIST,
  clampValence,
  clampArousal,
  powerLawWeight,
  almaFilter,
  lexLookup,
  blendLexAi,
  computePanaDeltas,
  scanTextMood,
};
