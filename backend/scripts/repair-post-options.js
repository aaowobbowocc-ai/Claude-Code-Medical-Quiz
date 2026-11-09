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

/*
 * 要重建哪些題。原本只挑「選項被切在半路」（結尾是逗號或左括號），
 * 2026-11-09 清掉隱形控制字元後又浮出兩種：選項整個空掉、兩個選項一模一樣
 * （原本那些選項裡只有一個看不見的 C1 標記字元，所以看起來「有內容、不重複」）。
 */
const isBroken = q => {
  const o = q.options || {}
  const v = ['A', 'B', 'C', 'D'].map(k => String(o[k] ?? '').trim())
  return v.some(x => CUT.test(x) || !x) || new Set(v).size < v.length
}

const clean = s => String(s || '').replace(/[-�]/g, '').replace(/[\u0080-\u009F]/g, '').replace(/\s+/g, ' ').trim()

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
  /*
   * 這些卷每個選項前面都有一個標記字元（U+0081..U+0084，原本是 ⒶⒷⒸⒹ）。
   * 有標記就直接用它切，比 x 縮排可靠得多：雙欄選項、換行選項、
   * 題幹佔兩行，這三種 x 縮排都會錯，標記都不會。
   */
  const mks = lines.filter(l => l.mk)
  if (mks.length === 4) {
    // 續行只認「垂直相鄰、而且左緣對齊」的下一行。
    // 這些卷側邊有直排書眉（第三節／專業科目(1)：…、＊入…），x 比選項欄再右一截，
    // 只看 y 擋不掉，會被接到選項尾巴上。
    const near = (a, b) => Math.abs(a.y - b.y) <= 22 && Math.abs(a.x - b.x) <= 20
    const first = lines.indexOf(mks[0])
    const out = []
    let stemM = lines[0].t.replace(ANCHOR, '$3'), prev = lines[0]
    for (const l of lines.slice(1, first)) { if (near(prev, l)) { stemM += l.t; prev = l } }
    for (const l of lines.slice(first)) {
      if (l.mk) { out.push(l.t); prev = l; continue }
      if (out.length && near(prev, l)) { out[out.length - 1] += l.t; prev = l }
    }
    const o = out.map(clean)
    if (o.length === 4 && !o.some(x => !x)) return { stem: clean(stemM), options: { A: o[0], B: o[1], C: o[2], D: o[3] } }
  }
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
  /*
   * 雙欄選項（A B 一列、C D 一列）用 x 縮排是切不出來的：右欄的 x 比左欄大，
   * 會被當成「續行」接到左欄後面，四個選項變成兩個。
   * 退而求其次 —— 題幹以外剛好四行時，直接依「先上後左」排序當成 A B C D。
   * 要求剛好四行，所以不會把換行的選項誤拆。
   */
  if (opts.length !== 4 && rest.length === 4) {
    const r4 = rest.slice().sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x))
    return { stem: clean(lines[0].t.replace(ANCHOR, '$3')), options: { A: clean(r4[0].t), B: clean(r4[1].t), C: clean(r4[2].t), D: clean(r4[3].t) } }
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
    /*
     * ⚠️ 不能直接用 structured-text 的「行」：選項是雙欄時，mupdf 常把同一列的
     *    左右兩欄併成一行（post-outdoor 107 #9 的 A、B 就併在 y=608 那一行），
     *    行的 bbox.x 只剩左欄的值，x 縮排判斷整組錯位 —— 當初爬蟲就是這樣爬壞的。
     *    改成逐字取座標，再在「本行左緣右邊的其他欄位起點」處切開。
     *    欄位起點取「至少 3 行共用的行首 x」，誤差 ±2px；中日文字寬 12px，
     *    左欄的字剛好落在右欄起點的機率很低。
     */
    const st = doc.loadPage(p).toStructuredText('preserve-whitespace')
    const raw = []
    let cur = null
    st.walk({
      beginLine() { cur = [] },
      onChar(c, origin, font, size, quad) { if (cur) cur.push({ x: origin[0], y: origin[1], r: quad ? quad[2] : origin[0], c }) },
      endLine() { if (cur && cur.length) raw.push(cur); cur = null },
    })
    // 欄位起點、縮排、間隙一律以「第一個非空白字」為準。
    // ⚠️ 行首常有一個空白字，位置比第一個字早約 11px；拿它當基準會讓
    //    合併行的右欄起點與單獨行的右欄起點差一格，間隙只剩 1px，切不開。
    const nsp = c => !/\s/.test(c.c)
    const head = ln => ln.find(nsp)
    const tally = {}
    for (const ln of raw) { const h = head(ln); if (h) { const k = Math.round(h.x); tally[k] = (tally[k] || 0) + 1 } }
    const origins = Object.keys(tally).map(Number).filter(k => tally[k] >= 3).sort((a, b) => a - b)
    const lines = []
    const push = seg => { const h = head(seg); if (!h) return; const t = clean(seg.map(ch => ch.c).join('')); if (t) lines.push({ mk: /[\u0080-\u009F]/.test(seg[0].c), x: Math.round(h.x), x2: Math.round(seg[seg.length - 1].x + 12), y: Math.round(h.y), t }) }
    for (const ln of raw) {
      const h0 = head(ln); if (!h0) continue
      let seg = [ln[0]]
      for (let k = 1; k < ln.length; k++) {
        // 最可靠的切點：選項標記本身。這些卷每個選項前面都有一個 U+0081..U+0084，
        // 它是原始 ⒶⒷⒸⒹ 標記在 PDF 的 ToUnicode 裡被當 cp1252 解過一次的產物。
        // 幾何判斷在這裡沒用 —— 左欄文字幾乎填滿欄寬，與右欄標記只差 1px。
        if (/[\u0080-\u009F]/.test(ln[k].c)) { if (k > 1) { push(seg); seg = [] } seg.push(ln[k]); continue }
        if (!nsp(ln[k])) { seg.push(ln[k]); continue }
        // 切點要同時落在某個欄位起點上、而且跟前一個非空白字之間有真實間隙。
        // 少了間隙這一條，橫跨整頁的題幹會在右欄起點處被腰斬。
        let pv = k - 1; while (pv > 0 && !nsp(ln[pv])) pv--
        if (ln[k].x - ln[pv].r >= 2 && origins.some(o => o > h0.x + 20 && Math.abs(ln[k].x - o) <= 2)) { push(seg); seg = [] }
        seg.push(ln[k])
      }
      push(seg)
    }
    // 依 x 分欄。**不能用固定寬度切**：三民的卷題幹在 x=599、選項在 x=614，
    // 用 300px 當界會把同一欄的題幹與選項拆到兩欄去（實測整卷一題都抓不到）。
    // 改成對 x 做間隙分群：排序後遇到 >120px 的空隙才算換欄。
    const xs = [...new Set(lines.map(l => l.x))].sort((a, b) => a - b)
    const bounds = []
    for (let i = 1; i < xs.length; i++) {
      const b = xs[i]
      if (b - xs[i - 1] <= 120) continue
      // ⚠️ 選項排成雙欄時也會出現 >120px 的空隙，但那不是頁面分欄。
      //    真正的分欄不會有任何一行跨過欄界；橫跨整頁的題幹就是反證
      //    （post-outdoor 107 的卷是單欄頁面＋雙欄選項，誤判成雙欄頁面後
      //     題幹與選項被拆到兩個欄去，整卷幾乎解不出來）。
      if (lines.some(l => l.x < b - 20 && l.x2 > b + 20)) continue
      bounds.push(b)
    }
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
      isBroken(q))
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
        isBroken(q))
      for (const q of broken) {
        const year = String(q.roc_year)
        // ⚠️ 不要寫死科目名。各年度叫法不同（郵政法規大意／郵政三法大意／
        //    郵政法大意及交通安全常識），寫死會讓整年的卷「索引裡找不到」而靜默跳過。
        //    直接拿題目自己的 subject_name 去比，比不到再退回關鍵字。
        const nameHit = r => (q.subject_name ? r.rel.includes(q.subject_name)
          : (q.subject_tag === 'post_law' ? /郵政法規大意|郵政三法|郵政法大意/ : /企業管理大意/).test(r.rel))
        const row = (sanmin.byYear[year] || []).find(r =>
          r.rel.includes('專業職(二)') && nameHit(r) && (r.rel.includes(side) || !/內勤|外勤/.test(r.rel)))
        if (!row) { console.log(`  ✗ ${file} ${year} #${q.number}: 三民索引找不到卷`); skipped++; continue }
        let parsed
        try { parsed = await parsePaper(row.url, { cache: path.join(ROOT, '_tmp', 'post-cache'), referer: 'https://www.3people.com.tw/' }) }
        catch (e) { console.log(`  ✗ ${year}: ${e.message.slice(0, 50)}`); skipped++; continue }
        if (process.env.DBG) console.log('  [dbg] 原卷解出', parsed.size, '題，號碼', [...parsed.keys()].slice(0, 25).join(','))
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
