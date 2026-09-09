// 验证 deepseek-v4-pro 模型名是否被 API 接受（小请求测试）
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const key = process.env.DEEPSEEK_API_KEY;
console.log('有 DEEPSEEK_API_KEY:', !!key, key ? '(长度' + key.length + ')' : '(本地可能没有，Render 上才有)');
if (!key) { console.log('本地无 key，无法验证——此测试需在 Render 跑或本地配 key'); return; }
(async () => {
  for (const model of ['deepseek-v4-pro', 'deepseek-v4-flash']) {
    try {
      const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5, stream: false }),
        signal: AbortSignal.timeout(20000)
      });
      const t = await resp.text();
      console.log(`\n${model}: HTTP ${resp.status}`);
      if (!resp.ok) console.log('  错误:', t.slice(0, 300));
      else {
        const j = JSON.parse(t);
        console.log('  ✅ 可用, 返回 model:', j.model || j.choices?.[0]?.message?.content ? 'ok' : '?');
      }
    } catch (e) {
      console.log(`\n${model}: 异常`, e.message);
    }
  }
})().catch(e => console.error(e.message));
