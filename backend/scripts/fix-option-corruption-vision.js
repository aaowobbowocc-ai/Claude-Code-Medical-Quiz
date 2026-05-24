#!/usr/bin/env node
/**
 * 用 Vertex Gemini Vision 修復選項損壞的題目（scan-option-corruption.js 偵測、
 * 文字 parser 修不動的殘留題）。對每題定位 PDF 頁面 → 渲染成圖 → Gemini 讀回
 * 4 選項 → 覆蓋。
 *
 * 用法: node scripts/fix-option-corruption-vision.js [--exam=medlab,...] [--limit=N] [--apply]
 */
require('dotenv/config')
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE_DIRS = [
  path.join(BACKEND, '_tmp', 'pdf-cache'),
  path.join(BACKEND, '_tmp', 'pdf-cache-100-105'),
]
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
// MODEL: gemini-2.5-flash (changed 2026-05-23 from gemini-2.5-pro)
//   OCR / Vision 任務不需要 Pro 推理；Flash 同準確度但便宜 ~17-33 倍。
//   5/22 batch 跑 Pro thinking 一次燒 $200+，Flash 同 batch 約 $5-10。
//   若特殊題目 Flash 結果不佳，再針對該批改回 'gemini-2.5-pro'。
const VERTEX_MODEL = 'gemini-2.5-flash'
const vertexAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
const APPLY = process.argv.includes('--apply')
const argExam = process.argv.find(a => a.startsWith('--exam='))?.slice(7)
const argLimit = process.argv.find(a => a.startsWith('--limit='))?.slice(8)
const MIN_LEN = 12
const sleep = ms => new Promise(r => setTimeout(r, ms))
const norm = s => String(s || '').normalize('NFKC').replace(/[^一-鿿A-Za-z0-9]/g, '')
// 去掉 OCR 可能抄進來的選項標籤前綴：(A) / A. / A、 / Ａ：…
const stripLabel = s => String(s || '').trim().replace(/^[（(]?\s*[A-Da-d]\s*[)）.、．。:：]\s*/, '').trim()

const EXAM_FILES = {
  medlab: 'questions-medlab.json', dental1: 'questions-dental1.json', dental2: 'questions-dental2.json',
  nursing: 'questions-nursing.json', pharma1: 'questions-pharma1.json', pharma2: 'questions-pharma2.json',
  vet: 'questions-vet.json', customs: 'questions-customs.json', doctor1: 'questions.json',
  doctor2: 'questions-doctor2.json', nutrition: 'questions-nutrition.json', tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json', pt: 'questions-pt.json', ot: 'questions-ot.json',
  radiology: 'questions-radiology.json', 'social-worker': 'questions-social-worker.json',
  judicial: 'questions-judicial.json', lawyer1: 'questions-lawyer1.json', 'civil-senior': 'questions-civil-senior.json',
  police: 'questions-police.json', police4: 'questions-police4.json', audiologist: 'questions-audiologist.json',
  'speech-therapist': 'questions-speech-therapist.json', rt: 'questions-rt.json',
  'clinical-psychology': 'questions-clinical-psychology.json',
  'counseling-psychology': 'questions-counseling-psychology.json',
}

// ─── 損壞偵測 ───
function corruptKeys(o) {
  const keys = ['A', 'B', 'C', 'D']
  const bad = new Set()
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++)
    if (x !== y && o[x].length >= MIN_LEN && o[y].length === o[x].length + 1 && o[y].slice(1) === o[x]) bad.add(keys[x])
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++)
    if (o[i] && o[i].length >= MIN_LEN && o[i] === o[j]) { bad.add(keys[i]); bad.add(keys[j]) }
  return bad
}

// ─── PDF 載入 / 頁面渲染 ───
let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }
const pdfCache = {}
async function loadPdf(pdfPath) {
  if (pdfCache[pdfPath]) return pdfCache[pdfPath]
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const pages = []
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i)
    pages.push({ page, text: page.toStructuredText('preserve-whitespace').asText(), idx: i })
  }
  const result = { doc, pages, mupdf }
  pdfCache[pdfPath] = result
  return result
}

