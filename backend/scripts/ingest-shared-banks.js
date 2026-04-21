#!/usr/bin/env node
// Ingest customs/judicial 法學知識 → common_constitution / common_law_basics / common_english
// Usage: node scripts/ingest-shared-banks.js [--dry-run]

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DRY = process.argv.includes('--dry-run')
const BANKS_DIR = path.join(__dirname, '..', 'shared-banks')

// Normalize for SHA1 dedup: NFKC + fullwidth punct → halfwidth + strip spaces
const FULLWIDTH = { '（':'(','）':')','，':',','。':'.','：':':','；':';','？':'?','！':'!','「':'"','」':'"','『':'"','』':'"','、':',' }
function normalize(s) {
  if (!s) return ''
  let n = s.normalize('NFKC')
  for (const [k,v] of Object.entries(FULLWIDTH)) n = n.split(k).join(v)
  return n.replace(/\s+/g, '').trim()
}

function hashQuestion(q) {
  const parts = [normalize(q.question)]
  for (const k of ['A','B','C','D']) parts.push(normalize((q.options||{})[k]||''))
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex')
}

function isEnglish(q) {
  const opts = ['A','B','C','D'].map(k => (q.options||{})[k]||'').join('')
  if (!opts.length) return false
  const ascii = opts.replace(/[^\x20-\x7E]/g, '').length
  return ascii / opts.length > 0.7
}

// Sources config
const SOURCES = [
  { file: 'questions-customs.json',  exam: 'customs',  level: 'senior', subject: '法學知識',
    split: { constitution: [1,25], law_basics: [26,50] } },
  { file: 'questions-customs.json',  exam: 'customs',  level: 'senior', subject: '英文',
    split: { english: [1,100] } },
  { file: 'questions-customs.json',  exam: 'customs',  level: 'senior', subject: '國文（測驗）',
    split: { chinese: [1,100] } },
  { file: 'questions-judicial.json', exam: 'judicial', level: 'senior', subject: '法學知識與英文',
    split: { constitution: [1,15], law_basics: [16,30], english: [31,50] } },
  { file: 'questions-civil-senior.json', exam: 'civil-senior', level: 'senior', subject: '法學知識與英文',
    split: { constitution: [1,15], law_basics: [16,30], english: [31,50] } },
  { file: 'questions-civil-senior.json', exam: 'civil-senior', level: 'senior', subject: '國文（測驗）',
    split: { chinese: [1,100] } },
  { file: 'questions-civil-senior.json', exam: 'civil-senior', level: 'senior', subject: '行政學',
    split: { admin_studies: [1,200] } },
  { file: 'questions-civil-senior.json', exam: 'civil-senior', level: 'senior', subject: '行政法',
    split: { admin_law: [1,200] } },
  { file: 'questions-police.json', exam: 'police', level: 'senior', subject: '行政學',
    split: { admin_studies: [1,200] } },
  { file: 'questions-police.json', exam: 'police', level: 'senior', subject: '行政法',
    split: { admin_law: [1,200] } },
]

function classify(q, split) {
  // Only auto-route to english when english is a legitimate bucket for this
  // source (mixed law+english papers). Pure-subject sources like 行政學 list
  // only one bucket in their split, so isEnglish must not hijack them —
  // otherwise questions with ASCII-heavy options (acronyms, citations) drift
  // into common_english.
  if (split.english && isEnglish(q)) return 'english'
  for (const [bucket, [lo, hi]] of Object.entries(split)) {
    if (q.number >= lo && q.number <= hi) return bucket
  }
  return 'unknown'
}

// Load existing bank (or skeleton if new)
function loadBank(bankId, defaults) {
  const fp = path.join(BANKS_DIR, bankId + '.json')
  if (fs.existsSync(fp)) {
    const b = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    b.questions = b.questions || []
    b.levels = b.levels || []
    return { fp, bank: b, existed: true }
  }
  return { fp, bank: {
    bankId,
    name: defaults.name,
    description: defaults.description,
    bankVersion: 0,
    last_synced_at: null,
    levels: [],
    questions: [],
  }, existed: false }
}

