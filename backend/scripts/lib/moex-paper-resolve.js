/**
 * 把「我們的一卷」對應到考選部的 (c=類科碼, s=科目碼) —— 單一來源。
 *
 * 為什麼需要：scan-missing-disputed / audit-paper-answers / fix-papers-batch
 * 各自寫了一份「名字比對」，於是同一個坑踩了很多次：
 *
 *   1. 名字對不上 → 整卷靜默跳過。
 *      pharma1 / dental1 / dental2 把科目存成「卷一」~「卷四」，考選部叫
 *      「藥理學與藥物化學」「牙醫學(三)」。字串比對永遠不成立，於是這三個
 *      考試的更正答案掃描恆為 0 筆（288 卷全跳過）。
 *   2. 名字對得上、卷卻不只一張。
 *      同一場次裡 c=302 與 c=303 都有「牙醫學(三)~(六)」（不同類科同名科目）。
 *      只靠名字比對會抓到別人的更正卷，把不該標的題標成爭議題——比跳過更糟。
 *
 * 所以這裡分兩層：
 *   A. 名稱層：sameName()，對不上再查別名表（卷一 → 藥理學與藥物化學）。
 *   B. 內容層：抓該候選的試題 PDF，確認我們的題幹真的印在上面。
 *      唯有內容對得上才回傳 —— 同名多類科只能靠這層分辨。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { fetchPdf, buildMoexUrl } = require('./pdf-fetcher');
const { sameName, skeleton } = require('./moex-normalize');

const DIR = path.join(__dirname, '..', '..');
const CODE_CACHE = path.join(DIR, '_tmp', 'moex-codes.json');
const RESOLVE_CACHE = path.join(DIR, '_tmp', 'moex-paper-resolve.json');
const PDF_DIR = path.join(DIR, '_tmp', 'bullet-cloze');
const UA = 'Mozilla/5.0';
const REF = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx';
/** 命中率門檻。抽 12 題只要對到 3 題就足以排除「抓到別人的卷」（不同卷不會有共同題）。 */
const MIN_HIT_RATE = 0.25;

/**
 * 「卷一」這種本地代號 → 考選部科目名的別名表。
 * 年度之間考選部會改寫科目名（「藥劑學（包括生物藥劑學）」→「藥劑學與生物藥劑學」），
 * 所以用關鍵字 regex 而不是完整字串。
 */
