#!/usr/bin/env node
/**
 * Add-missing-images sweep.
 *
 * Counterpart to fix-images.js. Where that script *re-routes* existing image
 * associations, this one *adds* image entries for questions that strictly
 * reference a figure ("附圖/如圖/下圖/上圖/圖中/圖示") but have no `images`
 * field. Reuses fix-images.js helpers so behavior matches the existing
 * extraction pipeline 1:1.
 *
 * Flow per (exam, exam_code):
 *   1. Probe candidate subject codes for valid PDFs (cached).
 *   2. Parse each PDF to extract per-question text + image bboxes.
 *   3. For each JSON question with strict image refs but empty `images`:
 *        - Text-match against the PDF question index (any paper)
 *        - Look up the matched PDF question's images
 *        - Crop each image and save as `${exam}_{q.id}_{i}.webp`
 *        - Set q.images = [paths]
 *
 * Idempotent: skips questions that already have images.
 */

const fs = require('fs')
const path = require('path')

const { IMAGE_REF: STRICT } = require('./lib/image-ref')

// We reach into fix-images.js by re-requiring its module after monkey-patching.
// Easiest: copy the helpers we need here. Avoid duplicating code by exporting
// them from fix-images.js… but fix-images.js currently has no exports. To keep
// this self-contained, this script duplicates the small parsing helpers and
// then re-uses the WebP cropper logic.

const { warnZero, checkRegistryCoverage, summary } = require('./lib/coverage-guard')
const https = require('https')
const sharp = require('sharp')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const IMG_OUT = path.join(__dirname, '..', '..', 'frontend', 'public', 'question-images')
const PROBE_CACHE_FILE = path.join(__dirname, '..', '_tmp', 'probe-results.json')
const RENDER_SCALE = 2
const MIN_IMG_DIM = 30
// 向量圖偵測門檻（pt）。正常行距 3~5pt，圖區空白實測 90~280pt，60 很安全。
const VECTOR_GAP_MIN = 60
const MARGIN = 2

fs.mkdirSync(PDF_CACHE, { recursive: true })
fs.mkdirSync(IMG_OUT, { recursive: true })

// ─── HTTP ───
function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*', 'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('bad redirect')) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000) : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}
async function cachedPdf(exam, code, c, s) {
  const key = `${exam}_${code}_c${c}_s${s}.pdf`
  const p = path.join(PDF_CACHE, key)
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p)
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  const buf = await fetchPdf(url)
  fs.writeFileSync(p, buf)
  return buf
}

// ─── Probe ───
let probeCache = {}
try { probeCache = JSON.parse(fs.readFileSync(PROBE_CACHE_FILE, 'utf8')) } catch {}
function saveProbeCache() {
  try { fs.writeFileSync(PROBE_CACHE_FILE, JSON.stringify(probeCache, null, 2)) } catch {}
}
const CANDIDATE_SUBJECT_CODES = [
  '11', '22', '33', '44', '55', '66', '77', '88',
  '0101', '0102', '0103', '0104', '0105', '0106', '0107', '0108',
  '0201', '0202', '0203', '0204', '0205', '0206',
  '0301', '0302', '0303', '0304', '0305', '0306',
  '0401', '0402', '0403', '0404', '0405', '0406',
  '0501', '0502', '0503', '0504', '0505', '0506',
  '0601', '0602', '0603', '0604', '0605', '0606',
  '0701', '0702', '0703', '0704', '0705', '0706',
  '0801', '0802', '0803', '0804', '0805', '0806',
  // 聽力師/語言治療師用 09xx，原本漏列導致這兩個考試永遠 probe 不到卷（2026-09-15）
  '0901', '0902', '0903', '0904', '0905', '0906',
  '1001', '1002', '1003', '1004', '1005', '1006',
]
async function probeSubjectCodes(exam, code, classCode) {
  const k = `${exam}_${code}`
  if (probeCache[k]) return probeCache[k]
  const found = []
  for (const s of CANDIDATE_SUBJECT_CODES) {
    try {
      const buf = await cachedPdf(exam, code, classCode, s)
      if (buf && buf.length > 100000) found.push(s)
    } catch {}
  }
  // 探測不到就不要寫進快取。先前把空陣列快取起來，導致後來補了類科碼/subject code
  // 也完全沒效果（2026-09-15 語言治療師、聽力師都踩到）。
  if (found.length) { probeCache[k] = found; saveProbeCache() }
  else console.warn(`   ⚠️ ${k}: 探測不到任何科目卷（不寫入快取，下次會重試）`)
  return found
}

