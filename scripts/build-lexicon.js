// 构建学术情绪词典：CVAW（中文）+ NRC 翻译结果（如存在）→ emotion-lexicon-academic.json
// 归一化：CVAW V 1-9 → [-1,1]（(m-5)/4），A 1-9 → [0,1]（(m-1)/8）
//         NRC V/A 已是 [-1,1]，Arousal → [0,1]（(x+1)/2）
// 用法：node scripts/build-lexicon.js
const fs = require('fs');
const path = require('path');

const outPath = 'E:/Mo-Home/emotion-lexicon-academic.json';

function normalizeCvaw(value) {
  const n = Number(value);
  if (!isFinite(n)) return null;
  return Math.max(-1, Math.min(1, (n - 5) / 4)); // V: 1-9 -> -1..1
}
function normalizeCvawArousal(value) {
  const n = Number(value);
  if (!isFinite(n)) return null;
  return Math.max(0, Math.min(1, (n - 1) / 8)); // A: 1-9 -> 0..1
}

(async () => {
  const lexicon = {};
  let cvawCount = 0, nrcCount = 0, dropped = 0;

  // 0) 若 academic.json 已存在（含 CVAW 繁简转换成果），先加载保留，不再从 CSV 覆盖
  let base = {};
  if (fs.existsSync(outPath)) {
    try { base = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (e) { base = {}; }
  }
  Object.assign(lexicon, base);
  cvawCount = Object.keys(lexicon).length;

  // 1) CVAW：仅当 academic.json 不存在或为空时从 CSV 生成（避免覆盖繁转简）
  if (Object.keys(lexicon).length === 0) {
    const cvawText = fs.readFileSync('E:/Mo-Home/ChineseEmoBank/CVAW_SD/CVAW_all_SD.csv', 'utf8');
    const cvawLines = cvawText.split(/\r?\n/).filter(Boolean);
    for (let i = 1; i < cvawLines.length; i++) {
      const cols = cvawLines[i].split('\t');
      if (cols.length < 4) continue;
      const word = String(cols[1] || '').trim();
      const v = normalizeCvaw(cols[2]);
      const a = normalizeCvawArousal(cols[3]);
      if (!word || v === null || a === null) { dropped++; continue; }
      if (word.length > 6) { dropped++; continue; }
      if (lexicon[word]) { dropped++; continue; }
      lexicon[word] = { v: Number(v.toFixed(4)), a: Number(a.toFixed(4)) };
      cvawCount++;
    }
  }

  // 2) NRC 翻译结果（如已生成 emotion-lexicon-nrc.json）
  // 格式：{"english_term":{v,a}, "__zh__english_term":"中文翻译"} → 中文翻译作 key，取英文词坐标
  const nrcPath = 'E:/Mo-Home/emotion-lexicon-nrc.json';
  if (fs.existsSync(nrcPath)) {
    try {
      const nrc = JSON.parse(fs.readFileSync(nrcPath, 'utf8'));
      for (const [k, v] of Object.entries(nrc)) {
        if (!k.startsWith('__zh__')) continue;
        const zh = String(v || '').trim();
        const coord = nrc[k.slice(6)]; // '__zh__' 是 6 字符前缀
        if (!zh || !coord || lexicon[zh]) continue;
        lexicon[zh] = { v: coord.v, a: coord.a };
        nrcCount++;
      }
    } catch (e) { console.error('NRC 翻译结果解析失败:', e.message); }
  }

  // 过滤单字词（"好""累""的""锅"等漏斗噪音）
  for (const w of Object.keys(lexicon)) {
    if (String(w).length < 2) delete lexicon[w];
  }

  fs.writeFileSync(outPath, JSON.stringify(lexicon));
  console.log('构建完成:', outPath);
  console.log('CVAW 词数:', cvawCount, '| NRC 词数:', nrcCount, '| 跳过:', dropped, '| 总计:', Object.keys(lexicon).length);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
