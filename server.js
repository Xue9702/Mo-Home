const express = require('express');
// 1. 引入 Supabase 的依赖包
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// 2. 利用 Zeabur 环境变量创建 Supabase 客户端
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const WebSocket = require('ws');
global.WebSocket = WebSocket; // ⭐️ 强制让 Node 18 认领这个 WebSocket 包
const supabase = createClient(supabaseUrl, supabaseKey, { transport: WebSocket });

app.get('/', (req, res) => {
  res.send('你好, Mo-Home');
});

// 3. 测试 Supabase 连接的路由（注意这里是 /test-db，和浏览器一致）
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