// ─── Text + image parsing (mirrors fix-images.js) ───
function pageTextColumnAware(pg) {
  const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
  const lines = []
  for (const b of parsed.blocks) {
    if (b.type !== 'text') continue
    for (const ln of (b.lines || [])) {
      const t = ln.text || ''
      if (!t.trim()) continue
      lines.push({ y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), text: t })
    }
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x)
  const groups = []
  for (const ln of lines) {
    const last = groups[groups.length - 1]
    if (last && Math.abs(last.y - ln.y) <= 3) last.parts.push(ln)
    else groups.push({ y: ln.y, parts: [ln] })
  }
  return groups.map(g => {
    g.parts.sort((a, b) => a.x - b.x)
    let merged = ''
    for (const p of g.parts) {
      const t = p.text
      if (merged && t) {
        const mTrim = merged.replace(/\s+$/, '')
        const tTrim = t.replace(/^\s+/, '')
        const lastCh = mTrim[mTrim.length - 1]
        const firstCh = tTrim[0]
        if (lastCh && lastCh === firstCh && !/\s/.test(lastCh)) merged = mTrim + tTrim.slice(1)
        else merged += t
      } else merged += t
    }
    return merged.trim()
  }).join('\n')
}

function parseQuestions(fullText) {
  const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean)
  const out = {}
  let cur = null, curOpt = null, qBuf = [], optBuf = ''
  let pendingNum = null
  function flushOpt() {
    if (cur && curOpt) cur.options[curOpt] = optBuf.trim()
    optBuf = ''; curOpt = null
  }
  function flushQ() {
    flushOpt()
    if (cur) {
      cur.question = qBuf.join('').trim()
      if (cur.question && cur.question.length >= 4) out[cur.num] = { question: cur.question, options: cur.options }
    }
    cur = null; qBuf = []
  }
  function tryStartQuestion(n, after) {
    const isSeq = !cur ? (n === 1) : n === cur.num + 1
    if (n >= 1 && n <= 120 && after && after.length >= 2 && isSeq) {
      flushQ()
      cur = { num: n, question: '', options: {} }
      qBuf = [after]
      return true
    }
    return false
  }
  for (const ln of lines) {
    const mBare = ln.match(/^(\d{1,3})(?:[.．、]|)\s*$/)
    if (mBare) {
      const n = +mBare[1]
      if (n >= 1 && n <= 120) { pendingNum = n; continue }
    }
    if (pendingNum != null) {
      const n = pendingNum
      pendingNum = null
      if (!/^[A-D][.．]/.test(ln)) {
        if (tryStartQuestion(n, ln)) continue
      }
    }
    const mQ = ln.match(/^(\d{1,3})[.．、]\s*(.*)/)
    if (mQ) {
      const n = +mQ[1]
      const after = mQ[2]
      if (tryStartQuestion(n, after)) continue
    }
    const mOpt = ln.match(/^([A-D])[.．]\s*(.*)/)
    if (mOpt && cur) {
      flushOpt()
      curOpt = mOpt[1]
      optBuf = mOpt[2]
      continue
    }
    if (curOpt) optBuf += ln
    else if (cur) qBuf.push(ln)
  }
  flushQ()
  return out
}

function normText(t) {
  return (t || '').normalize('NFKC')
    .replace(/[\s,，、.。;；:：!！?？（）()\[\]【】{}「」『』"'"'"""''\-_—–~`]/g, '')
    .toLowerCase()
}

function findMatch(jsonQ, pdfIndex) {
  const qn = normText(jsonQ.question)
  // Strip the carry-over context block we added in bind-carryover-questions.js
  // so the prefix actually matches the PDF text.
  const stripped = qn.replace(/^.*──────────/s, '')
  const candidate = stripped || qn
  const prefix = candidate.slice(0, Math.min(15, candidate.length))
  if (!prefix) return null
  for (const [num, pdfQ] of Object.entries(pdfIndex)) {
    const pn = normText(pdfQ.question)
    if (pn.startsWith(prefix) || pn.includes(prefix)) return { num: +num, pdfQ }
  }
  const optA = normText(jsonQ.options?.A || '').slice(0, 10)
  if (optA.length >= 6) {
    for (const [num, pdfQ] of Object.entries(pdfIndex)) {
      const pA = normText(pdfQ.options?.A || '')
      const pn = normText(pdfQ.question)
      if (pA.startsWith(optA) && pn.includes(candidate.slice(0, 5))) return { num: +num, pdfQ }
    }
  }
  return null
}

async function parsePdfFull(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  let fullText = ''
  const pages = []
  for (let i = 0; i < n; i++) {
    const pg = doc.loadPage(i)
    fullText += pageTextColumnAware(pg) + '\n'
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    const anchors = []
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const txt = (ln.text || '').trim()
        // Accept "5." "5．" "5、" (modern) and bare "5" (100-105 format).
        const m = txt.match(/^(\d{1,3})(?:[.．、]|\s*$)\s*(.*)/)
        if (!m) continue
        const num = parseInt(m[1], 10)
        if (num < 1 || num > 120) continue
        const after = (m[2] || '').trim()
        // Accept bare-number line (no content after); body will be on next
        // lines below the anchor y-coordinate.
        if (after && after.length < 2 && !/^\s*$/.test(after)) continue
        anchors.push({ num, y: ln.bbox.y, x: ln.bbox.x })
      }
    }
    const dedup = new Map()
    for (const a of anchors.sort((a, b) => a.y - b.y || a.x - b.x)) {
      if (!dedup.has(a.num)) dedup.set(a.num, a)
    }
    const uniqAnchors = [...dedup.values()].sort((a, b) => a.y - b.y)
    const images = []
    for (const b of parsed.blocks) {
      if (b.type !== 'image') continue
      const bb = b.bbox
      if (bb.w < MIN_IMG_DIM || bb.h < MIN_IMG_DIM) continue
      images.push({ bbox: bb })
    }
    const textLines = []
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        if (!(ln.text || '').trim()) continue
        textLines.push({ y: ln.bbox.y, h: ln.bbox.h, x: ln.bbox.x, w: ln.bbox.w })
      }
    }
    const bounds = pg.getBounds()
    pages.push({ pageNum: i + 1, anchors: uniqAnchors, images, textLines, mupdfPage: pg,
      pageW: bounds[2] - bounds[0], pageH: bounds[3] - bounds[1] })
  }
  const textIndex = parseQuestions(fullText)
  return { textIndex, pages, doc, mupdf }
}

