#!/usr/bin/env node
/**
 * 補「考試設定裡有、但題庫整科都沒有」的卷。
 *
 * 社工師就是這樣：exam-configs/social-worker.json 的 papers 列了六科，
 * 前端的分頁與分類也都準備好了，但題庫只有三科——社會政策與社會立法、
 * 人類行為與社會環境、社會工作研究方法 24 個場次全缺，約 2,880 題。
 * 因為題數在既有的三科裡是滿的，缺題盤點完全看不出來。
 *
 * 跟 fill-missing-papers.js 的差別：那支要手動在程式裡列 TARGETS，
 * 這支從 exam-configs 自動推導「應該要有哪些科目」，再跟題庫現況比對。
 *
 * 用法：
 *   node scripts/fill-missing-subjects.js --exam social-worker          # dry-run
 *   node scripts/fill-missing-subjects.js --exam social-worker --apply
 *   --code 114030 只補單一場次
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { probeCodes, nameCandidates, fetchSheet } = require('./lib/moex-paper-resolve')
const { pdfQuestions } = require('./lib/moex-pdf-parse')
const { parseAnswerSheet } = require('./lib/moex-answer-sheet')
const { warnZero, summary } = require('./lib/coverage-guard')
const { nameKey, skeleton } = require('./lib/moex-normalize')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d }
const EXAM = arg('--exam')
const ONLY_CODE = arg('--code')
const APPLY = process.argv.includes('--apply')
if (!EXAM) { console.error('需要 --exam'); process.exit(1) }

const DIR = path.join(__dirname, '..')
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'exam-configs', `${EXAM}.json`), 'utf8'))
const FILE = path.join(DIR, cfg.questionsFile || (EXAM === 'doctor1' ? 'questions.json' : `questions-${EXAM}.json`))

;(async () => {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const arr = raw.questions || raw
  const stageByTag = new Map((cfg.stages || []).map(s => [s.tag, s.id]))
  const wanted = (cfg.papers || []).map(p => ({
    subject: p.subject || p.name,
    tag: p.id,
    name: p.name,
    stage: stageByTag.get(p.id) ?? 0,
  }))
  if (!wanted.length) { console.error('exam-configs 沒有 papers'); process.exit(1) }
  console.log(`${EXAM}：設定檔列了 ${wanted.length} 科 — ${wanted.map(w => w.subject).join('、')}\n`)

  const codes = [...new Set(arr.map(q => String(q.exam_code)).filter(Boolean))].sort()
    .filter(c => !ONLY_CODE || c === ONLY_CODE)
  let nextId = Math.max(0, ...arr.map(q => Number(q.id)).filter(Number.isFinite)) + 1
  const added = []

  for (const code of codes) {
    const have = new Set(arr.filter(q => String(q.exam_code) === code).map(q => q.subject))
    const missing = wanted.filter(w => !have.has(w.subject))
    if (!missing.length) continue
    const sample = arr.find(q => String(q.exam_code) === code)
    const probe = probeCodes(code, code.slice(0, 3))

    for (const w of missing) {
      const { list } = nameCandidates(EXAM, w.subject, probe)
      if (!list.length) { console.log(`  ${code} ${w.subject}: 反查不到官方卷`); continue }
      // ⚠️ nameCandidates 含前綴比對：找「社會工作研究方法」會把官方的「社會工作」
      // 也算成候選（後者是前者的前綴），抓下來就整卷抓錯。完全相等的排前面。
      const ranked = [...list].sort((a, b) => {
        const ea = nameKey(a.subject) === nameKey(w.subject) ? 0 : 1
        const eb = nameKey(b.subject) === nameKey(w.subject) ? 0 : 1
        return ea - eb || nameKey(b.subject).length - nameKey(a.subject).length
      })
      let picked = null
      for (const c of ranked) {
        try {
          const qb = await fetchSheet('Q', code, c.c, c.s)
          if (!qb) continue
          const parsed = await pdfQuestions(qb)
          if (parsed.size < 10) continue
          let ans = {}
          try { const sb = await fetchSheet('S', code, c.c, c.s); if (sb) ans = await parseAnswerSheet(sb) } catch {}
          picked = { c, parsed, ans }
          break
        } catch {}
      }
      if (!picked) { console.log(`  ${code} ${w.subject}: 試題卷抓不到或解析不出來`); continue }

      // 保護：抓到的卷不能其實是這個場次已經有的另一科（前綴比對抓錯時就會這樣）
      const existing = new Set(arr.filter(q => String(q.exam_code) === code)
        .map(q => skeleton(q.question).slice(0, 25)))
      const overlap = [...picked.parsed.values()]
        .filter(o => existing.has(skeleton(o.stem).slice(0, 25))).length
      if (overlap > picked.parsed.size * 0.3) {
        console.log(`  ${code} ${w.subject}: 抓到的卷與現有題目重疊 ${overlap}/${picked.parsed.size}，應該是抓錯卷，跳過`)
        continue
      }

      const rows = []
      for (const [num, o] of picked.parsed) {
        const a = picked.ans[num]
        // 沒有答案就不要收——寧可少題，也不要給使用者一題沒有正解的題目
        if (!a || !/^[ABCD]$/.test(String(a))) continue
        const opts = { A: o.options[0], B: o.options[1], C: o.options[2], D: o.options[3] }
        if (['A', 'B', 'C', 'D'].some(k => !opts[k] || !String(opts[k]).trim())) continue
        rows.push({
          id: nextId++,
          roc_year: sample?.roc_year, session: sample?.session, exam_code: code,
          subject: w.subject, subject_tag: w.tag, subject_name: w.name, stage_id: w.stage,
          number: num,
          question: String(o.stem).replace(/^[\s.．、]+/, ''),
          options: opts, answer: String(a), explanation: '',
        })
      }
      console.log(`  ${code} ${w.subject}: 解析 ${picked.parsed.size} / 答案 ${Object.keys(picked.ans).length} → 收 ${rows.length} 題 (c=${picked.c.c} s=${picked.c.s})`)
      added.push(...rows)
    }
  }

  console.log(`\n共可新增 ${added.length} 題${APPLY ? '' : '（dry-run）'}`)
  warnZero(`${EXAM} 補缺科`, added.length, '設定檔的科目與題庫一致，或官方卷解析不出來')
  if (APPLY && added.length) {
    arr.push(...added)
    if (raw.total !== undefined) raw.total = arr.length
    if (raw.metadata) raw.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(FILE, JSON.stringify(raw, null, 2) + '\n')
    console.log(`✅ 已寫入 ${path.basename(FILE)}（總題數 ${arr.length}）`)
  }
  process.exitCode = summary()
})()
