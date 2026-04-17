#!/usr/bin/env node
/**
 * Fix wrong answers in newly scraped 100-105 questions.
 *
 * The scraper used text-based pdf-parse for answer PDFs, which can mis-parse
 * halfwidth concatenated answers or tabular formats. This script re-parses
 * answer PDFs using position-based pdfjsLib for verification.
 *
 * Also applies corrections from t=M PDFs (更正答案).
 *
 * Usage:
 *   node scripts/fix-answers-100-105.js              # fix all
 *   node scripts/fix-answers-100-105.js --dry        # dry run
 *   node scripts/fix-answers-100-105.js --exam pt    # single exam
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')

const BACKEND = path.resolve(__dirname, '..')
const CACHE = path.join(BACKEND, '_tmp', 'pdf-cache-100-105')
const DRY_RUN = process.argv.includes('--dry')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true })

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('redirect')) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800) : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Position-based answer parser (pdfjsLib) ───

async function parseAnswersPdfjsLib(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const allItems = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const item of content.items) {
      allItems.push({ x: Math.round(item.transform[4]), y: Math.round(item.transform[5]), page: p, str: item.str })
    }
  }
  allItems.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)

  // Group into rows
  const rows = []
  let curY = null, curRow = []
  for (const item of allItems) {
    if (curY === null || Math.abs(item.y - curY) > 3) {
      if (curRow.length) rows.push(curRow)
      curRow = [item]; curY = item.y
    } else { curRow.push(item) }
  }
  if (curRow.length) rows.push(curRow)

  const answers = {}

  // Method 1: Tabular format (第N題 row + answer letter row)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const nums = []
    for (const item of row) {
      const m = item.str.match(/第(\d+)題/)
      if (m) nums.push({ num: parseInt(m[1]), x: item.x })
    }
    if (nums.length >= 3 && i + 1 < rows.length) {
      const ansRow = rows[i + 1]
      const letters = ansRow.filter(r => /^[A-D]$/.test(r.str.trim())).sort((a, b) => a.x - b.x)
      nums.sort((a, b) => a.x - b.x)
      for (let j = 0; j < Math.min(nums.length, letters.length); j++) {
        answers[nums[j].num] = letters[j].str.trim()
      }
    }
  }
  if (Object.keys(answers).length >= 20) return answers

  // Method 2: Fullwidth continuous (答案ＡＢＣＤ... possibly with ＃)
  const fullText = allItems.map(r => r.str).join('')
  const fw = /答案\s*([ＡＢＣＤ＃]+)/g
  let m, n = 1
  while ((m = fw.exec(fullText)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
      else if (ch === '＃') n++ // corrected, skip
    }
  }
  if (Object.keys(answers).length >= 20) return answers

  // Method 3: Halfwidth continuous (答案ABCD... possibly with #)
  const hw = /答案\s*([A-D#]{10,})/gi
  n = 1
  while ((m = hw.exec(fullText)) !== null) {
    for (const ch of m[1]) {
      if (/[A-D]/i.test(ch)) answers[n] = ch.toUpperCase()
      n++
    }
  }
  return answers
}

// ─── Corrections parser ───

function parseCorrections(text) {
  const corrections = {}
  for (const line of text.split(/\n/)) {
    // 一律給分 / 送分
    const give = line.match(/第?\s*(\d{1,2})\s*題.*(?:一律給分|送分)/i)
    if (give) { corrections[parseInt(give[1])] = '*'; continue }

    // 更正答案 to specific letter
    const change = line.match(/第?\s*(\d{1,2})\s*題.*(?:更正|答案).*([A-DＡ-Ｄ])/i)
    if (change) {
      let ans = change[2]
      ans = ans.replace('Ａ', 'A').replace('Ｂ', 'B').replace('Ｃ', 'C').replace('Ｄ', 'D')
      corrections[parseInt(change[1])] = ans
      continue
    }

    // 答X或Y均給分 (give credit for multiple)
    const multi = line.match(/第?\s*(\d{1,2})\s*題.*答\s*([A-DＡ-Ｄ])\s*[或、]\s*([A-DＡ-Ｄ])/i)
    if (multi) {
      let ans = multi[2]
      ans = ans.replace('Ａ', 'A').replace('Ｂ', 'B').replace('Ｃ', 'C').replace('Ｄ', 'D')
      corrections[parseInt(multi[1])] = ans // use first acceptable answer
      continue
    }
  }
  return corrections
}

// ─── Target definitions (same as scrape-100-105.js) ───

function buildTargets(filterExam) {
  const targets = []

  function add(examId, file, year, code, classCode, subjects) {
    if (filterExam && filterExam !== examId) return
    targets.push({ examId, file, year, code, classCode, subjects })
  }

  // Doctor1
  add('doctor1', 'questions.json', '100', '100030', '101', [
    { s: '0101', tag: 'anatomy' }, { s: '0102', tag: 'pathology' }])
  add('doctor1', 'questions.json', '101', '101030', '101', [
    { s: '0101', tag: 'anatomy' }, { s: '0102', tag: 'pathology' }])

  // Doctor2
  add('doctor2', 'questions-doctor2.json', '101', '101030', '102', [
    { s: '0103', tag: 'internal_medicine' }, { s: '0104', tag: 'pediatrics' },
    { s: '0105', tag: 'surgery' }, { s: '0106', tag: 'medical_law_ethics' }])

  // Pharma1
  const p1s = [{ s: '0201', tag: 'pharmacology' }, { s: '0202', tag: 'pharmaceutical_analysis' }, { s: '0204', tag: 'pharmaceutics' }]
  add('pharma1', 'questions-pharma1.json', '100', '100030', '103', p1s)
  add('pharma1', 'questions-pharma1.json', '101', '101030', '103', p1s)
  add('pharma1', 'questions-pharma1.json', '103', '103090', '312', [
    { s: '11', tag: 'pharmacology' }, { s: '22', tag: 'pharmaceutical_analysis' }, { s: '33', tag: 'pharmaceutics' }])
  add('pharma1', 'questions-pharma1.json', '104', '104020', '312', [
    { s: '11', tag: 'pharmacology' }, { s: '22', tag: 'pharmaceutical_analysis' }, { s: '33', tag: 'pharmaceutics' }])

  // Pharma2
  const p2s = [{ s: '0203', tag: 'dispensing' }, { s: '0205', tag: 'pharmacotherapy' }, { s: '0206', tag: 'pharmacy_law' }]
  add('pharma2', 'questions-pharma2.json', '100', '100030', '103', p2s)
  add('pharma2', 'questions-pharma2.json', '101', '101030', '103', p2s)

  // Medlab 030 series
  const mls030 = [
    { s: '0107', tag: 'clinical_physio_path' }, { s: '0301', tag: 'hematology' },
    { s: '0302', tag: 'molecular' }, { s: '0303', tag: 'microbiology' },
    { s: '0304', tag: 'biochemistry' }, { s: '0305', tag: 'serology' }]
  add('medlab', 'questions-medlab.json', '100', '100030', '104', mls030)
  add('medlab', 'questions-medlab.json', '101', '101030', '104', mls030)
  // Medlab 020 series
  const mls020 = [
    { s: '11', tag: 'clinical_physio_path' }, { s: '22', tag: 'hematology' },
    { s: '33', tag: 'molecular' }, { s: '44', tag: 'microbiology' },
    { s: '55', tag: 'biochemistry' }, { s: '66', tag: 'serology' }]
  add('medlab', 'questions-medlab.json', '102', '102100', '311', mls020)
  add('medlab', 'questions-medlab.json', '103', '103020', '311', mls020)
  add('medlab', 'questions-medlab.json', '103', '103090', '311', mls020)
  add('medlab', 'questions-medlab.json', '104', '104020', '311', mls020)

  // PT 030 series
  const pts030 = [
    { s: '0501', tag: 'pt_basic' }, { s: '0502', tag: 'pt_intro' },
    { s: '0503', tag: 'pt_technique' }, { s: '0504', tag: 'pt_neuro' },
    { s: '0505', tag: 'pt_ortho' }, { s: '0506', tag: 'pt_cardio_peds' }]
  add('pt', 'questions-pt.json', '100', '100030', '106', pts030)
  // PT 020 series
  const pts020 = [
    { s: '11', tag: 'pt_basic' }, { s: '22', tag: 'pt_intro' },
    { s: '33', tag: 'pt_technique' }, { s: '44', tag: 'pt_neuro' },
    { s: '55', tag: 'pt_ortho' }, { s: '66', tag: 'pt_cardio_peds' }]
  add('pt', 'questions-pt.json', '101', '101010', '309', pts020)
  add('pt', 'questions-pt.json', '101', '101100', '309', pts020)
  add('pt', 'questions-pt.json', '102', '102020', '309', pts020)
  add('pt', 'questions-pt.json', '102', '102100', '309', pts020)
  add('pt', 'questions-pt.json', '103', '103020', '309', pts020)
  add('pt', 'questions-pt.json', '103', '103090', '309', pts020)
  add('pt', 'questions-pt.json', '104', '104020', '309', pts020)

  // TCM1
  add('tcm1', 'questions-tcm1.json', '100', '100030', '107', [
    { s: '0601', tag: 'tcm_basic_1' }, { s: '0602', tag: 'tcm_basic_2' }])
  add('tcm1', 'questions-tcm1.json', '101', '101030', '106', [
    { s: '0501', tag: 'tcm_basic_1' }, { s: '0502', tag: 'tcm_basic_2' }])
  add('tcm1', 'questions-tcm1.json', '104', '104100', '101', [
    { s: '0101', tag: 'tcm_basic_1' }, { s: '0102', tag: 'tcm_basic_2' }])
  add('tcm1', 'questions-tcm1.json', '105', '105030', '101', [
    { s: '0101', tag: 'tcm_basic_1' }, { s: '0102', tag: 'tcm_basic_2' }])
  add('tcm1', 'questions-tcm1.json', '105', '105090', '101', [
    { s: '0101', tag: 'tcm_basic_1' }, { s: '0102', tag: 'tcm_basic_2' }])

  // TCM2
  add('tcm2', 'questions-tcm2.json', '100', '100030', '107', [
    { s: '0603', tag: 'tcm_clinical_1' }, { s: '0604', tag: 'tcm_clinical_2' },
    { s: '0605', tag: 'tcm_clinical_3' }, { s: '0606', tag: 'tcm_clinical_4' }])
  add('tcm2', 'questions-tcm2.json', '101', '101030', '106', [
    { s: '0503', tag: 'tcm_clinical_1' }, { s: '0504', tag: 'tcm_clinical_2' },
    { s: '0505', tag: 'tcm_clinical_3' }, { s: '0506', tag: 'tcm_clinical_4' }])
  add('tcm2', 'questions-tcm2.json', '104', '104100', '102', [
    { s: '0103', tag: 'tcm_clinical_1' }, { s: '0104', tag: 'tcm_clinical_2' },
    { s: '0105', tag: 'tcm_clinical_3' }, { s: '0106', tag: 'tcm_clinical_4' }])
  add('tcm2', 'questions-tcm2.json', '105', '105030', '102', [
    { s: '0103', tag: 'tcm_clinical_1' }, { s: '0104', tag: 'tcm_clinical_2' },
    { s: '0105', tag: 'tcm_clinical_3' }, { s: '0106', tag: 'tcm_clinical_4' }])
  add('tcm2', 'questions-tcm2.json', '105', '105090', '102', [
    { s: '0103', tag: 'tcm_clinical_1' }, { s: '0104', tag: 'tcm_clinical_2' },
    { s: '0105', tag: 'tcm_clinical_3' }, { s: '0106', tag: 'tcm_clinical_4' }])

  // Nursing
  add('nursing', 'questions-nursing.json', '101', '101030', '105', [
    { s: '0108', tag: 'basic_medicine' }, { s: '0401', tag: 'basic_nursing' },
    { s: '0402', tag: 'med_surg' }, { s: '0403', tag: 'obs_ped' },
    { s: '0404', tag: 'psych_community' }])
  const nrs104 = [
    { s: '0501', tag: 'basic_medicine' }, { s: '0502', tag: 'basic_nursing' },
    { s: '0503', tag: 'med_surg' }, { s: '0504', tag: 'obs_ped' },
    { s: '0505', tag: 'psych_community' }]
  add('nursing', 'questions-nursing.json', '104', '104100', '106', nrs104)
  add('nursing', 'questions-nursing.json', '105', '105030', '106', nrs104)
  add('nursing', 'questions-nursing.json', '105', '105090', '106', nrs104)

  // Nutrition
  add('nutrition', 'questions-nutrition.json', '101', '101030', '107', [
    { s: '0601', tag: 'physio_biochem' }, { s: '0602', tag: 'nutrition_science' },
    { s: '0603', tag: 'diet_therapy' }, { s: '0604', tag: 'group_meal' },
    { s: '0605', tag: 'public_nutrition' }, { s: '0606', tag: 'food_safety' }])
  const nut104 = [
    { s: '0201', tag: 'physio_biochem' }, { s: '0202', tag: 'nutrition_science' },
    { s: '0203', tag: 'diet_therapy' }, { s: '0204', tag: 'group_meal' },
    { s: '0205', tag: 'public_nutrition' }, { s: '0206', tag: 'food_safety' }]
  add('nutrition', 'questions-nutrition.json', '104', '104100', '103', nut104)
  add('nutrition', 'questions-nutrition.json', '105', '105030', '103', nut104)
  add('nutrition', 'questions-nutrition.json', '105', '105090', '103', nut104)

  // Social Worker
  const sws = [{ s: '0601', tag: 'social_work' }, { s: '0602', tag: 'social_work_direct' }, { s: '0603', tag: 'social_work_mgmt' }]
  add('social-worker', 'questions-social-worker.json', '104', '104100', '107', sws)
  add('social-worker', 'questions-social-worker.json', '105', '105030', '107', sws)
  add('social-worker', 'questions-social-worker.json', '105', '105090', '107', sws)

  // Dental1 020 series
  const d1s = [{ s: '11', tag: 'dental_anatomy' }, { s: '22', tag: 'oral_pathology' }]
  add('dental1', 'questions-dental1.json', '100', '100020', '301', d1s)
  add('dental1', 'questions-dental1.json', '101', '101010', '301', d1s)
  add('dental1', 'questions-dental1.json', '101', '101100', '301', d1s)
  add('dental1', 'questions-dental1.json', '102', '102020', '301', d1s)
  add('dental1', 'questions-dental1.json', '102', '102100', '301', d1s)
  add('dental1', 'questions-dental1.json', '103', '103020', '301', d1s)
  add('dental1', 'questions-dental1.json', '103', '103090', '301', d1s)
  add('dental1', 'questions-dental1.json', '104', '104020', '301', d1s)

  // OT 020 series
  const ots = [
    { s: '11', tag: 'ot_anatomy' }, { s: '22', tag: 'ot_intro' },
    { s: '33', tag: 'ot_physical' }, { s: '44', tag: 'ot_mental' },
    { s: '55', tag: 'ot_pediatric' }, { s: '66', tag: 'ot_technique' }]
  add('ot', 'questions-ot.json', '101', '101010', '305', ots)
  add('ot', 'questions-ot.json', '101', '101100', '305', ots)
  add('ot', 'questions-ot.json', '102', '102020', '305', ots)
  add('ot', 'questions-ot.json', '102', '102100', '305', ots)
  add('ot', 'questions-ot.json', '103', '103020', '305', ots)
  add('ot', 'questions-ot.json', '103', '103090', '305', ots)
  add('ot', 'questions-ot.json', '104', '104020', '305', ots)

  // Radiology 020 series
  const rads = [
    { s: '11', tag: 'basic_medicine' }, { s: '22', tag: 'med_physics' },
    { s: '33', tag: 'radio_instruments' }, { s: '44', tag: 'radio_diagnosis' },
    { s: '55', tag: 'radio_therapy' }, { s: '66', tag: 'nuclear_medicine' }]
  add('radiology', 'questions-radiology.json', '100', '100020', '308', rads)
  add('radiology', 'questions-radiology.json', '101', '101010', '308', rads)
  add('radiology', 'questions-radiology.json', '101', '101100', '308', rads)
  add('radiology', 'questions-radiology.json', '102', '102020', '308', rads)
  add('radiology', 'questions-radiology.json', '102', '102100', '308', rads)
  add('radiology', 'questions-radiology.json', '103', '103020', '308', rads)
  add('radiology', 'questions-radiology.json', '103', '103090', '308', rads)
  add('radiology', 'questions-radiology.json', '104', '104020', '308', rads)

  return targets
}

// ─── Cached PDF getter ───

async function getCachedPdf(kind, code, classCode, s) {
  const fname = `${kind}_${code}_c${classCode}_s${s}.pdf`
  const fpath = path.join(CACHE, fname)
  if (fs.existsSync(fpath) && fs.statSync(fpath).size > 500) return fs.readFileSync(fpath)
  const url = `${BASE}?t=${kind}&code=${code}&c=${classCode}&s=${s}&q=1`
  const buf = await fetchPdf(url)
  fs.writeFileSync(fpath, buf)
  return buf
}

// ─── Main ───

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const examIdx = process.argv.indexOf('--exam')
  const filterExam = examIdx >= 0 ? process.argv[examIdx + 1] : null

  const targets = buildTargets(filterExam)
  console.log(`${targets.length} targets to verify`)

  // Group by file
  const byFile = {}
  for (const t of targets) {
    if (!byFile[t.file]) byFile[t.file] = []
    byFile[t.file].push(t)
  }

  let grandFixed = 0

  for (const [file, fileTargets] of Object.entries(byFile)) {
    const filePath = path.join(BACKEND, file)
    if (!fs.existsSync(filePath)) {
      console.log(`⚠ ${file} not found`)
      continue
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const questions = data.questions || (Array.isArray(data) ? data : [])
    let fileChanged = false
    let fileFixes = 0

    console.log(`\n═══ ${file} ═══`)

    for (const t of fileTargets) {
      for (const sub of t.subjects) {
        // Get answer PDF — try S, then A, then M
        let answers = {}
        for (const ansType of ['S', 'A']) {
          if (Object.keys(answers).length >= 20) break
          try {
            const aBuf = await getCachedPdf(ansType, t.code, t.classCode, sub.s)
            const parsed = await parseAnswersPdfjsLib(aBuf)
            if (Object.keys(parsed).length > Object.keys(answers).length) answers = parsed
          } catch { /* try next */ }
          await sleep(150)
        }

        // Try corrections PDF for answers + corrections
        let corrections = {}
        try {
          const mBuf = await getCachedPdf('M', t.code, t.classCode, sub.s)
          const mText = (await pdfParse(mBuf)).text
          corrections = parseCorrections(mText)

          // Also try extracting base answers from corrections PDF
          if (Object.keys(answers).length < 20) {
            const fromM = await parseAnswersPdfjsLib(mBuf)
            if (Object.keys(fromM).length > Object.keys(answers).length) answers = fromM
          }
        } catch { /* no corrections */ }

        // Apply corrections to answers
        for (const [num, ans] of Object.entries(corrections)) {
          if (ans !== '*') answers[parseInt(num)] = ans
        }

        if (Object.keys(answers).length < 5) continue

        // Find matching questions
        const matchQ = questions.filter(q =>
          q.exam_code === t.code && q.subject_tag === sub.tag &&
          String(q.roc_year) === String(t.year)
        )
        if (matchQ.length === 0) continue

        let fixes = 0
        for (const q of matchQ) {
          const correct = answers[q.number]
          if (!correct) continue

          // Mark disputed
          if (corrections[q.number] === '*' && !q.disputed) {
            if (!DRY_RUN) q.disputed = true
            fixes++; fileChanged = true
          }

          // Fix answer
          if (q.answer !== correct && correct !== '*') {
            if (!DRY_RUN) q.answer = correct
            fixes++; fileChanged = true
          }
        }

        if (fixes > 0) {
          console.log(`  ${t.year} ${t.code} ${sub.tag}: ${fixes} fixes (${Object.keys(answers).length} ref answers, ${matchQ.length} Q)`)
        }
        fileFixes += fixes
      }
    }

    if (fileChanged && !DRY_RUN) {
      if (data.questions) data.total = data.questions.length
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, filePath)
      console.log(`  💾 Saved ${file} (${fileFixes} total fixes)`)
    } else if (fileFixes === 0) {
      console.log(`  ✓ No fixes needed`)
    }

    grandFixed += fileFixes
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Total: ${grandFixed} fixes`)
}

main().catch(e => { console.error(e); process.exit(1) })
