#!/usr/bin/env node
/**
 * 用 Vertex Vision OCR 重新抽全站答案 PDF，跟現有 q.answer 比對。
 * 不一致的標 disputed + 紀錄差異 log，由人類確認後再決定是否覆寫。
 *
 * 步驟：
 * 1. 對每個 (exam, exam_code, c, s) 組合（一張答案 PDF 對應一組）：
 *    - 先 lookup PDF in cache; 找不到就跳過（不重抓 MoEX，避免 rate limit）
 *    - Render 答案 PDF page 1 為 PNG
 *    - Vertex Pro Vision: 抽出 Q1-Q100 答案 JSON
 *    - 對應該組所有題目，比對 q.answer
 * 2. 不一致：紀錄到 backend/_tmp/answer-recheck-log.json
 *    - 不直接改 JSON，等使用者批准
 *
 * Usage:
 *   node scripts/vision-recheck-answers.js [--exam X] [--limit N] [--apply]
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')
const { atomicWriteJson } = require('./lib/atomic-write')

const BACKEND = path.resolve(__dirname, '..')
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
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const args = process.argv.slice(2)
const examFilter = args.indexOf('--exam') >= 0 ? args[args.indexOf('--exam') + 1] : null
const limit = args.indexOf('--limit') >= 0 ? parseInt(args[args.indexOf('--limit') + 1]) : 0
const apply = args.includes('--apply')

const EXPECTED_KLASS = {
  doctor1: '醫師', doctor2: '醫師',
  dental1: '牙醫師', dental2: '牙醫師',
  pharma1: '藥師', pharma2: '藥師',
  medlab: '醫事檢驗師', radiology: '醫事放射師',
  pt: '物理治療師', ot: '職能治療師',
  nursing: '護理師', nutrition: '營養師',
  tcm1: '中醫師', tcm2: '中醫師',
  vet: '獸醫師',
  audiologist: '聽力師',
  'speech-therapist': '語言治療師',
  rt: '呼吸治療師',
  'social-worker': '社會工作師',
  customs: '關務', police: '警察', police4: '警察',
  judicial: '司法', 'civil-senior': '高考', lawyer1: '律師',
}

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
  rt: 'questions-rt.json',
}

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

// 從 cache 找答案 PDF（命名: A_*, S_*, 或 *_S.pdf）
function findAnswerPdf(exam_code, c, s) {
  const patterns = [
    new RegExp(`^A_${exam_code}_c${c}_s${s}\\.pdf$`),
    new RegExp(`^${exam_code}_c${c}_s${s}_S\\.pdf$`),
    new RegExp(`^[A-Za-z\\-_]+_A_${exam_code}_c${c}_s${s}\\.pdf$`),
    new RegExp(`^[A-Za-z\\-_]+_${exam_code}_c${c}_s${s}_S\\.pdf$`),
  ]
  for (const dir of PDF_CACHE_DIRS) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      for (const re of patterns) {
        if (re.test(f)) return path.join(dir, f)
      }
    }
  }
  return null
}

// 從合併答案 PDF 抽出 { subject: { qnum: answer } } 字典
// expectedKlass: 期待的類科名稱（如 "醫師"），若 PDF 首頁類科不符整份跳過
async function visionExtractCombined(pdfPath, expectedKlass) {
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  const subjectAnswers = {}

  // 先檢查所有 page 的類科 — 若沒有任一 page 提到 expectedKlass，整份跳過
  if (expectedKlass) {
    let anyMatch = false
    for (let i = 0; i < n; i++) {
      const t = doc.loadPage(i).toStructuredText('preserve-whitespace').asText().normalize('NFKC')
      const klass = t.match(/類\s*科[：:名稱]*\s*([^\s\n（(]{2,15})/)?.[1] || ''
      if (klass.includes(expectedKlass)) { anyMatch = true; break }
    }
    if (!anyMatch) return {}
  }

  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i)
    const text = page.toStructuredText('preserve-whitespace').asText().normalize('NFKC')
    // 該頁類科要符合期待
    const pageKlass = text.match(/類\s*科[：:名稱]*\s*([^\s\n（(]{2,15})/)?.[1] || ''
    if (expectedKlass && !pageKlass.includes(expectedKlass)) continue
    // 抓該頁科目 — 跳過 NFKC 後的全形括號，直接抓「主科目+編號括號」
    // PDF 文字: "科目名稱:醫學(一)(包括解剖學...)" → 抓 "醫學(一)"
    let subj = ''
    // 優先抓「主科目+(一/二/三/四/五/六/七/八)」
    const ordinalMatch = text.match(/科\s*目\s*名稱[：:\s]*\n?\s*([^\s\n]+?[(（][一二三四五六七八九十][)）])/)
    if (ordinalMatch) {
      subj = ordinalMatch[1].trim()
    } else {
      // 沒有 ordinal 的科目（如「呼吸疾病學」、「公共衛生營養學」）
      // 抓 「科目名稱:」 後到「(」前
      const plain = text.match(/科\s*目\s*名稱[：:\s]*\n?\s*([^\n(（]+?)(?:[(（]|每\s*題|題\s*數|\n)/)
      if (plain) subj = plain[1].trim()
    }
    if (!subj || subj.length < 2) continue
    // 渲染為 PNG + Vision 抽答案
    const px = page.toPixmap(mupdf.Matrix.scale(2.0, 2.0), mupdf.ColorSpace.DeviceRGB, false, true)
    const png = Buffer.from(px.asPNG())
    const ans = await visionExtractSinglePage(png)
    if (Object.keys(ans).length > 0) subjectAnswers[subj] = ans
  }
  return subjectAnswers
}

async function visionExtractSinglePage(png) {

  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const prompt = `這是台灣國考的「測驗式試題標準答案」PDF 截圖（單一科目）。
扁平輸出 — {"題號": "答案"} 形式。
題號為字串（"1", "2"），答案為單一字元 A/B/C/D。
若多選題照原樣輸出（"AC" 等）。若以 # 標記更正答案，用更正後的。
範例：{"1":"A","2":"B","3":"C",...}
不要解釋，不要 markdown code fence，只輸出 JSON。`
  const parts = [
    { inlineData: { data: png.toString('base64'), mimeType: 'image/png' } },
    { text: prompt },
  ]
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.0, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } },
        }),
      })
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, Math.min(60000, 3000 * 2 ** attempt)))
        continue
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return {}
      try {
        const parsed = JSON.parse(m[0])
        // Flatten nested { 試題代號: { qnum: answer } }
        const flat = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'object' && v !== null) {
            for (const [qk, qv] of Object.entries(v)) {
              flat[qk] = qv
            }
          } else if (typeof v === 'string' && v.length <= 3) {
            flat[k] = v
          }
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

async function processExam(exam) {
  const file = EXAM_FILES[exam]
  if (!file) return { total: 0, mismatch: 0 }
  const fp = path.join(BACKEND, file)
  if (!fs.existsSync(fp)) return { total: 0, mismatch: 0 }
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data

  // 找出 cache 裡所有 answer PDF，提取 (exam_code, c, s)
  const answerPdfs = []
  for (const dir of PDF_CACHE_DIRS) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      // Match: A_<code>_c<c>_s<s>.pdf  OR  <prefix>_<code>_c<c>_s<s>_S.pdf
      let m = f.match(/^A_(\d{6})_c(\d+)_s([\w-]+)\.pdf$/)
      if (!m) m = f.match(/^[A-Za-z\-_]+_A_(\d{6})_c(\d+)_s([\w-]+)\.pdf$/)
      if (!m) m = f.match(/^[A-Za-z\-_]+_(\d{6})_c(\d+)_s([\w-]+)_S\.pdf$/)
      if (!m) continue
      const [, exam_code, c, s] = m
      answerPdfs.push({ path: path.join(dir, f), exam_code, c, s })
    }
  }

  // 只保留有 question 對應的 exam_code 的 PDF
  const examCodes = new Set(arr.map(q => q.exam_code).filter(Boolean))
  const filtered = answerPdfs.filter(p => examCodes.has(p.exam_code))
  // 同 PDF 不重複處理
  const uniquePdfs = new Map()
  for (const pdf of filtered) {
    if (!uniquePdfs.has(pdf.path)) uniquePdfs.set(pdf.path, pdf)
  }
  console.log(`\n[${exam}] ${uniquePdfs.size} unique answer PDFs (filtered from ${answerPdfs.length} total)`)

  const targets = limit > 0 ? [...uniquePdfs.values()].slice(0, limit) : [...uniquePdfs.values()]

  const log = []
  let visionCalls = 0
  let totalChecked = 0
  let totalMismatch = 0
  const norm = s => (s || '').normalize('NFKC').replace(/\s/g, '')

  for (const pdf of targets) {
    const ansPdf = pdf.path

    process.stdout.write(`  ${path.basename(ansPdf)}: `)
    const subjectAnswers = await visionExtractCombined(ansPdf, EXPECTED_KLASS[exam])
    visionCalls += Object.keys(subjectAnswers).length
    process.stdout.write(`${Object.keys(subjectAnswers).length} subjects, `)

    let pdfMismatch = 0
    let pdfChecked = 0
    for (const [pdfSubj, ans] of Object.entries(subjectAnswers)) {
      // 嚴格 subject 匹配：normalize 後完全相同（or 一方為另一方前綴且夠長）
      const matched = arr.filter(q => {
        if (q.exam_code !== pdf.exam_code) return false
        const qS = norm(q.subject)
        const pS = norm(pdfSubj)
        if (!qS || !pS) return false
        if (qS === pS) return true
        // 允許 q.subject 是 pdfSubj 的後綴（少數 PDF 帶前綴）
        if (qS.length >= 4 && pS.endsWith(qS)) return true
        if (pS.length >= 4 && qS.endsWith(pS)) return true
        return false
      })
      if (matched.length === 0) continue
      for (const q of matched) {
        const correctAns = ans[String(q.number)] || ans[q.number]
        if (!correctAns) continue
        pdfChecked++
        totalChecked++
        if (correctAns.length === 1 && correctAns !== q.answer) {
          pdfMismatch++
          totalMismatch++
          log.push({
            examId: exam, qid: q.id, year: q.roc_year, session: q.session,
            subject: q.subject, num: q.number,
            old: q.answer, new: correctAns, source: path.basename(ansPdf),
            pdfSubj,
          })
          if (apply) {
            q.answer = correctAns
            q.disputed = true
          }
        }
      }
    }
    process.stdout.write(`${pdfChecked} checked, ${pdfMismatch} mismatch\n`)
  }

  if (apply && totalMismatch > 0) atomicWriteJson(fp, data)
  return { total: totalChecked, mismatch: totalMismatch, log, visionCalls }
}

;(async () => {
  await getMupdf()
  const exams = examFilter ? [examFilter] : Object.keys(EXAM_FILES)
  let total = 0, totalMismatch = 0, totalVision = 0
  const allLog = []
  for (const e of exams) {
    if (e === 'pt' || e === 'ot') continue
    const r = await processExam(e)
    total += r.total
    totalMismatch += r.mismatch
    totalVision += r.visionCalls
    allLog.push(...(r.log || []))
  }
  fs.writeFileSync(path.join(BACKEND, '_tmp', 'answer-recheck-log.json'), JSON.stringify({
    checked: total, mismatch: totalMismatch, vision_calls: totalVision,
    samples: allLog.slice(0, 50),
    full: allLog,
  }, null, 2))
  console.log(`\n=== 總計 ${total} 題比對，${totalMismatch} 不一致 (${(totalMismatch/total*100).toFixed(1)}%)，${totalVision} 次 Vision 呼叫 ===`)
  console.log(`Log: backend/_tmp/answer-recheck-log.json`)
  if (!apply) console.log(`Dry-run only. 確認後加 --apply 套用變更`)
})().catch(e => { console.error(e); process.exit(1) })
