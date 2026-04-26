#!/usr/bin/env node
/**
 * scrape-fill-gaps-vision.js
 * Auto-detects all missing questions across all exam JSON files and fills them
 * using Claude Vision OCR on the source PDFs.
 *
 * Usage:
 *   node scripts/scrape-fill-gaps-vision.js               # all exams
 *   node scripts/scrape-fill-gaps-vision.js --exam nursing # one exam
 *   node scripts/scrape-fill-gaps-vision.js --dry-run      # show what would run
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
require('dotenv').config()

const fs      = require('fs')
const path    = require('path')
const https   = require('https')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const pdfParse  = require('pdf-parse')
const { atomicWriteJson } = require('./lib/atomic-write')
const { fetchPdf, cachedFetch, buildMoexUrl } = require('./lib/pdf-fetcher')

const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE    = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const CACHE   = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const BACKEND = path.resolve(__dirname, '..')

if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true })

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const visionModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── URL lookup: (exam_code, subject) → {c, s} ────────────────────────────────
// Key format: "examId|exam_code|subject" → {c: classCode, s: subjectCode}
// Built from scrape-100-105.js + scrape-moex.js + scrape-tcm1/2-106-109.js data

function lu(code, subject, c, s) {
  return { key: `${code}|${subject}`, c, s }
}

const LOOKUP_ENTRIES = [
  // ── NURSING ─────────────────────────────────────────────────────────────────
  // 100030, 100140, 101030: c=105
  ...['100030','100140','101030'].flatMap(code => [
    lu(code,'基礎醫學','105','0108'), lu(code,'基本護理學與護理行政','105','0401'),
    lu(code,'內外科護理學','105','0402'), lu(code,'產兒科護理學','105','0403'),
    lu(code,'精神科與社區衛生護理學','105','0404'),
  ]),
  // 102030, 103030, 103100: c=107 (no 基礎醫學)
  ...['102030','103030','103100'].flatMap(code => [
    lu(code,'基本護理學與護理行政','107','0401'), lu(code,'內外科護理學','107','0402'),
    lu(code,'產兒科護理學','107','0403'), lu(code,'精神科與社區衛生護理學','107','0404'),
  ]),
  // 104030: c=109 (no 基礎醫學, shifted s codes)
  lu('104030','基本護理學與護理行政','109','0501'), lu('104030','內外科護理學','109','0502'),
  lu('104030','產兒科護理學','109','0503'), lu('104030','精神科與社區衛生護理學','109','0504'),
  // 104100, 105030, 105090: c=106
  ...['104100','105030','105090'].flatMap(code => [
    lu(code,'基礎醫學','106','0501'), lu(code,'基本護理學與護理行政','106','0502'),
    lu(code,'內外科護理學','106','0503'), lu(code,'產兒科護理學','106','0504'),
    lu(code,'精神科與社區衛生護理學','106','0505'),
  ]),
  // 106030-109110: c=106, s=0501-0505（2026-04-20 驗證）
  ...['106030','106110','107030','107110','108020','108110','109030','109110'].flatMap(code => [
    lu(code,'基礎醫學','106','0501'), lu(code,'基本護理學與護理行政','106','0502'),
    lu(code,'內外科護理學','106','0503'), lu(code,'產兒科護理學','106','0504'),
    lu(code,'精神科與社區衛生護理學','106','0505'),
  ]),
  // 114030+: c=101, s=0101-0105（CLAUDE.md 已驗證）
  // ⚠ 110-113 nursing c-code 隨場次不一致（c=105/106 混用），遇到缺題時請先手動 probe 再補
  ...['114030','114100','115030'].flatMap(code => [
    lu(code,'基礎醫學','101','0101'), lu(code,'基本護理學與護理行政','101','0102'),
    lu(code,'內外科護理學','101','0103'), lu(code,'產兒科護理學','101','0104'),
    lu(code,'精神科與社區衛生護理學','101','0105'),
  ]),

  // ── NUTRITION ────────────────────────────────────────────────────────────────
  // 101030, 100140: c=107
  ...['101030','100140'].flatMap(code => [
    lu(code,'生理學與生物化學','107','0601'), lu(code,'營養學','107','0602'),
    lu(code,'膳食療養學','107','0603'), lu(code,'團體膳食設計與管理','107','0604'),
    lu(code,'公共衛生營養學','107','0605'), lu(code,'食品衛生與安全','107','0606'),
  ]),
  // 104030: c=106 (s=0301-0306)
  lu('104030','生理學與生物化學','106','0301'), lu('104030','營養學','106','0302'),
  lu('104030','膳食療養學','106','0303'), lu('104030','團體膳食設計與管理','106','0304'),
  lu('104030','公共衛生營養學','106','0305'), lu('104030','食品衛生與安全','106','0306'),
  // 104100, 105030, 105090: c=103 (s=0201-0206)
  ...['104100','105030','105090'].flatMap(code => [
    lu(code,'生理學與生物化學','103','0201'), lu(code,'營養學','103','0202'),
    lu(code,'膳食療養學','103','0203'), lu(code,'團體膳食設計與管理','103','0204'),
    lu(code,'公共衛生營養學','103','0205'), lu(code,'食品衛生與安全','103','0206'),
  ]),
  // 106030+: c=102 (modern, different s ordering)
  ...['106030','106110','107030','107110','108020','108110','109030','109110',
      '110030','110111','111030','111110','112030','112110','113030','113100',
      '114030','114100','115030'].flatMap(code => [
    lu(code,'膳食療養學','102','0201'), lu(code,'團體膳食設計與管理','102','0202'),
    lu(code,'生理學與生物化學','102','0203'), lu(code,'營養學','102','0204'),
    lu(code,'公共衛生營養學','102','0205'), lu(code,'食品衛生與安全','102','0206'),
  ]),

  // ── SOCIAL WORKER ────────────────────────────────────────────────────────────
  lu('104030','社會工作','110','0601'), lu('104030','社會工作直接服務','110','0602'),
  lu('104030','社會工作管理','110','0603'),
  ...['104100','105030','105090'].flatMap(code => [
    lu(code,'社會工作','107','0601'), lu(code,'社會工作直接服務','107','0602'),
    lu(code,'社會工作管理','107','0603'),
  ]),
  ...['106030','106110','107030','107110','108020','108110','109030','109110',
      '110030','110111','111030','111110','112030','112110','113030','113100',
      '114030','114100','115030'].flatMap(code => [
    lu(code,'社會工作','103','0301'), lu(code,'社會工作直接服務','103','0302'),
    lu(code,'社會工作管理','103','0303'),
  ]),

  // ── TCM1 ─────────────────────────────────────────────────────────────────────
  lu('100030','中醫基礎醫學(一)','107','0601'), lu('100030','中醫基礎醫學(二)','107','0602'),
  ...['100140','101030'].flatMap(code => [
    lu(code,'中醫基礎醫學(一)','106','0501'), lu(code,'中醫基礎醫學(二)','106','0502'),
  ]),
  lu('102030','中醫基礎醫學(一)','109','0501'), lu('102030','中醫基礎醫學(二)','109','0502'),
  lu('103030','中醫基礎醫學(一)','109','0501'), lu('103030','中醫基礎醫學(二)','109','0502'),
  lu('103100','中醫基礎醫學(一)','103','0201'), lu('103100','中醫基礎醫學(二)','103','0202'),
  lu('104030','中醫基礎醫學(一)','103','0201'), lu('104030','中醫基礎醫學(二)','103','0202'),
  ...['104100','105030','105090'].flatMap(code => [
    lu(code,'中醫基礎醫學(一)','101','0101'), lu(code,'中醫基礎醫學(二)','101','0102'),
  ]),
  ...['106030','106110','107030','107110','108020','108110','109030','109110',
      '110030','110111','111030','111110','112030','112110','113030','113100',
      '114030','114100','115030'].flatMap(code => [
    lu(code,'中醫基礎醫學(一)','101','0101'), lu(code,'中醫基礎醫學(二)','101','0102'),
  ]),

  // ── TCM2 ─────────────────────────────────────────────────────────────────────
  lu('100030','中醫臨床醫學(一)','107','0603'), lu('100030','中醫臨床醫學(二)','107','0604'),
  lu('100030','中醫臨床醫學(三)','107','0605'), lu('100030','中醫臨床醫學(四)','107','0606'),
  ...['100140','101030'].flatMap(code => [
    lu(code,'中醫臨床醫學(一)','106','0503'), lu(code,'中醫臨床醫學(二)','106','0504'),
    lu(code,'中醫臨床醫學(三)','106','0505'), lu(code,'中醫臨床醫學(四)','106','0506'),
  ]),
  lu('102030','中醫臨床醫學(一)','110','0601'), lu('102030','中醫臨床醫學(二)','110','0602'),
  lu('102030','中醫臨床醫學(三)','110','0603'), lu('102030','中醫臨床醫學(四)','110','0604'),
  // 103030 tcm2: split across two class codes
  lu('103030','中醫臨床醫學(一)','110','0601'), lu('103030','中醫臨床醫學(二)','110','0602'),
  lu('103030','中醫臨床醫學(三)','109','0503'), lu('103030','中醫臨床醫學(四)','109','0504'),
  lu('103100','中醫臨床醫學(一)','104','0203'), lu('103100','中醫臨床醫學(二)','104','0204'),
  lu('103100','中醫臨床醫學(三)','104','0205'), lu('103100','中醫臨床醫學(四)','104','0206'),
  lu('104030','中醫臨床醫學(一)','104','0203'), lu('104030','中醫臨床醫學(二)','104','0204'),
  lu('104030','中醫臨床醫學(三)','104','0205'), lu('104030','中醫臨床醫學(四)','104','0206'),
  ...['104100','105030','105090'].flatMap(code => [
    lu(code,'中醫臨床醫學(一)','102','0103'), lu(code,'中醫臨床醫學(二)','102','0104'),
    lu(code,'中醫臨床醫學(三)','102','0105'), lu(code,'中醫臨床醫學(四)','102','0106'),
  ]),
  ...['106030','106110','107030','107110','108020','108110','109030','109110',
      '110030','110111','111030','111110','112030','112110','113030','113100',
      '114030','114100','115030'].flatMap(code => [
    lu(code,'中醫臨床醫學(一)','102','0103'), lu(code,'中醫臨床醫學(二)','102','0104'),
    lu(code,'中醫臨床醫學(三)','102','0105'), lu(code,'中醫臨床醫學(四)','102','0106'),
  ]),

  // ── DOCTOR2 ──────────────────────────────────────────────────────────────────
  ...['100030','101030','102030','103030','103100','104030'].flatMap(code => [
    lu(code,'醫學(三)','102','0103'), lu(code,'醫學(四)','102','0104'),
    lu(code,'醫學(五)','102','0105'), lu(code,'醫學(六)','102','0106'),
  ]),
  // 104090: c=302 (020 series second session)
  lu('104090','醫學(一)','302','0101'), lu('104090','醫學(二)','302','0102'),
  lu('104090','醫學(三)','302','0103'), lu('104090','醫學(四)','302','0104'),
  lu('104090','醫學(五)','302','0105'), lu('104090','醫學(六)','302','0106'),
  // 105020: c=302
  ...['105020','105100'].flatMap(code => [
    lu(code,'醫學(一)','302','0101'), lu(code,'醫學(二)','302','0102'),
    lu(code,'醫學(三)','302','0103'), lu(code,'醫學(四)','302','0104'),
    lu(code,'醫學(五)','302','0105'), lu(code,'醫學(六)','302','0106'),
  ]),

  // ── PHARMA1 ──────────────────────────────────────────────────────────────────
  ...['100030','101030'].flatMap(code => [
    lu(code,'卷一','103','0201'), lu(code,'卷二','103','0202'), lu(code,'卷三','103','0204'),
  ]),

  // ── PHARMA2 ──────────────────────────────────────────────────────────────────
  ...['100030','101030'].flatMap(code => [
    lu(code,'調劑與臨床','103','0203'), lu(code,'藥物治療','103','0205'), lu(code,'法規','103','0206'),
  ]),

  // ── MEDLAB ───────────────────────────────────────────────────────────────────
  ...['100030','101030'].flatMap(code => [
    lu(code,'臨床生理學與病理學','104','0107'),
    lu(code,'臨床血液學與血庫學','104','0301'), lu(code,'微生物學與臨床微生物學','104','0303'),
    lu(code,'生物化學與臨床生化學','104','0304'),
  ]),
  ...['103020','103090','104020'].flatMap(code => [
    lu(code,'臨床生理學與病理學','311','0107'),
    lu(code,'臨床血液學與血庫學','311','0501'), lu(code,'微生物學與臨床微生物學','311','0503'),
    lu(code,'生物化學與臨床生化學','311','0504'),
  ]),
  // 104090: c=308 (rotated back)
  lu('104090','臨床生理學與病理學','308','0107'),
  lu('104090','臨床血液學與血庫學','308','0501'), lu('104090','微生物學與臨床微生物學','308','0503'),
  lu('104090','生物化學與臨床生化學','308','0504'),

  // ── RADIOLOGY ────────────────────────────────────────────────────────────────
  ...['100020','101010','101100','102020','102100','103020','103090','104020'].flatMap(code => [
    lu(code,'醫學物理學與輻射安全','308','0601'),
    lu(code,'放射線器材學（包括磁振學與超音波學）','308','0602'),
    lu(code,'放射線診斷原理與技術學','308','0603'),
  ]),
  // 104090+: c=309
  ...['104090','105020','105100'].flatMap(code => [
    lu(code,'醫學物理學與輻射安全','309','0601'),
    lu(code,'放射線器材學（包括磁振學與超音波學）','309','0602'),
    lu(code,'放射線診斷原理與技術學','309','0603'),
  ]),
  // 106+: c=309
  ...['106020','106100','107020','107100','108020','108100','109020','109100',
      '110020','110100','111020','111100','112020','112100','113020','113090',
      '114020','114090','115020'].flatMap(code => [
    lu(code,'醫學物理學與輻射安全','309','0601'),
    lu(code,'放射線器材學（包括磁振學與超音波學）','309','0602'),
    lu(code,'放射線診斷原理與技術學','309','0603'),
    lu(code,'放射線治療原理與技術學','309','0604'),
    lu(code,'核子醫學診療原理與技術學','309','0605'),
    lu(code,'基礎醫學（包括解剖學、生理學與病理學）','309','0108'),
  ]),

  // ── CUSTOMS ──────────────────────────────────────────────────────────────────
  lu('108050','法學知識','101','0307'), lu('109050','法學知識','101','0308'),
  lu('110050','法學知識','101','0308'), lu('111050','法學知識','101','0310'),
  lu('112050','法學知識','101','0308'), lu('113040','法學知識','101','0306'),
  lu('114040','法學知識','101','0305'),
  ...['108050','109050','110050','111050','112050','113040','114040'].map(code =>
    lu(code,'英文','101','0201')
  ),
  ...['108050','109050','110050','111050','112050','113040','114040'].map(code =>
    lu(code,'國文（測驗）','101','0101')
  ),

  // ── JUDICIAL ─────────────────────────────────────────────────────────────────
  lu('109130','法學知識與英文','101','0412'),
  lu('110130','法學知識與英文','101','0315'),

  // ── POLICE ───────────────────────────────────────────────────────────────────
  lu('112050','行政學','301','0301'),  // Note: customs also uses 112050, different c code!
  // Police uses its own session codes
  lu('112010','行政學','301','0301'),  // adjust if needed
  lu('112040','行政學','301','0301'),
]

// Build lookup map
const URL_LOOKUP = {}
for (const e of LOOKUP_ENTRIES) {
  URL_LOOKUP[e.key] = { c: e.c, s: e.s }
}

// Overrides from alt-cs brute-force probe (scripts/probe-alt-cs.js)
// These fix cases where LOOKUP_ENTRIES had wrong c/s by mistake.
try {
  const overridesPath = path.join(__dirname, '..', 'alt-probe-matches.json')
  if (fs.existsSync(overridesPath)) {
    const arr = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
    for (const o of arr) {
      URL_LOOKUP[`${o.code}|${o.subject}`] = { c: o.newC, s: o.newS }
    }
  }
} catch (e) { /* ignore */ }