/**
 * 向量圖區塊：兩行文字之間異常大的空白 = 圖。
 *
 * 為什麼需要：呼吸治療、物理治療這類考科的波形圖／曲線圖在 PDF 裡是**向量繪圖**，
 * 不是內嵌點陣圖，所以 toStructuredText 的 image block 一個都抓不到
 * （rt 102020 呼吸器原理及應用整卷 imageBlocks=2，圖卻有十幾張）。
 * 既有流程只認 image block，於是這些卷「題幹對得到、圖永遠補不到」。
 *
 * 判法：同一頁內相鄰兩行文字的垂直間距 ≥ VECTOR_GAP_MIN，中間那塊就是圖。
 * 實測 rt 的圖區間距是 143~280pt，正常行距 3~5pt，分得很開。
 * 誤判防線：裁切後會再用像素統計擋掉整片空白的區塊（見 cropImage）。
 */
function vectorRegions(page) {
  const lines = [...(page.textLines || [])].sort((a, b) => a.y - b.y)
  if (lines.length < 2) return []
  const left = Math.min(...lines.map(l => l.x))
  const right = Math.max(...lines.map(l => l.x + l.w))
  const out = []
  for (let i = 1; i < lines.length; i++) {
    const prevBottom = lines[i - 1].y + lines[i - 1].h
    const gap = lines[i].y - prevBottom
    if (gap < VECTOR_GAP_MIN) continue
    out.push({ bbox: { x: left, y: prevBottom + 2, w: Math.max(right - left, 100), h: gap - 4 }, vector: true })
  }
  return out
}

function matchImageToPdfNum(img, page, prevPages) {
  const imgTop = img.bbox.y
  const above = page.anchors.filter(a => a.y <= imgTop + 5).sort((a, b) => b.y - a.y)
  if (above.length) return above[0].num
  for (let i = prevPages.length - 1; i >= 0; i--) {
    const p = prevPages[i]
    if (p.anchors.length) return Math.max(...p.anchors.map(a => a.num))
  }
  return null
}

async function cropImage(mupdf, page, bbox, outPath, opts = {}) {
  const m = mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE)
  const pixmap = page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false)
  const png = Buffer.from(pixmap.asPNG())
  const pw = pixmap.getWidth()
  const ph = pixmap.getHeight()
  const left = Math.max(0, Math.floor((bbox.x - MARGIN) * RENDER_SCALE))
  const top = Math.max(0, Math.floor((bbox.y - MARGIN) * RENDER_SCALE))
  const right = Math.min(pw, Math.ceil((bbox.x + bbox.w + MARGIN) * RENDER_SCALE))
  const bottom = Math.min(ph, Math.ceil((bbox.y + bbox.h + MARGIN) * RENDER_SCALE))
  const width = right - left
  const height = bottom - top
  if (width < 10 || height < 10) return false
  const region = sharp(png).extract({ left, top, width, height })
  // 向量圖是靠「空白間距」推出來的，必須驗證裁出來真的有東西：
  // 整塊接近純白（各通道標準差都極小）就丟掉，否則會塞一堆空白圖給使用者。
  if (opts.requireContent) {
    try {
      const st = await region.clone().stats()
      if (st.channels.every(c => c.stdev < 3)) return false
    } catch { return false }
  }
  await region.webp({ quality: 82 }).toFile(outPath)
  return true
}

