// 本地识图工具：node scripts/vision.js <图片路径> [附言]
// 使用阿里云百炼视觉模型（qwen3.5-omni-plus），key 从本地 .env 读取（不入库）
const fs = require('fs');
const path = require('path');

// 加载 .env（简易解析，支持 # 注释与引号）
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !m[1].startsWith('#') && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const KEY = process.env.DASHSCOPE_API_KEY;
if (!KEY) { console.error('缺少 DASHSCOPE_API_KEY（请在 .env 配置）'); process.exit(1); }

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('用法: node scripts/vision.js <图片路径> [附言]'); process.exit(1); }
const userText = process.argv[3] || '';

const ext = path.extname(file).toLowerCase();
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'image/png';
const dataUrl = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;

const prompt = '请用中文详细描述这张图片：主体内容、整体布局结构（元素如何排列）、文字内容（完整逐字转述）、颜色、风格、氛围等所有细节，越详细越好。'
  + (userText ? `\n用户附言：${userText}` : '');

(async () => {
  const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({
      model: process.env.VISION_MODEL || 'qwen3.5-omni-plus',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: prompt }
      ]}],
      stream: false,
      max_tokens: 1024
    })
  });
  if (!resp.ok) { console.error('HTTP', resp.status, (await resp.text()).slice(0, 500)); process.exit(1); }
  const json = await resp.json();
  console.log(json.choices?.[0]?.message?.content || '(空)');
})().catch(e => { console.error('识图失败:', e.message); process.exit(1); });
