#!/usr/bin/env node
/**
 * 經濟部國營事業聯招題庫爬蟲（台電官網來源）
 *
 *   共同科目「英文」40 單選   → shared-banks/common_state_english.json
 *   各類別 科目A 50 單選      → questions-state-<slug>.json
 * 科目B（申論／計算）由 scrape-taipower-essay.js 另外存檔，此處不收。
 *
 * 索引 _taipower-index.json 由 probe-taipower.js 產生：每個年度×類別
 * 收錄多個「候選 PDF」（各年命名不一），本爬蟲逐一解析、取題數最多者。
 *
 * Usage:
 *   node scripts/scrape-taipower.js
 *   node scripts/scrape-taipower.js --category 企管
 *   node scripts/scrape-taipower.js --year 108
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { cachedFetch } = require('./lib/pdf-fetcher')
const { atomicWriteJson, withLock } = require('./lib/atomic-write')
const { parseTaipowerPdf } = require('./lib/taipower-parser')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const INDEX_FILE = path.join(ROOT, '_tmp', '_taipower-index.json')
const CACHE_DIR = path.join(ROOT, '_tmp', 'taipower-cache')
const REFERER = 'https://www.taipower.com.tw/2289/2544/2554/2556/'

// 100–102 年試題為掃描圖檔（無文字層）→ 需 OCR，暫不收
const YEARS = ['103', '104', '105', '106', '107', '108', '109', '110', '111', '112', '113', '114']

const CATEGORIES = {
  '企管': { examId: 'state-mgmt', tag: 'state_mgmt', subjectName: '企業概論、法學緒論' },
  '人資': { examId: 'state-hr', tag: 'state_hr', subjectName: '企業管理、法學緒論' },
  '財會': { examId: 'state-finance', tag: 'state_finance', subjectName: '政府採購法規、會計審計法規' },
  '資訊': { examId: 'state-it', tag: 'state_it', subjectName: '計算機原理、網路概論' },
}

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) {
    console.log('索引不存在，先執行 probe-taipower.js …')
    execFileSync(process.execPath, [path.join(__dirname, 'probe-taipower.js')], { stdio: 'inherit' })
  }
  return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'))
}

// 逐一解析候選 PDF，回傳題數最多的解析結果
async function bestParse(candidates) {
  let best = []
  for (const url of candidates || []) {
    try {
      const buf = await cachedFetch(url, CACHE_DIR, { referer: REFERER, timeout: 40000 })
      const { text } = await pdfParse(buf)
      const parsed = parseTaipowerPdf(text)
      if (parsed.length > best.length) best = parsed
    } catch { /* 壞檔／掃描檔 → 跳過 */ }
  }
  return best
}

async function scrapeCategory(catName, index, filterYear, dryRun) {
  const cat = CATEGORIES[catName]
  const questions = []
  for (const year of YEARS) {
    if (filterYear && year !== filterYear) continue
    const slot = index[year] && index[year][catName]
    if (!slot || !slot.mcq || !slot.mcq.length) { console.log(`  ${year} ${catName}: 索引無候選`); continue }
    if (dryRun) { console.log(`  ${year} ${catName}: ${slot.mcq.length} 候選`); continue }
    const parsed = await bestParse(slot.mcq)
    let kept = 0, unknown = 0
    for (const q of parsed) {
      const answerKnown = !!q.answer
      if (!answerKnown) unknown++
      questions.push({
        id: `${cat.examId}-${year}-${q.number}`,
        roc_year: year,
        session: '第一次',
        exam_code: `taipower-${year}`,
        subject: '專業科目',
        subject_tag: cat.tag,
        subject_name: cat.subjectName,
        stage_id: 0,
        number: q.number,
        question: q.question,
        options: q.options,
        answer: q.answer || 'A',
        explanation: '',
        ...(q.disputed ? { disputed: true } : {}),
        ...(answerKnown ? {} : { incomplete: true }),   // 純送分無答案 → 排除出題池
        ...(q.case_context ? { case_context: q.case_context } : {}),
      })
      kept++
    }
    console.log(`  ${year} ${catName}: ${kept} 題${unknown ? `（${unknown} 純送分）` : ''}`)
    await new Promise(r => setTimeout(r, 200))
  }

  if (dryRun || questions.length === 0) return questions.length
  const outFile = path.join(ROOT, `questions-${cat.examId}.json`)
  withLock(outFile, () => atomicWriteJson(outFile, {
    metadata: { exam: cat.examId, label: `國營聯招 ${catName}`, scraped_at: new Date().toISOString(), source: 'taipower.com.tw' },
    total: questions.length,
    questions,
  }))
  console.log(`✅ ${cat.examId}: ${questions.length} 題 → questions-${cat.examId}.json`)
  return questions.length
}

