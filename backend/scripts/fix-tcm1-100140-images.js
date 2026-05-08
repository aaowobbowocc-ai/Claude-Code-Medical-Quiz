#!/usr/bin/env node
/**
 * 為 tcm1 100140 中醫基礎醫學(二) 6 題 missing_image_dep 補圖。
 * 此 PDF (Q_100140_c106_s0502.pdf) 為全圖像，已渲染 12 頁 PNG 至 _tmp。
 * 我（Claude）已親自確認每題對應的頁碼。
 */
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const { atomicWriteJson } = require('./lib/atomic-write')

const BACKEND = path.resolve(__dirname, '..')
const RENDERED = path.join(BACKEND, '_tmp', 'incomplete-for-claude')
const IMG_OUT = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')

// Question number → page index (1-based), verified by Claude visual inspection
const PAGE_MAP = {
  7:  1,
  33: 4,
  41: 5,
  70: 9,
  71: 9,
  75: 11,
}

async function main() {
  fs.mkdirSync(IMG_OUT, { recursive: true })
  const file = path.join(BACKEND, 'questions-tcm1.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const qs = data.questions

  let fixed = 0
  for (const q of qs) {
    if (q.exam_code !== '100140' || !q.incomplete) continue
    const pageNum = PAGE_MAP[q.number]
    if (!pageNum) continue
    const srcPng = path.join(RENDERED, `tcm1_100140_p${pageNum}.png`)
    if (!fs.existsSync(srcPng)) {
      console.log(`✗ Q${q.number}: source PNG missing`)
      continue
    }
    const outName = `tcm1_100140_q${q.number}_full.webp`
    const outPath = path.join(IMG_OUT, outName)
    const buf = fs.readFileSync(srcPng)
    await sharp(buf).webp({ quality: 80 }).toFile(outPath)

    q.image_url = `/question-images/${outName}`
    q.incomplete = 'image_options'  // image_dep → image_options (frontend handles this)
    fixed++
    console.log(`✓ Q${q.number} → ${outName} (from p${pageNum})`)
  }

  if (fixed) {
    atomicWriteJson(file, data)
    console.log(`💾 ${fixed} questions patched`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
