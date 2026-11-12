#!/usr/bin/env node
/**
 * 題組的後續小題，圖掛在第一小題上 —— 把同一張圖接到後面幾題。
 *
 * 考選部的題組只在第一小題印圖：
 *   76.請依此X 光影像，依序回答下列3 題。   ← 圖印在這裡
 *   77.圖中黑色箭頭所指的解剖位置為何？      ← 沒有圖，但指的是上面那張
 *   78.圖中黑色箭頭所指的病變…
 * 補圖工具只會掛給第一小題（圖確實只在那一題的範圍內），後面幾題
 * 對使用者來說就是「題目說有圖卻看不到」。
 *
 * 判準（三條都要成立才接）：
 *   1. 前面 1~3 題之內有一題**有圖**
 *   2. 兩題屬於同一個題組：領頭宣告「回答下列N題」／「第N-M題為題組」
 *      涵蓋到這一題，或這一題以「承上題」開頭、或兩題的【題組情境】逐字相同
 *   3. 這一題指名的圖號**沒有超出**領頭指名的範圍
 *      （領頭講圖1，這題講圖3，那就是別張圖，不能接）
 *
 *   node scripts/link-group-figures.js [--exam=dental2] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { IMAGE_REF } = require('./lib/image-ref');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];

const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const w2a = s => String(s).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const num = s => (/^\d+$/.test(s) ? +s : CN[s] || 0);
const COUNT_RE = /回答下列\s*([0-9]+|[一二三四五六七八九十])\s*[個]?題/;
const RANGE_RE = /第\s*([0-9]{1,3})\s*[-－–~～至]\s*([0-9]{1,3})\s*題/;
const hasImg = q => !!(q.images && q.images.length) || !!q.image || !!q.image_url;
// 題組的標記有兩種：考選部卷是我們自己加的【題組情境】，教檢卷原本就寫〈閱讀測驗〉。
// 只認前者的話，教檢的閱讀測驗題組接不上（112 資優 課程教學與評量 #20~#22）。
const GROUP_MARK = /^(【題組情境】|〈閱讀測驗〉|\(閱讀測驗\))+\s*/;
const ctxOf = s => (GROUP_MARK.test(s) ? s.replace(GROUP_MARK, '').slice(0, 40) : null);
const refsOf = s => new Set((w2a(s).match(/[圖表]\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})/g) || [])
  .map(t => t.replace(/\s/g, '')));

let linked = 0;
const why = {};
const bump = k => { why[k] = (why[k] || 0) + 1; };

for (const f of fs.readdirSync(BK).filter(x => /^questions(-[a-z0-9-]*)?\.json$/.test(x))) {
  const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
  if (only && exam !== only) continue;
  const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
  const arr = Array.isArray(j) ? j : j.questions;
  if (!arr) continue;
  const by = {};
  for (const q of arr) (by[q.exam_code + '|' + q.subject] = by[q.exam_code + '|' + q.subject] || []).push(q);
  let touched = false;

  for (const q of arr) {
    const stem = String(q.question || '');
    if (hasImg(q) || q.option_images || q.no_image_in_source) continue;
    if (!IMAGE_REF.test(stem)) continue;
    const sib = by[q.exam_code + '|' + q.subject] || [];
    const myCtx = ctxOf(stem);
    const myRefs = refsOf(stem);
    let lead = null, reason = '';
    for (let back = 1; back <= 3 && !lead; back++) {
      const L = sib.find(x => +x.number === +q.number - back);
      if (!L || !hasImg(L)) continue;
      const ls = w2a(String(L.question || ''));
      const mc = ls.match(COUNT_RE), mr = ls.match(RANGE_RE);
      let span = 0;
      if (mc) span = num(mc[1]);
      else if (mr) span = +mr[2] - +L.number + 1;
      const inSpan = span && +q.number <= +L.number + span - 1;
      // 領頭不一定帶【題組情境】標記（它就是情境本身），所以比的是
      // 「領頭的題幹是不是以這一段情境開頭」，不是兩邊的標記相不相等。
      const lHead = String(L.question || '').replace(GROUP_MARK, '');
      const sameCtx = myCtx && (ctxOf(String(L.question || '')) === myCtx || lHead.startsWith(myCtx));
      const carry = /^(【題組情境】)*\s*承上題/.test(stem) || /承上題/.test(stem.slice(0, 80));
      if (!inSpan && !sameCtx && !carry) continue;
      // 指名的圖號不能超出領頭的範圍
      const lRefs = refsOf(String(L.question || ''));
      const extra = [...myRefs].filter(r => !lRefs.has(r));
      if (myRefs.size && lRefs.size && extra.length) { bump(`圖號對不上(${extra.join(',')})`); continue; }
      lead = L; reason = inSpan ? '宣告涵蓋' : (sameCtx ? '同一段情境' : '承上題');
    }
    if (!lead) continue;
    console.log(`  ${exam} ${q.exam_code} ${q.subject} #${q.number} ← #${lead.number} (${reason}) ${lead.images ? lead.images[0] : lead.image_url}`);
    if (APPLY) {
      if (lead.images && lead.images.length) q.images = [...lead.images];
      else q.image_url = lead.image_url;
      touched = true;
    }
    linked++;
  }
  if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
}
console.log(`${APPLY ? '已接上' : '可接上'} ${linked} 題`);
if (Object.keys(why).length) console.log('沒接的原因:', JSON.stringify(why, null, 1));
