#!/usr/bin/env node
/**
 * 一個場次一次抓完所有科目的更正紀錄。
 *
 * 考選部有「**測驗式試題標準答案更正清冊**」，整場次一份，列出每一個科目的
 * 標準答案與備註（「無更正紀錄」或「第34題答Ｂ或Ｄ或BD者均給分」）。
 * 網址就是答案卷那支，但 `t=A` 而且**不帶 c/s**：
 *   wHandExamQandA_File.ashx?t=A&code=113090&c=&s=&q=1
 *
 * 比一卷一卷抓 `t=M` 划算太多：全站 3,763 卷只對應 125 個場次碼，
 * 而且更正卷只有「有更正」的卷才有，沒有的卷會白跑一趟。
 *
 * 清冊的版面（每個科目一段，以「等級名稱：」分段）：
 *   等級名稱：高等考試 科目代碼： 科目名稱：醫學（二）（包括…） 2301
 *   每題配分：1.0分 題數：100題 題號 01 - 10 … 答案 BCDBCDBBCC …
 *   類科名稱：醫師(一) 備註: 第34題答Ｂ或Ｄ或BD者均給分，第83題答…
 *
 *   node scripts/fetch-session-corrections.js [--code=113090] [--json=out.json]
 */
const fs = require('fs');
const path = require('path');
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher');
const { pdfText } = require('./lib/moex-paper-resolve');

const BK = path.join(__dirname, '..');
const CACHE = path.join(BK, '_tmp', 'moex-session-corrections');
const UA = 'Mozilla/5.0';
const REF = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx';
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const onlyCode = arg('code');
const outPath = arg('json');

const FW = { 'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D', 'Ｅ': 'E' };
const half = s => String(s).replace(/[ＡＢＣＤＥ]/g, c => FW[c]);

/** 備註 → { 題號: 給分的答案 }。字母是全形，「一律給分」沒有字母。 */
function parseRemark(text) {
  const out = {};
  const t = half(String(text || '')).replace(/\s+/g, '');
  const re = /第(\d{1,3})題[，,]?([^第]{0,120}?給分)/g;
  let m;
  while ((m = re.exec(t))) {
    const letters = [...new Set((m[2].match(/[A-E]/g) || []))].sort();
    out[+m[1]] = letters.length ? letters.join(',') : '送分';
  }
  return out;
}

/** 整份清冊 → 每個科目一筆 */
function parseSheet(text) {
  const t = String(text || '').replace(/[ \t　]+/g, ' ');
  const out = [];
  for (const seg of t.split('等級名稱：').slice(1)) {
    const subj = /科目名稱[：:]\s*([^\n]+?)\s+(\d{3,4})\s+每題配分/.exec(seg);
    const cnt = /題數[：:]\s*(\d{1,3})\s*題/.exec(seg);
    const cls = /類科名稱[：:]\s*([^\s]+)/.exec(seg);
    const note = /備註[：:]\s*([\s\S]*?)(?=\s*\d{2,3} - \d{2,3}|\s*等級名稱|$)/.exec(seg);
    if (!subj) continue;
    const remark = note ? note[1].replace(/\s+/g, ' ').trim() : '';
    out.push({
      subject: subj[1].trim(),
      subjectCode: subj[2],
      count: cnt ? +cnt[1] : null,
      klass: cls ? cls[1].trim() : '',
      remark,
      corrections: /無更正紀錄/.test(remark) ? {} : parseRemark(remark),
    });
  }
  return out;
}

async function sessionSheet(code) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, `${code}.txt`);
  if (fs.existsSync(f) && fs.statSync(f).size > 500) return fs.readFileSync(f, 'utf8');
  let buf;
  try { buf = await fetchPdf(buildMoexUrl('A', code, '', ''), { userAgent: UA, referer: REF }); }
  catch { return null; }
  if (!buf || buf.length < 1000) return null;
  const txt = await pdfText(buf);
  fs.writeFileSync(f, txt, 'utf8');
  return txt;
}

module.exports = { sessionSheet, parseSheet, parseRemark };

if (require.main === module) (async () => {
  const codes = new Set();
  for (const f of fs.readdirSync(BK).filter(x => /^questions(-[a-z0-9-]*)?\.json$/.test(x) && !/\.bak/.test(x))) {
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    for (const q of (Array.isArray(j) ? j : j.questions)) {
      if (/^\d{6}$/.test(String(q.exam_code || ''))) codes.add(String(q.exam_code));
    }
  }
  const list = [...codes].sort().filter(c => !onlyCode || c === onlyCode);
  const all = {};
  let withFix = 0, papers = 0, none = 0;
  for (const code of list) {
    const txt = await sessionSheet(code);
    if (!txt) { none++; console.log(`✗ ${code} 抓不到清冊`); continue; }
    const recs = parseSheet(txt);
    papers += recs.length;
    const fixes = recs.filter(r => Object.keys(r.corrections).length);
    withFix += fixes.length;
    all[code] = recs;
    console.log(`${code}  科目 ${String(recs.length).padStart(3)}｜有更正 ${String(fixes.length).padStart(2)}`
      + (fixes.length ? '  ' + fixes.slice(0, 2).map(r => `${r.klass}/${r.subject.slice(0, 10)}:${Object.entries(r.corrections).map(([n, a]) => `#${n}→${a}`).join(',')}`).join('  ') : ''));
  }
  console.log(`\n場次 ${list.length}｜科目 ${papers}｜有更正的科目 ${withFix}｜抓不到 ${none}`);
  if (outPath) { fs.writeFileSync(path.join(BK, outPath), JSON.stringify(all, null, 1)); console.log(`已寫出 ${outPath}`); }
})();
