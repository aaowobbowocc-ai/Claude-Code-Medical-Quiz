#!/usr/bin/env node
/**
 * 把「原卷文字層也壞掉」的題渲染成圖，交給對話讀圖還原。
 *
 * 有一批題不是我們解析錯，是**考選部 PDF 自己的文字層壞了**：
 * 臨床心理 106030 #2 的四個選項抽出來全是「①①①」，實際上是
 * ①③④ / ①②④ / ②③④ / ①②③——字型的 ToUnicode 對應表壞掉，
 * 所有圈號都映射到同一個碼位。這種再怎麼改解析器都救不回來。
 *
 * 但把那塊版面**畫成圖**就看得見了。渲染出來讓對話讀圖還原，零 API 成本
 * （專案原則：修題/audit/補圖能給對話做就不要走 Vertex）。
 *
 * 流程：
 *   1. node scripts/export-broken-for-vision.js --exam clinical-psychology
 *      → 圖片存到 _tmp/vision-broken/，並產生 manifest.json
 *   2. 對話讀圖，把還原的選項寫成 _tmp/vision-broken/answers.json
 *      格式：{ "<id>": { "A": "...", "B": "...", "C": "...", "D": "..." } }
 *   3. node scripts/apply-vision-options.js --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve')
const { IMAGE_REF } = require('./lib/image-ref')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d }
const EXAM = arg('--exam')
const LIMIT = +arg('--limit', '40')
// 預設只匯出 broken_options；題組解析失敗的題要連題幹一起看，用 --mark 指定
const MARK = arg('--mark', 'broken_options')
const DIR = path.join(__dirname, '..')
const OUT = path.join(DIR, '_tmp', 'vision-broken')
const SCALE = 2.5

;(async () => {
  const files = EXAM
    ? [EXAM === 'doctor1' ? 'questions.json' : `questions-${EXAM}.json`]
    : fs.readdirSync(DIR).filter(x => /^questions(-.*)?\.json$/.test(x) && !/\.bak/.test(x))
  fs.mkdirSync(OUT, { recursive: true })
  const manifest = []
  const mupdf = await import('mupdf')

  for (const f of files) {
    const exam = f === 'questions.json' ? 'doctor1' : f.replace('questions-', '').replace('.json', '')
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
    const arr = Array.isArray(raw) ? raw : raw.questions
    if (!arr) continue
    // --mark missing-image 是虛擬標記：那些題沒有 incomplete，
    // 它們的問題是「題幹提到圖、卻沒有圖」，得看版面才知道圖在哪
    const targets = MARK === 'missing-image'
      ? arr.filter(q => !q.incomplete && !q.no_image_in_source && !q.images && !q.image && !q.image_url &&
          IMAGE_REF.test(String(q.question || '')))
      : arr.filter(q => q.incomplete === MARK)
    if (!targets.length) continue

    const byPaper = new Map()
    for (const q of targets) {
      const k = `${q.exam_code}|${q.subject}`
      if (!byPaper.has(k)) byPaper.set(k, [])
      byPaper.get(k).push(q)
    }

    for (const [k, list] of byPaper) {
      if (manifest.length >= LIMIT) break
      const [code, subject] = k.split('|')
      const items = arr.filter(q => String(q.exam_code) === code && q.subject === subject)
      let buf = null
      try {
        const cand = await resolvePaper({ exam, code, year: items[0]?.roc_year, subject, items })
        if (cand) buf = await fetchSheet('Q', code, cand.c, cand.s)
      } catch {}
      if (!buf) { console.log(`  ${exam} ${code} ${subject}: 抓不到試題卷`); continue }
      const doc = mupdf.Document.openDocument(buf, 'application/pdf')

      // 先把每一頁的「題號行」位置建好索引，才知道每題的上下界
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
        pages.push({ pg, lines })
      }

      for (const q of list) {
        if (manifest.length >= LIMIT) break
        // 題號可能寫成「12」或「12.」，而且一定是縮排在最左邊
        const re = new RegExp(`^${q.number}[.．、]?$`)
        let found = null
        for (let p = 0; p < pages.length && !found; p++) {
          const { lines } = pages[p]
          const i = lines.findIndex(l => re.test(l.t) && l.x < 70)
          if (i < 0) continue
          const nx = lines.findIndex((l, m) => m > i && /^\d{1,3}[.．、]?$/.test(l.t) && l.x < 70)
          found = { p, top: lines[i].y - 5, bot: nx > 0 ? lines[nx].y - 2 : lines[i].y + 210 }
        }
        if (!found) { console.log(`  ${exam} ${code} #${q.number}: 在原卷找不到題號`); continue }

        const pg = pages[found.p].pg
        const px = pg.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false)
        const png = Buffer.from(px.asPNG())
        const top = Math.max(0, Math.floor(found.top * SCALE))
        const height = Math.min(px.getHeight() - top, Math.ceil((found.bot - found.top) * SCALE))
        if (height < 30) continue
        const name = `${exam}_${code}_${String(q.number).padStart(3, '0')}_${q.id}.png`
        await sharp(png).extract({ left: 0, top, width: px.getWidth(), height }).png().toFile(path.join(OUT, name))
        manifest.push({ file: name, exam, id: String(q.id), code, subject, number: q.number,
          current: q.options, currentQuestion: String(q.question || '').slice(0, 120) })
      }
    }
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`\n輸出 ${manifest.length} 張圖到 ${path.relative(DIR, OUT)}`)
})()
