const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('你好, Mo-Home');
});

app.listen(port, () => {
  console.log(`服务已启动，访问端口: ${port}`);
});
app.get('/test-db', async (req, res) => {
  const { data, error } = await supabase
    .from('settings')
    .select('*')
    .limit(1);

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true, data });
});