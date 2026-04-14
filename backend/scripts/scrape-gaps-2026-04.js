#!/usr/bin/env node
/**
 * One-shot gap-filler (2026-04-14):
 *
 *   1. tcm1 114 第一次 — code=114020, c=317, s=0301/0302  (labeled PDF)
 *   2. tcm2 114 第一次 — code=114020, c=318, s=0303/0304/0305/0306  (labeled)
 *   3. nursing 111 第二次 — code=111110, c=104, s=0301..0305  (column-based PDF)
 *
 * Why a separate script: these 3 batches need either (a) a different
 * code series than scrape-moex.js's hardcoded 030 definitions, or (b)
 * column-aware parsing (nursing 111-2 uses pre-reform layout with no
 * A/B/C/D labels).
 *
 * Runs append-only against existing JSON files; IDs start at max+1.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

// ─── HTTP with cache ───
function fetchPdfRaw(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 20000,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/pdf,*/*',
        'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
      },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error(`bad redirect`)) }
        return fetchPdfRaw(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdfRaw(url, retries - 1).then(resolve, reject), 1000)
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0
      ? setTimeout(() => fetchPdfRaw(url, retries - 1).then(resolve, reject), 1000)
      : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function cachedPdf(tag, kind, code, c, s) {
  // tag: short id for cache filename ('tcm1_114', 'nursing_111110', etc)
  fs.mkdirSync(PDF_CACHE, { recursive: true })
  const fname = `${tag}_${kind}_${code}_c${c}_s${s}.pdf`
  const cur = path.join(PDF_CACHE, fname)
  if (fs.existsSync(cur) && fs.statSync(cur).size > 1000) return fs.readFileSync(cur)
  const url = `${BASE}?t=${kind}&code=${code}&c=${c}&s=${s}&q=1`
  const buf = await fetchPdfRaw(url)
  fs.writeFileSync(cur, buf)
  return buf
}

// ─── Labeled-format parser (1., A./B./C./D.) — adapted from scrape-moex.js ───

function parseLabeled(text) {
  const questions = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let currentQ = null, currentOption = null, buffer = ''

  const flushOpt = () => {
    if (currentQ && currentOption) currentQ.options[currentOption] = buffer.trim()
    buffer = ''; currentOption = null
  }
  const flushQ = () => {
    flushOpt()
    if (currentQ && currentQ.question && Object.keys(currentQ.options).length === 4) questions.push(currentQ)
    currentQ = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^(代號|類科|科目|考試|頁次|等\s*別|本試題|座號|※|注意)/.test(line)) continue
    if (/^\d+\s*頁/.test(line) || /^第\s*\d+\s*頁/.test(line)) continue

    const qm = line.match(/^(\d{1,2})[.、．]\s*(.*)$/)
    if (qm && (line.length > 6 || /[\u4e00-\u9fff a-zA-Z]/.test(qm[2] || '') || (qm[2] || '') === '')) {
      const num = parseInt(qm[1])
      const isFirst = !currentQ && questions.length === 0
      if (num >= 1 && num <= 80 && (isFirst || (currentQ && num === currentQ.number + 1))) {
        flushQ()
        currentQ = { number: num, question: (qm[2] || '').trim(), options: {} }
        continue
      }
    }
    const om = line.match(/^[\(（]\s*([A-Da-dＡＢＣＤ])\s*[\)）]\s*(.*)$/)
      || line.match(/^([A-Da-dＡＢＣＤ])\s*[.．、]\s*(.*)$/)
    if (om && currentQ) {
      flushOpt()
      currentOption = om[1].toUpperCase()
        .replace('Ａ', 'A').replace('Ｂ', 'B').replace('Ｃ', 'C').replace('Ｄ', 'D')
      buffer = om[2] || ''
      continue
    }
    if (currentOption) buffer += ' ' + line
    else if (currentQ) currentQ.question += ' ' + line
  }
  flushQ()
  return questions
}

