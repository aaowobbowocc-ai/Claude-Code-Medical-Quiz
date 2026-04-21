#!/usr/bin/env node
/**
 * scrape-ocr-vision.js — Extract questions from image-only PDFs using Claude Vision.
 *
 * Usage:
 *   node scripts/scrape-ocr-vision.js               # all targets
 *   node scripts/scrape-ocr-vision.js --target ot   # single examId prefix
 *   node scripts/scrape-ocr-vision.js --dry-run      # list targets only
 *
 * How it works:
 *   1. Download question PDF (or use cache)
 *   2. Render each page to PNG via mupdf
 *   3. Send each page image to Claude Vision → get structured questions JSON
 *   4. Download answer PDF → parse answers
 *   5. Merge into questions-*.json (only question numbers not already present)
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
require('dotenv').config()

const fs   = require('fs')
const path = require('path')
const https = require('https')
const Anthropic = require('@anthropic-ai/sdk')
const pdfParse  = require('pdf-parse')
const { atomicWriteJson } = require('./lib/atomic-write')

const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE    = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const CACHE   = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const BACKEND = path.resolve(__dirname, '..')

if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true })

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── Targets ─────────────────────────────────────────────────────────────────

const TARGETS = [
  {
    id: 'doctor2_103_1_q4',
    examId: 'doctor2',
    file: 'questions-doctor2.json',
    year: '103', code: '103030', session: '第一次', classCode: '102', s: '0104',
    subject: '醫學(四)', subject_tag: 'pediatrics', subject_name: '醫學(四)',
    answerFormat: 'halfwidth',   // 100-105 style
  },
  {
    id: 'doctor2_103_2_q4',
    examId: 'doctor2',
    file: 'questions-doctor2.json',
    year: '103', code: '103100', session: '第二次', classCode: '102', s: '0104',
    subject: '醫學(四)', subject_tag: 'pediatrics', subject_name: '醫學(四)',
    answerFormat: 'halfwidth',
  },
  {
    id: 'ot_102_2_pediatric',
    examId: 'ot',
    file: 'questions-ot.json',
    year: '102', code: '102100', session: '第二次', classCode: '305', s: '55',
    subject: '小兒疾病職能治療學', subject_tag: 'ot_pediatric', subject_name: '小兒疾病職能治療學',
    answerFormat: 'halfwidth',
  },
  {
    id: 'tcm1_109_1_basic2',
    examId: 'tcm1',
    file: 'questions-tcm1.json',
    year: '109', code: '109030', session: '第一次', classCode: '101', s: '0102',
    subject: '中醫基礎醫學(二)', subject_tag: 'tcm_basic_2', subject_name: '中醫基礎醫學(二)',
    answerFormat: 'fullwidth',   // 106+ style
  },
  {
    id: 'tcm1_100_2_basic2',
    examId: 'tcm1',
    file: 'questions-tcm1.json',
    year: '100', code: '100140', session: '第二次', classCode: '106', s: '0502',
    subject: '中醫基礎醫學(二)', subject_tag: 'tcm_basic_2', subject_name: '中醫基礎醫學(二)',
    answerFormat: 'halfwidth',
  },
  {
    id: 'tcm2_109_1_clinical3',
    examId: 'tcm2',
    file: 'questions-tcm2.json',
    year: '109', code: '109030', session: '第一次', classCode: '102', s: '0103',
    subject: '中醫臨床醫學(三)', subject_tag: 'tcm_clinical_3', subject_name: '中醫臨床醫學(三)',
    answerFormat: 'fullwidth',
  },
  {
    id: 'tcm2_109_1_clinical4',
    examId: 'tcm2',
    file: 'questions-tcm2.json',
    year: '109', code: '109030', session: '第一次', classCode: '102', s: '0104',
    subject: '中醫臨床醫學(四)', subject_tag: 'tcm_clinical_4', subject_name: '中醫臨床醫學(四)',
    answerFormat: 'fullwidth',
  },
]

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 20000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('redirect')) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error('not PDF')) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
      res.on('error', e => retries > 0
        ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
        : reject(e))
    })
    req.on('error', e => retries > 0
      ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
      : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function cachedPdf(kind, code, c, s) {
  const fpath = path.join(CACHE, `${kind}_${code}_c${c}_s${s}.pdf`)
  try {
    const buf = fs.readFileSync(fpath)
    if (buf.length > 1000) return { buf, fromCache: true }
  } catch {}
  const buf = await fetchPdf(`${BASE}?t=${kind}&code=${code}&c=${c}&s=${s}&q=1`)
  fs.writeFileSync(fpath, buf)
  return { buf, fromCache: false }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── PDF → PNG pages via mupdf ───────────────────────────────────────────────

async function pdfToPageImages(buf, dpi = 144) {
  const mupdf = await import('mupdf')
  const doc   = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n     = doc.countPages()
  const scale = dpi / 72
  const images = []
  for (let i = 0; i < n; i++) {
    const page    = doc.loadPage(i)
    const matrix  = mupdf.Matrix.scale(scale, scale)
    const pixmap  = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
    const pngBuf  = Buffer.from(pixmap.asPNG())
    images.push(pngBuf)
  }
  return images  // array of PNG Buffers
}

// ─── Claude Vision: extract questions from one page image ────────────────────

const VISION_PROMPT = `這是一張台灣國家考試（國考）試題的掃描圖片。
請將圖片中所有可見的單選題（選擇題）完整抽出。

規則：
- 每一題必須包含：題號(number)、題目文字(question)、四個選項(A/B/C/D)
- 題目文字和選項請完整逐字抄錄，不要省略或改寫
- 若某選項包含圖片/圖表（如「如圖所示」），請照錄文字說明
- 若此頁沒有完整的選擇題，回傳空 array

只輸出純 JSON，格式：
[
  {
    "number": 1,
    "question": "題目文字...",
    "options": {"A": "...", "B": "...", "C": "...", "D": "..."}
  }
]`

async function extractQuestionsFromImage(pngBuf, pageNum) {
  const base64 = pngBuf.toString('base64')
  let attempts = 0
  while (attempts < 3) {
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
            { type: 'text', text: VISION_PROMPT },
          ],
        }],
      })
      const text = msg.content[0].text.trim()
      // Extract JSON array from response
      const match = text.match(/\[[\s\S]*\]/)
      if (!match) {
        console.log(`    Page ${pageNum}: no JSON array in response, skipping`)
        return []
      }
      return JSON.parse(match[0])
    } catch (e) {
      attempts++
      if (attempts >= 3) { console.log(`    Page ${pageNum}: Vision API failed: ${e.message}`); return [] }
      await sleep(2000 * attempts)
    }
  }
  return []
}

// ─── Answer parsing helpers ──────────────────────────────────────────────────

function parseAnswersPdfLocal(text) {
  const answers = {}
  // fullwidth: 答案ＡＢＣＤ...
  const fwPattern = /答案\s*([ＡＢＣＤ＃]+)/g
  let m, n = 1
  while ((m = fwPattern.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
      else if (ch === '＃') n++
    }
  }
  if (Object.keys(answers).length >= 20) return answers
  // halfwidth: 答案ABCD...
  const hwPattern = /答案\s*([A-D#]{10,})/gi
  n = 1
  const hwAnswers = {}
  while ((m = hwPattern.exec(text)) !== null) {
    for (const ch of m[1]) {
      if (/[A-D]/i.test(ch) && n <= 120) hwAnswers[n] = ch.toUpperCase()
      n++
    }
  }
  if (Object.keys(hwAnswers).length > Object.keys(answers).length &&
      Object.keys(hwAnswers).length >= 20) return hwAnswers
  // "第N題\nX" format (some 109030 PDFs)
  const numPattern = /第\s*(\d+)\s*題[\s\S]{0,5}?([ABCD])/gi
  const numAnswers = {}
  while ((m = numPattern.exec(text)) !== null) {
    const num = parseInt(m[1])
    if (num >= 1 && num <= 120) numAnswers[num] = m[2].toUpperCase()
  }
  if (Object.keys(numAnswers).length > Object.keys(hwAnswers).length) return numAnswers
  return Object.keys(hwAnswers).length > 0 ? hwAnswers : answers
}

const ANSWER_VISION_PROMPT = `這是一張台灣國家考試答案表的掃描圖片。
請抽出所有可見的題號與答案。

只輸出純 JSON，格式（題號為數字，答案為 A/B/C/D）：
{"1":"A","2":"C","3":"B",...}`

async function extractAnswersFromImage(pngBuf) {
  const base64 = pngBuf.toString('base64')
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
          { type: 'text', text: ANSWER_VISION_PROMPT },
        ],
      }],
    })
    const text = msg.content[0].text.trim()
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return {}
    const raw = JSON.parse(match[0])
    const result = {}
    for (const [k, v] of Object.entries(raw)) {
      const num = parseInt(k)
      if (num >= 1 && num <= 120 && /^[ABCD]$/i.test(v)) result[num] = v.toUpperCase()
    }
    return result
  } catch { return {} }
}

async function parseAnswersPdfVision(buf) {
  let pageImages
  try { pageImages = await pdfToPageImages(buf, 120) } catch { return {} }
  const combined = {}
  for (const img of pageImages) {
    const partial = await extractAnswersFromImage(img)
    Object.assign(combined, partial)
    await sleep(300)
  }
  return combined
}

// ─── ID helpers ──────────────────────────────────────────────────────────────

function nextId(questions) {
  if (!questions.length) return 1
  const sample = questions[0].id
  if (typeof sample === 'number') {
    return Math.max(...questions.map(q => Number(q.id))) + 1
  }
  // string format — find max numeric suffix
  const nums = questions.map(q => parseInt(String(q.id).split('_').pop())).filter(n => !isNaN(n))
  return nums.length ? Math.max(...nums) + 1 : questions.length + 1
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function processTarget(t, dryRun) {
  console.log(`\n═══ ${t.id} (${t.year}年${t.session} ${t.subject}) ═══`)

  const filePath = path.join(BACKEND, t.file)
  const rawData  = JSON.parse(fs.readFileSync(filePath))
  const allQs    = rawData.questions || rawData
  const isWrapped = !!rawData.questions

  // Find existing question numbers for this subject
  const existing = allQs.filter(q =>
    q.roc_year === t.year && q.exam_code === t.code && q.subject === t.subject)
  const existingNums = new Set(existing.map(q => q.number))
  const emptyAnswerNums = new Set(existing.filter(q => !q.answer).map(q => q.number))
  const missingNums  = []
  for (let i = 1; i <= 80; i++) if (!existingNums.has(i)) missingNums.push(i)
  console.log(`  Existing: ${existing.length}/80, missing: ${missingNums.length} questions, empty answers: ${emptyAnswerNums.size}`)

  if (missingNums.length === 0 && emptyAnswerNums.size === 0) { console.log('  ✓ Already complete'); return 0 }
  if (dryRun) {
    if (missingNums.length) console.log(`  [dry-run] Would extract Q${missingNums[0]}-${missingNums[missingNums.length-1]}`)
    if (emptyAnswerNums.size) console.log(`  [dry-run] Would patch answers for Q${[...emptyAnswerNums].join(',')}`)
    return 0
  }

  // 1-3: Extract missing questions via Vision (skip if only patching answers)
  let toAdd = []
  if (missingNums.length > 0) {
    let qBuf
    try {
      console.log(`  📥 Downloading question PDF...`)
      const { buf, fromCache } = await cachedPdf('Q', t.code, t.classCode, t.s)
      qBuf = buf
      console.log(`  ${fromCache ? '(cached)' : '(fetched)'} ${buf.length} bytes`)
    } catch (e) {
      console.log(`  ✗ PDF download failed: ${e.message}`)
      qBuf = null
    }

    if (qBuf) {
      console.log(`  🖼  Rendering PDF pages...`)
      let pageImages
      try {
        pageImages = await pdfToPageImages(qBuf)
        console.log(`  ${pageImages.length} pages rendered`)
      } catch (e) {
        console.log(`  ✗ Render failed: ${e.message}`)
        pageImages = []
      }

      if (pageImages.length > 0) {
        console.log(`  🤖 Extracting questions via Claude Vision...`)
        const extracted = []
        for (let i = 0; i < pageImages.length; i++) {
          process.stdout.write(`    Page ${i + 1}/${pageImages.length}... `)
          const qs = await extractQuestionsFromImage(pageImages[i], i + 1)
          console.log(`${qs.length} questions`)
          extracted.push(...qs)
          if (i < pageImages.length - 1) await sleep(500)
        }
        console.log(`  Total extracted: ${extracted.length} questions`)
        toAdd = extracted.filter(q => missingNums.includes(q.number))
        console.log(`  ${toAdd.length} new questions to add`)
      }
    }
  }

  // 4. Download answers
  console.log(`  📥 Downloading answer PDF...`)
  let answers = {}
  let answerBuf = null
  for (const ansType of ['S', 'M', 'A']) {
    try {
      const { buf: aBuf } = await cachedPdf(ansType, t.code, t.classCode, t.s)
      const aText = (await pdfParse(aBuf)).text
      const parsed = parseAnswersPdfLocal(aText)
      if (Object.keys(parsed).length >= 20) { answers = parsed; answerBuf = aBuf; break }
      answerBuf = aBuf  // keep for Vision fallback
    } catch {}
  }
  // Vision fallback when text parsing fails
  if (Object.keys(answers).length < 20 && answerBuf) {
    console.log(`  ⚠ Text parsing got ${Object.keys(answers).length} answers, trying Vision fallback...`)
    answers = await parseAnswersPdfVision(answerBuf)
    console.log(`  Vision fallback: ${Object.keys(answers).length} answers`)
  }
  console.log(`  ${Object.keys(answers).length} answers loaded`)

  // 5a. Patch empty answers on existing questions
  let patched = 0
  if (emptyAnswerNums.size > 0 && Object.keys(answers).length > 0) {
    for (const q of allQs) {
      if (q.roc_year === t.year && q.exam_code === t.code && q.subject === t.subject &&
          !q.answer && answers[q.number]) {
        q.answer = answers[q.number]
        patched++
      }
    }
    console.log(`  Patched ${patched} empty answers`)
  }

  if (missingNums.length === 0 || toAdd.length === 0) {
    if (patched > 0) {
      const output = isWrapped ? { ...rawData, questions: allQs } : allQs
      atomicWriteJson(filePath, output)
      console.log(`  💾 Saved ${t.file}: ${allQs.length} total (patched ${patched} answers)`)
    }
    return patched > 0 ? patched : 0
  }

  // 5b. Build new question objects
  let idCounter = nextId(allQs)
  const newQs = toAdd.map(extracted => {
    const q = {
      id:           idCounter++,
      roc_year:     t.year,
      session:      t.session,
      exam_code:    t.code,
      subject:      t.subject,
      subject_tag:  t.subject_tag,
      subject_name: t.subject_name,
      stage_id:     0,
      number:       extracted.number,
      question:     extracted.question,
      options:      extracted.options,
      answer:       answers[extracted.number] || '',
      explanation:  '',
    }
    if (!q.answer) console.log(`  ⚠ No answer for Q${extracted.number}`)
    return q
  })

  // 6. Merge and save
  const merged = [...allQs, ...newQs]
  const output = isWrapped ? { ...rawData, questions: merged } : merged
  atomicWriteJson(filePath, output)
  console.log(`  💾 Saved ${t.file}: ${merged.length} total (+${newQs.length} new)`)
  return newQs.length
}

async function main() {
  const args    = process.argv.slice(2)
  const dryRun  = args.includes('--dry-run')
  const targetArg = args.find(a => a.startsWith('--target'))?.split('=')?.[1]
                 || (args.indexOf('--target') >= 0 ? args[args.indexOf('--target') + 1] : null)

  const targets = targetArg
    ? TARGETS.filter(t => t.id.startsWith(targetArg) || t.examId === targetArg)
    : TARGETS

  console.log(`Found ${targets.length} targets${dryRun ? ' [DRY RUN]' : ''}`)

  let totalAdded = 0
  for (const t of targets) {
    totalAdded += await processTarget(t, dryRun)
  }
  console.log(`\n總計新增: ${totalAdded} questions`)
}

main().catch(e => { console.error(e); process.exit(1) })
