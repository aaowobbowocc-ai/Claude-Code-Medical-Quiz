// Find questions that reference an image but have no image attached, and are NOT already marked incomplete.
const fs = require('fs')
const path = require('path')
const dir = path.join(__dirname, '..')

// 判定共用 lib/image-ref.js —— 這支與 add-missing-images.js 必須用同一份名單，
// 否則會出現「盤點說缺 75 題、補圖工具卻說 0 個候選」的假象。
const { IMAGE_REF: RX_IMG } = require('./lib/image-ref')

// 不能只認 questions-*.json：醫師一階存成 questions.json（沒有 dash），
// 這個 glob 曾讓它 6,297 題完全不在盤點範圍內。
const files = fs.readdirSync(dir).filter(f => /^questions(-.*)?\.json$/.test(f) && !/\.bak/.test(f))
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
