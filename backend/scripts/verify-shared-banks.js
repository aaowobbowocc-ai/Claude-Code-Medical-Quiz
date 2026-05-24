#!/usr/bin/env node
/**
 * 對 shared-banks 答案做 Vision OCR 驗證。
 * 只用已 cached 的 PDF（avoid 額外抓 PDF 費用）。
 *
 * 流程：
 *   1. 對每個 shared-bank 題目，找 source PDF (S/TS 答案 PDF)
 *   2. 用 Gemini 2.5 Pro Vision OCR 答案表
 *   3. 比對 stored vs OCR
 *   4. 不一致時：dry-run 列表，--apply 套用 + disputed=true
 *
 * Cache vision-ocr-cache.json 已有的不再呼叫 (重用 vision-recheck v2 cache)
 *
 * Usage:
 *   node scripts/verify-shared-banks.js [--dry] [--bank common_constitution]
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
const LOG = path.join(BACKEND, '_tmp', 'shared-banks-verify-log.json')

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const bankFilter = args.includes('--bank') ? args[args.indexOf('--bank') + 1] : null

const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const VERTEX_MODEL = 'gemini-2.5-pro'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const BANKS = [
  'common_constitution', 'common_law_basics', 'common_chinese', 'common_english',
  'common_law_knowledge', 'common_admin_law', 'common_admin_law_junior',
  'common_admin_studies', 'common_admin_studies_junior',
]

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

// 找 cached answer PDF for source exam + year + session
// 命名規則：${exam}_${code}_c${c}_s${s}_S.pdf 或 TS_${exam}_${code}*.pdf
function findAnswerPdf(sourceExam, rocYear, session) {
  // 不知道 code，scan 所有 cached PDF 找名稱含 exam + year 的
  const yearPrefix = rocYear + (session === '第二次' || session === '第二次' ? '0' : '0')  // best effort
  const candidates = []
  for (const dir of PDF_DIRS) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(sourceExam + '_')) continue
      // 必須是 _S.pdf 或 TS_ 開頭（answer/standard）
      const isAnswer = f.endsWith('_S.pdf')
      if (!isAnswer) continue
      // year 必須在檔名中
      if (!f.includes(rocYear)) continue
      candidates.push({ name: f, path: path.join(dir, f) })
    }
  }
  return candidates
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
          generationConfig: { temperature: 0.0, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } },
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
    } catch (e) {
      if (attempt === 4) return {}
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
  return {}
}

async function ocrPdf(pdfPath, ocrCache) {
  const name = path.basename(pdfPath)
  if (ocrCache[name] && Object.keys(ocrCache[name]).length > 0) return ocrCache[name]
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  const subjectAnswers = {}
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i)
    const text = page.toStructuredText('preserve-whitespace').asText().normalize('NFKC')
    // 多科同頁 → 跳過
    const subjectHeaders = (text.match(/科\s*目\s*名稱\s*[：:]/g) || []).length
    if (subjectHeaders > 1) continue
    let subj = ''
    const ord = text.match(/科\s*目\s*名稱\s*[：:]\s*\n?\s*([^\s\n]+?(?:\([^)]+\))?)/)
    if (ord) subj = ord[1].trim().replace(/\(.+$/, '').trim()
    if (!subj || subj.length < 2) subj = '_default'
    const px = page.toPixmap(mupdf.Matrix.scale(2.0, 2.0), mupdf.ColorSpace.DeviceRGB, false, true)
    const png = Buffer.from(px.asPNG())
    const ans = await visionOnePage(png)
    if (Object.keys(ans).length > 0) subjectAnswers[subj] = { ...(subjectAnswers[subj] || {}), ...ans }
  }
  ocrCache[name] = subjectAnswers
  atomicWriteJson(OCR_CACHE, ocrCache)
  return subjectAnswers
}

;(async () => {
  await getMupdf()
  const ocrCache = JSON.parse(fs.readFileSync(OCR_CACHE, 'utf-8') || '{}')

  let totalQs = 0, totalChecked = 0, totalMismatch = 0, totalSkipped = 0
  const allFixes = []

  for (const bank of BANKS) {
    if (bankFilter && bank !== bankFilter) continue
    const fp = path.join(SB_DIR, bank + '.json')
    if (!fs.existsSync(fp)) continue
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    totalQs += arr.length

    // group by (year, session, source_exam, subject)
    const groups = new Map()
    for (const q of arr) {
      const k = `${q.roc_year}|${q.session}|${q.source_exam_code}|${q.subject}`
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(q)
    }

    let bankChecked = 0, bankMismatch = 0, bankFix = 0
    for (const [k, qs] of groups) {
      const [yr, sess, srcEx, subject] = k.split('|')
      const pdfs = findAnswerPdf(srcEx, yr, sess)
      if (pdfs.length === 0) { totalSkipped += qs.length; continue }
      // 取第一個
      const pdfPath = pdfs[0].path
      let ocrResult
      try { ocrResult = await ocrPdf(pdfPath, ocrCache) }
      catch (e) { totalSkipped += qs.length; continue }

      // 找 subject 對應的答案 map（嚴格 NFKC 相同 或 唯一 subject）
      const norm = s => (s || '').normalize('NFKC').replace(/\s/g, '')
      let ansMap = null
      for (const [s, m] of Object.entries(ocrResult)) {
        if (norm(s) === norm(subject) || norm(s).includes(norm(subject)) || norm(subject).includes(norm(s))) {
          ansMap = m; break
        }
      }
      if (!ansMap && Object.keys(ocrResult).length === 1) ansMap = Object.values(ocrResult)[0]
      if (!ansMap) { totalSkipped += qs.length; continue }

      for (const q of qs) {
        const got = ansMap[String(q.number)] || ansMap[q.number]
        if (!got) continue
        bankChecked++; totalChecked++
        if (!/^[ABCD]$/.test(got)) continue
        // disputed 跳過
        if (q.answer === '送分' || /[#＃]/.test(q.answer || '') || q.disputed) continue
        if (got !== q.answer) {
          bankMismatch++; totalMismatch++
          allFixes.push({
            bank, qid: q.id, year: q.roc_year, session: q.session, sourceExam: q.source_exam_code,
            subject: q.subject, num: q.number, old: q.answer, new: got, source: pdfs[0].name,
          })
          if (!dry) { q.answer = got; q.disputed = true }
          bankFix++
        }
      }
    }
    if (!dry && bankFix > 0) atomicWriteJson(fp, data)
    console.log(`[${bank}] checked=${bankChecked} mismatch=${bankMismatch}${dry ? ' (dry-run)' : ' applied'}`)
  }

  fs.writeFileSync(LOG, JSON.stringify({
    timestamp: new Date().toISOString(),
    dry, totalQs, totalChecked, totalMismatch, totalSkipped,
    samples: allFixes.slice(0, 50), full: allFixes,
  }, null, 2))

  console.log(`\n=== Total: ${totalChecked} checked, ${totalMismatch} mismatch (${totalSkipped} skipped) ===`)
  console.log(`Log: ${path.relative(BACKEND, LOG)}`)
})().catch(e => { console.error(e); process.exit(1) })