// ─── Exam registry ───
// Static class codes (no per-year variance): use as primary; fall back to
// probing alternates only if the static one yields no PDFs.
//
// `examName` is the exact 類科 string printed on the official PDF — used to
// validate that a cached/downloaded PDF actually belongs to this exam. Without
// this check, scripts blindly trusted the cached `c{NN}` filename and picked
// up the wrong-exam PDFs from earlier years where the same class code was
// reused for a different 類科 (e.g. nursing 030-c=101 in 110/111 is actually
// 中醫師, not 護理師).
const EXAM_REGISTRY = {
  doctor1:   { file: 'questions.json',           classCodes: ['301','101'], examName: '醫師' },
  doctor2:   { file: 'questions-doctor2.json',   classCodes: ['302','102'], examName: '醫師' },
  dental1:   { file: 'questions-dental1.json',   classCodes: ['303','301'], examName: '牙醫師' },
  dental2:   { file: 'questions-dental2.json',   classCodes: ['304','302'], examName: '牙醫師' },
  pharma1:   { file: 'questions-pharma1.json',   classCodes: ['305','312','306','310'], examName: '藥師' },
  pharma2:   { file: 'questions-pharma2.json',   classCodes: ['306','307','310'],       examName: '藥師' },
  nursing:   { file: 'questions-nursing.json',   classCodes: ['101','102','104','105','106','107','109'], examName: '護理師' },
  nutrition: { file: 'questions-nutrition.json', classCodes: ['101','102','103','106','107'],              examName: '營養師' },
  medlab:    { file: 'questions-medlab.json',    classCodes: ['308','311','104','108','109'], examName: '醫事檢驗師' },
  pt:        { file: 'questions-pt.json',        classCodes: ['311','309'], examName: '物理治療師' },
  ot:        { file: 'questions-ot.json',        classCodes: ['312','305'], examName: '職能治療師' },
  vet:       { file: 'questions-vet.json',       classCodes: ['314','307'], examName: '獸醫師' },
  tcm1:      { file: 'questions-tcm1.json',      classCodes: ['317','101','103','106','107'], examName: '中醫師(一)' },
  tcm2:      { file: 'questions-tcm2.json',      classCodes: ['318','102','103','104','105','106','107'], examName: '中醫師(二)' },
  radiology: { file: 'questions-radiology.json', classCodes: ['309','308'], examName: '醫事放射師' },
  // 牙體技術師原本不在 registry 裡，所以從來沒被補過圖（2026-09-13 盤點：41 題
  // 提到圖卻沒圖，使用者回報 17 筆）。類科碼逐年不同：107-109 年 c=111、
  // 111 年 c=109、112-113 年 c=107，全列進來讓 probe 自己試，
  // pdfExamName() 會擋掉抓錯卷的情況。
  'dental-tech': { file: 'questions-dental-tech.json', classCodes: ['107','109','111','108','110'], examName: '牙體技術師' },
  // 以下三個考試缺圖最多（呼吸治療 254、語言治療 188、聽力師 149），原本都不在
  // registry 裡所以從沒被補過圖。類科碼逐年變動很大，這裡是從 _tmp/moex-codes.json
  // 探碼快取推導出來的實際值；pdfExamName() 會擋掉抓錯卷的情況。
  rt:        { file: 'questions-rt.json',        classCodes: ['313','306','315','310'], examName: '呼吸治療師' },
  'speech-therapist': { file: 'questions-speech-therapist.json', classCodes: ['109','110','111','112','114','113','108','107','106','105','301'], examName: '語言治療師' },
  audiologist: { file: 'questions-audiologist.json', classCodes: ['110','112','113','111','109','114','108','106','301'], examName: '聽力師' },
  // 以下 11 個考試原本不在 registry，補圖工具從沒跑過它們（2026-09-15 由
  // coverage-guard 的 registry 涵蓋檢查一次列出）。類科碼從 _tmp/moex-codes.json
  // 探碼快取推導，括號內是「卷別對到率」。
  // 不加的：post-*（金研院題源）、teacher-*（tqa）、state-*（台電聯招）、
  // lawyer1（快取無對應待查）、gsat/ast（大考中心）、driver-*（公路局）——題源都不是考選部。
  police:       { file: 'questions-police.json',       classCodes: ['131','201','301'], examName: '警察' },              // 40/40
  police4:      { file: 'questions-police4.json',      classCodes: ['131','137','201','301','401'], examName: '警察' },  // 43/43
  customs:      { file: 'questions-customs.json',      classCodes: ['101','151'], examName: '關務' },                    // 23/35
  'railway-admin':     { file: 'questions-railway-admin.json',     classCodes: ['131','201','301','702','703','705','901'], examName: '鐵路' }, // 52/52
  'railway-transport': { file: 'questions-railway-transport.json', classCodes: ['131','201','301','701','702','901','903'], examName: '鐵路' }, // 46/52
  'public-health':     { file: 'questions-public-health.json',     classCodes: ['108','110','401'], examName: '公共衛生師' },  // 36/36
  'clinical-psychology':   { file: 'questions-clinical-psychology.json',   classCodes: ['104','106','107','108','109','111','315'], examName: '臨床心理師' }, // 146/146
  'counseling-psychology': { file: 'questions-counseling-psychology.json', classCodes: ['105','107','108','109','110','112','316'], examName: '諮商心理師' }, // 126/130
  optometrist:         { file: 'questions-optometrist.json',        classCodes: ['109','111','112'], examName: '驗光師' },     // 50/50
  'optometrist-junior':{ file: 'questions-optometrist-junior.json', classCodes: ['110','112','113'], examName: '驗光生' },     // 30/30
  'social-worker':     { file: 'questions-social-worker.json',      classCodes: ['103','105','107','110'], examName: '社會工作師' }, // 74/74
}

