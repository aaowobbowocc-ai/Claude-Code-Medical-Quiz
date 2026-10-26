#!/usr/bin/env node
/**
 * 把「含圖選項被 AI 描述」的題改回站內慣例。
 *
 * 這些題的四個選項在原卷上是圖（聽力圖、示意圖、血中濃度曲線、金字塔層級圖），
 * 考選部的文字層就是空的：
 *
 *   醫師二階 107080 醫學(六) #22 原卷全文：
 *     「22.承上題，此病人接受純音聽力檢查（puretoneaudiometry），最可能的結果為下列何者？A.B.C.D.」
 *                                                                              ↑ 四個選項沒有任何文字
 *
 * 但題庫裡是 AI 編出來的描述（「顯示一個膜結合型抗體分子…」「圖示為溫度從0°C開始上升…」），
 * 使用者會把編造的內容當成考題背。依 [[feedback_image_questions_verbatim]]
 * 與站內既有慣例，一律改成 `(圖)`，等補圖。
 *
 * 進場用明列清單而不是簽章 —— 只有 9 題，每一筆都逐題核對過原卷，
 * 不值得為這個數量做自動判定（判錯會把好選項抹成 `(圖)`）。
 *
 *   node scripts/fix-ai-described-image-options.js            # dry-run
 *   node scripts/fix-ai-described-image-options.js --apply
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const L = ['A', 'B', 'C', 'D']
const FILE = e => path.join(BK, e === 'doctor1' ? 'questions.json' : `questions-${e}.json`)

/** 選項在原卷是圖 → 全部改成 (圖)。 */
const TO_FIGURE = [
  ['doctor2', '107080', '醫學(六)', 22, '原卷全文「22.承上題…最可能的結果為下列何者？A.B.C.D.」四選項無文字，是聽力圖'],
  ['gsat', 'gsat_100', '自然', 29, '四選項都是加熱曲線圖，題庫是 AI 描述「圖示為溫度從0°C開始上升…」'],
  ['medlab', '103020', '臨床血清免疫學與臨床病毒學', 8, '題幹問「下列何者是 T 細胞接受器分子構造的示意圖」，四選項是示意圖'],
  ['medlab', '105020', '臨床血清免疫學與臨床病毒學', 35, '題幹問「下列何者是B細胞接受器分子構造的示意圖」'],
  ['medlab', '107100', '臨床血清免疫學與臨床病毒學', 13, '題幹問「結果應是下列何種圖示型態」，四選項是螢光染色圖'],
  ['nutrition', '109030', '團體膳食設計與管理', 27, '題幹問「各制度相互間的關係，下列圖示何者正確」，四選項是金字塔圖'],
  ['pharma1', '106100', '卷三', 56, '題幹問「下列那一血中濃度－時間關係圖」，四選項是曲線圖'],
  ['radiology', '100020', '放射線器材學（包括磁振學與超音波學）', 78, '題幹問「下列關於各種平衡的圖示何者正確」，四選項各含三張圖'],

  // 第二批：逐題抓原卷文字層確認選項是空的
  ['optometrist', '109110', '視覺光學', 35, '原卷「35若一眼之屈光屬於規則性散光，以下何種圖例屬於單純近視性（simplemyopic）散光？（註：左弧為眼表面…）」之後直接是代號／頁次與 #36，四選項無文字'],
  ['pharma1', '100030', '卷三', 55, '原卷該題選項位置只有「CCCC」——四張圖的縱軸標籤'],
  ['pharma1', '100140', '卷三', 58, '原卷該題選項位置只有「CCCC」'],
  ['pharma1', '104020', '卷三', 56, '原卷「…關係圖之變化？A.B.C.D.」四選項無文字'],
  ['pharma1', '101100', '卷一', 76, '原卷「76.Finasteride之結構為下列何者？A.B.C.D.」'],
  ['pharma1', '101100', '卷二', 66, '原卷「66.下列何者為Thymol之構造？A.B.C.D.」'],
  ['tcm1', '103030', '中醫基礎醫學(二)', 78, '原卷「78下列藥物中，何者常與破故紙，一木一火配合…？79…80…」三題連續完全沒有選項文字，選項是藥材照片'],
  ['tcm1', '103030', '中醫基礎醫學(二)', 79, '同 #78'],
  ['tcm1', '103030', '中醫基礎醫學(二)', 80, '同 #78'],

  // 第三批（2026-10-27）：用 show-official-question.js 逐題抓原卷全文確認，
  // 選項位置都是「A.B.C.D.」沒有任何文字
  ['doctor2', '105100', '醫學(三)', 2, '原卷「…以下何心電圖最可能是胡小姐的心律不整？A.B.C.D.」四選項是心電圖'],
  ['medlab', '109020', '微生物學與臨床微生物學', 5, '原卷「5.下列革蘭氏染色結果，何者最有可能是炭疽菌？A.B.C.D.」四選項是染色照片'],
  ['pharma1', '105020', '卷三', 69, '原卷「69.…下列關於Michaelis-Mentenequation之敘述何者錯誤？A.B.C.D.」四選項是公式圖'],
  ['pharma1', '106100', '卷三', 74, '原卷「74.…關於Michaelis-Mentenequation之敘述，下列何者正確？A.B.C.D.」四選項是公式圖'],
  ['radiology', '112100', '核子醫學診療原理與技術學', 57, '原卷「57.正子掃描的訊號來源中，下列何者為隨機偶合事件（randomcoincidenceevents）？A.B.C.D.」'],
  ['vet', '103090', '獸醫普通疾病學', 18, '原卷「18.牛馬在下列何種情況，通常只能施行剖腹產術處理？A.B.C.D.」'],
]

