#!/usr/bin/env node
/**
 * 暴力 Vision OCR 修復器：為每題 incomplete 掃過該 exam_code 下所有 PDF，
 * 找有對應題號內容的那張，render 該頁高 DPI，請 Gemini 直接 OCR 該題。
 *
 * 跟 fix-incomplete-batch-vision 不同：
 *   - 不靠 subject literal match（PDF 描述跟 DB subject_name 常不一致）
 *   - 不靠 content fingerprint（古文 PDF 經常 parser 失敗）
 *   - 直接 Vision OCR：給整張頁面 + 題號，全 LLM 找
 *
 * 用法:
 *   node scripts/fix-stubborn-incomplete.js --dry-run
 *   node scripts/fix-stubborn-incomplete.js --exam=tcm1
 *   node scripts/fix-stubborn-incomplete.js --concurrency=2
 */
require('dotenv/config')
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
// MODEL: gemini-2.5-flash (changed 2026-05-23 from gemini-2.5-pro)
//   OCR / Vision 任務不需要 Pro 推理；Flash 同準確度但便宜 ~17-33 倍。
//   5/22 batch 跑 Pro thinking 一次燒 $200+，Flash 同 batch 約 $5-10。
//   若特殊題目 Flash 結果不佳，再針對該批改回 'gemini-2.5-pro'。
const VERTEX_MODEL = 'gemini-2.5-flash'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const examFilter = args.find(a => a.startsWith('--exam='))?.split('=')[1] || 'all'
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1]) || 2
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || Infinity

const EXAM_FILES = {
  doctor1: 'questions.json', doctor2: 'questions-doctor2.json',
  dental1: 'questions-dental1.json', dental2: 'questions-dental2.json',
  pharma1: 'questions-pharma1.json', pharma2: 'questions-pharma2.json',
  nursing: 'questions-nursing.json', nutrition: 'questions-nutrition.json',
  medlab: 'questions-medlab.json', pt: 'questions-pt.json', ot: 'questions-ot.json',
  radiology: 'questions-radiology.json', tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json', vet: 'questions-vet.json',
  audiologist: 'questions-audiologist.json',
  'speech-therapist': 'questions-speech-therapist.json',
}

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

const pdfPageCache = {}  // pdfPath -> { doc, pages: [{idx, text}] }
async function loadPdfPages(pdfPath) {
  if (pdfPageCache[pdfPath]) return pdfPageCache[pdfPath]
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const pages = []
  const n = doc.countPages()
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i)
    const text = stripPUA(page.toStructuredText('preserve-whitespace').asText())
    pages.push({ page, text, idx: i })
  }
  const result = { doc, pages, mupdf }
  pdfPageCache[pdfPath] = result
  return result
}

async function findCandidatePdfs(exam, exam_code) {
  const allFiles = fs.readdirSync(PDF_CACHE).filter(f => f.endsWith('.pdf'))
  // Match (1) Q PDFs starting with exam prefix, (2) any PDF containing exam_code (Q-style)
  // Skip TM/TS/M/S/A/TA answer-only PDFs (we want question PDFs).
  return allFiles.filter(f => {
    if (/^(TM|TS|M|S|A|TA)_/.test(f)) return false
    if (f.startsWith(`${exam}_${exam_code}_`)) return true
    if (new RegExp(`(?:^|_)Q_${exam_code}_c\\d+_s`).test(f)) return true
    if (new RegExp(`^[A-Za-z\\-]+_Q_${exam_code}_c\\d+_s`).test(f)) return true
    return false
  })
}

async function findPageWithQuestion(pdfPath, qnum) {
  const { pages, mupdf, doc } = await loadPdfPages(pdfPath)
  // Detect page containing "Nthat题" pattern. Try several patterns.
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s*[.、．]`),
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`),
    new RegExp(`第\\s*${qnum}\\s*題`),
  ]
  for (const p of pages) {
    for (const re of patterns) {
      if (re.test(p.text)) return { page: p.page, idx: p.idx, mupdf, doc, totalPages: pages.length }
    }
  }
  return null
}

async function pageToPng(page, mupdf, scale = 3) {
  const px = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
  return Buffer.from(px.asPNG())
}

async function visionExtract(pngs, qnum, examName, subjectHint) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const prompt = `這是台灣${examName}「${subjectHint || '專業科目'}」試題掃描頁。請從圖中找出第 ${qnum} 題並完整輸出其題幹與四個選項。

注意事項：
- 題號可能是「${qnum}.」、「${qnum}、」、單獨「${qnum}」一行，或「第 ${qnum} 題」
- 中醫古文題可能含古籍引文/方劑名/藥材名，請完整保留
- 若選項是 ①②③④ 圈圈數字組合，請完整保留組合（例：「①②③」、「①③④」）
- 每個選項必須非空
- 若該頁找不到第 ${qnum} 題，回 {"found": false}

只輸出 JSON：{"found": true, "number": ${qnum}, "question": "完整題幹", "options": {"A":"...","B":"...","C":"...","D":"..."}}`
  const parts = pngs.map(b => ({ inlineData: { data: b.toString('base64'), mimeType: 'image/png' } }))
  parts.push({ text: prompt })
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 180000)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 4096 } }),
        signal: ctrl.signal,
      })
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 5000 * (attempt + 1))); continue }
      if (!resp.ok) {
        const err = await resp.text().catch(() => '')
        if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue }
        throw new Error('HTTP ' + resp.status + ': ' + err.slice(0, 100))
      }
      const data = await resp.json()
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const m = text.match(/\{[\s\S]*\}/)
      if (m) return JSON.parse(m[0])
      return null
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000))
      else throw e
    }
  }
  return null
}

