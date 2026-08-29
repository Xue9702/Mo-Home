// 分析两个词典文件：编码、词数、值域
const fs = require('fs');

(async () => {
  // CVAW（可能是 utf8 或 gb18030）
  const cvawPath = 'E:/Mo-Home/ChineseEmoBank/CVAW_SD/CVAW_all_SD.csv';
  let cvawText = fs.readFileSync(cvawPath, 'utf8');
  // 检测编码：如果含替换字符 U+FFFD 或乱码，尝试 gb18030
  const hasReplacement = cvawText.includes('\uFFFD');
  const lines = cvawText.split(/\r?\n/).filter(Boolean);
  console.log('CVAW utf8 读：行数', lines.length, '| 有替换符', hasReplacement);
  console.log('CVAW 第1行:', lines[1] || '');
  // 统计 V/A 范围
  let minV = 9, maxV = 0, minA = 9, maxA = 0;
  for (let i = 1; i < Math.min(lines.length, 6000); i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 4) continue;
    const v = Number(cols[2]), a = Number(cols[3]);
    if (isFinite(v)) { minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
    if (isFinite(a)) { minA = Math.min(minA, a); maxA = Math.max(maxA, a); }
  }
  console.log('CVAW V 范围:', minV, '~', maxV, '| A 范围:', minA, '~', maxA);

  // NRC v2.1 unigrams
  const nrcPath = 'E:/Mo-Home/NRC-VAD-Lexicon-v2.1/Unigrams/unigrams-NRC-VAD-Lexicon-v2.1.txt';
  const nrcText = fs.readFileSync(nrcPath, 'utf8');
  const nrcLines = nrcText.split(/\r?\n/).filter(Boolean);
  console.log('\nNRC 行数:', nrcLines.length, '| 表头:', nrcLines[0]);
  let mnV = 9, mxV = -9, mnA = 9, mxA = -9, mnD = 9, mxD = -9;
  for (let i = 1; i < nrcLines.length; i++) {
    const cols = nrcLines[i].split('\t');
    if (cols.length < 4) continue;
    const v = Number(cols[1]), a = Number(cols[2]), d = Number(cols[3]);
    if (isFinite(v)) { mnV = Math.min(mnV, v); mxV = Math.max(mxV, v); }
    if (isFinite(a)) { mnA = Math.min(mnA, a); mxA = Math.max(mxA, a); }
    if (isFinite(d)) { mnD = Math.min(mnD, d); mxD = Math.max(mxD, d); }
  }
  console.log('NRC V 范围:', mnV, '~', mxV, '| A 范围:', mnA, '~', mxA, '| D 范围:', mnD, '~', mxD);
  console.log('NRC 样例 5 行:');
  for (let i = 1; i <= 5; i++) console.log(' ', nrcLines[i]);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
