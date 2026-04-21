#!/usr/bin/env node
// Fill recoverable phantom sessions: vet 100-1 / vet 101-1 / nutrition 100-1.

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const VET_FILE = path.join(__dirname, '..', 'questions-vet.json')
const NUT_FILE = path.join(__dirname, '..', 'questions-nutrition.json')

const VET_SUBJECTS = [
  { s: '11', subject: '獸醫病理學', tag: 'vet_pathology' },
  { s: '22', subject: '獸醫藥理學', tag: 'vet_pharmacology' },
  { s: '33', subject: '獸醫實驗診斷學', tag: 'vet_lab_diagnosis' },
  { s: '44', subject: '獸醫普通疾病學', tag: 'vet_common_disease' },
  { s: '55', subject: '獸醫傳染病學', tag: 'vet_infectious' },
  { s: '66', subject: '獸醫公共衛生學', tag: 'vet_public_health' },
]

const NUT_SUBJECTS = [
  { s: '0701', subject: '生理學與生物化學', tag: 'physio_biochem' },
  { s: '0702', subject: '營養學', tag: 'nutrition_science' },
  { s: '0703', subject: '膳食療養學', tag: 'diet_therapy' },
  { s: '0704', subject: '團體膳食設計與管理', tag: 'group_meal' },
  { s: '0705', subject: '公共衛生營養學', tag: 'public_nutrition' },
  { s: '0706', subject: '食品衛生與安全', tag: 'food_safety' },
]

// Nutrition 100-1 uses mixed 申論+測驗 format with no A./B./C./D. labels.
// Needs column-aware parser; deferred to future task. Vet 100/101-1 only for now.
const SESSIONS = [
  { bank: 'vet', year: '100', session: '第一次', code: '100020', c: '307', subjects: VET_SUBJECTS },
  { bank: 'vet', year: '101', session: '第一次', code: '101010', c: '307', subjects: VET_SUBJECTS },
]
void NUT_SUBJECTS; void NUT_FILE;

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) return reject(new Error('redir ' + res.statusCode))
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function parseQuestions(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  let i = lines.findIndex(l => /^1\.(\s|$)/.test(l) || l === '1.')
  if (i < 0) return []
  const qs = []
  const qNumRe = /^(\d{1,3})\.(.*)$/
  const matchNext = (line, expected) => {
    const m = line.match(qNumRe)
    if (!m) return null
    if (parseInt(m[1]) !== expected) return null
    return { num: expected, inline: m[2].trim() }
  }
  while (i < lines.length) {
    const expected = qs.length ? qs[qs.length - 1].num + 1 : 1
    const mNum = matchNext(lines[i], expected)
    if (!mNum) break
    const num = mNum.num
    i++
    const buckets = { stem: [], A: [], B: [], C: [], D: [] }
    let cur = 'stem'
    if (mNum.inline) buckets.stem.push(mNum.inline)
    while (i < lines.length) {
      const l = lines[i]
      if (matchNext(l, num + 1)) break
      const mOpt = l.match(/^([ABCD])\.(.*)$/)
      if (mOpt) {
        const exp = { stem: 'A', A: 'B', B: 'C', C: 'D' }[cur]
        if (mOpt[1] === exp) {
          cur = mOpt[1]
          if (mOpt[2]) buckets[cur].push(mOpt[2])
          i++
          continue
        }
      }
      buckets[cur].push(l)
      i++
    }
    qs.push({
      num,
      question: buckets.stem.join(''),
      options: { A: buckets.A.join(''), B: buckets.B.join(''), C: buckets.C.join(''), D: buckets.D.join('') },
    })
  }
  return qs
}

