// 测试阿里百炼视觉模型：当前默认模型 + 几个备选，看哪个能真的返回描述
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const KEY = process.env.DASHSCOPE_API_KEY;
const BASE = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/?$/, '');
console.log('DASHSCOPE_API_KEY 长度:', KEY ? KEY.length : '(缺失!)');
console.log('BASE:', BASE);

// 1x1 红色 PNG（最小可用测试图）
const PNG_RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function tryModel(model) {
  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: PNG_RED } },
        { type: 'text', text: '这张图是什么颜色？一句话回答。' }
      ]
    }],
    stream: false,
    max_tokens: 100
  };
  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000)
    });
    const txt = await r.text();
    if (!r.ok) {
      console.log(`  ${model}: HTTP ${r.status} → ${txt.slice(0, 200)}`);
      return;
    }
    let j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (content && String(content).trim()) {
      console.log(`  ${model}: ✅ 返回「${String(content).trim().slice(0, 60)}」`);
    } else {
      console.log(`  ${model}: ⚠️ HTTP 200 但 content 为空 → ${txt.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`  ${model}: ❌ 异常 ${e.message}`);
  }
}

(async () => {
  const models = [
    process.env.VISION_MODEL || 'qwen3.5-omni-plus',
    'qwen3-vl-plus',
    'qwen3-vl-flash',
    'qwen-vl-max',
    'qwen-vl-plus',
    'qwen2.5-vl-72b-instruct'
  ];
  console.log('\n=== 逐个测试视觉模型 ===');
  for (const m of models) {
    await tryModel(m);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