async function discoverPdf(exam, exam_code, subject, allArr) {
  const prefixed = `${exam}_${exam_code}_`
  const codeOnly = new RegExp(`^([A-Z]+_)?${exam_code}_c\\d+_s[\\w-]+\\.pdf$`)
  const qCandidates = []
  for (const dir of PDF_CACHE_DIRS) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.pdf'))) {
      if (!(f.startsWith(prefixed) || codeOnly.test(f))) continue
      if (/^(TM|TS|A|M|S)_/.test(f) && !f.startsWith(prefixed)) continue
      qCandidates.push({ dir, file: f })
    }
  }
  for (const { dir, file: f } of qCandidates) {
    const { pages, mupdf } = await loadPdf(path.join(dir, f))
    if (pages[0].text.includes(subject)) return { file: f, dir, pages, mupdf }
  }
  // fingerprint by a clean sibling question stem
  const sib = allArr.filter(q => q.exam_code === exam_code && q.subject === subject && q.question && q.question.length >= 30)
  for (const probe of [sib[Math.floor(sib.length / 2)], sib[0], sib[sib.length - 1]].filter(Boolean)) {
    const cn = (probe.question.match(/[一-鿿]+/g) || []).find(s => s.length >= 8)
    if (!cn) continue
    const snippet = cn.slice(0, 12)
    for (const { dir, file: f } of qCandidates) {
      const { pages, mupdf } = await loadPdf(path.join(dir, f))
      if (pages.some(p => p.text.includes(snippet))) return { file: f, dir, pages, mupdf }
    }
    break
  }
  return null
}

// 直接用題幹在所有同場次 PDF 裡找該題（題幹通常未損壞，比 subject 比對可靠）
async function findQuestionByStem(exam_code, stem) {
  const want = norm(stem).slice(0, 16)
  if (want.length < 10) return null
  for (const dir of PDF_CACHE_DIRS) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.pdf') || /^(TM|TS|A|M|S)_/.test(f)) continue
      if (!f.includes(`_${exam_code}_c`)) continue
      const { pages, mupdf } = await loadPdf(path.join(dir, f))
      for (let i = 0; i < pages.length; i++) {
        if (norm(pages[i].text).includes(want)) return { pages, mupdf, pageIdx: i }
      }
    }
  }
  return null
}

function findQuestionPage(pages, qnum) {
  const res = [
    new RegExp(`(?:^|\\n)\\s*${qnum}[.、．]`),
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`),
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s{2,}[^\\d]`),
  ]
  for (let i = 0; i < pages.length; i++) if (res.some(r => r.test(pages[i].text))) return i
  return -1
}

async function pageToPng(page, mupdf, dpi = 150) {
  const matrix = mupdf.Matrix.scale(dpi / 72, dpi / 72)
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
  return Buffer.from(pixmap.asPNG())
}

async function visionExtract(pngBuf, prompt) {
  const base64 = pngBuf.toString('base64')
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const token = await vertexAuth.getAccessToken()
      const body = {
        contents: [{ role: 'user', parts: [
          { inlineData: { data: base64, mimeType: 'image/png' } },
          { text: prompt },
        ] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
      }
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error?.message || JSON.stringify(data))
      const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
      const m = text.match(/\{[\s\S]*\}/)
      return m ? JSON.parse(m[0]) : null
    } catch (e) {
      if (attempt >= 2) { console.log(`    Vision 失敗: ${e.message}`); return null }
      await sleep(2000 * (attempt + 1))
    }
  }
}

const PROMPT = `這是台灣國家考試試題掃描圖。請找出題號 __QNUM__ 的單選題，抽出題幹與 A/B/C/D 四個選項。
只輸出純 JSON：{"number": __QNUM__, "question": "題幹文字", "options": {"A":"...","B":"...","C":"...","D":"..."}}
請逐字精確抄寫，不要省略選項開頭的字母或數字、不要把同一選項斷成兩段。若某選項是圖片無法辨識，填 "[圖]"。`

