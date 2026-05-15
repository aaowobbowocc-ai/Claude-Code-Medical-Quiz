#!/usr/bin/env node
// PDF-verified corrections for 5 manual pollution fixes that were wrong.
// PDF inspection done 2026-05-15 to verify exact option order + answer.
const fs = require('fs')

const FIXES = [
  // customs 868 法學知識 #34 著作人 (107050)
  // PDF: customs_107050_c101_s0312.pdf
  // Answer per A_PDF: D (出資人享有)
  {
    file: 'questions-customs.json',
    match: q => q.id === 868,
    question: '下列關於著作人之敘述，何者正確？',
    options: {
      A: '受雇人於職務上完成之著作，得以契約約定以雇用人為著作人',
      B: '受雇人於職務上完成之著作，如未有約定，應以受雇人為著作人，其著作財產權亦歸受雇人享有',
      C: '出資聘請他人完成之著作，應以該出資人為著作人',
      D: '出資聘請他人完成之著作，以受聘人為著作人且未約定著作財產權之歸屬者，其著作財產權歸出資人享有',
    },
    answer: 'D',
  },
  // customs 247 副總統 #6 (111050) — already correct
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
    answer: 'D', // PDF answer key confirmed
  },
  // police 20 行政學 #20 (113060) — A/C 順序錯
  // PDF order: A=①②③④, B=②①③④, C=④①②③, D=②④③①
  {
    file: 'questions-police.json',
    match: q => q.id === 20 && q.exam_code === '113060',
    question: '理性的決策至少包括下列四個步驟，依其先後順序，下列何者正確？①蒐集論據 ②做出決策 ③執行決策 ④找出問題',
    options: { A: '①②③④', B: '②①③④', C: '④①②③', D: '②④③①' },
    answer: 'C', // unchanged — points to 找出問題→蒐集→做出→執行
  },
  // shared mirrors
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
    answer: 'D',
  },
  {
    file: 'shared-banks/common_admin_studies.json',
    match: q => q.id === 'common_admin_studies-113-police-20',
    question: '理性的決策至少包括下列四個步驟，依其先後順序，下列何者正確？①蒐集論據 ②做出決策 ③執行決策 ④找出問題',
    options: { A: '①②③④', B: '②①③④', C: '④①②③', D: '②④③①' },
    answer: 'C',
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
    if (fix.answer && q.answer !== fix.answer) {
      console.log('  answer change:', fp, q.id, q.answer, '→', fix.answer)
      q.answer = fix.answer
    }
    fixed++
  }
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log(fp, ':', fixed)
  total += fixed
}
console.log('TOTAL:', total)
