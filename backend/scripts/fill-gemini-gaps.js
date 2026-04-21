#!/usr/bin/env node
// Fill remaining OCR-hard question gaps using Gemini 2.0 Flash vision API.
//
// Targets:
//   tcm1 102-2 中醫基礎醫學(二): Q6, 40, 50, 51, 59, 60, 65, 77, 78, 79, 80
//   nursing 108-1 精神/社區衛生護理學: Q36, 80
//
// Answers parsed from _tmp/ocr_pdfs/*_S.pdf (reusing logic from parse-ocr-output.js).
// API key read from backend/.gemini-key (gitignored).

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const ROOT = path.resolve(__dirname, '..')
const KEY_FILE = path.join(ROOT, '.gemini-key')
const IMG_DIR = path.join(ROOT, '_tmp', 'ocr_imgs')
const PDF_DIR = path.join(ROOT, '_tmp', 'ocr_pdfs')
const TCM1_FILE = path.join(ROOT, 'questions-tcm1.json')
const NURSING_FILE = path.join(ROOT, 'questions-nursing.json')

if (!fs.existsSync(KEY_FILE)) {
  console.error(`[fatal] Gemini API key file not found: ${KEY_FILE}`)
  process.exit(1)
}
const GEMINI_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim()
// NOTE: gemini-2.0-flash returns 404 "no longer available to new users" on this
// API key. Using gemini-2.5-flash (free tier, multimodal, similar quota). Same
// endpoint contract, same request body.
const MODEL = 'gemini-2.5-flash'
const ENDPOINT = `/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`

// ---- Targets ----

const TCM1_TARGET = {
  label: 'tcm1 102-2 中醫基礎醫學(二)',
  exam_code: '102110',
  roc_year: '102',
  session: '第二次',
  subject: '中醫基礎醫學(二)',
  subject_tag: 'tcm_basic_2',
  subjCode: '0202',
  pdfS: 'tcm1_102-2_basic2_S.pdf',
  bankFile: TCM1_FILE,
  needed: [6, 40, 50, 51, 59, 60, 65, 77, 78, 79, 80],
  // Page image filename template: tcm1_102-2_basic2_Q_p{n}.png
  imgTemplate: n => `tcm1_102-2_basic2_Q_p${n}.png`,
  // Pages to probe (80 Qs / 10 pages ≈ 8/page). Send plausibly-relevant pages.
  probePages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
}

const NURSING_TARGET = {
  label: 'nursing 108-1 精神/社區衛生護理學',
  exam_code: '108020',
  roc_year: '108',
  session: '第一次',
  subject: '精神科與社區衛生護理學',
  subject_tag: 'psych_community',
  subjCode: '0505',
  pdfS: 'nursing_108-1_psych_S.pdf',
  bankFile: NURSING_FILE,
  needed: [36, 80],
  imgTemplate: n => `nursing_108-1_psych_Q_p${n}.png`,
  // 80 Qs / 8 pages = 10/page. Q36 ≈ p4, Q80 ≈ p8. Probe p4, p5, p8 to be safe.
  probePages: [3, 4, 5, 8],
}

// ---- Answer PDF parsers (from parse-ocr-output.js) ----