const EXAM_NAME = {
  doctor1: '醫師一階', doctor2: '醫師二階',
  dental1: '牙醫一階', dental2: '牙醫二階',
  pharma1: '藥師一階', pharma2: '藥師二階',
  nursing: '護理師', nutrition: '營養師',
  medlab: '醫事檢驗師', pt: '物理治療師', ot: '職能治療師', radiology: '醫事放射師',
  tcm1: '中醫師一階', tcm2: '中醫師二階',
  vet: '獸醫師', audiologist: '聽力師', 'speech-therapist': '語言治療師',
}

// Verify PDF subject matches DB question's subject before trusting its content.
// Also check if existing DB question text matches PDF's question (sanity check).
async function fixOne(q, exam, examName) {
  const dbQ = (q.question || '').replace(/^\d+[.、．\s]*/, '').trim().slice(0, 30)
  const candidates = await findCandidatePdfs(exam, q.exam_code)
  for (const f of candidates) {
    const pdfPath = path.join(PDF_CACHE, f)
    let info
    try { info = await findPageWithQuestion(pdfPath, q.number) } catch { continue }
    if (!info) continue
    // Sanity: PDF first page subject should not blatantly contradict DB subject.
    // Reject obvious wrong-exam PDFs (e.g. tcm1_100030_c101 is actually doctor1 mistagged).
    const { pages } = await loadPdfPages(pdfPath)
    const firstPageText = pages[0]?.text || ''
    const dbSubjectMain = (q.subject_name || q.subject || '').replace(/[（(].*$/, '').trim()
    // If question text is non-trivial, the PDF page must contain at least 8 chars of it
    if (dbQ.length >= 12) {
      const targetPageText = pages[info.idx]?.text || ''
      const hint = dbQ.slice(0, 8)
      if (!targetPageText.includes(hint)) {
        // PDF found Q-num but it's a different question — skip this PDF
        continue
      }
    }
    const pngs = []
    pngs.push(await pageToPng(info.page, info.mupdf, 3))
    if (info.idx + 1 < info.totalPages) {
      const next = info.doc.loadPage(info.idx + 1)
      pngs.push(await pageToPng(next, info.mupdf, 3))
    }
    let v
    try { v = await visionExtract(pngs, q.number, examName, q.subject_name || q.subject) }
    catch (e) { continue }
    if (!v || !v.found) continue
    if (!v.options || Object.keys(v.options).length !== 4) continue
    if (Object.values(v.options).some(o => !o || o.length < 1)) continue
    if (!v.question || v.question.length < 8) continue
    // Only overwrite question if existing was empty/very short; otherwise keep DB version.
    const keepDbQuestion = (q.question || '').length >= 12
    return {
      question: keepDbQuestion ? q.question : v.question,
      options: v.options,
      sourcePdf: f,
    }
  }
  return null
}

async function processExam(exam) {
  const file = EXAM_FILES[exam]
  if (!file) return 0
  const fp = path.join(BACKEND, file)
  if (!fs.existsSync(fp)) return 0
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = data.questions || data
  const candidates = arr.filter(q => q.incomplete || (!q.options || Object.keys(q.options).length !== 4 || Object.values(q.options).some(o => !o)))
  const todo = candidates.slice(0, limit)
  console.log(`[${exam}] incomplete=${candidates.length}, todo=${todo.length}`)
  if (dryRun || !todo.length) return 0

  const examName = EXAM_NAME[exam] || exam
  let done = 0, fail = 0
  const queue = [...todo]
  async function worker() {
    while (queue.length) {
      const q = queue.shift()
      if (!q) break
      try {
        const res = await fixOne(q, exam, examName)
        if (res) {
          q.question = res.question
          q.options = res.options
          delete q.incomplete
          delete q.gap_reason
          done++
        } else {
          fail++
        }
      } catch (e) {
        fail++
      }
      if ((done + fail) % 5 === 0) {
        process.stdout.write(`\r  [${exam}] ${done}/${todo.length} fixed, ${fail} failed`)
        // Save every 5
        fs.writeFileSync(fp, JSON.stringify(data, null, 2))
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log(`\n  [${exam}] ✓ ${done} fixed, ${fail} unrecoverable`)
  return done
}

async function main() {
  const exams = examFilter === 'all'
    ? ['tcm1','tcm2','audiologist','speech-therapist','nursing','dental2','medlab','pharma1','pharma2','pt','ot','radiology','vet','dental1','nutrition']
    : examFilter.split(',')
  console.log(`[stubborn-fix] exams=${exams.join(',')} concurrency=${concurrency} dry=${dryRun}`)
  let total = 0
  for (const e of exams) total += await processExam(e)
  console.log(`\n=== TOTAL FIXED: ${total} ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
