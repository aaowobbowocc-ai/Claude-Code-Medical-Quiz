#!/usr/bin/env node
// 重爬 司法特考三等「法學知識與英文」106-114 → common_law_knowledge。
// 取代 questions-judicial.json（舊 scraper 選項位移污染 ~72 題）。
// 用 parseColumnAware（與 civil-senior 重建同條好 parser）。
//
// Usage: node scripts/rebuild-judicial-banks.js [--apply]

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { fetchPdf } = require('./lib/pdf-fetcher')
const { parseColumnAware, parseAnswersColumnAware, parseAnswersText } = require('./lib/moex-column-parser')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const BANK = path.join(__dirname, '..', 'shared-banks', 'common_law_knowledge.json')
const APPLY = process.argv.includes('--apply')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// year → [code, c, s]  司法特考三等 法學知識與英文（c=101，s 由 CLAUDE.md 確認）
const SESSIONS = {
  '106': ['106130', '101', '0415'], '107': ['107130', '101', '0414'],
  '108': ['108130', '101', '0414'], '109': ['109130', '101', '0412'],
  '110': ['110130', '101', '0315'], '111': ['111130', '101', '0315'],
  '112': ['112130', '101', '0313'], '113': ['113120', '101', '0309'],
  '114': ['114120', '101', '0309'],
}

const BANKS_DIR = path.join(__dirname, '..', 'shared-banks')

async function main() {
  // 清掉舊污染：judicial 法學知識與英文 曾被誤拆進 constitution/law_basics/english
  const splitBanks = {}
  for (const id of ['common_constitution', 'common_law_basics', 'common_english']) {
    const p = path.join(BANKS_DIR, id + '.json')
    const b = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const before = b.questions.length
    b.questions = b.questions.filter(q => q.source_exam_code !== 'judicial')
    splitBanks[id] = { path: p, data: b }
    console.log(`  清理 ${id} judicial rows: ${before} → ${b.questions.length}`)
  }

  const bank = JSON.parse(fs.readFileSync(BANK, 'utf-8'))
  const before = bank.questions.length
  bank.questions = bank.questions.filter(q => q.source_exam_code !== 'judicial')
  console.log(`  清理 common_law_knowledge judicial rows: ${before} → ${bank.questions.length}`)
  const byId = new Map(bank.questions.map(q => [q.id, q]))

  let added = 0, gaps = []
  for (const [year, [code, c, s]] of Object.entries(SESSIONS)) {
    let qbuf, abuf
    try { qbuf = await fetchPdf(`${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`) }
    catch (e) { console.log(`  ✗ ${year}: Q ${e.message}`); continue }
    try { abuf = await fetchPdf(`${BASE}?t=S&code=${code}&c=${c}&s=${s}&q=1`) } catch { abuf = null }

    let parsed = {}
    try { parsed = await parseColumnAware(qbuf) } catch (e) { console.log(`  ✗ ${year}: parse ${e.message}`); continue }
    let ans = {}
    if (abuf) {
      try { ans = await parseAnswersColumnAware(abuf) } catch {}
      if (Object.keys(ans).length < 10) {
        try { const pp = require('pdf-parse'); ans = parseAnswersText((await pp(abuf)).text) } catch {}
      }
    }
    let n = 0
    for (const num of Object.keys(parsed).map(Number).sort((a, b) => a - b)) {
      if (num < 1 || num > 50) continue
      const q = parsed[num], a = ans[num]
      if (!a || !/^[ABCD]$/.test(a)) continue
      if (!q.question || !q.options || ['A','B','C','D'].some(k => !q.options[k])) continue
      const id = `common_law_knowledge-${year}-judicial-${num}`
      byId.set(id, {
        id, roc_year: year, session: '第一次',
        source_exam_code: 'judicial', source_exam_name: `${year} 年司法特考三等`,
        subject: '法學知識與英文（包括中華民國憲法、法學緒論、英文）',
        subject_tags: ['law_knowledge_combined'], number: num,
        question: q.question, options: q.options, answer: a,
        level: 'senior', shared_bank: 'common_law_knowledge',
        parent_id: null, case_context: null, is_deprecated: false, deprecated_reason: null,
      })
      n++; added++
    }
    console.log(`  ${year}: +${n}/50` + (n < 50 ? ` ⚠缺${50 - n}` : ''))
    if (n < 50) gaps.push(`${year} 缺${50 - n}`)
    await sleep(250)
  }
  bank.questions = Array.from(byId.values())
  console.log(`\n總重建 ${added} 題（judicial）；缺口 ${gaps.join(', ') || '無'}`)
  if (!APPLY) { console.log('(dry-run)'); return }
  for (const { path: p, data } of Object.values(splitBanks)) {
    data.bankVersion = (Number(data.bankVersion) || 0) + 1
    data.last_synced_at = new Date().toISOString()
    fs.writeFileSync(p + '.tmp', JSON.stringify(data, null, 2))
    fs.renameSync(p + '.tmp', p)
  }
  bank.bankVersion = (Number(bank.bankVersion) || 0) + 1
  bank.last_synced_at = new Date().toISOString()
  fs.writeFileSync(BANK + '.tmp', JSON.stringify(bank, null, 2))
  fs.renameSync(BANK + '.tmp', BANK)
  console.log('✅ common_law_knowledge + 3 split banks 已寫入')
}
main().catch(e => { console.error(e); process.exit(1) })
