#!/usr/bin/env node
// Fill remaining B-list gaps:
//   customs 108050 c=101 s=0307 法學知識 (12 Qs)
//   customs 113040 c=101 s=0306 法學知識 (9 Qs)
//   radio   111100 c=309 s=33   放射線器材學 (11 Qs, Q70-80)

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseColumnAware } = require('./lib/moex-column-parser')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/' } }, res => {
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('HTTP ' + res.statusCode))
      }
      const cs = []; res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    }).on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800) : reject(e))
  })
}

// Parse Q with "A.  B.  C.  D." text labels (radio 111100 format).
function parseTextLabeled(text, nums) {
  const out = {}
  for (const n of nums) {
    const re = new RegExp(`${n}\\.([\\s\\S]*?)(?:\\n\\s*${n + 1}\\.|$)`, 'm')
    const m = text.match(re)
    if (!m) continue
    const body = m[1]
    const qm = body.match(/^([\s\S]*?)(?=\n\s*A\.)/)
    if (!qm) continue
    const question = qm[1].replace(/\s+/g, ' ').trim()
    const opts = {}
    for (const L of ['A','B','C','D']) {
      const nextL = { A: 'B', B: 'C', C: 'D', D: null }[L]
      const re2 = nextL
        ? new RegExp(`${L}\\.\\s*([\\s\\S]*?)(?=\\n\\s*${nextL}\\.)`)
        : new RegExp(`${L}\\.\\s*([\\s\\S]*?)$`)
      const om = body.match(re2)
      if (!om) return out
      opts[L] = om[1].replace(/\s+/g, ' ').trim()
    }
    if (question && Object.keys(opts).length === 4) out[n] = { question, options: opts }
  }
  return out
}

// Parse Q where question number is "N " (no dot) and options are last 4
// non-empty lines of the block (customs 108050 format).
function parseTextUnlabeled(text, nums) {
  const out = {}
  for (const n of nums) {
    const re = new RegExp(`\\n\\s*${n}\\s+([\\s\\S]*?)\\n\\s*${n + 1}\\s+`, 'm')
    const m = text.match(re)
    if (!m) continue
    const lines = m[1].split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length < 5) continue
    const opts = lines.slice(-4)
    const qLines = lines.slice(0, -4)
    const question = qLines.join(' ').replace(/\s+/g, ' ').trim()
    if (!question || !opts.every(o => o.length >= 1)) continue
    out[n] = { question, options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
  }
  return out
}

// Page-by-page pdfjs text extraction (for image-heavy PDFs like radio 111100
// where pdf-parse returns interleaved/wrapped text). Returns {question, options}
// by question number for all Q detected.
async function parseLabeledViaPdfjs(buf, nums) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
  const allText = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const c = await page.getTextContent()
    const items = c.items.map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5] })).filter(i => i.s.trim())
    items.sort((a, b) => Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x)
    allText.push(items.map(i => i.s).join(' '))
  }
  const flat = allText.join(' ').replace(/\s+/g, ' ')
  const out = {}
  for (const n of nums) {
    // Match "N.xxxxx A.xxx B.xxx C.xxx D.xxx" then stop at next Q# or end
    const re = new RegExp(`${n}\\.\\s*([^A-D]*?(?:[^A-D]|A(?!\\.))+?)\\s*A\\.\\s*(.*?)\\s*B\\.\\s*(.*?)\\s*C\\.\\s*(.*?)\\s*D\\.\\s*(.*?)(?=\\s+${n + 1}\\.|\\s*$)`)
    let m = flat.match(re)
    if (!m) {
      // Simpler fallback: greedy by fixed anchors
      const re2 = new RegExp(`${n}\\.(.*?)A\\.(.*?)B\\.(.*?)C\\.(.*?)D\\.(.*?)(?=${n + 1}\\.|$)`)
      m = flat.match(re2)
    }
    if (m) {
      const dedup = s => s.replace(/(.{2,}?) \1/g, '$1').trim()
      out[n] = {
        question: dedup(m[1]).replace(/[，。？\s]+$/, '').trim() + (m[1].includes('？') ? '' : '？'),
        options: { A: dedup(m[2]), B: dedup(m[3]), C: dedup(m[4]), D: dedup(m[5]) },
      }
    }
  }
  return out
}

async function parseAnswersPdfjs(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
  const answers = {}
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const items = content.items.map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5] })).filter(i => i.s && i.s.trim())
    const labels = items.filter(i => /^第\d+題/.test(i.s))
    const letters = items.filter(i => /^[A-D]$/.test(i.s.trim()))
    for (const lb of labels) {
      const n = parseInt(lb.s.match(/\d+/)[0])
      if (answers[n]) continue
      const cand = letters.filter(lt => Math.abs(lt.x - lb.x) < 20 && lt.y < lb.y && lt.y > lb.y - 40)
      cand.sort((a, b) => b.y - a.y)
      if (cand[0]) answers[n] = cand[0].s.trim()
    }
  }
  return answers
}

