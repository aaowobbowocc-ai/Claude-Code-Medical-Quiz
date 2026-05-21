#!/usr/bin/env node
/**
 * medlab 含圖題圖片整批重建
 *
 * 背景：questions-medlab.json 內 380 題含 images，但圖片連結大範圍錯亂
 *（指到別題的圖、甚至指到 PDF 純文字裁切）。原因是舊抓圖腳本的題↔圖
 * 連結邏輯壞掉。本腳本從考選部原始 PDF 以座標式重新定位每題的圖。
 *
 * 兩種圖：
 *   A. 點陣圖（顯微照片/超音波/電泳膠）— preserve-images 取得 image 物件
 *   B. 向量圖（心電圖等）— PDF 內無 image 物件，靠「題內最大文字空隙」偵測，
 *      渲染該band後用 sharp.trim() 去白邊收緊
 *
 * 用法：
 *   node scripts/_rebuild-medlab-images.js index           # 重建 PDF 索引
 *   node scripts/_rebuild-medlab-images.js dry [examcode]   # 試跑（不寫檔），列覆蓋率
 *   node scripts/_rebuild-medlab-images.js run [examcode]   # 正式跑：抓圖 + 回寫 json
 */
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const ROOT = path.join(__dirname, '..')
const PDF_DIR = path.join(ROOT, '_tmp', 'pdf-cache')
const PDF_INDEX = path.join(ROOT, '_tmp', '_medlab-pdf-index.json')
const QJSON = path.join(ROOT, 'questions-medlab.json')
const IMG_OUT = path.join(ROOT, '..', 'frontend', 'public', 'question-images')
const SCALE = 3
const GAP_MIN = 50          // 向量圖：題內文字空隙 ≥ 此值(pt) 才視為圖
const MIN_OUT_PX = 90       // 裁切後最小邊長(px)，太小視為雜訊丟棄

const SUBJ_CODE = {
  '臨床生理學與病理學': 'physio',
  '臨床血液學與血庫學': 'blood',
  '醫學分子檢驗學與臨床鏡檢學': 'molmicro',
  '微生物學與臨床微生物學': 'micro',
  '生物化學與臨床生化學': 'biochem',
  '臨床血清免疫學與臨床病毒學': 'immuno',
}
// 科目別名 → 正規科目名（舊年份 100-102 科目名與現行不同）
const SUBJ_ALIASES = [
  ['臨床生理學與病理學', '臨床生理學與病理學'],
  ['臨床血液學與血庫學', '臨床血液學與血庫學'],
  ['臨床血液學與血庫', '臨床血液學與血庫學'],   // 標頭亂碼截斷（缺「學」）的容錯
  ['醫學分子檢驗學與臨床鏡檢學', '醫學分子檢驗學與臨床鏡檢學'],
  ['臨床鏡檢學', '醫學分子檢驗學與臨床鏡檢學'],        // 舊名
  ['微生物學與臨床微生物學', '微生物學與臨床微生物學'],
  ['微生物學及臨床微生物學', '微生物學與臨床微生物學'],  // 舊名（及）
  ['生物化學與臨床生化學', '生物化學與臨床生化學'],
  ['臨床血清免疫學與臨床病毒學', '臨床血清免疫學與臨床病毒學'],
]
function subjKey(subject) {
  if (!subject) return null
  // NFKC 正規化 — PDF 字型常用 CJK 相容表意字，碼位不同會比對失敗
  const s = String(subject).normalize('NFKC')
  for (const [alias, canon] of SUBJ_ALIASES) {
    if (s.includes(alias)) return canon
  }
  return null
}

// 合併重疊/相鄰的點陣圖塊（處理掃描線碎片 + 多段拼接圖）
function mergeImageBlocks(blocks) {
  let boxes = blocks.filter(b => b.type === 'image').map(b => ({
    x0: b.bbox.x, y0: b.bbox.y, x1: b.bbox.x + b.bbox.w, y1: b.bbox.y + b.bbox.h,
  }))
  let changed = true
  while (changed) {
    changed = false
    outer:
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j]
        const xOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > -8
        const yGap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1)
        if (xOverlap && yGap < 12) {
          a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0)
          a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1)
          boxes.splice(j, 1); changed = true; break outer
        }
      }
    }
  }
  return boxes.filter(g => (g.x1 - g.x0) > 38 && (g.y1 - g.y0) > 22)
            .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
}

