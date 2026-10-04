// 全量重算记忆向量。
// ⚠️ 换嵌入模型/供应商后【必须】跑一次：跨模型的向量空间不通用，混着用召回会变乱。
// 供应商与模型跟 server.js 共用同一组环境变量：
//   AEVUM_EMBED_STYLE / AEVUM_EMBED_BASE_URL / AEVUM_EMBED_API_KEY / AEVUM_EMBED_MODEL / AEVUM_EMBED_DIM
//   （cloudflare 方式另需 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN）
//
// 用法（Supabase 在国内常被阻断，需走代理）：
//   HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 \
//   NODE_USE_ENV_PROXY=1 NO_PROXY=api.cloudflare.com \
//   node scripts/reindex-embeddings-qwen.js
//   注：Node 24 默认不认 HTTPS_PROXY，必须同时给 NODE_USE_ENV_PROXY=1。
//
// 说明：重复跑会全量重算（幂等但浪费额度）；单行失败会重试并跳过，不再中断整轮。
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
if (!fs.existsSync(envFile)) {
  console.error('缺少 .env（放项目根目录，至少要有 SUPABASE_URL_V2 / SUPABASE_ANON_KEY_V2，以及嵌入供应商的 key）');
  process.exit(1);
}
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL_V2, process.env.SUPABASE_ANON_KEY_V2);

const STYLE = (process.env.AEVUM_EMBED_STYLE || 'openai').toLowerCase();
const BASE_URL = process.env.AEVUM_EMBED_BASE_URL || process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const API_KEY = process.env.AEVUM_EMBED_API_KEY || process.env.DASHSCOPE_API_KEY;
const MODEL = process.env.AEVUM_EMBED_MODEL || 'qwen3.7-text-embedding';
const DIM = process.env.AEVUM_EMBED_DIM === undefined ? 1024 : (Number(process.env.AEVUM_EMBED_DIM) || 0);

console.log(`嵌入供应商: ${STYLE} | 模型: ${MODEL} | 维度: ${DIM > 0 ? DIM : '(由供应商决定)'}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 网络抖动重试：Supabase 走代理时偶发 fetch failed，不重试会把整轮跑挂
async function withRetry(label, fn, attempts = 5) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts) await sleep(400 * i);
    }
  }
  throw new Error(`${label}连续 ${attempts} 次失败: ${lastErr && lastErr.message}`);
}

async function embedOnce(text) {
  const input = String(text || '').slice(0, 800);
  let resp;
  if (STYLE === 'cloudflare') {
    const acc = process.env.CLOUDFLARE_ACCOUNT_ID;
    const tok = process.env.CLOUDFLARE_API_TOKEN;
    if (!acc || !tok) { console.error('缺少 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN'); process.exit(1); }
    resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/ai/run/${MODEL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok}` },
      body: JSON.stringify({ text: [input] }),
      signal: AbortSignal.timeout(20000)
    });
  } else {
    resp = await fetch(`${BASE_URL.replace(/\/?$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, input, ...(DIM > 0 ? { dimensions: DIM } : {}), encoding_format: 'float' }),
      signal: AbortSignal.timeout(20000)
    });
  }
  if (!resp.ok) {
    const t = await resp.text();
    if (resp.status === 429 || /quota|exhausted|Free tier|rate limit/i.test(t)) {
      console.error('⛔ 额度/限流问题，停止:', t.slice(0, 150));
      process.exit(2);
    }
    throw new Error(`HTTP ${resp.status} ${t.slice(0, 100)}`);
  }
  const data = await resp.json();
  const raw = STYLE === 'cloudflare'
    ? (Array.isArray(data?.result?.data) && Array.isArray(data.result.data[0]) ? data.result.data[0] : data?.result?.data)
    : data?.data?.[0]?.embedding;
  if (!Array.isArray(raw) || !raw.length) throw new Error('返回里没有向量');
  if (DIM > 0 && raw.length !== DIM) {
    console.error(`⚠️ 维度不符：期望 ${DIM}，实际 ${raw.length} —— 先确认 pgvector 列，不要写库`);
    process.exit(3);
  }
  return raw;
}

async function embed(text) {
  try {
    return await withRetry('嵌入', () => embedOnce(text), 4);
  } catch (e) {
    console.error('嵌入失败:', e.message);
    return null;
  }
}

(async () => {
  let offset = 0;
  const BATCH = 50;
  let done = 0, fail = 0, skip = 0;
  const failedIds = [];
  while (true) {
    // 必须显式 order：否则分页顺序不确定，边更新边翻页会漏行/重复行
    const page = await withRetry('查询', async () => {
      const { data, error } = await supabase
        .from('aevum_memories')
        .select('id, content, title')
        .eq('status', 'active')
        .order('id', { ascending: true })
        .range(offset, offset + BATCH - 1);
      if (error) throw new Error(error.message);
      return data;
    });
    if (!page || !page.length) break;
    offset += page.length;

    for (const r of page) {
      const text = String(r.content || r.title || '').trim();
      if (text.length < 2) { skip++; continue; }
      const emb = await embed(text);
      if (!emb) { fail++; failedIds.push(r.id); continue; }
      try {
        await withRetry('写入', async () => {
          const up = await supabase.from('aevum_memories').update({ embedding: emb }).eq('id', r.id);
          if (up.error) throw new Error(up.error.message);
        });
        done++;
      } catch (e) {
        fail++; failedIds.push(r.id);
        console.error(`写入失败 id=${r.id}: ${e.message}`);
      }
    }
    console.log(`进度: 已处理 ${offset} 条 | 成功 ${done} 失败 ${fail} 跳过 ${skip}`);
    await sleep(150);
  }
  console.log(`\n✅ 重算完成: 成功 ${done} 失败 ${fail} 跳过 ${skip}`);
  if (failedIds.length) {
    console.log(`⚠️ 失败 id（再跑一次即可补齐）: ${failedIds.slice(0, 40).join(',')}${failedIds.length > 40 ? ` …共 ${failedIds.length} 条` : ''}`);
  }
})().catch((e) => { console.error('错误:', e.message); process.exit(1); });
