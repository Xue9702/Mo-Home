// 图片型 PDF 视觉识别：渲染每页 → DashScope 视觉模型逐页识别 → 汇总
// 用法：node scripts/pdf-vision.js <pdf路径> <输出txt路径>
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

// 加载 .env
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const KEY = process.env.DASHSCOPE_API_KEY;
if (!KEY) { console.error('缺少 DASHSCOPE_API_KEY'); process.exit(1); }

const pdfPath = process.argv[2];
const outPath = process.argv[3] || 'E:/Mo-Home/docs/pdf-vision-output.txt';
const pageDir = path.join(path.dirname(outPath), '.pdf-vision-pages');
fs.mkdirSync(pageDir, { recursive: true });

async function visionDescribe(dataUrl, pageNo) {
  const prompt = `这是教程 PDF 的第 ${pageNo} 页截图。请完整转述这一页的所有文字内容（逐字），并说明页面的结构（标题/步骤/图表/代码块等）。如果是代码，请完整转述代码。不要省略任何文字。`;
  const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({
      model: process.env.VISION_MODEL || 'qwen3.5-omni-plus',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: prompt }
      ]}],
      stream: false,
      max_tokens: 1500
    })
  });
  if (!resp.ok) return `（第${pageNo}页识别失败 HTTP ${resp.status}）`;
  const json = await resp.json();
  return json.choices?.[0]?.message?.content || '（空）';
}

(async () => {
  const buf = fs.readFileSync(pdfPath);
  const p = new PDFParse({ data: buf });
  const info = await p.getInfo({ parsePageInfo: true });
  const total = info.total;
  console.log('总页数:', total);
  const shot = await p.getScreenshot({ scale: 1.5, imageDataUrl: true });
  const parts = [];
  for (const pg of shot.pages) {
    const no = pg.pageNumber;
    const pngPath = path.join(pageDir, `page-${String(no).padStart(2, '0')}.png`);
    if (pg.dataUrl) fs.writeFileSync(pngPath, Buffer.from(pg.dataUrl.split(',')[1], 'base64'));
    console.log(`识别第 ${no} 页...`);
    const desc = await visionDescribe(pg.dataUrl, no);
    parts.push(`\n\n========== 第 ${no} 页 ==========\n${desc}`);
    fs.writeFileSync(outPath, parts.join('')); // 增量写，中断不丢
  }
  await p.destroy();
  console.log('完成，输出:', outPath);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
