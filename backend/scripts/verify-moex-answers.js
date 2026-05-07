#!/usr/bin/env node
/**
 * 全面比對所有醫事題庫的答案 vs 考選部官方標準答案+更正答案 (TM/M PDF)。
 *
 * 處理規則（依 CLAUDE.md feedback_official_corrections.md）：
 *   - 「第N題一律給分」/「除未作答者不給分外，其餘均給分」→ answer = '送分'
 *   - 「第N題答X或Y或XY者均給分」/「答X或Y給分」→ answer = "X,Y"（多答案）
 *   - TM 答案表 # 標記 + 備註寫單字母 → 採更正後答案
 *   - 標準答案直接覆寫（若 DB 有錯）
 *
 * 用法:
 *   node scripts/verify-moex-answers.js --dry-run    # 列差異
 *   node scripts/verify-moex-answers.js --fix        # 套用更正
 *   node scripts/verify-moex-answers.js --exam=tcm1  # 限考試
 */
const fs = require('fs')
const path = require('path')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run') || !args.includes('--fix')
const examFilter = args.find(a => a.startsWith('--exam='))?.split('=')[1] || null

// Map: exam_code prefix → which question JSON file owns it (heuristic by exam type)
// Each entry maps a class_code (or exam-specific marker) to the questions JSON file.
// For multi-exam shared session codes (030/100/110 series), we identify by the
// PDF's 類科名稱 metadata read from the actual content.
const EXAM_FILES = {
  doctor1: 'questions.json',
  doctor2: 'questions-doctor2.json',
  dental1: 'questions-dental1.json',
  dental2: 'questions-dental2.json',
  pharma1: 'questions-pharma1.json',
  pharma2: 'questions-pharma2.json',
  nursing: 'questions-nursing.json',
  nutrition: 'questions-nutrition.json',
  medlab: 'questions-medlab.json',
  pt: 'questions-pt.json',
  ot: 'questions-ot.json',
  radiology: 'questions-radiology.json',
  tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json',
  vet: 'questions-vet.json',
  audiologist: 'questions-audiologist.json',
  'speech-therapist': 'questions-speech-therapist.json',
  'social-worker': 'questions-social-worker.json',
}

// 考試名稱 (從 PDF "考試名稱:" 欄位讀出) → 我們的 examId 對應。
// 這個欄位指該 PDF 對應的實際考試類別，比類科名稱（裡面常含其他考試名）更可靠。
const EXAM_NAME_MAP = [
  // 醫師：(一)/(二) 用括號區分階段
  [/^醫師\(一\)?$/, 'doctor1'],
  [/^醫師\(二\)?$/, 'doctor2'],
  [/^牙醫師\(一\)?$/, 'dental1'],
  [/^牙醫師\(二\)?$/, 'dental2'],
  [/^藥師\(一\)?$/, 'pharma1'],
  [/^藥師\(二\)?$/, 'pharma2'],
  [/^中醫師\(一\)?$/, 'tcm1'],
  [/^中醫師\(二\)?$/, 'tcm2'],
  [/^護理師$/, 'nursing'],
  [/^營養師$/, 'nutrition'],
  [/^醫事檢驗師$/, 'medlab'],
  [/^物理治療師$/, 'pt'],
  [/^職能治療師$/, 'ot'],
  [/^醫事放射師$/, 'radiology'],
  [/^獸醫師$/, 'vet'],
  [/^聽力師$/, 'audiologist'],
  [/^語言治療師$/, 'speech-therapist'],
  [/^社會工作師$/, 'social-worker'],
]

// ─── PDF parsing helpers ──────────────────────────────────────────────────────
let pdfjsLib = null
async function getPdfjs() {
  if (!pdfjsLib) pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjsLib
}

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