// ─── Column-aware parser (from scrape-tcm1-110-111.js) ───

async function parseColumnAware(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()

  function parsePage(pg) {
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    const lines = []
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        lines.push({ y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), w: Math.round(ln.bbox.w), text: t })
      }
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x)
    return lines
  }

  function findAnchors(lines, isFirstPage) {
    const anchors = []
    for (const ln of lines) {
      if (ln.x > 60) continue
      if (ln.w > 22) continue
      const m = ln.text.match(/^(\d{1,3})$/)
      if (!m) continue
      const num = +m[1]
      if (num < 1 || num > 120) continue
      if (isFirstPage && ln.y < 220) continue
      anchors.push({ num, y: ln.y, x: ln.x })
    }
    const seen = new Set()
    return anchors.filter(a => { if (seen.has(a.num)) return false; seen.add(a.num); return true })
  }

  function extractQuestionFromContent(content) {
    if (!content.length) return null
    const rows = []
    for (const ln of content) {
      const last = rows[rows.length - 1]
      const clone = { y: ln.y, x: ln.x, w: ln.w, text: ln.text }
      if (last && Math.abs(last.y - ln.y) <= 5) last.parts.push(clone)
      else rows.push({ y: ln.y, parts: [clone] })
    }
    for (const r of rows) r.parts.sort((a, b) => a.x - b.x)

    // Merge wrap continuations: a single-part row whose x is noticeably to
    // the right of the leftmost content column is a wrap from the previous
    // row. Compute the leftmost x dynamically (nursing uses 58, tcm1 uses 72).
    const minX = Math.min(...rows.flatMap(r => r.parts.map(p => p.x)))
    for (let i = rows.length - 1; i > 0; i--) {
      const r = rows[i]
      if (r.parts.length === 1 && r.parts[0].x > minX + 8) {
        const prev = rows[i - 1]
        const lastPart = prev.parts[prev.parts.length - 1]
        lastPart.text += r.parts[0].text
        rows.splice(i, 1)
      }
    }

    // An option row has multiple parts at wide-gap x positions AND each part
    // is relatively narrow (options are usually short). Question rows may
    // also have split parts (e.g. the ①②③④ enumeration in the question
    // body) but those are typically wide (>220px) or the row contains a
    // long text run.
    const isOptionRow = r => {
      if (r.parts.length < 2) return false
      const xs = r.parts.map(p => p.x).sort((a, b) => a - b)
      let wideGap = false
      for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 50) { wideGap = true; break }
      if (!wideGap) return false
      const maxW = Math.max(...r.parts.map(p => p.w || 0))
      return maxW < 260
    }
    const optIdxs = rows.map((r, i) => isOptionRow(r) ? i : -1).filter(i => i >= 0)

    let questionRows, optionParts
    if (optIdxs.length > 0) {
      const firstOpt = optIdxs[0]
      questionRows = rows.slice(0, firstOpt)
      optionParts = []
      for (const r of rows.slice(firstOpt)) for (const p of r.parts) optionParts.push(p)
    } else {
      if (rows.length < 4) return null
      questionRows = rows.slice(0, rows.length - 4)
      optionParts = rows.slice(rows.length - 4).map(r => r.parts[0])
    }
    // Salvage: when mupdf merged two adjacent column cells into one part, we
    // get fewer than 4 options. Try to split the widest part on a structural
    // boundary (closing bracket + CJK/English start, or full-stop + non-final).
    if (optionParts.length === 3 || optionParts.length === 2) {
      const need = 4 - optionParts.length
      const wides = optionParts.map((p, i) => ({ p, i, w: p.w || p.text.length * 10 }))
        .sort((a, b) => b.w - a.w)
      for (const cand of wides) {
        if (need <= 0) break
        const text = cand.p.text
        // Try these split patterns in order
        const patterns = [
          /([）)])([^\s，。；、])/,           // ")X" where X is not punctuation
          /([。！？])([^\s，。；、)])/,        // "。X"
        ]
        let splitAt = -1
        for (const re of patterns) {
          // Search within the middle 60% of the string
          const mid = Math.floor(text.length / 2)
          const range = Math.floor(text.length * 0.3)
          const slice = text.slice(mid - range, mid + range)
          const m = slice.match(re)
          if (m) { splitAt = mid - range + m.index + m[1].length; break }
        }
        if (splitAt > 0 && splitAt < text.length) {
          const left = text.slice(0, splitAt)
          const right = text.slice(splitAt)
          optionParts.splice(cand.i, 1, { text: left }, { text: right })
          break
        }
      }
    }

    if (optionParts.length < 4) return null
    const opts = optionParts.slice(0, 4).map(p => p.text.trim())
    const question = questionRows.map(r => r.parts.map(p => p.text).join('')).join('').trim()
    if (!question) return null
    return { question, options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
  }

  const pageData = []
  for (let i = 0; i < n; i++) {
    const lines = parsePage(doc.loadPage(i))
    pageData.push({ lines, anchors: findAnchors(lines, i === 0) })
  }
  // Drop anchor-pattern lines from each page's content
  const isAnchorLine = ln => ln.x <= 60 && ln.w <= 22 && /^\d{1,3}$/.test(ln.text)

  const out = {}
  for (let pi = 0; pi < pageData.length; pi++) {
    const { lines, anchors } = pageData[pi]
    for (let ai = 0; ai < anchors.length; ai++) {
      const a = anchors[ai]
      const nextA = ai + 1 < anchors.length ? anchors[ai + 1] : null
      let content
      if (nextA) {
        content = lines.filter(ln =>
          !isAnchorLine(ln) &&
          ln.y >= a.y - 2 && ln.y < nextA.y - 2
        )
      } else if (pi + 1 < pageData.length) {
        const curTail = lines.filter(ln => !isAnchorLine(ln) && ln.y >= a.y - 2)
        const np = pageData[pi + 1]
        const nextOnNext = np.anchors.length ? np.anchors[0] : null
        // Offset next-page y so it sorts after current-page y
        const yOffset = 2000
        const nextTail = np.lines
          .filter(ln => !isAnchorLine(ln) && (nextOnNext == null || ln.y < nextOnNext.y - 2))
          .map(ln => ({ ...ln, y: ln.y + yOffset }))
        content = curTail.concat(nextTail)
      } else {
        content = lines.filter(ln => !isAnchorLine(ln) && ln.y >= a.y - 2)
      }
      const q = extractQuestionFromContent(content)
      if (q && !out[a.num]) out[a.num] = q
    }
  }
  return out
}

