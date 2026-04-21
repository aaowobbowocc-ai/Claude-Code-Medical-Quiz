#!/usr/bin/env node
// Parse PaddleOCR output in _tmp/ocr_json/ and merge reconstructed questions into
// questions-tcm1.json (102-2 中醫基礎醫學二, missing Qs only) and
// questions-nursing.json (108-1 精神/社區衛生護理學, whole paper).
//
// Answers sourced from _tmp/ocr_pdfs/*_S.pdf (already downloaded).

const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')

const ROOT = path.resolve(__dirname, '..')
const OCR_DIR = path.join(ROOT, '_tmp', 'ocr_json')
const PDF_DIR = path.join(ROOT, '_tmp', 'ocr_pdfs')
const TCM1_FILE = path.join(ROOT, 'questions-tcm1.json')
const NURSING_FILE = path.join(ROOT, 'questions-nursing.json')

const TCM1_TARGET = {
  label: 'tcm1 102-2 中醫基礎醫學(二)',
  exam_code: '102110',
  roc_year: '102',
  session: '第二次',
  subject: '中醫基礎醫學(二)',
  subject_tag: 'tcm_basic_2',
  pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `tcm1_p${n}.json`),
  pdfS: 'tcm1_102-2_basic2_S.pdf',
  onlyMissing: [6, 40, 50, 51, 59, 60, 65, 77, 78, 79, 80],
  bankFile: TCM1_FILE,
}

const NURSING_TARGET = {
  label: 'nursing 108-1 精神/社區衛生護理學',
  exam_code: '108020',
  roc_year: '108',
  session: '第一次',
  subject: '精神科與社區衛生護理學',
  subject_tag: 'psych_community',
  pages: [1, 2, 3, 4, 5, 6, 7, 8].map(n => `nursing_p${n}.json`),
  pdfS: 'nursing_108-1_psych_S.pdf',
  onlyMissing: null, // take all reconstructable
  bankFile: NURSING_FILE,
}