async function parseTcm1Answers(target) {
  const buf = fs.readFileSync(path.join(PDF_DIR, target.pdfS))
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

async function parseNursingAnswers(target) {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(path.join(PDF_DIR, target.pdfS))
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

// ---- Gemini REST call ----

function geminiRequest(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: ENDPOINT,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) {
          reject(new Error(`Gemini HTTP ${res.statusCode}: ${text.slice(0, 500)}`))
          return
        }
        try { resolve(JSON.parse(text)) }
        catch (e) { reject(new Error(`bad JSON: ${text.slice(0, 200)}`)) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function extractText(geminiResp) {
  const cand = geminiResp.candidates?.[0]
  if (!cand) return ''
  const parts = cand.content?.parts || []
  return parts.map(p => p.text || '').join('')
}

function stripFence(s) {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
}

async function extractFromPage(target, pageNum, neededQs) {
  const imgPath = path.join(IMG_DIR, target.imgTemplate(pageNum))
  if (!fs.existsSync(imgPath)) {
    console.warn(`  [skip] image missing: ${imgPath}`)
    return {}
  }
  const b64 = fs.readFileSync(imgPath).toString('base64')
  const prompt = `This is a Taiwan national exam question paper scan. Extract ONLY the following question numbers if they appear on this page: [${neededQs.join(', ')}].
For each question you find, return strict JSON (no prose, no markdown fence) in this shape:
{
  "<number>": {
    "question": "<stem text in traditional Chinese, full>",
    "options": {"A": "<text>", "B": "<text>", "C": "<text>", "D": "<text>"}
  }
}
Rules:
- If the paper uses (A)(B)(C)(D) or ①②③④ or ＡＢＣＤ for options, map to keys A/B/C/D in that order.
- If a target question is NOT on this page or is unreadable, OMIT it (do not invent).
- Preserve traditional Chinese characters exactly. Do not translate to English or simplify.
- Do not include the question number inside the "question" field.
- If an option is a herb/plant image rather than text, transcribe any visible Chinese label printed with the image (e.g. "金銀花", "蒲公英"). If there is no printed label, use a concise traditional-Chinese description like "圖示1". Do NOT output English descriptions like "Image of Honeysuckle".
- Return ONLY the JSON object, no preamble.`

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'image/png', data: b64 } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
    },
  }

  const resp = await geminiRequest(body)
  const raw = extractText(resp)
  const cleaned = stripFence(raw)
  if (!cleaned) return {}
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    console.warn(`  [parse-fail] p${pageNum}: ${cleaned.slice(0, 200)}`)
    return {}
  }
}

// ---- Validation & merge ----

function validEntry(e) {
  if (!e || typeof e !== 'object') return false
  const { question, options } = e
  if (typeof question !== 'string' || question.length < 10) return false
  if (!options || typeof options !== 'object') return false
  for (const L of ['A', 'B', 'C', 'D']) {
    if (typeof options[L] !== 'string' || options[L].length < 1) return false
  }
  return true
}

// Detect placeholder image-only options (e.g. "圖示1", "Image of ...").
function isImageDep(e) {
  const vals = ['A', 'B', 'C', 'D'].map(L => e.options[L] || '')
  const placeholders = vals.filter(v => /^(圖示|圖片|image|picture|圖)[\s_\-]*\d*$/i.test(v.trim()))
  return placeholders.length >= 2
}

function atomicWrite(file, obj) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, file)
}

