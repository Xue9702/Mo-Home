const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('你好, Mo-Home 正在运行');
});

// ⭐️ 测试连接 Supabase
app.get('/test-db', async (req, res) => {
  try {
    const baseUrl = process.env.SUPABASE_URL_V2;
    const supabaseKey = process.env.SUPABASE_ANON_KEY_V2;

    console.log('🔑 开始连接 Supabase，URL 读取情况:', baseUrl ? '已读取' : '为空!!!');

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

// 测试写入 Supabase
app.get('/test-write', async (req, res) => {
  const baseUrl = process.env.SUPABASE_URL_V2;
  const supabaseKey = process.env.SUPABASE_ANON_KEY_V2;

  if (!baseUrl || !supabaseKey) {
    return res.status(500).json({
      error: '环境变量缺失',
      hasUrl: !!baseUrl,
      hasKey: !!supabaseKey
    });
  }

  try {
    const testMessage = {
      session_id: 1,
      role: 'user',
      content: '这是一条来自 /test-write 的测试消息',
      visible: true,
      created_at: new Date().toISOString()
    };

    const url = `${baseUrl}/rest/v1/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testMessage)
    });

    let data = null;
    const text = await response.text();

    if (text && text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        if (response.ok) {
          return res.json({
            success: true,
            message: '写入成功（返回内容非JSON）',
            raw: text.substring(0, 200)
          });
        }
        return res.status(500).json({
          error: '响应不是有效的JSON',
          raw: text.substring(0, 200)
        });
      }
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: '写入失败',
        status: response.status,
        details: data
      });
    }

    res.json({
      success: true,
      message: '测试消息写入成功',
      data: data
    });
  } catch (err) {
    console.error('写入测试失败:', err.message);
    res.status(500).json({
      error: err.message,
      type: err.name
    });
  }
});

// 测试直接 Fetch
app.get('/test-fetch', async (req, res) => {
  const baseUrl = process.env.SUPABASE_URL_V2;
  const supabaseKey = process.env.SUPABASE_ANON_KEY_V2;

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
      url: url.replace(baseUrl, '***')
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
  }
});

// 测试环境变量
app.get('/env-test', (req, res) => {
  res.json({
    hasUrl: !!process.env.SUPABASE_URL_V2,
    hasKey: !!process.env.SUPABASE_ANON_KEY_V2,
    urlPrefix: process.env.SUPABASE_URL_V2?.substring(0, 30)
  });
});

// 🌟 重点修改：删掉 module.exports，加上这个 Render 需要的启动代码！
app.listen(port, () => {
  console.log(`✅ 服务已启动，访问端口: ${port}`);
});