const SUBJECT_ALIASES = {
  // 114 年起考選部把科目改名成「藥學(一)(包括藥理學與藥物化學)」，
  // 所以比對括號裡的內容，不要錨在字串開頭。
  pharma1: {
    卷一: /藥理學.*藥物化學/,
    卷二: /藥物分析.*生藥學/,
    卷三: /藥劑學(與|（|\()?.*生物藥劑學|^藥劑學/,
  },
  dental1: {
    卷一: /^牙醫學[（(]一/,
    卷二: /^牙醫學[（(]二/,
  },
  // 職能治療師：考選部把「疾病」改寫成「障礙」（生理疾病職能治療學 → 生理障礙職能治療學），
  // 小兒那科則直接少掉「疾病」兩字。純字串比對整個考試 79 卷全跳過。
  ot: {
    生理疾病職能治療學: /生理(疾病|障礙)職能治療學/,
    心理疾病職能治療學: /心理(疾病|障礙)職能治療學/,
    小兒疾病職能治療學: /小兒(疾病)?職能治療學/,
  },
  // 藥師二階我們存的是簡稱
  pharma2: {
    法規: /藥事行政與法規|藥學\(六\)|藥學（六）/,
    調劑與臨床: /調劑學與臨床藥學/,
    藥物治療: /藥物治療學/,
  },
  dental2: {
    卷一: /^牙醫學[（(]三/,
    卷二: /^牙醫學[（(]四/,
    卷三: /^牙醫學[（(]五/,
    卷四: /^牙醫學[（(]六/,
  },
};

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const codeCache = readJson(CODE_CACHE);
const resolveCache = readJson(RESOLVE_CACHE);

/** 反查某場次所有 (c, s, 科目名)。結果寫進 _tmp/moex-codes.json 共用。 */
function probeCodes(code, year) {
  if (codeCache[code]) return codeCache[code];
  try {
    const out = execFileSync('python', [path.join(__dirname, '..', 'probe-moex-codes.py'), String(+year + 1911), String(code)],
      { encoding: 'utf8', timeout: 180000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const list = [];
    for (const line of out.split('\n')) {
      const m = line.match(/c=(\d+)\s+s=(\w+)\s+(.+)/);
      // 一定要 NFC：考選部頁面把「理」印成 U+F9E4（CJK 相容表意文字），
      // 字形一模一樣但碼位不同，任何 regex / === 比對都會安靜地對不上。
      if (m) list.push({ c: m[1], s: m[2], subject: m[3].replace(/試題|答案|更正答案/g, '').trim().normalize('NFC') });
    }
    // 空結果不要寫進快取：抓不到通常是網路/參數問題，寫進去會讓之後每次都「沒事做」
    if (list.length) { codeCache[code] = list; fs.writeFileSync(CODE_CACHE, JSON.stringify(codeCache, null, 2), 'utf8'); }
    return list;
  } catch { return []; }
}

/** 只有序數的括號，例如「綜合法學(一)(憲法、行政法…)」裡的 (一)。 */
const ORDINAL_PAREN = /[（(][一二三四五六七八九十0-9]{1,3}[）)]/g;
const stripOrdinal = (t) => String(t ?? '').normalize('NFC').replace(ORDINAL_PAREN, '');
const stripAllParens = (t) => String(t ?? '').normalize('NFC').replace(/[（(][^（()）]*[）)]/g, '');

/**
 * 名稱層候選，由嚴到寬四層。第 1 層（名稱直接對得上）可以單獨採信；
 * 第 2~4 層是放寬猜測，一律交給內容層（題幹比對）裁決，對不上就整卷跳過。
 * 回傳 { list, tier }，tier=0 表示四層都沒有候選。
 */
function nameCandidates(exam, subject, codes) {
  codes = codes.map(x => ({ ...x, subject: String(x.subject).normalize('NFC') }));  // 舊快取可能未正規化

  // 1. 直接比（已含全形括號、(包括…) 後綴的前綴比對）
  const byName = codes.filter(x => sameName(x.subject, subject));
  if (byName.length) return { list: byName, tier: 1 };

  // 2. 去掉序數括號再比。律師「綜合法學（憲法、行政法…）」對考選部
  //    「綜合法學(一)(憲法、行政法…)」只差一個 (一)，40 卷全卡在這。
  //    律師同一場次有 301/302/303 三個類科開同名科目，所以會有多個候選 → 交給內容層。
  const byOrdinal = codes.filter(x => sameName(stripOrdinal(x.subject), stripOrdinal(subject)));
  if (byOrdinal.length) return { list: byOrdinal, tier: 2 };

  // 3. 去掉所有括號內容再比。護理師「基本護理學與護理行政」對
  //    「基本護理學（包括護理原理、護理技術）與護理行政」——括號插在名稱中間，前綴比對救不了。
  const bare = stripAllParens(subject);
  if (bare.replace(/\s/g, '').length >= 4) {
    const byBare = codes.filter(x => sameName(stripAllParens(x.subject), bare));
    if (byBare.length) return { list: byBare, tier: 3 };
  }

  // 4. 手工別名表：名稱被改寫到看不出關聯時（卷一 / 生理疾病→生理障礙 / 法規）
  const re = SUBJECT_ALIASES[exam]?.[String(subject).trim()];
  if (re) {
    const byAlias = codes.filter(x => re.test(x.subject));
    if (byAlias.length) return { list: byAlias, tier: 4 };
  }
  return { list: [], tier: 0 };
}

async function pdfText(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  let all = '';
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-whitespace').asJSON());
    for (const b of st.blocks || []) for (const l of b.lines || []) all += (l.text || '') + ' ';
  }
  return all;
}

/** 抓某類型的卷（t: Q 試題 / S 答案 / M 更正答案），檔案快取在 _tmp/bullet-cloze。 */
async function fetchSheet(t, code, c, s) {
  const p = path.join(PDF_DIR, `${t}_${code}_${c}_${s}.pdf`);
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p);
  try {
    const buf = await fetchPdf(buildMoexUrl(t, code, c, s), { userAgent: UA, referer: REF });
    if (buf && buf.length > 1000) {
      fs.mkdirSync(PDF_DIR, { recursive: true });
      fs.writeFileSync(p, buf);
      return buf;
    }
  } catch { /* 沒有這張卷 */ }
  return null;
}

/**
 * 內容層：我們的題幹有多少比例印在這張試題卷上，回傳 0~1。
 *
 * 不要用「過半才算對」：考選部不少卷含表格／圖片，mupdf 抽出來的文字本來就有缺，
 * 實測同一張正確的卷命中率可能只有 19/80。門檻訂太高會把對的卷判成不符，
 * 於是整卷靜默跳過——正是這支工具最初三個考試全 0 筆的原因之一。
 */
async function stemHitRate(code, c, s, stems) {
  const buf = await fetchSheet('Q', code, c, s);
  if (!buf) return 0;
  let text;
  try { text = skeleton(await pdfText(buf)); } catch { return 0; }
  if (text.length < 500) return 0;
  let hit = 0;
  for (const st of stems) if (st && text.includes(st)) hit++;
  return hit / stems.length;
}

/**
 * 解析一卷。
 * @param {object} p  { exam, code, year, subject, items }  items 用來取樣題幹
 * @param {object} opts { verify: 是否做內容層驗證（預設 true）}
 * @returns {Promise<{c,s,subject}|null>}
 */
async function resolvePaper(p, opts = {}) {
  const verify = opts.verify !== false;
  const key = `${p.exam}|${p.code}|${p.subject}`;
  if (resolveCache[key] !== undefined) return resolveCache[key];

  const codes = probeCodes(p.code, p.year);
  const { list: cands, tier } = nameCandidates(p.exam, p.subject, codes);
  let picked = null;

  if (!cands.length) picked = null;
  else if (cands.length === 1 && !verify) picked = cands[0];
  else {
    // 樣本要散佈全卷：只取連續幾題，碰上該段剛好是圖表題就整卷誤判
    const items = (p.items || []).filter(q => (q.question || '').length > 20);
    const step = Math.max(1, Math.floor(items.length / 12));
    const stems = items.filter((_, i) => i % step === 0).slice(0, 12)
      .map(q => skeleton(q.question).slice(0, 24)).filter(s => s.length >= 12);
    if (!stems.length) picked = cands[0] || null;      // 沒樣本可驗，只能信名稱
    else {
      let best = null;
      for (const cand of cands) {
        const rate = await stemHitRate(p.code, cand.c, cand.s, stems);
        if (!best || rate > best.rate) best = { cand, rate };
        if (rate >= 0.8) break;                        // 夠高就不用再試其他候選
      }
      if (best && best.rate >= MIN_HIT_RATE) picked = { ...best.cand, hitRate: +best.rate.toFixed(2) };
      // 只有一個候選時，命中率低多半是「那張卷是掃描檔／表格多，抽不出文字」，
      // 不是抓錯卷——沒有第二張卷可混淆，就信名稱比對。硬卡掉會讓整批卷靜默消失。
      // 第 1 層又只有一個候選時，命中率低多半是「那張卷是掃描檔／表格多，抽不出文字」，
      // 不是抓錯卷——沒有第二張卷可混淆，就信名稱比對。硬卡掉會讓整批卷靜默消失。
      // 第 2~4 層是放寬猜的，沒驗過就不能用。
      else if (tier === 1 && cands.length === 1) picked = { ...cands[0], hitRate: best ? +best.rate.toFixed(2) : 0, unverified: true };
      else picked = null;
    }
  }

  resolveCache[key] = picked;
  fs.writeFileSync(RESOLVE_CACHE, JSON.stringify(resolveCache, null, 2), 'utf8');
  return picked;
}

module.exports = { probeCodes, nameCandidates, resolvePaper, fetchSheet, pdfText, SUBJECT_ALIASES };
