// Find questions that reference an image but have no image attached, and are NOT already marked incomplete.
const fs = require('fs')
const path = require('path')
const dir = path.join(__dirname, '..')

// Heuristics that strongly imply an image is required to answer.
const RX_IMG = /(如圖|下圖|附圖|圖示|圖中|示意圖|箭頭所指|箭頭|下列圖|圖譜|血球如|此圖|箭號)/

const files = fs.readdirSync(dir).filter(f => f.startsWith('questions-') && f.endsWith('.json'))
const groups = {}
let total = 0
for (const f of files) {
  let d
  try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch (e) { continue }
  const qs = Array.isArray(d) ? d : d.questions
  if (!qs) continue
  for (const q of qs) {
    if (q.incomplete) continue
    if (!q.question) continue
    if (!RX_IMG.test(q.question)) continue
    if (q.image || q.images || q.image_url) continue
    const k = `${f}|${q.subject}`
    groups[k] = (groups[k] || 0) + 1
    total++
  }
}
console.log('Total uncovered image-dep questions:', total)
const sorted = Object.entries(groups).sort((a, b) => b[1] - a[1])
for (const [k, n] of sorted.slice(0, 25)) console.log(n, k)