async function processTarget(target, answers) {
  console.log(`\n=== ${target.label} ===`)
  console.log(`  needed: ${target.needed.join(', ')}`)
  console.log(`  answers parsed: ${Object.keys(answers).length} / 80`)

  // Accumulate best extraction per Q number across probed pages.
  const combined = {}
  for (const p of target.probePages) {
    const remaining = target.needed.filter(n => !combined[n])
    if (!remaining.length) break
    console.log(`  [page ${p}] requesting Qs: ${remaining.join(', ')}`)
    const got = await extractFromPage(target, p, remaining)
    const foundNums = Object.keys(got).filter(k => /^\d+$/.test(k))
    console.log(`    -> Gemini returned: ${foundNums.join(', ') || '(none)'}`)
    for (const k of foundNums) {
      const num = +k
      if (!target.needed.includes(num)) continue
      if (combined[num]) continue
      if (validEntry(got[k])) combined[num] = got[k]
      else {
        console.log(`    [invalid] Q${num} — failed validation; raw: ${JSON.stringify(got[k]).slice(0, 300)}`)
      }
    }
  }

  // Build final entries.
  const bank = JSON.parse(fs.readFileSync(target.bankFile, 'utf8'))
  const bankArr = bank.questions || bank
  const existingKey = new Set(bankArr
    .filter(q => q.exam_code === target.exam_code && q.subject_tag === target.subject_tag)
    .map(q => q.number))

  const toAdd = []
  const skipped = {}
  for (const num of target.needed) {
    if (existingKey.has(num)) { skipped[num] = 'already in bank'; continue }
    const e = combined[num]
    if (!e) { skipped[num] = 'not extracted'; continue }
    const ans = answers[num]
    if (!ans || !/^[A-D#]$/.test(ans)) {
      skipped[num] = `no answer (${JSON.stringify(ans)})`
      continue
    }
    const imageDep = isImageDep(e)
    toAdd.push({
      id: `${target.exam_code}_${target.subjCode}_${num}`,
      roc_year: target.roc_year,
      session: target.session,
      exam_code: target.exam_code,
      subject: target.subject,
      subject_tag: target.subject_tag,
      subject_name: target.subject,
      stage_id: 0,
      number: num,
      question: e.question.trim(),
      options: {
        A: e.options.A.trim(),
        B: e.options.B.trim(),
        C: e.options.C.trim(),
        D: e.options.D.trim(),
      },
      answer: ans === '#' ? 'A' : ans,
      explanation: '',
      ...(ans === '#' ? { disputed: true } : {}),
      ...(imageDep ? { incomplete: true, gap_reason: 'missing_image_dep' } : {}),
    })
    if (imageDep) console.log(`    [image-dep] Q${num} flagged incomplete`)
  }

  return { bank, toAdd, skipped }
}

async function main() {
  const write = process.argv.includes('--write')

  const tcm1Answers = await parseTcm1Answers(TCM1_TARGET)
  const nurseAnswers = await parseNursingAnswers(NURSING_TARGET)

  const tcm1Res = await processTarget(TCM1_TARGET, tcm1Answers)
  console.log(`  added: ${tcm1Res.toAdd.length} / ${TCM1_TARGET.needed.length}`)
  console.log(`  skipped: ${JSON.stringify(tcm1Res.skipped)}`)
  for (const s of tcm1Res.toAdd.slice(0, 2)) {
    console.log(`  sample Q${s.number}: ${s.question.slice(0, 60)}`)
    console.log(`    A: ${s.options.A} | B: ${s.options.B} | C: ${s.options.C} | D: ${s.options.D} | ans=${s.answer}`)
  }

  const nurseRes = await processTarget(NURSING_TARGET, nurseAnswers)
  console.log(`  added: ${nurseRes.toAdd.length} / ${NURSING_TARGET.needed.length}`)
  console.log(`  skipped: ${JSON.stringify(nurseRes.skipped)}`)
  for (const s of nurseRes.toAdd) {
    console.log(`  sample Q${s.number}: ${s.question.slice(0, 80)}`)
    console.log(`    A: ${s.options.A}`)
    console.log(`    B: ${s.options.B}`)
    console.log(`    C: ${s.options.C}`)
    console.log(`    D: ${s.options.D} | ans=${s.answer}`)
  }

  if (write) {
    if (tcm1Res.toAdd.length) {
      tcm1Res.bank.questions.push(...tcm1Res.toAdd)
      tcm1Res.bank.total = tcm1Res.bank.questions.length
      if (tcm1Res.bank.metadata) tcm1Res.bank.metadata.total = tcm1Res.bank.questions.length
      atomicWrite(TCM1_FILE, tcm1Res.bank)
      console.log(`[write] questions-tcm1.json now has ${tcm1Res.bank.questions.length} questions`)
    }
    if (nurseRes.toAdd.length) {
      nurseRes.bank.questions.push(...nurseRes.toAdd)
      nurseRes.bank.total = nurseRes.bank.questions.length
      if (nurseRes.bank.metadata) nurseRes.bank.metadata.total = nurseRes.bank.questions.length
      atomicWrite(NURSING_FILE, nurseRes.bank)
      console.log(`[write] questions-nursing.json now has ${nurseRes.bank.questions.length} questions`)
    }
  } else {
    console.log('\n(dry-run; pass --write to persist)')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