// Read the 類科 line from the first page of a PDF buffer. Returns null on
// failure. The official 考選部 試題 PDF always prints
// 「類科：護理師」 (or similar) near the top of page 1, so checking against
// EXAM_REGISTRY[exam].examName proves the file actually belongs to that exam
// and not a same-class-code from a different year.
async function pdfExamName(buf) {
  try {
    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const parsed = JSON.parse(doc.loadPage(0).toStructuredText('preserve-images').asJSON())
    let txt = ''
    // ⚠️ 不能照 PDF 區塊順序直接串接。考選部把「類科」兩個字拆成兩個 text run，
    // 且 baseline 差 1px（類 y=142 x=46、科 y=141 x=90），照原順序串會變成
    // 「科：語言治療師類」，regex 永遠比對不到 → 那個考試整個 probe 不到卷。
    // 必須先按 y 分列（容差 4）、列內按 x 排序再串。
    // （2026-09-15 語言治療師補圖恆為 0 的真因）
    const __items = []
    for (const b of parsed.blocks || []) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = ln.text || ''
        if (!t.trim()) continue
        __items.push({ y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), t })
      }
    }
    const __rows = []
    for (const it of __items.sort((a, b) => a.y - b.y || a.x - b.x)) {
      const r = __rows.find(r => Math.abs(r.y - it.y) <= 4)
      if (r) r.items.push(it)
      else __rows.push({ y: it.y, items: [it] })
    }
    for (const r of __rows) {
      r.items.sort((a, b) => a.x - b.x)
      txt += r.items.map(i => i.t).join('') + '\n'
    }
    // Match across line breaks. Two layouts exist on moex:
    //   old: "類　科：護理師"        → strips to 類科：護理師
    //   new: "類科名稱：中醫師(一)"   → strips to 類科名稱：中醫師(一)
    // Accept an optional 名稱 between 類科 and the colon, and allow CJK
    // brackets / arabic digits in the captured name (covers 中醫師(一) etc).
    const compact = txt.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, '').normalize('NFKC')
    // Exclude 科 from the char class so we don't greedily eat the next field
    // "類科：中醫師 科目：..." — previously captured "中醫師科目".
    const m = compact.match(/類科(?:名稱)?[：:]([\u4e00-\u9fff()（）]{2,12}?)(?=科目|等別|考試|$)/)
    return m ? m[1] : null
  } catch { return null }
}

async function pdfSubjectName(buf) {
  try {
    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const parsed = JSON.parse(doc.loadPage(0).toStructuredText('preserve-images').asJSON())
    let txt = ''
    // ⚠️ 不能照 PDF 區塊順序直接串接。考選部把「類科」兩個字拆成兩個 text run，
    // 且 baseline 差 1px（類 y=142 x=46、科 y=141 x=90），照原順序串會變成
    // 「科：語言治療師類」，regex 永遠比對不到 → 那個考試整個 probe 不到卷。
    // 必須先按 y 分列（容差 4）、列內按 x 排序再串。
    // （2026-09-15 語言治療師補圖恆為 0 的真因）
    const __items = []
    for (const b of parsed.blocks || []) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = ln.text || ''
        if (!t.trim()) continue
        __items.push({ y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), t })
      }
    }
    const __rows = []
    for (const it of __items.sort((a, b) => a.y - b.y || a.x - b.x)) {
      const r = __rows.find(r => Math.abs(r.y - it.y) <= 4)
      if (r) r.items.push(it)
      else __rows.push({ y: it.y, items: [it] })
    }
    for (const r of __rows) {
      r.items.sort((a, b) => a.x - b.x)
      txt += r.items.map(i => i.t).join('') + '\n'
    }
    const compact = txt.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, '').normalize('NFKC')
    const m = compact.match(/科目[：:]([\u4e00-\u9fff()（）一二三四五六七八九十]{2,30})/)
    return m ? m[1] : null
  } catch { return null }
}

async function pdfMatchesExam(buf, examName) {
  if (!buf || !examName) return false
  const found = await pdfExamName(buf)
  if (!found) return false
  // Prefix match: either name must start with the other. Prevents "醫師"
  // falsely matching "中醫師(二)" (where 醫師 is just a substring) while
  // still allowing "醫師" to match PDF-rendered "醫師(一)" etc.
  return found === examName || found.startsWith(examName) || examName.startsWith(found)
}

