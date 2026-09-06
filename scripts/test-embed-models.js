// 测试百炼候选文本嵌入模型：返回维度 + 是否可用
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const key = process.env.DASHSCOPE_API_KEY;

const MODELS = [
  'qwen3.7-text-embedding',
  'qwen3.7-text-embedding-flash',
];

async function testModel(model) {
  try {
    const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, input: '测试一下这个嵌入模型的维度', encoding_format: 'float' }),
      signal: AbortSignal.timeout(20000)
    });
    if (!resp.ok) {
      console.log(`${model}: HTTP ${resp.status} ${String(await resp.text()).slice(0, 200)}`);
      return;
    }
    const data = await resp.json();
    const emb = data?.data?.[0]?.embedding;
    console.log(`${model}: ✅ 可用, 维度 = ${Array.isArray(emb) ? emb.length : '无'}`);
  } catch (e) {
    console.log(`${model}: 异常 ${e.message}`);
  }
}

(async () => {
  for (const m of MODELS) await testModel(m);
})().catch(e => console.error(e.message));
