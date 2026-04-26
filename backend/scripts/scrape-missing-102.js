#!/usr/bin/env node
// Scrape 102-year missing sessions (030 series, text-layer parse):
//   doctor2 102110 c=102 s=0103-0106
//   tcm1    102110 c=103 s=0201-0202
//   tcm2    102110 c=103 s=0203-0206
//   nursing 102110 c=109 s=0107,0501-0504
//   medlab  102030 c=109 s=0107,0501-0505

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { fetchPdf, cachedFetch, buildMoexUrl } = require('./lib/pdf-fetcher')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s


function parseQuestionsText(text) {
  const out = {}
  const cleaned = text.replace(/代號[：:]\s*\d+\s*\n/g, '').replace(/頁次[：:]\s*\d+－\d+\s*\n/g, '')
  for (let n = 1; n <= 80; n++) {
    const re = new RegExp(`\\n\\s*${n}\\s+([\\s\\S]*?)\\n\\s*${n + 1}\\s`, 'm')
    const m = cleaned.match(re)
    if (!m) continue
    const lines = m[1].split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length < 2) continue
    let matched = false
    for (let k = 1; k < lines.length; k++) {
      const segs = []
      for (const l of lines.slice(k)) segs.push(...l.split(/\s{2,}/).filter(Boolean))
      if (segs.length === 4 && segs.every(s => s.length >= 1)) {
        out[n] = { question: lines.slice(0, k).join(' ').replace(/\s+/g,' ').trim(),
                   options: { A: segs[0], B: segs[1], C: segs[2], D: segs[3] } }
        matched = true; break
      }
    }
    if (matched) continue
    if (lines.length >= 5) {
      const opts = lines.slice(-4)
      if (opts.every(o => o.length >= 2 && !/^[①②③④⑤]+$/.test(o))) {
        out[n] = { question: lines.slice(0, -4).join(' ').replace(/\s+/g,' ').trim(),
                   options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
        continue
      }
    }
    if (lines.length >= 3) {
      const split2 = lines.slice(-2).map(l => l.split(/\s+/).filter(Boolean))
      if (split2.every(a => a.length === 2 && a.every(s => s.length >= 2))) {
        const opts = [...split2[0], ...split2[1]]
        out[n] = { question: lines.slice(0, -2).join(' ').replace(/\s+/g,' ').trim(),
                   options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
        continue
      }
    }
    if (lines.length >= 2) {
      const segs = lines[lines.length - 1].split(/\s+/).filter(Boolean)
      if (segs.length === 4 && segs.every(s => s.length >= 1)) {
        out[n] = { question: lines.slice(0, -1).join(' ').replace(/\s+/g,' ').trim(),
                   options: { A: segs[0], B: segs[1], C: segs[2], D: segs[3] } }
      }
    }
  }
  return out
}

function parseAnswersText(text) {
  const ans = {}
  const re = /答案([A-D]{20,})/g
  let m, n = 1
  while ((m = re.exec(text)) !== null) {
    for (const ch of m[1]) ans[n++] = ch
  }
  return ans
}

// Target definitions
// subject_tag and subject_name follow existing JSON conventions
const TARGETS = [
  { file: 'questions-doctor2.json', code: '102110', session: '第二次', roc: '102',
    stage_id: 1, c: '102',
    papers: [
      { s: '0103', subject: '醫學(三)', tag: 'internal_medicine', name: '醫學(三)' },
      { s: '0104', subject: '醫學(四)', tag: 'pediatrics',        name: '醫學(四)' },
      { s: '0105', subject: '醫學(五)', tag: 'surgery',            name: '醫學(五)' },
      { s: '0106', subject: '醫學(六)', tag: 'medical_law_ethics', name: '醫學(六)' },
    ]},
  { file: 'questions-tcm1.json', code: '102110', session: '第二次', roc: '102',
    stage_id: 0, c: '103',
    papers: [
      { s: '0201', subject: '中醫基礎醫學(一)', tag: 'tcm_basic_1', name: '中醫基礎醫學(一)' },
      { s: '0202', subject: '中醫基礎醫學(二)', tag: 'tcm_basic_2', name: '中醫基礎醫學(二)' },
    ]},
  { file: 'questions-tcm2.json', code: '102110', session: '第二次', roc: '102',
    stage_id: 0, c: '103',
    papers: [
      { s: '0203', subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1', name: '中醫臨床醫學(一)' },
      { s: '0204', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2', name: '中醫臨床醫學(二)' },
      { s: '0205', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3', name: '中醫臨床醫學(三)' },
      { s: '0206', subject: '中醫臨床醫學(四)', tag: 'tcm_clinical_4', name: '中醫臨床醫學(四)' },
    ]},
  { file: 'questions-nursing.json', code: '102110', session: '第二次', roc: '102',
    stage_id: 0, c: '109',
    papers: [
      { s: '0107', subject: '基礎醫學',               tag: 'basic_medicine',   name: '基礎醫學' },
      { s: '0501', subject: '基本護理學與護理行政', tag: 'basic_nursing',    name: '基本護理學與護理行政' },
      { s: '0502', subject: '內外科護理學',         tag: 'med_surg',         name: '內外科護理學' },
      { s: '0503', subject: '產兒科護理學',         tag: 'obs_ped',          name: '產兒科護理學' },
      { s: '0504', subject: '精神科與社區衛生護理學', tag: 'psych_community',  name: '精神科與社區衛生護理學' },
    ]},
  { file: 'questions-medlab.json', code: '102030', session: '第一次', roc: '102',
    stage_id: 0, c: '109',
    papers: [
      { s: '0107', subject: '臨床生理學與病理學',         tag: 'clinical_physio_path', name: '臨床生理學與病理學' },
      { s: '0501', subject: '臨床血液學與血庫學',         tag: 'hematology',           name: '臨床血液學與血庫學' },
      { s: '0502', subject: '醫學分子檢驗學與臨床鏡檢學', tag: 'molecular',            name: '醫學分子檢驗學與臨床鏡檢學' },
      { s: '0503', subject: '微生物學與臨床微生物學',     tag: 'microbiology',         name: '微生物學與臨床微生物學' },
      { s: '0504', subject: '生物化學與臨床生化學',       tag: 'biochemistry',         name: '生物化學與臨床生化學' },
      { s: '0505', subject: '臨床血清免疫學與臨床病毒學', tag: 'serology',             name: '臨床血清免疫學與臨床病毒學' },
    ]},
]

async function scrapePaper(t, p) {
  const qUrl = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${p.s}&q=1`
  const aUrl = `${BASE}?t=S&code=${t.code}&c=${t.c}&s=${p.s}&q=1`
  const qBuf = await fetchPdf(qUrl)
  const { text: qText } = await pdfParse(qBuf)
  if (qText.length < 500) throw new Error('question PDF too short')
  const parsed = parseQuestionsText(qText)
  await sleep(300)
  const aBuf = await fetchPdf(aUrl)
  const { text: aText } = await pdfParse(aBuf)
  const answers = parseAnswersText(aText)
  const qs = []
  for (let n = 1; n <= 80; n++) {
    const pq = parsed[n]
    const ans = answers[n]
    if (!pq || !ans) continue
    if (!['A','B','C','D'].every(k => (pq.options[k]||'').length >= 2)) continue
    qs.push({
      id: `${t.code}_${p.s}_${n}`,
      roc_year: t.roc,
      session: t.session,
      exam_code: t.code,
      subject: p.subject,
      subject_tag: p.tag,
      subject_name: p.name,
      stage_id: t.stage_id,
      number: n,
      question: stripPUA(pq.question),
      options: Object.fromEntries(['A','B','C','D'].map(k => [k, stripPUA(pq.options[k])])),
      answer: ans,
      explanation: '',
    })
  }
  return qs
}

async function main() {
  for (const t of TARGETS) {
    const fp = path.join(__dirname, '..', t.file)
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const existingKeys = new Set(data.questions.map(q => `${q.exam_code}_${q.subject}_${q.number}`))
    let added = 0
    for (const p of t.papers) {
      try {
        const qs = await scrapePaper(t, p)
        console.log(`  ${t.file} ${t.code} ${p.subject} → parsed ${qs.length}/80`)
        for (const q of qs) {
          const k = `${q.exam_code}_${q.subject}_${q.number}`
          if (existingKeys.has(k)) continue
          data.questions.push(q)
          existingKeys.add(k)
          added++
        }
        await sleep(400)
      } catch (e) {
        console.log(`  ⚠ ${t.file} ${t.code} ${p.s}: ${e.message}`)
      }
    }
    data.total = data.questions.length
    const tmp = fp + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, fp)
    console.log(`✅ ${t.file}: +${added}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
