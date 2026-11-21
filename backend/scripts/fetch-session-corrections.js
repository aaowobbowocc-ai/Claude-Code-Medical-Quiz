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

/**
 * 整份清冊 → 每個科目一筆。
 *
 * ⚠️ 版面至少有四種，欄位順序、科目代碼位置、題數寫法都不一樣：
 *   A（近年）  等級名稱：… 科目代碼： 科目名稱：…（…） 1301
 *              每題配分：1.0分 題數：100題 題號 … 類科名稱：醫師(一) 備註: …
 *   B（103 前後）科目代碼： 類科名稱:醫師(一) 科目名稱：…（…） 1101
 *              題號 … 備註: … 每題配分：1.00分 題數：100題
 *   C（108 前後）等級名稱：… 科目代碼：1101 … 類科名稱:中醫師(一)
 *              科目名稱：…（…） 題數：80題 備註: 第7題答Ｂ給分。
 *   D（107 前後）等級名稱：高考 **類科名稱：社會工作師 科目代號：1107**
 *              科目名稱：社會工作 **單選題數：40 題** … 備註：無更正紀錄
 *
 * D 有兩個陷阱：「科目代**號**」不是「科目代碼」，而且**類科名稱排在科目代號前面**，
 * 切段之後會落在前一段裡 —— 所以段內找不到類科時要往前找最近的一個。
 *
 * ⚠️ 版面認不得時**不會報錯**，只會解出 0 個科目，然後在配對時變成
 * 「清冊沒有這個類科」。看到大量「對不到」要先懷疑解析，不要先懷疑配對。
 */
