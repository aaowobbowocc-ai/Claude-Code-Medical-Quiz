#!/usr/bin/env node
// Tier-1 nursing / medlab gap-fill.
//
// Verified targets (after probing c-codes 2026-04):
//   - nursing 103100 c=109 s=0501..0504   (4 papers × 80 Qs; JSON had only 40/each — fills Qs 41-80)
//   - nursing 103030 c=109 s=0501..0504   (top-up whatever is missing)
//   - nursing 108020 c=106 s=0501..0505   (fills med_surg 16/29/80, adds psych_community)
//   - medlab  102020                       (no medlab class in this session — documented, skipped)
//
// 類科 verification uses regex matching /類科(?:名稱)?[：:]/ line (full-width spaces common).
// Parser: parseColumnAware for ≤ 105 年; standard text parser for ≥ 106 年.
// Answer fallback: t=S → t=M → t=A. Full-width → half-width conversion.
// De-dup against existing JSON by (exam_code, subject_tag, number) AND (question text).

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseColumnAware } = require('./lib/moex-column-parser')

const NURSING_FILE = path.join(__dirname, '..', 'questions-nursing.json')

const NURSING_SUBJECTS = [
  { s: '0501', subject: '基本護理學與護理行政', tag: 'basic_nursing', keyword: '基本護理' },
  { s: '0502', subject: '內外科護理學',         tag: 'med_surg',      keyword: '內外科' },
  { s: '0503', subject: '產兒科護理學',         tag: 'obs_ped',       keyword: '產兒科' },
  { s: '0504', subject: '精神科與社區衛生護理學', tag: 'psych_community', keyword: '精神科' },
]
// For 108020 c=106: the psych paper appears at s=0505 per probe
const NURSING_108020_SUBJECTS = [
  { s: '0501', subject: '基礎醫學',             tag: 'basic_medicine', keyword: '基礎醫學' },
  { s: '0502', subject: '基本護理學與護理行政', tag: 'basic_nursing',  keyword: '基本護理' },
  { s: '0503', subject: '內外科護理學',         tag: 'med_surg',       keyword: '內外科' },
  { s: '0504', subject: '產兒科護理學',         tag: 'obs_ped',        keyword: '產兒科' },
  { s: '0505', subject: '精神科與社區衛生護理學', tag: 'psych_community', keyword: '精神科' },
]

const TARGETS = [
  { bank: 'nursing', year: '103', session: '第二次', code: '103100', c: '109', useColumn: true,  subjects: NURSING_SUBJECTS },
  { bank: 'nursing', year: '103', session: '第一次', code: '103030', c: '109', useColumn: true,  subjects: NURSING_SUBJECTS },
  { bank: 'nursing', year: '104', session: '第一次', code: '104030', c: '109', useColumn: true,  subjects: NURSING_SUBJECTS },
  { bank: 'nursing', year: '108', session: '第一次', code: '108020', c: '106', useColumn: false, subjects: NURSING_108020_SUBJECTS },
]

function download(url) {
  return new Promise((res, rej) => {
    https.get(url, { rejectUnauthorized: false }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400) return rej(new Error('redir ' + r.statusCode))
      const cs = []
      r.on('data', c => cs.push(c))
      r.on('end', () => res(Buffer.concat(cs)))
      r.on('error', rej)
    }).on('error', rej)
  })
}

async function tryDownload(url) {
  try { return await download(url) } catch { return null }
}

function verifyExam(text, expectedKey /* '護理師' */, subjectKeyword) {
  // NFKC normalization handles CJK Compatibility Ideographs (e.g. U+F9E4 → U+7406 理);
  // many-full-width spaces in "類  科：" are matched via [\s　]*.
  const norm = (text || '').normalize('NFKC')
  const classLine = norm.match(/類[\s　]*科(?:名稱)?[\s　]*[：:][\s　]*([^\n]+)/)
  const subjLine  = norm.match(/科[\s　]*目(?:名稱)?[\s　]*[：:][\s　]*([^\n]+)/)
  const className = classLine ? classLine[1].trim() : ''
  const subjName  = subjLine  ? subjLine[1].trim()  : ''
  const ok = className.includes(expectedKey) && (subjectKeyword ? subjName.includes(subjectKeyword) : true)
  return { ok, className, subjName }
}

// Full-width to half-width
const toHalf = s => s
  .replace(/Ａ/g, 'A').replace(/Ｂ/g, 'B').replace(/Ｃ/g, 'C').replace(/Ｄ/g, 'D')
  .replace(/＃/g, '#').replace(/　/g, ' ')

