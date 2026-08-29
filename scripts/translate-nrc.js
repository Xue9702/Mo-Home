// 翻译 NRC-VAD v2.1 unigrams（英文词 → 简体中文），输出 emotion-lexicon-nrc.json
// 分批调 deepseek（flash），每批 300 词；增量写文件，可断点续跑（跳过已有词）
// 归一化：valence 保持 [-1,1]；arousal [-1,1] → [0,1]（(x+1)/2）
// 用法：node scripts/translate-nrc.js [起始批号]
const fs = require('fs');
const path = require('path');

// 加载 .env
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error('缺少 DEEPSEEK_API_KEY'); process.exit(1); }

const SRC = 'E:/Mo-Home/NRC-VAD-Lexicon-v2.1/Unigrams/unigrams-NRC-VAD-Lexicon-v2.1.txt';
const OUT = 'E:/Mo-Home/emotion-lexicon-nrc.json';
const BATCH = 300;

async function translateBatch(words) {
  const system = '你是词典翻译器。把英文单词逐一翻译为简体中文，按"该词最常见/最自然的情绪语境义"翻译（多义词取最常用义，如 blue 翻译为"忧郁"而非"蓝色"）。只输出 JSON 对象：{"english_word":"中文翻译"}；若某词没有合适的中文翻译（专有名词/无意义词），对应值输出 null。不要解释。';
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'system', content: system }, { role: 'user', content: words.join('\n') }],
      reasoning_effort: 'none',
      max_tokens: 4000,
      temperature: 0.2,
      stream: false
    })
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  const raw = String(data.choices?.[0]?.message?.content || '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  try { return JSON.parse(raw.substring(start, end + 1)); }
  catch (e) { console.error('解析失败:', raw.slice(0, 100)); return {}; }
}

(async () => {
  const text = fs.readFileSync(SRC, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean).slice(1); // 去表头
  const entries = lines.map(l => {
    const c = l.split('\t');
    return { term: c[0], v: Number(c[1]), a: Number(c[2]) };
  }).filter(e => e.term && isFinite(e.v) && isFinite(e.a));

  let result = {};
  if (fs.existsSync(OUT)) { try { result = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {} }
  const existing = new Set(Object.keys(result));

  const todo = entries.filter(e => !existing.has(e.term));
  console.log('总词数:', entries.length, '| 待翻译:', todo.length);

  let done = 0, failed = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const translated = await translateBatch(batch.map(b => b.term));
      for (const b of batch) {
        const zh = translated[b.term];
        if (zh && typeof zh === 'string' && zh.trim() && zh.trim().length <= 8) {
          result[b.term] = { v: Number(b.v.toFixed(4)), a: Number(((b.a + 1) / 2).toFixed(4)) };
          // 同时存中文映射，供 lexicon 合并用：值存原始 term 坐标
          result['__zh__' + b.term] = zh.trim();
        } else { failed++; }
      }
      done += batch.length;
      if (done % 3000 < BATCH) {
        fs.writeFileSync(OUT, JSON.stringify(result));
        console.log(`进度: ${done}/${todo.length}，已翻译 ${Object.keys(result).filter(k => !k.startsWith('__zh__')).length} 词，失败 ${failed}`);
      }
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      console.error('批次失败（重试下一批）:', e.message);
      failed += batch.length;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(result));
  console.log('翻译完成。词条:', Object.keys(result).filter(k => !k.startsWith('__zh__')).length, '| 中文映射:', Object.keys(result).filter(k => k.startsWith('__zh__')).length);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
