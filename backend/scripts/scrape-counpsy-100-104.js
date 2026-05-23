#!/usr/bin/env node
/**
 * Scrape 諮商心理師 100-104: backfill missing papers per _psych-fullmap.json.
 *
 * Coverage strategy (see handover audit 2026-05-23):
 *   - 100/101 (3-paper era, c=110/109/107): backfill 實務 + 團體 (2/paper-session)
 *   - 102/103030/104030 (4-paper era, c=108): backfill 實務 + 團體
 *   - 103100 (6-paper era, c=108): backfill 實務 + 心理健康變態 + 個案評估 + 團體
 *
 * Existing 100-104 cou_basic for 100030/100140/101030/101110 is contamination
 * from clinical psychology and is removed by a separate purge step (see
 * --purge-bad-basic flag below). cou_basic/cou_theory for 102-104030 was
 * verified PDF-matching during audit and left intact.
 *
 * Parsing uses moex-column-parser.parseColumnAware (proven on 6 probe targets,
 * 40/40 Q each). Header check requires "類科：諮商心理師" before any write.
 * Idempotent: skips (exam_code, subject_tag, number) already present.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { fetchPdf } = require('./lib/pdf-fetcher')
const { parseColumnAware, parseAnswersColumnAware, parseAnswersText } = require('./lib/moex-column-parser')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const DRY = process.argv.includes('--dry-run')
const PURGE_BAD = process.argv.includes('--purge-bad-basic')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// (year, exam_code, session, c, s, subject_name, subject_tag, expectedQ)
const TARGETS = [
  // 100030 c=110 (第一次, 3 papers): backfill 實務 + 團體
  ['100', '100030', '第一次', '110', '0809', '諮商與心理治療實務與專業倫理', 'cou_practice', 40],
  ['100', '100030', '第一次', '110', '0810', '團體諮商與心理治療',           'cou_group',    40],
  // 100140 c=109 (第二次, 3 papers)
  ['100', '100140', '第二次', '109', '0709', '諮商與心理治療實務與專業倫理', 'cou_practice', 40],
  ['100', '100140', '第二次', '109', '0710', '團體諮商與心理治療',           'cou_group',    40],
  // 101030 c=109 (第一次, 3 papers)
  ['101', '101030', '第一次', '109', '0709', '諮商與心理治療實務與專業倫理', 'cou_practice', 40],
  ['101', '101030', '第一次', '109', '0710', '團體諮商與心理治療',           'cou_group',    40],
  // 101110 c=107 (第二次, 3 papers)
  ['101', '101110', '第二次', '107', '0409', '諮商與心理治療實務與專業倫理', 'cou_practice', 40],
  ['101', '101110', '第二次', '107', '0410', '團體諮商與心理治療',           'cou_group',    40],
  // 102030 c=108 (第一次, 4 papers): backfill 實務 + 團體
  ['102', '102030', '第一次', '108', '0409', '諮商與心理治療實務與專業倫理', 'cou_practice', 40],
  ['102', '102030', '第一次', '108', '0412', '團體諮商與心理治療',           'cou_group',    40],
  // 102110 c=108 (第二次, 4 papers)
  ['102', '102110', '第二次', '108', '0409', '諮商與心理治療實務與專業倫理', 'cou_practice', 40],
  ['102', '102110', '第二次', '108', '0412', '團體諮商與心理治療',           'cou_group',    40],
  // 103030 c=108 (第一次, 4 papers)
  ['103', '103030', '第一次', '108', '0409', '諮商與心理治療實務與專業倫理', 'cou_practice', 40],
  ['103', '103030', '第一次', '108', '0412', '團體諮商與心理治療',           'cou_group',    40],
  // 103100 c=108 (第二次, 6 papers): backfill 實務 + 心理健康變態 + 個案評估 + 團體
  ['103', '103100', '第二次', '108', '0409', '諮商與心理治療實務與專業倫理', 'cou_practice',      40],
  ['103', '103100', '第二次', '108', '0410', '心理健康與變態心理學',          'cou_mental_health', 40],
  ['103', '103100', '第二次', '108', '0411', '個案評估與心理衡鑑',            'cou_assessment',    40],
  ['103', '103100', '第二次', '108', '0412', '團體諮商與心理治療',            'cou_group',         40],
  // 104030 c=108 (第一次, 4 papers): backfill 實務 + 團體
  ['104', '104030', '第一次', '108', '0409', '諮商與心理治療實務與專業倫理', 'cou_practice', 40],
  ['104', '104030', '第一次', '108', '0412', '團體諮商與心理治療',           'cou_group',    40],
]

async function main() {
  const fp = path.join(__dirname, '..', 'questions-counseling-psychology.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = data.questions || data
  const seen = new Set(arr.map(q => `${q.exam_code}_${q.subject_tag}_${q.number}`))
  let nextId = arr.reduce((m, q) => Math.max(m, +q.id || 0), 0) + 1
  const added = []
  let totalParsed = 0, totalExpected = 0, papersOK = 0, papersBad = 0
  const badReports = []

  for (const [year, code, session, c, s, name, tag, expectQ] of TARGETS) {
    totalExpected += expectQ
    process.stdout.write(`▶ ${year} ${session} ${name} (code=${code} c=${c} s=${s}) … `)
    let qBuf, aBuf
    try { qBuf = await fetchPdf(`${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`) }
    catch (e) { console.log(`✗ Q PDF: ${e.message}`); papersBad++; badReports.push(`${code}/${tag}: Q ${e.message}`); continue }
    try { aBuf = await fetchPdf(`${BASE}?t=S&code=${code}&c=${c}&s=${s}&q=1`) }
    catch (e) {
      // 100-105 era: some papers have no t=S; t=M ("更正答案") provides the
      // same standard-answer block plus a corrections (#) annotation.
      try {
        aBuf = await fetchPdf(`${BASE}?t=M&code=${code}&c=${c}&s=${s}&q=1`)
        process.stdout.write('[t=M fallback] ')
      } catch (e2) { console.log(`⚠ S/M PDF: ${e2.message}`); aBuf = null }
    }

    // header verification — must contain 諮商心理師 + the subject name (loose match)
    const { text } = await pdfParse(qBuf)
    const head = text.normalize('NFC').slice(0, 500)
    if (!head.includes('諮商心理師')) {
      console.log(`✗ HEADER 缺「諮商心理師」`); papersBad++
      badReports.push(`${code}/${tag}: header missing 諮商心理師`)
      continue
    }

    let parsed = {}
    try { parsed = await parseColumnAware(qBuf) }
    catch (e) { console.log(`✗ parse: ${e.message}`); papersBad++; badReports.push(`${code}/${tag}: parse ${e.message}`); continue }

    // answer parse: column-aware first, then text fallback (half-width / line numbered)
    let answers = {}
    if (aBuf) {
      try { answers = await parseAnswersColumnAware(aBuf) } catch {}
      if (Object.keys(answers).length < 10) {
        try {
          const { text: aText } = await pdfParse(aBuf)
          const ta = parseAnswersText(aText.normalize('NFC'))
          if (Object.keys(ta).length > Object.keys(answers).length) answers = ta
        } catch {}
      }
    }

    const nums = Object.keys(parsed).map(Number).sort((a, b) => a - b)
    let kept = 0, skipDup = 0, skipBad = 0
    for (const num of nums) {
      const q = parsed[num]
      const ans = answers[num]
      if (!ans || !/^[ABCD]$/.test(ans)) { skipBad++; continue }
      if (!q.question || !q.options || ['A','B','C','D'].some(k => !q.options[k])) { skipBad++; continue }
      const key = `${code}_${tag}_${num}`
      if (seen.has(key)) { skipDup++; continue }
      seen.add(key)
      added.push({
        id: nextId++, roc_year: year, session, exam_code: code,
        subject: name, subject_tag: tag, subject_name: name, stage_id: 0,
        number: num, question: q.question, options: q.options, answer: ans, explanation: '',
      })
      kept++
    }
    totalParsed += kept
    papersOK++
    console.log(`parsed ${nums.length}/A=${Object.keys(answers).length} kept=${kept} dup=${skipDup} bad=${skipBad}`)
    await sleep(300)
  }

  console.log(`\n=== Scrape summary ===`)
  console.log(`Papers OK: ${papersOK} / Bad: ${papersBad}`)
  console.log(`Kept ${totalParsed} / Expected ${totalExpected} (${(totalParsed/totalExpected*100).toFixed(1)}%)`)
  if (badReports.length) {
    console.log('Bad reports:')
    for (const r of badReports) console.log('  -', r)
  }

  // Purge contamination: 100/101 cou_basic (160 records, no such subject in these years)
  let purged = 0
  if (PURGE_BAD) {
    const BAD_CODES = ['100030', '100140', '101030', '101110']
    const before = arr.length
    const filtered = arr.filter(q => !(BAD_CODES.includes(q.exam_code) && q.subject_tag === 'cou_basic'))
    purged = before - filtered.length
    if (purged > 0) {
      data.questions = filtered
      console.log(`\nPurge 100/101 cou_basic 污染: removed ${purged} records`)
    }
  }

  if (DRY) {
    console.log(`\n[dry-run] 預計新增 ${added.length} 題，刪除 ${purged} 題（含 --purge-bad-basic 旗標時才刪）。未寫入。`)
    return
  }

  if (!added.length && !purged) { console.log('\n(無變更)'); return }
  const final = (data.questions || arr)
  if (added.length) {
    final.push(...added)
  }
  data.questions = final
  data.total = final.length
  fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n')
  console.log(`\n✅ 寫入：+${added.length} -${purged} → total ${final.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
