const express = require('express');
const app = express();

// 读取新命名的环境变量（注意这里确保名字和 Vercel 里的完全一致）
const supabaseUrl = process.env.SUPABASE_URL_V2;
const supabaseKey = process.env.SUPABASE_ANON_KEY_V2;

// 根路由
app.get('/', (req, res) => {
  res.send('你好，Mo-Home 正在运行');
});

// 测试数据库连接 - 用 REST API 方式
app.get('/test-db', async (req, res) => {
  // 直接用上面定义好的 V2 变量
  const fullUrl = `${supabaseUrl}/rest/v1/settings?select=*&limit=1`;

  try {
    const response = await fetch(fullUrl, {
      method: 'GET',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    const data = await response.json();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 【极其关键的一步！】Vercel 必须有这个导出，不能用 app.listen
module.exports = app;