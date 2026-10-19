// 用真实图片测试识图：当前模型 vs 备选，验证端到端
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const KEY = process.env.DASHSCOPE_API_KEY;
const BASE = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/?$/, '');

const imgPath = 'C:/Users/Kiki_/Desktop/IMG_6152.PNG';
const b64 = fs.readFileSync(imgPath).toString('base64');
const dataUrl = 'data:image/png;base64,' + b64;
console.log('测试图:', imgPath, '| base64 长度:', b64.length);

async function tryModel(model) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: '用中文简要描述这张图片（主体、颜色、内容）。' }
          ]
        }],
        stream: false,
        max_tokens: 300
      }),
      signal: AbortSignal.timeout(90000)
    });
    const txt = await r.text();
    const ms = Date.now() - t0;
    if (!r.ok) { console.log(`\n${model} ❌ HTTP ${r.status} (${ms}ms)\n  ${txt.slice(0, 250)}`); return; }
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (c && String(c).trim()) console.log(`\n${model} ✅ (${ms}ms)\n  ${String(c).trim().slice(0, 200)}`);
    else console.log(`\n${model} ⚠️ HTTP200 但空内容 (${ms}ms)\n  原始: ${txt.slice(0, 300)}`);
  } catch (e) {
    console.log(`\n${model} ❌ 异常: ${e.message}`);
  }
}

(async () => {
  for (const m of [process.env.VISION_MODEL || 'qwen3.5-omni-plus', 'qwen3-vl-plus']) {
    await tryModel(m);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
