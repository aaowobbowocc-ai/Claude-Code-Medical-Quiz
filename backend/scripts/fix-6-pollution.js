#!/usr/bin/env node
// Manual fix 5 真實 pollution (medlab #49 false positive, skipped)
const fs = require('fs')

const FIXES = [
  // customs 868 — 著作人 #34
  // Q trailing 是 D 的內容；C 結尾「享有」被切到 D
  {
    file: 'questions-customs.json',
    match: q => q.id === 868,
    question: '下列關於著作人之敘述，何者正確？',
    options: {
      A: '受雇人於職務上完成之著作，如未有約定，應以受雇人為著作人，其著作財產權亦歸受雇人享有',
      B: '出資聘請他人完成之著作，應以該出資人為著作人',
      C: '出資聘請他人完成之著作，以受聘人為著作人且未約定著作財產權之歸屬者，其著作財產權歸出資人享有',
      D: '受雇人於職務上完成之著作，得以契約約定以雇用人為著作人',
    },
  },
  // customs 247 — 副總統 #6 (111050)
  // Q trailing 是某選項；C 結尾「雙重」被切到 D 開頭「保險機制」之疑慮
  {
    file: 'questions-customs.json',
    match: q => q.id === 247,
    question: '依司法院大法官解釋，關於「副總統可否兼任行政院院長」，下列敘述何者正確？',
    options: {
      A: '憲法對此未明文禁止，然副總統職位與行政院院長職位並不相容，故不允許',
      B: '憲法對此未明文禁止，依此更可貫徹總統的施政意志而屬允許',
      C: '憲法對此未明文規範，由總統依其人事任用權而決定',
      D: '憲法對此未明文規範，然副總統如兼任行政院院長，有減損繼任「雙重保險機制」之疑慮',
    },
  },
  // police 20 / shared common_admin_studies-113-police-20 — 行政學 #20
  // 排序題：A 應為 ④①②③ (找出問題→蒐集→做出→執行)
  {
    file: 'questions-police.json',
    match: q => q.id === 20 && q.exam_code === '113060',
    question: '理性的決策至少包括下列四個步驟，依其先後順序，下列何者正確？①蒐集論據 ②做出決策 ③執行決策 ④找出問題',
    options: { A: '④①②③', B: '①②③④', C: '②①③④', D: '③④①②' },
  },
  // shared common_constitution-111-customs-6 (mirror of customs 247)
  {
    file: 'shared-banks/common_constitution.json',
    match: q => q.id === 'common_constitution-111-customs-6',
    question: '依司法院大法官解釋，關於「副總統可否兼任行政院院長」，下列敘述何者正確？',
    options: {
      A: '憲法對此未明文禁止，然副總統職位與行政院院長職位並不相容，故不允許',
      B: '憲法對此未明文禁止，依此更可貫徹總統的施政意志而屬允許',
      C: '憲法對此未明文規範，由總統依其人事任用權而決定',
      D: '憲法對此未明文規範，然副總統如兼任行政院院長，有減損繼任「雙重保險機制」之疑慮',
    },
  },
  // shared common_admin_studies-113-police-20 (mirror of police 20)
  {
    file: 'shared-banks/common_admin_studies.json',
    match: q => q.id === 'common_admin_studies-113-police-20',
    question: '理性的決策至少包括下列四個步驟，依其先後順序，下列何者正確？①蒐集論據 ②做出決策 ③執行決策 ④找出問題',
    options: { A: '④①②③', B: '①②③④', C: '②①③④', D: '③④①②' },
  },
]

const byFile = {}
for (const f of FIXES) {
  if (!byFile[f.file]) byFile[f.file] = []
  byFile[f.file].push(f)
}

let total = 0
for (const [fp, fixes] of Object.entries(byFile)) {
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  let fixed = 0
  for (const fix of fixes) {
    const q = arr.find(fix.match)
    if (!q) { console.log('NOT FOUND:', fp, fix.question.slice(0, 30)); continue }
    q.question = fix.question
    q.options = fix.options
    fixed++
  }
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log(fp, ':', fixed)
  total += fixed
}
console.log('TOTAL:', total)
console.log('Note: medlab 100030 #49 left unchanged — false positive (multichoice statements listed in Q)')
