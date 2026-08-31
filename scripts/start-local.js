// 本地开发启动器：加载 .env 后启动 server.js
// 用法：node scripts/start-local.js [PORT]
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
process.env.PORT = process.argv[2] || process.env.PORT || '3000';
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  stdio: 'inherit',
  env: process.env
});
child.on('exit', (code) => process.exit(code));