// Pick the working classCode for (exam, exam_code). For each candidate we:
//   1. Look at any cached PDF with that c-code
//   2. Verify its 類科 line actually matches this exam (otherwise the cache
//      is stale data from another exam that reused the code)
//   3. If no cached file passes, probe-download one subject code and verify
async function pickClassCode(examTag, code, candidates, jsonSubjects) {
  const expectedName = EXAM_REGISTRY[examTag]?.examName
  // Build a normalized JSON-subject set for extra validation. When multiple
  // exams share an ambiguous 類科 (tcm1 vs tcm2, both print 中醫師), the PDF
  // 科目 line carries the disambiguator (基礎醫學 vs 臨床醫學).
  const normJsonSubs = new Set((jsonSubjects || []).map(s => normText(s)))
  // Only disambiguate via 科目 when the registry name has a 一/二 suffix
  // (tcm1 vs tcm2 both print 中醫師 on PDFs). For unambiguous exams the
  // 類科 check alone is enough and adding a stricter 科目 check drops valid
  // matches (pdfSubjectName over-captures noise, e.g. "醫師科目內外科...").
  const needsSubjectCheck = /\([一二]\)$|（[一二]）$/.test(expectedName || '')
  async function pdfPassesSubject(buf) {
    if (!needsSubjectCheck) return true
    if (!normJsonSubs.size) return true
    const sn = await pdfSubjectName(buf)
    if (!sn) return true
    const ns = normText(sn)
    // Exact / substring match first
    for (const js of normJsonSubs) if (ns.includes(js) || js.includes(ns)) return true
    // Fallback: share ≥4 CJK-char common prefix. PDF 科目 often reads
    // "中醫臨床醫學(包括傷寒論...)" while JSON has "中醫臨床醫學(一)"; neither
    // is a substring of the other but they share a 6-char prefix.
    for (const js of normJsonSubs) {
      let common = 0
      const len = Math.min(ns.length, js.length)
      for (let i = 0; i < len; i++) {
        if (ns[i] !== js[i]) break
        if (/[\u4e00-\u9fff]/.test(ns[i])) common++
        else break
      }
      if (common >= 4) return true
    }
    return false
  }
  for (const c of candidates) {
    const cachedFiles = fs.readdirSync(PDF_CACHE).filter(f =>
      (f.startsWith(`${examTag}_${code}_c${c}_`) || f.startsWith(`${examTag}_Q_${code}_c${c}_`))
      && f.endsWith('.pdf')
      && fs.statSync(path.join(PDF_CACHE, f)).size > 100000
    )
    let validatedFromCache = false
    for (const f of cachedFiles) {
      const buf = fs.readFileSync(path.join(PDF_CACHE, f))
      if (await pdfMatchesExam(buf, expectedName) && await pdfPassesSubject(buf)) { validatedFromCache = true; break }
    }
    if (validatedFromCache) return c
    for (const probeS of ['0101','0102','0103','0104','0108','0201','0203','0301','0303','0304','0401','0501','0503','0601','0603','0701','1001','11','22','33','44','55','66']) {
      try {
        const buf = await cachedPdf(examTag, code, c, probeS)
        if (buf && buf.length > 100000 && await pdfMatchesExam(buf, expectedName) && await pdfPassesSubject(buf)) return c
      } catch {}
    }
  }
  return null
}

