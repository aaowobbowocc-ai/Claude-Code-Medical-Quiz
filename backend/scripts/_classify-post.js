// 一次性：全量下載 _post-index.json 的 219 份 PDF，判定題型（選擇題 / 申論）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { cachedFetch } = require('./lib/pdf-fetcher')

const idx = require(path.join(__dirname, '..', '_tmp', '_post-index.json'))
const CACHE = path.join(__dirname, '..', '_tmp', 'post-cache')

function parseRel(rel) {
  const parts = rel.replace(/\.pdf$/i, '').split('/')
  let rank = '其他'
  if (rel.includes('專業職(二)') || /內勤|外勤/.test(rel)) rank = '專業職二'
  else if (rel.includes('專業職(一)')) rank = '專業職一'
  else if (rel.includes('營運職')) rank = '營運職'
  return { rank, subject: parts[parts.length - 1] }
}

// 題型判定：先看試卷開頭說明（最可靠），再數選擇題標記
function detectType(text) {
  const head = text.slice(0, 1400).replace(/\s+/g, '')
  const mcq = (text.match(/【\s*[1-4](?:\s*[,，、]\s*[1-4])*\s*】\s*\d{1,3}\s*[.．、]/g) || []).length
  let verdict
  if (/非選擇題|共有.{0,6}大題/.test(head)) verdict = '申論'
  else if (/題單選題|題.{0,4}測驗題|單一選擇題/.test(head)) verdict = '選擇題'
  else if (mcq >= 20) verdict = '選擇題'
  else if (mcq > 0) verdict = `部分(${mcq})`
  else verdict = text.length < 1500 ? '疑壞檔/申論' : '無選擇題'
  return { verdict, mcq, len: text.length }
}

async function main() {
  const rows = []
  for (const [year, arr] of Object.entries(idx.byYear)) {
    for (const { rel, url } of arr) rows.push({ year, rel, url, ...parseRel(rel) })
  }
  console.log(`全量判定 ${rows.length} 份 PDF …\n`)

  let done = 0
  for (const r of rows) {
    try {
      const buf = await cachedFetch(r.url, CACHE, { referer: 'https://www.3people.com.tw/', timeout: 45000 })
      const { text } = await pdfParse(buf)
      Object.assign(r, detectType(text))
    } catch (e) { r.verdict = 'ERR'; r.err = e.message }
    if (++done % 30 === 0) console.log(`  … ${done}/${rows.length}`)
    await new Promise(res => setTimeout(res, 90))
  }

  // 統計：職階 × 題型
  const stat = {}
  for (const r of rows) {
    const k = r.rank
    stat[k] ??= { 選擇題: 0, '部分': 0, 申論: 0, 無選擇題: 0, '疑壞檔/申論': 0, ERR: 0, total: 0 }
    const v = r.verdict.startsWith('部分') ? '部分' : r.verdict
    stat[k][v] = (stat[k][v] || 0) + 1
    stat[k].total++
  }
  console.log('\n=== 職階 × 題型 ===')
  for (const [k, s] of Object.entries(stat)) {
    console.log(`  ${k}: 選擇題=${s.選擇題} 部分=${s.部分} 申論=${s.申論} 無選擇題=${s.無選擇題} 疑壞檔=${s['疑壞檔/申論']} ERR=${s.ERR}  (共 ${s.total})`)
  }

  // 選擇題卷清單（選擇題 + 部分）
  console.log('\n=== 可用（選擇題/部分選擇題）卷清單 ===')
  const usable = rows.filter(r => r.verdict === '選擇題' || r.verdict.startsWith('部分'))
  usable.sort((a, b) => (a.rank + a.subject + a.year).localeCompare(b.rank + b.subject + b.year))
  for (const r of usable) console.log(`  [${r.verdict}] ${r.year} ${r.rank} / ${r.subject}  (mcq=${r.mcq})`)
  console.log(`\n可用卷數: ${usable.length} / ${rows.length}`)

  fs.writeFileSync(path.join(__dirname, '..', '_tmp', '_post-classified.json'),
    JSON.stringify({ rows, stat }, null, 2))
  console.log('→ _tmp/_post-classified.json')
}
main().catch(e => { console.error(e); process.exit(1) })
