#!/usr/bin/env node
/**
 * 修「一題被寫進另一題的位置、卻留著原位置的答案」——使用者會照著背錯答案，
 * 所以這型優先於一般的題幹破損。
 *
 * 三筆都已逐卷對過原卷與標準答案卷（2026-09-21）：
 *   medlab 100140 #29  被 #30（肺順應性）蓋掉；官方 #29=B，我們存的也是 B → 只換題幹選項
 *   police  109070 #40 被 #50（"key" 字義題）蓋掉；官方 #40=D，我們存的也是 D
 *   tcm1    102110 #60 被 #5（溫脾湯）蓋掉；官方 #60=C，我們存的也是 C，
 *                      但原卷 #60 的選項是藥材圖，文字層取不到 → 留空並標 image_options
 *
 * 三筆的答案字母都恰好是對的：被蓋掉的只有題幹與選項。
 *
 *   node scripts/repair-overwritten-slots.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');

const FIXES = [
  { file: 'questions-medlab.json', id: '100140029', expectAns: 'B',
    question: '體重70 公斤35 歲正常成人，休息時每分鐘氧氣消耗量約為：',
    options: { A: '150 mL', B: '250 mL', C: '350 mL', D: '450 mL' } },
  { file: 'questions-police.json', id: 580, expectAns: 'D',
    question: "Almost one thousand students will _____ at the university's gymnasium to attend the graduation commencement in June.",
    options: { A: 'certify', B: 'chatter', C: 'coincide', D: 'converge' } },
  { file: 'questions-tcm1.json', id: '102110_0202_60', expectAns: 'C',
    question: '下列何藥為活血調經之要藥，並為治頭痛之要藥？',
    options: { A: '', B: '', C: '', D: '' }, incomplete: 'image_options' },

  /*
   * 2026-11-09：諮商心理師 103 年三題，症狀是題幹整個空的、選項是**鄰題的**。
   *   諮商與心理治療理論 #23  選項被 #40（心理劇）蓋掉
   *   團體諮商與心理治療 #16  選項被 #40（籌組兒童諮商團體）蓋掉
   *   團體諮商與心理治療 #39  同上
   * 三題的答案都與官方標準答案卷一致（C / D / C），所以被蓋掉的只有題幹與選項。
   * 選項是組合題圈號，原卷文字層全塌成 ①，用 decode-circled-options.js --probe
   * 配跨卷字形庫解回來的 —— 題幹空白時沒辦法用題幹定位，所以才需要 --probe。
   */
  { file: 'questions-counseling-psychology.json', id: '103100_2_23', expectAns: 'C',
    question: '下列對認知治療之敘述，何者正確？①認知三元組（cognitive triad）是指憂鬱患者對他人、世界和未來常持一種負向觀點 ②強調「專家－學生」之角色 ③認知治療係1960 年代Beck 從事憂鬱症的研究而開始 ④Bandura 和Mahoney 的實務工作影響認知治療的發展',
    options: { A: '僅①②', B: '僅②③', C: '僅③④', D: '僅②④' } },
  { file: 'questions-counseling-psychology.json', id: 695, expectAns: 'D',
    question: '下列敘述何者屬團體倫理守則的範疇？①團體帶領者應依成員的成熟度、團體性質與目的，解釋加入團體的程序、時間、付費方式及終結的程序 ②團體帶領者應就成員及諮商員的角色期待、權利、責任，和成員溝通 ③團體帶領者應和特殊成員，如：酗酒、毒癮、情緒障礙等之配偶或監護人，商討參與團體之情事 ④團體帶領者應說明在特殊結構下，團體可提供及不能提供的服務內容',
    options: { A: '①②③', B: '②③④', C: '①③④', D: '①②④' } },
  { file: 'questions-counseling-psychology.json', id: 718, expectAns: 'C',
    question: '帶領者帶領多樣性的青少年團體，下列那一個組合是為了滿足成員需求宜注意的事項？①篩選成員只需考慮具有類似問題者，以形成同質性團體，彼此的和睦關係不是重點 ②在團體初期設計相關及有趣的活動，吸引他們的興趣及參與 ③發現團體進行中負面消極的能量，帶領者要以創造力和改革力面對並處理 ④團體成員若為非志願性參與，一開始不宜正式提出規範，約束成員遵守紀律',
    options: { A: '①②③', B: '①③④', C: '②③④', D: '①②④' } },
];

let n = 0;
const banks = {};
for (const fx of FIXES) {
  const p = path.join(BK, fx.file);
  if (!banks[fx.file]) { const j = JSON.parse(fs.readFileSync(p, 'utf8')); banks[fx.file] = { raw: j, arr: Array.isArray(j) ? j : j.questions }; }
  const q = banks[fx.file].arr.find(x => String(x.id) === String(fx.id));
  if (!q) { console.log(`✗ ${fx.file} id=${fx.id} 找不到`); continue; }
  // 答案字母必須與稽核當下一致，否則代表資料又動過，停手
  if (q.answer !== fx.expectAns) { console.log(`✗ ${fx.file} id=${fx.id} 答案已變成 ${q.answer}（預期 ${fx.expectAns}），不動`); continue; }
  // ⚠️ 題幹已經是修好的樣子就跳過，不要重寫。
  //    這是一份歷史帳本，重跑會把**後來的改進蓋回去** ——
  //    2026-11-09 加新案例時重跑了一次，就把 tcm1 102110 #60 的選項
  //    從後來改好的「(圖)」倒回成空字串（前端靠它顯示選項圖）。
  if (String(q.question) === fx.question) { console.log(`· ${fx.file} #${q.number} 已修過，跳過`); continue; }
  console.log(`✓ ${fx.file} #${q.number}\n    舊: ${String(q.question).replace(/\s+/g, ' ').slice(0, 60)}\n    新: ${fx.question.slice(0, 70)}`);
  if (APPLY) {
    q.question = fx.question;
    q.options = fx.options;
    if (fx.incomplete) q.incomplete = fx.incomplete; else delete q.incomplete;
  }
  n++;
}
if (APPLY) { for (const f of Object.keys(banks)) atomicWriteJson(path.join(BK, f), banks[f].raw); console.log(`\n已修 ${n} 題，寫回 ${Object.keys(banks).length} 個檔`); }
else console.log(`\n${n} 題可修（試跑；加 --apply 才寫入）`);