// --- text cleaning ---
const stripPUA = s => s.replace(/[\uE000-\uF8FF]/g, '')
const normalize = s => stripPUA(String(s || ''))
  .replace(/\u3000/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

// Full-width → half-width for option markers
const toHalf = s => s
  .replace(/Ａ/g, 'A').replace(/Ｂ/g, 'B').replace(/Ｃ/g, 'C').replace(/Ｄ/g, 'D')
  .replace(/（/g, '(').replace(/）/g, ')')

// --- answer PDF parsers ---

// tcm1 S.pdf: "答案DABDD..." sequence runs of 20
async function parseTcm1Answers() {
  const buf = fs.readFileSync(path.join(PDF_DIR, TCM1_TARGET.pdfS))
  const text = (await pdfParse(buf)).text
  const rows = text.match(/答案[A-D#]+/g) || []
  const ans = {}
  let n = 1
  for (const r of rows) {
    const seq = r.replace(/^答案/, '')
    for (const ch of seq) {
      if (/[A-D#]/.test(ch)) { if (n <= 80) ans[n] = ch; n++ }
    }
  }
  return ans
}

// nursing S.pdf: grid with 題號 labels and answer letters offset vertically.
// Match letter to nearest label by x within ±25px and y-diff 5..35.
async function parseNursingAnswers() {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(path.join(PDF_DIR, NURSING_TARGET.pdfS))
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const items = []
  for (let pi = 0; pi < doc.countPages(); pi++) {
    const parsed = JSON.parse(doc.loadPage(pi).toStructuredText('preserve-images').asJSON())
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of b.lines || []) {
        const t = (ln.text || '').trim()
        if (!t) continue
        items.push({ y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), t })
      }
    }
  }
  const labels = []
  const letters = []
  for (const it of items) {
    const m = it.t.match(/^第(\d+)題$/)
    if (m) { labels.push({ num: +m[1], x: it.x, y: it.y }); continue }
    if (/^[A-D#＃]$/.test(it.t)) letters.push({ letter: it.t === '＃' ? '#' : it.t, x: it.x, y: it.y })
  }
  const ans = {}
  for (const lbl of labels) {
    if (lbl.num > 80) continue
    let best = null
    for (const a of letters) {
      const dx = Math.abs(a.x - lbl.x)
      const dy = a.y - lbl.y
      if (dx <= 25 && dy >= 5 && dy <= 35) {
        if (!best || dy < best.dy) best = { letter: a.letter, dy }
      }
    }
    if (best) ans[lbl.num] = best.letter
  }
  return ans
}

// --- OCR JSON → question blocks ---

// Find anchors (question numbers) in a page's boxes.
function findAnchors(boxes) {
  const out = []
  for (const b of boxes) {
    if (b.xmin > 180) continue
    if (b.cy < 100) continue
    const t = normalize(b.text)
    const m = t.match(/^(\d{1,3})(?:[.、．]|)$/)
    if (!m) continue
    const num = +m[1]
    if (num < 1 || num > 80) continue
    // Anchor text must be short
    if (t.length > 3) continue
    out.push({ num, cy: b.cy })
  }
  return out
}

// Split a question block into stem + options using (A)(B)(C)(D) markers.
function splitBlock(blockBoxes) {
  // Sort boxes top-to-bottom, left-to-right with cy banding (±20)
  // Critical: the "first" box in each row must be the leftmost regardless of small cy jitter,
  // otherwise option (A) at x<250 loses priority to (B/C/D) earlier-cy boxes.
  const sorted = blockBoxes.slice().sort((a, b) => {
    if (Math.abs(a.cy - b.cy) <= 20) return a.xmin - b.xmin
    return a.cy - b.cy
  })

  // Identify option-marker boxes. Markers appear as "(A)", "(A)text", or just "A)" variants.
  // Heuristic: a box is an option-marker if its text starts with ["(" optional] + letter + [")"|"」"]
  // AND it sits at a left-edge position (xmin < 320 for column-1 or xmin 680-2000 for columns 2-4).
  const markerIdx = []
  for (let i = 0; i < sorted.length; i++) {
    const raw = normalize(sorted[i].text)
    const t = toHalf(raw)
    // Primary: "(A)..." or "(A..." — paren may be stripped by OCR
    let m = t.match(/^\s*\(?([ABCD])[)）」]\s*(.*)$/)
    if (!m) continue
    // Guard: avoid matching stem text where a letter happens to appear mid-sentence.
    // Require the box to be short-ish for the marker-only case, OR have few chars before match.
    // We'll filter later by confirming we get exactly-one marker per letter in the right order.
    markerIdx.push({ i, letter: m[1], inlineText: m[2], box: sorted[i] })
  }
  if (markerIdx.length < 4) return null

  // Keep only the first 4 in A,B,C,D order for strictness but also tolerate duplicates
  // by picking the earliest occurrence of each letter.
  const firstOf = {}
  for (const m of markerIdx) {
    if (!firstOf[m.letter]) firstOf[m.letter] = m
  }
  for (const L of ['A', 'B', 'C', 'D']) if (!firstOf[L]) return null

  // Stem = all boxes before the (A) marker's box index.
  // Stem ends at the earliest of any option marker's index (not just A, since OCR reading
  // order can put options out-of-order when they sit on the same row).
  const firstMarkerIdx = Math.min(firstOf.A.i, firstOf.B.i, firstOf.C.i, firstOf.D.i)
  const aIdx = firstMarkerIdx
  const stemBoxes = sorted.slice(0, aIdx)
  // Skip stray short-glyph boxes (single ASCII letter/punct orphans from OCR quotation-mark artifacts)
  const cleanStemParts = []
  for (const sb of stemBoxes) {
    const t = normalize(sb.text)
    if (!t) continue
    // single ASCII cap-letter boxes floating in middle (like stray "C」" artifacts) — skip
    if (/^[A-Z]$/.test(t) && sb.xmin > 400) continue
    if (/^[」』"'.]$/.test(t)) continue
    cleanStemParts.push(t)
  }
  const stem = normalize(toHalf(cleanStemParts.join('')))

  // Build option text by collecting boxes from this marker's position until the next option
  // marker's position (in reading order). Since options may share a row (2×2 grid), we
  // collect boxes in the "forward direction" from one marker to the next.
  const ordered = ['A', 'B', 'C', 'D'].map(L => firstOf[L])
  const opts = { A: '', B: '', C: '', D: '' }
  for (let k = 0; k < 4; k++) {
    const cur = ordered[k]
    const next = ordered[k + 1]
    // Collect cur.inlineText plus any following boxes in sorted order that belong to cur.
    let txt = cur.inlineText || ''
    // The "box" sequence between cur.i and the next marker's i: include boxes whose reading
    // order is after cur.i but BEFORE the next marker, AND are on same row as cur (for grid)
    // OR below cur and above any later marker.
    // Simpler: attribute each non-marker box to the option whose marker has the closest same-row
    //          or preceding position. We'll do this per-box.
    opts[cur.letter] = txt
  }

  // For each non-marker box, find which option it belongs to.
  const markerSet = new Set(markerIdx.map(m => m.i))
  for (let i = 0; i < sorted.length; i++) {
    if (markerSet.has(i)) continue
    if (i < aIdx) continue // stem territory
    const bx = sorted[i]
    // Find the marker (from firstOf.A,B,C,D) to which this box belongs.
    // Rule: pick the marker that is (a) on the same row (|cy - bx.cy| <= 20) and has
    //       the largest xmin that is still <= bx.xmin; otherwise, if the box is below
    //       all markers on a later row, use the marker directly above with matching column.
    let best = null
    for (const L of ['A', 'B', 'C', 'D']) {
      const m = firstOf[L]
      const mb = m.box
      // Same row?
      if (Math.abs(mb.cy - bx.cy) <= 25) {
        if (mb.xmin <= bx.xmin) {
          if (!best || mb.xmin > best.mb.xmin) best = { L, mb }
        }
      }
    }
    if (!best) {
      // Below-line assignment: pick the marker immediately above (largest cy <= bx.cy)
      // with the same column (|xmin diff| < 120); fallback: largest cy <= bx.cy.
      let above = null
      for (const L of ['A', 'B', 'C', 'D']) {
        const m = firstOf[L]
        const mb = m.box
        if (mb.cy <= bx.cy + 5) {
          const colOK = Math.abs(mb.xmin - bx.xmin) < 250
          if (!above || mb.cy > above.mb.cy ||
              (mb.cy === above.mb.cy && colOK && Math.abs(mb.xmin - bx.xmin) < Math.abs(above.mb.xmin - bx.xmin))) {
            above = { L, mb, colOK }
          }
        }
      }
      if (above) best = above
    }
    if (!best) continue
    opts[best.L] += normalize(bx.text)
  }

  // Clean the option texts
  for (const L of ['A', 'B', 'C', 'D']) {
    opts[L] = normalize(toHalf(opts[L])).replace(/^[\s.、．:：]+/, '').trim()
  }

  return {
    stem,
    options: opts,
  }
}

// Build question blocks from a page's OCR boxes and a list of anchors.
function buildBlocksFromPage(boxes, anchors) {
  if (!anchors.length) return {}
  const sortedAnchors = anchors.slice().sort((a, b) => a.cy - b.cy)
  const out = {}
  for (let ai = 0; ai < sortedAnchors.length; ai++) {
    const a = sortedAnchors[ai]
    const nextCy = ai + 1 < sortedAnchors.length ? sortedAnchors[ai + 1].cy : Infinity
    // Anchor's row: take boxes whose cy is in [a.cy - 5, nextCy - 1] but skip the anchor-number box itself
    // The stem usually starts on the same line as the anchor.
    const block = boxes.filter(b => {
      if (b.cy < a.cy - 15) return false
      // Exclude anything on the next anchor's row (same line as next Q's anchor number)
      if (nextCy !== Infinity && b.cy >= nextCy - 20) return false
      // Skip the anchor box (short number text at xmin<180 with same cy)
      const t = normalize(b.text)
      if (t === String(a.num) && b.xmin < 180 && Math.abs(b.cy - a.cy) < 20) return false
      return true
    })
    const split = splitBlock(block)
    if (split) out[a.num] = split
  }
  return out
}

// --- main ---

async function processTarget(target, answers, existingBank) {
  const reconstructed = {}
  const skipReasons = {}

  for (const pageFile of target.pages) {
    const fp = path.join(OCR_DIR, pageFile)
    if (!fs.existsSync(fp)) {
      console.warn(`  [skip] ${pageFile} missing`)
      continue
    }
    const boxes = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const anchors = findAnchors(boxes)
    const blocks = buildBlocksFromPage(boxes, anchors)
    for (const num of Object.keys(blocks)) {
      if (reconstructed[num]) continue
      reconstructed[num] = blocks[num]
    }
  }

  // Validate; filter by onlyMissing if applicable.
  const candidateNums = target.onlyMissing || [...Array(80)].map((_, i) => i + 1)
  const accepted = []
  for (const num of candidateNums) {
    const b = reconstructed[num]
    if (!b) { skipReasons[num] = 'no block reconstructed'; continue }
    const { stem, options } = b
    if (!stem || stem.length < 8) { skipReasons[num] = `stem too short (${stem?.length})`; continue }
    const allOpts = ['A', 'B', 'C', 'D'].every(L => options[L] && options[L].length >= 1)
    if (!allOpts) {
      skipReasons[num] = `missing options: ${['A','B','C','D'].filter(L=>!options[L]||!options[L].length).join(',')}`
      continue
    }
    const ans = answers[num]
    if (!ans || !/^[A-D#]$/.test(ans)) {
      skipReasons[num] = `no answer letter from PDF (got ${JSON.stringify(ans)})`
      continue
    }
    accepted.push({ num, stem, options, answer: ans === '#' ? 'A' : ans, disputed: ans === '#' })
  }

  // Dedup against existing bank
  const bankArr = existingBank.questions || existingBank
  const existingKey = new Set(bankArr
    .filter(q => q.exam_code === target.exam_code && q.subject_tag === target.subject_tag)
    .map(q => q.number))

  const toAdd = []
  for (const a of accepted) {
    if (existingKey.has(a.num)) {
      skipReasons[a.num] = 'already in bank'
      continue
    }
    const subjTagPart = target.subject_tag.includes('tcm_basic_2') ? '0202'
      : target.subject_tag === 'psych_community' ? '0505'
      : '0001'
    toAdd.push({
      id: `${target.exam_code}_${subjTagPart}_${a.num}`,
      roc_year: target.roc_year,
      session: target.session,
      exam_code: target.exam_code,
      subject: target.subject,
      subject_tag: target.subject_tag,
      subject_name: target.subject,
      stage_id: 0,
      number: a.num,
      question: a.stem,
      options: a.options,
      answer: a.answer,
      explanation: '',
      ...(a.disputed ? { disputed: true } : {}),
    })
  }

  return { toAdd, skipReasons, accepted }
}

function atomicWrite(file, obj) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, file)
}

async function main() {
  const tcm1Answers = await parseTcm1Answers()
  const nurseAnswers = await parseNursingAnswers()

  console.log('tcm1 answers:', Object.keys(tcm1Answers).length, '/ 80')
  console.log('nursing answers:', Object.keys(nurseAnswers).length, '/ 80')

  const tcm1Bank = JSON.parse(fs.readFileSync(TCM1_FILE, 'utf8'))
  const nurseBank = JSON.parse(fs.readFileSync(NURSING_FILE, 'utf8'))

  // TCM1
  console.log(`\n=== ${TCM1_TARGET.label} ===`)
  const tcm1Res = await processTarget(TCM1_TARGET, tcm1Answers, tcm1Bank)
  console.log('  accepted:', tcm1Res.accepted.length, 'toAdd:', tcm1Res.toAdd.length)
  console.log('  skipped:', Object.entries(tcm1Res.skipReasons).map(([n, r]) => `Q${n}: ${r}`).join('\n    '))
  // Sample 3
  for (const s of tcm1Res.toAdd.slice(0, 3)) {
    console.log('  sample Q' + s.number + ':', s.question.slice(0, 60))
    console.log('    A:', s.options.A, '| B:', s.options.B, '| C:', s.options.C, '| D:', s.options.D, '| ans=' + s.answer)
  }

  // Nursing
  console.log(`\n=== ${NURSING_TARGET.label} ===`)
  const nurseRes = await processTarget(NURSING_TARGET, nurseAnswers, nurseBank)
  console.log('  accepted:', nurseRes.accepted.length, 'toAdd:', nurseRes.toAdd.length)
  console.log('  total skipped reasons count:', Object.keys(nurseRes.skipReasons).length)
  // Print only numbers we couldn't take
  const nurseSkip = Object.entries(nurseRes.skipReasons).filter(([n, r]) => r !== 'already in bank')
  console.log('  skipped (not in bank):', nurseSkip.map(([n, r]) => `Q${n}: ${r}`).join('\n    '))
  if (process.argv.includes('--dump-nursing')) {
    for (const s of nurseRes.toAdd) {
      console.log(`Q${s.number} [${s.answer}] ${s.question}`)
      console.log(`  A=${s.options.A}`)
      console.log(`  B=${s.options.B}`)
      console.log(`  C=${s.options.C}`)
      console.log(`  D=${s.options.D}`)
    }
  }
  const samples = [nurseRes.toAdd[0], nurseRes.toAdd[1], nurseRes.toAdd[2]].filter(Boolean)
  for (const s of samples) {
    console.log('  sample Q' + s.number + ':', s.question.slice(0, 80))
    console.log('    A:', s.options.A)
    console.log('    B:', s.options.B)
    console.log('    C:', s.options.C)
    console.log('    D:', s.options.D, '| ans=' + s.answer)
  }

  // Write banks
  if (process.argv.includes('--write')) {
    tcm1Bank.questions.push(...tcm1Res.toAdd)
    tcm1Bank.total = tcm1Bank.questions.length
    if (tcm1Bank.metadata) tcm1Bank.metadata.total = tcm1Bank.questions.length
    atomicWrite(TCM1_FILE, tcm1Bank)
    console.log(`\n[write] questions-tcm1.json now has ${tcm1Bank.questions.length} questions`)

    nurseBank.questions.push(...nurseRes.toAdd)
    nurseBank.total = nurseBank.questions.length
    if (nurseBank.metadata) nurseBank.metadata.total = nurseBank.questions.length
    atomicWrite(NURSING_FILE, nurseBank)
    console.log(`[write] questions-nursing.json now has ${nurseBank.questions.length} questions`)
  } else {
    console.log('\n(dry-run; pass --write to persist)')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