function parseSheet(text) {
  const t = String(text || '').replace(/[ \t\u3000]+/g, ' ');
  const STOP = '(?=每題配分|單選題數|複選題數|題數|題號|備註|類科名稱|科別名稱|等級名稱|科目代[碼號]|答案|$)';
  // 「類科名稱」也有寫成「科別名稱」的（110180 公共衛生師那一場）
  const KLASS_RE = /(?:類科|科別)名稱[：:]\s*([^\s]+)/g;
  const marks = [...t.matchAll(/科目代[碼號]：/g)].map(m => m.index);
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const seg = t.slice(marks[i], marks[i + 1] === undefined ? t.length : marks[i + 1]);
    const sm = new RegExp('科目名稱[：:]\\s*([\\s\\S]+?)\\s*' + STOP).exec(seg);
    if (!sm) continue;
    // 名稱後面可能黏著科目代碼（版面 A、B），拆掉
    const nameRaw = sm[1].replace(/\s+/g, '');
    const tail = /^(.*?)(\d{3,4})$/.exec(nameRaw);
    const subject = tail ? tail[1] : nameRaw;
    if (!subject) continue;
    let klass = '';
    const inSeg = /(?:類科|科別)名稱[：:]\s*([^\s]+)/.exec(seg);
    if (inSeg) klass = inSeg[1].trim();
    else {
      const before = [...t.slice(0, marks[i]).matchAll(KLASS_RE)];
      if (before.length) klass = before[before.length - 1][1].trim();
    }
    /*
     * 題數有三種寫法，第三種是**數字排在標籤前面**（有複選題的卷才有）：
     *   題數：50題
     *   單選題數：40 題
     *   每題配分： 2.00分 35題 單選題數： 複選每題配分： 10題 複選題數：
     */
    const num = re => { const m = re.exec(seg); return m ? +m[1] : null; };
    const singles = num(/(?:單選)?題數[：:]\s*(\d{1,3})\s*題/) ?? num(/(\d{1,3}) ?題 ?單選題數/);
    const multi = num(/複選題數[：:]\s*(\d{1,3})\s*題/) ?? num(/(\d{1,3}) ?題 ?複選題數/) ?? 0;
    const count = singles == null ? null : singles + multi;

    /*
     * 整卷標準答案。清冊除了更正紀錄，也把**整卷答案**印在「題號／答案」表格裡：
     *   題號 01-10 11-20 21-30 31-40 41-50 51-60 答案 DCCABDBABC …
     * 三個坑：
     * 1. 備註裡的「第41題答Ａ給分」那個Ａ會被當成一組答案，所以要先把備註挖掉。
     * 2. 題號標題永遠印滿 01-10 … 91-100，超出這一卷題數的標題沒有對應的答案格，
     *    照文字順序配會整段錯位 —— 先把題數以外的標題濾掉。
     * 3. 第二列標題的文字順序是亂的（71-80 排在 61-70 前面），而答案格的順序
     *    **還沒有辦法確定**：75 題的卷（律師）照文字順序配是對的，
     *    100 題的卷（醫師一階）照文字順序配從第 61 題起全錯。
     *    所以超過 60 題的部分只在「尾段長度不同、配法唯一」時才採信，
     *    其餘一律不給答案（trustMax 停在 60）。
     * 4. 複選題答案是「AE」「BDE」，PDF 把第二、三個字母拆到別的格子，順序無法復原，
     *    所以複選卷只採信前面的單選段（複選題一定排在最後）。
     */
    const body = seg.slice(seg.indexOf('題號'))
      .replace(/備註[：:][\s\S]*?(?=每題配分|題數[：:]|等級名稱|科目代[碼號]|$)/g, ' ');
    const heads = [], groups = [];
    for (const m of body.matchAll(/(\d{1,3}) ?- ?(\d{1,3})|([A-EＡ-Ｅ#]{1,12})/g)) {
      if (m[1]) heads.push(+m[1]);
      else if (m[3]) { const g = m[3].normalize('NFKC'); if (/^[A-E#]+$/.test(g)) groups.push(g); }
    }
    const answers = {};
    const useHeads = heads.filter(h => !count || h <= count);
    useHeads.forEach((h, hi) => {
      const g = groups[hi];
      if (!g) return;
      // 只有前 60 題（第一列標題）的配法是確定的
      if (h > 60) {
        const rest = useHeads.filter(x => x > 60);
        const partial = count % 10;
        // 尾段只有一組、或這一組長度剛好等於最後一段的零頭時，配法才唯一
        const unique = rest.length === 1 || (partial && g.length === partial && h + partial - 1 === count);
        if (!unique) return;
      }
      [...g].forEach((ch, k) => { answers[h + k] = ch; });
    });
    let trustMax = multi ? singles : count;
    if (trustMax > 60) {
      for (let n = 61; n <= trustMax; n++) if (!answers[n]) { trustMax = 60; break; }
    }
    const keyOk = trustMax > 0 && [...Array(trustMax).keys()].every(i => answers[i + 1]);
    const note = /備註[：:]\s*([\s\S]*?)(?=\s*每題配分|\s*等級名稱|\s*科目代[碼號]|\s*\d{2,3} ?- ?\d{2,3}|$)/.exec(seg);
    const remark = note ? note[1].replace(/\s+/g, ' ').trim() : '';
    // 等級名稱（三等/四等/佐級…）通常排在「科目代碼：」前面，段內找不到就往前找
    let level = '';
    const lvSeg = /等級名稱[：:]\s*([^\s]+)/.exec(seg);
    if (lvSeg) level = lvSeg[1].trim();
    else {
      const b = [...t.slice(0, marks[i]).matchAll(/等級名稱[：:]\s*([^\s]+)/g)];
      if (b.length) level = b[b.length - 1][1].trim();
    }
    // klass 只取第一個 token（舊行為，不要動）；klassFull 是完整的類科清單
    let klassFull = klass;
    const kmFull = /(?:類科|科別)名稱[：:]\s*([\s\S]+?)\s*(?=科目名稱|科目代|等級名稱|題號|答案|備註|每題配分|題數|$)/.exec(seg);
    if (kmFull) klassFull = kmFull[1].replace(/\s+/g, '');
    out.push({
      subject,
      subjectCode: tail ? tail[2] : (/^\s*(\d{3,4})/.exec(seg) || [])[1] || '',
      klass, klassFull, level, singles, multi, answers, keyOk, trustMax,
      count,
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
