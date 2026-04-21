#!/usr/bin/env node
// Tier-2 gap-fill (2026-04):
//   - tcm1    102110 c=103 s=0201..0202   (tcm_basic_1 missing 6, tcm_basic_2 missing 33)
//   - nursing 102110 c=109 s=0107,0501    (basic_medicine missing 40, basic_nursing missing 1)
//   - nutrition 100030 c=108 s=0704       (group_meal: 團膳 parser stuck at 5/40 -> fallback for 6-40)
//
// Verification: 類科 NFKC match. Dedup by (exam_code, subject_tag, number) and question text.
// Atomic .tmp write.

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseColumnAware } = require('./lib/moex-column-parser')

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

// Single-column fallback for no-A/B/C/D-label papers.
async function parseSingleColumnFallback(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
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
  const rows = []
  for (const ln of allLines) {
    const last = rows[rows.length - 1]
    if (last && Math.abs(last.y - ln.y) <= 5) last.parts.push(ln)
    else rows.push({ y: ln.y, parts: [ln] })
  }
  for (const r of rows) r.parts.sort((a, b) => a.x - b.x)

  // Anchor detection:
  //  (a) standalone number: row parts[0].text = "N" (x<60)
  //  (b) inline anchor: row parts[0].text starts with "N " at x<60, followed by stem chars on same line
  const anchors = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const p0 = r.parts[0]
    if (!p0) continue
    if (p0.x >= 60) continue
    let num = null
    let inlineStem = null
    const m1 = p0.text.match(/^(\d{1,3})$/)
    const m2 = !m1 ? p0.text.match(/^(\d{1,3})\s+(.+)$/) : null
    if (m1) { num = +m1[1] }
    else if (m2) { num = +m2[1]; inlineStem = m2[2] }
    else continue
    if (num < 1 || num > 120) continue
    anchors.push({ idx: i, num, y: r.y, inlineStem })
  }
  for (let ai = 0; ai < anchors.length; ai++) {
    const a = anchors[ai]
    const nextA = ai + 1 < anchors.length ? anchors[ai + 1] : null
    const endIdx = nextA ? nextA.idx : rows.length
    const block = rows.slice(a.idx, endIdx)
    if (!block.length) continue
    const first = block[0]
    const stemParts = a.inlineStem ? [a.inlineStem] : first.parts.slice(1).map(p => p.text)
    const stemStartX = first.parts[1] ? first.parts[1].x
                       : (a.inlineStem ? first.parts[0].x + 12 : 72)
    const optionRows = []
    for (let i = 1; i < block.length; i++) {
      const r = block[i]
      const firstP = r.parts[0]
      if (!firstP) continue
      if (Math.abs(firstP.x - stemStartX) <= 3 && optionRows.length === 0) {
        stemParts.push(r.parts.map(p => p.text).join(''))
      } else {
        optionRows.push(r)
      }
    }
    const opts = []
    for (const r of optionRows) {
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

async function getParsed(qBuf) {
  const parsed = await parseColumnAware(qBuf)
  const fallback = await parseSingleColumnFallback(qBuf)
  for (const k of Object.keys(fallback)) {
    if (!parsed[k] || !parsed[k].options || !parsed[k].options.A || !parsed[k].options.D) {
      const f = fallback[k]
      if (f && f.question && f.options.A && f.options.B && f.options.C && f.options.D) {
        parsed[k] = f
      }
    }
  }
  return parsed
}

const TARGETS = [
  {
    name: 'tcm1 102110',
    file: 'questions-tcm1.json',
    code: '102110', c: '103', year: '102', session: '第二次',
    examKey: '中醫師', total: 80,
    subjects: [
      // 102-2 中醫基礎醫學 PDFs don't include (一)/(二) suffix in 科目 line;
      // s-code (0201/0202) distinguishes. Use a loose keyword that matches both.
      { s: '0201', subject: '中醫基礎醫學(一)', tag: 'tcm_basic_1', keyword: '中醫基礎醫學', subjectMarker: '中醫醫學史' },
      { s: '0202', subject: '中醫基礎醫學(二)', tag: 'tcm_basic_2', keyword: '中醫基礎醫學', subjectMarker: null },
    ],
  },
  {
    name: 'nursing 102110',
    file: 'questions-nursing.json',
    code: '102110', c: '109', year: '102', session: '第二次',
    examKey: '護理師', total: 80,
    subjects: [
      { s: '0107', subject: '基礎醫學',             tag: 'basic_medicine', keyword: '基礎醫學' },
      { s: '0501', subject: '基本護理學與護理行政', tag: 'basic_nursing',  keyword: '基本護理' },
    ],
  },
  {
    name: 'police 112070 admin_studies',
    file: 'questions-police.json',
    code: '112070', c: '301', year: '112', session: '第一次',
    examKey: '行政警察', total: 25, intId: true,
    subjects: [
      { s: '0301', subject: '行政學', tag: 'admin_studies', keyword: '行政學' },
    ],
  },
  {
    name: 'nutrition 100030 group_meal',
    file: 'questions-nutrition.json',
    code: '100030', c: '108', year: '100', session: '第一次',
    examKey: '營養師', total: 40,
    subjects: [
      { s: '0704', subject: '團體膳食設計與管理', tag: 'group_meal', keyword: '團體膳食' },
    ],
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
  const parsed = await getParsed(qBuf)

  let aBuf = null
  for (const t of ['S', 'M', 'A']) {
    const b = await tryDownload(`https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=${t}&code=${code}&c=${c}&s=${sub.s}&q=1`)
    if (b) { aBuf = b; break }
  }
  if (!aBuf) { console.warn(`[${code} s=${sub.s}] no answer PDF`); return [] }
  const aText = (await pdfParse(aBuf)).text
  const { answers, disputed, corrections } = parseAnswers(aText, target.total)

  const results = []
  const nums = Object.keys(parsed).map(n => parseInt(n)).sort((a, b) => a - b)
  for (const num of nums) {
    if (num < 1 || num > target.total) continue
    const p = parsed[num]
    if (!p || !p.question || !p.options.A || !p.options.B || !p.options.C || !p.options.D) continue
    const ansRaw = answers[num]
    const ans = corrections[num] || (ansRaw === '#' || ansRaw === '＃' || !ansRaw ? 'A' : ansRaw)
    const q = {
      id: target.intId ? null /* filled per-file later */ : `${code}_${sub.s}_${num}`,
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
  console.log(`[${code} s=${sub.s} ${sub.tag}] 題數=${target.total} parsed=${Object.keys(parsed).length} clean=${results.length}`)
  return results
}

function dedupKey(q) { return `${q.exam_code}|${q.subject_tag}|${q.number}` }
function textKey(q) { return (q.question || '').replace(/\s+/g,'').slice(0, 100) }

async function processFile(targets) {
  const fileGroups = {}
  for (const t of targets) {
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
          if (existingKey.has(dedupKey(q))) continue
          const tk = textKey(q)
          if (tk && existingText.has(tk)) continue
          existingKey.add(dedupKey(q))
          if (tk) existingText.add(tk)
          toAdd.push(q)
        }
      }
    }
    console.log(`\n${file}: adding ${toAdd.length} new questions (before: ${arr.length})`)
    if (toAdd.length === 0) continue
    // Assign integer IDs for banks that use them (e.g. police)
    let nextId = 0
    for (const q of arr) if (typeof q.id === 'number' && q.id > nextId) nextId = q.id
    for (const q of toAdd) if (q.id === null) q.id = ++nextId
    const merged = arr.concat(toAdd)
    const tmp = absPath + '.tmp'
    const toWrite = bank.questions ? { ...bank, questions: merged } : merged
    fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2))
    fs.renameSync(tmp, absPath)
    console.log(`${file}: wrote total ${merged.length} (delta +${toAdd.length})`)
  }
}

processFile(TARGETS).catch(e => { console.error(e); process.exit(1) })
