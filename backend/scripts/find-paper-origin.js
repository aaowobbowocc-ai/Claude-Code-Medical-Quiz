#!/usr/bin/env node
/**
 * 反查「我們這卷的題目，真正出自考選部哪一場哪一科」。
 *
 * audit-paper-alignment 會告訴你某卷內容對不上原卷，但不會說它到底是哪來的。
 * 知道來源才分得出是哪一種事故：
 *   - 全部指向同一場次的同一科 → 場次標錯（改 exam_code 就好）
 *   - 全部指向同一場次的不同科 → 卷別錯置
 *   - 指向別的考試          → 跨考試污染（只能整卷重建）
 *   - 找不到出處            → 題源根本不是考選部，或題幹被改寫過
 *
 * ⚠️ 只用題幹比對，不要加選項比對。選項比對（四取三相同）在圈號選項
 * （①②③④）和短選項上會大量誤中——2026-09-16 用它查獸醫時，
 * 把藥師的題判成獸醫病理學，得出「401/480 找到出處」的假結論。
 *
 * 用法：
 *   node scripts/find-paper-origin.js --exam pt --code 106020
 *   node scripts/find-paper-origin.js --exam pt --code 106020 --subject 物理治療基礎學
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { probeCodes, fetchSheet } = require('./lib/moex-paper-resolve')
const { pdfStems } = require('./lib/moex-pdf-parse')
const { skeleton } = require('./lib/moex-normalize')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d }
const EXAM = arg('--exam')
const CODE = arg('--code')
const ONLY = arg('--subject')
const FILTER = arg('--match')      // 只掃科目名含這個字的卷，例如 --match 物理治療
if (!EXAM || !CODE) { console.error('需要 --exam 與 --code'); process.exit(1) }
const FILE = path.join(__dirname, '..', EXAM === 'doctor1' ? 'questions.json' : `questions-${EXAM}.json`)

const key = q => skeleton(q.question).replace(/^【題組情境】/, '').slice(0, 18)

;(async () => {
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const arr = j.questions || j
  const mine = arr.filter(q => String(q.exam_code) === CODE && (!ONLY || q.subject === ONLY))
  if (!mine.length) { console.error('找不到題目'); process.exit(1) }
  console.log(`${EXAM} ${CODE}${ONLY ? ' ' + ONLY : ''}：${mine.length} 題要反查出處\n`)

  const codes = [...new Set(arr.map(q => String(q.exam_code)).filter(Boolean))].sort()
  const found = new Map()
  const re = FILTER ? new RegExp(FILTER) : null

  for (const c of codes) {
    const cands = probeCodes(c, c.slice(0, 3)).filter(x => !re || re.test(x.subject))
    for (const cand of cands) {
      let stems
      try { const b = await fetchSheet('Q', c, cand.c, cand.s); if (!b) continue; stems = await pdfStems(b) } catch { continue }
      if (!stems.size) continue
      const all = [...stems.values()].join('|')
      let hit = 0
      for (const q of mine) {
        if (found.has(q.id)) continue
        const s = key(q)
        if (s.length >= 14 && all.includes(s)) { found.set(q.id, { code: c, subject: cand.subject, from: q.subject }); hit++ }
      }
      if (hit) console.log(`  ${c} ${cand.subject.slice(0, 22).padEnd(22)} → 認領 ${hit} 題`)
    }
  }

  console.log(`\n${mine.length} 題中找到出處 ${found.size} 題`)
  const by = {}
  for (const v of found.values()) {
    const k = `${v.from}  →  ${v.code} ${v.subject.slice(0, 20)}`
    by[k] = (by[k] || 0) + 1
  }
  console.log('\n對應關係（我們的卷 → 考選部的卷）：')
  Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${k}  ${n} 題`))
  fs.writeFileSync(path.join(__dirname, '..', '_tmp', `origin-${EXAM}-${CODE}.json`), JSON.stringify([...found], null, 2))
})()
