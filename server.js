const express = require('express');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

const baseUrl = process.env.SUPABASE_URL_V2;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

// 根路由
app.get('/', (req, res) => {
  res.send('你好，Mo-Home 正在运行');
});

// 测试数据库连接 - 用 REST API 方式
app.get('/test-db', (req, res) => {
  // 直接从环境变量读取完整的 Supabase URL
  const baseUrl = process.env.SUPABASE_URL;
  // 构造完整的请求路径
  const fullUrl = `${baseUrl}/rest/v1/settings?select=*&limit=1`;

  // 使用 fetch（Node 18+ 原生支持）发送 GET 请求
  fetch(fullUrl, {
    method: 'GET',
    headers: {
      'apikey': process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
    }
  })
  .then(response => response.json())
  .then(data => {
    res.json({ success: true, data });
  })
  .catch(err => {
    res.status(500).json({ error: err.message });
  });
});