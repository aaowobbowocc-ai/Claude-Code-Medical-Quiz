#!/usr/bin/env node
// 逐卷污染稽核（read-only）。以「檔案 + exam_code + subject」為一卷單位，
// 判斷整卷的主題是否與所屬考試相符。針對 030 合併考場（醫師/中醫師/營養師/
// 心理師/護理師/社工師同場）造成的「整卷抓到別科」污染。
//
// 作法：每題用領域關鍵字打分，整卷統計各領域命中率。若所屬考試的領域
// 命中率偏低、或某外來領域命中率偏高 → 標記為疑似污染卷。

const fs = require('fs')
const path = require('path')

// 領域關鍵字（出現即視為該領域題）
const DOMAINS = {
  psych: /(DSM-|WAIS|WISC|羅夏|心理衡鑑|投射測驗|認知行為治療|個人中心治療|完形治療|現實治療|焦點解決|敘事治療|精神分析|心理動力|心理計量|常模|標準化測驗|GAF|衡鑑工具|心理治療學派|團體諮商|諮商技術|同理心|個案概念化|心理病理)/,
  research: /(後設分析|統計考驗|自變項|依變項|研究假設|實驗設計|抽樣方法|質性研究|量化研究|信度與效度|內在效度|外在效度|對照組|隨機分派)/,
  tcm: /(傷寒論|金匱要略|素問|靈樞|溫病條辨|本草|經絡|穴位|方劑|脈診|舌診|針灸|溫病|證型|臟腑|氣血兩|陰陽|桂枝湯|柴胡|麻黃|六腑|衛氣|三焦|補陽|溫陽|瘀血|痰濕)/,
  nursing: /(護理措施|護理計畫|護理人員|護理評估|臨終照護|壓傷|壓瘡|導尿|灌腸|翻身擺位|出院準備|護理指導|護理診斷)/,
  nutrition: /(膳食療養|團體膳食|膳食設計|食物代換|熱量需求|巨量營養素|膳食纖維|公共衛生營養|食品衛生與安全)/,
  pharma: /(藥物動力學|藥效學|半衰期|生體可用率|調劑|首渡效應|藥物交互作用|劑型|藥事法|藥品許可證)/,
  medlab: /(血球計數|白血球分類|血液抹片|凝血時間|尿液鏡檢|血清學|細菌培養|革蘭氏染色|藥敏試驗|電泳分析|醫事檢驗)/,
  radiology: /(射源|劑量學|準直儀|kVp|mAs|顯影劑|電腦斷層|核醫造影|射線防護|加馬射線|放射治療|影像品質)/,
  rehab: /(關節活動度|徒手治療|本體感覺|運動處方|步態分析|感覺統合|副木|輔具|日常生活活動|物理治療|職能治療)/,
  dental: /(齲齒|牙周|根管治療|義齒|咬合|琺瑯質|牙菌斑|牙髓|齒列矯正|氟化物|牙周囊袋)/,
  law: /(民法|刑法|憲法|行政程序法|訴訟法|法律行為|構成要件|管轄權|不當得利|侵權行為)/,
}

// 各考試檔 → 預期領域（可多個皆算自己人）
const EXAM_EXPECT = {
  'questions.json': ['psych', 'research', 'tcm', 'nursing', 'nutrition', 'pharma', 'medlab', 'radiology', 'rehab', 'dental'], // doctor1 一階基礎，含蓋廣，僅當對照
  'questions-doctor2.json': ['psych', 'research', 'tcm', 'nursing', 'nutrition', 'pharma', 'medlab', 'radiology', 'rehab', 'dental'],
  'questions-nursing.json': ['nursing'],
  'questions-nutrition.json': ['nutrition'],
  'questions-tcm1.json': ['tcm'],
  'questions-tcm2.json': ['tcm'],
  'questions-pharma1.json': ['pharma'],
  'questions-pharma2.json': ['pharma'],
  'questions-medlab.json': ['medlab'],
  'questions-radiology.json': ['radiology'],
  'questions-pt.json': ['rehab'],
  'questions-ot.json': ['rehab'],
  'questions-dental1.json': ['dental'],
  'questions-dental2.json': ['dental'],
  'questions-social-worker.json': [],
  'questions-vet.json': [],
  'questions-speech-therapist.json': [],
  'questions-audiologist.json': [],
  'questions-rt.json': [],
}

// 對非自己領域、且屬「明顯不同科」的外來領域 → 視為污染訊號
const FOREIGN = ['psych', 'research', 'tcm', 'nursing', 'nutrition', 'pharma', 'medlab', 'radiology', 'rehab', 'dental', 'law']

function classify(q) {
  const text = (q.question || '') + ' ' + Object.values(q.options || {}).join(' ')
  const hits = []
  for (const [d, re] of Object.entries(DOMAINS)) if (re.test(text)) hits.push(d)
  return hits
}

const flagged = []
for (const [file, expect] of Object.entries(EXAM_EXPECT)) {
  const fp = path.join(__dirname, '..', file)
  if (!fs.existsSync(fp)) continue
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  // 分卷
  const papers = {}
  for (const q of arr) {
    const key = `${q.exam_code}||${q.subject}`
    ;(papers[key] = papers[key] || []).push(q)
  }
  for (const [key, qs] of Object.entries(papers)) {
    const [code, subject] = key.split('||')
    const n = qs.length
    const domainCount = {}
    for (const q of qs) for (const d of classify(q)) domainCount[d] = (domainCount[d] || 0) + 1
    // 外來領域命中率（排除自己預期的領域）
    const foreignHits = {}
    for (const d of FOREIGN) {
      if (expect.includes(d)) continue
      const c = domainCount[d] || 0
      if (c > 0) foreignHits[d] = c
    }
    const foreignTotal = Object.values(foreignHits).reduce((a, b) => a + b, 0)
    const foreignPct = Math.round((foreignTotal / n) * 100)
    // 旗標：外來領域命中 ≥ 20% 的卷
    if (foreignPct >= 20) {
      flagged.push({ file, code, subject, n, foreignPct, foreignHits })
    }
  }
}

flagged.sort((a, b) => b.foreignPct - a.foreignPct)
console.log(`\n疑似污染卷：${flagged.length}\n`)
for (const f of flagged) {
  const fh = Object.entries(f.foreignHits).map(([d, c]) => `${d}:${c}`).join(' ')
  console.log(`${f.file.replace('questions-', '').replace('.json', '').padEnd(18)} ${f.code} ${String(f.subject).slice(0, 16).padEnd(17)} ${String(f.n).padStart(3)}題 外來${String(f.foreignPct).padStart(3)}%  [${fh}]`)
}