// ─── Exam config: expected question counts ─────────────────────────────────────
const EXAM_FILES = {
  'nursing':       { file: 'questions-nursing.json',       config: 'exam-configs/nursing.json' },
  'nutrition':     { file: 'questions-nutrition.json',     config: 'exam-configs/nutrition.json' },
  'social-worker': { file: 'questions-social-worker.json', config: 'exam-configs/social-worker.json' },
  'tcm1':          { file: 'questions-tcm1.json',          config: 'exam-configs/tcm1.json' },
  'tcm2':          { file: 'questions-tcm2.json',          config: 'exam-configs/tcm2.json' },
  'doctor2':       { file: 'questions-doctor2.json',       config: 'exam-configs/doctor2.json' },
  'pharma1':       { file: 'questions-pharma1.json',       config: 'exam-configs/pharma1.json' },
  'pharma2':       { file: 'questions-pharma2.json',       config: 'exam-configs/pharma2.json' },
  'medlab':        { file: 'questions-medlab.json',        config: 'exam-configs/medlab.json' },
  'radiology':     { file: 'questions-radiology.json',     config: 'exam-configs/radiology.json' },
  'customs':       { file: 'questions-customs.json',       config: 'exam-configs/customs.json' },
  'judicial':      { file: 'questions-judicial.json',      config: 'exam-configs/judicial.json' },
  'police':        { file: 'questions-police.json',        config: 'exam-configs/police.json' },
  'pt':            { file: 'questions-pt.json',            config: 'exam-configs/pt.json' },
  'dental1':       { file: 'questions-dental1.json',       config: 'exam-configs/dental1.json' },
  'dental2':       { file: 'questions-dental2.json',       config: 'exam-configs/dental2.json' },
}

