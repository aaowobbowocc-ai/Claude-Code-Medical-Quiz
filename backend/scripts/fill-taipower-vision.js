#!/usr/bin/env node
/**
 * 經濟部國營聯招 100-103 年 Vision OCR 補題
 *
 * 100-102：試題科目A 為掃描圖檔（無文字層）→ mupdf 轉 PNG → Vertex Gemini 辨識；
 *          答案取自「解答科目A」文字答案表（1.(D) 2.(A) …，含「(A或C)」更正）。
 * 103    ：試題第 4 頁為圖檔 → OCR「解答科目A」（影像含 [X] 答案標記）補 Q41-50；
 *          共同英文補末段缺題。
 *
 * 缺題才補（merge-missing），不動既有 103-114 資料。
 *
 * Usage:
 *   node scripts/fill-taipower-vision.js              # dry-run
 *   node scripts/fill-taipower-vision.js --year 100
 *   node scripts/fill-taipower-vision.js --apply
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const { GoogleAuth } = require('google-auth-library')
const pdfParse = require('pdf-parse')
const { cachedFetch } = require('./lib/pdf-fetcher')
const { atomicWriteJson, withLock } = require('./lib/atomic-write')

const ROOT = path.resolve(__dirname, '..')
const CACHE_DIR = path.join(ROOT, '_tmp', 'taipower-cache')
const LIST = 'https://www.taipower.com.tw/2289/2544/2554/2556/'
const REFERER = LIST
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const VERTEX_MODEL = 'gemini-2.5-flash'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const APPLY = process.argv.includes('--apply')
const YEAR_FILTER = process.argv.find((_, i) => process.argv[i - 1] === '--year') || null

const YEAR_QATTR = { '100': 556, '101': 557, '102': 558, '103': 559 }

const CATS = {
  '共同科目': { kind: 'bank', tag: 'state_english', maxQ: 40 },
  '企管': { kind: 'exam', examId: 'state-mgmt', tag: 'state_mgmt', maxQ: 50, subjectName: '企業概論、法學緒論' },
  '人資': { kind: 'exam', examId: 'state-hr', tag: 'state_hr', maxQ: 50, subjectName: '企業管理、法學緒論' },
  '財會': { kind: 'exam', examId: 'state-finance', tag: 'state_finance', maxQ: 50, subjectName: '政府採購法規、會計審計法規' },
  '資訊': { kind: 'exam', examId: 'state-it', tag: 'state_it', maxQ: 50, subjectName: '計算機原理、網路概論' },
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, 'Referer': 'https://www.taipower.com.tw/' } }, res => {
      const cs = []; res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs).toString('utf-8')))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// 取某年度 q_attribute 頁的所有下載連結 {url, title}
async function yearLinks(year) {
  const html = await fetchHtml(`${LIST}?Page=1&PageSize=300&q_attribute=${YEAR_QATTR[year]}`)
  return [...html.matchAll(/<a[^>]+href="(\/media\/[^"]+)"[^>]*title="([^"]+)"/g)]
    .map(m => ({ url: 'https://www.taipower.com.tw' + m[1], title: m[2].replace(/（另開新視窗）\s*$/, '').trim() }))
}

// 解析「解答科目A」文字答案表：1.(D) 2.(A) … 33.(A或C)
function parseAnswerKey(text) {
  const ans = {}, disputed = new Set()
  const re = /(\d{1,3})\s*[.．、]\s*[（(]\s*([A-D])\s*(?:或\s*([A-D])\s*)?[）)]/g
  let m
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10)
    ans[n] = m[2]
    if (m[3]) disputed.add(n)
  }
  return { ans, disputed }
}

async function geminiRequest(body) {
  const tk = await auth.getAccessToken()
  const token = typeof tk === 'string' ? tk : tk.token
  const pathStr = `/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}` +
    `/publishers/google/models/${VERTEX_MODEL}:generateContent`
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: `${VERTEX_REGION}-aiplatform.googleapis.com`, path: pathStr, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(data) },
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`))
        try { resolve(JSON.parse(text)) } catch { reject(new Error('bad JSON')) }
      })
    })
    req.on('error', reject)
    req.write(data); req.end()
  })
}

async function visionExtract(png) {
  const prompt = `This is a scan of a Taiwan state-enterprise joint recruitment exam page (經濟部國營事業聯招，繁體中文，可能含英文題).
Extract every single-choice (單選) question fully visible on this page.
Return STRICT JSON array (no prose, no markdown fence):
[{"number":<int>,"question":"<stem>","options":{"A":"..","B":"..","C":"..","D":".."},"answer":"<A-D or empty>","case_context":"<shared passage or empty>"}]
Rules:
- Only numbered single-choice questions. Skip 國文作文/論文寫作 essay parts.
- Options labelled (A)(B)(C)(D); map them to A/B/C/D. Keep traditional Chinese & English exactly, do NOT translate.
- The leading number of each item is "number"; do not include it in "question".
- If a bracketed marker like [A] or [A或D] or [送分] appears before the question number, put the (first) answer letter in "answer"; otherwise leave "answer" empty.
- For 克漏字/閱讀測驗 passage-grouped questions, put the shared passage in "case_context" (same passage repeated for each question of the group); else "case_context" empty.
- If a question is unreadable or truncated, omit it. Do not invent.
- Return ONLY the JSON array.`
  const body = {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: 'image/png', data: png.toString('base64') } },
      { text: prompt },
    ] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  }
  const resp = await geminiRequest(body)
  const raw = (resp.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  if (!cleaned) return []
  try { const j = JSON.parse(cleaned); return Array.isArray(j) ? j : [] }
  catch { console.warn('  [parse-fail]', cleaned.slice(0, 150)); return [] }
}

function validQ(q, maxQ) {
  if (!q || typeof q.number !== 'number' || q.number < 1 || q.number > maxQ) return false
  if (typeof q.question !== 'string' || q.question.length < 5) return false
  if (!q.options) return false
  for (const L of ['A', 'B', 'C', 'D']) if (typeof q.options[L] !== 'string' || !q.options[L].trim()) return false
  return true
}

// OCR 答案表圖檔（或含 [X] 標記的試題圖）→ { ans:{num:letter}, disputed:Set }
async function ocrAnswerKey(mupdf, buf, maxQ) {
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const ans = {}, disputed = new Set()
  const prompt = `This image is a Taiwan exam ANSWER KEY (答案表), or an exam paper with bracketed [X] answer markers before each question number.
Extract the answer for every question visible. Return STRICT JSON array (no prose, no markdown fence):
[{"number":<int>,"answer":"<A-D or empty>","disputed":<true/false>}]
- "(A或C)" / "[A或D]" / multiple letters → answer = first letter, disputed = true.
- 送分/一律給分 with no letter → answer = "", disputed = true.
- Return ONLY the JSON array.`
  for (let i = 0; i < doc.countPages(); i++) {
    const px = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(2.2, 2.2), mupdf.ColorSpace.DeviceRGB, false, true)
    const png = Buffer.from(px.asPNG())
    const resp = await geminiRequest({
      contents: [{ role: 'user', parts: [
        { inline_data: { mime_type: 'image/png', data: png.toString('base64') } },
        { text: prompt },
      ] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    })
    const raw = (resp.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    let arr = []
    try { arr = JSON.parse(cleaned) } catch { /* skip page */ }
    for (const r of (Array.isArray(arr) ? arr : [])) {
      const n = parseInt(r.number, 10)
      if (!(n >= 1 && n <= maxQ)) continue
      const L = (r.answer || '').match(/[A-D]/)?.[0]
      if (L) ans[n] = L
      if (r.disputed) disputed.add(n)
    }
    await sleep(800)
  }
  return { ans, disputed }
}

