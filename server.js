const express = require('express');
// ⭐️ 第一步：先引入 ws 并挂载到全局（一定要在引入 Supabase 之前！）
const WebSocket = require('ws');
global.WebSocket = WebSocket;

// ⭐️ 第二步：然后再引入 Supabase
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
// 这里不需要再传 { transport: WebSocket } 了，因为上面已经挂载到全局
const supabase = createClient(supabaseUrl, supabaseKey);
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