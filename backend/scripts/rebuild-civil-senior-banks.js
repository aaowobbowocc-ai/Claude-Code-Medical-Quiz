#!/usr/bin/env node
// 重爬 高考三等一般行政 103-114（行政學/行政法/法學知識與英文）→ shared banks。
// 取代舊 scrape-civil-senior.js（pdfjs）切錯選項的污染資料。
// 用 parseColumnAware + parseAnswersColumnAware（與 civil-senior-general 114 同一條好 parser）。
//
//   行政學            → common_admin_studies   (admin_studies)
//   行政法            → common_admin_law       (admin_law)
//   法學知識與英文     → common_law_knowledge   (law_knowledge_combined，整卷不拆)
//
// 同時清掉舊污染：constitution/law_basics/english 的 civil-senior rows、
// common_law_knowledge 的 civil-senior-general rows（114 那 38 題，將重抓）。
//
// Usage: node scripts/rebuild-civil-senior-banks.js [--apply]

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { fetchPdf } = require('./lib/pdf-fetcher')
const { parseColumnAware, parseAnswersColumnAware, parseAnswersText } = require('./lib/moex-column-parser')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const BANKS = path.join(__dirname, '..', 'shared-banks')
const APPLY = process.argv.includes('--apply')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// year → 高考三等一般行政 session code
const SESSION = {
  '103': '103080', '104': '104080', '105': '105080', '106': '106090',
  '107': '107090', '108': '108090', '109': '109090', '110': '110090',
  '111': '111090', '112': '112090', '113': '113080', '114': '114080',
}

// subject → bank / tag
const SUBJECTS = {
  admin_studies: { bank: 'common_admin_studies', tag: 'admin_studies', name: '行政學' },
  admin_law:     { bank: 'common_admin_law',     tag: 'admin_law',     name: '行政法' },
  law_knowledge: { bank: 'common_law_knowledge',
    tag: 'law_knowledge_combined',
    name: '法學知識與英文（包括中華民國憲法、法學緒論、英文）' },
}

// (year, subjectKey) → [c, s]  —— 由 scrape-civil-senior.js + 100-105 probe 確認
const CS = {
  // 行政學
  '103.admin_studies': ['201', '0401'], '105.admin_studies': ['201', '0504'],
  '106.admin_studies': ['201', '0504'], '107.admin_studies': ['301', '0607'],
  '108.admin_studies': ['201', '0607'], '109.admin_studies': ['301', '0604'],
  '110.admin_studies': ['301', '0501'], '111.admin_studies': ['301', '0301'],
  '112.admin_studies': ['301', '0301'], '113.admin_studies': ['301', '0303'],
  '114.admin_studies': ['201', '0303'],
  // 行政法
  '103.admin_law': ['201', '0503'], '104.admin_law': ['201', '0503'],
  '105.admin_law': ['201', '0601'], '106.admin_law': ['201', '0701'],
  '107.admin_law': ['301', '0801'], '108.admin_law': ['201', '0801'],
  '109.admin_law': ['301', '0801'], '110.admin_law': ['301', '0603'],
  '111.admin_law': ['301', '0403'], '112.admin_law': ['301', '0403'],
  '113.admin_law': ['301', '0403'], '114.admin_law': ['201', '0403'],
  // 法學知識與英文（103/105 該卷為申論或查無，略）
  '104.law_knowledge': ['201', '0111'], '106.law_knowledge': ['201', '0210'],
  '107.law_knowledge': ['301', '0210'], '108.law_knowledge': ['201', '0213'],
  '109.law_knowledge': ['301', '0216'], '110.law_knowledge': ['301', '0105'],
  '111.law_knowledge': ['301', '0115'], '112.law_knowledge': ['301', '0118'],
  '113.law_knowledge': ['301', '0112'], '114.law_knowledge': ['201', '0401'],
}

function loadBank(id) {
  return JSON.parse(fs.readFileSync(path.join(BANKS, id + '.json'), 'utf-8'))
}
function saveBank(id, b) {
  b.bankVersion = (Number(b.bankVersion) || 0) + 1
  b.last_synced_at = new Date().toISOString()
  const p = path.join(BANKS, id + '.json')
  fs.writeFileSync(p + '.tmp', JSON.stringify(b, null, 2))
  fs.renameSync(p + '.tmp', p)
}

