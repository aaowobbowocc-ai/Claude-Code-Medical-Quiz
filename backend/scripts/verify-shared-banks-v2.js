#!/usr/bin/env node
/**
 * Shared-banks 驗證 v2 — 先從 PDF 第一頁認科目，再對應 shared-bank 題目。
 *
 * 改正 v1 的 bug：v1 用 (year, exam) 找 _S.pdf 但不檢查科目，
 * 結果可能拿到「國文」答案 PDF 去比對「行政法」題目。
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')
const { atomicWriteJson } = require('./lib/atomic-write')

const BACKEND = path.resolve(__dirname, '..')
const PDF_DIRS = [
  path.join(BACKEND, '_tmp', 'pdf-cache'),
  path.join(BACKEND, '_tmp', 'pdf-cache-100-105'),
]
const SB_DIR = path.join(BACKEND, 'shared-banks')
const OCR_CACHE = path.join(BACKEND, '_tmp', 'vision-ocr-cache.json')
const META_CACHE = path.join(BACKEND, '_tmp', 'pdf-metadata-cache.json')
const LOG = path.join(BACKEND, '_tmp', 'shared-banks-verify-v2-log.json')

const args = process.argv.slice(2)
const dry = args.includes('--dry')

const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const VERTEX_MODEL = 'gemini-2.5-pro'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const BANKS = [
  'common_constitution', 'common_law_basics', 'common_chinese', 'common_english',
  'common_law_knowledge', 'common_admin_law', 'common_admin_law_junior',
  'common_admin_studies', 'common_admin_studies_junior',
]

// shared-bank subject → 可能在 PDF 顯示的科目名稱關鍵字
const SUBJECT_KEYWORDS = {
  '法學知識與英文': ['法學知識與英文', '法學知識', '英文'],
  '中華民國憲法': ['中華民國憲法', '憲法'],
  '法學緒論': ['法學緒論'],
  '行政法': ['行政法'],
  '國文': ['國文'],
  '英文': ['英文'],
  '行政學': ['行政學'],
  '行政學概要': ['行政學'],
  '行政法概要': ['行政法'],
}

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

const norm = s => (s || '').normalize('NFKC').replace(/\s/g, '')

// 從每個 cached _S.pdf 抽出 (subject, year, exam) info
async function buildPdfIndex() {
  const meta = JSON.parse(fs.readFileSync(META_CACHE, 'utf-8'))
  const index = []  // [{ name, path, sourceExam, year, subject }]
  for (const dir of PDF_DIRS) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      // 只看公職類 _S.pdf
      const m = f.match(/^(civil-senior|customs|judicial|lawyer1|police|police4)_(\d{6})_c(\d+)_s([\w]+)_S\.pdf$/)
      if (!m) continue
      const [, sourceExam, code, c, s] = m
      const year = code.slice(0, 3)
      // 從 metadata cache 看科目
      const entry = meta[f]
      if (!entry || !entry.sections) continue
      for (const sec of entry.sections) {
        if (sec.subject) index.push({
          name: f, path: path.join(dir, f), sourceExam, year, code,
          subject: sec.subject, page: sec.page,
        })
      }
    }
  }
  return index
}

// 對 (sourceExam, year, targetSubject) 找對應 PDF
function findPdfForSubject(pdfIndex, sourceExam, year, targetSubject) {
  const keywords = SUBJECT_KEYWORDS[targetSubject] || [targetSubject]
  for (const entry of pdfIndex) {
    if (entry.sourceExam !== sourceExam) continue
    if (entry.year !== year) continue
    const subjN = norm(entry.subject)
    for (const kw of keywords) {
      if (subjN.includes(norm(kw))) return entry
    }
  }
  return null
}

async function visionOnePage(png) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const prompt = `這是台灣國考的測驗式試題標準答案 PDF 截圖。
扁平輸出 — {"題號": "答案"} 形式，題號為字串，答案為單一字元 A/B/C/D。
若多選照原樣輸出（"AC"）。若以 # 標記更正答案，用更正後的。
範例：{"1":"A","2":"B","3":"C"}
不要解釋、不要 markdown code fence，只輸出 JSON。`
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { inlineData: { data: png.toString('base64'), mimeType: 'image/png' } },
            { text: prompt },
          ] }],
          generationConfig: { temperature: 0.0, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 256 } },
        }),
      })
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 3000 * 2 ** attempt)); continue }
      if (!resp.ok) { if (attempt === 4) return {}; await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue }
      const data = await resp.json()
      const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return {}
      try {
        const parsed = JSON.parse(m[0])
        const flat = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'object' && v !== null) {
            for (const [qk, qv] of Object.entries(v)) flat[qk] = qv
          } else if (typeof v === 'string' && v.length <= 4) flat[k] = v
        }
        return flat
      } catch { return {} }
    } catch { if (attempt === 4) return {}; await new Promise(r => setTimeout(r, 2000 * (attempt + 1))) }
  }
  return {}
}

async function ocrSpecificPage(pdfPath, pageIdx, cacheKey, ocrCache) {
  const fullKey = `${cacheKey}::p${pageIdx}`
  if (ocrCache[fullKey]) return ocrCache[fullKey]
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const page = doc.loadPage(pageIdx)
  const px = page.toPixmap(mupdf.Matrix.scale(2.0, 2.0), mupdf.ColorSpace.DeviceRGB, false, true)
  const png = Buffer.from(px.asPNG())
  const ans = await visionOnePage(png)
  ocrCache[fullKey] = ans
  atomicWriteJson(OCR_CACHE, ocrCache)
  return ans
}

;(async () => {
  await getMupdf()
  console.log('=== Building PDF index from metadata cache ===')
  const pdfIndex = await buildPdfIndex()
  console.log('Indexed PDF sections:', pdfIndex.length)

  const ocrCache = JSON.parse(fs.readFileSync(OCR_CACHE, 'utf-8') || '{}')

  let totalQs = 0, totalChecked = 0, totalMismatch = 0, totalNoPdf = 0
  const allFixes = []

  for (const bank of BANKS) {
    const fp = path.join(SB_DIR, bank + '.json')
    if (!fs.existsSync(fp)) continue
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    totalQs += arr.length

    const groups = new Map()
    for (const q of arr) {
      const k = `${q.roc_year}|${q.session}|${q.source_exam_code}|${q.subject}`
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(q)
    }

    let bankChecked = 0, bankMismatch = 0
    for (const [k, qs] of groups) {
      const [yr, sess, srcEx, subject] = k.split('|')
      const found = findPdfForSubject(pdfIndex, srcEx, yr, subject)
      if (!found) { totalNoPdf += qs.length; continue }
      let ans
      try { ans = await ocrSpecificPage(found.path, found.page, found.name, ocrCache) }
      catch { totalNoPdf += qs.length; continue }
      if (Object.keys(ans).length < 5) { totalNoPdf += qs.length; continue }

      for (const q of qs) {
        const got = ans[String(q.number)] || ans[q.number]
        if (!got) continue
        bankChecked++; totalChecked++
        if (!/^[ABCD]$/.test(got)) continue
        if (q.answer === '送分' || /[#＃]/.test(q.answer || '') || q.disputed) continue
        if (got !== q.answer) {
          bankMismatch++; totalMismatch++
          allFixes.push({
            bank, qid: q.id, year: q.roc_year, session: q.session, sourceExam: q.source_exam_code,
            subject: q.subject, num: q.number, old: q.answer, new: got, source: found.name,
          })
          if (!dry) { q.answer = got; q.disputed = true }
        }
      }
    }
    if (!dry && bankMismatch > 0) atomicWriteJson(fp, data)
    console.log(`[${bank.padEnd(30)}] checked=${bankChecked} mismatch=${bankMismatch}`)
  }

  fs.writeFileSync(LOG, JSON.stringify({
    timestamp: new Date().toISOString(),
    dry, totalQs, totalChecked, totalMismatch, totalNoPdf,
    samples: allFixes.slice(0, 50), full: allFixes,
  }, null, 2))

  console.log(`\n=== Total: ${totalChecked} checked, ${totalMismatch} mismatch (${totalNoPdf} no PDF) ===`)
  console.log(`Log: ${path.relative(BACKEND, LOG)}`)
})().catch(e => { console.error(e); process.exit(1) })
