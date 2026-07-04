const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('你好, Mo-Home 正在运行');
});

// ⭐️ 我们把 Supabase 的连接放进路由里面！
// 这样即使环境变量没读到， app 也能成功导出并运行起来。
app.get('/test-db', async (req, res) => {
  try {
    // 在这里读取环境变量
    const baseUrl = process.env.SUPABASE_URL_V2;
    const supabaseKey = process.env.SUPABASE_ANON_KEY_V2;

    console.log('🔑 开始连接 Supabase，URL 读取情况:', baseUrl ? '已读取' : '为空!!!');

    // 在这里初始化 Supabase
    const supabase = createClient(baseUrl, supabaseKey);

    const { data, error } = await supabase.from('settings').select('*').limit(1);

    if (error) {
      return res.status(500).json({ error: error.message, details: error.details });
    }
    
    res.json({ success: true, data: data });
  } catch (err) {
    console.error('请求出错:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 这就是 Vercel 需要的导出
module.exports = app;