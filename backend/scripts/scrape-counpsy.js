#!/usr/bin/env node
// 諮商心理師考試爬蟲。每卷格式為「一、申論題（跳過）+ 二、測驗題（單選，抓取）」。
// 測驗題格式：N.\n題幹\nA.\n選項…\nB.… 答案 PDF 為半形 ABCD 連續字串。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const OUT = path.join(__dirname, '..', 'questions-counseling-psychology.json')
const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const APPLY = process.argv.includes('--apply')

// 6 卷固定結構
const PAPERS = [
  { subject: '諮商的心理學基礎', tag: 'cou_basic' },
  { subject: '諮商與心理治療理論', tag: 'cou_theory' },
  { subject: '諮商與心理治療實務與專業倫理', tag: 'cou_practice' },
  { subject: '心理健康與變態心理學', tag: 'cou_mental_health' },
  { subject: '個案評估與心理衡鑑', tag: 'cou_assessment' },
  { subject: '團體諮商與心理治療', tag: 'cou_group' },
]
// 場次：[code, c, s前2碼]
// 注意：106-110 年的 PDF 為無 ABCD 標記的雙欄格式，暫不納入；目前僅收 113/114。
const SESSIONS = [
  ['113100', '112', '11'], ['114100', '112', '11'],
]
const sessionName = code => /0(2|3)0$/.test(code) ? '第一次' : '第二次'

async function getPdf(kind, code, c, s) {
  const fn = path.join(CACHE, `counpsy_${kind}_${code}_c${c}_s${s}.pdf`)
  try { const b = fs.readFileSync(fn); if (b.length > 1000) return b } catch {}
  const buf = await fetchPdf(buildMoexUrl(kind, code, c, s), { userAgent: UA, referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' })
  fs.writeFileSync(fn, buf)
  return buf
}

// 解析測驗題段
function parseMC(text) {
  // 新版用「二、測驗題」、舊版用「乙、測驗題部分」
  let cut = text.indexOf('乙、測驗題')
  if (cut < 0) cut = text.indexOf('二、測驗題')
  if (cut < 0) return []
  let mc = text.slice(cut)
  mc = mc.split(/\n+/).filter(l => !/^代\s*號|^頁\s*次|^\s*$/.test(l.trim())).join('\n')
  const re = /\n\s*(\d{1,2})\.\s*\n/g
  const marks = []
  let m
  while ((m = re.exec(mc)) !== null) marks.push({ num: +m[1], start: re.lastIndex, at: m.index })
  const out = []
  for (let i = 0; i < marks.length; i++) {
    const body = mc.slice(marks[i].start, i + 1 < marks.length ? marks[i + 1].at : mc.length)
    const om = body.match(/^([\s\S]*?)\n\s*A\.\s*\n([\s\S]*?)\n\s*B\.\s*\n([\s\S]*?)\n\s*C\.\s*\n([\s\S]*?)\n\s*D\.\s*\n([\s\S]*)$/)
    if (!om) continue
    const clean = s => s.replace(/\s+/g, ' ').trim()
    const q = clean(om[1]), o = [clean(om[2]), clean(om[3]), clean(om[4]), clean(om[5])]
    if (q.length < 6 || o.some(x => !x)) continue
    out.push({ number: marks[i].num, question: q, options: { A: o[0], B: o[1], C: o[2], D: o[3] } })
  }
  return out
}

function parseAnswers(text) {
  const t = text.normalize('NFKC')
  let s = ''
  for (const m of t.matchAll(/答\s*案\s*([ABCD]+)/g)) s += m[1]
  return s.split('')
}

async function main() {
  let all = []
  try { all = JSON.parse(fs.readFileSync(OUT, 'utf8')).questions || [] } catch {}
  const existing = new Set(all.map(q => q.id))
  let added = 0
  for (const [code, c, sb] of SESSIONS) {
    const year = code.slice(0, 3)
    for (let pi = 0; pi < 6; pi++) {
      const s = sb + '0' + (pi + 1)
      const paper = PAPERS[pi]
      let qbuf, abuf
      try {
        qbuf = await getPdf('Q', code, c, s)
        abuf = await getPdf('S', code, c, s)
      } catch (e) { console.log(`  ✗ ${code} ${paper.subject}: ${e.message}`); continue }
      const qtext = (await pdfParse(qbuf)).text.normalize('NFKC')
      if (!qtext.includes('諮商心理師')) { console.log(`  ⚠ ${code} s${s} 類科不符，跳過`); continue }
      const qs = parseMC(qtext)
      const ans = parseAnswers((await pdfParse(abuf)).text)
      let n = 0
      for (const q of qs) {
        const ansLetter = ans[q.number - 1]
        if (!ansLetter || !/[ABCD]/.test(ansLetter)) continue
        const id = `${code}_${pi + 1}_${q.number}`
        if (existing.has(id)) continue
        all.push({
          id, roc_year: year, session: sessionName(code), exam_code: code,
          subject: paper.subject, subject_tag: paper.tag, subject_name: paper.subject,
          stage_id: 0, number: q.number, question: q.question, options: q.options,
          answer: ansLetter, explanation: '',
        })
        existing.add(id); n++; added++
      }
      console.log(`  ${code} ${paper.subject}: ${n} 題`)
      await sleep(150)
    }
  }
  console.log(`\n新增 ${added} 題，總計 ${all.length}`)
  if (APPLY) {
    fs.writeFileSync(OUT, JSON.stringify({ questions: all, total: all.length }, null, 2) + '\n')
    console.log('已寫入', OUT)
  } else console.log('(dry-run，加 --apply 寫入)')
}
main().catch(e => { console.error(e); process.exit(1) })
