#!/usr/bin/env node
/**
 * 中醫古文 incomplete 高解析度 OCR：專打 tcm1/tcm2 殘留 incomplete。
 *
 * 跟 fix-stubborn-incomplete.js 差別：
 *   - DPI scale 3 → 7（高 5.4x 像素），對掃描品質差的古文 PDF 給更多細節
 *   - 只跑 tcm1/tcm2
 *   - 加強 prompt：強調古文/方劑/藥材/古籍引文要逐字
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
const VERTEX_MODEL = 'gemini-2.5-pro'
const SCALE = 7

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const examFilter = args.find(a => a.startsWith('--exam='))?.split('=')[1] || 'tcm1,tcm2'
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1]) || 2
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || Infinity

const EXAM_FILES = {
  tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json',
}
const EXAM_NAME = { tcm1: '中醫師一階', tcm2: '中醫師二階' }

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

const pdfPageCache = {}
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

async function pageToPng(page, mupdf, scale = SCALE) {
  const px = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
  return Buffer.from(px.asPNG())
}

async function visionExtract(pngs, qnum, examName, subjectHint) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const prompt = `這是台灣${examName}「${subjectHint || '專業科目'}」試題掃描頁（高解析度 ${SCALE}x DPI）。請從圖中找出第 ${qnum} 題並完整輸出其題幹與四個選項。

注意事項：
- 此為中醫古文題，可能含古籍引文（如《內經》《傷寒論》《金匱要略》《醫宗金鑑》等）、方劑名（如桂枝湯、四物湯）、藥材名、五行/經絡術語
- 古文逐字OCR，不要意譯、不要簡化、繁簡體照原文
- 題號可能是「${qnum}.」、「${qnum}、」、單獨「${qnum}」一行，或「第 ${qnum} 題」
- 選項可能是 ①②③④ 圈圈數字組合（例：「①②③」、「①③④」）→ 完整保留組合
- 選項也可能是中文一段（藥材組合、方劑名等）→ 完整逐字保留
- 每個選項必須非空
- 若該頁找不到第 ${qnum} 題或字跡完全無法辨識，回 {"found": false, "reason": "原因簡述"}

只輸出 JSON：{"found": true, "number": ${qnum}, "question": "完整題幹", "options": {"A":"...","B":"...","C":"...","D":"..."}}`
  const parts = pngs.map(b => ({ inlineData: { data: b.toString('base64'), mimeType: 'image/png' } }))
  parts.push({ text: prompt })
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 240000)  // 4 min for high-res
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

async function fixOne(q, exam, examName) {
  const dbQ = (q.question || '').replace(/^\d+[.、．\s]*/, '').trim().slice(0, 30)
  const candidates = await findCandidatePdfs(exam, q.exam_code)
  for (const f of candidates) {
    const pdfPath = path.join(PDF_CACHE, f)
    let info
    try { info = await findPageWithQuestion(pdfPath, q.number) } catch { continue }
    if (!info) continue
    const { pages } = await loadPdfPages(pdfPath)
    if (dbQ.length >= 12) {
      const targetPageText = pages[info.idx]?.text || ''
      const hint = dbQ.slice(0, 8)
      if (!targetPageText.includes(hint)) continue
    }
    const pngs = []
    pngs.push(await pageToPng(info.page, info.mupdf, SCALE))
    if (info.idx + 1 < info.totalPages) {
      const next = info.doc.loadPage(info.idx + 1)
      pngs.push(await pageToPng(next, info.mupdf, SCALE))
    }
    let v
    try { v = await visionExtract(pngs, q.number, examName, q.subject_name || q.subject) }
    catch (e) { continue }
    if (!v || !v.found) continue
    if (!v.options || Object.keys(v.options).length !== 4) continue
    if (Object.values(v.options).some(o => !o || o.length < 1)) continue
    if (!v.question || v.question.length < 8) continue
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
  const candidates = arr.filter(q => q.incomplete)
  const todo = candidates.slice(0, limit)
  console.log(`[${exam}] incomplete=${candidates.length}, todo=${todo.length} (DPI=${SCALE}x)`)
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
          process.stdout.write(`\n  [${exam}] ✓ ${q.id} (${q.exam_code} Q${q.number}) ← ${res.sourcePdf}`)
        } else {
          fail++
        }
      } catch (e) {
        fail++
      }
      if ((done + fail) % 3 === 0) {
        process.stdout.write(`\r  [${exam}] ${done}/${todo.length} fixed, ${fail} failed`)
        fs.writeFileSync(fp, JSON.stringify(data, null, 2))
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log(`\n  [${exam}] DONE ✓ ${done} fixed, ${fail} unrecoverable`)
  return done
}

async function main() {
  const exams = examFilter.split(',')
  console.log(`[tcm-classical-hires] exams=${exams.join(',')} DPI=${SCALE}x concurrency=${concurrency} dry=${dryRun}`)
  let total = 0
  for (const e of exams) total += await processExam(e)
  console.log(`\n=== TOTAL FIXED: ${total} ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
