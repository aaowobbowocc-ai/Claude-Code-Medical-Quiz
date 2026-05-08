#!/usr/bin/env node
/**
 * Patrol scan: walk every questions-*.json (except questions-pt.json and questions-ot.json
 * which are reserved by the PT/OT classifier), categorise unanswerable items into:
 *   A. truly_broken     incomplete:true OR gap_reason set
 *   B. empty_options    options.A/B/C/D contain ""
 *   C. missing_image    question text references "圖" but no image_url + images empty
 *   D. broken_image_url image_url points to a file that does not exist on disk
 *   E. cross_contam     question text > 200 chars and contains 「下列何者」 multiple times
 *
 * Writes:
 *   backend/_tmp/patrol-scan.json
 */
const fs = require('fs')
const path = require('path')

const BACKEND = path.join(__dirname, '..')
const PUBLIC_IMG_DIR = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')

const SKIP = new Set(['questions-pt.json', 'questions-ot.json'])

const EXAM_OF_FILE = {
  'questions.json':                'doctor1',
  'questions-doctor2.json':        'doctor2',
  'questions-nursing.json':        'nursing',
  'questions-nutrition.json':      'nutrition',
  'questions-medlab.json':         'medlab',
  'questions-dental1.json':        'dental1',
  'questions-dental2.json':        'dental2',
  'questions-pharma1.json':        'pharma1',
  'questions-pharma2.json':        'pharma2',
  'questions-radiology.json':      'radiology',
  'questions-rt.json':             'rt',
  'questions-tcm1.json':           'tcm1',
  'questions-tcm2.json':           'tcm2',
  'questions-vet.json':            'vet',
  'questions-customs.json':        'customs',
  'questions-judicial.json':       'judicial',
  'questions-lawyer1.json':        'lawyer1',
  'questions-civil-senior.json':   'civil-senior',
  'questions-police.json':         'police',
  'questions-police4.json':        'police4',
  'questions-audiologist.json':    'audiologist',
  'questions-speech-therapist.json': 'speech-therapist',
  'questions-social-worker.json':  'social-worker',
  'questions-ast.json':            'ast',
  'questions-driver-car.json':     'driver-car',
  'questions-driver-moto.json':    'driver-moto',
  'questions-driver-moto-hazard.json': 'driver-moto-hazard',
  'questions-gsat.json':           'gsat',
}

function isEmpty(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
}

