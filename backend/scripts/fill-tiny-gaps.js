#!/usr/bin/env node
/**
 * Targeted small-gap fill — relaxed option-length filter for short Chinese options.
 * Targets pharma2 / nursing 1-3 missing per session.
 */
const fs = require('fs')
const path = require('path')
const https = require('https')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

const GAPS = [
  // pharma2 藥物治療 散缺
  { file: 'questions-pharma2.json', code: '110020', subject: '藥物治療', tag: 'therapeutics', year: '110', sess: '第一次', c: '306', s: '55', miss: [79] },
  { file: 'questions-pharma2.json', code: '112020', subject: '藥物治療', tag: 'pharmacotherapy', year: '112', sess: '第一次', c: '306', s: '55', miss: [73] },
  { file: 'questions-pharma2.json', code: '114090', subject: '藥物治療', tag: 'therapeutics', year: '114', sess: '第二次', c: '306', s: '0405', miss: [77] },
  { file: 'questions-pharma2.json', code: '115020', subject: '藥物治療', tag: 'therapeutics', year: '115', sess: '第一次', c: '306', s: '0405', miss: [77] },
  // nursing 散缺 — let auto-discover c/s from cache filename
  { file: 'questions-nursing.json', code: '101110', subject: '基本護理學與護理行政', tag: 'fundamental_nursing', year: '101', sess: '第二次', miss: [41] },
  { file: 'questions-nursing.json', code: '101110', subject: '產兒科護理學', tag: 'obstetric_nursing', year: '101', sess: '第二次', miss: [72] },
  { file: 'questions-nursing.json', code: '101110', subject: '精神科與社區衛生護理學', tag: 'psychiatric_nursing', year: '101', sess: '第二次', miss: [28] },
  { file: 'questions-nursing.json', code: '102030', subject: '精神科與社區衛生護理學', tag: 'psychiatric_nursing', year: '102', sess: '第一次', miss: [47, 72] },
]

function get(url) {
  return new Promise(r => {
    https.get(url, { agent: new https.Agent({ rejectUnauthorized: false }) }, x => {
      if (x.statusCode !== 200) { x.destroy(); return r(null) }
      const c = []; x.on('data', d => c.push(d)); x.on('end', () => r(Buffer.concat(c)))
    }).on('error', () => r(null))
  })
}

async function readPdf(p) {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(p)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += '\n' + doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return txt.normalize('NFKC').replace(/[-]/g, '')
}

function parseQ(txt) {
  const raw = [...txt.matchAll(/^\s*(\d{1,3})[.、．]\s*/gm)]
  // Filter to monotonically increasing sequence (reject mid-body digit noise like "3、MCH")
  const matches = []
  let prev = 0
  for (const m of raw) {
    const num = parseInt(m[1])
    if (num < 1 || num > 200) continue
    if (num <= prev) continue
    if (num > prev + 10 && prev > 0) continue
    matches.push(m)
    prev = num
  }
  const out = {}
  for (let i = 0; i < matches.length; i++) {
    const num = parseInt(matches[i][1])
    const start = matches[i].index + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index : txt.length
    const body = txt.slice(start, end).trim()
    const optM = [...body.matchAll(/^\s*([ABCD])[.、．]\s*/gm)]
    if (optM.length < 4) continue
    const options = {}
    for (let j = 0; j < 4; j++) {
      const a = optM[j].index + optM[j][0].length
      const b = j + 1 < optM.length ? optM[j + 1].index : body.length
      options[optM[j][1]] = body.slice(a, b).trim().replace(/\s+/g, ' ')
    }
    const question = body.slice(0, optM[0].index).trim().replace(/\s+/g, ' ')
    if (question.length < 5) continue
    out[num] = { number: num, question, options }
  }
  return out
}

