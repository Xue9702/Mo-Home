const express = require('express');
const app = express();
const port = 3000;

app.get('/', (req, res) => {
  res.send('你好，Mo-Home 正在运行');
});

app.listen(port, () => {
  console.log(`服务已启动：http://localhost:${port}`);
});