// 抽一份 PDF：回傳 { [題號]: { raster: [webpBuf...], vector: webpBuf|null } }
async function extractPdfImages(pdfPath, mupdf) {
  const doc = mupdf.Document.openDocument(new Uint8Array(fs.readFileSync(pdfPath)), 'application/pdf')
  const byQ = {}
  const ensure = n => (byQ[n] = byQ[n] || { raster: [], vector: null })
  let lastQ = null

  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p)
    const bounds = page.getBounds()
    const pageW = bounds[2], pageBottom = bounds[3]
    const st = JSON.parse(page.toStructuredText('preserve-images').asJSON())
    const blocks = st.blocks || []

    // 題號行
    const qlines = []
    const textIv = []   // 所有文字行 y 區間
    for (const b of blocks) {
      if (b.type !== 'text') continue
      for (const l of (b.lines || [])) {
        const y0 = l.bbox.y, y1 = l.bbox.y + l.bbox.h
        textIv.push([y0, y1])
        const t = (l.text || '').trim()
        // 新格式「12.題幹」；舊格式（100-102 年）題號自成一行純數字、
        // 位於左欄（x<68），題幹在右側另一行。
        let m = t.match(/^(\d{1,3})\s*[.．、]/)
        if (!m && l.bbox.x < 68) m = t.match(/^(\d{1,3})$/)
        if (m) { const n = parseInt(m[1]); if (n >= 1 && n <= 200) qlines.push({ n, y: y0, y1 }) }
      }
    }
    qlines.sort((a, b) => a.y - b.y)
    textIv.sort((a, b) => a[0] - b[0])

    const rasters = mergeImageBlocks(blocks)
    const needRender = rasters.length > 0 || qlines.length > 0
    let png = null, pngW = 0, pngH = 0
    if (needRender) {
      const pix = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false)
      png = Buffer.from(pix.asPNG())
      const m = await sharp(png).metadata()
      pngW = m.width; pngH = m.height
    }
    // 夾限裁切框到實際 png 範圍 — 圖塊 bbox 可能溢出頁緣，未夾限會讓
    // sharp 拋 "bad extract area" 而整份 PDF 解析失敗。
    const clampCrop = (c) => {
      const left = Math.max(0, Math.min(c.left, pngW - 2))
      const top = Math.max(0, Math.min(c.top, pngH - 2))
      return { left, top,
        width: Math.max(1, Math.min(c.width, pngW - left)),
        height: Math.max(1, Math.min(c.height, pngH - top)) }
    }

    // A. 點陣圖 → 歸題
    for (const g of rasters) {
      let owner = null
      for (const q of qlines) { if (q.y < g.y0 + 6) owner = q.n; else break }
      if (owner == null) owner = lastQ
      if (owner == null) continue
      const M = 4
      const crop = clampCrop({
        left: Math.round((g.x0 - M) * SCALE),
        top: Math.round((g.y0 - M) * SCALE),
        width: Math.round((g.x1 - g.x0 + 2 * M) * SCALE),
        height: Math.round((g.y1 - g.y0 + 2 * M) * SCALE),
      })
      try {
        const buf = await sharp(png).extract(crop).webp({ quality: 88 }).toBuffer()
        ensure(owner).raster.push(buf)
      } catch (e) { /* 單張裁切失敗 → 略過，不影響整份 PDF */ }
    }

    // B. 向量圖 → 每題找題內最大文字空隙
    for (let i = 0; i < qlines.length; i++) {
      const q = qlines[i]
      const spanBottom = (i + 1 < qlines.length) ? qlines[i + 1].y : pageBottom
      let prevBottom = q.y1, bestGap = null
      for (const [y0, y1] of textIv) {
        if (y0 < q.y1 - 2 || y0 >= spanBottom) continue
        if (y0 - prevBottom > GAP_MIN &&
            (!bestGap || (y0 - prevBottom) > (bestGap.y1 - bestGap.y0))) {
          bestGap = { y0: prevBottom, y1: y0 }
        }
        prevBottom = Math.max(prevBottom, y1)
      }
      if (spanBottom - prevBottom > GAP_MIN &&
          (!bestGap || (spanBottom - prevBottom) > (bestGap.y1 - bestGap.y0))) {
        bestGap = { y0: prevBottom, y1: spanBottom }
      }
      if (!bestGap || !png) continue
      const crop = clampCrop({
        left: Math.round(28 * SCALE),
        top: Math.round((bestGap.y0 - 2) * SCALE),
        width: Math.round((pageW - 56) * SCALE),
        height: Math.round((bestGap.y1 - bestGap.y0 + 4) * SCALE),
      })
      try {
        let img = sharp(png).extract(crop)
        img = img.trim({ threshold: 18 })   // 去白邊收緊到實際圖形
        const buf = await img.webp({ quality: 88 }).toBuffer()
        const meta = await sharp(buf).metadata()
        if (meta.width >= MIN_OUT_PX && meta.height >= MIN_OUT_PX) {
          ensure(q.n).vector = buf
        }
      } catch { /* 全白 band → trim 失敗，略過 */ }
    }

    if (qlines.length) lastQ = qlines[qlines.length - 1].n
  }
  return byQ
}

function buildPdfMatcher(index) {
  return (examCode, subject) => {
    const want = subjKey(subject)
    const cands = index.filter(r => {
      const m = r.file.match(/medlab_(\d+)_/)
      return m && m[1] === String(examCode)
    })
    const hit = cands.find(r => subjKey(r.subject) === want)
    return hit ? hit.file : null
  }
}