function parseAnswersText(text) {
  const answers = {}
  const fw = /答案\s*([ＡＢＣＤ#＃]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      if (ch === '#' || ch === '＃') { n++; continue }
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
    }
  }
  return answers
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

const TARGETS = [
  { file: 'questions-customs.json', code: '108050', c: '101', s: '0307',
    year: '108', session: '第一次', subject: '法學知識', tag: 'law_knowledge',
    nums: [3, 14, 17, 18, 20, 21, 24, 32, 35, 40, 44, 48] },
  { file: 'questions-customs.json', code: '113040', c: '101', s: '0306',
    year: '113', session: '第一次', subject: '法學知識', tag: 'law_knowledge',
    nums: [2, 6, 13, 14, 19, 28, 39, 40, 41] },
  { file: 'questions-radiology.json', code: '111100', c: '309', s: '33',
    year: '111', session: '第二次', subject: '放射線器材學（包括磁振學與超音波學）', tag: 'radio_instruments',
    nums: [70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80] },
]

async function main() {
  const byFile = new Map()
  for (const t of TARGETS) {
    const qUrl = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${t.s}&q=1`
    const aUrl = `${BASE}?t=S&code=${t.code}&c=${t.c}&s=${t.s}&q=1`
    console.log(`\n── ${t.file} ${t.code} ${t.subject} (c=${t.c} s=${t.s}) ──`)
    const qBuf = await fetchPdf(qUrl)
    let aBuf = null
    try { aBuf = await fetchPdf(aUrl) } catch (e) { console.log(`  ⚠ ans: ${e.message}`) }
    let parsed = await parseColumnAware(qBuf)
    if (Object.keys(parsed).length < t.nums.length) {
      const { text: qText } = await pdfParse(qBuf)
      const labeled = parseTextLabeled(qText, t.nums)
      const unlabeled = parseTextUnlabeled(qText, t.nums)
      parsed = { ...parsed, ...unlabeled, ...labeled }
    }
    if (t.nums.some(n => !parsed[n])) {
      try {
        const viaPdfjs = await parseLabeledViaPdfjs(qBuf, t.nums.filter(n => !parsed[n]))
        parsed = { ...parsed, ...viaPdfjs }
      } catch (e) { console.log(`  ⚠ pdfjs Q: ${e.message}`) }
    }
    console.log(`  parsed ${Object.keys(parsed).length} Q`)
    let answers = {}
    if (aBuf) {
      const { text } = await pdfParse(aBuf)
      answers = parseAnswersText(text)
      if (Object.keys(answers).length < 20) {
        try { answers = await parseAnswersPdfjs(aBuf) } catch (e) { console.log(`  ⚠ pdfjs: ${e.message}`) }
      }
    }
    console.log(`  answers ${Object.keys(answers).length}`)
    const entries = []
    for (const n of t.nums) {
      const pq = parsed[n]; const a = answers[n]
      if (!pq || !pq.question || !a || !/^[A-D]$/.test(a) ||
          !['A','B','C','D'].every(k => (pq.options?.[k] || '').length >= 1)) {
        console.log(`  ✗ Q${n}: ${pq ? 'ok-q' : 'no-q'}, ans=${a || '?'}`)
        continue
      }
      entries.push({ t, n, pq, a })
      console.log(`  ✓ Q${n} [${a}]: ${pq.question.slice(0, 40)}`)
    }
    if (entries.length) {
      if (!byFile.has(t.file)) byFile.set(t.file, [])
      byFile.get(t.file).push(...entries)
    }
  }

  for (const [fname, items] of byFile) {
    const fp = path.join(__dirname, '..', fname)
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    let nextId = Math.max(...data.questions.map(q => q.id || 0)) + 1
    let added = 0, replaced = 0
    for (const { t, n, pq, a } of items) {
      const idx = data.questions.findIndex(x =>
        x.exam_code === t.code && x.subject === t.subject && x.number === n)
      const rec = {
        roc_year: t.year, session: t.session, exam_code: t.code,
        subject: t.subject, subject_tag: t.tag, subject_name: t.subject,
        stage_id: 0, number: n,
        question: stripPUA(pq.question),
        options: Object.fromEntries(['A','B','C','D'].map(k => [k, stripPUA(pq.options[k])])),
        answer: a, explanation: '',
      }
      if (idx >= 0) { rec.id = data.questions[idx].id; data.questions[idx] = rec; replaced++ }
      else { rec.id = nextId++; data.questions.push(rec); added++ }
    }
    data.total = data.questions.length
    const tmp = fp + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, fp)
    console.log(`\n✅ ${fname}: +${added} added, ${replaced} replaced → ${data.questions.length}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