function getExpectedCount(cfg, subject) {
  if (!cfg || !cfg.papers) return 80
  const paper = cfg.papers.find(p => p.subject === subject || p.name === subject)
  return paper ? (paper.count || 80) : 80
}

// ─── Auto-detect missing targets ──────────────────────────────────────────────

// For these exams every question is a 選擇題 — use cross-year max to detect missing
// second-column questions (e.g. nursing 102/103 where parser only got Q1-40 of an 80-Q paper)
const PURE_SELECTION_EXAMS = new Set(['nursing','tcm1','tcm2','doctor2','medlab','radiology','pt','dental1','dental2','pharma1','pharma2'])

// Exam format changes: when papers shrank in later years, cap expected count by new max
// to avoid false "missing Q51-80" for 50-question papers
const FORMAT_YEAR_CHANGES = [
  { exam: 'nursing', subject: '基礎醫學', fromYear: 111, maxQ: 50 },
  { exam: 'nursing', subject: null,        fromYear: 113, maxQ: 50 },
  { exam: 'pharma2', subject: '藥物治療',  fromYear: 110, maxQ: 54 },
]

function getFormatMaxQ(examId, subject, examCode) {
  const year = parseInt(examCode.slice(0, 3))
  for (const fc of FORMAT_YEAR_CHANGES) {
    if (fc.exam === examId && (fc.subject === null || fc.subject === subject) && year >= fc.fromYear) {
      return fc.maxQ
    }
  }
  return 80
}

