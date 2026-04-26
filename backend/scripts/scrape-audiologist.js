#!/usr/bin/env node
/**
 * Scrape 聽力師 (audiologist) exam from 考選部 MoEX.
 * Years with PDFs: 111, 112, 113 (6 papers × 50 Q each)
 * 115+ is CBT (電腦化測驗), PDFs not released.
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseAnswersColumnAware } = require('./lib/moex-column-parser')
const { fetchPdf, cachedFetch, buildMoexUrl } = require('./lib/pdf-fetcher')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
fs.mkdirSync(CACHE, { recursive: true })

const SUBJECTS = [
  { name: '基礎聽力科學',                   tag: 'audio_basic' },
  { name: '行為聽力學',                     tag: 'audio_behavioral' },
  { name: '電生理聽力學',                   tag: 'audio_electro' },
  { name: '聽覺輔具原理與實務學',           tag: 'audio_devices' },
  { name: '聽覺與平衡系統之創健與復健學',   tag: 'audio_rehab' },
  { name: '聽語溝通障礙學（包括專業倫理）', tag: 'audio_comm' },
]

const S_CODES = {
  '103100': ['0901', '0902', '0903', '0904', '0905', '0906'],
  '104100': ['0901', '0902', '0903', '0904', '0905', '0906'],
  '105090': ['0901', '0902', '0903', '0904', '0905', '0906'],
  '106110': ['0901', '0902', '0903', '0904', '0905', '0906'],
  '107110': ['0901', '0902', '0903', '0904', '0905', '0906'],
  '108110': ['0901', '0902', '0903', '0904', '0905', '0906'],
  '109110': ['0901', '0902', '0903', '0904', '0905', '0906'],
  '110111': ['0901', '0902', '0903', '0904', '0905', '0906'],
  '111110': ['0701', '0702', '0703', '0704', '0705', '0706'],
  '112110': ['0601', '0602', '0603', '0604', '0605', '0606'],
  '113100': ['0601', '0602', '0603', '0604', '0605', '0606'],
  '114100': ['0601', '0602', '0603', '0604', '0605', '0606'],
}

const TARGETS = [
  { year: '103', session: '第一次', code: '103100', c: '113' },
  { year: '104', session: '第一次', code: '104100', c: '110' },
  { year: '105', session: '第一次', code: '105090', c: '110' },
  { year: '106', session: '第一次', code: '106110', c: '110' },
  { year: '107', session: '第一次', code: '107110', c: '110' },
  { year: '108', session: '第一次', code: '108110', c: '110' },
  { year: '109', session: '第一次', code: '109110', c: '110' },
  { year: '110', session: '第一次', code: '110111', c: '110' },
  { year: '111', session: '第一次', code: '111110', c: '108' },
  { year: '112', session: '第一次', code: '112110', c: '106' },
  { year: '113', session: '第一次', code: '113100', c: '106' },
  { year: '114', session: '第一次', code: '114100', c: '106' },
]


async function getPdf(kind, code, c, s) {
  const file = path.join(CACHE, 'audiologist_' + code + '_c' + c + '_s' + s + '_' + kind + '.pdf')
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return fs.readFileSync(file)
  const buf = await fetchPdf(BASE + '?t=' + kind + '&code=' + code + '&c=' + c + '&s=' + s + '&q=1')
  fs.writeFileSync(file, buf)
  return buf
}

// Three MoEX 聽力師 PDF formats:
//   104-106: PUA chars for options + question number alone on line ("\n1\n因耳蝸...")
//   107-113: PUA chars + question on same line ("1基礎..." or "1 有關...")
//   114+:    "A.\nopt\n" pattern, no PUA + question prefix "1.\n"
function parseQuestions(text) {
  let t = text
  const LETTERS = ['A', 'B', 'C', 'D']
  const hasPUA = t.includes(String.fromCharCode(0xE18C))

  if (hasPUA) {
    for (let i = 0; i < 4; i++) {
      const pua = String.fromCharCode(0xE18C + i)
      t = t.split(pua).join('\n__OPT_' + LETTERS[i] + '__ ')
    }
  } else {
    // 114+ format: "A.\noption text" (letter on own line followed by content)
    t = t.replace(/(^|\n)\s*([A-D])[.．]\s*\n/g, (m, p1, letter) => {
      return p1 + '\n__OPT_' + letter + '__ '
    })
  }

  // Question number boundary — match all three formats:
  //   "\n1\n..."       (104-106, num alone on line)
  //   "\n1基礎..."     (107+ no space)
  //   "\n1 有關..."    (with space)
  //   "\n1.下列..."    (114+ with dot)
  // Don't match: "1.0" (digit-after-dot), "115年" (3-digit year), "代號：1106"
  t = t.replace(/(^|\n)\s{0,3}(\d{1,3})\s*[.．]?\s*([^\d\s])/g, (m, p1, num, ch) => {
    const n = parseInt(num)
    if (n < 1 || n > 100) return m
    return p1 + '\n__Q_' + n + '__ ' + ch
  })

  const lines = t.split('\n').map(l => l.trim()).filter(Boolean)
  const out = []
  let curr = null
  let mode = null

  function push() {
    if (curr && curr.question && curr.options.A && curr.options.B && curr.options.C && curr.options.D) {
      out.push(curr)
    }
    curr = null
  }

  for (const line of lines) {
    const qm = line.match(/^__Q_(\d+)__\s*(.+)$/)
    if (qm) {
      const num = parseInt(qm[1])
      if (num >= 1 && num <= 100) {
        push()
        curr = { number: num, question: qm[2].trim(), options: {} }
        mode = 'question'
        continue
      }
    }
    const om = line.match(/^__OPT_([A-D])__\s*(.*)$/)
    if (om && curr) {
      curr.options[om[1]] = om[2].trim()
      mode = 'opt_' + om[1]
      continue
    }
    if (curr) {
      if (mode === 'question') curr.question += line
      else if (mode && mode.startsWith('opt_')) {
        const k = mode.slice(4)
        curr.options[k] = (curr.options[k] || '') + line
      }
    }
  }
  push()
  return out
}

function parseAnswers(text) {
  // Full-width or half-width; can be continuous or with spaces
  const matches = [...text.matchAll(/答[　\s]*案[：: ]*([ＡＢＣＤA-D＃#\s]+)/g)]
  const letters = []
  for (const m of matches) {
    for (const ch of m[1]) {
      const mapped = ch.replace('Ａ', 'A').replace('Ｂ', 'B').replace('Ｃ', 'C').replace('Ｄ', 'D')
      if (/[A-D]/.test(mapped)) letters.push(mapped)
    }
  }
  return letters
}

async function main() {
  const allQuestions = []
  for (const t of TARGETS) {
    const codes = S_CODES[t.code]
    console.log('\n=== ' + t.year + ' 年 ' + t.session + ' (' + t.code + ' c=' + t.c + ') ===')
    for (let i = 0; i < codes.length; i++) {
      const s = codes[i]
      const subj = SUBJECTS[i]
      try {
        const qBuf = await getPdf('Q', t.code, t.c, s)
        const aBuf = await getPdf('S', t.code, t.c, s).catch(() => null)
        const qText = (await pdfParse(qBuf)).text
        const qs = parseQuestions(qText)

        // ansMap: { 1: 'A', 2: 'B', ... }
        let ansMap = {}
        if (aBuf) {
          try {
            const m = await parseAnswersColumnAware(aBuf)  // returns object
            if (m && Object.keys(m).length > 0) ansMap = m
          } catch {}
          if (Object.keys(ansMap).length === 0) {
            const aText = (await pdfParse(aBuf)).text
            const arr = parseAnswers(aText)  // returns array
            arr.forEach((l, i) => { ansMap[i + 1] = l })
          }
        }

        let added = 0
        for (const q of qs) {
          const letter = ansMap[q.number]
          if (!letter) continue
          allQuestions.push({
            id: 'audiologist_' + t.code + '_s' + s + '_' + q.number,
            roc_year: t.year,
            session: t.session,
            exam_code: t.code,
            subject: subj.name,
            subject_tag: subj.tag,
            subject_name: subj.name,
            stage_id: i + 1,
            number: q.number,
            question: q.question,
            options: q.options,
            answer: letter,
            explanation: '',
          })
          added++
        }
        console.log('  ' + subj.name + ': ' + qs.length + ' parsed, ' + Object.keys(ansMap).length + ' answers, ' + added + ' added')
      } catch (e) {
        console.log('  ' + subj.name + ': FAIL - ' + e.message)
      }
    }
  }

  const out = path.join(__dirname, '..', 'questions-audiologist.json')
  fs.writeFileSync(out, JSON.stringify(allQuestions, null, 2))
  console.log('\n==> Saved ' + allQuestions.length + ' questions to questions-audiologist.json')
}

main().catch(e => { console.error(e); process.exit(1) })
