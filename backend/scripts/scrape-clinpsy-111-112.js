#!/usr/bin/env node
// 臨床/諮商心理師 111-112 年 backfill。
// 111/112 心理師用合併場次 111100/112100，c=315(臨床)/316(諮商)，s=11~66（2碼）。
// 無 ABCD 標記 → column parser。每科 40 測驗題，每類科每年 240 題。
// URL 由使用者提供並驗證 2026-05-20。
//
// Usage: node scripts/scrape-clinpsy-111-112.js [--apply]

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { fetchPdf } = require('./lib/pdf-fetcher')
const { parseAnswersText } = require('./lib/moex-column-parser')

// 111/112 心理師 PDF：有 1./A. 標記，純文字可解（測驗題段）。
function parseMC(fullText) {
  const cut = fullText.search(/測驗題/)
  if (cut < 0) return []
  const lines = fullText.slice(cut).split(/\n/).map(l => l.trim()).filter(Boolean)
  const out = []
  let cur = null, curOpt = null
  const flush = () => {
    if (cur && cur.question && ['A','B','C','D'].every(k => cur.options[k])) {
      cur.question = cur.question.replace(/\s+/g, ' ').trim()
      for (const k of ['A','B','C','D']) cur.options[k] = cur.options[k].replace(/\s+/g, ' ').trim()
      if (cur.question.length >= 6) out.push(cur)
    }
    cur = null; curOpt = null
  }
  for (const line of lines) {
    if (/^(代\s*號|頁\s*次|類\s*科|科\s*目|※|測驗題|本試題|考試時間|座號)/.test(line)) continue
    const qm = line.match(/^(\d{1,2})[.、．]\s*(.*)$/)
    const om = line.match(/^([A-D])[.、．]\s*(.*)$/)
    // 題號可能單獨成行（題幹在後續行）→ qm[2] 空白也算題目起點
    const isBareNum = qm && (qm[2] || '').trim() === ''
    if (qm && ((!cur && +qm[1] === 1) || (cur && +qm[1] === cur.number + 1)) &&
        (isBareNum || /[一-鿿A-Za-z]/.test(qm[2] || ''))) {
      flush()
      cur = { number: +qm[1], question: qm[2] || '', options: {} }
    } else if (om && cur && (om[1] === 'A' || cur.options[String.fromCharCode(om[1].charCodeAt(0) - 1)])) {
      curOpt = om[1]
      cur.options[curOpt] = om[2]
    } else if (curOpt && cur) {
      cur.options[curOpt] += ' ' + line
    } else if (cur && !curOpt) {
      cur.question += ' ' + line
    }
  }
  flush()
  return out
}

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const ROOT = path.resolve(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 6 科目（subject / subject_tag 對齊既有 113/114 資料）
const CLINICAL = [
  ['臨床心理學基礎', 'cp_basic'],
  ['臨床心理學總論(一)', 'cp_general_1'],
  ['臨床心理學總論(二)', 'cp_general_2'],
  ['臨床心理學特論(一)', 'cp_special_1'],
  ['臨床心理學特論(二)', 'cp_special_2'],
  ['臨床心理學特論(三)', 'cp_special_3'],
]
const COUNSELING = [
  ['諮商的心理學基礎', 'cou_basic'],
  ['諮商與心理治療理論', 'cou_theory'],
  ['諮商與心理治療實務與專業倫理', 'cou_practice'],
  ['心理健康與變態心理學', 'cou_mental_health'],
  ['個案評估與心理衡鑑', 'cou_assessment'],
  ['團體諮商與心理治療', 'cou_group'],
]
const S_CODES = ['11', '22', '33', '44', '55', '66']

const TARGETS = [
  { file: 'questions-clinical-psychology.json',   klass: '臨床心理師', c: '315', papers: CLINICAL },
  { file: 'questions-counseling-psychology.json', klass: '諮商心理師', c: '316', papers: COUNSELING },
]
const YEARS = [['111', '111100'], ['112', '112100']]

async function getPdf(kind, code, c, s) {
  return fetchPdf(`${BASE}?t=${kind}&code=${code}&c=${c}&s=${s}&q=1`, {
    referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
  })
}

async function main() {
  let grand = 0
  for (const t of TARGETS) {
    const filePath = path.join(ROOT, t.file)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const qs = data.questions || data
    const haveId = new Set(qs.map(q => q.id))
    let added = 0

    for (const [year, code] of YEARS) {
      for (let pi = 0; pi < 6; pi++) {
        const s = S_CODES[pi]
        const [subject, tag] = t.papers[pi]
        let qbuf, abuf
        try {
          qbuf = await getPdf('Q', code, t.c, s)
          abuf = await getPdf('S', code, t.c, s)
        } catch (e) { console.log(`  ✗ ${code} c=${t.c} s=${s}: ${e.message}`); continue }

        const qtext = (await pdfParse(qbuf)).text
        // 驗證類科
        if (!qtext.slice(0, 400).normalize('NFKC').includes(t.klass)) {
          console.log(`  ⚠ ${code} c=${t.c} s=${s} 類科不符，跳過`); continue
        }
        const parsed = parseMC(qtext)
        const answers = parseAnswersText((await pdfParse(abuf)).text)

        let n = 0
        for (const q of parsed) {
          const num = q.number
          if (num < 1 || num > 40) continue
          const ans = answers[num]
          if (!ans || !/^[ABCD]$/.test(ans)) continue
          if (!q.question || !q.options || ['A','B','C','D'].some(k => !q.options[k])) continue
          const id = `${code}_${pi + 1}_${num}`
          if (haveId.has(id)) continue
          qs.push({
            id, roc_year: year, session: '第二次', exam_code: code,
            subject, subject_tag: tag, subject_name: subject, stage_id: 0,
            number: num, question: q.question, options: q.options,
            answer: ans, explanation: '',
          })
          haveId.add(id); n++; added++; grand++
        }
        console.log(`  ${t.klass} ${year} ${subject}: +${n}/40`)
        await sleep(250)
      }
    }
    console.log(`${t.klass}: 共新增 ${added}\n`)
    if (APPLY && added) {
      data.questions = qs
      if (data.total !== undefined) data.total = qs.length
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, filePath)
      console.log(`✅ ${t.file} 已寫入（${qs.length} 題）\n`)
    }
  }
  console.log(`${APPLY ? '✅' : '(dry-run)'} 總計 +${grand} 題`)
}
main().catch(e => { console.error(e); process.exit(1) })
