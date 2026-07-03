// 1. 引入 ws 并绑定到全局对象
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket; // 用 globalThis 更保险

// 2. 引入 Express 和 Supabase
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
// 3. 明确把 WebSocket 当做参数传过去
const supabase = createClient(supabaseUrl, supabaseKey, { transport: WebSocket });
app.get('/test-db', async (req, res) => {
  try {
    // 尝试查询 settings 表的第一条数据
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .limit(1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    // 成功的话，把数据返回给浏览器
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`服务已启动，访问端口: ${port}`);
});