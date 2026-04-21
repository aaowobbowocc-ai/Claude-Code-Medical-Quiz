#!/usr/bin/env node
// Tier-3 gap-fill (2026-04-21):
//
// Handles parser edge cases where options stack vertically at the same x as the stem
// (tier1/tier2 fallback treats them as stem continuation) and single-row 4-column option layouts.
//
// Targets — actual verified gaps (probed 2026-04-21):
//   - nursing  102110 c=109 s=0107 basic_medicine Q30        (single-row 4-col options at x=54/183/309/437)
//   - nursing  102110 c=109 s=0501 basic_nursing   Q5        (vertical options at x=70, same as stem)
//   - nursing  103030 c=109 s=0501 basic_nursing   Q42, Q48  (vertical options at x=72, same as stem)
//   - nutrition 100030 c=108 s=0704 group_meal     Q19       (inline anchor, 2x2 options)
//   - nursing  103100 c=109 s=0502 med_surg        Q63       (2x2 at x=83/323, already extractable — included for idempotency)
//
// NOT fixable without OCR (confirmed image-based options via PUA char analysis):
//   - tcm1 102110 tcm_basic_2 Q6/40/50/51/59/60/65/77/78/79/80 — brief called out these 11 Qs,
//     but probing shows all option slots are PUA U+E18C.. glyphs (embedded images). Needs OCR pipeline.
//
// Verification: 類科 NFKC match. Dedup by (exam_code, subject_tag, number) and question text.
// Only writes a question if all 4 options non-empty and a valid A-D answer exists.

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')

const BACKEND = path.join(__dirname, '..')
const stripPUA = s => (s || '').replace(/[\uE000-\uF8FF]/g, '')

function download(url) {
  return new Promise((res, rej) => {
    https.get(url, { rejectUnauthorized: false }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400) return rej(new Error('redir ' + r.statusCode))
      if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode))
      const cs = []
      r.on('data', c => cs.push(c))
      r.on('end', () => res(Buffer.concat(cs)))
      r.on('error', rej)
    }).on('error', rej)
  })
}
const tryDownload = async url => { try { return await download(url) } catch { return null } }

function verifyExam(text, expectedKey, subjectKeyword) {
  const norm = (text || '').normalize('NFKC')
  const classLine = norm.match(/類[\s　]*科(?:名稱|組別)?[\s　]*[：:][\s　]*([^\n]+)/)
  const subjLine  = norm.match(/科[\s　]*目(?:名稱)?[\s　]*[：:][\s　]*([^\n]+)/)
  const className = classLine ? classLine[1].trim() : ''
  const subjName  = subjLine  ? subjLine[1].trim()  : ''
  const ok = className.includes(expectedKey) && (subjectKeyword ? subjName.includes(subjectKeyword) : true)
  return { ok, className, subjName }
}

const toHalf = s => s
  .replace(/Ａ/g,'A').replace(/Ｂ/g,'B').replace(/Ｃ/g,'C').replace(/Ｄ/g,'D')
  .replace(/＃/g,'#').replace(/　/g,' ')

// Grid-layout answer PDF parser (使用 pdfjsLib 座標解析). 用於像
// 103100 c=109 s=0502 那種「第N題」header row + letter row 的新版答案 PDF。
async function parseAnswersPdfjsLib(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const allItems = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const item of content.items) {
      allItems.push({
        x: Math.round(item.transform[4]),
        y: Math.round(item.transform[5]),
        page: p, str: item.str,
      })
    }
  }
  allItems.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  const rows = []
  let curY = null, curRow = []
  for (const item of allItems) {
    if (curY === null || Math.abs(item.y - curY) > 3) {
      if (curRow.length) rows.push(curRow)
      curRow = [item]; curY = item.y
    } else curRow.push(item)
  }
  if (curRow.length) rows.push(curRow)
  const answers = {}
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
  return answers
}

