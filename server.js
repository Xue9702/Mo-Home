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
app.get('/test-fetch', async (req, res) => {
  const baseUrl = process.env.SUPABASE_URL_V2;
  const supabaseKey = process.env.SUPABASE_ANON_KEY_V2;

  // 先返回诊断信息，看看环境变量是否被读取
  if (!baseUrl || !supabaseKey) {
    return res.status(500).json({
      error: '环境变量未读取',
      hasUrl: !!baseUrl,
      hasKey: !!supabaseKey,
      urlValue: baseUrl ? '已设置' : '未设置'
    });
  }

  try {
    const url = `${baseUrl}/rest/v1/settings?select=*&limit=1`;
    const response = await fetch(url, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    const data = await response.json();
    res.json({
      success: true,
      status: response.status,
      data: data,
      url: url.replace(baseUrl, '***') // 隐藏真实URL
    });
} catch (err) {
  console.error('=== test-db 错误详细信息 ===');
  console.error('错误类型:', err.name);
  console.error('错误信息:', err.message);
  console.error('错误堆栈:', err.stack);
  console.error('===========================');
  res.status(500).json({
    error: err.message,
    type: err.name,
    diagnostics: {
      url: url,
      hasUrl: !!process.env.SUPABASE_URL_V2,
      hasKey: !!process.env.SUPABASE_ANON_KEY_V2
    }
  });
}app.get('/env-test', (req, res) => {
  res.json({
    hasUrl: !!process.env.SUPABASE_URL_V2,
    hasKey: !!process.env.SUPABASE_ANON_KEY_V2,
    urlPrefix: process.env.SUPABASE_URL_V2?.substring(0, 30)
  });
});
});
// 这就是 Vercel 需要的导出
module.exports = app;