async function main() {
  // ── 1. 清掉舊污染 ──
  const cleanup = {
    common_constitution:  q => q.source_exam_code === 'civil-senior',
    common_law_basics:    q => q.source_exam_code === 'civil-senior',
    common_english:       q => q.source_exam_code === 'civil-senior',
    common_admin_studies: q => q.source_exam_code === 'civil-senior',
    common_admin_law:     q => q.source_exam_code === 'civil-senior',
    common_law_knowledge: q => q.source_exam_code === 'civil-senior-general' || q.source_exam_code === 'civil-senior',
  }
  const banks = {}
  for (const [id, pred] of Object.entries(cleanup)) {
    const b = loadBank(id)
    const before = b.questions.length
    b.questions = b.questions.filter(q => !pred(q))
    banks[id] = b
    console.log(`  清理 ${id}: ${before} → ${b.questions.length}  (-${before - b.questions.length})`)
  }

  // ── 2. 重爬 ──
  let added = 0, gaps = []
  for (const year of Object.keys(SESSION)) {
    for (const subjKey of Object.keys(SUBJECTS)) {
      const cs = CS[`${year}.${subjKey}`]
      if (!cs) continue
      const [c, s] = cs
      const code = SESSION[year]
      const subj = SUBJECTS[subjKey]
      let qbuf, abuf
      try { qbuf = await fetchPdf(`${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`) }
      catch (e) { console.log(`  ✗ ${year} ${subj.name}: Q ${e.message}`); continue }
      try { abuf = await fetchPdf(`${BASE}?t=S&code=${code}&c=${c}&s=${s}&q=1`) } catch { abuf = null }

      let parsed = {}
      try { parsed = await parseColumnAware(qbuf) } catch (e) { console.log(`  ✗ ${year} ${subj.name}: parse ${e.message}`); continue }
      let ans = {}
      if (abuf) {
        try { ans = await parseAnswersColumnAware(abuf) } catch {}
        if (Object.keys(ans).length < 10) {
          try { const pdfParse = require('pdf-parse'); ans = parseAnswersText((await pdfParse(abuf)).text) } catch {}
        }
      }
      const bank = banks[subj.bank]
      const byId = new Map(bank.questions.map(q => [q.id, q]))
      let n = 0
      const nums = Object.keys(parsed).map(Number).sort((a, b) => a - b)
      const expectMax = subjKey === 'law_knowledge' ? 50 : 25
      for (const num of nums) {
        if (num < 1 || num > expectMax) continue
        const q = parsed[num]
        const a = ans[num]
        if (!a || !/^[ABCD]$/.test(a)) continue
        if (!q.question || !q.options || ['A','B','C','D'].some(k => !q.options[k])) continue
        const id = `${subj.bank}-${year}-civil-senior-${num}`
        byId.set(id, {
          id, roc_year: year, session: '第一次',
          source_exam_code: 'civil-senior', source_exam_name: `${year} 年高考三等一般行政`,
          subject: subj.name, subject_tags: [subj.tag], number: num,
          question: q.question, options: q.options, answer: a,
          level: 'senior', shared_bank: subj.bank,
          parent_id: null, case_context: null, is_deprecated: false, deprecated_reason: null,
        })
        n++; added++
      }
      bank.questions = Array.from(byId.values())
      const miss = expectMax - n
      console.log(`  ${year} ${subj.name}: +${n}/${expectMax}` + (miss > 0 ? ` ⚠缺${miss}` : ''))
      if (miss > 0) gaps.push(`${year} ${subj.name} 缺${miss}`)
      await sleep(250)
    }
  }

  console.log(`\n總重建 ${added} 題；缺口 ${gaps.length} 處`)
  if (gaps.length) gaps.forEach(g => console.log('  - ' + g))
  if (!APPLY) { console.log('\n(dry-run，未寫入)'); return }
  for (const [id, b] of Object.entries(banks)) saveBank(id, b)
  console.log('\n✅ 6 個 bank 已寫入')
}
main().catch(e => { console.error(e); process.exit(1) })