// OCR 一份 PDF（指定頁）→ Map<number, q>
async function ocrPdf(mupdf, buf, maxQ, pages) {
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const found = new Map()
  const pageCount = doc.countPages()
  for (let i = 0; i < pageCount; i++) {
    if (pages && !pages.includes(i)) continue
    const px = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(2.2, 2.2), mupdf.ColorSpace.DeviceRGB, false, true)
    const qs = await visionExtract(Buffer.from(px.asPNG()))
    for (const q of qs) {
      if (!validQ(q, maxQ)) continue
      if (!found.has(q.number)) found.set(q.number, q)
    }
    await sleep(800)
  }
  return found
}

async function main() {
  const mupdf = await import('mupdf')
  const years = Object.keys(YEAR_QATTR).filter(y => !YEAR_FILTER || y === YEAR_FILTER)

  // 載入要寫入的檔案
  const fileCache = {}
  const loadFile = (rel, isBank) => {
    if (fileCache[rel]) return fileCache[rel]
    const fp = isBank ? path.join(ROOT, 'shared-banks', rel) : path.join(ROOT, rel)
    fileCache[rel] = { fp, data: JSON.parse(fs.readFileSync(fp, 'utf-8')) }
    return fileCache[rel]
  }

  let grandAdded = 0
  for (const year of years) {
    const links = await yearLinks(year)
    console.log(`\n══ ${year} 年 (q_attribute=${YEAR_QATTR[year]}, ${links.length} 連結) ══`)
    const mode = year === '103' ? 'B' : 'A'
    const pages = year === '103' ? [2, 3] : null   // 103 只 OCR 後兩頁

    for (const [catName, cat] of Object.entries(CATS)) {
      const inCat = (t) => catName === '共同科目' ? /共同/.test(t) : t.includes(catName)
      const isB = (t) => /科目\s*[Bb]/.test(t)
      const qFile = links.find(l => inCat(l.title) && /試題科目/.test(l.title) && !isB(l.title))
      const keyFile = links.find(l => inCat(l.title) && /解答/.test(l.title) && !isB(l.title))

      // mode A：OCR 試題、答案取自 keyFile 文字表；mode B：OCR keyFile（含 [X]）
      const ocrTarget = mode === 'B' ? (keyFile || qFile) : qFile
      if (!ocrTarget) { console.log(`  ${catName}: 找不到試題檔`); continue }

      // 既有題號
      const isBank = cat.kind === 'bank'
      const rel = isBank ? 'common_state_english.json' : `questions-state-${cat.examId.replace('state-', '')}.json`
      const { data } = loadFile(rel, isBank)
      const list = data.questions
      const have = new Set(list.filter(q => q.roc_year === year &&
        (isBank ? true : q.subject_tag === cat.tag)).map(q => q.number))
      const missing = []
      for (let i = 1; i <= cat.maxQ; i++) if (!have.has(i)) missing.push(i)
      if (!missing.length) { console.log(`  ${catName}: 已滿`); continue }

      // 答案來源（mode A）：解答檔先試文字解析，失敗（掃描圖檔）→ OCR 答案表
      let answers = {}, disputedSet = new Set()
      if (mode === 'A' && keyFile) {
        try {
          const kbuf = await cachedFetch(keyFile.url, CACHE_DIR, { referer: REFERER, timeout: 40000 })
          const parsed = parseAnswerKey((await pdfParse(kbuf)).text)
          if (Object.keys(parsed.ans).length >= 5) {
            answers = parsed.ans; disputedSet = parsed.disputed
          } else {
            const oc = await ocrAnswerKey(mupdf, kbuf, cat.maxQ)
            answers = oc.ans; disputedSet = oc.disputed
          }
        } catch (e) { console.log(`  ${catName}: 答案表讀取失敗 ${e.message}`) }
      }

      // OCR
      let qbuf
      try { qbuf = await cachedFetch(ocrTarget.url, CACHE_DIR, { referer: REFERER, timeout: 60000 }) }
      catch (e) { console.log(`  ${catName}: 試題下載失敗 ${e.message}`); continue }
      const found = await ocrPdf(mupdf, qbuf, cat.maxQ, pages)

      // 合併缺題
      let added = 0
      for (const num of missing) {
        const q = found.get(num)
        if (!q) continue
        const vAns = (q.answer || '').match(/[A-D]/)?.[0] || null
        const ans = answers[num] || vAns
        if (!ans) { continue }
        const disputed = disputedSet.has(num) || /或|送分/.test(q.answer || '')
        const opts = { A: q.options.A.trim(), B: q.options.B.trim(), C: q.options.C.trim(), D: q.options.D.trim() }
        const ctx = (q.case_context && q.case_context.trim()) || null
        if (isBank) {
          list.push({
            id: `common_state_english-${year}-${num}`, roc_year: year, session: '第一次',
            source_exam_code: 'taipower', source_exam_name: `${year} 年經濟部國營事業聯招`,
            subject: '英文', subject_tags: ['state_english'], number: num,
            question: q.question.trim(), options: opts, answer: ans,
            case_context: ctx, level: 'state', shared_bank: 'common_state_english',
            parent_id: null, is_deprecated: false, deprecated_reason: null,
            ...(disputed ? { disputed: true } : {}),
          })
        } else {
          list.push({
            id: `${cat.examId}-${year}-${num}`, roc_year: year, session: '第一次',
            exam_code: `taipower-${year}`, subject: '專業科目', subject_tag: cat.tag,
            subject_name: cat.subjectName, stage_id: 0, number: num,
            question: q.question.trim(), options: opts, answer: ans, explanation: '',
            ...(disputed ? { disputed: true } : {}),
            ...(ctx ? { case_context: ctx } : {}),
          })
        }
        added++; grandAdded++
      }
      console.log(`  ${catName}: 缺 ${missing.length}、OCR 得 ${found.size}、補入 ${added}`)
    }
  }

  if (APPLY) {
    for (const { fp, data } of Object.values(fileCache)) {
      if (data.total !== undefined) data.total = data.questions.length
      if (data.bankVersion !== undefined) {
        data.bankVersion = (Number(data.bankVersion) || 0) + 1
        data.last_synced_at = new Date().toISOString()
      }
      // 題目依年份、題號排序，維持卷面順序
      data.questions.sort((a, b) =>
        String(a.roc_year).localeCompare(String(b.roc_year)) || (a.number || 0) - (b.number || 0))
      withLock(fp, () => atomicWriteJson(fp, data))
      console.log(`✅ 寫入 ${path.basename(fp)}（${data.questions.length} 題）`)
    }
  }
  console.log(`\n${APPLY ? '✅ 已套用' : '(dry-run，加 --apply 寫入)'} 總計 +${grandAdded} 題`)
}

main().catch(e => { console.error(e); process.exit(1) })
