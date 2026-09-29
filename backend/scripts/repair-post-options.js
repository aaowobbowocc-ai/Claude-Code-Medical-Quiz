#!/usr/bin/env node
/**
 * 重建郵局題庫裡「選項錯位」的題。
 *
 * 版面（svc.tabf 官方卷，雙欄，每欄內）：
 *   x601 "【3】14.依郵政法有關郵件投遞之規定，下列敘述何者錯誤？"   ← 題幹，最左
 *   x616 "除另有約定外，各類郵件應按其表面所書收件人之地址投遞"     ← 選項起始
 *   x616 "收件地址係地面層以外樓層…各類郵件得交該管理服務人員或郵件收"
 *   x626 "發處收領"                                            ← **續行，往右縮排**
 *   x616 "收件地址係地面層以外樓層，地面層未設有…"
 *
 * lib/post-parser.js 的 `collectOptions()` 是「取最後四段」，
 * 一旦某個選項換行就會整組錯位：題幹吃掉選項 A、最後一個選項被切成兩半
 * （post-outdoor 114 #14 實測）。這裡改用 **x 縮排** 判斷續行。
 *
 * 答案不用猜：題號前綴的【X】就是官方答案（【3】= C）。
 *
 *   node scripts/repair-post-options.js            # dry-run
 *   node scripts/repair-post-options.js --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { cachedFetch } = require('./lib/pdf-fetcher')
const { optionKey } = require('./lib/moex-normalize')
const { atomicWriteJson } = require('./lib/atomic-write')

const ROOT = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const CACHE = path.join(ROOT, '_tmp', 'post-official-cache')
const CUT = /[、，,（(]$/
const ANCHOR = /^【\s*([^】]{1,16})\s*】\s*(\d{1,3})\s*[.．、]?\s*(.*)$/

const clean = s => String(s || '').replace(/[-�]/g, '').replace(/\s+/g, ' ').trim()

/** 【3】→ C；多個數字＝爭議題，取第一個。 */
function markerAnswer(raw) {
  const nums = (raw.match(/[1-4]/g) || []).map(Number)
  if (!nums.length) return null
  return { answer: 'ABCD'[nums[0] - 1], disputed: nums.length > 1 || /送分|給分|一律|皆可|或/.test(raw) }
}

/** 依 x 縮排把一欄的行切成「題幹 + 四個選項」。 */
function blockToQuestion(lines) {
  if (lines.length < 5) return null
  const stemX = lines[0].x
  // 選項起始 x = 題幹以外最靠左的 x
  const rest = lines.slice(1)
  const optX = Math.min(...rest.map(l => l.x))
  const opts = []
  let stem = lines[0].t.replace(ANCHOR, '$3')
  for (const l of rest) {
    if (l.x <= optX + 4) opts.push(l.t)                       // 新選項
    else if (opts.length) opts[opts.length - 1] += l.t        // 續行（往右縮排）
    else stem += l.t                                          // 還沒開始選項 → 還是題幹
  }
  if (opts.length !== 4) return null
  const o = opts.map(clean)
  if (o.some(x => !x)) return null
  return { stem: clean(stem), options: { A: o[0], B: o[1], C: o[2], D: o[3] } }
}

/** 抽一份卷的所有題：依 x 分欄、依【X】題號錨點切塊。 */
async function parsePaper(url, opt = {}) {
  const mupdf = await import('mupdf')
  const buf = await cachedFetch(url, opt.cache || CACHE,
    { referer: opt.referer || 'https://svc.tabf.org.tw/', timeout: 60000 })
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const out = new Map()
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-images').asJSON())
    const lines = []
    for (const b of st.blocks || []) {
      if (b.type !== 'text') continue
      for (const ln of b.lines || []) {
        const t = clean(ln.text)
        if (!t) continue
        lines.push({ x: Math.round(ln.bbox.x), y: Math.round(ln.bbox.y), t })
      }
    }
    // 依 x 分欄。**不能用固定寬度切**：三民的卷題幹在 x=599、選項在 x=614，
    // 用 300px 當界會把同一欄的題幹與選項拆到兩欄去（實測整卷一題都抓不到）。
    // 改成對 x 做間隙分群：排序後遇到 >120px 的空隙才算換欄。
    const xs = [...new Set(lines.map(l => l.x))].sort((a, b) => a - b)
    const bounds = []
    for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 120) bounds.push(xs[i])
    const colOf = x => bounds.filter(b => x >= b).length
    const cols = new Map()
    for (const l of lines) {
      const c = colOf(l.x)
      if (!cols.has(c)) cols.set(c, [])
      cols.get(c).push(l)
    }
    for (const col of [...cols.keys()].sort((a, b) => a - b)) {
      const arr = cols.get(col).sort((a, b) => a.y - b.y || a.x - b.x)
      let block = null
      const flush = () => {
        if (!block) return
        const m = ANCHOR.exec(block[0].t)
        if (m) {
          const mk = markerAnswer(m[1])
          const q = blockToQuestion(block)
          if (mk && q) out.set(+m[2], { ...q, ...mk })
        }
        block = null
      }
      for (const l of arr) {
        if (ANCHOR.test(l.t)) { flush(); block = [l] }
        else if (block) block.push(l)
      }
      flush()
    }
  }
  return out
}

// 受影響的卷：從官方索引挑（只有 svc.tabf 來源的卷有 PDF 可重解）
const index = JSON.parse(fs.readFileSync(path.join(ROOT, '_tmp', '_post-official-index.json'), 'utf8'))
function findPaper(year, rank, subjectName) {
  return (index.papers || []).find(p => String(p.year) === String(year) && p.rank === rank &&
    String(p.subject).slice(0, 12) === String(subjectName).slice(0, 12))
}