// Parse per-subject t=S answer PDF: 4 rows of 20 answers, full-width ＡＢＣＤ.
function parseAnswers(text) {
  const rows = text.match(/答案[ＡＢＣＤ#＃A-D]+/g) || []
  const toHalf = s => s.replace(/Ａ/g,'A').replace(/Ｂ/g,'B').replace(/Ｃ/g,'C').replace(/Ｄ/g,'D').replace(/＃/g,'#')
  const answers = new Array(80).fill('')
  for (let r = 0; r < Math.min(4, rows.length); r++) {
    const seq = toHalf(rows[r].replace('答案', ''))
    for (let i = 0; i < 20 && i < seq.length; i++) answers[r * 20 + i] = seq[i]
  }
  const disputed = new Set()
  const corrections = {}
  const noteMatch = text.match(/備\s*[　 ]?\s*註[：:]([^\n]+)/)
  if (noteMatch) {
    for (const item of noteMatch[1].split(/[，,]/)) {
      const mAll = item.match(/第(\d+)題一律給分/)
      if (mAll) { disputed.add(parseInt(mAll[1])); continue }
      const mDual = item.match(/第(\d+)題答([ABCDＡＢＣＤ])[、,．]([ABCDＡＢＣＤ])給分/)
      if (mDual) { disputed.add(parseInt(mDual[1])); corrections[parseInt(mDual[1])] = toHalf(mDual[2]) }
    }
  }
  return { answers, disputed, corrections }
}

async function scrapeSession(sess) {
  const results = []

  for (const sub of sess.subjects) {
    const qUrl = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${sess.code}&c=${sess.c}&s=${sub.s}&q=1`
    let qBuf, aBuf
    try { qBuf = await download(qUrl) } catch (e) { console.warn('SKIP Q', sess.code, sub.s, e.message); continue }
    for (const t of ['S', 'M', 'A']) {
      try {
        aBuf = await download(`https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=${t}&code=${sess.code}&c=${sess.c}&s=${sub.s}&q=1`)
        break
      } catch (e) {}
    }
    if (!aBuf) { console.warn('SKIP A (all t=S/M/A failed)', sess.code, sub.s); continue }
    const qText = (await pdfParse(qBuf)).text
    const aText = (await pdfParse(aBuf)).text
    const klass = qText.slice(0, 500)
    if (sess.bank === 'vet' && !klass.includes('獸醫師')) {
      console.warn(`WRONG EXAM ${sess.code} c=${sess.c} s=${sub.s} — expected 獸醫師`)
      continue
    }
    const parsed = parseQuestions(qText)
    const { answers, disputed, corrections } = parseAnswers(aText)

    const entries = parsed.map(p => {
      const raw = answers[p.num - 1]
      const ans = corrections[p.num] || (raw === '#' || raw === '＃' || !raw ? 'A' : raw)
      const q = {
        id: `${sess.code}_${sub.s}_${p.num}`,
        roc_year: sess.year,
        session: sess.session,
        exam_code: sess.code,
        subject: sub.subject,
        subject_tag: sub.tag,
        subject_name: sub.subject,
        stage_id: 0,
        number: p.num,
        question: p.question,
        options: p.options,
        answer: ans,
        explanation: '',
      }
      if (disputed.has(p.num)) q.disputed = true
      return q
    })
    const clean = entries.filter(e => e.question && e.options.A && e.options.B && e.options.C && e.options.D)
    console.log(`${sess.year}-${sess.session} ${sub.subject}: ${parsed.length} parsed → ${clean.length} clean`)
    results.push(...clean)
  }
  return results
}

async function main() {
  const vetBank = JSON.parse(fs.readFileSync(VET_FILE, 'utf8'))
  const vetArr = vetBank.questions || vetBank

  const newVet = []
  for (const sess of SESSIONS) {
    console.log(`\n=== ${sess.bank} ${sess.year}-${sess.session} (${sess.code} c=${sess.c}) ===`)
    const got = await scrapeSession(sess)
    newVet.push(...got)
  }

  const removeVet = new Set(['100020', '101010'])
  const vetKeep = vetArr.filter(q => !removeVet.has(q.exam_code))
  console.log(`\nVet: removed ${vetArr.length - vetKeep.length} old, added ${newVet.length} new`)

  const vetMerged = vetKeep.concat(newVet)
  if (vetBank.questions) vetBank.questions = vetMerged
  const tmp = VET_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(vetBank.questions ? vetBank : vetMerged, null, 2))
  fs.renameSync(tmp, VET_FILE)
  console.log('Wrote', VET_FILE, '—', vetMerged.length, 'total')
}

main().catch(e => { console.error(e); process.exit(1) })
