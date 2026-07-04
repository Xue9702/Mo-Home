const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

const baseUrl = process.env.SUPABASE_URL_V2;
const supabaseKey = process.env.SUPABASE_ANON_KEY_V2;

// ⭐️ Vercel 运行日志里会打印出完整的 baseUrl，帮我们确认它到底有没有读到。
console.log('🔑 尝试读取 Supabase URL:', baseUrl ? '成功读取' : '读取为空!!!');

const supabase = createClient(baseUrl, supabaseKey);

app.get('/', (req, res) => {
  res.send('你好, Mo-Home 正在运行');
});

app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*').limit(1);
    if (error) {
      return res.status(500).json({ error: error.message, details: error.details });
    }
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ⭐️ 保留这个即可，绝对不能有 app.listen！
module.exports = app;