async function processExamCode(examTag, code, opts) {
  const def = EXAM_REGISTRY[examTag]
  const file = path.join(__dirname, '..', def.file)
  if (!fs.existsSync(file)) return { added: 0, skipped: 0 }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const qs = Array.isArray(raw) ? raw : raw.questions

  // Candidate questions: same exam_code, no images, and either:
  //   (default)        strict 圖 reference in stem/options, OR
  //   (blank-options)  any option is empty (likely image-based answer choices), OR
  //   (auto)           any question without images — relies on text-match + actual
  //                    PDF image presence to gate attachment (no false positives
  //                    because pdfImgs.length must be ≥ 1)
  const isBlank = q => ['A','B','C','D'].some(k => !q.options?.[k] || !q.options[k].trim())
  let filter
  if (opts.mode === 'blank-options') {
    filter = q => q.exam_code === code && (!q.images || !q.images.length) && isBlank(q)
  } else if (opts.mode === 'auto') {
    filter = q => q.exam_code === code && (!q.images || !q.images.length)
  } else {
    filter = q => q.exam_code === code && (!q.images || !q.images.length) &&
            STRICT.test((q.question || '') + ' ' + Object.values(q.options || {}).join(' '))
  }
  const candidates = qs.filter(filter)
  if (!candidates.length) return { added: 0, skipped: 0 }

  // Find working classCode. Pass JSON subjects for this exam_code so that
  // ambiguous 類科 names (e.g. tcm1/tcm2 both show "中醫師") are resolved by
  // matching the PDF 科目 against actual JSON subjects.
  const jsonSubjects = [...new Set(qs.filter(q => q.exam_code === code).map(q => q.subject).filter(Boolean))]
  const classCode = await pickClassCode(examTag, code, def.classCodes, jsonSubjects)
  if (!classCode) {
    console.log(`  ${examTag} ${code}: no working class code from ${def.classCodes.join('/')}`)
    return { added: 0, skipped: 0 }
  }

  // Probe subject codes
  const subjectCodes = await probeSubjectCodes(examTag, code, classCode)
  if (!subjectCodes.length) {
    console.log(`  ${examTag} ${code} c${classCode}: no PDFs found`)
    return { added: 0, skipped: 0 }
  }

  // Build subject ordering from JSON (first-appearance order) for fallback
  // number-based image matching on old-format PDFs.
  const subjectOrder = []
  const seenSubj = new Set()
  for (const q of qs) {
    if (q.exam_code !== code || !q.subject) continue
    if (seenSubj.has(q.subject)) continue
    seenSubj.add(q.subject)
    subjectOrder.push(q.subject)
  }

  // Parse each PDF
  const pdfs = []
  for (let si = 0; si < subjectCodes.length; si++) {
    const s = subjectCodes[si]
    try {
      const buf = await cachedPdf(examTag, code, classCode, s)
      if (buf.length < 2000) continue
      const parsed = await parsePdfFull(buf)
      const subjName = await pdfSubjectName(buf)
      // Match PDF 科目 to JSON subject by ≥4-char CJK common prefix. Handles
      // cases like PDF "中醫臨床醫學(包括傷寒論...)" ⟷ JSON "中醫臨床醫學(一)".
      // Returns null when ambiguous; falls back to null-safe paperSubject use.
      let paperSubject = null
      if (subjName) {
        const ns = normText(subjName)
        let best = null, bestCommon = 0
        for (const js of subjectOrder) {
          const njs = normText(js)
          let common = 0
          const len = Math.min(ns.length, njs.length)
          for (let i = 0; i < len; i++) {
            if (ns[i] !== njs[i]) break
            if (/[\u4e00-\u9fff]/.test(ns[i])) common++
            else break
          }
          if (common > bestCommon) { bestCommon = common; best = js }
        }
        if (bestCommon >= 4) paperSubject = best
      }
      pdfs.push({ s, classCode, subjectName: subjName, paperSubject, ...parsed })
    } catch (e) { console.error(`    parse ${s} failed: ${e.message}`) }
  }
  if (!pdfs.length) return { added: 0, skipped: 0 }

  // Build {pdfNum: [imageBboxes]} for each PDF
  for (const pdf of pdfs) {
    pdf.imagesPerNum = {}
    pdf.vectorPerNum = {}
    for (let pi = 0; pi < pdf.pages.length; pi++) {
      const page = pdf.pages[pi]
      const prev = pdf.pages.slice(0, pi)
      for (const img of page.images) {
        const num = matchImageToPdfNum(img, page, prev)
        if (num == null) continue
        if (!pdf.imagesPerNum[num]) pdf.imagesPerNum[num] = []
        pdf.imagesPerNum[num].push({ page: page.mupdfPage, bbox: img.bbox })
      }
      // 向量圖另存一份：點陣圖優先，抓不到才退而用空白區塊
      for (const reg of vectorRegions(page)) {
        const num = matchImageToPdfNum(reg, page, prev)
        if (num == null) continue
        if (!pdf.vectorPerNum[num]) pdf.vectorPerNum[num] = []
        pdf.vectorPerNum[num].push({ page: page.mupdfPage, bbox: reg.bbox, vector: true })
      }
    }
  }

  let added = 0, skipped = 0
  try {
    for (const q of candidates) {
      let hit = null
      for (const pdf of pdfs) {
        const m = findMatch(q, pdf.textIndex)
        if (m) { hit = { pdf, num: m.num }; break }
      }
      // Fallback: old-format PDFs that textIndex can't parse. Match by
      // subject name (PDF 科目 ⟷ JSON subject_name/subject) and use q.number
      // directly. Only fires when the question actually has an image anchor.
      if (!hit && q.number && q.subject) {
        for (const pdf of pdfs) {
          // 不能用嚴格相等：我們存「中醫臨床醫學(四)」，PDF 寫
          // 「中醫臨床醫學（四）（包括針灸科學）」——全形括號與 (包括…) 後綴都會讓它不等。
          // 這是「名稱比對」家族的老問題，一律先正規化再做前綴比對。
          const nk = t => String(t || '').replace(/[（）()【】\[\]、，,。．.\s]/g, '')
          const a = nk(pdf.paperSubject), b = nk(q.subject)
          if (!(a === b || a.startsWith(b) || b.startsWith(a))) continue
          if (pdf.imagesPerNum[q.number]?.length) { hit = { pdf, num: q.number }; break }
        }
      }
      if (!hit) {
        skipped++
        if (opts.verbose) console.log(`  - ${q.id} #${q.number} ${q.subject}: 題幹對不到任何卷`)
        continue
      }
      let pdfImgs = hit.pdf.imagesPerNum[hit.num] || []
      if (!pdfImgs.length) pdfImgs = hit.pdf.vectorPerNum[hit.num] || []   // 向量圖 fallback
      if (!pdfImgs.length) {
        skipped++
        if (opts.verbose) console.log(`  - ${q.id} #${q.number}: 對到 s=${hit.pdf.s} #${hit.num}，但該題在 PDF 裡沒抓到圖`)
        continue
      }
      const newPaths = []
      for (let i = 0; i < pdfImgs.length; i++) {
        const fname = `${examTag}_${q.id}_${i}.webp`
        const outPath = path.join(IMG_OUT, fname)
        if (!opts.dryRun) {
          const ok = await cropImage(hit.pdf.mupdf, pdfImgs[i].page, pdfImgs[i].bbox, outPath,
            { requireContent: !!pdfImgs[i].vector })
          if (!ok) continue
        }
        newPaths.push('/question-images/' + fname)
      }
      if (newPaths.length) {
        if (!opts.dryRun) {
          q.images = newPaths
          if (q.gap_reason === 'missing_image_dep' || q.incomplete === 'missing_image') {
            delete q.incomplete
            delete q.gap_reason
          }
        }
        added++
        if (opts.verbose) console.log(`  + ${q.id}: ${newPaths.length} img`)
      }
    }
  } finally {
    for (const pdf of pdfs) {
      for (const p of pdf.pages) { try { p.mupdfPage.destroy?.() } catch {} }
      try { pdf.doc.destroy?.() } catch {}
    }
  }

  if (!opts.dryRun && added > 0) {
    if (raw.metadata) raw.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(file, JSON.stringify(raw, null, 2))
  }
  console.log(`  ${examTag} ${code}: added=${added} skipped=${skipped}`)
  return { added, skipped }
}

