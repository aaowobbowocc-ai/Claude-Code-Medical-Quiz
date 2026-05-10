#!/usr/bin/env node
/**
 * Vision-recheck v2 — question-driven 答案重抽
 *
 * 設計理念：
 * - v1 從 cache 掃 PDF + 用 exam_code filter，但 exam_code 可能跨考試重用
 *   （e.g. 103100 doctor1 用、audiologist 也用），結果掃到別考的 PDF
 *   被類科檢查擋掉 → 大半時間花在「跳過」而非比對。
 * - v2 反過來做：對每題 question，從 metadata index 找出對應的答案 PDF，
 *   保證每題都會被檢查。每張 PDF 只 Vision OCR 一次（80 題分攤）。
 *
 * 三階段：
 *   1) 建 PDF metadata index（一次）— 讀每張 PDF 第一頁取 (klass, subject)
 *   2) 對 target exam 的 questions group by (exam_code, subject) → 找 PDF
 *   3) Vision OCR per PDF（cached）→ 比對 → log mismatch
 *
 * Cache 檔：
 *   _tmp/pdf-metadata-cache.json   — basename → {klass, subject, pages}
 *   _tmp/vision-ocr-cache.json     — basename → {qnum → answer}
 *   _tmp/vision-recheck-v2-log.json — 比對結果
 *
 * Usage:
 *   node scripts/vision-recheck-v2.js --build-index           # 只建 index
 *   node scripts/vision-recheck-v2.js --exam doctor1          # dry-run
 *   node scripts/vision-recheck-v2.js --exam doctor1 --apply  # 套用變更
 *   node scripts/vision-recheck-v2.js --all --apply           # 全站
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
const META_CACHE = path.join(BACKEND, '_tmp', 'pdf-metadata-cache.json')
const OCR_CACHE = path.join(BACKEND, '_tmp', 'vision-ocr-cache.json')
const LOG_FILE = path.join(BACKEND, '_tmp', 'vision-recheck-v2-log.json')

const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const VERTEX_MODEL = 'gemini-2.5-pro'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const args = process.argv.slice(2)
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i+1] : null }
const examFilter = argVal('--exam')
const limit = parseInt(argVal('--limit') || '0')
const apply = args.includes('--apply')
const buildIndexOnly = args.includes('--build-index')
const all = args.includes('--all')
const dryRunForce = args.includes('--dry')

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
  'social-worker': 'questions-social-worker.json',
}

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

function loadJsonOr(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return def }
}

const norm = s => (s || '').normalize('NFKC').replace(/\s/g, '')

// ---------- Phase 1: PDF metadata index ----------

// 從檔名抽出 (examPrefix, exam_code, c, s)。回傳 null 表示不是答案 PDF。
// 接受的命名:
//   A_<code>_c<c>_s<s>.pdf                  — 合併答案
//   S_<code>_c<c>_s<s>.pdf                  — 標準答案
//   M_<code>_c<c>_s<s>.pdf                  — 更正答案
//   TS_<code>_c<c>_s<s>.pdf                 — 測驗式標準答案（同 S_）
//   TM_<code>_c<c>_s<s>.pdf                 — 測驗式更正答案
//   TS_<prefix>_<code>_c<c>_s<s>.pdf        — 帶考試前綴
//   TM_<prefix>_<code>_c<c>_s<s>.pdf
//   <prefix>_<code>_c<c>_s<s>_S.pdf         — _S 後綴
//   <prefix>_A_<code>_c<c>_s<s>.pdf         — _A_ 中綴
//
// 排除：Q_*（題目 PDF，非答案）
function parseAnswerPdfName(name) {
  let m
  if (/^Q_/.test(name)) return null
  // TS_<prefix>_<code>... 或 TM_<prefix>_<code>...
  if ((m = name.match(/^(TS|TM)_([A-Za-z][A-Za-z0-9\-]+)_(\d{6})_c(\d+)_s([\w-]+)\.pdf$/))) {
    return { kind: m[1], examPrefix: m[2], exam_code: m[3], c: m[4], s: m[5] }
  }
  // TS_<code>... 或 TM_<code>...（無 exam prefix）
  if ((m = name.match(/^(TS|TM)_(\d{6})_c(\d+)_s([\w-]+)\.pdf$/))) {
    return { kind: m[1], examPrefix: null, exam_code: m[2], c: m[3], s: m[4] }
  }
  // A_<prefix>_<code>... / S_<prefix>_<code>... / M_<prefix>_<code>...
  if ((m = name.match(/^([ASM])_([A-Za-z][A-Za-z0-9\-]+)_(\d{6})_c(\d+)_s([\w-]+)\.pdf$/))) {
    return { kind: m[1], examPrefix: m[2], exam_code: m[3], c: m[4], s: m[5] }
  }
  // A_/S_/M_<code>...
  if ((m = name.match(/^([ASM])_(\d{6})_c(\d+)_s([\w-]+)\.pdf$/))) {
    return { kind: m[1], examPrefix: null, exam_code: m[2], c: m[3], s: m[4] }
  }
  // <prefix>_<code>_..._S.pdf
  if ((m = name.match(/^([A-Za-z][A-Za-z0-9\-]+)_(\d{6})_c(\d+)_s([\w-]+)_S\.pdf$/))) {
    return { kind: 'S-suffix', examPrefix: m[1], exam_code: m[2], c: m[3], s: m[4] }
  }
  // <prefix>_A_<code>_... / <prefix>_S_<code>_... / <prefix>_M_<code>_...
  if ((m = name.match(/^([A-Za-z][A-Za-z0-9\-]+)_([ASM])_(\d{6})_c(\d+)_s([\w-]+)\.pdf$/))) {
    return { kind: m[2], examPrefix: m[1], exam_code: m[3], c: m[4], s: m[5] }
  }
  return null
}

const KLASS_KEYWORDS = ['醫師','藥師','護理師','營養師','物理治療師','職能治療師','醫事檢驗師','醫事放射師','社會工作師','社工師','聽力師','語言治療師','呼吸治療師','獸醫師','牙體技術師','心理師','法醫師']

// 從一頁文字抽 (klass, subject)。處理多種格式：
//   A) 「類科名稱:醫師(一)」「科目名稱:醫學(一)」 — 同一行有值
//   B) 「類科名稱:」空 + 換行 + 「100年第一次...」 — 後綴是title不是klass
//      → 掃整頁找獨立的「醫師(一)」「聽力師」等片語
//   C) 「考試名稱: 聽力師」「科目名稱:\n聽覺輔具原理與實務學」— 多行
function extractKlassSubject(text) {
  // klass 必須是已知考試名稱（可帶 (一)/(二) 後綴）
  const klassEndPat = new RegExp(`^(?:[一-鿿]{1,4})?(?:${KLASS_KEYWORDS.join('|')})(?:[(（][一二三四五六七八九十][)）])?$`)
  function validKlass(s) {
    if (!s) return false
    s = s.trim()
    if (/^\d|^第|^年|標準|答案|科目|題數|備註|考試/.test(s)) return false
    if (s.length > 15) return false
    return klassEndPat.test(s)
  }
  let klass = ''
  // (A) 類科名稱:後緊跟值
  const k1 = text.match(/類\s*科\s*名稱\s*[：:]\s*([^\s\n（(]{2,15}(?:[(（][^)）]+[)）])?)/)
  if (k1 && validKlass(k1[1])) klass = k1[1].trim()
  // (C) 考試名稱:聽力師
  if (!klass) {
    const k2 = text.match(/考\s*試\s*名稱\s*[：:]\s*\n?\s*([^\s\n（(]{2,15})/)
    if (k2 && validKlass(k2[1])) klass = k2[1].trim()
  }
  // (B) 整頁掃描關鍵字
  if (!klass) {
    const pat = new RegExp(`(?:^|\\n|\\s)((?:[一-鿿]{1,4})?(?:${KLASS_KEYWORDS.join('|')})(?:[(（][一二三四五六七八九十][)）])?)`, 'g')
    let m
    while ((m = pat.exec(text))) {
      const cand = m[1].trim()
      if (validKlass(cand)) { klass = cand; break }
    }
  }

  // subject — 多回合
  let subj = ''
  // (A) 科目名稱:後緊跟值（含 ordinal）
  const s1 = text.match(/科\s*目\s*名稱\s*[：:]\s*([^\s\n]+?[(（][一二三四五六七八九十][)）])/)
  if (s1) subj = s1[1].trim()
  // (A') 緊跟一般科目（無 ordinal）
  if (!subj) {
    const s2 = text.match(/科\s*目\s*名稱\s*[：:]\s*([^\n(（]+?)(?:[(（]|每\s*題|題\s*數|\n)/)
    if (s2 && s2[1].trim().length >= 2) subj = s2[1].trim()
  }
  // (C) 「科目名稱:」空 + 換行 + 真值
  if (!subj) {
    const s3 = text.match(/科\s*目\s*名稱\s*[：:]\s*\n+\s*([^\n（(]+?)(?:[(（]|\n)/)
    if (s3 && s3[1].trim().length >= 2) subj = s3[1].trim()
  }
  return { klass, subject: subj }
}

// 從 PDF 抽出每頁的 (klass, subject) — 一張 PDF 可能含多個考試科目
async function extractMetaFromPdf(pdfPath) {
  try {
    const mupdf = await getMupdf()
    const buf = fs.readFileSync(pdfPath)
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const n = doc.countPages()
    if (n === 0) return null
    const sections = []
    for (let i = 0; i < n; i++) {
      let text = ''
      try { text = doc.loadPage(i).toStructuredText('preserve-whitespace').asText().normalize('NFKC') } catch { continue }
      // 同頁科目數（>1 表示是 combined 答案表，OCR 階段會跳過）
      const subjectHeaders = (text.match(/科\s*目\s*名稱\s*[：:]/g) || []).length
      // 對 combined page 抽出所有 (klass, subject) 對 — 由 klass+subject 順序對應
      if (subjectHeaders > 1) {
        // 抽全部 subject 跟 klass
        const subjMatches = [...text.matchAll(/科\s*目\s*名稱\s*[：:]\s*([^\s\n]+?[(（][一二三四五六七八九十][)）])/g)].map(m => m[1])
        const klassMatches = [...text.matchAll(/類\s*科\s*名稱\s*[：:]\s*([^\s\n（(]{2,15}(?:[(（][^)）]+[)）])?)/g)].map(m => m[1])
        const len = Math.min(subjMatches.length, klassMatches.length)
        for (let k = 0; k < len; k++) {
          sections.push({ page: i, klass: klassMatches[k], subject: subjMatches[k], multi: true })
        }
        if (len === 0) {
          // 抓不到配對，先記一個空 section
          sections.push({ page: i, klass: '', subject: '', multi: true })
        }
        continue
      }
      sections.push({ page: i, ...extractKlassSubject(text) })
    }
    return { sections, pages: n }
  } catch (e) {
    return { error: e.message }
  }
}

async function buildMetadataIndex() {
  const cache = loadJsonOr(META_CACHE, {})
  let processed = 0, added = 0, errors = 0
  for (const dir of PDF_CACHE_DIRS) {
    if (!fs.existsSync(dir)) continue
    const files = fs.readdirSync(dir)
    for (const f of files) {
      if (cache[f] !== undefined) continue
      const parsed = parseAnswerPdfName(f)
      if (!parsed) { cache[f] = { skipped: 'not-answer-pdf' }; continue }
      const meta = await extractMetaFromPdf(path.join(dir, f))
      if (!meta) { cache[f] = { skipped: 'pdf-load-failed' }; continue }
      cache[f] = { ...parsed, ...meta }
      added++
      if (meta.error) errors++
      processed++
      if (processed % 50 === 0) {
        process.stdout.write(`  index: ${processed} processed, ${added} added (errors=${errors})\r`)
        atomicWriteJson(META_CACHE, cache)
      }
    }
  }
  atomicWriteJson(META_CACHE, cache)
  console.log(`\n  index: built. total entries: ${Object.keys(cache).length}, added this run: ${added}, errors: ${errors}`)
  return cache
}

// ---------- Phase 2: Find PDF for each question group ----------

// klass 嚴格匹配：考試 expected klass 是 PDF section klass 的「乾淨前綴」
// — 即 PDF klass 開頭等於 expected，且後接 "(", "（", " ", "" 之一（避免 "醫師" 匹配 "牙醫師"）
function klassStrictMatch(pdfKlass, expectedKlass) {
  if (!pdfKlass || !expectedKlass) return false
  if (!pdfKlass.startsWith(expectedKlass)) return false
  const after = pdfKlass[expectedKlass.length]
  return after === undefined || after === '(' || after === '（' || after === ' '
}

// doctor1/doctor2 額外靠 subject 區分（modern 年度 klass 都是「醫師」沒有 (一)/(二) 後綴）
const DOCTOR1_SUBJECTS = new Set(['醫學(一)', '醫學(二)'])
const DOCTOR2_SUBJECTS = new Set(['醫學(三)', '醫學(四)', '醫學(五)', '醫學(六)'])
function doctorSubjectFits(exam, subject) {
  const s = norm(subject)
  if (exam === 'doctor1') return DOCTOR1_SUBJECTS.has(s)
  if (exam === 'doctor2') return DOCTOR2_SUBJECTS.has(s)
  return true
}

// PDF metadata 是否含「(exam, subject)」對應的 section？
function findMatchingSection(meta, exam, exam_code, subjectNorm) {
  if (!meta || meta.skipped || meta.exam_code !== exam_code) return null
  if (!meta.sections?.length) return null
  const expectedKlass = EXPECTED_KLASS[exam]
  // 檔名 prefix 也算 klass 線索（如 pharma1_S_*, nursing_S_*）
  const prefixHintsExam = !!meta.examPrefix && filenamePrefixToExam(meta.examPrefix) === exam
  for (const sec of meta.sections) {
    // 多科同頁的 PDF section — OCR 階段會跳過，不要當候選
    if (sec.multi) continue
    // klass 比對：
    if (sec.klass && expectedKlass && !klassStrictMatch(sec.klass, expectedKlass)) continue
    // 沒 klass 又沒檔名提示 → 只接受單頁 PDF（subject 唯一足以識別）
    if (!sec.klass && !prefixHintsExam && meta.sections.length > 1) continue
    if (!sec.subject) continue
    const secN = norm(sec.subject)
    // PDF subject 嚴格匹配 OR PDF subject 開頭等於 candidate
    // （合併名如「藥理學與藥物化學」startsWith「藥理學」OK，但「中醫基礎醫學(一)」不會 startsWith「醫學(一)」避免誤配）
    const exactMatch = secN === subjectNorm
    const looseMatch = subjectNorm.length >= 3 && secN.startsWith(subjectNorm)
    if (!exactMatch && !looseMatch) continue
    // 醫師/中醫師/牙醫師 一階二階區分
    if (exam === 'doctor1' && sec.klass?.includes('醫師(二)')) continue
    if (exam === 'doctor2' && sec.klass?.includes('醫師(一)')) continue
    if (exam === 'tcm1' && sec.klass?.includes('中醫師(二)')) continue
    if (exam === 'tcm2' && sec.klass?.includes('中醫師(一)')) continue
    if (exam === 'dental1' && sec.klass?.includes('牙醫師(二)')) continue
    if (exam === 'dental2' && sec.klass?.includes('牙醫師(一)')) continue
    return sec
  }
  return null
}

// 檔名 prefix → exam id
const PREFIX_TO_EXAM = {
  doctor1: 'doctor1', doctor2: 'doctor2',
  dental1: 'dental1', dental2: 'dental2',
  pharma1: 'pharma1', pharma2: 'pharma2',
  nursing: 'nursing', nutrition: 'nutrition',
  medlab: 'medlab', radiology: 'radiology',
  pt: 'pt', ot: 'ot', tcm1: 'tcm1', tcm2: 'tcm2',
  vet: 'vet', audiologist: 'audiologist',
  speech: 'speech-therapist',
  rt: 'rt',
  'social-worker': 'social-worker',
}
function filenamePrefixToExam(prefix) {
  return PREFIX_TO_EXAM[prefix] || null
}

function findPdfForGroup(metaCache, exam, exam_code, subject) {
  const subjectN = norm(subject)
  const candidates = []
  for (const [name, meta] of Object.entries(metaCache)) {
    const sec = findMatchingSection(meta, exam, exam_code, subjectN)
    if (sec) candidates.push({ name, meta, sec })
  }
  if (candidates.length === 0) return null
  // 排序：TS > S-suffix > S > A > M > TM
  const priority = { 'TS': 0, 'S-suffix': 1, 'S': 2, 'A': 3, 'M': 4, 'TM': 5 }
  candidates.sort((a, b) => (priority[a.meta.kind] ?? 9) - (priority[b.meta.kind] ?? 9))
  return { name: candidates[0].name, expectedSubject: candidates[0].sec.subject }
}

function findPdfPath(name) {
  for (const dir of PDF_CACHE_DIRS) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

// ---------- Phase 3: Vision OCR + compare ----------

async function visionExtractAnswerPdf(pdfPath, expectedKlass) {
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  // 用「科目+題號 → 答案」結構，因為一張 PDF 可能含多科
  const subjectAnswers = {}
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i)
    const text = page.toStructuredText('preserve-whitespace').asText().normalize('NFKC')
    // 多科同頁的 combined answer PDF：一頁含 5 個科目的答案表，
    // Vision 一張 PNG 看到 400 題答案無法分辨 → 跳過該頁，避免污染
    const subjectHeaders = (text.match(/科\s*目\s*名稱\s*[：:]/g) || []).length
    if (subjectHeaders > 1) continue
    const { klass: pageKlass, subject: subj } = extractKlassSubject(text)
    if (expectedKlass && pageKlass && !klassStrictMatch(pageKlass, expectedKlass)) continue
    if (!subj || subj.length < 2) continue
    const px = page.toPixmap(mupdf.Matrix.scale(2.0, 2.0), mupdf.ColorSpace.DeviceRGB, false, true)
    const png = Buffer.from(px.asPNG())
    const ans = await visionOnePage(png)
    if (Object.keys(ans).length > 0) {
      subjectAnswers[subj] = { ...(subjectAnswers[subj] || {}), ...ans }
    }
  }
  return subjectAnswers
}

async function visionOnePage(png) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const prompt = `這是台灣國考的「測驗式試題標準答案」PDF 截圖。
扁平輸出 — {"題號": "答案"} 形式，題號為字串，答案為單一字元 A/B/C/D。
若多選照原樣輸出（"AC"）。若以 # 標記更正答案，用更正後的。
範例：{"1":"A","2":"B","3":"C"}
不要解釋、不要 markdown code fence，只輸出 JSON。`
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
          generationConfig: { temperature: 0.0, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 256 } },
        }),
      })
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, Math.min(60000, 3000 * 2 ** attempt)))
        continue
      }
      if (!resp.ok) {
        if (attempt === 4) return {}
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
        continue
      }
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
          } else if (typeof v === 'string' && v.length <= 4) {
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

async function getOcrForPdf(pdfPath, expectedKlass, ocrCache) {
  const name = path.basename(pdfPath)
  if (ocrCache[name]) return ocrCache[name]
  const result = await visionExtractAnswerPdf(pdfPath, expectedKlass)
  ocrCache[name] = result
  // persist immediately so partial progress is durable
  atomicWriteJson(OCR_CACHE, ocrCache)
  return result
}

// ---------- Main ----------

async function processExam(exam, metaCache, ocrCache) {
  const file = EXAM_FILES[exam]
  if (!file) { console.log(`[${exam}] no questions file mapped, skip`); return null }
  const fp = path.join(BACKEND, file)
  if (!fs.existsSync(fp)) { console.log(`[${exam}] ${file} not found, skip`); return null }
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  console.log(`\n[${exam}] ${arr.length} questions`)

  // group by (exam_code, subject) — q.subject 是 paper name（如 "卷一" 或 "基礎醫學"）
  // 同時記錄該 group 出現過的 q.subject_name 集合，以便 PDF 匹配 fallback
  const groups = new Map()
  for (const q of arr) {
    if (!q.exam_code || !q.subject) continue
    const key = `${q.exam_code}|${q.subject}`
    if (!groups.has(key)) groups.set(key, { qs: [], subject_names: new Map() })
    const g = groups.get(key)
    g.qs.push(q)
    if (q.subject_name) {
      g.subject_names.set(q.subject_name, (g.subject_names.get(q.subject_name) || 0) + 1)
    }
  }
  console.log(`[${exam}] ${groups.size} (exam_code, subject) groups`)

  const expectedKlass = EXPECTED_KLASS[exam]
  const log = []
  let mismatchCount = 0, checkedCount = 0, missingPdf = 0, ocrFailed = 0
  let groupIdx = 0
  const groupTotal = limit > 0 ? Math.min(limit, groups.size) : groups.size

  for (const [key, group] of groups) {
    if (limit > 0 && groupIdx >= limit) break
    groupIdx++
    const [exam_code, subject] = key.split('|')
    const qs = group.qs
    // try q.subject first, then most common q.subject_name (for exams like pharma1
    // where q.subject is "卷一" but PDF is "藥理學")
    const subjectCandidates = [subject]
    const sortedNames = [...group.subject_names.entries()].sort((a, b) => b[1] - a[1])
    for (const [name] of sortedNames) {
      if (!subjectCandidates.includes(name)) subjectCandidates.push(name)
    }

    let found = null, usedSubject = null
    for (const cand of subjectCandidates) {
      found = findPdfForGroup(metaCache, exam, exam_code, cand)
      if (found) { usedSubject = cand; break }
    }
    if (!found) {
      missingPdf++
      if (groupIdx <= 5 || groupIdx % 20 === 0) {
        console.log(`  [${groupIdx}/${groupTotal}] ${exam_code} | ${subject} → ✗ no matching PDF (tried: ${subjectCandidates.slice(0,3).join(' / ')})`)
      }
      continue
    }
    const { name: pdfName, expectedSubject } = found
    const pdfPath = findPdfPath(pdfName)
    if (!pdfPath) { missingPdf++; continue }

    let ocr
    try {
      ocr = await getOcrForPdf(pdfPath, expectedKlass, ocrCache)
    } catch (e) {
      ocrFailed++
      console.log(`  [${groupIdx}/${groupTotal}] ${pdfName} → OCR failed: ${e.message}`)
      continue
    }

    // ocr: { subject: {qnum: ans} } — 用 usedSubject (找到 PDF 的那個候選) 嚴格匹配
    const usedSubjectN = norm(usedSubject)
    let ansMap = null
    for (const [ocrSubj, m] of Object.entries(ocr)) {
      if (norm(ocrSubj) === usedSubjectN) { ansMap = m; break }
    }
    if (!ansMap && expectedSubject) {
      for (const [ocrSubj, m] of Object.entries(ocr)) {
        if (norm(ocrSubj) === norm(expectedSubject)) { ansMap = m; break }
      }
    }
    if (!ansMap) {
      missingPdf++
      if (groupIdx <= 10 || groupIdx % 20 === 0) {
        console.log(`  [${groupIdx}/${groupTotal}] ${exam_code} | ${subject} → ${pdfName} but OCR has no matching subject (has: ${Object.keys(ocr).join(', ')})`)
      }
      continue
    }

    let groupChecked = 0, groupMis = 0
    for (const q of qs) {
      const got = ansMap[String(q.number)] || ansMap[q.number]
      if (!got) continue
      checkedCount++; groupChecked++
      // 過濾假陽性：
      // - got 必須是合法選項 A/B/C/D（OCR 偶爾讀到 E 等，不可信）
      // - q.answer === '送分' / '#' / 含 #：是 disputed 題，跳過
      const isValidLetter = /^[ABCD]$/.test(got)
      const oldIsDisputed = !q.answer || q.answer === '送分' || /[#＃]/.test(q.answer) || q.disputed === true
      if (!isValidLetter) continue
      if (oldIsDisputed) continue  // 不覆寫 disputed，已由考選部送分
      if (got !== q.answer) {
        mismatchCount++; groupMis++
        log.push({
          examId: exam, qid: q.id, year: q.roc_year, session: q.session,
          subject: q.subject, num: q.number, old: q.answer, new: got,
          source: pdfName,
        })
        if (apply) { q.answer = got; q.disputed = true }
      }
    }
    if (groupIdx <= 5 || groupIdx % 20 === 0 || groupMis > 0) {
      console.log(`  [${groupIdx}/${groupTotal}] ${exam_code} | ${subject} → ${pdfName} | checked ${groupChecked}/${qs.length} | mismatch ${groupMis}`)
    }
  }

  if (apply && mismatchCount > 0) {
    atomicWriteJson(fp, data)
    console.log(`[${exam}] applied ${mismatchCount} answer changes to ${file}`)
  }
  console.log(`[${exam}] checked=${checkedCount} mismatch=${mismatchCount} missingPdf=${missingPdf} ocrFailed=${ocrFailed}`)
  return { exam, checked: checkedCount, mismatch: mismatchCount, missingPdf, ocrFailed, log }
}

;(async () => {
  await getMupdf()
  console.log('=== Phase 1: build PDF metadata index ===')
  const metaCache = await buildMetadataIndex()
  if (buildIndexOnly) { console.log('--build-index done'); return }

  const ocrCache = loadJsonOr(OCR_CACHE, {})
  const exams = examFilter ? [examFilter] : (all ? Object.keys(EXAM_FILES) : null)
  if (!exams) {
    console.log('Usage: --exam <id> | --all | --build-index')
    return
  }

  const overall = []
  for (const e of exams) {
    const r = await processExam(e, metaCache, ocrCache)
    if (r) overall.push(r)
  }

  const summary = {
    timestamp: new Date().toISOString(),
    apply: !!apply,
    overall: overall.map(r => ({ exam: r.exam, checked: r.checked, mismatch: r.mismatch, missingPdf: r.missingPdf })),
    total_checked: overall.reduce((s, r) => s + r.checked, 0),
    total_mismatch: overall.reduce((s, r) => s + r.mismatch, 0),
    samples: overall.flatMap(r => r.log).slice(0, 100),
    full: overall.flatMap(r => r.log),
  }
  atomicWriteJson(LOG_FILE, summary)
  console.log(`\n=== 總計 ${summary.total_checked} 題比對，${summary.total_mismatch} 不一致 ===`)
  console.log(`Log: ${path.relative(BACKEND, LOG_FILE)}`)
  if (!apply) console.log('Dry-run only. 確認後加 --apply 套用')
})().catch(e => { console.error(e); process.exit(1) })
