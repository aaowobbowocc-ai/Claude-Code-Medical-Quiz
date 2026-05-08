#!/usr/bin/env node
/**
 * Parse 公路局 機車危險感知影片選擇題（中文版）PDF → 題庫格式。
 *
 * 來源：ws.thb.gov.tw 公開下載 PDF（公路局，公開政府資訊）
 * 影片在 space2.thb.gov.tw（Synology 共享，互動 UI 才能下載個別影片）
 *
 * 每題格式：
 *   {題號} {答案 1-3} {題目+(1)(2)(3) 三選項} {影片編號}
 *
 * 輸出：JSON array，可塞進 questions-driver-moto.json 或單獨檔。
 */
const fs = require('fs')
const path = require('path')

;(async () => {
  const mupdf = await import('mupdf')
  const PDF = path.join(__dirname, '..', '_tmp', 'hazard-questions.pdf')
  const buf = fs.readFileSync(PDF)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')

  let allText = ''
  for (let i = 0; i < doc.countPages(); i++) {
    allText += doc.loadPage(i).toStructuredText('preserve-whitespace').asText() + '\n'
  }

  // Parser: lines look like
  //   001 \n 1 \n {stem with (1)(2)(3) options} \n {video_id}
  // Strategy: split by 題號 pattern (3-digit at start of stripped line)
  const lines = allText.split('\n').map(l => l.trim()).filter(Boolean)
  const questions = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 題號是 001-050 之類，3 位數字
    if (!/^\d{3}$/.test(line)) { i++; continue }
    const qnum = parseInt(line, 10)
    // 下一行是答案 (1, 2, or 3)
    if (i + 1 >= lines.length) break
    const ansLine = lines[i + 1]
    if (!/^[123]$/.test(ansLine)) { i++; continue }
    const answerNum = parseInt(ansLine, 10)
    // 接下來是題目內容直到下一個 3-digit 題號 OR 「題號 答案 題目 影片編號」表格頭
    let stemLines = []
    let videoId = null
    let j = i + 2
    let videoIdCandidate = null  // hold video_id if (3) hasn't been collected yet (跨頁情況)
    while (j < lines.length) {
      const next = lines[j]
      // 略過頁眉/欄位名
      if (next === '題號' || next === '答案' || next === '題目' || next === '影片編號') { j++; continue }
      // 略過頁碼（單個 1-2 位數字）
      if (/^\d{1,2}$/.test(next)) { j++; continue }
      // 下一題的題號（3 位數且大於目前題號）
      if (/^\d{3}$/.test(next) && parseInt(next, 10) > qnum) {
        if (videoIdCandidate) videoId = videoIdCandidate
        break
      }
      // 4-digit video_id：但要確認 (3) 已經出現在 stemLines（否則只是中途的數字）
      if (/^4\d{3}$/.test(next)) {
        const accum = stemLines.join(' ')
        if (/\(\s*3\s*\)/.test(accum)) {
          videoId = next
          j++
          break
        }
        // (3) 還沒到，先記下這個候選，繼續往下找
        videoIdCandidate = next
        j++
        continue
      }
      stemLines.push(next)
      j++
    }
    const fullStem = stemLines.join(' ').replace(/\s+/g, ' ')
    // 拆題幹 + 3 選項（容忍 ( 1 ) 內含空白）
    const m = fullStem.match(/^(.*?)\(\s*1\s*\)(.*?)\(\s*2\s*\)(.*?)\(\s*3\s*\)(.*)$/)
    if (!m) {
      console.warn('parse fail Q' + qnum + ':', fullStem.slice(0, 120))
      i = j
      continue
    }
    const [, stem, opt1, opt2, opt3] = m
    questions.push({
      number: qnum,
      answer_letter: ['A','B','C'][answerNum - 1],
      question: stem.trim(),
      options: { A: opt1.trim(), B: opt2.trim(), C: opt3.trim() },
      hazard_video_id: videoId,
    })
    i = j
  }

  console.log(`parsed ${questions.length} questions`)
  if (questions.length > 0) {
    console.log('first sample:', JSON.stringify(questions[0], null, 2))
    console.log('last sample:', JSON.stringify(questions[questions.length - 1], null, 2))
  }
  // Save to JSON for next step
  fs.writeFileSync(path.join(__dirname, '..', '_tmp', 'hazard-questions.json'), JSON.stringify(questions, null, 2))
  console.log('written _tmp/hazard-questions.json')
})()
