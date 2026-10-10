#!/usr/bin/env node
/**
 * 用修好的 lib/post-parser.js 重新切郵局題的「題幹／選項」邊界。
 *
 * 背景：post-parser.js 原本的 collectOptions() 是「取前四段」，選項一換行就整組
 * 錯位（題幹吃掉選項 A、最後一個選項被切掉）。2026-10-10 把 x 縮排判準移植進
 * parser 本體後，重解整卷就會給出正確切點。
 *
 * repair-post-options.js 當初只撈「選項結尾是、，（」的題，所以漏掉碎片結尾不是
 * 那些字的 29 題——這支用 parser 全卷重解來補。
 *
 * **安全閘：題幹+四個選項串接後必須與題庫完全相同**（NFKC + 去空白）。
 * 相同代表只是切點不同，沒有內容錯置、沒有抓到別題；不同就不動，另案處理。
 *
 *   node scripts/repair-post-by-parser.js            # dry-run
 *   node scripts/repair-post-by-parser.js --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { cachedFetch } = require('./lib/pdf-fetcher')
const { parsePostPdf } = require('./lib/post-parser')
const { atomicWriteJson } = require('./lib/atomic-write')

const ROOT = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const OFFICIAL_CACHE = path.join(ROOT, '_tmp', 'post-official-cache')
const SANMIN_CACHE = path.join(ROOT, '_tmp', 'post-cache')
const officialIdx = JSON.parse(fs.readFileSync(path.join(ROOT, '_tmp', '_post-official-index.json'), 'utf8'))
const sanminIdx = JSON.parse(fs.readFileSync(path.join(ROOT, '_tmp', '_post-index.json'), 'utf8'))

const norm = s => String(s || '').replace(/[\s　]/g, '').normalize('NFKC')
const seqOf = q => norm(q.question) + ['A', 'B', 'C', 'D'].map(x => norm(q.options?.[x])).join('')

function resolveUrl(exam, year, subjectName, source, side, tag) {
  if (String(source).includes('svc.tabf')) {
    const rank = exam === 'post-outdoor' ? '專業職二外勤' : '專業職二內勤'
    const p = (officialIdx.papers || []).find(p => String(p.year) === String(year) && p.rank === rank &&
      String(p.subject).slice(0, 12) === String(subjectName).slice(0, 12))
    return p && { url: p.url, cache: OFFICIAL_CACHE, referer: 'https://svc.tabf.org.tw/' }
  }
  const want = tag === 'post_law' ? /郵政法規大意|郵政三法|郵政法大意/ : /企業管理大意/
  const row = (sanminIdx.byYear[String(year)] || []).find(r =>
    r.rel.includes('專業職(二)') && want.test(r.rel) && (r.rel.includes(side) || !/內勤|外勤/.test(r.rel)))
  return row && { url: row.url, cache: SANMIN_CACHE, referer: 'https://www.3people.com.tw/' }
}

;(async () => {
  const cache = {}
  let same = 0, fixed = 0, answerFixed = 0
  const skipped = []
  for (const [file, side] of [['questions-post-outdoor.json', '外勤'], ['questions-post-indoor.json', '內勤']]) {
    const exam = file.replace('questions-', '').replace('.json', '')
    const j = cache[file] || (cache[file] = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')))
    const arr = j.questions || j
    const byPaper = new Map()
    for (const q of arr) {
      const k = [q.roc_year, q.subject_name, q.source, q.subject_tag].join('\u0000')
      if (!byPaper.has(k)) byPaper.set(k, [])
      byPaper.get(k).push(q)
    }
    for (const [k, qs] of byPaper) {
      const [year, subjectName, source, tag] = k.split('\u0000')
      const loc = resolveUrl(exam, year, subjectName, source, side, tag)
      if (!loc) { skipped.push({ exam, year, reason: '索引找不到卷', n: qs.length }); continue }
      let parsed
      try {
        const buf = await cachedFetch(loc.url, loc.cache, { referer: loc.referer, timeout: 60000 })
        parsed = new Map((await parsePostPdf(buf)).map(q => [+q.number, q]))
      } catch (e) { skipped.push({ exam, year, reason: e.message.slice(0, 40), n: qs.length }); continue }

      for (const q of qs) {
        const o = parsed.get(+q.number)
        if (!o || o.incomplete) { skipped.push({ exam, year, n: q.number, reason: '重解不到' }); continue }
        if (seqOf(o) === seqOf(q) && norm(o.question) === norm(q.question)) { same++; continue }
        // 安全閘：只允許切點不同
        if (seqOf(o) !== seqOf(q)) {
          skipped.push({ exam, year, n: q.number, reason: '內容不只切點不同' })
          continue
        }
        console.log(`\n${exam} ${year} #${q.number}${String(o.answer) !== String(q.answer) ? `  答 ${q.answer}→${o.answer}` : ''}`)
        console.log(`  舊題幹: ${String(q.question).slice(0, 72)}`)
        console.log(`  新題幹: ${String(o.question).slice(0, 72)}`)
        console.log(`  舊選項: ${['A', 'B', 'C', 'D'].map(x => q.options[x]).join(' | ').slice(0, 120)}`)
        console.log(`  新選項: ${['A', 'B', 'C', 'D'].map(x => o.options[x]).join(' | ').slice(0, 120)}`)
        if (String(o.answer) !== String(q.answer)) answerFixed++
        if (APPLY) {
          q.question = o.question
          q.options = { ...o.options }
          q.answer = o.answer
          if (o.disputed) q.disputed = true
        }
        fixed++
      }
    }
  }
  console.log(`\n切點重建 ${fixed} 題（其中答案也跟著改 ${answerFixed} 題）｜本來就一致 ${same} 題${APPLY ? '' : '（dry-run）'}`)
  if (skipped.length) console.log(`跳過 ${skipped.reduce((s, x) => s + (x.n > 1 ? x.n : 1), 0)}：`, JSON.stringify(skipped.slice(0, 10)))
  if (APPLY) {
    for (const [f, j] of Object.entries(cache)) {
      const arr = j.questions || j
      if (j.total !== undefined) j.total = arr.length
      atomicWriteJson(path.join(ROOT, f), j)
    }
    console.log('✅ 已寫回')
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
