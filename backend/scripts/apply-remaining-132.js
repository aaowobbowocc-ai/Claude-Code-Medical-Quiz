// 套用剩 132 筆 nutrition 112110 的 Vision OCR 答案
// 證據：手動比對 Q1-11 完全相同、Q12 開始 stored 全部下移一位 → scraper 有 off-by-1 bug
// Vision OCR 是直接從官方答案 PDF 圖像讀的，最可信
const fs = require('fs');
const path = require('path');
const BACKEND = path.resolve(__dirname, '..');

const log = JSON.parse(fs.readFileSync(path.join(BACKEND, '_tmp', 'vision-recheck-v2-log.json'), 'utf-8'));
const verifyLog = JSON.parse(fs.readFileSync(path.join(BACKEND, '_tmp', 'pdfjs-verify-log.json'), 'utf-8'));

const mc = {};
for (const m of log.full) mc[m.source] = (mc[m.source] || 0) + 1;
const appliedKeys = new Set(verifyLog.full.map(x => x.exam + '|' + x.qid + '|' + x.num));
const disagree = log.full.filter(m => mc[m.source] >= 16 && !appliedKeys.has(m.examId + '|' + m.qid + '|' + m.num));

const fp = path.join(BACKEND, 'questions-nutrition.json');
const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
const arr = data.questions || data;
const idIndex = new Map();
for (const q of arr) idIndex.set(String(q.id), q);

let applied = 0;
for (const m of disagree) {
  const q = idIndex.get(String(m.qid));
  if (!q) continue;
  if (!/^[ABCD]$/.test(m.new)) continue;
  if (q.answer === m.new) continue;
  q.answer = m.new;
  q.vision_uncertain = false;
  q.disputed = true;
  applied++;
}
fs.writeFileSync(fp, JSON.stringify(data));
console.log('Applied', applied, 'changes to nutrition');
