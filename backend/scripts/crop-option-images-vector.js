#!/usr/bin/env node
/**
 * 切「畫出來的」選項圖：化學結構式、供需曲線這種**向量繪圖**的選項。
 *
 * 跟 crop-option-images-geometric.js 的差別：那支讀 PDF 內嵌點陣圖的座標
 * （中藥材照片那種）。但藥師一階的化學結構式整頁 0 張 image block——
 * 它是用線段畫出來的，抓不到 bbox。
 *
 * 這支改用**選項標記當上下界**：版面長這樣（x 是行左緣）
 *   y398 x25  41.下圖化合物為何者的代謝物？
 *   y537 x35  A.            ← 標記之間那 130pt 的空白就是結構式
 *   y666 x35  B.
 *   y794 x35  C.
 *   （D 常在下一頁頂端）
 * 所以 A 的圖 = y537 到 y666，以此類推；最後一個選項到下一題題號為止，
 * 跨頁時接著切下一頁頂端到第一個文字行。
 *
 * 裁完一律用像素統計驗證：整片接近純白就丟掉——那代表切到空白處。
 *
 * 用法：
 *   node scripts/crop-option-images-vector.js --exam pharma1 --show
 *   node scripts/crop-option-images-vector.js --exam pharma1 --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
// sharp 會快取解碼後的影像。同一個 buffer 反覆 extract 不同區域時，
// 快取會讓後續的 extract 拿到錯的尺寸資訊，一律回 "bad extract area"
// —— 同樣的參數拿到獨立 process 跑卻成功，就是這個原因。
sharp.cache(false)
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve')
const { warnZero, summary } = require('./lib/coverage-guard')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d }
const EXAM = arg('--exam')
const APPLY = process.argv.includes('--apply')
const SHOW = process.argv.includes('--show')
if (!EXAM) { console.error('需要 --exam'); process.exit(1) }
const DIR = path.join(__dirname, '..')
const OUT = path.join(DIR, '..', 'frontend', 'public', 'question-images')
const SCALE = 3
const MIN_H = 40          // 選項區塊至少要這麼高才可能是圖

;(async () => {
  const mupdf = await import('mupdf')
  fs.mkdirSync(OUT, { recursive: true })
  const FILE = path.join(DIR, EXAM === 'doctor1' ? 'questions.json' : `questions-${EXAM}.json`)
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const arr = raw.questions || raw
  const targets = arr.filter(q => q.incomplete === 'image_options' && !q.option_images)
  if (!targets.length) { console.log('沒有待處理的題'); return }

  const byPaper = new Map()
  for (const q of targets) {
    const k = `${q.exam_code}|${q.subject}`
    if (!byPaper.has(k)) byPaper.set(k, [])
    byPaper.get(k).push(q)
  }

  let done = 0, skipped = 0
  for (const [k, list] of byPaper) {
    const [code, subject] = k.split('|')
    const items = arr.filter(q => String(q.exam_code) === code && q.subject === subject)
    let buf = null
    try {
      const cand = await resolvePaper({ exam: EXAM, code, year: items[0]?.roc_year, subject, items })
      if (cand) buf = await fetchSheet('Q', code, cand.c, cand.s)
    } catch {}
    if (!buf) { console.log(`  ${code} ${subject}: 抓不到試題卷`); skipped += list.length; continue }
    const doc = mupdf.Document.openDocument(buf, 'application/pdf')

    // 每頁的文字行 + 該頁的 pixmap（延後產生，用到才算）
    const pages = []
    for (let p = 0; p < doc.countPages(); p++) {
      const pg = doc.loadPage(p)
      const st = JSON.parse(pg.toStructuredText('preserve-whitespace').asJSON())
      const lines = []
      for (const b of st.blocks || []) for (const l of b.lines || []) {
        const t = (l.text || '').trim()
        if (t) lines.push({ y: l.bbox.y, h: l.bbox.h, x: Math.round(l.bbox.x), t })
      }
      lines.sort((a, b) => a.y - b.y)
      pages.push({ lines, png: null, w: 0, h: 0 })
    }
    // 用到時才 loadPage 並算 pixmap。先前把 11 頁的 page 物件全握在手上，
    // 之後 toPixmap 出來的 buffer 與 sharp 對不上（extract 一律 bad extract area）。
    const pixmapOf = (pi) => {
      const p = pages[pi]
      if (!p.png) {
        const pg2 = doc.loadPage(pi)
        const px = pg2.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false)
        p.png = Buffer.from(px.asPNG()); p.w = px.getWidth(); p.h = px.getHeight()
      }
      return p
    }

    for (const q of list) {
      // 找題號行
      let at = null
      for (let pi = 0; pi < pages.length && !at; pi++) {
        const i = pages[pi].lines.findIndex(l => new RegExp(`^${q.number}\s*[.．、]`).test(l.t) && l.x < 70)
        if (i >= 0) at = { pi, i }
      }
      if (!at) { skipped++; continue }

      // 從題號往後找四個選項標記（A. B. C. D.），可能跨頁
      const marks = []
      let pi = at.pi, i = at.i + 1
      while (pi < pages.length && marks.length < 4) {
        const lines = pages[pi].lines
        if (i >= lines.length) { pi++; i = 0; continue }
        const l = lines[i]
        const m = l.t.match(/^([A-D])\s*[.．、]\s*(.*)$/)
        // 下一題的題號 → 停
        if (/^\d{1,3}\s*[.．、]/.test(l.t) && l.x < 70 && marks.length) break
        if (m && m[1] === 'ABCD'[marks.length]) marks.push({ pi, y: l.y, h: l.h, tail: m[2].trim() })
        i++
      }
      if (marks.length !== 4) { skipped++; continue }
      // 標記後面若已經有文字內容，那是一般文字選項，不該走這支
      if (marks.some(m => m.tail.length > 3)) { skipped++; continue }

      const paths = {}
      let bad = false
      for (let oi = 0; oi < 4 && !bad; oi++) {
        const cur = marks[oi], nxt = marks[oi + 1]
        const top = cur.y + cur.h
        let bottom
        if (nxt && nxt.pi === cur.pi) bottom = nxt.y - 2
        else {
          // 該頁最後一個選項：切到下一題題號或頁尾
          const after = pages[cur.pi].lines.find(l => l.y > top + MIN_H && /^\d{1,3}\s*[.．、]/.test(l.t) && l.x < 70)
          bottom = after ? after.y - 2 : null
        }
        const p = pixmapOf(cur.pi)
        const y0 = Math.max(0, Math.floor(top * SCALE))
        const y1 = bottom ? Math.min(p.h, Math.ceil(bottom * SCALE)) : p.h
        if (y1 - y0 < MIN_H * SCALE) { bad = true; break }
        const name = `${EXAM}_${q.id}_vopt${'ABCD'[oi]}.webp`
        try {
          // 注意：sharp 的 pipeline 用過就不能再用，每次都要從 buffer 重建，
          // 否則 dry-run（只跑 stats）會過、--apply（再跑 toFile）卻整批失敗。
          // 一次裁切、一次輸出。sharp 的 pipeline 不能重複使用，
          // 分兩次 extract 同一區域會在第二次拋 extract_area（dry-run 過、apply 卻全滅）。
          // ⚠️ 不要在這裡用 .trim()：區域若幾乎全白，trim 會把內容裁成 0×0，
          //    sharp 內部丟出來的是 "extract_area: bad extract area"——
          //    看起來像是裁切座標錯，實際上座標完全正確，害我追錯方向很久。
          //    先裁固定區域、用像素統計判斷是不是空白，確定有內容才 trim。
          const box = { left: 0, top: y0, width: p.w, height: Math.max(1, y1 - y0) }
          const st2 = await sharp(p.png).extract(box).stats()
          if (st2.channels.every(c => c.stdev < 3)) { bad = true; break }   // 全白＝切到空白
          let cut
          try {
            cut = await sharp(p.png).extract(box).trim().webp({ quality: 85 }).toBuffer()
          } catch {
            cut = await sharp(p.png).extract(box).webp({ quality: 85 }).toBuffer()
          }
          if (APPLY) fs.writeFileSync(path.join(OUT, name), cut)
        } catch (e) {
          console.log(`      ✖ #${q.number} ${'ABCD'[oi]}: ${e.message} (top=${y0} bottom=${y1} pixmap=${p.w}x${p.h})`)
          bad = true; break
        }
        paths['ABCD'[oi]] = '/question-images/' + name
      }
      if (bad) { skipped++; continue }
      console.log(`  ✔ ${code} ${subject} #${q.number} → 4 張結構式選項圖`)
      if (SHOW) console.log(`      ${String(q.question).slice(0, 50)}`)
      if (APPLY) { q.option_images = paths; delete q.incomplete }
      done++
    }
  }

  if (APPLY && done) {
    if (raw.metadata) raw.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(FILE, JSON.stringify(raw, null, 2) + String.fromCharCode(10))
  }
  console.log(`\n切出 ${done} 題的選項圖，跳過 ${skipped} 題${APPLY ? '（已寫入）' : '（dry-run）'}`)
  warnZero('向量選項圖切割', done, '沒有 image_options 的題，或找不到四個選項標記')
  process.exitCode = summary()
})()
