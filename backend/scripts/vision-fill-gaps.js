#!/usr/bin/env node
/**
 * Use Vertex AI Gemini Vision to extract specific missing questions from PDFs.
 *
 * For each (exam, exam_code, subject, missing_number):
 *   1. Find PDF (using auto-fill discoverPdf logic)
 *   2. Locate the page containing the question
 *   3. Render page at 2x DPI → send to Vertex Vision
 *   4. Parse JSON response with question + options
 *   5. Get answer from cached answer PDF
 *   6. Add to questions JSON (idempotent dedup)
 */

require('dotenv/config')
const fs = require('fs')
const path = require('path')
const https = require('https')
const { GoogleAuth } = require('google-auth-library')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const VERTEX_MODEL = 'gemini-2.5-pro'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

const EXAMS = {
  doctor1: 'questions.json', doctor2: 'questions-doctor2.json',
  dental1: 'questions-dental1.json', dental2: 'questions-dental2.json',
  pharma1: 'questions-pharma1.json', pharma2: 'questions-pharma2.json',
  nursing: 'questions-nursing.json', nutrition: 'questions-nutrition.json',
  medlab: 'questions-medlab.json', pt: 'questions-pt.json', ot: 'questions-ot.json',
  radiology: 'questions-radiology.json', tcm1: 'questions-tcm1.json', tcm2: 'questions-tcm2.json',
  vet: 'questions-vet.json', 'social-worker': 'questions-social-worker.json',
  audiologist: 'questions-audiologist.json', 'speech-therapist': 'questions-speech-therapist.json',
}

const SUBJECT_ALIASES = {
  '醫學分子檢驗學與臨床鏡檢學': ['臨床鏡檢學'],
  '微生物學與臨床微生物學': ['微生物學及臨床微生物學', '微生物學'],
  '卷一': ['醫學(一)', '牙醫學(一)', '藥理學與藥物化學', '物理治療基礎學'],
  '卷二': ['醫學(二)', '牙醫學(二)', '藥物分析與生藥學', '物理治療學概論'],
  '卷三': ['醫學(三)', '牙醫學(三)', '藥劑學', '物理治療技術學'],
  '卷四': ['醫學(四)', '牙醫學(四)', '神經疾病物理治療學'],
  '卷五': ['醫學(五)', '牙醫學(五)'],
  '卷六': ['醫學(六)', '牙醫學(六)'],
  '調劑與臨床': ['調劑學與臨床藥學'],
  '藥物治療': ['藥物治療學'],
  '法規': ['藥事行政與法規'],
  '聽力學與輔助溝通系統（包括專業倫理）': ['聽力學與輔助溝通系統', '溝通障礙總論'],
}

const PDF_PREFIX_VARIANTS = {
  'speech-therapist': ['speech-therapist', 'speech'],
  'social-worker': ['social-worker', 'socialworker'],
}

function get(url) {
  return new Promise(r => {
    https.get(url, { agent: new https.Agent({ rejectUnauthorized: false }) }, x => {
      if (x.statusCode !== 200) { x.destroy(); return r(null) }
      const c = []; x.on('data', d => c.push(d)); x.on('end', () => r(Buffer.concat(c)))
    }).on('error', () => r(null))
  })
}

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

async function readPdfText(p) {
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(p)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += '\n' + doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return stripPUA(txt)
}

