// CVAW 词表繁转简：读 emotion-lexicon-academic.json，把繁体词批量转简体（qwen）
// 生成同结构的简体版（繁体保留，简体 key 新增，繁简同形跳过）；写回 academic.json
// 用法：node scripts/convert-t2s.js
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const KEY = process.env.DASHSCOPE_API_KEY;
if (!KEY) { console.error('缺少 DASHSCOPE_API_KEY'); process.exit(1); }

const ACADEMIC = 'E:/Mo-Home/emotion-lexicon-academic.json';
const BATCH = 200;

async function convertBatch(words) {
  const system = '你是繁简转换器。把繁体中文词转换为简体中文。逐行输出，每行一条，格式：繁体词=简体词；若该词繁简相同，输出 繁体词=繁体词。不要输出其他文字。';
  const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({
      model: process.env.TRANSLATE_MODEL || 'qwen-turbo',
      messages: [{ role: 'system', content: system }, { role: 'user', content: words.join('\n') }],
      max_tokens: 3000,
      temperature: 0.1,
      stream: false
    })
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  const raw = String(data.choices?.[0]?.message?.content || '');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const t = line.slice(0, idx).trim();
    const s = line.slice(idx + 1).trim();
    if (words.includes(t) && s) out[t] = s;
  }
  return out;
}

(async () => {
  const lexicon = JSON.parse(fs.readFileSync(ACADEMIC, 'utf8'));
  const words = Object.keys(lexicon);
  console.log('待转换词数:', words.length);
  let added = 0;
  for (let i = 0; i < words.length; i += BATCH) {
    const batch = words.slice(i, i + BATCH);
    try {
      const map = await convertBatch(batch);
      for (const [t, s] of Object.entries(map)) {
        if (s === t) continue; // 繁简同形
        if (lexicon[s]) continue; // 已有简体
        lexicon[s] = lexicon[t]; // 简体 key 复用坐标
        added++;
      }
      console.log(`进度: ${Math.min(i + BATCH, words.length)}/${words.length}，新增简体 ${added}`);
      await new Promise(r => setTimeout(r, 120));
    } catch (e) {
      console.error('批次失败:', e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  fs.writeFileSync(ACADEMIC, JSON.stringify(lexicon));
  console.log('完成。词典词数:', Object.keys(lexicon).length, '（新增简体', added, '）');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
