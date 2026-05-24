#!/usr/bin/env node
/**
 * 用 Gemini 2.5 Pro Vision OCR 補 93 題散落缺漏。
 * audiologist 106-1 行為聽力/聽覺輔具 23 題
 * speech-therapist 100/101/102-1 五卷 ~72 題
 *
 * 成本估算：~7 PDFs × 6 pages × $0.01 ≈ $0.42 USD
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')

const BACKEND = path.resolve(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
// MODEL: gemini-2.5-flash (changed 2026-05-23 from gemini-2.5-pro)
//   OCR / Vision 任務不需要 Pro 推理；Flash 同準確度但便宜 ~17-33 倍。
//   5/22 batch 跑 Pro thinking 一次燒 $200+，Flash 同 batch 約 $5-10。
//   若特殊題目 Flash 結果不佳，再針對該批改回 'gemini-2.5-pro'。
const VERTEX_MODEL = 'gemini-2.5-flash'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

// 各場缺漏設定（從 check-all-gaps 結果）
const TARGETS = [
  {
    exam: 'audiologist', file: 'questions-audiologist.json',
    year: '106', session: '第一次', code: '106110',
    papers: [
      { subject: '行為聽力學', subject_tag: 'audio_behavioral', pdfName: 'audiologist_106110_c110_s0902_Q.pdf' },
      { subject: '聽覺輔具原理與實務學', subject_tag: 'audio_aids', pdfName: 'audiologist_106110_c110_s0904_Q.pdf' },
    ],
    answerPdf: (paper) => paper.pdfName.replace('_Q.pdf', '_S.pdf'),
  },
  {
    exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    year: '100', session: '第一次', code: '100090',
    papers: [
      { subject: '聽力學與輔助溝通系統（包括專業倫理）', subject_tag: 'speech_hearing', pdfName: 'Q_speech-therapist_100090_c201_s0406.pdf', answerName: 'A_speech-therapist_100090_c201_s0406.pdf' },
    ],
  },
  {
    exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    year: '101', session: '第一次', code: '101070',
    papers: [
      { subject: '嗓音與吞嚥障礙', subject_tag: 'speech_voice', pdfName: 'Q_speech-therapist_101070_c201_s0404.pdf', answerName: 'A_speech-therapist_101070_c201_s0404.pdf' },
    ],
  },
  {
    exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    year: '101', session: '第二次', code: '101110',
    papers: [
      { subject: '基礎言語科學', subject_tag: 'speech_basic', pdfName: 'Q_speech-therapist_101110_c111_s0803.pdf', answerName: 'A_speech-therapist_101110_c111_s0803.pdf' },
    ],
  },
  {
    exam: 'speech-therapist', file: 'questions-speech-therapist.json',
    year: '102', session: '第一次', code: '102030',
    papers: [
      { subject: '基礎言語科學', subject_tag: 'speech_basic', pdfName: 'Q_speech-therapist_102030_c114_s1003.pdf', answerName: 'A_speech-therapist_102030_c114_s1003.pdf' },
      { subject: '聽力學與輔助溝通系統（包括專業倫理）', subject_tag: 'speech_hearing', pdfName: 'Q_speech-therapist_102030_c114_s1006.pdf', answerName: 'A_speech-therapist_102030_c114_s1006.pdf' },
    ],
  },
]

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

async function visionExtractPage(pngBuf, missingNums) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const prompt = `這是台灣國考試題 PDF 截圖。請抽出題目，輸出嚴格 JSON 陣列：
[
  {"number": 數字, "question": "題目正文", "options": {"A":"...","B":"...","C":"...","D":"..."}},
  ...
]
規則：
- 只抽選擇題（4 選 1）
- 若選項只有 3 個有效（A/B/C 等），仍填 4 欄但缺的留空字串
- 題目正文要完整，含臨床情境
- 不要解釋、不要 markdown，只輸出 JSON
- 若這頁沒有完整題目（只是題目延續），輸出 []`
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { inlineData: { data: pngBuf.toString('base64'), mimeType: 'image/png' } },
            { text: prompt },
          ] }],
          generationConfig: { temperature: 0.0, maxOutputTokens: 8000, thinkingConfig: { thinkingBudget: 0 } },
        }),
      })
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 3000 * 2 ** attempt)); continue }
      if (!resp.ok) { if (attempt === 3) return []; await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue }
      const data = await resp.json()
      const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
      const m = text.match(/\[[\s\S]*\]/)
      if (!m) return []
      try { return JSON.parse(m[0]) } catch { return [] }
    } catch (e) { if (attempt === 3) return []; await new Promise(r => setTimeout(r, 2000 * (attempt + 1))) }
  }
  return []
}

async function parseAnswerPdf(pdfPath) {
  if (!fs.existsSync(pdfPath)) return {}
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let text = ''
  for (let i = 0; i < doc.countPages(); i++) {
    text += doc.loadPage(i).toStructuredText('preserve-whitespace').asText().normalize('NFKC') + '\n'
  }
  const answers = {}
  const fw = /答案\s*([ＡＢＣＤ＃#]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
      else n++
    }
  }
  if (Object.keys(answers).length >= 20) return answers
  n = 1
  const hw = /答案\s*([A-D#]{10,})/gi
  while ((m = hw.exec(text)) !== null) {
    for (const ch of m[1]) { if (/[A-D]/i.test(ch)) answers[n] = ch.toUpperCase(); n++ }
  }
  return answers
}

;(async () => {
  await getMupdf()
  let totalAdded = 0
  for (const t of TARGETS) {
    const fp = path.join(BACKEND, t.file)
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    const haveSet = new Set(arr.map(q => `${q.exam_code}|${q.subject}|${q.number}`))
    let maxId = Math.max(...arr.map(q => parseInt(q.id) || 0).filter(n => !isNaN(n))) || 1000000

    for (const paper of t.papers) {
      const qPdfPath = path.join(PDF_CACHE, paper.pdfName)
      if (!fs.existsSync(qPdfPath)) { console.log(`  ✗ no PDF: ${paper.pdfName}`); continue }

      // 找出缺漏題號
      const have = arr.filter(q => q.exam_code === t.code && q.subject === paper.subject).map(q => q.number).sort((a,b) => a-b)
      const allNums = [...Array(80).keys()].map(n => n+1)
      const missing = allNums.filter(n => !have.includes(n) && n <= (Math.max(...have) || 80))
      if (missing.length === 0) { console.log(`  ${t.year}-${t.session} ${paper.subject}: 無缺漏`); continue }
      console.log(`  ${t.year}-${t.session} ${paper.subject}: 缺 ${missing.length} 題 (${missing.join(',')})`)

      // 答案 PDF
      const aPdfName = paper.answerName || (t.answerPdf ? t.answerPdf(paper) : paper.pdfName.replace('_Q.pdf', '_S.pdf').replace('.pdf', '_S.pdf'))
      const aPdfPath = path.join(PDF_CACHE, aPdfName)
      const answers = await parseAnswerPdf(aPdfPath)

      // OCR each page
      const mupdf = await getMupdf()
      const buf = fs.readFileSync(qPdfPath)
      const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
      const found = new Map()
      for (let i = 0; i < doc.countPages(); i++) {
        const page = doc.loadPage(i)
        const px = page.toPixmap(mupdf.Matrix.scale(2.0, 2.0), mupdf.ColorSpace.DeviceRGB, false, true)
        const png = Buffer.from(px.asPNG())
        const qs = await visionExtractPage(png, missing)
        for (const q of qs) {
          if (!q.number || !q.question || !q.options) continue
          if (missing.includes(q.number) && !found.has(q.number)) found.set(q.number, q)
        }
        if (found.size >= missing.length) break  // 都找到了
      }
      console.log(`    Vision found: ${found.size}/${missing.length}`)

      // 插入
      let added = 0
      for (const [num, q] of found) {
        if (haveSet.has(`${t.code}|${paper.subject}|${num}`)) continue
        const optKeys = Object.keys(q.options).filter(k => q.options[k] && q.options[k].length >= 1)
        if (optKeys.length < 3) continue
        maxId++
        arr.push({
          id: maxId,
          roc_year: t.year, session: t.session, exam_code: t.code,
          subject: paper.subject, subject_tag: paper.subject_tag, subject_name: paper.subject,
          paper_id: 'paper1', stage_id: 0,
          number: num,
          question: q.question,
          options: q.options,
          answer: answers[num] || '',
          explanation: '',
        })
        added++
      }
      fs.writeFileSync(fp, JSON.stringify(data, null, 2))
      console.log(`    ✓ added ${added} to ${t.file}`)
      totalAdded += added
    }
  }
  console.log(`\n=== Total added: ${totalAdded} ===`)
})().catch(e => { console.error(e); process.exit(1) })