async function getAnswers(code, c, s, expected = 80) {
  for (const prefix of ['TS', 'TM', 'A', 'S']) {
    const fp = path.join(PDF_CACHE, `${prefix}_${code}_c${c}_s${s}.pdf`)
    if (fs.existsSync(fp)) {
      const txt = await readPdf(fp)
      const m = txt.match(/(?<![A-Z0-9])[A-D#](?![A-Z0-9])/g) || []
      if (m.length >= expected) return m.slice(0, expected)
    }
  }
  for (const t of ['S', 'M']) {
    const url = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=${t}&code=${code}&c=${c}&s=${s}&q=1`
    const buf = await get(url)
    if (!buf || buf.length < 1000) continue
    const fp = path.join(PDF_CACHE, `T${t}_${code}_c${c}_s${s}.pdf`)
    fs.writeFileSync(fp, buf)
    const txt = await readPdf(fp)
    const m = txt.match(/(?<![A-Z0-9])[A-D#](?![A-Z0-9])/g) || []
    if (m.length >= expected) return m.slice(0, expected)
  }
  return null
}

function findCachedPdf(prefix, code, subject, txtCheck) {
  const files = fs.readdirSync(PDF_CACHE).filter(f =>
    f.startsWith(prefix + '_' + code + '_') && f.endsWith('.pdf')
  )
  return files
}

async function findQPdf(prefix, code, subject) {
  const files = findCachedPdf(prefix, code, subject)
  for (const f of files) {
    const fp = path.join(PDF_CACHE, f)
    const txt = await readPdf(fp)
    if (txt.includes(subject) || txt.includes(subject.slice(0, 4))) {
      const m = f.match(/_c(\w+)_s(\w+)\.pdf$/)
      return { fp, c: m?.[1], s: m?.[2], file: f }
    }
  }
  return null
}

async function main() {
  let total = 0
  for (const g of GAPS) {
    const prefix = g.file.replace('questions-', '').replace('.json', '')
    let { c, s } = g
    let qPdf
    if (c && s) {
      qPdf = path.join(PDF_CACHE, `${prefix}_${g.code}_c${c}_s${s}.pdf`)
      if (!fs.existsSync(qPdf)) qPdf = null
    }
    if (!qPdf) {
      const found = await findQPdf(prefix, g.code, g.subject)
      if (!found) { console.log(`  ✗ ${g.code} ${g.subject}: no Q PDF`); continue }
      qPdf = found.fp; c = found.c; s = found.s
    }
    const txt = await readPdf(qPdf)
    if (!txt.includes(g.subject) && !txt.includes(g.subject.slice(0, 4))) {
      console.log(`  ✗ ${g.code} ${g.subject}: PDF subject mismatch (${qPdf.split(/[\\/]/).pop()})`)
      continue
    }
    const parsed = parseQ(txt)
    const answers = await getAnswers(g.code, c, s, 80)
    if (!answers) { console.log(`  ✗ ${g.code} ${g.subject}: no answer`); continue }

    const fp = path.join(BACKEND, g.file)
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    const existing = new Set(arr.filter(q => q.exam_code === g.code && q.subject === g.subject).map(q => q.number))
    const maxId = arr.reduce((m, q) => Math.max(m, parseInt(String(q.id).replace(/\D/g, '')) || 0), 0)
    let nextId = maxId + 1

    let added = 0
    for (const num of g.miss) {
      if (existing.has(num)) continue
      const q = parsed[num]
      if (!q) { console.log(`    #${num}: not parsed`); continue }
      const ans = answers[num - 1]
      if (!ans || ans === '#') { console.log(`    #${num}: no answer`); continue }
      // Relaxed: allow single-char options (高/中/低 etc)
      if (!q.options.A || !q.options.B || !q.options.C || !q.options.D) {
        console.log(`    #${num}: missing options`); continue
      }
      arr.push({
        id: nextId++,
        roc_year: g.year, session: g.sess, exam_code: g.code,
        subject: g.subject, subject_tag: g.tag, subject_name: g.subject,
        stage_id: 0, number: num,
        question: q.question, options: q.options, answer: ans,
        explanation: '',
      })
      existing.add(num); added++
    }
    arr.sort((a, b) => {
      if (a.exam_code !== b.exam_code) return String(a.exam_code).localeCompare(String(b.exam_code))
      if (a.subject !== b.subject) return String(a.subject).localeCompare(String(b.subject))
      return (a.number || 0) - (b.number || 0)
    })
    fs.writeFileSync(fp, JSON.stringify(data, null, 2))
    console.log(`  ✓ ${g.code} ${g.subject}: +${added}/${g.miss.length}`)
    total += added
  }
  console.log(`\nTOTAL +${total}`)
}

main().catch(e => { console.error(e); process.exit(1) })
