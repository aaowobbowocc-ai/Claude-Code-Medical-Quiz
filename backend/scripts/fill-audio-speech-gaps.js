#!/usr/bin/env node
/**
 * 用 pdfjs 位置基礎 parser 補 audiologist + speech-therapist 散落缺漏
 * 免費（純本地解析）
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')

const BACKEND = path.resolve(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

// 已知缺漏（從 check-all-gaps 結果）
const TARGETS = [
  { exam: 'audiologist', file: 'questions-audiologist.json',
    year: '106', session: '第一次',
    code: '106110', c: '110',
    subjects: {
      '行為聽力學': { s: '0902', missing: [2,8,9,24,28,30,33,34,39,45,67] },
      '聽覺輔具原理與實務學': { s: '0904', missing: [2,3,25,35,60,63,65,67,70,71,72,76] },
    },
    answerPdfPrefix: 'audiologist_106110_c110' },
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    year: '100', session: '第一次',
    code: '100090', c: '201',
    subjects: {
      '聽力學與輔助溝通系統（包括專業倫理）': { s: '0406', missingExpected: 79 },
    },
    answerPdfPrefix: 'speech-therapist_100090_c201' },
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    year: '101', session: '第一次',
    code: '101070', c: '201',
    subjects: { '嗓音與吞嚥障礙': { s: '0404', missingExpected: 80 } },
    answerPdfPrefix: 'speech-therapist_101070_c201' },
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    year: '101', session: '第二次',
    code: '101110', c: '111',
    subjects: { '基礎言語科學': { s: '0803', missingExpected: 80 } },
    answerPdfPrefix: 'speech-therapist_101110_c111' },
  { exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    year: '102', session: '第一次',
    code: '102030', c: '114',
    subjects: {
      '基礎言語科學': { s: '1003', missingExpected: 79 },
      '聽力學與輔助溝通系統（包括專業倫理）': { s: '1006', missingExpected: 79 },
    },
    answerPdfPrefix: 'speech-therapist_102030_c114' },
]

// 用 pdfjs 抓題號 + 選項 + 題目正文（極簡版，能用就好）
async function parseQuestionsFromPdf(pdfPath) {
  const buf = fs.readFileSync(pdfPath)
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  let all = ''
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    all += content.items.map(it => it.str).join('\n') + '\n'
  }
  // 簡單 split by 題號
  const questions = []
  const text = all.normalize('NFKC').replace(/\r/g, '')
  const lines = text.split(/\n/)
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim()
    if (!ln) continue
    const m = ln.match(/^(\d{1,3})[.\s]\s*(.*)$/)
    if (m && !ln.match(/^\d{4,}/)) {
      const num = parseInt(m[1])
      if (num >= 1 && num <= 100) {
        if (cur) questions.push(cur)
        cur = { number: num, question: m[2] || '', options: {} }
        continue
      }
    }
    const optM = ln.match(/^[(（]?([A-D])[)）.、．]\s*(.*)$/)
    if (optM && cur) {
      cur.options[optM[1]] = optM[2].trim()
      continue
    }
    if (cur && !cur.options.A) cur.question += ' ' + ln
  }
  if (cur) questions.push(cur)
  return questions
}

// 從答案 PDF 抓答案 map
async function parseAnswersPdf(pdfPath) {
  const buf = fs.readFileSync(pdfPath)
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  let text = ''
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    text += content.items.map(it => it.str).join('') + '\n'
  }
  text = text.normalize('NFKC')
  const answers = {}
  // 全形連續
  const fw = /答案\s*([ＡＢＣＤ＃#]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
      else n++  // #
    }
  }
  if (Object.keys(answers).length >= 20) return answers
  // 半形
  n = 1
  const hw = /答案\s*([A-D#]{10,})/gi
  while ((m = hw.exec(text)) !== null) {
    for (const ch of m[1]) {
      if (/[A-D]/i.test(ch)) answers[n] = ch.toUpperCase()
      n++
    }
  }
  return answers
}

async function main() {
  let totalAdded = 0
  for (const t of TARGETS) {
    const fp = path.join(BACKEND, t.file)
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    const idIndex = new Map()
    for (const q of arr) idIndex.set(`${q.exam_code}|${q.subject}|${q.number}`, q)
    let maxId = Math.max(...arr.map(q => parseInt(q.id) || 0).filter(n => !isNaN(n))) || 1000000
    let added = 0
    for (const [subjName, info] of Object.entries(t.subjects)) {
      const qPdf = path.join(PDF_CACHE, `${t.answerPdfPrefix}_s${info.s}_Q.pdf`)
      const aPdf = path.join(PDF_CACHE, `${t.answerPdfPrefix}_s${info.s}_S.pdf`)
      if (!fs.existsSync(qPdf)) {
        // 試別的命名
        const alt = path.join(PDF_CACHE, `${t.answerPdfPrefix}_s${info.s}.pdf`)
        if (!fs.existsSync(alt)) { console.log(`  ✗ ${t.year}-${t.session} ${subjName}: no PDF`); continue }
      }
      let qs, ans
      try {
        qs = await parseQuestionsFromPdf(fs.existsSync(qPdf) ? qPdf : path.join(PDF_CACHE, `${t.answerPdfPrefix}_s${info.s}.pdf`))
        ans = fs.existsSync(aPdf) ? await parseAnswersPdf(aPdf) : {}
      } catch (e) { console.log(`  ✗ ${t.year}-${t.session} ${subjName}: ${e.message}`); continue }

      const missingNums = info.missing || [...Array(info.missingExpected || 80).keys()].map(n => n+1)
      let subjAdded = 0
      for (const num of missingNums) {
        const key = `${t.code}|${subjName}|${num}`
        if (idIndex.has(key)) continue
        const q = qs.find(x => x.number === num)
        if (!q || !q.question || !q.options.A) continue
        if (q.question.length < 10) continue
        const optKeys = Object.keys(q.options).filter(k => q.options[k] && q.options[k].length >= 2)
        if (optKeys.length < 3) continue
        maxId++
        arr.push({
          id: maxId,
          roc_year: t.year, session: t.session, exam_code: t.code,
          subject: subjName, subject_tag: 'paper1', subject_name: subjName,
          paper_id: 'paper1', stage_id: 0,
          number: num,
          question: q.question.trim(),
          options: q.options,
          answer: ans[num] || '',
          explanation: '',
        })
        subjAdded++; added++
      }
      console.log(`  ${t.year}-${t.session} ${subjName}: +${subjAdded}`)
    }
    if (added > 0) {
      fs.writeFileSync(fp, JSON.stringify(data, null, 2))
      console.log(`[${t.exam}] ${t.year} +${added} → save`)
    }
    totalAdded += added
  }
  console.log(`\nTotal added: ${totalAdded}`)
}

main().catch(e => { console.error(e); process.exit(1) })
