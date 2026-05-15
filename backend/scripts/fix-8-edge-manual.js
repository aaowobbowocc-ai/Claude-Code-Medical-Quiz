#!/usr/bin/env node
// Manual fixes for 7 edge-case multichoice/single-answer pollution
const fs = require('fs')

const FIXES = [
  {
    file: 'questions.json',
    match: q => q.exam_code === '100030' && q.subject === '醫學(二)' && q.number === 22,
    question: '就精原母細胞（spermatogonium）到精子（sperm）的過程，下列那一項之順序最佳？',
    options: {
      A: 'Spermatogonium→primary spermatocyte→first meiosis→secondary spermatocyte→second meiosis→spermatid→sperm',
      B: 'Spermatogonium→first meiosis→primary spermatocyte→second meiosis→secondary spermatocyte→spermatid→sperm',
      C: 'Spermatogonium→primary spermatocyte→first meiosis→secondary spermatocyte→spermatid→second meiosis→sperm',
      D: 'Spermatogonium→primary spermatocyte→secondary spermatocyte→first meiosis→spermatid→second meiosis→sperm',
    },
  },
  {
    file: 'questions-tcm1.json',
    match: q => q.exam_code === '106110' && q.subject === '中醫基礎醫學(一)' && q.number === 57,
    question: '下列症狀有幾項，一般認為是屬於「邪氣盛則實」的臨床表現？①二便不通 ②聲高氣粗 ③神思恍惚 ④狂躁 ⑤自汗盜汗 ⑥脈實有力 ⑦心悸氣短',
    options: { A: '6', B: '5', C: '4', D: '3' },
  },
  {
    file: 'questions-tcm1.json',
    match: q => q.exam_code === '108110' && q.subject === '中醫基礎醫學(一)' && q.number === 73,
    question: '依《素問‧熱論》，有關少陽與厥陰俱病的症狀，下列選項何者正確？①身熱 ②耳聾 ③腹滿 ④囊縮而厥 ⑤頭痛 ⑥口乾 ⑦煩滿',
    options: { A: '①③', B: '④⑦', C: '②④', D: '⑤⑥' },
  },
  {
    file: 'questions-tcm2.json',
    match: q => q.exam_code === '107110' && q.subject === '中醫臨床醫學(一)' && q.number === 58,
    question: '小便不禁，宜辨別虛證的輕重，下列敘述何者屬病重？①有夢而遺尿 ②夜有遺尿而晝有不禁者 ③咳嗽或談笑而不禁者 ④無故不禁者',
    options: { A: '①②', B: '②③', C: '①③', D: '②④' },
  },
  {
    file: 'questions-nursing.json',
    match: q => q.exam_code === '109030' && q.subject === '精神科與社區衛生護理學' && q.number === 21,
    question: '蔡女士，因憂鬱症有不想活的念頭而住院治療，某日在病房中將自己心愛的首飾分送給病友，站在窗前凝視，告訴護理師生命有如輕煙，此時護理師優先提供的護理處置，下列何者正確？①敏銳觀察自殺徵兆 ②鼓勵表達自我感受 ③安排人少的房間 ④鼓勵參與活動',
    options: { A: '①②③', B: '①②④', C: '①③④', D: '②③④' },
  },
  {
    file: 'questions-nutrition.json',
    match: q => q.exam_code === '108110' && q.subject === '生理學與生物化學' && q.number === 35,
    question: '有關兒茶酚胺（catecholamines）與其訊息傳遞（signal transduction）機制之敘述，下列何者正確？',
    options: {
      A: '兒茶酚胺（catecholamines）在人體僅有一種接受器（receptor）',
      B: '兒茶酚胺（catecholamines）訊息傳遞（signal transduction）路徑可透過蛋白C（protein C）活化腺苷酸環化酶（adenylate cyclase）',
      C: '兒茶酚胺（catecholamines）訊息傳遞（signal transduction）路徑可透過環狀腺苷單磷酸（cyclic AMP, cAMP）為次級訊息傳遞者（second messenger）',
      D: '兒茶酚胺（catecholamines）訊息傳遞（signal transduction）路徑可透過活化磷酯酶C（phospholipase C）終止訊息傳遞',
    },
  },
  {
    // nutrition 109030 #21: options already correct, just clean inline (A)(B)(C)(D) from question
    file: 'questions-nutrition.json',
    match: q => q.exam_code === '109030' && q.subject === '團體膳食設計與管理' && q.number === 21,
    question: '長期攝取含汞金屬濃度高的魚肉會出現的症狀，下列敘述何者正確？',
    // Keep existing options
    keepOptions: true,
  },
]

let totalFixed = 0
const byFile = {}
for (const fix of FIXES) {
  if (!byFile[fix.file]) byFile[fix.file] = []
  byFile[fix.file].push(fix)
}

for (const [fp, fixes] of Object.entries(byFile)) {
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  let fixed = 0
  for (const fix of fixes) {
    const q = arr.find(fix.match)
    if (!q) { console.log('NOT FOUND:', fp, fix.question.slice(0, 30)); continue }
    q.question = fix.question
    if (!fix.keepOptions) q.options = fix.options
    // disputed reserved for 考選部 official corrections only — don't set on parser repair
    fixed++
  }
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log(fp, ':', fixed)
  totalFixed += fixed
}
console.log('TOTAL:', totalFixed)
console.log('Note: medlab 100030 #49 is a false positive (multichoice with statements listed in question) — left unchanged.')
