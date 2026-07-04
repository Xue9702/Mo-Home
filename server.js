const express = require('express');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

// 根路由
app.get('/', (req, res) => {
  res.send('你好，Mo-Home 正在运行');
});

// 测试数据库连接 - 用 REST API 方式
app.get('/test-db', (req, res) => {
  const path = '/rest/v1/settings?select=*&limit=1';
  const options = {
    hostname: supabaseUrl.replace('https://', '').replace('.supabase.co', ''),
    path: path,
    method: 'GET',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`
    }
  };

  const request = https.get(options, (response) => {
    let data = '';
    response.on('data', (chunk) => { data += chunk; });
    response.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        res.json({ success: true, data: parsed });
      } catch (err) {
        res.status(500).json({ error: '解析响应失败' });
      }
    });
  });

  request.on('error', (err) => {
    res.status(500).json({ error: err.message });
  });
});

app.listen(port, () => {
  console.log(`服务已启动，访问端口: ${port}`);
});