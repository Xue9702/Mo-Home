const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('你好, Mo-Home');
});

app.listen(port, () => {
  console.log(`服务已启动，访问端口: ${port}`);
});
const { createClient } = require('@supabase/supabase-js');

// 测试 Supabase 连接的路由
app.get('/test-dp', async (req, res) => {
    try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_ANON_KEY;
        const supabase = createClient(supabaseUrl, supabaseKey);

        // 尝试查一个表（请把 '你的表名' 换成你 Supabase 里真实存在的表名，比如 'users' 或 'test'）
        const { data, error } = await supabase.from('你的表名').select('*').limit(1);

        if (error) {
            return res.status(500).json({ error: error.message });
        }
        res.json({ success: true, message: 'Supabase 连接成功！', data: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});