#!/usr/bin/env node
// Parse 機車危險感知影片選擇題 PDF → questions-driver-moto-hazard.json
// Source: 公路局 126 題（影片編號 4142-4267）

const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')

const PDF = path.join(__dirname, '..', '_hazard', 'moto_hazard.pdf')
const OUT = path.join(__dirname, '..', 'questions-driver-moto-hazard.json')

async function main() {
  const buf = fs.readFileSync(PDF)
  const { text } = await pdfParse(buf)

  // Split into question blocks. Each block starts with "NNN A " at the beginning
  // of a line (題號 3 碼 + 答案 1 碼). Block ends before next 3-digit 題號 or EOF.
  const lines = text.split('\n').map(l => l.trim())
  const blocks = []
  let cur = null
  for (const ln of lines) {
    const m = ln.match(/^(\d{3})\s+([123])\s+(.*)/)
    if (m) {
      if (cur) blocks.push(cur)
      cur = { num: parseInt(m[1]), ans: m[2], text: m[3], videoId: null }
    } else if (cur) {
      // Video ID is a 4-digit number on its own line (after last option)
      const v = ln.match(/^(\d{4})$/)
      if (v) {
        cur.videoId = v[1]
      } else if (ln) {
        cur.text += ln
      }
    }
  }
  if (cur) blocks.push(cur)

  // Split stem and 3 options: stem ends before "(1)", then (1)…(2)…(3)…
  const questions = blocks.map(b => {
    const raw = b.text.replace(/\s+/g, '')
    const m = raw.match(/^(.+?)\(1\)(.+?)\(2\)(.+?)\(3\)(.+)$/)
    if (!m) return { ...b, _parseFail: true }
    return {
      id: `driver-moto-hazard-${b.num}`,
      number: b.num,
      question: m[1],
      options: { A: m[2], B: m[3], C: m[4] },
      answer: ['A','B','C'][parseInt(b.ans) - 1],
      video_id: b.videoId,
      subject: '機車危險感知',
      subject_tag: 'moto_hazard',
      subject_name: '機車危險感知',
      stage_id: 0,
    }
  })

  const failed = questions.filter(q => q._parseFail)
  if (failed.length) {
    console.warn('Failed to parse', failed.length, 'blocks:', failed.map(f => f.num))
  }
  const ok = questions.filter(q => !q._parseFail)
  console.log('Parsed', ok.length, 'of', blocks.length, 'questions')
  console.log('Sample:', JSON.stringify(ok[0], null, 2))

  fs.writeFileSync(OUT, JSON.stringify({
    metadata: {
      source: '公路局 機車危險感知影片選擇題（中文版）',
      total: ok.length,
      note: '靜態文字版；實際考試含影片，本題庫僅作文字理解練習',
    },
    total: ok.length,
    questions: ok,
  }, null, 2))
  console.log('Wrote', OUT)
}

main().catch(e => { console.error(e); process.exit(1) })
