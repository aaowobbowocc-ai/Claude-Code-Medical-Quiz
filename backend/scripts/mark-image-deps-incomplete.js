// Mark image-dependent questions with no stored image as incomplete.
// Tags `gap_reason: "missing_image_dep"` for future batch image-extraction recovery.
const fs = require('fs')
const path = require('path')
const dir = path.join(__dirname, '..')

const RX_IMG = /(如圖|下圖|附圖|圖示|圖中|示意圖|箭頭所指|箭頭|下列圖|圖譜|血球如|此圖|箭號)/

const files = fs.readdirSync(dir).filter(f => f.startsWith('questions-') && f.endsWith('.json'))
let total = 0
const perFile = {}
for (const f of files) {
  const fp = path.join(dir, f)
  let d
  try { d = JSON.parse(fs.readFileSync(fp, 'utf8')) } catch (e) { continue }
  const qs = Array.isArray(d) ? d : d.questions
  if (!qs) continue
  let n = 0
  for (const q of qs) {
    if (q.incomplete) continue
    if (!q.question || !RX_IMG.test(q.question)) continue
    if (q.image || q.images || q.image_url) continue
    q.incomplete = true
    q.gap_reason = 'missing_image_dep'
    n++
  }
  if (n) {
    fs.writeFileSync(fp, JSON.stringify(d, null, 2))
    perFile[f] = n
    total += n
  }
}
console.log('Marked total:', total)
for (const [f, n] of Object.entries(perFile).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n}\t${f}`)
}
