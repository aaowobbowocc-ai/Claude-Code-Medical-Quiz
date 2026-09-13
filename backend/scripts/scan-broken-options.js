#!/usr/bin/env node
/**
 * 掃出「選項被拆碎／題幹漏進選項」的題，依卷（exam_code + subject_tag）彙總排序，
 * 好決定 fix-column-fragments.js 要先修哪幾卷。
 *
 * 判定訊號（任一成立即算破損，取最強的那個當理由）：
 *   stem-leak  選項是題幹的一段（長度 ≥6）→ 題幹漏進選項，最嚴重
 *   frag-head  選項以接續符號開頭（～ - ， ） 、 等）→ 明顯是被切斷的後半段
 *   frag-tail  選項以連接符號結尾（～ - （ ，）→ 被切斷的前半段
 *   tiny-pair  兩個以上選項極短(≤4)且其中含純數字 → 數值選項被拆
 *
 * 用法：
 *   node scripts/scan-broken-options.js            依卷彙總
 *   node scripts/scan-broken-options.js --list <file> <exam_code> <tag>   列出該卷細節
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');
const norm = (x) => String(x || '').replace(/\s+/g, '');

function diagnose(q) {
  const opts = ['A', 'B', 'C', 'D'].map(k => String((q.options || {})[k] || ''));
  if (opts.some(o => !o)) return null;
  const stem = norm(q.question);

  // 題幹只剩「(A)… (B)…」的選項列 → 題幹整個遺失（克漏字常見），不是選項碎片
  if (/\(A\)/.test(q.question) && /\(B\)/.test(q.question)) return 'no-stem';

  for (const o of opts) {
    const n = norm(o);
    // 題幹要明顯比選項長，否則像上面那種「題幹＝選項列」會全部誤判
    if (n.length >= 6 && stem.length > n.length * 2 && stem.includes(n)) return 'stem-leak';
  }
  // 負號開頭的數值是合法選項（-2.00 D 屈光度、-11.00DS…），不能當碎片
  const fragHead = (o) => /^[～~，,）)、。]/.test(o) || (/^[-－]/.test(o) && !/^[-－]\s*[\d.]/.test(o));
  // 結尾的 - 可能是離子價數（HCO3-、Cl-），只在前面不是英數時才算碎片
  const fragTail = (o) => /[～~（(，,]$/.test(o) || (/[-－]$/.test(o) && !/[A-Za-z0-9)]\s*[-－]$/.test(o));
  if (opts.some(o => fragHead(o.trim()))) return 'frag-head';
  if (opts.some(o => fragTail(o.trim()))) return 'frag-tail';

  // 複選組合題的選項本來就長成「123」「僅23」「①③④」，不是碎片，要先排除
  const combo = (o) => /^[僅只有以上下列\d①-⑳、,，和與及]+$/.test(norm(o));
  if (opts.every(combo)) return null;

  const tiny = opts.filter(o => norm(o).length <= 4);
  if (tiny.length >= 2 && tiny.some(o => /^[\d.]+$/.test(norm(o))) &&
      tiny.some(o => !/^[\d.]+$/.test(norm(o)))) return 'tiny-pair';
  return null;
}

module.exports = { diagnose };
if (require.main !== module) return;

const args = process.argv.slice(2);

if (args[0] === '--list') {
  const [, file, code, tag] = args;
  const j = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  const arr = Array.isArray(j) ? j : j.questions;
  for (const q of arr) {
    if (String(q.exam_code) !== String(code) || q.subject_tag !== tag) continue;
    const why = diagnose(q);
    if (!why) continue;
    console.log(`#${q.number} [${why}] id=${q.id}`);
    console.log(`   ${String(q.question).replace(/\n/g, ' ').slice(0, 70)}`);
    console.log(`   ${JSON.stringify(q.options)}`);
  }
  return;
}

const papers = new Map();
for (const file of fs.readdirSync(DIR).filter(f => /^questions(-.*)?\.json$/.test(f) && !/\.bak/.test(f))) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch { continue; }
  const arr = Array.isArray(j) ? j : j.questions;
  if (!arr) continue;
  for (const q of arr) {
    const why = diagnose(q);
    if (!why) continue;
    const key = `${file}\t${q.exam_code}\t${q.subject_tag}\t${q.roc_year}\t${q.session}\t${q.subject}`;
    const rec = papers.get(key) || { n: 0, why: {} };
    rec.n++; rec.why[why] = (rec.why[why] || 0) + 1;
    papers.set(key, rec);
  }
}

const rows = [...papers.entries()].sort((a, b) => b[1].n - a[1].n);
const total = rows.reduce((s, r) => s + r[1].n, 0);
console.log(`破損題總計 ${total} 題，分布於 ${rows.length} 卷\n`);
console.log('題數  考試'.padEnd(26) + '場次碼   年度      科目            訊號');
const LIMIT = args.includes('--limit') ? +args[args.indexOf('--limit') + 1] : 40;
for (const [key, rec] of rows.slice(0, LIMIT)) {
  const [file, code, tag, year, session, subject] = key.split('\t');
  const exam = file.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
  const why = Object.entries(rec.why).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(
    String(rec.n).padStart(4) + '  ' +
    exam.padEnd(20) + String(code).padEnd(9) +
    `${year}${session}`.padEnd(10) + String(subject).slice(0, 14).padEnd(16) + why);
}
if (rows.length > 40) console.log(`\n…另有 ${rows.length - 40} 卷`);