async function discoverPdf(examPrefix, examCode, subjectName) {
  const prefixes = PDF_PREFIX_VARIANTS[examPrefix] || [examPrefix]
  let files = []
  for (const pfx of prefixes) {
    files = files.concat(fs.readdirSync(PDF_CACHE).filter(f =>
      f.startsWith(pfx + '_' + examCode + '_') && f.endsWith('.pdf')
      && !f.startsWith('A_') && !f.startsWith('TM_') && !f.startsWith('TS_')
      && !f.endsWith('_S.pdf')
    ))
  }
  const stem = subjectName.replace(/[（(].*$/, '').trim()
  const headPart = stem.split(/[與及]/)[0]
  const keywords = [subjectName, stem, headPart, ...(SUBJECT_ALIASES[subjectName] || [])]
  for (const f of files) {
    const p = path.join(PDF_CACHE, f)
    const txt = await readPdfText(p)
    if (keywords.some(k => k && txt.includes(k))) return p
  }
  return null
}

async function findQuestionPage(pdfPath, qnum) {
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  for (let i = 0; i < doc.countPages(); i++) {
    const t = stripPUA(doc.loadPage(i).toStructuredText('preserve-whitespace').asText())
    // Try various patterns: "NN.", "NN ", standalone NN at line start
    if (new RegExp(`(?:^|\\n)\\s*${qnum}[.、．]`).test(t)) return { doc, idx: i }
    if (new RegExp(`(?:^|\\n)\\s*${qnum}\\s{2,}[^\\d]`).test(t)) return { doc, idx: i }
    if (new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`).test(t)) return { doc, idx: i }
  }
  return null
}

async function pageToPng(doc, idx, scale = 2) {
  const mupdf = await getMupdf()
  const page = doc.loadPage(idx)
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
  return Buffer.from(pixmap.asPNG())
}

async function visionExtract(pngBuf, qnum) {
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const token = await auth.getAccessToken()
  const prompt = `這是台灣國家考試試題掃描頁。請從圖中抽出第 ${qnum} 題的完整題幹和 A/B/C/D 四個選項。
若雙欄版型，依「左上→左下→右上→右下」逐欄讀取選項位置以正確對應 A/B/C/D。
若題目跨頁或本頁沒有第 ${qnum} 題，回傳 {"found": false}。
只輸出純 JSON：{"found": true, "number": ${qnum}, "question": "...", "options": {"A": "...", "B": "...", "C": "...", "D": "..."}}`
  const tokenStr = (typeof token === 'string') ? token : token.token
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { inlineData: { data: pngBuf.toString('base64'), mimeType: 'image/png' } },
            { text: prompt },
          ]}],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(JSON.stringify(data).slice(0, 200))
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const m = text.match(/\{[\s\S]*\}/)
      if (m) return JSON.parse(m[0])
    } catch (e) {
      if (attempt >= 1) { console.log('     vision err:', e.message); return null }
      await new Promise(r => setTimeout(r, 1500))
    }
  }
  return null
}

async function getAnswerKey(examCode, c, s, paperCount, examPrefix) {
  const candidates = [
    `TM_${examCode}_c${c}_s${s}.pdf`,
    `TS_${examCode}_c${c}_s${s}.pdf`,
    `A_${examCode}_c${c}_s${s}.pdf`,
    examPrefix && `${examPrefix}_${examCode}_c${c}_s${s}_S.pdf`,
    examPrefix && `A_${examPrefix}_${examCode}_c${c}_s${s}.pdf`,
  ].filter(Boolean)
  for (const fn of candidates) {
    const p = path.join(PDF_CACHE, fn)
    if (fs.existsSync(p) && fs.statSync(p).size > 1000) {
      const txt = await readPdfText(p)
      const letters = (txt.match(/(?<![A-Z0-9])[A-D#](?![A-Z0-9])/g) || [])
      if (letters.length >= paperCount) return letters.slice(0, paperCount).join('')
    }
  }
  for (const t of ['S', 'M', 'A']) {
    const url = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=${t}&code=${examCode}&c=${c}&s=${s}&q=1`
    const buf = await get(url)
    if (!buf || buf.length < 1000) continue
    fs.writeFileSync(path.join(PDF_CACHE, `T${t}_${examCode}_c${c}_s${s}.pdf`), buf)
    const txt = stripPUA(await readPdfText(path.join(PDF_CACHE, `T${t}_${examCode}_c${c}_s${s}.pdf`)))
    const letters = (txt.match(/(?<![A-Z0-9])[A-D#](?![A-Z0-9])/g) || [])
    if (letters.length >= paperCount) return letters.slice(0, paperCount).join('')
  }
  return null
}

// Per-exam historical paper-count overrides (when older years had different counts)
// nutrition: 113年起改 50題；100-112 為 40題/paper for 4 中央科目
function getHistoricalCount(examId, examCode, subject, defaultCount) {
  if (examId === 'nutrition' && parseInt(examCode.slice(0, 3)) < 113) {
    if (['生理學與生物化學', '營養學', '公共衛生營養學', '食品衛生與安全'].includes(subject)) {
      return 40
    }
  }
  return defaultCount
}

function audit(examFilter) {
  const gaps = []
  for (const [examId, file] of Object.entries(EXAMS)) {
    if (examFilter && !examFilter.includes(examId)) continue
    const cfg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'exam-configs', examId + '.json'), 'utf8'))
    const expByPaper = {}
    for (const p of cfg.papers) expByPaper[p.subject] = { count: p.count, tag: p.id }
    const data = JSON.parse(fs.readFileSync(path.join(BACKEND, file), 'utf8'))
    const arr = data.questions || data
    const grp = {}
    for (const q of arr) {
      const k = q.exam_code + '|' + q.subject
      grp[k] = grp[k] || []
      grp[k].push(q)
    }
    for (const [k, qs] of Object.entries(grp)) {
      const [code, subj] = k.split('|')
      const exp = expByPaper[subj]
      if (!exp) continue
      const histCount = getHistoricalCount(examId, code, subj, exp.count)
      const gap = histCount - qs.length
      if (gap < 1 || gap > 25) continue
      const have = new Set(qs.map(q => q.number))
      const missing = []
      for (let i = 1; i <= histCount; i++) if (!have.has(i)) missing.push(i)
      const sample = qs[0]
      gaps.push({
        examId, jsonFile: file, examCode: code, subject: subj, subject_tag: exp.tag,
        missing, paperCount: histCount,
        rocYear: sample?.roc_year || code.slice(0, 3),
        session: sample?.session || (parseInt(code.slice(3, 6)) > 50 ? '第二次' : '第一次'),
      })
    }
  }
  return gaps
}

async function fillGapWithVision(gap) {
  const pdfPath = await discoverPdf(gap.examId, gap.examCode, gap.subject)
  if (!pdfPath) return { status: 'NO_PDF', added: 0 }
  const fname = path.basename(pdfPath)
  const csMatch = fname.match(/_c(\w+)_s(\w+?)(?:_Q)?\.pdf$/)
  if (!csMatch) return { status: 'NO_CS', added: 0 }
  const [, c, s] = csMatch
  const answers = await getAnswerKey(gap.examCode, c, s, gap.paperCount, gap.examId)
  if (!answers) return { status: 'NO_ANS', added: 0 }

  const filePath = path.join(BACKEND, gap.jsonFile)
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr = data.questions || data
  const maxId = arr.reduce((m, q) => Math.max(m, typeof q.id === 'number' ? q.id : parseInt(String(q.id).replace(/\D/g, '')) || 0), 0)
  let nextId = maxId + 1
  const existing = new Set(arr.filter(q => q.exam_code === gap.examCode && q.subject === gap.subject).map(q => q.number))

  let added = 0, vErr = 0
  for (const num of gap.missing) {
    if (existing.has(num)) continue
    const ans = answers[num - 1]
    if (!ans || ans === '#') continue
    const pageInfo = await findQuestionPage(pdfPath, num)
    if (!pageInfo) { console.log(`     Q${num}: page not found`); continue }
    const png = await pageToPng(pageInfo.doc, pageInfo.idx)
    const v = await visionExtract(png, num)
    if (!v || !v.found || !v.options) { console.log(`     Q${num}: vision miss`); vErr++; continue }
    if (Object.keys(v.options).length !== 4) continue
    if (Object.values(v.options).some(x => !x || x.length < 2)) continue
    existing.add(num)
    arr.push({
      id: nextId++,
      roc_year: gap.rocYear, session: gap.session, exam_code: gap.examCode,
      subject: gap.subject, subject_tag: gap.subject_tag, subject_name: gap.subject,
      stage_id: 0, number: num, question: v.question, options: v.options,
      answer: ans, explanation: '',
    })
    added++
    console.log(`     Q${num}: ✓`)
  }
  if (added > 0) {
    arr.sort((a, b) => {
      if (a.exam_code !== b.exam_code) return a.exam_code.localeCompare(b.exam_code)
      if (a.subject !== b.subject) return a.subject.localeCompare(b.subject)
      return (a.number || 0) - (b.number || 0)
    })
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
  }
  return { status: 'OK', added, total: gap.missing.length, vErr }
}

async function main() {
  const TARGETS = ['medlab','pharma1','pharma2','pt','vet','social-worker','audiologist','speech-therapist','tcm2','radiology','dental2','doctor2','nursing','nutrition']
  const limit = process.argv.find(a => a.startsWith('--limit='))?.slice(8)
  const max = limit ? parseInt(limit) : Infinity

  const gaps = audit(TARGETS)
  console.log(`Found ${gaps.length} gaps. Total missing: ${gaps.reduce((s, g) => s + g.missing.length, 0)}\n`)
  let totalAdded = 0
  let processed = 0
  for (const g of gaps) {
    if (processed >= max) break
    console.log(`  [${g.examId} ${g.examCode} ${g.subject}] missing ${g.missing.length}:`)
    const r = await fillGapWithVision(g)
    if (r.added > 0) {
      console.log(`    +${r.added}/${r.total} (status=${r.status})`)
      totalAdded += r.added
    } else {
      console.log(`    ${r.status}`)
    }
    processed++
  }
  console.log(`\n=== Total added via Vision: ${totalAdded} ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