;(async () => {
  const cache = {}
  let fixed = 0, skipped = 0
  const reasons = {}
  for (const [file, rank] of [['questions-post-outdoor.json', '專業職二外勤'], ['questions-post-indoor.json', '專業職二內勤']]) {
    const p = path.join(ROOT, file)
    const j = cache[file] || (cache[file] = JSON.parse(fs.readFileSync(p, 'utf8')))
    const arr = j.questions || j
    const broken = arr.filter(q => String(q.source || '').includes('svc.tabf') &&
      Object.values(q.options || {}).some(v => CUT.test(String(v || '').trim())))
    const byPaper = new Map()
    for (const q of broken) {
      const k = q.roc_year + '\u0000' + q.subject_name
      if (!byPaper.has(k)) byPaper.set(k, [])
      byPaper.get(k).push(q)
    }
    for (const [k, qs] of byPaper) {
      const [year, subjectName] = k.split('\u0000')
      const paper = findPaper(year, rank, subjectName)
      if (!paper) { console.log(`  ✗ ${file} ${year} ${subjectName.slice(0, 20)}: 索引裡找不到卷`); skipped += qs.length; continue }
      let parsed
      try { parsed = await parsePaper(paper.url) }
      catch (e) { console.log(`  ✗ ${year}: ${e.message.slice(0, 50)}`); skipped += qs.length; continue }
      for (const q of qs) {
        const o = parsed.get(+q.number)
        const bump = r => { reasons[r] = (reasons[r] || 0) + 1; skipped++ }
        if (!o) { bump('原卷解析不到該題號'); continue }
        const vals = ['A', 'B', 'C', 'D'].map(x => o.options[x])
        if (vals.some(v => !v) || new Set(vals.map(optionKey)).size !== 4) { bump('原卷選項不乾淨'); continue }
        if (vals.some(v => CUT.test(v))) { bump('原卷仍切在半路'); continue }
        console.log(`\n${file.replace(/questions-|\.json/g, '')} ${year} #${q.number}  答${q.answer}→${o.answer}${o.disputed ? '（爭議）' : ''}`)
        console.log(`  舊題幹: ${String(q.question).slice(0, 70)}`)
        console.log(`  新題幹: ${o.stem.slice(0, 70)}`)
        console.log(`  舊選項: ${['A', 'B', 'C', 'D'].map(x => q.options[x]).join(' | ').slice(0, 110)}`)
        console.log(`  新選項: ${vals.join(' | ').slice(0, 110)}`)
        if (APPLY) {
          q.question = o.stem
          q.options = { ...o.options }
          q.answer = o.answer
          if (o.disputed) q.disputed = true
        }
        fixed++
      }
    }
  }
  // ── 三民來源（104/105/107 年）。版面一樣是「題幹最左、選項往右縮排」，
  //    只是 PDF 在別的站，索引由 probe-post.js 產生（_tmp/_post-index.json）。
  const sanminPath = path.join(ROOT, '_tmp', '_post-index.json')
  if (fs.existsSync(sanminPath)) {
    const sanmin = JSON.parse(fs.readFileSync(sanminPath, 'utf8'))
    for (const [file, side] of [['questions-post-outdoor.json', '外勤'], ['questions-post-indoor.json', '內勤']]) {
      const j = cache[file] || (cache[file] = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')))
      const arr = j.questions || j
      const broken = arr.filter(q => String(q.source || '').includes('3people') &&
        Object.values(q.options || {}).some(v => CUT.test(String(v || '').trim())))
      for (const q of broken) {
        const year = String(q.roc_year)
        const want = q.subject_tag === 'post_law' ? /郵政法規大意|郵政三法/ : /企業管理大意/
        const row = (sanmin.byYear[year] || []).find(r =>
          r.rel.includes('專業職(二)') && want.test(r.rel) && (r.rel.includes(side) || !/內勤|外勤/.test(r.rel)))
        if (!row) { console.log(`  ✗ ${file} ${year} #${q.number}: 三民索引找不到卷`); skipped++; continue }
        let parsed
        try { parsed = await parsePaper(row.url, { cache: path.join(ROOT, '_tmp', 'post-cache'), referer: 'https://www.3people.com.tw/' }) }
        catch (e) { console.log(`  ✗ ${year}: ${e.message.slice(0, 50)}`); skipped++; continue }
        const o = parsed.get(+q.number)
        const bump = r => { reasons[r] = (reasons[r] || 0) + 1; skipped++ }
        if (!o) { bump('原卷解析不到該題號'); continue }
        const vals = ['A', 'B', 'C', 'D'].map(x => o.options[x])
        if (vals.some(v => !v) || new Set(vals.map(optionKey)).size !== 4 || vals.some(v => CUT.test(v))) { bump('原卷選項不乾淨'); continue }
        console.log(`\n${file.replace(/questions-|\.json/g, '')} ${year} #${q.number}  答${q.answer}→${o.answer}`)
        console.log(`  舊選項: ${['A', 'B', 'C', 'D'].map(x => q.options[x]).join(' | ').slice(0, 110)}`)
        console.log(`  新選項: ${vals.join(' | ').slice(0, 110)}`)
        if (APPLY) { q.question = o.stem; q.options = { ...o.options }; q.answer = o.answer; if (o.disputed) q.disputed = true }
        fixed++
      }
    }
  }

  console.log(`\n重建 ${fixed} 題；跳過 ${skipped}（${JSON.stringify(reasons)}）${APPLY ? '' : '（dry-run）'}`)
  if (APPLY) {
    for (const [f, j] of Object.entries(cache)) {
      const arr = j.questions || j
      if (j.total !== undefined) j.total = arr.length
      atomicWriteJson(path.join(ROOT, f), j)
    }
    console.log('✅ 已寫回')
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
