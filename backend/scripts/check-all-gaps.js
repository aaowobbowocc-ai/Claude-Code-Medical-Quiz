// 列出所有考試各 (year, session, subject) 不滿 expected 的卷
const fs = require('fs')
const path = require('path')

const EXAM_FILES = {
  doctor1: 'questions.json', doctor2: 'questions-doctor2.json',
  dental1: 'questions-dental1.json', dental2: 'questions-dental2.json',
  pharma1: 'questions-pharma1.json', pharma2: 'questions-pharma2.json',
  nursing: 'questions-nursing.json', nutrition: 'questions-nutrition.json',
  medlab: 'questions-medlab.json', pt: 'questions-pt.json', ot: 'questions-ot.json',
  radiology: 'questions-radiology.json', tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json', vet: 'questions-vet.json',
  audiologist: 'questions-audiologist.json',
  'speech-therapist': 'questions-speech-therapist.json',
  rt: 'questions-rt.json',
  'social-worker': 'questions-social-worker.json',
}

for (const [exam, file] of Object.entries(EXAM_FILES)) {
  const fp = path.join(__dirname, '..', file)
  if (!fs.existsSync(fp)) continue
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  // group by (year, session, subject)
  const groups = new Map()
  for (const q of arr) {
    const k = `${q.roc_year}|${q.session}|${q.subject}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(q)
  }
  // common subjects 的 expected size
  // 把每場 (year, session) 的 subjects 算 mode size
  const yearSession = new Map()
  for (const [k, qs] of groups) {
    const [y, s, subj] = k.split('|')
    const ys = `${y}|${s}`
    if (!yearSession.has(ys)) yearSession.set(ys, [])
    yearSession.get(ys).push({ subj, n: qs.length })
  }
  const gaps = []
  for (const [ys, subjects] of yearSession) {
    // 取該場最常見的 N 作為 expected
    const counts = subjects.map(x => x.n).sort((a, b) => b - a)
    const expectedMax = counts[0]
    // 80 是一般、50 是新版、40/50 是 nursing/nutrition 部分
    // 判斷規則：低於該場最大值 90% 視為缺
    for (const { subj, n } of subjects) {
      if (n < expectedMax * 0.9 && n < 75) {
        gaps.push({ ys, subj, n, expected: expectedMax })
      }
    }
  }
  if (gaps.length > 0) {
    console.log(`\n[${exam}] 缺漏 ${gaps.length} 卷:`)
    for (const g of gaps.slice(0, 20)) {
      const [y, s] = g.ys.split('|')
      console.log(`  ${y}-${s} ${g.subj}: ${g.n}/${g.expected} (缺 ${g.expected - g.n})`)
    }
    if (gaps.length > 20) console.log(`  ...還有 ${gaps.length - 20}`)
  }
}
