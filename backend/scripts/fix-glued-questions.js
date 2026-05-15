#!/usr/bin/env node
/**
 * 批次修「題幹被混入多題內容」問題
 * 從 PDF 重抽純題幹，替換 DB 的 question 欄位（options/answer 不動）
 *
 * ID 規範：
 *   doctor2/tcm2: `{code}_{ssss}_{num}` → PDF = Q_{code}_c{?}_s{ssss}.pdf
 *   nursing 102110: `{code}_{ssss}_{num}` or `{code}_{tag}_{num}` — 較複雜
 *
 * 策略：
 *   1. 掃描所有 questions，找 question.length > 400 + 多 glue 信號
 *   2. 從 ID 推 PDF 路徑（試多種命名）
 *   3. 從 PDF 找對應 Q num 的純題幹（在 N\n ... \n(N+1)\n 之間）
 *   4. 寫回（options/answer 不動）
 */
const fs = require('fs')
const path = require('path')

const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

const FILES = {
  'questions-doctor2.json': 'doctor2',
  'questions-nursing.json': 'nursing',
  'questions-tcm1.json': 'tcm1',
  'questions-tcm2.json': 'tcm2',
  'questions-medlab.json': 'medlab',
  'questions-radiology.json': 'radiology',
  'questions-ot.json': 'ot',
  'questions-pharma2.json': 'pharma2',
  'questions-rt.json': 'rt',
  'questions-nutrition.json': 'nutrition',
  'questions.json': 'doctor1',
}

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

async function readPdfText(buf) {
  const mupdf = await getMupdf()
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return txt.normalize('NFKC')
}

async function findPdfForId(id, examPrefix, exam_code) {
  // 解析 id：通常 {code}_{ssss}_{num} or {code}_{tag}_{num}
  const idStr = String(id)
  const m = idStr.match(/^(\d+)_(\w+?)_(\d+)$/)
  if (!m) return null
  const [, code, ss, num] = m
  if (code !== exam_code) return null  // 防範 ID 跨年份

  // 嘗試多種 PDF 命名
  const cCodes = ['102','103','104','105','106','107','108','109','110','301','305','306','307','308','309','311','312','313']
  const candidates = []
  for (const c of cCodes) {
    candidates.push(`Q_${code}_c${c}_s${ss}.pdf`)
    candidates.push(`${examPrefix}_${code}_c${c}_s${ss}.pdf`)
    candidates.push(`${examPrefix}_${code}_c${c}_s${ss}_Q.pdf`)
  }
  for (const f of candidates) {
    const fp = path.join(PDF_CACHE, f)
    if (fs.existsSync(fp)) return { fp, num: parseInt(num) }
  }
  return null
}

function extractPureQ(txt, num) {
  // 找 \nN[\s.][內容]\n(N+1)
  const re = new RegExp(`\\n\\s*${num}[\\.\\s]([\\s\\S]+?)\\n\\s*${num + 1}[\\.\\s]`, 'm')
  const m = txt.match(re)
  if (!m) return null
  const body = m[1].trim()
  // 找出題目正文（在第一個選項標記之前）— 100-105 CBT 沒有 ABCD 標記、直接看到 4 選項都在
  // 試找「?」「？」分界（題幹結尾）
  const qe = body.match(/^([\s\S]+?[?？])\s*\n/)
  if (qe) return qe[1].replace(/\s+/g, ' ').trim()
  // fallback: 整體第一行+第二行
  return body.split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' ').trim()
}

async function main() {
  const suspects = []
  // 1. 找 suspects
  for (const [file, prefix] of Object.entries(FILES)) {
    if (!fs.existsSync(file)) continue
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const arr = data.questions || data
    for (const q of arr) {
      if (!q.question || q.question.length < 400) continue
      const matches = q.question.match(/\s\d{1,3}\s+[^\d\s]/g) || []
      if (matches.length < 3) continue
      // 跳過 gsat 英文長閱讀
      if (file === 'questions-gsat.json' && q.subject === '英文') continue
      // 跳過 customs/police 英文（長閱讀）
      if (q.subject && /英文|英語/.test(q.subject)) continue
      suspects.push({ file, prefix, q })
    }
  }
  console.log('Total suspects (非英文):', suspects.length)

  // 2. 修
  const fileChanges = {}
  let fixed = 0, skipped = 0
  for (const s of suspects) {
    const found = await findPdfForId(s.q.id, s.prefix, s.q.exam_code)
    if (!found) { skipped++; continue }
    const buf = fs.readFileSync(found.fp)
    const txt = await readPdfText(buf)
    const pureQ = extractPureQ(txt, found.num)
    if (!pureQ || pureQ.length < 10 || pureQ.length > 500) { skipped++; continue }
    if (!fileChanges[s.file]) fileChanges[s.file] = []
    fileChanges[s.file].push({ id: s.q.id, oldLen: s.q.question.length, newQ: pureQ })
    fixed++
  }

  // 3. 套用
  for (const [file, changes] of Object.entries(fileChanges)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const arr = data.questions || data
    for (const ch of changes) {
      const q = arr.find(x => x.id === ch.id)
      if (q) {
        q.question = ch.newQ
        q.disputed = true
      }
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
    console.log(`${file}: fixed ${changes.length}`)
    for (const ch of changes.slice(0, 3)) {
      console.log(`  ${ch.id} (${ch.oldLen}→${ch.newQ.length})`)
      console.log(`    new: ${ch.newQ.slice(0,80)}`)
    }
  }
  console.log(`\nFixed ${fixed} / Skipped ${skipped}`)
}

main().catch(e => { console.error(e); process.exit(1) })