async function scrapeEnglish(index, filterYear, dryRun) {
  const bankFile = path.join(ROOT, 'shared-banks', 'common_state_english.json')
  let bank = fs.existsSync(bankFile)
    ? JSON.parse(fs.readFileSync(bankFile, 'utf-8'))
    : {
        bankId: 'common_state_english',
        name: '國營聯招英文',
        description: '經濟部國營事業聯招 共同科目「英文」測驗題（字彙、文法、克漏字、閱讀測驗），103–114 年。',
        bankVersion: 0, last_synced_at: null, levels: ['state'], questions: [],
      }
  const byId = new Map(bank.questions.map(q => [q.id, q]))

  for (const year of YEARS) {
    if (filterYear && year !== filterYear) continue
    const slot = index[year] && index[year]['共同科目']
    if (!slot || !slot.mcq || !slot.mcq.length) { console.log(`  ${year} 共同英文: 索引無候選`); continue }
    if (dryRun) { console.log(`  ${year} 共同英文: ${slot.mcq.length} 候選`); continue }
    const parsed = await bestParse(slot.mcq)
    let kept = 0
    for (const q of parsed) {
      const id = `common_state_english-${year}-${q.number}`
      const answerKnown = !!q.answer
      byId.set(id, {
        id, roc_year: year, session: '第一次',
        source_exam_code: 'taipower',
        source_exam_name: `${year} 年經濟部國營事業聯招`,
        subject: '英文', subject_tags: ['state_english'],
        number: q.number, question: q.question, options: q.options,
        answer: q.answer || 'A',
        case_context: q.case_context || null,
        level: 'state', shared_bank: 'common_state_english',
        parent_id: null, is_deprecated: false, deprecated_reason: null,
        ...(q.disputed ? { disputed: true } : {}),
        ...(answerKnown ? {} : { incomplete: true }),
      })
      kept++
    }
    console.log(`  ${year} 共同英文: ${kept} 題`)
    await new Promise(r => setTimeout(r, 200))
  }

  if (dryRun) return 0
  bank.questions = Array.from(byId.values())
  bank.description = '經濟部國營事業聯招 共同科目「英文」測驗題（字彙、文法、克漏字、閱讀測驗），103–114 年。'
  bank.bankVersion = (Number(bank.bankVersion) || 0) + 1
  bank.last_synced_at = new Date().toISOString()
  withLock(bankFile, () => atomicWriteJson(bankFile, bank))
  console.log(`✅ common_state_english: ${bank.questions.length} 題 (v${bank.bankVersion})`)
  return bank.questions.length
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const catFilter = args.includes('--category') ? args[args.indexOf('--category') + 1] : null
  const filterYear = args.includes('--year') ? args[args.indexOf('--year') + 1] : null

  const index = loadIndex()
  console.log(`\n${'='.repeat(60)}\n  經濟部國營聯招爬蟲（${YEARS[0]}–${YEARS[YEARS.length - 1]}）${dryRun ? ' (dry-run)' : ''}\n${'='.repeat(60)}`)

  console.log('\n── 共同科目 英文（shared bank）──')
  await scrapeEnglish(index, filterYear, dryRun)

  for (const catName of Object.keys(CATEGORIES)) {
    if (catFilter && catName !== catFilter) continue
    console.log(`\n── ${catName} 科目A ──`)
    await scrapeCategory(catName, index, filterYear, dryRun)
  }
  console.log('\n完成。')
}

main().catch(e => { console.error(e); process.exit(1) })
