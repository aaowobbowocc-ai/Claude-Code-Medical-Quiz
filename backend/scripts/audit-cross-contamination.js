#!/usr/bin/env node
// Read-only keyword-based cross-contamination audit for exams that share
// combined MoEX sessions (tcm1/tcm2/nutrition/social-worker + nursing).
// Flags questions whose content includes strong keywords from a DIFFERENT
// domain (e.g., TCM markers in a nutrition question).

const fs = require('fs')
const path = require('path')

const MARKERS = {
  tcm: /(經絡|穴位|陰陽|傷寒論|素問|靈樞|溫病條辨|本草|中醫|脾胃虛|氣滯|血瘀|肝氣|腎陰|針灸|舌診|脈診|衛氣|三焦|六腑|臟腑|證型|方劑|補陽|溫陽|黃龍湯|桂枝湯|麻黃|柴胡|消渴|淋證|痺證|傷科|痰濕|風邪|寒邪|暑邪|瘀血|金匱|溫病|肱骨幹骨折|腔室症候群)/,
  nursing: /(護理師|護理措施|護理計畫|護理人員|臥床病人|病人翻身|臨終照護|居家照護|灌腸|導尿|靜脈輸液|壓傷|壓瘡|傷口敷料)/,
  nutrition: /(膳食療養|團體膳食|膳食設計|食品衛生|營養師|熱量需求|巨量營養素|膳食纖維|醣類代謝|脂肪酸代謝|胺基酸|蛋白質營養|維生素[A-K]|礦物質|微量元素|食物代換)/,
  sw: /(社會工作師|社會工作直接服務|社會工作管理|社工員|社區工作|個案工作|團體工作|社會福利|社會救助|家庭暴力|兒童保護|老人福利|身心障礙福利)/,
  pharma: /(藥物動力學|藥效學|半衰期|生體可用率|調劑|處方|首渡效應|清除率|anti[a-z]+|tablet|capsule|IV\s*push|mg\/kg|mcg\/mL|dosing|pharmacokinetic)/i,
  medlab: /(抹片|血球|白血球|紅血球|血紅素|凝血|生化|尿液|酵素|血清學|ELISA|PCR|細菌培養|革蘭氏|藥敏|電泳|免疫|醫事檢驗)/,
  radiology: /(放射師|射源|劑量學|準直|X光|伽瑪射線|Gy|Sv|顯影劑|對比劑|斷層|MRI|PET|超音波|核醫|造影|射線防護|kVp|mAs)/i,
  pt: /(物理治療|關節活動度|肌力訓練|徒手治療|ROM|本體感覺|運動處方|步態|復健|職能|電療|熱療|感覺統合)/,
  ot: /(職能治療|職能活動|工作治療|感覺統合|ADL|日常生活活動|手功能|副木|輔具|手眼協調)/,
  dental: /(牙醫|齲齒|牙周|根管|義齒|咬合|琺瑯質|牙菌斑|牙冠|牙髓|矯正器|氟化物)/,
  doctor: /(家族史|鑑別診斷|生命徵象|理學檢查|臨床表徵|病理機轉|免疫學|抗體|細胞激素)/,
}

const EXAMS = [
  { id: 'tcm1', file: 'questions-tcm1.json', expect: 'tcm', enemies: ['nursing','nutrition','sw','pharma','medlab'] },
  { id: 'tcm2', file: 'questions-tcm2.json', expect: 'tcm', enemies: ['nursing','nutrition','sw','pharma','medlab'] },
  { id: 'nutrition', file: 'questions-nutrition.json', expect: 'nutrition', enemies: ['tcm','nursing','sw'] },
  { id: 'social-worker', file: 'questions-social-worker.json', expect: 'sw', enemies: ['tcm','nursing','nutrition'] },
  { id: 'pharma1', file: 'questions-pharma1.json', expect: 'pharma', enemies: ['medlab','radiology','pt','ot','dental'] },
  { id: 'pharma2', file: 'questions-pharma2.json', expect: 'pharma', enemies: ['medlab','radiology','pt','ot','dental'] },
  { id: 'medlab', file: 'questions-medlab.json', expect: 'medlab', enemies: ['pharma','radiology','pt','ot','dental'] },
  { id: 'radiology', file: 'questions-radiology.json', expect: 'radiology', enemies: ['pharma','medlab','pt','ot','dental'] },
  { id: 'pt', file: 'questions-pt.json', expect: 'pt', enemies: ['pharma','medlab','radiology','ot','dental'] },
  { id: 'ot', file: 'questions-ot.json', expect: 'ot', enemies: ['pharma','medlab','radiology','pt','dental'] },
  { id: 'dental1', file: 'questions-dental1.json', expect: 'dental', enemies: ['pharma','medlab','radiology','pt','ot'] },
  { id: 'dental2', file: 'questions-dental2.json', expect: 'dental', enemies: ['pharma','medlab','radiology','pt','ot'] },
]

for (const ex of EXAMS) {
  const fp = path.join(__dirname, '..', ex.file)
  if (!fs.existsSync(fp)) { console.log(`[skip] ${ex.file} not found`); continue }
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  let total = 0, suspicious = 0
  const hits = { tcm: 0, nursing: 0, nutrition: 0, sw: 0 }
  const samples = []
  for (const q of data.questions) {
    total++
    const text = (q.question||'') + ' ' + Object.values(q.options||{}).join(' ')
    const foreign = ex.enemies.filter(e => MARKERS[e].test(text))
    const own = MARKERS[ex.expect].test(text)
    if (foreign.length && !own) {
      suspicious++
      for (const e of foreign) hits[e]++
      if (samples.length < 15) samples.push({ code: q.exam_code, subj: q.subject, n: q.number,
        foreign, qtext: q.question.slice(0,50) })
    }
  }
  console.log(`\n=== ${ex.id} (${total} q) ===`)
  console.log(`  suspicious (foreign keywords, no own): ${suspicious}`)
  console.log(`  breakdown:`, hits)
  for (const s of samples) console.log(`   ${s.code} ${s.subj} Q${s.n} [${s.foreign.join(',')}]: ${s.qtext}`)
}