function main() {
  const banks = {
    common_constitution: loadBank('common_constitution', {
      name: '中華民國憲法',
      description: '公職考試共通科目：中華民國憲法（含大法官解釋、憲法法庭判決、增修條文）',
    }),
    common_law_basics: loadBank('common_law_basics', {
      name: '法學緒論 / 法學大意',
      description: '公職考試共通科目：法學緒論、法學大意',
    }),
    common_english: loadBank('common_english', {
      name: '公職英文',
      description: '公職考試共通科目：英文（字彙、文法、克漏字、閱讀測驗）',
    }),
    common_chinese: loadBank('common_chinese', {
      name: '公職國文',
      description: '公職考試共通科目：國文（閱讀測驗、公文格式、修辭）',
    }),
    common_admin_studies: loadBank('common_admin_studies', {
      name: '行政學',
      description: '公職考試三等／特考共通科目：行政學（含組織理論、人事、財務、政策等）',
    }),
    common_admin_law: loadBank('common_admin_law', {
      name: '行政法',
      description: '公職考試三等／特考共通科目：行政法（含行政程序法、行政救濟、訴願等）',
    }),
  }

  // Pre-seed seen hashes from existing bank content (so repeated ingest is idempotent)
  const seen = new Map() // hash -> {bank, srcExam, srcNumber}
  for (const [bankId, entry] of Object.entries(banks)) {
    for (const q of entry.bank.questions) {
      const h = hashQuestion(q)
      if (!seen.has(h)) seen.set(h, { bank: bankId, srcExam: q.source_exam_code, srcNumber: q.number })
    }
  }

  const stats = {}
  const suspicious = [] // question-start overlap but different SHA1
  const skipped = []    // dedup-skipped
  const unknown = []
  const questionStarts = new Map() // first 30 chars → [{bank, source, hash}]

  for (const src of SOURCES) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', src.file), 'utf-8'))
    const qs = data.questions.filter(q => q.subject === src.subject)
    const statKey = `${src.exam}/${src.subject}`
    stats[statKey] = { total: qs.length, constitution: 0, law_basics: 0, english: 0, chinese: 0, admin_studies: 0, admin_law: 0, unknown: 0, skipped: 0, added: 0 }

    for (const q of qs) {
      const bucket = classify(q, src.split)
      stats[statKey][bucket]++
      if (bucket === 'unknown') { unknown.push({ src: src.exam, exam_code: q.exam_code, n: q.number, q: q.question.slice(0,50) }); continue }

      const h = hashQuestion(q)
      const start = normalize(q.question).slice(0, 30)

      // Check suspicious overlap
      if (questionStarts.has(start)) {
        for (const prev of questionStarts.get(start)) {
          if (prev.hash !== h) suspicious.push({ a: prev, b: { bank: 'common_'+bucket, srcExam: src.exam, n: q.number, hash: h }, start })
        }
      }

      const targetBank = 'common_' + bucket
      if (seen.has(h)) {
        const prev = seen.get(h)
        skipped.push({ bank: targetBank, srcExam: src.exam, n: q.number, dupOf: prev })
        stats[statKey].skipped++
        continue
      }

      const bankId = targetBank
      const tag = bucket
      const newQ = {
        id: `${bankId}-${q.roc_year}-${src.exam}-${q.number}`,
        roc_year: q.roc_year,
        session: q.session,
        source_exam_code: src.exam,
        source_exam_name: data.metadata?.name || src.exam,
        subject: q.subject,
        subject_tags: [tag],
        number: q.number,
        question: q.question,
        options: q.options,
        answer: q.answer,
        level: src.level,
        shared_bank: bankId,
        parent_id: null,
        case_context: null,
        is_deprecated: !!q.disputed,
        deprecated_reason: q.disputed ? '送分題' : null,
      }

      banks[bankId].bank.questions.push(newQ)
      if (!banks[bankId].bank.levels.includes(src.level)) banks[bankId].bank.levels.push(src.level)
      seen.set(h, { bank: bankId, srcExam: src.exam, srcNumber: q.number })
      const arr = questionStarts.get(start) || []
      arr.push({ bank: bankId, srcExam: src.exam, n: q.number, hash: h })
      questionStarts.set(start, arr)
      stats[statKey].added++
    }
  }

  // Sort each bank: by (source_exam, roc_year desc, number asc)
  for (const entry of Object.values(banks)) {
    entry.bank.questions.sort((a,b) => {
      if (a.source_exam_code !== b.source_exam_code) return a.source_exam_code.localeCompare(b.source_exam_code)
      if (a.roc_year !== b.roc_year) return b.roc_year.localeCompare(a.roc_year)
      return a.number - b.number
    })
  }

  // Print report
  console.log('\n════════════ INGEST REPORT ' + (DRY ? '(DRY RUN)' : '(WRITE)') + ' ════════════\n')
  for (const src of SOURCES) {
    const s = stats[`${src.exam}/${src.subject}`]
    console.log(`[${src.exam}/${src.subject}] total=${s.total}  constitution=${s.constitution}  law_basics=${s.law_basics}  english=${s.english}  chinese=${s.chinese}  unknown=${s.unknown}  skipped=${s.skipped}  added=${s.added}`)
  }
  console.log('\nBank output:')
  for (const [bankId, entry] of Object.entries(banks)) {
    const bySource = {}
    for (const q of entry.bank.questions) bySource[q.source_exam_code] = (bySource[q.source_exam_code]||0)+1
    console.log(`  ${bankId}: total=${entry.bank.questions.length}  levels=${JSON.stringify(entry.bank.levels)}  bySource=${JSON.stringify(bySource)}`)
  }

  if (unknown.length) {
    console.log(`\n⚠ unknown (${unknown.length}):`)
    for (const u of unknown.slice(0, 5)) console.log(`  ${u.src} ${u.exam_code} q${u.n}: ${u.q}`)
  }

  if (suspicious.length) {
    console.log(`\n⚠ suspicious-overlap (${suspicious.length}, 同開頭不同 SHA1):`)
    for (const s of suspicious.slice(0, 10)) {
      console.log(`  [${s.a.bank}] ${s.a.srcExam} q${s.a.n}  vs  [${s.b.bank}] ${s.b.srcExam} q${s.b.n}  start="${s.start}"`)
    }
  }

  console.log(`\n🔁 dedup-skipped: ${skipped.length}`)
  for (const s of skipped.slice(0, 5)) {
    console.log(`  ${s.bank} ${s.srcExam} q${s.n} → dup of ${s.dupOf.bank} ${s.dupOf.srcExam} q${s.dupOf.srcNumber}`)
  }

  // Dry-run samples: 5 questions per bucket per source
  if (DRY) {
    console.log('\n──────── CLASSIFICATION SAMPLES ────────')
    for (const src of SOURCES) {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', src.file), 'utf-8'))
      const qs = data.questions.filter(q => q.subject === src.subject)
      const byBucket = { constitution: [], law_basics: [], english: [] }
      for (const q of qs) {
        const b = classify(q, src.split)
        if (byBucket[b] && byBucket[b].length < 5) byBucket[b].push(q)
      }
      for (const [bucket, samples] of Object.entries(byBucket)) {
        if (!samples.length) continue
        console.log(`\n[${src.exam} → ${bucket}]`)
        for (const q of samples) console.log(`  ${q.exam_code} Q${q.number}: ${q.question.slice(0, 70).replace(/\n/g,' ')}`)
      }
    }
    console.log('\n(dry-run — nothing written. Re-run without --dry-run to commit.)\n')
    return
  }

  // Write banks
  const now = new Date().toISOString()
  for (const [bankId, entry] of Object.entries(banks)) {
    entry.bank.bankVersion = (entry.bank.bankVersion || 0) + 1
    entry.bank.last_synced_at = now
    fs.writeFileSync(entry.fp + '.tmp', JSON.stringify(entry.bank, null, 2))
    fs.renameSync(entry.fp + '.tmp', entry.fp)
    console.log(`✓ wrote ${entry.fp} (v${entry.bank.bankVersion}, ${entry.bank.questions.length} Q)`)
  }

  // Write logs
  fs.writeFileSync(path.join(BANKS_DIR, '_ingest-skipped.log'), JSON.stringify(skipped, null, 2))
  fs.writeFileSync(path.join(BANKS_DIR, '_ingest-suspicious.log'), JSON.stringify(suspicious, null, 2))
  fs.writeFileSync(path.join(BANKS_DIR, '_ingest-unknown.log'), JSON.stringify(unknown, null, 2))
  console.log('\n✅ done')
}

main()