function buildTargets(examFilter) {
  const targets = []

  for (const [examId, { file, config: cfgPath }] of Object.entries(EXAM_FILES)) {
    if (examFilter && !examId.startsWith(examFilter) && examId !== examFilter) continue
    const filePath = path.join(BACKEND, file)
    if (!fs.existsSync(filePath)) continue

    const raw = JSON.parse(fs.readFileSync(filePath))
    const allQs = raw.questions || raw

    // Compute cross-year max per subject (for pure-selection exams only)
    const subjectCrossYearMax = {}
    if (PURE_SELECTION_EXAMS.has(examId)) {
      for (const q of allQs) {
        subjectCrossYearMax[q.subject] = Math.max(subjectCrossYearMax[q.subject] || 0, q.number)
      }
    }

    // Group by exam_code + subject
    const groups = {}
    for (const q of allQs) {
      const key = `${q.exam_code}|${q.subject}`
      if (!groups[key]) groups[key] = { nums: new Set(), sample: q }
      groups[key].nums.add(q.number)
    }

    for (const [key, { nums, sample }] of Object.entries(groups)) {
      const [exam_code, subject] = key.split('|')
      const inYearMax  = Math.max(...nums)
      const crossMax   = subjectCrossYearMax[subject] || inYearMax
      const formatMax  = getFormatMaxQ(examId, subject, exam_code)
      // For pure-selection exams: use cross-year max to catch missing 2nd-column questions
      // but cap by formatMax to avoid flagging papers that legitimately shrank (e.g. nursing 113+)
      // For mixed exams (nutrition etc.): use in-year max to avoid flagging 申論題 as missing
      const expected = PURE_SELECTION_EXAMS.has(examId)
        ? Math.max(inYearMax, Math.min(crossMax, formatMax))
        : inYearMax

      const emptyAnswers = allQs.filter(q =>
        q.exam_code === exam_code && q.subject === subject && !q.answer
      ).length

      const missing = []
      for (let i = 1; i <= expected; i++) if (!nums.has(i)) missing.push(i)

      if (missing.length === 0 && emptyAnswers === 0) continue

      const lookupKey = `${exam_code}|${subject}`
      const urlInfo = URL_LOOKUP[lookupKey]
      if (!urlInfo) {
        if (missing.length > 0)
          console.log(`  ⚠ No URL lookup for: ${examId} ${exam_code} "${subject}" (${missing.length} missing)`)
        continue
      }

      targets.push({
        examId, file, exam_code, subject,
        c: urlInfo.c, s: urlInfo.s,
        roc_year: sample.roc_year,
        session: sample.session,
        subject_tag: sample.subject_tag,
        subject_name: sample.subject_name || subject,
        expected, missing, emptyAnswers,
      })
    }
  }

  return targets
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

async function cachedPdf(kind, code, c, s) {
  const fpath = path.join(CACHE, `${kind}_${code}_c${c}_s${s}.pdf`)
  try { const buf = fs.readFileSync(fpath); if (buf.length > 1000) return { buf, fromCache: true } } catch {}
  const buf = await fetchPdf(`${BASE}?t=${kind}&code=${code}&c=${c}&s=${s}&q=1`)
  fs.writeFileSync(fpath, buf)
  return { buf, fromCache: false }
}

// ─── PDF → PNG pages ──────────────────────────────────────────────────────────
async function pdfToPageImages(buf, dpi = 144) {
  const mupdf = await import('mupdf')
  const doc   = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n     = doc.countPages()
  const scale = dpi / 72
  const images = []
  for (let i = 0; i < n; i++) {
    const page   = doc.loadPage(i)
    const matrix = mupdf.Matrix.scale(scale, scale)
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
    images.push(Buffer.from(pixmap.asPNG()))
  }
  return images
}

// ─── Claude Vision: extract questions ─────────────────────────────────────────
const VISION_Q_PROMPT = `這是一張台灣國家考試試題的掃描圖片。
請將圖片中所有可見的單選題完整抽出。
規則：題號(number)、題目文字(question)、四個選項(A/B/C/D)必須完整。
只輸出純 JSON：[{"number":1,"question":"...","options":{"A":"...","B":"...","C":"...","D":"..."}}]`

const VISION_A_PROMPT = `這是一張台灣國家考試答案表的掃描圖片。
請抽出所有可見的題號與答案。
只輸出純 JSON（題號為數字，答案為A/B/C/D）：{"1":"A","2":"C",...}`

async function visionExtract(pngBuf, prompt, pageNum) {
  const base64 = pngBuf.toString('base64')
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await visionModel.generateContent([
        { inlineData: { data: base64, mimeType: 'image/png' } },
        prompt,
      ])
      const text = result.response.text().trim()
      const match = text.match(/[\[{][\s\S]*[\]}]/)
      if (!match) return prompt.startsWith('[') ? [] : {}
      return JSON.parse(match[0])
    } catch (e) {
      if (attempt >= 2) { console.log(`    Page ${pageNum}: Vision failed: ${e.message}`); return prompt.startsWith('[') ? [] : {} }
      await sleep(2000 * (attempt + 1))
    }
  }
}

