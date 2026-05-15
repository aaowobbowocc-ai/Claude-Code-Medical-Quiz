#!/usr/bin/env node
// customs 107050 #8-19 英文 — 抽閱讀測驗 passage + 題目
const fs = require('fs')
const path = require('path')

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }
async function readText(buf) {
  const mupdf = await getMupdf()
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return txt.normalize('NFKC')
}

async function main() {
  const buf = fs.readFileSync('_tmp/pdf-cache/customs_107050_c101_s0202.pdf')
  const txt = await readText(buf)
  // 測驗題 starts after "乙、測驗題"
  const tIdx = txt.search(/乙、測驗題/)
  if (tIdx < 0) { console.error('no 測驗題 section'); return }
  const body = txt.slice(tIdx)

  // 抽取每題: 找 "請依下文回答第X題至第Y題" → passage 內容
  // 然後每個 "N\n[content]\n[A]\n[B]\n[C]\n[D]" 結構
  // 用 lookahead 分割 questions
  const data = JSON.parse(fs.readFileSync('questions-customs.json', 'utf-8'))
  const arr = data.questions || data
  let fixed = 0

  const targets = arr.filter(q => q.exam_code === '107050' && q.subject === '英文' && (!q.question || q.question.length < 5))
  console.log('target #s:', targets.map(q => q.number).sort((a,b)=>a-b))

  // 解析 passage 段
  // Pattern: "請依下文回答第8 題至第10 題" or 第11題至第14題 etc.
  const passageRe = /請依下文回答第\s*(\d+)\s*題至第\s*(\d+)\s*題\s*([\s\S]+?)(?=\n\s*\d+\s*\n)/g
  const passages = []
  let pm
  while ((pm = passageRe.exec(body)) !== null) {
    passages.push({ start: parseInt(pm[1]), end: parseInt(pm[2]), text: pm[3].trim() })
  }
  console.log('passages found:', passages.length, passages.map(p => `${p.start}-${p.end}`))

  // 抽每題 question text (between "N\n" and options)
  // Question body 是: N → 直到第一行像選項的開始 (典型 4 短行 + 下一題號)
  for (const q of targets) {
    const re = new RegExp(`\n\s*${q.number}\s*\n([\s\S]+?)(?=\n\s*${q.number + 1}\s*\n|\n\s*代號|\n\s*請依)`, '')
    const m = body.match(re)
    if (!m) { console.log('  no match #' + q.number); continue }
    const block = m[1].trim()
    // 切出 question vs 4 options：最後 4 行（含可能短英文 phrase）
    const lines = block.split(/\n+/).map(l => l.trim()).filter(l => l && !/^代號|^頁次/.test(l))
    if (lines.length < 5) { console.log('  too few lines #' + q.number); continue }
    // options = last 4 lines, question = remaining
    const optLines = lines.slice(-4)
    const qText = lines.slice(0, -4).join(' ').replace(/\s+/g, ' ').trim()
    // 找出該題對應的 passage
    const psg = passages.find(p => q.number >= p.start && q.number <= p.end)
    const finalQ = psg ? psg.text + '\n\n' + qText : qText
    if (!finalQ || finalQ.length < 5) continue
    q.question = finalQ
    // 重新組 options (compare with existing)
    const newOpts = { A: optLines[0], B: optLines[1], C: optLines[2], D: optLines[3] }
    // Sanity: existing options should mostly match
    const existA = (q.options?.A || '').trim()
    if (existA && !optLines.some(o => o.trim() === existA)) {
      console.log('  ⚠ option mismatch #' + q.number, 'existA=', existA, 'newA=', optLines[0])
    }
    fixed++
  }
  fs.writeFileSync('questions-customs.json', JSON.stringify(data, null, 2))
  console.log('Fixed:', fixed)
}

main().catch(e => { console.error(e); process.exit(1) })
