#!/usr/bin/env node
/**
 * medlab「醫學分子檢驗學與臨床鏡檢學」卷 — 子科目重分類
 *
 * 回饋：分子檢驗題庫混入鏡檢題。原因是舊腳本純按題號位置切（每卷
 * 第1-40題→臨床鏡檢學、第41-80題→醫學分子檢驗學）：
 *   - 舊年份(100-102) 該卷實為「臨床鏡檢學（包括寄生蟲學）」純鏡檢卷，
 *     根本沒有分子檢驗 → Q41-80 被整批誤標成分子檢驗（系統性錯誤）
 *   - 新年份(103+) 才是「醫學分子檢驗學與臨床鏡檢學」合卷，題號位置切
 *     即考卷實際結構（Q1-40 鏡檢、Q41-80 分子），可靠
 *
 * 修法：
 *   - 舊年份(≤102)：整卷 → 臨床鏡檢學
 *   - 新年份(103+)：依題號位置（Q1-40 鏡檢、Q41-80 分子）
 *   一併把殘留的舊 subject_name（如「臨床鏡檢學（包括寄生蟲學）」）正規化
 *
 * 內容關鍵字分類試過但對新年份誤判率偏高（分子題常提及檢體/腦脊髓液
 * 而被誤判為鏡檢），故不採用 — 考卷位置結構本身才是可靠依據。
 *
 * 用法：node scripts/_reclassify-medlab-molmicro.js [dry|run]
 */
const fs = require('fs')
const path = require('path')

const QFILE = path.join(__dirname, '..', 'questions-medlab.json')

const CM = { tag: 'clinical_micro', name: '臨床鏡檢學', stage_id: 5 }
const MD = { tag: 'molecular_dx',   name: '醫學分子檢驗學', stage_id: 6 }

function main() {
  const dry = (process.argv[2] || 'dry') !== 'run'
  const questions = JSON.parse(fs.readFileSync(QFILE, 'utf8'))

  const targets = questions.filter(q =>
    q.subject_tag === 'clinical_micro' || q.subject_tag === 'molecular_dx')

  let toCM = 0, toMD = 0, flips = 0
  const sampleFlips = []

  for (const q of targets) {
    const year = parseInt(q.roc_year) || 0
    // 舊年份整卷鏡檢；新年份依題號位置
    const target = (year <= 102) ? CM : (q.number <= 40 ? CM : MD)

    const before = q.subject_tag
    if (before !== target.tag) {
      flips++
      if (sampleFlips.length < 25) {
        sampleFlips.push(`  ${q.exam_code} 第${q.number}題 ${before}→${target.tag}  ${(q.question || '').slice(0, 40)}`)
      }
    }
    if (target.tag === 'clinical_micro') toCM++; else toMD++

    q.subject_tag = target.tag
    q.subject_name = target.name
    q.stage_id = target.stage_id
  }

  console.log(`molmicro 子科目重分類：`)
  console.log(`  總題數 ${targets.length}  →  臨床鏡檢學 ${toCM} / 醫學分子檢驗學 ${toMD}`)
  console.log(`  改 subject_tag ${flips} 題（其餘僅正規化 subject_name/stage_id）`)
  console.log(`\n改分類樣本（前25）：`)
  sampleFlips.forEach(s => console.log(s))

  if (dry) { console.log('\n[dry-run] 未寫檔。'); return }
  fs.writeFileSync(QFILE, JSON.stringify(questions, null, 1))
  console.log(`\n✓ 已回寫 questions-medlab.json`)
}
main()