function parseAnswers(text, total) {
  const answers = {}
  const rows = text.match(/答[\s　]*案[\s　]*[：:]?[\s　]*([ＡＢＣＤ#＃A-D][ＡＢＣＤ#＃A-D\s　]*)/g) || []
  let n = 1
  for (const row of rows) {
    const body = row.replace(/^答[\s　]*案[\s　]*[：:]?[\s　]*/, '')
    const seq = toHalf(body).replace(/\s+/g,'')
    for (const ch of seq) {
      if (!/[A-D#]/.test(ch)) continue
      if (n <= total) answers[n] = ch
      n++
    }
  }
  if (Object.keys(answers).length < Math.min(20, total - 5)) {
    const hw = /(\d{1,3})\s*[.\s、．:：]\s*([A-Da-d＃#])/g
    let m
    while ((m = hw.exec(text)) !== null) {
      const num = parseInt(m[1])
      if (num >= 1 && num <= total) answers[num] = toHalf(m[2]).toUpperCase()
    }
  }
  const disputed = new Set()
  const corrections = {}
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

// Tier-3 extractor: tuned for stacked-vertical options at same x as stem, plus
// single-row 4-col and 2x2 layouts. Uses mupdf bbox info.
//
// Key tweaks vs tier-1/tier-2 fallback:
//   1. Anchor x-threshold tightened to ≤ 52 (previously ≤ 59 caused false "Q3" anchor
//      when option text "3" appeared at x=54 in numeric-answer questions).
//   2. Anchors must be strictly monotonic in num; falsely-decreasing anchors skipped.
//   3. Option-row detection: split each post-stem row by wide-gap (>50px) into columns,
//      collect all columns as option candidates, then take LAST 4 as the 4 options
//      (remaining prior text joins the stem).
async function smartExtract(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const out = {}
  const allLines = []
  let yOff = 0
  for (let pi = 0; pi < doc.countPages(); pi++) {
    const parsed = JSON.parse(doc.loadPage(pi).toStructuredText('preserve-images').asJSON())
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = stripPUA(ln.text || '').trim()
        if (!t) continue
        allLines.push({
          pi, y: Math.round(ln.bbox.y) + yOff, x: Math.round(ln.bbox.x),
          w: Math.round(ln.bbox.w), text: t,
        })
      }
    }
    yOff += 2000
  }
  allLines.sort((a, b) => a.y - b.y || a.x - b.x)

  // Row-group by y (tol 5)
  const rows = []
  for (const ln of allLines) {
    const last = rows[rows.length - 1]
    if (last && Math.abs(last.y - ln.y) <= 5) last.parts.push(ln)
    else rows.push({ y: ln.y, pi: ln.pi, parts: [ln] })
  }
  for (const r of rows) r.parts.sort((a, b) => a.x - b.x)

  // Anchor detection.
  const rawAnchors = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const p0 = r.parts[0]
    if (!p0) continue
    // Tightened x-threshold: real anchors sit at x ≤ 52 in the MoEX PDFs.
    if (p0.x > 52) continue
    let num = null, inlineStem = null
    const m1 = p0.text.match(/^(\d{1,3})$/)
    const m2 = !m1 ? p0.text.match(/^(\d{1,3})\s+(.+)$/) : null
    if (m1) { num = +m1[1] }
    else if (m2) { num = +m2[1]; inlineStem = m2[2] }
    else continue
    if (num < 1 || num > 120) continue
    // Reject page-header false anchors: "100 年…", "102 年…", etc.
    if (inlineStem && /^年|^第\s*\S+\s*次|^\S*(年度|考試|高等|技術人員)/.test(inlineStem)) continue
    rawAnchors.push({ idx: i, num, y: r.y, inlineStem })
  }
  // Keep only anchors whose num is "next question" — skip outliers that jump backwards
  // or leap forward by >10 (likely page headers like "100 年…" when we're at Q16).
  const anchors = []
  let maxSeen = 0
  for (const a of rawAnchors) {
    if (a.num <= maxSeen) continue
    if (maxSeen > 0 && a.num - maxSeen > 10) continue
    anchors.push(a)
    maxSeen = a.num
  }

  for (let ai = 0; ai < anchors.length; ai++) {
    const a = anchors[ai]
    const nextA = ai + 1 < anchors.length ? anchors[ai + 1] : null
    const endIdx = nextA ? nextA.idx : rows.length
    // Filter page-header noise rows
    const block = rows.slice(a.idx, endIdx).filter(r => {
      const txt = r.parts.map(p => p.text).join('')
      if (/^(代號|頁次|科\s*目|類\s*科|等\s*別|本科目共|注意|試題|座號|考試時間|※)/.test(txt)) return false
      return true
    })
    if (!block.length) continue
    const first = block[0]
    const stemParts = a.inlineStem ? [a.inlineStem] : first.parts.slice(1).map(p => p.text)
    const rest = block.slice(1)
    // Stop collecting options at 情況 header / 請依此回答 — question-group intro.
    const filtered = []
    for (const r of rest) {
      const txt = r.parts.map(p => p.text).join('')
      if (/^情況[:：]/.test(txt)) break
      if (/^請依此回答/.test(txt)) break
      if (/^至第\s*\d+\s*題/.test(txt)) break
      filtered.push(r)
    }

    const optParts = []
    for (const r of filtered) {
      // Split by wide-gap (>50px) into column-groups
      const cols = []
      let curCol = [r.parts[0]]
      for (let i = 1; i < r.parts.length; i++) {
        if (r.parts[i].x - r.parts[i - 1].x > 50) { cols.push(curCol); curCol = [r.parts[i]] }
        else curCol.push(r.parts[i])
      }
      cols.push(curCol)
      for (const c of cols) optParts.push(c.map(p => p.text).join(''))
    }
    if (optParts.length < 4) continue
    // Take LAST 4 as options; earlier rows join stem (handles 2-line stems).
    const opts = optParts.slice(-4).map(s => s.trim())
    const extraStem = optParts.slice(0, -4)
    const question = (stemParts.concat(extraStem)).join('').trim()
    if (!question) continue
    if (!opts[0] || !opts[1] || !opts[2] || !opts[3]) continue
    out[a.num] = { question, options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
  }
  return out
}

const TARGETS = [
  {
    name: 'nursing 102110 basic_medicine',
    file: 'questions-nursing.json',
    code: '102110', c: '109', year: '102', session: '第二次',
    examKey: '護理師', total: 80,
    subjects: [
      { s: '0107', subject: '基礎醫學', tag: 'basic_medicine', keyword: '基礎醫學' },
    ],
    onlyNums: [30],
  },
  {
    name: 'nursing 102110 basic_nursing',
    file: 'questions-nursing.json',
    code: '102110', c: '109', year: '102', session: '第二次',
    examKey: '護理師', total: 80,
    subjects: [
      { s: '0501', subject: '基本護理學與護理行政', tag: 'basic_nursing', keyword: '基本護理' },
    ],
    onlyNums: [5],
  },
  {
    name: 'nursing 103030 basic_nursing',
    file: 'questions-nursing.json',
    code: '103030', c: '109', year: '103', session: '第一次',
    examKey: '護理師', total: 80,
    subjects: [
      { s: '0501', subject: '基本護理學與護理行政', tag: 'basic_nursing', keyword: '基本護理' },
    ],
    onlyNums: [42, 48],
  },
  {
    name: 'nursing 103100 med_surg',
    file: 'questions-nursing.json',
    code: '103100', c: '109', year: '103', session: '第二次',
    examKey: '護理師', total: 80,
    subjects: [
      { s: '0502', subject: '內外科護理學', tag: 'med_surg', keyword: '內外科' },
    ],
    onlyNums: [63],
  },
  {
    name: 'nutrition 100030 group_meal',
    file: 'questions-nutrition.json',
    code: '100030', c: '108', year: '100', session: '第一次',
    examKey: '營養師', total: 40,
    subjects: [
      { s: '0704', subject: '團體膳食設計與管理', tag: 'group_meal', keyword: '團體膳食' },
    ],
    onlyNums: [19],
  },
]

async function scrapeOne(target, sub) {
  const { code, c } = target
  const qUrl = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${code}&c=${c}&s=${sub.s}&q=1`
  const qBuf = await tryDownload(qUrl)
  if (!qBuf) { console.warn(`[${code} s=${sub.s}] Q PDF unreachable`); return [] }
  const qText = (await pdfParse(qBuf)).text
  const v = verifyExam(qText, target.examKey, sub.keyword)
  if (!v.ok) {
    console.warn(`[${code} s=${sub.s}] EXAM MISMATCH: 類科=${v.className} 科目=${v.subjName}`)
    return []
  }
  const parsed = await smartExtract(qBuf)

  let aBuf = null
  for (const t of ['S', 'M', 'A']) {
    const b = await tryDownload(`https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=${t}&code=${code}&c=${c}&s=${sub.s}&q=1`)
    if (b) { aBuf = b; break }
  }
  if (!aBuf) { console.warn(`[${code} s=${sub.s}] no answer PDF`); return [] }
  const aText = (await pdfParse(aBuf)).text
  const { answers, disputed, corrections } = parseAnswers(aText, target.total)
  // Grid-layout fallback (e.g. 103100 s=0502) — merge in if text parser missed targets.
  const needGrid = target.onlyNums.some(n => !answers[n])
  if (needGrid) {
    try {
      const grid = await parseAnswersPdfjsLib(aBuf)
      for (const k of Object.keys(grid)) {
        const n = parseInt(k)
        if (!answers[n]) answers[n] = grid[n]
      }
    } catch (e) { console.warn(`[${code} s=${sub.s}] pdfjs fallback failed: ${e.message}`) }
  }

  const results = []
  const targetNums = target.onlyNums
  for (const num of targetNums) {
    const p = parsed[num]
    if (!p || !p.question || !p.options.A || !p.options.B || !p.options.C || !p.options.D) {
      console.warn(`[${code} s=${sub.s}] Q${num} NOT extractable`)
      continue
    }
    const ansRaw = answers[num]
    if (!ansRaw) { console.warn(`[${code} s=${sub.s}] Q${num} no answer`); continue }
    const ans = corrections[num] || (ansRaw === '#' || ansRaw === '＃' ? 'A' : ansRaw)
    if (!/^[A-D]$/.test(ans)) { console.warn(`[${code} s=${sub.s}] Q${num} bad answer ${ans}`); continue }
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
  console.log(`[${code} s=${sub.s} ${sub.tag}] targeted=${targetNums.length} extracted=${results.length}`)
  return results
}

function dedupKey(q) { return `${q.exam_code}|${q.subject_tag}|${q.number}` }
// Only dedup by text when stem is long enough to be unique — short stems like
// "下列敘述何者錯誤？" collide with dozens of unrelated questions.
function textKey(q) {
  const t = (q.question || '').replace(/\s+/g, '')
  return t.length >= 40 ? t.slice(0, 100) : ''
}

async function main() {
  const fileGroups = {}
  for (const t of TARGETS) {
    fileGroups[t.file] = fileGroups[t.file] || []
    fileGroups[t.file].push(t)
  }
  for (const file of Object.keys(fileGroups)) {
    const absPath = path.join(BACKEND, file)
    const bank = JSON.parse(fs.readFileSync(absPath, 'utf8'))
    const arr = bank.questions || bank
    console.log(`\n=== ${file}: starting total ${arr.length} ===`)
    const existingKey = new Set(arr.map(dedupKey))
    const existingText = new Set(arr.map(textKey).filter(Boolean))
    const toAdd = []
    for (const target of fileGroups[file]) {
      console.log(`\n--- ${target.name} c=${target.c} ---`)
      for (const sub of target.subjects) {
        let got
        try { got = await scrapeOne(target, sub) }
        catch (e) { console.warn(`[${target.code} s=${sub.s}] ERROR: ${e.message}`); continue }
        for (const q of got) {
          if (existingKey.has(dedupKey(q))) { console.log(`  skip existing key ${dedupKey(q)}`); continue }
          const tk = textKey(q)
          if (tk && existingText.has(tk)) { console.log(`  skip existing text Q${q.number}`); continue }
          existingKey.add(dedupKey(q)); if (tk) existingText.add(tk)
          toAdd.push(q)
          console.log(`  ADD ${q.exam_code}|${q.subject_tag}|${q.number} ans=${q.answer}`)
        }
      }
    }
    console.log(`\n${file}: adding ${toAdd.length} new questions (before: ${arr.length})`)
    if (toAdd.length === 0) continue
    const merged = arr.concat(toAdd)
    const tmp = absPath + '.tmp'
    const toWrite = bank.questions ? { ...bank, questions: merged } : merged
    fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2))
    fs.renameSync(tmp, absPath)
    console.log(`${file}: wrote total ${merged.length} (delta +${toAdd.length})`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
