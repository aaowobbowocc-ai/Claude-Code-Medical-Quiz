#!/usr/bin/env node
/**
 * Scrape missing speech-therapist + audiologist years from MoEX.
 *
 * Found PDFs (probed):
 *   speech 100-1: 100090 c=201 s=0401..0406
 *   speech 100-2: 100140 c=111 s=0901..0906
 *   speech 101-1: 101110 c=111 s=0801..0806
 *   speech 104-2: 104100 c=109 s=0801..0806
 *   audio  100-1: 100090 c=301 s=0501..0506
 *   audio  100-2: 100140 c=112 s=1001..1006
 *   audio  101-1: 101110 c=112 s=0901..0906
 *   audio  104-2: 104100 c=110 s=0901..0906
 *
 * Auto-detects year/session/subject from PDF heading.
 */

require('dotenv/config')
const fs   = require('fs')
const path = require('path')
const https = require('https')
const lib  = require('./lib/moex-column-parser')

const BACKEND   = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// Canonical subject names match the exam-config papers[].subject so the dedup
// key (exam_code, subject, number) lines up with already-stored entries.
// 100-104 年舊 PDF 標題寫「聽語溝通障礙學」/「聽力學與輔助溝通系統」（無附加），
// 但 config 與已 rename 的 JSON 用「（包括專業倫理）」結尾。
const SPEECH_PAPERS = ['基礎言語科學', '神經性溝通障礙學', '兒童語言障礙', '嗓音與吞嚥障礙', '構音與語暢障礙', '聽力學與輔助溝通系統（包括專業倫理）']
const AUDIO_PAPERS  = ['基礎聽力科學', '行為聽力學', '電生理聽力學', '聽覺輔具原理與實務學', '聽覺與平衡系統之創健與復健學', '聽語溝通障礙學（包括專業倫理）']

const TARGETS = [
  // speech-therapist
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    code: '100090', c: '201', sBase: '0401', papers: SPEECH_PAPERS },  // 特考(相當高考)
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    code: '100140', c: '111', sBase: '0901', papers: SPEECH_PAPERS },  // 高考二次
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    code: '101070', c: '201', sBase: '0401', papers: SPEECH_PAPERS },  // 101 特考
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    code: '101110', c: '111', sBase: '0801', papers: SPEECH_PAPERS },  // 101 高考二次
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    code: '102030', c: '114', sBase: '1001', papers: SPEECH_PAPERS },  // 102 第一次
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    code: '102110', c: '114', sBase: '1001', papers: SPEECH_PAPERS },  // 102 第二次
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    code: '104100', c: '109', sBase: '0801', papers: SPEECH_PAPERS },  // 104 第二次
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    code: '107110', c: '109', sBase: '0801', papers: SPEECH_PAPERS },  // 107 第一次（小缺）
  // audiologist
  { exam: 'audiologist', file: 'questions-audiologist.json',
    code: '100090', c: '301', sBase: '0501', papers: AUDIO_PAPERS },   // 特考
  { exam: 'audiologist', file: 'questions-audiologist.json',
    code: '100140', c: '112', sBase: '1001', papers: AUDIO_PAPERS },   // 高考二次
  { exam: 'audiologist', file: 'questions-audiologist.json',
    code: '101070', c: '301', sBase: '0501', papers: AUDIO_PAPERS },   // 101 特考
  { exam: 'audiologist', file: 'questions-audiologist.json',
    code: '101110', c: '112', sBase: '0901', papers: AUDIO_PAPERS },   // 101 高考二次
  { exam: 'audiologist', file: 'questions-audiologist.json',
    code: '102030', c: '112', sBase: '0801', papers: AUDIO_PAPERS },   // 102 第一次
  { exam: 'audiologist', file: 'questions-audiologist.json',
    code: '102110', c: '201', sBase: '0707', papers: AUDIO_PAPERS },   // 102 第二次
  { exam: 'audiologist', file: 'questions-audiologist.json',
    code: '104100', c: '110', sBase: '0901', papers: AUDIO_PAPERS },   // 104 第二次
  // === 補缺新增 targets (2026-05-12) ===
  { exam: 'audiologist', file: 'questions-audiologist.json',
    code: '103100', c: '113', sBase: '0901', papers: AUDIO_PAPERS },   // 103 第一次（用 103100 c=113）
  { exam: 'audiologist', file: 'questions-audiologist.json',
    code: '106110', c: '110', sBase: '0901', papers: AUDIO_PAPERS },   // 106 第一次
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    code: '103100', c: '112', sBase: '0801', papers: SPEECH_PAPERS },  // 103 第一次
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    code: '105090', c: '109', sBase: '0801', papers: SPEECH_PAPERS },  // 105 第一次
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    code: '106110', c: '109', sBase: '0801', papers: SPEECH_PAPERS },  // 106 第一次
]

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function get(url) {
  return new Promise((res, rej) => {
    const agent = new https.Agent({ rejectUnauthorized: false })
    https.get(url, { agent }, r => {
      if (r.statusCode === 302) return rej(new Error('302'))
      if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode))
      const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => res(Buffer.concat(ch)))
    }).on('error', rej)
  })
}