/** 選項其實有文字，但題庫那組是別題的 → 用原卷逐字覆寫。 */
const TO_TEXT = [
  ['doctor2', '104030', '醫學(六)', 33,
    { A: 'positive', B: 'negative', C: 'reactive', D: 'nonreactive' }, 'C',
    '原卷全文「33承上題，下列四者中最可能的檢查結果為何？positivenegativereactivenonreactive」；答案卷 C。題庫原本是「白血球計數正常，無貧血現象」等，整組是別題的'],

  ['doctor1', '109020', '醫學(一)', 99,
    { A: '前者的受體在細胞膜上，而後者在細胞內',
      B: '在血液中前者有攜帶蛋白（carrier protein），後者沒有攜帶蛋白',
      C: '前者如副甲狀腺荷爾蒙（parathyroid hormone）和細胞膜上受體結合後可產生cAMP',
      D: '後者和受體結合後會和DNA結合' }, 'B',
    '原卷全文逐字：「99.下列關於胜肽類…何者錯誤？A.前者的受體在細胞膜上，而後者在細胞內B.在血液中前者有攜帶蛋白（carrierprotein），後者沒有攜帶蛋白C.…可產生cAMPD.後者和受體結合後會和DNA結合」。答 B 正確——有攜帶蛋白的是類固醇不是胜肽。題庫原本是 AI 改寫版'],

  ['medlab', '108030', '醫學分子檢驗學與臨床鏡檢學', 60,
    { A: 'a', B: 'b', C: 'c', D: 'd' }, 'C',
    '原卷「60.…圖中的區段何者最有可能是TP53基因的位置？A.aB.bC.cD.d」——選項就是圖上的區段標記 a/b/c/d。題庫原本是 AI 編的描述（「該區域探針訊號強度明顯上升，提示基因擴增。」）。因為題幹要看圖才答得出來而題庫沒有圖，另外標 incomplete',
    { incomplete: 'missing_image', incomplete_reason: '題幹的 array CGH 圖未收錄，選項 a/b/c/d 是圖上的區段標記' }],
]

let n = 0
const dirty = new Map()
const load = e => {
  if (!dirty.has(e)) {
    const j = JSON.parse(fs.readFileSync(FILE(e), 'utf8'))
    dirty.set(e, { j, arr: j.questions || j, touched: false })
  }
  return dirty.get(e)
}
const find = (e, code, sub, num) => load(e).arr.find(q =>
  String(q.exam_code) === String(code) && q.subject === sub && +q.number === num)

for (const [e, code, sub, num, why] of TO_FIGURE) {
  const q = find(e, code, sub, num)
  if (!q) { console.log(`✗ 找不到 ${e} ${code} ${sub} #${num}`); continue }
  const alreadyFig = L.every(k => String(q.options?.[k]) === '(圖)')
  const alreadyMarked = q.incomplete === 'image_options'
  if (alreadyFig && alreadyMarked) { console.log(`－ ${e} ${code} #${num} 已處理`); continue }
  console.log(`${e} ${code} ${sub} #${num} 答${q.answer} → (圖)×4${alreadyMarked ? '' : ' + incomplete=image_options'}`)
  console.log(`   依據: ${why}`)
  if (!alreadyFig) console.log(`   抹掉: ${String(q.options.A).replace(/\s+/g, ' ').slice(0, 68)}…`)
  if (APPLY) {
    q.options = { A: '(圖)', B: '(圖)', C: '(圖)', D: '(圖)' }
    // ⚠️ 只換成 (圖) 還不夠。健康報告對 (圖)×4 的豁免條件是 option_images
    //    有 ≥4 把鑰匙；還沒補圖的要標 incomplete='image_options'，
    //    前端才會顯示「本題選項為圖片，可能無法正常對應選項」並從出題排除
    //    （server.js 把 q.incomplete 的題過濾掉）。全站已有 49 題是這個狀態。
    q.incomplete = 'image_options'
    q.incomplete_reason = '選項在原卷是圖，待補 option_images'
    load(e).touched = true
  }
  n++
}

for (const [e, code, sub, num, opts, ansLetter, why, extra] of TO_TEXT) {
  const q = find(e, code, sub, num)
  if (!q) { console.log(`✗ 找不到 ${e} ${code} ${sub} #${num}`); continue }
  console.log(`${e} ${code} ${sub} #${num} 答${q.answer}${String(q.answer) !== ansLetter ? '→' + ansLetter : ''}${extra ? '  + ' + JSON.stringify(extra) : ''}`)
  console.log(`   依據: ${why}`)
  for (const k of L) console.log(`   ${k} 舊「${String(q.options[k]).replace(/\s+/g, ' ').slice(0, 44)}」→ 新「${opts[k]}」`)
  if (APPLY) {
    q.options = { ...opts }
    q.answer = ansLetter
    // extra：少數題目換完文字還是答不出來（例如選項是圖上的 a/b/c/d 標記，
    // 但題庫沒有那張圖），要一併標 incomplete 讓前端擋掉。
    if (extra) Object.assign(q, extra)
    load(e).touched = true
  }
  n++
}

console.log(`\n處理 ${n} 題${APPLY ? '' : '（dry-run）'}`)
if (APPLY) {
  for (const [e, v] of dirty) if (v.touched) atomicWriteJson(FILE(e), v.j)
  console.log('✅ 已寫回')
}