function imageWebpExists(imageUrl) {
  if (!imageUrl) return false
  // "/question-images/foo.webp" -> "foo.webp"
  const m = imageUrl.match(/\/question-images\/([^/?#]+)/)
  if (!m) return false
  const filename = decodeURIComponent(m[1])
  const fp = path.join(PUBLIC_IMG_DIR, filename)
  return fs.existsSync(fp)
}

const PIC_KEYWORDS = ['如圖', '下圖', '附圖', '右圖', '左圖', '上圖', '本圖', '此圖', '圖示', '依下圖', '依圖', '見圖', '所示之圖', '依據下圖']

function mentionsImage(text) {
  if (!text) return false
  return PIC_KEYWORDS.some(k => text.includes(k))
}

function countSubstr(text, sub) {
  if (!text) return 0
  let n = 0, i = 0
  while ((i = text.indexOf(sub, i)) !== -1) { n++; i += sub.length }
  return n
}

function classifyQuestion(q) {
  const tags = []

  // A. truly broken — only flag if incomplete is "true" (real broken),
  // NOT image_options (a valid schema for image-based questions)
  if (q.incomplete === true || q.incomplete === 'true') {
    tags.push('truly_broken')
  }
  // gap_reason set: only flag if not already overridden by image_url presence
  if (q.gap_reason && !q.image_url && !(q.images && q.images.length)) tags.push('truly_broken')

  // B. empty options
  const opts = q.options || {}
  const letters = ['A', 'B', 'C', 'D']
  const hasMC = letters.some(l => l in opts)
  const emptyLetters = letters.filter(l => l in opts && isEmpty(opts[l]))
  // Driver license is intentionally 3-option: A/B/C populated, D empty by design
  const isDriver3Opt = !isEmpty(opts.A) && !isEmpty(opts.B) && !isEmpty(opts.C)
    && isEmpty(opts.D) && emptyLetters.length === 1 && emptyLetters[0] === 'D'
    && (q.id && (String(q.id).startsWith('moto_') || String(q.id).startsWith('car_')))
  if (hasMC && emptyLetters.length > 0 && !isDriver3Opt) tags.push('empty_options:' + emptyLetters.join(''))

  // C. mentions image but no image
  const hasImageUrl = !isEmpty(q.image_url)
  const hasImages = Array.isArray(q.images) && q.images.length > 0
  if (mentionsImage(q.question) && !hasImageUrl && !hasImages) tags.push('missing_image')

  // D. broken image_url (file 404)
  if (hasImageUrl && q.image_url.startsWith('/question-images/')) {
    if (!imageWebpExists(q.image_url)) tags.push('broken_image_url')
  }

  // E. cross-contam (long text + multiple 下列何者)
  const qText = q.question || ''
  if (qText.length > 200 && countSubstr(qText, '下列何者') >= 2) tags.push('cross_contam')

  return tags
}

function main() {
  const files = fs.readdirSync(BACKEND).filter(f => /^questions-.*\.json$/.test(f) || f === 'questions.json')
  const include = files.filter(f => !SKIP.has(f) && !f.endsWith('.bak') && !f.endsWith('.bak2') && !f.endsWith('.bak3'))

  const summary = {
    scanned_files: 0,
    total_questions: 0,
    total_flagged: 0,
    by_category: {
      truly_broken: 0,
      empty_options: 0,
      missing_image: 0,
      broken_image_url: 0,
      cross_contam: 0,
    },
    by_exam: {},
  }
  const flagged = []

  for (const fname of include) {
    const examId = EXAM_OF_FILE[fname] || fname.replace(/^questions-|\.json$/g, '')
    const fp = path.join(BACKEND, fname)
    let raw, arr
    try { raw = JSON.parse(fs.readFileSync(fp, 'utf8')) } catch (e) {
      console.error(`SKIP ${fname}: ${e.message}`)
      continue
    }
    if (Array.isArray(raw)) arr = raw
    else if (raw && Array.isArray(raw.questions)) arr = raw.questions
    else if (raw && Array.isArray(raw.data)) arr = raw.data
    else {
      console.error(`SKIP ${fname}: cannot find questions array`)
      continue
    }
    summary.scanned_files++
    summary.total_questions += arr.length
    summary.by_exam[examId] = summary.by_exam[examId] || { total: 0, flagged: 0, cats: {} }
    summary.by_exam[examId].total += arr.length

    for (const q of arr) {
      const tags = classifyQuestion(q)
      if (tags.length === 0) continue
      summary.total_flagged++
      summary.by_exam[examId].flagged++
      for (const t of tags) {
        const head = t.split(':')[0]
        summary.by_category[head] = (summary.by_category[head] || 0) + 1
        summary.by_exam[examId].cats[head] = (summary.by_exam[examId].cats[head] || 0) + 1
      }
      flagged.push({
        examId,
        file: fname,
        id: q.id,
        roc_year: q.roc_year,
        session: q.session,
        exam_code: q.exam_code,
        subject: q.subject,
        number: q.number,
        tags,
        // tiny preview for diagnostics
        question_preview: (q.question || '').slice(0, 120),
        options: q.options ? {
          A: (q.options.A || '').slice(0, 40),
          B: (q.options.B || '').slice(0, 40),
          C: (q.options.C || '').slice(0, 40),
          D: (q.options.D || '').slice(0, 40),
        } : null,
        image_url: q.image_url || null,
        incomplete: q.incomplete || null,
      })
    }
    console.log(`scanned ${fname}: ${arr.length} qs, flagged so far ${summary.by_exam[examId].flagged}`)
  }

  const tmpDir = path.join(BACKEND, '_tmp')
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'patrol-scan.json'), JSON.stringify({ summary, flagged }, null, 2))
  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`\nWrote ${flagged.length} flagged items to backend/_tmp/patrol-scan.json`)
}

main()