// Extract answer for each question by position-based pdfjs scan.
// Returns { 1: 'A', 2: 'B', ..., 80: 'D' } or null on failure.
async function extractAnswersByPosition(pdfBuf) {
  const pdfjs = await getPdfjs()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuf) }).promise
  const ans = {}
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const items = content.items.filter(it => it.str && it.str.trim())
    // Question labels: "第NN題"
    const qLabels = items.filter(it => /^第\d{1,3}題$/.test(it.str.trim()))
    if (!qLabels.length) continue
    const letters = items.filter(it => /^[A-D#＃]$/.test(it.str.trim()))
    for (const ql of qLabels) {
      const num = parseInt(ql.str.match(/\d+/)[0])
      if (ans[num]) continue  // already found from earlier page
      // Find nearest letter: same y (within 20pt), to the right (positive dx, dx<80)
      let best = null, bestDx = 999
      for (const c of letters) {
        const dx = c.transform[4] - ql.transform[4]
        const dy = c.transform[5] - ql.transform[5]
        if (Math.abs(dy) < 20 && dx > 0 && dx < 80 && dx < bestDx) {
          bestDx = dx
          best = c.str.trim() === '＃' ? '#' : c.str.trim()
        }
      }
      if (best) ans[num] = best
    }
  }
  return Object.keys(ans).length > 0 ? ans : null
}

// Read PDF text for 備註 (notes) parsing
async function readPdfText(pdfBuf) {
  const pdfjs = await getPdfjs()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuf) }).promise
  let txt = ''
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    txt += '\n' + content.items.map(it => it.str).join(' ')
  }
  return stripPUA(txt)
}

// Parse 備註 corrections — returns { N: '送分' | 'A,B' | 'A' (override) }
function parseRemarks(txt) {
  const overrides = {}
  // Find "備 註:" section
  const m = txt.match(/備\s*註\s*[:：]([\s\S]*?)(?:標準答案|測驗題標準答案|每題配分|題數|$)/)
  if (!m) return overrides
  const note = m[1]
  // Pattern A: 第N題一律給分 / 第N題除未作答者不給分外，其餘均給分
  for (const m of note.matchAll(/第\s*(\d{1,3})\s*題[\s\S]{0,40}?(?:一律給分|除未作答者不給分外[，,]?\s*其餘均給分)/g)) {
    overrides[parseInt(m[1])] = '送分'
  }
  // Pattern B: 第N題答X或Y[或XY]者均給分 / 第N題答X或Y給分 / 第N題答X、Y均給分
  for (const m of note.matchAll(/第\s*(\d{1,3})\s*題[\s\S]{0,30}?答\s*([A-D](?:\s*[或、,，]\s*[A-D]){1,3})[\s\S]{0,15}?給分/g)) {
    const num = parseInt(m[1])
    if (overrides[num]) continue  // 一律給分 takes precedence
    const letters = (m[2].match(/[A-D]/g) || [])
    const uniq = [...new Set(letters)].filter(L => L.length === 1)
    if (uniq.length >= 2) overrides[num] = uniq.sort().join(',')
    else if (uniq.length === 1) overrides[num] = uniq[0]  // single letter correction
  }
  // Pattern C: 第N題答X給分 (single letter, no 或 — explicit override)
  for (const m of note.matchAll(/第\s*(\d{1,3})\s*題[\s\S]{0,15}?答\s*([A-D])[\s\S]{0,5}?給分(?![A-D])/g)) {
    const num = parseInt(m[1])
    if (!overrides[num]) overrides[num] = m[2]
  }
  return overrides
}

