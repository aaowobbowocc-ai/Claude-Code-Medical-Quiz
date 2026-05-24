// 一次性：測 post-parser 對官方 svc.tabf 專業職(二) 主科卷的抽取率
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const path = require('path')
const { cachedFetch } = require('./lib/pdf-fetcher')
const { parsePostPdf } = require('./lib/post-parser')

const CACHE = path.join(__dirname, '..', '_tmp', 'post-official-cache')
const idx = require(path.join(__dirname, '..', '_tmp', '_post-official-index.json'))

// 專業職二、選擇題、主科（企管/郵政三法/郵政法），排除國文英文與臺灣地理
function isMain(p) {
  if (!/專業職二/.test(p.rank || '')) return false
  if (!p.isMcqPaper) return false
  const s = p.subject || ''
  return /企業管理|郵政三法|郵政法規/.test(s) && !/國文|英文/.test(s)
}

async function main() {
  const papers = idx.papers.filter(isMain)
  console.log(`測試 ${papers.length} 份官方專業職(二) 主科卷\n`)
  let tg = 0, tb = 0
  for (const p of papers) {
    try {
      const buf = await cachedFetch(p.url, CACHE, { referer: 'https://svc.tabf.org.tw/', timeout: 45000 })
      const qs = await parsePostPdf(buf)
      const good = qs.filter(q => !q.incomplete)
      const bad = qs.filter(q => q.incomplete)
      tg += good.length; tb += bad.length
      const nums = qs.map(q => q.number)
      const gaps = []
      for (let i = 1; i <= Math.max(...nums, 0); i++) if (!nums.includes(i)) gaps.push(i)
      console.log(`  ${p.year} ${p.rank} / ${(p.subject || '').slice(0, 24)}`)
      console.log(`     抽出 ${qs.length}（完整 ${good.length}/殘缺 ${bad.length}）預期約 ${p.mcq}` +
        `${gaps.length ? ' 缺號:' + gaps.slice(0, 10).join(',') : ''}` +
        `${bad.length ? ' 殘缺:' + bad.map(q => q.number).join(',') : ''}`)
    } catch (e) {
      console.log(`  ✗ ${p.year} ${p.subject}: ${e.message}`)
    }
  }
  console.log(`\n總計：完整 ${tg}，殘缺 ${tb}`)
}
main().catch(e => { console.error(e); process.exit(1) })