// ─── Answer parsing ────────────────────────────────────────────────────────────
function parseAnswersPdfLocal(text) {
  // fullwidth
  const fwPattern = /答案\s*([ＡＢＣＤ＃]+)/g
  const answers = {}; let m, n = 1
  while ((m = fwPattern.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k; else if (ch === '＃') n++
    }
  }
  if (Object.keys(answers).length >= 20) return answers
  // halfwidth
  const hwPattern = /答案\s*([A-D#]{10,})/gi
  n = 1; const hw = {}
  while ((m = hwPattern.exec(text)) !== null) {
    for (const ch of m[1]) { if (/[A-D]/i.test(ch) && n <= 120) hw[n] = ch.toUpperCase(); n++ }
  }
  if (Object.keys(hw).length > Object.keys(answers).length && Object.keys(hw).length >= 20) return hw
  // 第N題\nX format
  const numPattern = /第\s*(\d+)\s*題[\s\S]{0,5}?([ABCD])/gi
  const numAns = {}
  while ((m = numPattern.exec(text)) !== null) {
    const num = parseInt(m[1]); if (num >= 1 && num <= 120) numAns[num] = m[2].toUpperCase()
  }
  if (Object.keys(numAns).length > Object.keys(hw).length) return numAns
  return Object.keys(hw).length > 0 ? hw : answers
}

async function parseAnswersPdfVision(buf) {
  let pageImages
  try { pageImages = await pdfToPageImages(buf, 120) } catch { return {} }
  const combined = {}
  for (let i = 0; i < pageImages.length; i++) {
    const partial = await visionExtract(pageImages[i], VISION_A_PROMPT, i + 1)
    if (partial && typeof partial === 'object') {
      for (const [k, v] of Object.entries(partial)) {
        const num = parseInt(k)
        if (num >= 1 && num <= 120 && /^[ABCD]$/i.test(v)) combined[num] = v.toUpperCase()
      }
    }
    await sleep(300)
  }
  return combined
}

async function loadAnswers(code, c, s) {
  let answerBuf = null
  for (const t of ['S', 'M', 'A']) {
    try {
      const { buf } = await cachedPdf(t, code, c, s)
      const text = (await pdfParse(buf)).text
      const parsed = parseAnswersPdfLocal(text)
      if (Object.keys(parsed).length >= 20) return parsed
      answerBuf = buf
    } catch {}
  }
  if (answerBuf) {
    const vision = await parseAnswersPdfVision(answerBuf)
    if (Object.keys(vision).length >= 10) return vision
  }
  return {}
}

// ─── ID helper ────────────────────────────────────────────────────────────────
function nextId(allQs) {
  if (!allQs.length) return 1
  const nums = allQs.map(q => parseInt(String(q.id).split('_').pop())).filter(n => !isNaN(n))
  return nums.length ? Math.max(...nums) + 1 : allQs.length + 1
}

// ─── Process one target ────────────────────────────────────────────────────────
async function processTarget(t, dryRun) {
  console.log(`\n═══ ${t.examId} ${t.roc_year}年${t.session} ${t.subject} ═══`)
  console.log(`    exam_code=${t.exam_code} c=${t.c} s=${t.s}`)
  console.log(`    Missing: ${t.missing.length} | Empty answers: ${t.emptyAnswers}`)

  if (dryRun) return 0

  const filePath = path.join(BACKEND, t.file)
  const rawData  = JSON.parse(fs.readFileSync(filePath))
  const allQs    = rawData.questions || rawData
  const isWrapped = !!rawData.questions

  // Determine actually missing (re-check in case another target already filled some)
  const existing = allQs.filter(q => q.exam_code === t.exam_code && q.subject === t.subject)
  const existingNums = new Set(existing.map(q => q.number))
  const emptyNums    = new Set(existing.filter(q => !q.answer).map(q => q.number))
  const missingNums  = t.missing.filter(n => !existingNums.has(n))

  if (missingNums.length === 0 && emptyNums.size === 0) {
    console.log('  ✓ Already complete'); return 0
  }

  // Load answers (needed for both new questions and patching)
  let answers = {}
  if (missingNums.length > 0 || emptyNums.size > 0) {
    console.log('  📥 Loading answers...')
    answers = await loadAnswers(t.exam_code, t.c, t.s)
    console.log(`  ${Object.keys(answers).length} answers loaded`)
  }

  // Patch empty-answer existing questions
  let patched = 0
  if (emptyNums.size > 0 && Object.keys(answers).length > 0) {
    for (const q of allQs) {
      if (q.exam_code === t.exam_code && q.subject === t.subject && !q.answer && answers[q.number]) {
        q.answer = answers[q.number]; patched++
      }
    }
    console.log(`  Patched ${patched} empty answers`)
  }

  // Extract missing questions via Vision
  let added = 0
  if (missingNums.length > 0) {
    console.log('  📥 Downloading question PDF...')
    let qBuf = null
    try {
      const { buf, fromCache } = await cachedPdf('Q', t.exam_code, t.c, t.s)
      qBuf = buf
      console.log(`  ${fromCache ? '(cached)' : '(fetched)'} ${buf.length} bytes`)
    } catch (e) { console.log(`  ✗ PDF download failed: ${e.message}`) }

    if (qBuf) {
      console.log('  🖼  Rendering pages...')
      let pageImages = []
      try { pageImages = await pdfToPageImages(qBuf); console.log(`  ${pageImages.length} pages`) }
      catch (e) { console.log(`  ✗ Render failed: ${e.message}`) }

      if (pageImages.length > 0) {
        console.log('  🤖 Extracting questions via Vision...')
        const extracted = []
        for (let i = 0; i < pageImages.length; i++) {
          process.stdout.write(`    Page ${i+1}/${pageImages.length}... `)
          const qs = await visionExtract(pageImages[i], VISION_Q_PROMPT, i+1)
          console.log(`${Array.isArray(qs) ? qs.length : 0} questions`)
          if (Array.isArray(qs)) extracted.push(...qs)
          if (i < pageImages.length - 1) await sleep(400)
        }

        const toAdd = extracted.filter(q => missingNums.includes(q.number))
        console.log(`  ${toAdd.length}/${missingNums.length} missing questions found`)

        let idCounter = nextId(allQs)
        for (const eq of toAdd) {
          allQs.push({
            id: idCounter++, roc_year: t.roc_year, session: t.session,
            exam_code: t.exam_code, subject: t.subject,
            subject_tag: t.subject_tag, subject_name: t.subject_name,
            stage_id: 0, number: eq.number, question: eq.question,
            options: eq.options, answer: answers[eq.number] || '',
            explanation: '',
          })
          if (!answers[eq.number]) console.log(`  ⚠ No answer for Q${eq.number}`)
          added++
        }
      }
    }
  }

  // Save if anything changed
  if (patched > 0 || added > 0) {
    const output = isWrapped ? { ...rawData, questions: allQs } : allQs
    atomicWriteJson(filePath, output)
    console.log(`  💾 Saved ${t.file}: ${allQs.length} total (+${added} new, ${patched} patched)`)
  }
  return added + patched
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args      = process.argv.slice(2)
  const dryRun    = args.includes('--dry-run')
  const examArg   = args.find(a => a.startsWith('--exam'))?.split('=')?.[1]
               || (args.indexOf('--exam') >= 0 ? args[args.indexOf('--exam') + 1] : null)

  console.log('Scanning for missing questions...')
  const targets = buildTargets(examArg)

  const total = targets.reduce((s, t) => s + t.missing.length, 0)
  const totalEmpty = targets.reduce((s, t) => s + t.emptyAnswers, 0)
  console.log(`Found ${targets.length} targets with ${total} missing questions + ${totalEmpty} empty answers${dryRun ? ' [DRY RUN]' : ''}`)

  if (dryRun) {
    for (const t of targets) {
      const parts = []
      if (t.missing.length) parts.push(`缺${t.missing.length}題: Q${t.missing.slice(0,5).join(',')}${t.missing.length>5?'...':''}`)
      if (t.emptyAnswers) parts.push(`${t.emptyAnswers}空答案`)
      console.log(`  ${t.examId} ${t.roc_year}年 ${t.exam_code} "${t.subject}" — ${parts.join(' | ')}`)
    }
    return
  }

  let totalAdded = 0
  for (const t of targets) {
    totalAdded += await processTarget(t, dryRun)
  }
  console.log(`\n總計: ${totalAdded} questions added/patched`)
}

main().catch(e => { console.error(e); process.exit(1) })