// ─── Answer / correction parsers ───

function parseAnswers(text) {
  const ans = {}
  const fw = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) ans[n++] = k
    }
  }
  if (Object.keys(ans).length >= 20) return ans
  const hw = /(\d{1,2})\s*[.\s、．:：]\s*([A-Da-d])/g
  while ((m = hw.exec(text)) !== null) {
    const num = parseInt(m[1])
    if (num >= 1 && num <= 80) ans[num] = m[2].toUpperCase()
  }
  return ans
}

// Column-aware answer parser (for 111110 nursing — also a table layout)
async function parseAnswersColumnAware(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const orderedNums = [], orderedAns = []
  for (let pi = 0; pi < doc.countPages(); pi++) {
    const parsed = JSON.parse(doc.loadPage(pi).toStructuredText('preserve-images').asJSON())
    const lines = []
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        lines.push({ y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), text: t })
      }
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x)
    const rows = []
    for (const ln of lines) {
      const last = rows[rows.length - 1]
      if (last && Math.abs(last.y - ln.y) <= 3) last.parts.push(ln)
      else rows.push({ y: ln.y, parts: [ln] })
    }
    for (const r of rows) {
      const nums = []
      for (const p of r.parts) {
        const m = p.text.match(/^第(\d{1,3})題$/)
        if (m) nums.push({ x: p.x, num: +m[1] })
      }
      if (nums.length >= 2) {
        nums.sort((a, b) => a.x - b.x)
        for (const nn of nums) orderedNums.push(nn.num)
        continue
      }
      const hasLabel = r.parts.some(p => p.text === '答案')
      if (!hasLabel) continue
      const letters = []
      for (const p of r.parts) {
        if (p.text === '答案') continue
        if (/^[A-D]$/.test(p.text)) letters.push({ x: p.x, ch: p.text })
        else if (/^[ＡＢＣＤ]$/.test(p.text)) {
          const ch = p.text === 'Ａ' ? 'A' : p.text === 'Ｂ' ? 'B' : p.text === 'Ｃ' ? 'C' : 'D'
          letters.push({ x: p.x, ch })
        }
      }
      if (letters.length >= 2) {
        letters.sort((a, b) => a.x - b.x)
        for (const l of letters) orderedAns.push(l.ch)
      }
    }
  }
  const ans = {}
  const len = Math.min(orderedNums.length, orderedAns.length)
  for (let i = 0; i < len; i++) ans[orderedNums[i]] = orderedAns[i]
  return ans
}

