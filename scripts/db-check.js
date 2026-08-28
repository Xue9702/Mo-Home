// 本地数据库诊断：查看记忆书/候选/版本的实际情况
// 用法：node scripts/db-check.js
// key 从 .env 读取（gitignore 保护，绝不入库）
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const url = process.env.SUPABASE_URL_V2;
const key = process.env.SUPABASE_ANON_KEY_V2;
if (!url || !key) { console.error('缺少 SUPABASE_URL_V2 / SUPABASE_ANON_KEY_V2'); process.exit(1); }
const supabase = createClient(url, key);

(async () => {
  console.log('=== 记忆书 ===');
  const { data: books, error: be } = await supabase
    .from('aevum_books').select('id, label, created_at, updated_at, updated_count')
    .order('updated_at', { ascending: false }).limit(30);
  if (be) console.log('books 查询失败:', be.message);
  else for (const b of (books || [])) {
    const created = b.created_at ? new Date(b.created_at).toISOString().slice(0, 16) : '?';
    const updated = b.updated_at ? new Date(b.updated_at).toISOString().slice(0, 16) : '?';
    console.log(`#${b.id} [${b.label}] created=${created} updated=${updated} updated_count=${b.updated_count}`);
  }

  console.log('\n=== 候选状态分布 ===');
  const { data: cands, error: ce } = await supabase.from('aevum_book_candidates').select('book_id, status');
  if (ce) console.log('candidates 查询失败:', ce.message);
  else {
    const byBook = {};
    for (const c of (cands || [])) (byBook[c.book_id] = byBook[c.book_id] || {})[c.status] = (byBook[c.book_id]?.[c.status] || 0) + 1;
    for (const [bid, st] of Object.entries(byBook)) console.log(`book ${bid}:`, JSON.stringify(st));
  }

  console.log('\n=== 版本数量 ===');
  const { data: vers, error: ve } = await supabase.from('aevum_book_versions').select('book_id, version_no');
  if (ve) console.log('versions 查询失败:', ve.message);
  else {
    const byBook = {};
    for (const v of (vers || [])) byBook[v.book_id] = (byBook[v.book_id] || 0) + 1;
    for (const [bid, n] of Object.entries(byBook)) console.log(`book ${bid}: ${n} 个版本`);
    if (!Object.keys(byBook).length) console.log('（无版本记录）');
  }

  console.log('\n=== 记忆书单元数 ===');
  const { data: items, error: ie } = await supabase.from('aevum_book_items').select('book_id');
  if (ie) console.log('items 查询失败:', ie.message);
  else {
    const byBook = {};
    for (const r of (items || [])) byBook[r.book_id] = (byBook[r.book_id] || 0) + 1;
    for (const [bid, n] of Object.entries(byBook)) console.log(`book ${bid}: ${n} 个单元`);
  }
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
