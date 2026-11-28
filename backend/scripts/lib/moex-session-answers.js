/**
 * 整場次清冊裡的「整卷標準答案」—— 答案的第二來源。
 *
 * 一卷一份的答案卷（fetchSheet('S', code, c, s)）只有醫事類比較齊，
 * 舊年度與非醫事類很多根本沒有，或是版型 parseAnswerSheet 認不得
 * （營養師 100030 食品衛生與安全：S 不存在、A 解出 0 題）。
 * 清冊走 t=A 且不帶 c/s，一個場次一份，裡面每個科目都印了整卷答案。
 *
 * 原本這段邏輯只長在 audit-session-answers.js 裡（而且跟它的對齊率評分
 * 纏在一起），重建腳本拿不到 —— 所以搬到這裡共用，別再抄第二份
 * （見 reference_moex_shared_libs）。
 *
 * ⚠️ 挑卷**不用答案對齊率**。那一支是在稽核答案，用對齊率挑卷是合理的；
 * 重建腳本要的是「官方答案」，拿題庫答案去挑卷再回頭改題庫就是循環論證
 * （見 project_civil_gap_fill）。這裡只用科目名稱＋題數＋類科，
 * 篩完必須只剩一個候選才給答案。
 */
const { nameCandidates } = require('./moex-paper-resolve');
const { sessionSheet, parseSheet } = require('../fetch-session-corrections');

/**
 * 我們的考試 id → 清冊上的（等級名稱, 類科名稱）。
 * 等級一定要篩：警察三等與四等的「國文」是不同的卷，鐵路佐級與員級也是。
 * 類科要用「包含」比而不是 `^` 比：共同科目那幾列的類科名稱是一長串，
 * 而且會被印到一半就截斷。
 */
const MATCH = {
  // 醫事類：類科名稱就是一個名字，沒有等級之分（都是高考）
  doctor1: { klass: /^醫師[（(]一/ }, doctor2: { klass: /^醫師[（(]二/ },
  dental1: { klass: /^牙醫師[（(]一/ }, dental2: { klass: /^牙醫師[（(]二/ },
  pharma1: { klass: /^藥師[（(]一/ }, pharma2: { klass: /^藥師[（(]二/ },
  tcm1: { klass: /^中醫師[（(]一/ }, tcm2: { klass: /^中醫師[（(]二|^中醫師$/ },
  nursing: { klass: /^護理師/ }, nutrition: { klass: /^營養師/ }, medlab: { klass: /^醫事檢驗師/ },
  radiology: { klass: /^醫事放射師/ }, pt: { klass: /^物理治療師/ }, ot: { klass: /^職能治療師/ },
  rt: { klass: /^呼吸治療師/ }, vet: { klass: /^獸醫師/ }, audiologist: { klass: /^聽力師/ },
  'speech-therapist': { klass: /^語言治療師/ }, 'clinical-psychology': { klass: /^臨床心理師/ },
  'counseling-psychology': { klass: /^諮商心理師/ }, 'social-worker': { klass: /^社會工作師/ },
  'dental-tech': { klass: /^牙體技術師/ }, optometrist: { klass: /^驗光師/ },
  'optometrist-junior': { klass: /^驗光生/ }, 'public-health': { klass: /^公共衛生師/ },
  // 公職／特考類：要連等級一起篩
  lawyer1: { klass: /^(司法官|律師|司法官及律師)/ },
  police: { level: /三等/, klass: /警察|公共安全|國家安全|消防|水上警察|刑事|交通警察|國境|犯罪防治|外事/ },
  police4: { level: /四等/, klass: /警察|公共安全|消防|水上警察|刑事|交通警察|國境|犯罪防治|外事/ },
  customs: { klass: /關稅|關務|財稅行政|一般行政/ },
  'railway-admin': { level: /佐級/, klass: /^事務管理$/ },
  'railway-transport': { level: /佐級/, klass: /^運輸營業$/ },
};

const pieces = s => String(s || '').split(/[、,，]/).map(x => x.trim()).filter(Boolean);
const hitKlass = (re, rec) => !re || re.test(rec.klass) || pieces(rec.klassFull).some(p => re.test(p));

const cache = {};
async function loadSheet(code) {
  if (!(code in cache)) {
    let rows = null;
    try { const txt = await sessionSheet(code); rows = txt ? parseSheet(txt) : null; } catch { rows = null; }
    cache[code] = rows;
  }
  return cache[code];
}

/**
 * @returns {Promise<{answers:Object, trustMax:number, row:object}|{reason:string}>}
 *   answers[題號] = 'A'…'E'｜'#'（送分等原樣）
 */
async function sessionAnswers({ exam, code, subject, maxN }) {
  if (!MATCH[exam]) return { reason: '這個考試沒有清冊對照' };
  const rows = await loadSheet(code);
  if (!rows) return { reason: '抓不到清冊' };
  const pool = rows.filter(r => r.keyOk);
  if (!pool.length) return { reason: '清冊沒有可用的答案' };
  let { list } = nameCandidates(exam, subject, pool);
  if (!list.length) return { reason: '科目名稱對不到' };
  if (maxN) {
    const sized = list.filter(r => Math.abs(r.count - maxN) <= 2 || Math.abs(r.singles - maxN) <= 2);
    if (!sized.length) return { reason: '題數對不上' };
    list = sized;
  }
  if (list.length > 1) {
    const byKlass = list.filter(r => hitKlass(MATCH[exam].klass, r));
    if (byKlass.length) list = byKlass;
  }
  if (list.length !== 1) return { reason: `清冊有 ${list.length} 個候選分不出來` };
  const r = list[0];
  return { answers: r.answers, trustMax: r.trustMax, row: r };
}

module.exports = { MATCH, pieces, hitKlass, sessionAnswers };
