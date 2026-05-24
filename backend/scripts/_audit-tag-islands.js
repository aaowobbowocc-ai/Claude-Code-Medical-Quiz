// One-off: detect short subject_tag "islands" — runs of ≤3 questions whose tag
// differs from substantial same-tag blocks on BOTH sides (likely misclassification
// that neighbor-smoothing's lone-outlier rule skips).
const fs = require('fs'), path = require('path')
const BK = path.resolve(__dirname, '..')

const ISLAND_MAX = 3   // a run this short or shorter = candidate island
const BLOCK_MIN = 4    // neighbouring runs must be at least this long to "vote"

const files = fs.readdirSync(BK).filter(f => /^questions.*\.json$/.test(f) && !f.includes('.bak'))
let totalIslands = 0
const byExam = {}

for (const f of files) {
  let arr
  try { arr = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')).questions } catch { continue }
  if (!Array.isArray(arr)) continue

  // group by paper: year|session|subject
  const papers = {}
  for (const q of arr) {
    if (!q.subject_tag) continue
    const k = `${q.roc_year}|${q.session}|${q.subject || ''}`
    ;(papers[k] = papers[k] || []).push(q)
  }

  const hits = []
  for (const [pk, qs] of Object.entries(papers)) {
    qs.sort((a, b) => (a.number || 0) - (b.number || 0))
    const tags = new Set(qs.map(q => q.subject_tag))
    if (tags.size < 2) continue   // single-subject paper — nothing to misplace

    // build runs
    const runs = []
    for (const q of qs) {
      const last = runs[runs.length - 1]
      if (last && last.tag === q.subject_tag) { last.qs.push(q) }
      else runs.push({ tag: q.subject_tag, qs: [q] })
    }
    // scan for islands
    for (let i = 1; i < runs.length - 1; i++) {
      const r = runs[i], prev = runs[i - 1], next = runs[i + 1]
      if (r.qs.length > ISLAND_MAX) continue
      if (prev.tag !== next.tag || prev.tag === r.tag) continue
      if (prev.qs.length < BLOCK_MIN || next.qs.length < BLOCK_MIN) continue
      hits.push({ pk, island: r, neighbourTag: prev.tag })
    }
  }
  if (hits.length) {
    byExam[f] = hits.length
    totalIslands += hits.length
    console.log(`\n━━ ${f} — ${hits.length} 孤島 ━━`)
    for (const h of hits) {
      const nums = h.island.qs.map(q => q.number).join(',')
      console.log(`  ${h.pk}  #${nums}  [${h.island.tag}] → 應為 [${h.neighbourTag}]`)
      for (const q of h.island.qs) console.log(`     #${q.number} ${String(q.question || '').replace(/\s+/g, ' ').slice(0, 56)}`)
    }
  }
}
console.log(`\n═══ 全站共 ${totalIslands} 個孤島，分布 ${Object.keys(byExam).length} 個考試 ═══`)
for (const [f, n] of Object.entries(byExam).sort((a, b) => b[1] - a[1])) console.log(`  ${f}: ${n}`)