function nextS(s) {
  // s is 4-digit string like '0401'. Increment last digit.
  const n = parseInt(s.slice(2)) + 1
  return s.slice(0, 2) + String(n).padStart(2, '0')
}

// MoEX PDFs use PUA-region glyphs that LOOK like normal Chinese chars but
// have different codepoints. stripPUA removes them. Use lib's helper.
const stripPUA = s => (lib.stripPUA ? lib.stripPUA(s) : s).normalize('NFKC')

function parseHeading(text) {
  const cleaned = stripPUA(text)
  const m1 = cleaned.match(/(\d{2,3})\s*年(?:第([一二])次)?專門職業/)
  if (!m1) return null
  const year = m1[1]
  const session = m1[2] === '一' ? '第一次' : m1[2] === '二' ? '第二次' : '第一次'
  const subj = cleaned.match(/科\s*目[：:]?\s*([^\s（(]+)/)?.[1] || ''
  // Detect exam type from heading. "特種考試" / "相當高等考試" → 相當高考.
  // 語言治療師/聽力師 100-101年 第一次 是特考；其餘為專技高考。
  const isSpecial = /特種考試|相當高等考試|相當專技高考/.test(cleaned)
  const exam_type = isSpecial ? 'special_high' : 'high'
  return { year, session, subject: subj, exam_type }
}

async function parseQuestions(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) {
    txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText() + '\n'
  }
  txt = stripPUA(txt)  // Strip PUA glyphs before parsing
  const lines = txt.split('\n').map(l => l.trim()).filter(Boolean)
  const isHeader = ln => /^(代號|頁次|等\s*別|類\s*科|科\s*目|考試時間|本試題|本科目|本科共|禁止|座號|※)/u.test(ln)

  const hasABCD = lines.slice(0, 100).some(l => /^[A-D][.、．]\s*\S/.test(l))
  const questions = []
  let cur = null

  if (hasABCD) {
    for (const line of lines) {
      if (isHeader(line)) continue
      const qM = line.match(/^(\d{1,3})[.、．]\s*(.+)/)
      if (qM) {
        const n = +qM[1]
        if (n >= 1 && n <= 100 && /[一-鿿]/.test(qM[2]) && !/^[A-D]/.test(qM[2])) {
          if (cur) questions.push(cur)
          cur = { number: n, question: qM[2], options: { A:'', B:'', C:'', D:'' } }
          continue
        }
      }
      const oM = line.match(/^([A-D])[.、．]\s*(.+)/)
      if (oM && cur) { cur.options[oM[1]] = oM[2]; continue }
      if (cur) {
        const last = ['D','C','B','A'].find(k => cur.options[k])
        if (last) cur.options[last] += ' ' + line
        else cur.question += ' ' + line
      }
    }
  } else {
    let collected = 0
    for (const line of lines) {
      if (isHeader(line)) continue
      const num = line.match(/^(\d{1,3})$/)
      if (num) {
        const n = +num[1]
        if (n >= 1 && n <= 100) {
          if (cur && collected >= 3) questions.push(cur)
          cur = { number: n, question: '', options: { A:'', B:'', C:'', D:'' } }
          collected = 0
          continue
        }
      }
      if (!cur) continue
      const oM = line.match(/^([A-D])[.、．]\s*(.+)/)
      if (oM) {
        cur.options[oM[1]] = oM[2]
        collected = Math.max(collected, ['A','B','C','D'].indexOf(oM[1]) + 1)
        continue
      }
      if (!cur.question) { cur.question = line; continue }
      const slot = ['A','B','C','D'][collected]
      if (slot && cur.options[slot] === '') {
        cur.options[slot] = line; collected++; continue
      }
      const last = ['D','C','B','A'].find(k => cur.options[k])
      if (last) cur.options[last] += ' ' + line
      else cur.question += ' ' + line
    }
    if (cur && collected >= 3) questions.push(cur)
  }
  return questions
}