function parseAnswers(text, total) {
  // Primary: "答案：ABCDAC..." sequence runs
  const answers = {}
  const rows = text.match(/答[\s　]*案[\s　]*[：:]?[\s　]*([ＡＢＣＤ#＃A-D][ＡＢＣＤ#＃A-D\s　]*)/g) || []
  let n = 1
  for (const row of rows) {
    const body = row.replace(/^答[\s　]*案[\s　]*[：:]?[\s　]*/, '')
    const seq = toHalf(body).replace(/\s+/g, '')
    for (const ch of seq) {
      if (!/[A-D#]/.test(ch)) continue
      if (n <= total) answers[n] = ch
      n++
    }
  }
  if (Object.keys(answers).length < Math.min(20, total - 5)) {
    // Secondary: "1. A" / "1 A" patterns
    const hw = /(\d{1,3})\s*[.\s、．:：]\s*([A-Da-d＃#])/g
    let m
    while ((m = hw.exec(text)) !== null) {
      const num = parseInt(m[1])
      if (num >= 1 && num <= total) answers[num] = toHalf(m[2]).toUpperCase()
    }
  }

  const disputed = new Set()
  const corrections = {}
  // 備註: 第N題一律給分 / 第N題答X,Y給分
  const noteMatch = text.match(/備[\s　]*註[\s　]*[：:]([^\n]+(?:\n[^\n備]+)*)/)
  if (noteMatch) {
    const block = noteMatch[1]
    for (const m of block.matchAll(/第\s*(\d+)\s*題一律給分/g)) disputed.add(parseInt(m[1]))
    for (const m of block.matchAll(/第\s*(\d+)\s*題[^，,。]*答[\s　]*([ABCDＡＢＣＤ])[、,．．]([ABCDＡＢＣＤ])/g)) {
      disputed.add(parseInt(m[1]))
      corrections[parseInt(m[1])] = toHalf(m[2])
    }
  }
  return { answers, disputed, corrections }
}

// Fallback single-column text parser: used for Qs that parseColumnAware missed.
// Strategy: walk bbox rows, anchor on single "\d{1,3}" at x<60; the next 4 rows
// at comparable x (indent ~80-90) are taken as options verbatim.
async function parseSingleColumnFallback(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const stripPUA = s => s.replace(/[\uE000-\uF8FF]/g, '')
  const out = {}
  const allLines = []
  let yOff = 0
  for (let pi = 0; pi < doc.countPages(); pi++) {
    const parsed = JSON.parse(doc.loadPage(pi).toStructuredText('preserve-images').asJSON())
    const pageLines = []
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = stripPUA(ln.text || '').trim()
        if (!t) continue
        pageLines.push({
          y: Math.round(ln.bbox.y) + yOff, x: Math.round(ln.bbox.x),
          w: Math.round(ln.bbox.w), text: t,
        })
      }
    }
    pageLines.sort((a, b) => a.y - b.y || a.x - b.x)
    allLines.push(...pageLines)
    yOff += 2000
  }

  // Group into rows
  const rows = []
  for (const ln of allLines) {
    const last = rows[rows.length - 1]
    if (last && Math.abs(last.y - ln.y) <= 5) last.parts.push(ln)
    else rows.push({ y: ln.y, parts: [ln] })
  }
  for (const r of rows) r.parts.sort((a, b) => a.x - b.x)

  // Find question anchors: standalone number at x<60
  const anchors = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const p0 = r.parts[0]
    if (!p0) continue
    const m = p0.text.match(/^(\d{1,3})$/)
    if (!m) continue
    if (p0.x >= 60) continue
    const num = +m[1]
    if (num < 1 || num > 120) continue
    anchors.push({ idx: i, num, y: r.y })
  }

  for (let ai = 0; ai < anchors.length; ai++) {
    const a = anchors[ai]
    const nextA = ai + 1 < anchors.length ? anchors[ai + 1] : null
    const endIdx = nextA ? nextA.idx : rows.length
    const block = rows.slice(a.idx, endIdx)
    // First row: anchor + stem (parts[0]=num, parts[1+]=stem)
    if (!block.length) continue
    const first = block[0]
    // Collect stem rows: rows with stem-indent (x ~= 70-75) until indent jumps to option-indent (~80+)
    // Robust heuristic: stem = block[0] stem part + subsequent rows that start at same x as stem part
    const stemParts = first.parts.slice(1).map(p => p.text)
    const stemStartX = first.parts[1] ? first.parts[1].x : 72
    const optionRows = []
    for (let i = 1; i < block.length; i++) {
      const r = block[i]
      const firstP = r.parts[0]
      if (!firstP) continue
      // If first part x is very close to stem start (within 3px) AND no obvious option spike, treat as stem continuation
      if (Math.abs(firstP.x - stemStartX) <= 3 && optionRows.length === 0) {
        stemParts.push(r.parts.map(p => p.text).join(''))
      } else {
        optionRows.push(r)
      }
    }
    // Option rows: ideally 4 (1 per option) or 2/1 wide-gap multi-column rows
    const opts = []
    for (const r of optionRows) {
      // Detect wide-gap multi-col (options on same line)
      if (r.parts.length >= 2) {
        const xs = r.parts.map(p => p.x).sort((x, y) => x - y)
        let hasWideGap = false
        for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 50) { hasWideGap = true; break }
        if (hasWideGap) {
          for (const p of r.parts) opts.push(p.text)
          continue
        }
      }
      opts.push(r.parts.map(p => p.text).join(''))
    }
    if (opts.length < 4) continue
    const question = stemParts.join('').trim()
    if (!question) continue
    out[a.num] = {
      question,
      options: { A: opts[0].trim(), B: opts[1].trim(), C: opts[2].trim(), D: opts[3].trim() },
    }
  }
  return out
}

function dedupKey(q) {
  return `${q.exam_code}|${q.subject_tag}|${q.number}`
}

function textKey(q) {
  return (q.question || '').replace(/\s+/g, '').slice(0, 100)
}

async function scrapeOne(target, sub) {
  const { code, c } = target
  const qUrl = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${code}&c=${c}&s=${sub.s}&q=1`
  const qBuf = await tryDownload(qUrl)
  if (!qBuf) { console.warn(`[${code} s=${sub.s}] Q PDF unreachable`); return [] }
  const qText = (await pdfParse(qBuf)).text
  const v = verifyExam(qText, '護理師', sub.keyword)
  if (!v.ok) {
    console.warn(`[${code} s=${sub.s}] EXAM MISMATCH: 類科=${v.className} 科目=${v.subjName}`)
    return []
  }
  const totalM = qText.match(/本科目共\s*(\d+)\s*題/)
  const total = totalM ? parseInt(totalM[1]) : 80

  const parsed = await parseColumnAware(qBuf)
  // For any missing question number, try the single-column fallback parser.
  const fallback = await parseSingleColumnFallback(qBuf)
  for (const k of Object.keys(fallback)) {
    if (!parsed[k] || !parsed[k].options || !parsed[k].options.A || !parsed[k].options.D) {
      const f = fallback[k]
      if (f && f.question && f.options.A && f.options.B && f.options.C && f.options.D) {
        parsed[k] = f
      }
    }
  }

  // Answer PDF: t=S → M → A
  let aBuf = null
  for (const t of ['S', 'M', 'A']) {
    const b = await tryDownload(`https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=${t}&code=${code}&c=${c}&s=${sub.s}&q=1`)
    if (b) { aBuf = b; break }
  }
  if (!aBuf) { console.warn(`[${code} s=${sub.s}] no answer PDF`); return [] }
  const aText = (await pdfParse(aBuf)).text
  const { answers, disputed, corrections } = parseAnswers(aText, total)

  const results = []
  const nums = Object.keys(parsed).map(n => parseInt(n)).sort((a, b) => a - b)
  for (const num of nums) {
    if (num < 1 || num > total) continue
    const p = parsed[num]
    if (!p || !p.question || !p.options.A || !p.options.B || !p.options.C || !p.options.D) continue
    const ansRaw = answers[num]
    const ans = corrections[num] || (ansRaw === '#' || ansRaw === '＃' || !ansRaw ? 'A' : ansRaw)
    const q = {
      id: `${code}_${sub.s}_${num}`,
      roc_year: target.year,
      session: target.session,
      exam_code: code,
      subject: sub.subject,
      subject_tag: sub.tag,
      subject_name: sub.subject,
      stage_id: 0,
      number: num,
      question: p.question,
      options: p.options,
      answer: ans,
      explanation: '',
    }
    if (disputed.has(num)) q.disputed = true
    results.push(q)
  }
  console.log(`[${code} s=${sub.s} ${sub.tag}] 題數=${total} parsed=${Object.keys(parsed).length} clean=${results.length}`)
  return results
}

async function main() {
  const bank = JSON.parse(fs.readFileSync(NURSING_FILE, 'utf8'))
  const arr = bank.questions || bank
  console.log('Starting total:', arr.length)

  // Build dedup sets
  const existingKey = new Set(arr.map(dedupKey))
  const existingText = new Set(arr.map(textKey).filter(Boolean))

  const toAdd = []
  for (const target of TARGETS) {
    console.log(`\n--- ${target.bank} ${target.code} (${target.year} ${target.session}) c=${target.c} ---`)
    for (const sub of target.subjects) {
      let got
      try { got = await scrapeOne(target, sub) }
      catch (e) { console.warn(`[${target.code} s=${sub.s}] ERROR: ${e.message}`); continue }
      for (const q of got) {
        if (existingKey.has(dedupKey(q))) continue
        const tk = textKey(q)
        if (tk && existingText.has(tk)) continue
        existingKey.add(dedupKey(q))
        if (tk) existingText.add(tk)
        toAdd.push(q)
      }
    }
  }

  console.log(`\n=== Adding ${toAdd.length} new questions ===`)
  const merged = arr.concat(toAdd)

  const tmp = NURSING_FILE + '.tmp'
  const toWrite = bank.questions ? { ...bank, questions: merged } : merged
  fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2))
  fs.renameSync(tmp, NURSING_FILE)
  console.log(`Wrote ${NURSING_FILE} — total ${merged.length} (delta +${toAdd.length})`)
}

main().catch(e => { console.error(e); process.exit(1) })