async function main() {
  const exams = argExam ? argExam.split(',') : Object.keys(EXAM_FILES)
  let total = 0, fixed = 0, noPdf = 0, noPage = 0, noOcr = 0, reject = 0
  for (const examId of exams) {
    const file = EXAM_FILES[examId]
    if (!file || !fs.existsSync(path.join(BACKEND, file))) continue
    const raw = JSON.parse(fs.readFileSync(path.join(BACKEND, file), 'utf8'))
    const arr = raw.questions || raw
    let targets = arr.filter(q => {
      if (!q.options) return false
      const o = ['A', 'B', 'C', 'D'].map(k => String(q.options[k] ?? '').trim())
      return corruptKeys(o).size > 0
    })
    if (argLimit) targets = targets.slice(0, parseInt(argLimit))
    if (!targets.length) continue
    console.log(`\n=== ${examId} (${targets.length} 題) ===`)
    let fileFixed = 0
    for (let i = 0; i < targets.length; i++) {
      const q = targets[i]
      total++
      process.stdout.write(`  [${i + 1}/${targets.length}] #${q.number} ${q.exam_code} ${q.subject}... `)
      // 先用 subject 比對找 PDF；找不到再用題幹直接在同場次 PDF 裡搜
      let found = await discoverPdf(examId, q.exam_code, q.subject, arr)
      let pageIdx = found ? findQuestionPage(found.pages, q.number) : -1
      if (!found || pageIdx < 0) {
        const byStem = await findQuestionByStem(q.exam_code, q.question)
        if (byStem) { found = byStem; pageIdx = byStem.pageIdx }
      }
      if (!found) { console.log('無 PDF'); noPdf++; continue }
      if (pageIdx < 0) { console.log('找不到頁'); noPage++; continue }
      const png = await pageToPng(found.pages[pageIdx].page, found.mupdf)
      const ocr = await visionExtract(png, PROMPT.replace(/__QNUM__/g, q.number))
      if (!ocr || !ocr.options) { console.log('OCR 無結果'); noOcr++; continue }
      const keys = ['A', 'B', 'C', 'D']
      const no = keys.map(k => stripLabel(ocr.options[k] ?? ''))
      if (no.some(v => !v || v === '[圖]')) { console.log('OCR 選項不完整'); reject++; continue }
      // 健全性：用「題幹」確認 OCR 抓對題（題幹通常未損壞，可靠）
      const stemDb = norm(q.question).slice(0, 14)
      const stemOcr = norm(ocr.question).slice(0, 14)
      if (stemDb.length >= 10 && stemOcr && stemDb !== stemOcr) { console.log('題幹不符，跳過'); reject++; continue }
      const o = keys.map(k => String(q.options[k] ?? '').trim())
      const bad = corruptKeys(o)
      if (APPLY) for (let k = 0; k < 4; k++) q.options[keys[k]] = no[k]
      fixed++; fileFixed++
      console.log('✓ 修正 ' + [...bad].join(','))
      if (APPLY && fileFixed % 5 === 0) fs.writeFileSync(path.join(BACKEND, file), JSON.stringify(raw, null, 2) + '\n')
    }
    if (APPLY && fileFixed) {
      fs.writeFileSync(path.join(BACKEND, file), JSON.stringify(raw, null, 2) + '\n')
      console.log(`  💾 ${file}: ${fileFixed} 修正`)
    }
  }
  console.log(`\n總計 ${total} | 修正 ${fixed} | 無PDF ${noPdf} | 找不到頁 ${noPage} | OCR無結果 ${noOcr} | 拒絕 ${reject}`)
  console.log(APPLY ? '(已套用)' : '(dry-run)')
}
main().catch(e => { console.error(e); process.exit(1) })