function parseCorrections(text) {
  const corrections = {}
  for (const line of text.split(/\n/)) {
    const give = line.match(/第?\s*(\d{1,3})\s*題.*(?:一律給分|送分)/i)
    if (give) { corrections[parseInt(give[1])] = '*'; continue }
    const change = line.match(/第?\s*(\d{1,3})\s*題.*更正.*([ＡＢＣＤA-D])/i)
    if (change) {
      let ch = change[2]
      if (ch === 'Ａ') ch = 'A'
      else if (ch === 'Ｂ') ch = 'B'
      else if (ch === 'Ｃ') ch = 'C'
      else if (ch === 'Ｄ') ch = 'D'
      corrections[parseInt(change[1])] = ch
    }
  }
  return corrections
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Batch definitions ───

const BATCHES = [
  {
    file: 'questions-tcm1.json',
    tag: 'tcm1_114_1',
    code: '114020',
    classCode: '317',
    year: '114',
    session: '第一次',
    parser: 'labeled',
    subjects: [
      { s: '0301', name: '中醫基礎醫學(一)', tag: 'tcm_basic_1' },
      { s: '0302', name: '中醫基礎醫學(二)', tag: 'tcm_basic_2' },
    ],
  },
  {
    file: 'questions-tcm2.json',
    tag: 'tcm2_114_1',
    code: '114020',
    classCode: '318',
    year: '114',
    session: '第一次',
    parser: 'labeled',
    subjects: [
      { s: '0303', name: '中醫臨床醫學(一)', tag: 'tcm_clinical_1' },
      { s: '0304', name: '中醫臨床醫學(二)', tag: 'tcm_clinical_2' },
      { s: '0305', name: '中醫臨床醫學(三)', tag: 'tcm_clinical_3' },
      { s: '0306', name: '中醫臨床醫學(四)', tag: 'tcm_clinical_4' },
    ],
  },
  {
    file: 'questions-nursing.json',
    tag: 'nursing_111_2',
    code: '111110',
    classCode: '104',
    year: '111',
    session: '第二次',
    parser: 'column',
    subjects: [
      { s: '0301', name: '基礎醫學', tag: 'basic_medicine' },
      { s: '0302', name: '基本護理學與護理行政', tag: 'fundamentals_admin' },
      { s: '0303', name: '內外科護理學', tag: 'med_surg' },
      { s: '0304', name: '產兒科護理學', tag: 'ob_peds' },
      { s: '0305', name: '精神科與社區衛生護理學', tag: 'psych_community' },
    ],
  },
]

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const only = args.find(a => a.startsWith('--only='))?.slice(7)

  for (const batch of BATCHES) {
    if (only && !batch.tag.startsWith(only)) continue
    console.log(`\n=== ${batch.tag} (code=${batch.code}, c=${batch.classCode}) ===`)
    const filePath = path.join(__dirname, '..', batch.file)
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const existingQs = existing.questions || []
    let nextId = (existingQs.reduce((m, q) => Math.max(m, +q.id || 0), 0)) + 1
    const existingKeys = new Set(existingQs.map(q =>
      `${q.roc_year}|${q.session}|${q.exam_code}|${q.subject_tag}|${q.number}`
    ))
    const newQs = []

    for (const sub of batch.subjects) {
      try {
        const qBuf = await cachedPdf(batch.tag, 'Q', batch.code, batch.classCode, sub.s)
        const sBuf = await cachedPdf(batch.tag, 'S', batch.code, batch.classCode, sub.s).catch(() => null)
        let mBuf = null
        try { mBuf = await cachedPdf(batch.tag, 'M', batch.code, batch.classCode, sub.s) } catch {}

        let parsed
        if (batch.parser === 'labeled') {
          const qText = (await pdfParse(qBuf)).text
          const list = parseLabeled(qText)
          parsed = {}
          for (const q of list) parsed[q.number] = { question: q.question, options: q.options }
        } else {
          parsed = await parseColumnAware(qBuf)
        }

        let answers = {}
        if (sBuf) {
          if (batch.parser === 'column') {
            answers = await parseAnswersColumnAware(sBuf)
            if (Object.keys(answers).length < 20) {
              answers = parseAnswers((await pdfParse(sBuf)).text)
            }
          } else {
            answers = parseAnswers((await pdfParse(sBuf)).text)
          }
        }
        const corrections = mBuf ? parseCorrections((await pdfParse(mBuf)).text) : {}
        for (const [num, ch] of Object.entries(corrections)) {
          if (ch !== '*') answers[num] = ch
        }

        const numKeys = Object.keys(parsed).map(n => +n).sort((a, b) => a - b)
        const ansKeys = Object.keys(answers).map(n => +n)
        const maxN = Math.max(...(ansKeys.length ? ansKeys : [80]))
        const missing = []
        for (let i = 1; i <= maxN; i++) if (!numKeys.includes(i)) missing.push(i)
        console.log(`  ${sub.s} ${sub.name}: parsed ${numKeys.length}Q, ${Object.keys(answers).length}A, ${Object.keys(corrections).length} corr${missing.length ? ' missing=' + missing.join(',') : ''}`)

        let kept = 0
        for (const num of numKeys) {
          const q = parsed[num]
          const a = answers[num]
          if (!a) continue
          if (!q.question || !q.options.A || !q.options.B || !q.options.C || !q.options.D) continue
          const dupKey = `${batch.year}|${batch.session}|${batch.code}|${sub.tag}|${num}`
          if (existingKeys.has(dupKey)) continue
          newQs.push({
            id: nextId++,
            roc_year: batch.year,
            session: batch.session,
            exam_code: batch.code,
            subject: sub.name,
            subject_tag: sub.tag,
            subject_name: sub.name,
            stage_id: 0,
            number: num,
            question: q.question,
            options: q.options,
            answer: a,
            explanation: '',
            ...(corrections[num] === '*' ? { disputed: true } : {}),
          })
          kept++
        }
        console.log(`    kept: ${kept}`)
        await sleep(200)
      } catch (e) {
        console.log(`  ✗ ${sub.s} ${sub.name}: ${e.message}`)
      }
    }

    if (dryRun) {
      console.log(`  [dry-run] would add ${newQs.length} questions`)
      continue
    }
    if (!newQs.length) {
      console.log('  No new questions')
      continue
    }
    existing.questions = existingQs.concat(newQs)
    existing.total = existing.questions.length
    if (existing.metadata) existing.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf-8')
    console.log(`  ✅ ${existingQs.length} → ${existing.questions.length} questions`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