async function main() {
  const cmd = process.argv[2] || 'dry'
  const filterCode = process.argv[3] || null

  if (cmd === 'index') {
    require('child_process').execSync('node ' + path.join(__dirname, '_index-medlab-pdfs.js'),
      { stdio: 'inherit' })
    return
  }

  const mupdf = await import('mupdf')
  const index = JSON.parse(fs.readFileSync(PDF_INDEX, 'utf8'))
  const match = buildPdfMatcher(index)
  const questions = JSON.parse(fs.readFileSync(QJSON, 'utf8'))

  const groups = {}
  for (const q of questions) {
    if (!q.images || !q.images.length) continue
    if (filterCode && String(q.exam_code) !== String(filterCode)) continue
    const key = q.exam_code + '|' + q.subject
    ;(groups[key] = groups[key] || []).push(q)
  }

  const dry = cmd === 'dry'
  let totalQ = 0, matchedQ = 0, gotRaster = 0, gotVector = 0, gotCarry = 0, noPdf = 0, noImg = 0
  const pdfCache = {}
  const updates = []

  for (const key of Object.keys(groups).sort()) {
    const [examCode, subject] = key.split('|')
    const qs = groups[key]
    totalQ += qs.length
    const pdfFile = match(examCode, subject)
    if (!pdfFile) {
      noPdf += qs.length
      console.log(`✗ 無 PDF: ${key}  (${qs.length} 題)`)
      continue
    }
    matchedQ += qs.length
    if (!pdfCache[pdfFile]) {
      try {
        pdfCache[pdfFile] = await extractPdfImages(path.join(PDF_DIR, pdfFile), mupdf)
      } catch (e) {
        console.log(`✗ 解析失敗 ${pdfFile}: ${e.message}`)
        pdfCache[pdfFile] = {}
      }
    }
    const byQ = pdfCache[pdfFile]
    const sc = SUBJ_CODE[subjKey(subject)] || 'x'
    const numsWithImg = Object.keys(byQ).map(Number)
      .filter(k => byQ[k].raster.length || byQ[k].vector).sort((a, b) => a - b)
    let okHere = 0
    for (const q of qs) {
      const hit = byQ[q.number]
      let bufs = null, kind = null
      if (hit && hit.raster.length) { bufs = hit.raster; kind = 'raster' }
      else if (hit && hit.vector)   { bufs = [hit.vector]; kind = 'vector' }
      // 承上題：本題無圖、題幹為「承上題/上圖」→ 沿用題組首題（前一個有圖的題）
      if (!bufs && /承上題|上圖|如上|前(一)?題/.test(q.question || '')) {
        let lead = null
        for (const k of numsWithImg) { if (k < q.number) lead = k; else break }
        if (lead != null) {
          const lh = byQ[lead]
          bufs = lh.raster.length ? lh.raster : [lh.vector]
          kind = 'carry'
        }
      }
      if (!bufs) {
        noImg++
        console.log(`  ⚠ ${key} 第${q.number}題(id ${q.id}) 找不到圖`)
        continue
      }
      if (kind === 'raster') gotRaster++; else if (kind === 'vector') gotVector++; else gotCarry++
      okHere++
      const names = bufs.map((_, i) => `medlab_${examCode}_${sc}_q${q.number}_${i}.webp`)
      updates.push({ id: q.id, names, bufs })
    }
    console.log(`✓ ${key}  PDF=${pdfFile}  ${qs.length}題 → 抓到 ${okHere}`)
  }

  console.log(`\n─── 覆蓋率 ───`)
  console.log(`含圖題總數: ${totalQ}`)
  console.log(`配到 PDF:   ${matchedQ}   無 PDF: ${noPdf}`)
  console.log(`抓到圖:     ${gotRaster + gotVector + gotCarry}（點陣 ${gotRaster} / 向量 ${gotVector} / 承上題沿用 ${gotCarry}）   找不到: ${noImg}`)

  if (dry) { console.log('\n[dry-run] 未寫檔。'); return }

  console.log(`\n寫入 ${updates.length} 題的圖檔…`)
  const idMap = {}
  for (const u of updates) {
    for (let i = 0; i < u.bufs.length; i++) {
      fs.writeFileSync(path.join(IMG_OUT, u.names[i]), u.bufs[i])
    }
    idMap[u.id] = u.names.map(n => '/question-images/' + n)
  }
  let rewritten = 0
  for (const q of questions) {
    if (idMap[q.id]) { q.images = idMap[q.id]; rewritten++ }
  }
  fs.writeFileSync(QJSON, JSON.stringify(questions, null, 1))
  console.log(`✓ 完成：寫出圖檔、回寫 ${rewritten} 題 images 欄位`)
}
main().catch(e => { console.error(e); process.exit(1) })