// Identify which exam a PDF belongs to + extract its 科目名稱 (paper subject).
// Returns { examId, paperSubject } or null.
// paperSubject is the literal paper name from PDF (e.g. '醫學(一)' / '醫學(二)' /
// '基礎醫學' / '臨床血液學與血庫學' etc.). Used to disambiguate multi-paper sessions
// where Q1 of paper A is a different question from Q1 of paper B.
async function identifyExam(pdfBuf) {
  const pdfjs = await getPdfjs()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuf) }).promise
  const page = await doc.getPage(1)
  const content = await page.getTextContent()
  const txt = stripPUA(content.items.map(it => it.str).join(' '))
  const head = txt.slice(0, 2000)
  // Look for 考試名稱: ... — this is the authoritative field in MoEX answer PDFs.
  // 類科名稱 contains all classes that share the session and is misleading.
  // Robust match: take name letters (excluding whitespace/parens), then check
  // if (一) or (二) follows after optional whitespace. PDF extraction often
  // inserts spaces between Chinese characters and Latin parens.
  const examNameMatch = head.match(/考試名稱[\s：:]+([^\s（(\n]+)(?:\s*[（(]\s*([一二])\s*[）)])?/)
  if (!examNameMatch) return null
  const baseName = examNameMatch[1].trim()
  const stagePart = examNameMatch[2] ? `(${examNameMatch[2]})` : ''
  const examName = baseName + stagePart
  let examId = null
  for (const [pattern, eid] of EXAM_NAME_MAP) {
    if (pattern.test(examName)) { examId = eid; break }
  }
  if (!examId) return null
  // Extract 科目名稱: 醫學(四)（包括小兒科...） — capture base name + optional
  // (一/二/三/四/五/六) numeric suffix (without including descriptive括弧 content).
  const subjectMatch = head.match(/科目名稱[\s：:]+([^\s（(\n]+)(?:\s*[（(]\s*([一二三四五六])\s*[）)])?/)
  let paperSubject = null
  if (subjectMatch) {
    const base = subjectMatch[1].trim()
    const stage = subjectMatch[2] ? `(${subjectMatch[2]})` : ''
    paperSubject = (base + stage).slice(0, 40)
  }
  return { examId, paperSubject }
}

// Apply MoEX overrides to extracted answer set
function mergeOverrides(extracted, overrides) {
  const merged = { ...extracted }
  for (const [num, ov] of Object.entries(overrides)) {
    merged[num] = ov  // override has higher priority (corrections + 給分)
  }
  return merged
}

// ─── Main loop ────────────────────────────────────────────────────────────────
async function main() {
  const allFiles = fs.readdirSync(PDF_CACHE).filter(f => f.endsWith('.pdf'))
  // Answer PDFs are those whose filename has _T?M_ / _T?S_ / _A_ marker. Examples:
  //   TM_103030_c101_s0101.pdf       (corrections, top priority)
  //   M_103030_c101_s0101.pdf         (corrections, alt naming)
  //   nursing_M_106030_c106_s0501.pdf (exam-prefix variant)
  //   doctor1_S_104030_c101_s0101.pdf
  //   TS_/TA_/A_/S_ — standard-only fallback
  const isAnswerPdf = f => /(?:^|_)(TM|M|TS|TA|S|A)_\d+_c\w+_s[\w-]+\.pdf$/.test(f)
  const answerPdfs = allFiles.filter(isAnswerPdf)

  console.log(`[scan] ${answerPdfs.length} answer PDFs in cache`)

  function priorityOf(f) {
    // Prefer M/TM (with corrections) over S/TS (standard only) over A/TA (combined).
    if (/(?:^|_)TM_/.test(f)) return 5
    if (/(?:^|_)M_/.test(f))  return 4
    if (/(?:^|_)TS_/.test(f)) return 3
    if (/(?:^|_)S_/.test(f))  return 2
    return 1  // TA / A / other
  }

  // Group by (code, c, s) — prefer correction-bearing PDFs
  const grouped = {}
  for (const f of answerPdfs) {
    const m = f.match(/(\d{6})_c(\w+)_s([\w-]+)\.pdf$/)
    if (!m) continue
    const [, code, c, s] = m
    const key = `${code}_c${c}_s${s}`
    const priority = priorityOf(f)
    if (!grouped[key] || grouped[key].priority < priority) grouped[key] = { file: f, priority, code, c, s }
  }
  console.log(`[scan] ${Object.keys(grouped).length} unique (code,c,s) sessions`)

  // Build override map: examId → exam_code → paperSubject → {qNum: answer}
  // paperSubject is the literal 科目名稱 from PDF (e.g. '醫學(一)' / '基礎醫學' /
  // '臨床血液學與血庫學') — needed because doctor1's 醫學(一) Q1 and 醫學(二) Q1
  // share an exam_code but are different questions.
  const allOverrides = {}
  let processed = 0, skipped = 0
  for (const [key, info] of Object.entries(grouped)) {
    processed++
    if (processed % 20 === 0) process.stdout.write(`\r  scanning... ${processed}/${Object.keys(grouped).length}`)
    try {
      const buf = fs.readFileSync(path.join(PDF_CACHE, info.file))
      const ident = await identifyExam(buf)
      if (!ident) { skipped++; continue }
      const { examId, paperSubject } = ident
      if (examFilter && examId !== examFilter) { skipped++; continue }
      const ans = await extractAnswersByPosition(buf)
      if (!ans) { skipped++; continue }
      const txt = await readPdfText(buf)
      const overrides = parseRemarks(txt)
      const merged = mergeOverrides(ans, overrides)
      if (!allOverrides[examId]) allOverrides[examId] = {}
      if (!allOverrides[examId][info.code]) allOverrides[examId][info.code] = {}
      const subjectKey = paperSubject || '_default'
      if (!allOverrides[examId][info.code][subjectKey]) allOverrides[examId][info.code][subjectKey] = {}
      for (const [num, a] of Object.entries(merged)) {
        if (!allOverrides[examId][info.code][subjectKey][num]) allOverrides[examId][info.code][subjectKey][num] = a
      }
    } catch (e) {
      skipped++
    }
  }
  console.log(`\n[scan] done. examined=${processed}, skipped=${skipped}`)

  // Compare with DB. Match q to override entry by exam_code + paperSubject + number.
  // paperSubject lookup tries: q.subject_name → q.subject → fallback _default.
  function pickOverride(byCode, q) {
    if (!byCode) return null
    const candidates = [q.subject_name, q.subject, '_default'].filter(Boolean)
    for (const k of candidates) {
      if (byCode[k] && byCode[k][q.number]) return byCode[k][q.number]
    }
    // Last resort: scan all subjects under this code, take first match. Risky
    // because it may pick wrong paper, so only do this when single-paper.
    const subjects = Object.keys(byCode)
    if (subjects.length === 1) {
      return byCode[subjects[0]][q.number] || null
    }
    return null
  }

  let diffCount = 0
  let multiAnsAdded = 0
  let voidedCount = 0
  let correctedCount = 0
  const fixes = []
  for (const [examId, override] of Object.entries(allOverrides)) {
    const file = EXAM_FILES[examId]
    if (!file) continue
    const fp = path.join(BACKEND, file)
    if (!fs.existsSync(fp)) continue
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const arr = data.questions || data
    for (const q of arr) {
      if (!q.exam_code || !override[q.exam_code]) continue
      const moexAns = pickOverride(override[q.exam_code], q)
      if (!moexAns) continue
      if (moexAns === '#') continue
      const cur = q.answer
      if (String(cur) === String(moexAns)) continue
      diffCount++
      if (moexAns === '送分') voidedCount++
      else if (moexAns.includes(',')) multiAnsAdded++
      else correctedCount++
      fixes.push({ file, id: q.id, exam_code: q.exam_code, num: q.number, subject: q.subject_name || q.subject, before: cur, after: moexAns, examId })
    }
  }

  console.log(`\n=== diff summary ===`)
  console.log(`total mismatches: ${diffCount}`)
  console.log(`  → 送分: ${voidedCount}`)
  console.log(`  → 多答案 (A,B): ${multiAnsAdded}`)
  console.log(`  → 單字母更正: ${correctedCount}`)

  // Save report
  const reportPath = path.join(BACKEND, '_tmp', 'moex-answer-fixes.json')
  fs.writeFileSync(reportPath, JSON.stringify(fixes, null, 2))
  console.log(`[saved] ${reportPath}`)

  // Sample first 10
  console.log(`\nSample first 10 fixes:`)
  for (const f of fixes.slice(0, 10)) {
    console.log(`  [${f.examId}] ${f.exam_code} Q${f.num} (id=${f.id}): ${f.before} → ${f.after}`)
  }

  if (dryRun) {
    console.log('\n[dry-run] no DB writes. use --fix to apply.')
    return
  }

  // Apply
  const filesToSave = new Set()
  const dataCache = {}
  function getData(file) {
    if (!dataCache[file]) dataCache[file] = JSON.parse(fs.readFileSync(path.join(BACKEND, file), 'utf8'))
    return dataCache[file]
  }
  let applied = 0
  for (const f of fixes) {
    const data = getData(f.file)
    const arr = data.questions || data
    const q = arr.find(x => String(x.id) === String(f.id))
    if (!q) continue
    q.answer = f.after
    if (f.after === '送分' || (typeof f.after === 'string' && f.after.includes(','))) {
      q.disputed = true
    }
    applied++
    filesToSave.add(f.file)
  }
  for (const file of filesToSave) {
    const fp = path.join(BACKEND, file)
    fs.writeFileSync(fp, JSON.stringify(dataCache[file], null, 2))
    console.log(`[saved] ${file}`)
  }
  console.log(`\n=== applied ${applied} fixes ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