async function parseAnswerLetters(aBuf) {
  if (!aBuf) return {}
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(aBuf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) {
    txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText() + '\n'
  }
  txt = stripPUA(txt)

  // Format A (100-103 era): "答案ＡＢＣＤ..." continuous letter runs
  const blocks = [...txt.matchAll(/答案\s*([ABCDＡＢＣＤ\s#＃]+)/g)]
  const ansA = {}
  let qA = 1
  for (const m of blocks) {
    const letters = m[1].replace(/\s+/g, '').replace(/[ＡＢＣＤ]/g, c => ({Ａ:'A',Ｂ:'B',Ｃ:'C',Ｄ:'D'}[c])).replace(/[#＃]/g, '')
    for (const ch of letters) {
      if (/[A-D]/.test(ch)) { ansA[qA] = ch; qA++; if (qA > 100) break }
    }
    if (qA > 100) break
  }
  if (Object.keys(ansA).length >= 40) return ansA

  // Format B (104+ era): table with "第N題" labels then letters separately
  const lines = txt.split('\n').map(l => l.trim()).filter(Boolean)
  const qNums = []
  const letters = []
  for (const line of lines) {
    const qm = line.match(/^第\s*(\d{1,3})\s*題/)
    if (qm) { qNums.push(+qm[1]); continue }
    const lm = line.match(/^([A-DＡＢＣＤ])$/)
    if (lm) letters.push(({Ａ:'A',Ｂ:'B',Ｃ:'C',Ｄ:'D'}[lm[1]] || lm[1]))
  }
  const ansB = {}
  const len = Math.min(qNums.length, letters.length)
  for (let i = 0; i < len; i++) ansB[qNums[i]] = letters[i]

  return Object.keys(ansB).length > Object.keys(ansA).length ? ansB : ansA
}

let nextId = 30000000  // pseudo IDs for new questions

async function scrapePaper(t, papIdx) {
  const s = (() => {
    let cur = t.sBase
    for (let i = 0; i < papIdx; i++) cur = nextS(cur)
    return cur
  })()
  const url = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${s}&q=1`
  const cacheFile = path.join(PDF_CACHE, `${t.exam}_${t.code}_c${t.c}_s${s}.pdf`)

  let qBuf
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 1000) {
    qBuf = fs.readFileSync(cacheFile)
  } else {
    qBuf = await get(url)
    fs.writeFileSync(cacheFile, qBuf)
  }

  // Get answer PDF
  let aBuf = null
  for (const tParam of ['S', 'A']) {
    try {
      const aUrl = `${BASE}?t=${tParam}&code=${t.code}&c=${t.c}&s=${s}&q=1`
      const aCache = path.join(PDF_CACHE, `A_${t.exam}_${t.code}_c${t.c}_s${s}.pdf`)
      if (fs.existsSync(aCache) && fs.statSync(aCache).size > 1000) {
        aBuf = fs.readFileSync(aCache); break
      }
      aBuf = await get(aUrl)
      fs.writeFileSync(aCache, aBuf)
      break
    } catch {}
  }

  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(qBuf), 'application/pdf')
  const headText = doc.loadPage(0).toStructuredText('preserve-whitespace').asText()
  const meta = parseHeading(headText)
  if (!meta) { console.log('  no heading meta'); return [] }

  const questions = await parseQuestions(qBuf)
  const answers   = await parseAnswerLetters(aBuf)

  const built = questions
    .filter(q => /[一-鿿]/.test(q.question) && Object.values(q.options).filter(v => v).length >= 3)
    .map(q => ({
      id:           ++nextId,
      roc_year:     meta.year,
      session:      meta.session,
      exam_code:    t.code,
      subject:      t.papers[papIdx],
      subject_tag:  `paper${papIdx + 1}`,
      subject_name: t.papers[papIdx],
      paper_id:     `paper${papIdx + 1}`,
      stage_id:     0,
      number:       q.number,
      question:     q.question,
      options:      q.options,
      answer:       answers[q.number] || '',
      exam_type:    meta.exam_type || 'high',
      explanation:  '',
    }))
    .filter(q => q.answer)

  console.log(`  paper ${papIdx + 1} (${t.papers[papIdx]}) ${meta.year}-${meta.session}: ${built.length} questions`)
  return built
}

async function main() {
  let total = 0
  for (const t of TARGETS) {
    console.log(`\n=== ${t.exam} ${t.code} c=${t.c} ===`)
    const allBuilt = []
    for (let p = 0; p < t.papers.length; p++) {
      try {
        const built = await scrapePaper(t, p)
        allBuilt.push(...built)
      } catch (e) {
        console.log(`  paper ${p + 1}: ${e.message}`)
      }
    }
    if (!allBuilt.length) continue
    const filePath = path.join(BACKEND, t.file)
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const arr = raw.questions || raw

    // Dedup by (exam_code, subject, number)
    const existing = new Set(arr.map(q => `${q.exam_code}|${q.subject}|${q.number}`))
    const toAdd = allBuilt.filter(q => !existing.has(`${q.exam_code}|${q.subject}|${q.number}`))
    arr.push(...toAdd)
    if (toAdd.length) {
      const toSave = raw.questions ? raw : arr
      fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2))
      console.log(`  💾 ${t.file} (+${toAdd.length})`)
      total += toAdd.length
    }
  }
  console.log(`\n總計: ${total} questions added`)
}

main().catch(e => { console.error(e); process.exit(1) })