async function main() {
  // 題庫檔存在卻不在 registry 的考試 = 會被整個靜默跳過（醫師一階/牙體技術師/
  // 呼吸治療師都是這樣漏掉的），先喊出來
  checkRegistryCoverage(Object.keys(EXAM_REGISTRY), path.join(__dirname, '..'))

  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const verbose = args.includes('--verbose')
  const filterExam = args.find(a => a.startsWith('--exam='))?.slice(7)
  const filterCode = args.find(a => a.startsWith('--code='))?.slice(7)
  const mode = args.find(a => a.startsWith('--mode='))?.slice(7) || 'strict'

  const isBlank = q => ['A','B','C','D'].some(k => !q.options?.[k] || !q.options[k].trim())

  // Build target list: per (examTag, exam_code) where ≥1 candidate question exists
  const targets = []
  for (const [examTag, def] of Object.entries(EXAM_REGISTRY)) {
    if (filterExam && filterExam !== examTag) continue
    const file = path.join(__dirname, '..', def.file)
    if (!fs.existsSync(file)) continue
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const qs = Array.isArray(raw) ? raw : raw.questions
    const codes = new Set()
    for (const q of qs) {
      if (filterCode && filterCode !== q.exam_code) continue
      if (!q.exam_code) continue
      if (q.images && q.images.length) continue
      if (mode === 'blank-options') {
        if (isBlank(q)) codes.add(q.exam_code)
      } else if (mode === 'auto') {
        codes.add(q.exam_code)
      } else {
        const txt = (q.question || '') + ' ' + Object.values(q.options || {}).join(' ')
        if (STRICT.test(txt)) codes.add(q.exam_code)
      }
    }
    for (const code of [...codes].sort()) targets.push({ examTag, code })
  }

  console.log(`Targets: ${targets.length}${dryRun ? ' (dry-run)' : ''} mode=${mode}`)
  let totalAdded = 0, totalSkipped = 0
  for (const t of targets) {
    console.log(`=== ${t.examTag} ${t.code} ===`)
    try {
      const r = await processExamCode(t.examTag, t.code, { dryRun, verbose, mode })
      totalAdded += r.added
      totalSkipped += r.skipped
    } catch (e) { console.error(`  error: ${e.message}`) }
  }
  console.log(`\nTotal: added=${totalAdded} skipped=${totalSkipped}`)
  warnZero((filterExam || '全考試') + ' 補圖', totalAdded,
    'registry 缺該考試、類科碼清單沒涵蓋到該年度、或 CANDIDATE_SUBJECT_CODES 漏了該區段（例如 09xx）')
  process.exitCode = summary()
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1) })
