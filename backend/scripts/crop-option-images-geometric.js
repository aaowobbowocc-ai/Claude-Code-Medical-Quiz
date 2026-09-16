#!/usr/bin/env node
/**
 * 把「選項本身是圖」的題，從原卷切出 4 張選項圖。
 *
 * 中醫一階的中藥材辨識題、醫檢的血球圖、藥師的化學結構式都是這種：
 * 題幹是文字，四個選項是四張圖。文字解析只會得到「(圖)(圖)(圖)(圖)」。
 *
 * 跟既有的 crop-option-images.js 的差別：那支用 Vertex Gemini 偵測 bounding box
 * （會產生 API 費用，5/22 跑一次 batch 就燒掉 $200+）。這支純用 mupdf 讀
 * PDF 內嵌圖片的座標——那些圖本來就是獨立的 image block，座標是現成的，
 * 不需要任何模型。零成本、而且比模型偵測精確。
 *
 * 判法：抓題號 y 到下一題號 y 之間、夠大的 image block，
 * 先按 y 分列再按 x 排序（選項可能是一橫排，也可能是 2×2），恰好 4 張才處理。
 *
 * 用法：
 *   node scripts/crop-option-images-geometric.js --exam tcm1
 *   node scripts/crop-option-images-geometric.js --all --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve')
const { warnZero, summary } = require('./lib/coverage-guard')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d }
const EXAM = arg('--exam')
const ALL = process.argv.includes('--all')
const APPLY = process.argv.includes('--apply')
const DIR = path.join(__dirname, '..')
const OUT = path.join(DIR, '..', 'frontend', 'public', 'question-images')
const SCALE = 3
const MIN_DIM = 40

;(async () => {
  const mupdf = await import('mupdf')
  fs.mkdirSync(OUT, { recursive: true })
  const files = ALL || !EXAM
    ? fs.readdirSync(DIR).filter(x => /^questions(-.*)?\.json$/.test(x) && !/\.bak/.test(x))
    : [EXAM === 'doctor1' ? 'questions.json' : `questions-${EXAM}.json`]

  let done = 0, skipped = 0
  for (const f of files) {
    const exam = f === 'questions.json' ? 'doctor1' : f.replace('questions-', '').replace('.json', '')
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
    const arr = Array.isArray(raw) ? raw : raw.questions
    if (!arr) continue
    const targets = arr.filter(q => q.incomplete === 'image_options' && !q.option_images)
    if (!targets.length) continue

    const byPaper = new Map()
    for (const q of targets) {
      const k = `${q.exam_code}|${q.subject}`
      if (!byPaper.has(k)) byPaper.set(k, [])
      byPaper.get(k).push(q)
    }
    let touched = 0

    for (const [k, list] of byPaper) {
      const [code, subject] = k.split('|')
      const items = arr.filter(q => String(q.exam_code) === code && q.subject === subject)
      let buf = null
      try {
        const cand = await resolvePaper({ exam, code, year: items[0]?.roc_year, subject, items })
        if (cand) buf = await fetchSheet('Q', code, cand.c, cand.s)
      } catch {}
      if (!buf) { console.log(`  ${exam} ${code} ${subject}: 抓不到試題卷`); skipped += list.length; continue }
      const doc = mupdf.Document.openDocument(buf, 'application/pdf')

      const pages = []
      for (let p = 0; p < doc.countPages(); p++) {
        const pg = doc.loadPage(p)
        const st = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
        const lines = [], imgs = []
        for (const b of st.blocks || []) {
          if (b.type === 'image') { if (b.bbox.w >= MIN_DIM && b.bbox.h >= MIN_DIM) imgs.push(b.bbox); continue }
          for (const l of b.lines || []) {
            const t = (l.text || '').trim()
            if (t) lines.push({ y: l.bbox.y, x: Math.round(l.bbox.x), t })
          }
        }
        lines.sort((a, b) => a.y - b.y)
        pages.push({ pg, lines, imgs })
      }

      for (const q of list) {
        const re = new RegExp(`^${q.number}[.．、]?$`)
        let hit = null
        for (let p = 0; p < pages.length && !hit; p++) {
          const { lines } = pages[p]
          const i = lines.findIndex(l => re.test(l.t) && l.x < 70)
          if (i < 0) continue
          const nx = lines.findIndex((l, m) => m > i && /^\d{1,3}[.．、]?$/.test(l.t) && l.x < 70)
          hit = { p, top: lines[i].y - 2, bot: nx > 0 ? lines[nx].y - 2 : 1e4 }
        }
        if (!hit) { skipped++; continue }
        const within = pages[hit.p].imgs.filter(b => b.y >= hit.top && b.y < hit.bot)
        if (within.length !== 4) {
          console.log(`  ${exam} ${code} #${q.number}: 該範圍有 ${within.length} 張圖（需要剛好 4 張），跳過`)
          skipped++; continue
        }
        // 選項可能排成一橫排，也可能 2×2 —— 先按列（y 容差 20）再按 x
        const sorted = [...within].sort((a, b) => (Math.abs(a.y - b.y) > 20 ? a.y - b.y : a.x - b.x))
        const pg = pages[hit.p].pg
        const px = pg.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false)
        const png = Buffer.from(px.asPNG())
        const paths = {}
        for (let i = 0; i < 4; i++) {
          const b = sorted[i]
          const left = Math.max(0, Math.floor((b.x - 1) * SCALE))
          const top = Math.max(0, Math.floor((b.y - 1) * SCALE))
          const width = Math.min(px.getWidth() - left, Math.ceil((b.w + 2) * SCALE))
          const height = Math.min(px.getHeight() - top, Math.ceil((b.h + 2) * SCALE))
          if (width < 20 || height < 20) { paths.__bad = true; break }
          const name = `${exam}_${q.id}_opt${'ABCD'[i]}.webp`
          if (APPLY) await sharp(png).extract({ left, top, width, height }).webp({ quality: 85 }).toFile(path.join(OUT, name))
          paths['ABCD'[i]] = '/question-images/' + name
        }
        if (paths.__bad) { skipped++; continue }
        console.log(`  ✔ ${exam} ${code} ${subject} #${q.number} → 4 張選項圖`)
        if (APPLY) { q.option_images = paths; delete q.incomplete }
        done++; touched++
      }
    }
    if (APPLY && touched) {
      if (raw.metadata) raw.metadata.last_updated = new Date().toISOString()
      fs.writeFileSync(path.join(DIR, f), JSON.stringify(raw, null, 2) + '\n')
    }
  }

  console.log(`\n切出 ${done} 題的選項圖，跳過 ${skipped} 題${APPLY ? '（已寫入）' : '（dry-run）'}`)
  warnZero('選項圖切割', done, '沒有 image_options 的題，或原卷圖片數量對不上 4 張')
  process.exitCode = summary()
})()
