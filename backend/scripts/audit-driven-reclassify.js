#!/usr/bin/env node
/**
 * 根據 audit 結果重新分類問題卷的所有題目（全跑）。
 *
 * 流程：
 * 1. 讀 classification-audit-pro.json，找出 accuracy < 70% 的 (exam, subject)
 * 2. 對每個有問題的 subject，蒐集該卷所有題目以及 audit 中模型建議的可能 tags
 * 3. 用 Vertex Pro 對全卷每題重新分類
 * 4. 比對：模型建議 vs 現有 tag，不同則更新
 * 5. atomic save
 *
 * Usage:
 *   node scripts/audit-driven-reclassify.js [--exam X] [--limit N] [--dry-run]
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')
const { atomicWriteJson } = require('./lib/atomic-write')

const BACKEND = path.resolve(__dirname, '..')
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const VERTEX_MODEL = 'gemini-2.5-pro'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const args = process.argv.slice(2)
const examFilter = args.indexOf('--exam') >= 0 ? args[args.indexOf('--exam') + 1] : null
const limitArg = args.indexOf('--limit') >= 0 ? parseInt(args[args.indexOf('--limit') + 1]) : 0
const dryRun = args.includes('--dry-run')
const ACCURACY_THRESHOLD = 0.7  // 卷整體 accuracy < 70% 視為需重分類

const EXAM_FILES = {
  doctor1: 'questions.json', doctor2: 'questions-doctor2.json',
  dental1: 'questions-dental1.json', dental2: 'questions-dental2.json',
  pharma1: 'questions-pharma1.json', pharma2: 'questions-pharma2.json',
  nursing: 'questions-nursing.json', nutrition: 'questions-nutrition.json',
  medlab: 'questions-medlab.json',
  radiology: 'questions-radiology.json', tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json', vet: 'questions-vet.json',
  audiologist: 'questions-audiologist.json',
  'speech-therapist': 'questions-speech-therapist.json',
  rt: 'questions-rt.json',
}

// ── Step 1: 從 audit 結果建立「需重分類」清單 ──
const auditData = JSON.parse(fs.readFileSync(path.join(BACKEND, '_tmp/classification-audit-pro.json'), 'utf-8'))

const reclassifyTargets = []  // [{exam, subject, candidateTags: Set<string>}]
for (const [examId, examData] of Object.entries(auditData.by_exam || {})) {
  if (examId === 'pt' || examId === 'ot') continue
  if (examFilter && examFilter !== examId) continue
  for (const [subject, subjectData] of Object.entries(examData.by_subject || {})) {
    let totalSampled = 0, totalAgree = 0
    const candidates = new Set()
    const allTags = new Set()
    for (const [tag, tagData] of Object.entries(subjectData.by_tag || {})) {
      totalSampled += tagData.sampled
      totalAgree += tagData.agree
      allTags.add(tag)
      // 收集模型建議的所有 tag
      for (const ex of (tagData.examples_disagree || [])) {
        if (ex.suggested) candidates.add(ex.suggested)
      }
    }
    const accuracy = totalSampled > 0 ? totalAgree / totalSampled : 1
    if (accuracy < ACCURACY_THRESHOLD) {
      // 候選 tag = 既有 tag + 模型建議的 tag
      const allCandidates = new Set([...allTags, ...candidates])
      reclassifyTargets.push({ examId, subject, candidates: [...allCandidates], accuracy })
    }
  }
}

console.log(`找到 ${reclassifyTargets.length} 個需重分類的 (exam, subject):`)
for (const t of reclassifyTargets) {
  console.log(`  ${t.examId} / ${t.subject} — accuracy=${(t.accuracy * 100).toFixed(0)}% — candidates: ${t.candidates.join(',')}`)
}
if (dryRun) {
  console.log('\n--dry-run, exit')
  process.exit(0)
}

// ── Step 2: 對每個 target 重新分類所有題目 ──
async function callGemini(prompt) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.0, maxOutputTokens: 50, thinkingConfig: { thinkingBudget: 0 } },
        }),
      })
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, Math.min(60000, 3000 * 2 ** attempt)))
        continue
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
    } catch (e) {
      if (attempt === 5) throw e
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
}

function buildPrompt(question, options, subject, candidates) {
  const opts = Object.entries(options || {}).map(([k, v]) => `(${k}) ${v}`).join('\n')
  const choices = candidates.join(' / ')
  return `你是國考題分類員。下面這題是「${subject}」卷別的題目，請從候選 subject_tag 中選一個最準確的：

題目：${question}
選項：
${opts}

候選 tags（必須從中選一個）：${choices}

只輸出 tag 名稱，無解釋無標點無多餘文字。`
}

;(async () => {
  let totalProcessed = 0, totalChanged = 0, totalErrors = 0
  const cost = { in: 0, out: 0 }

  for (const target of reclassifyTargets) {
    const file = EXAM_FILES[target.examId]
    if (!file) continue
    const fp = path.join(BACKEND, file)
    if (!fs.existsSync(fp)) continue
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    const targets = arr.filter(q => q.subject === target.subject)
    const N = limitArg > 0 ? Math.min(limitArg, targets.length) : targets.length
    const subset = targets.slice(0, N)

    console.log(`\n📂 ${target.examId} / ${target.subject} (${subset.length} 題, candidates: ${target.candidates.join(',')})`)

    let changed = 0
    let processed = 0
    const validSet = new Set(target.candidates)

    for (const q of subset) {
      try {
        const prompt = buildPrompt(q.question, q.options, target.subject, target.candidates)
        const reply = await callGemini(prompt)
        const tag = reply.replace(/[`'"]/g, '').split(/\s+/)[0].trim()
        if (validSet.has(tag) && tag !== q.subject_tag) {
          q.subject_tag = tag
          changed++
        }
        processed++
        if (processed % 50 === 0) {
          atomicWriteJson(fp, data)
          console.log(`  ${processed}/${subset.length} (changed: ${changed})`)
        }
      } catch (e) {
        totalErrors++
        if (totalErrors < 5) console.log(`  ✗ ${q.id}: ${e.message}`)
      }
    }
    atomicWriteJson(fp, data)
    console.log(`  ✓ ${processed}/${subset.length}, ${changed} tag changed`)
    totalProcessed += processed
    totalChanged += changed
  }

  console.log(`\n=== 總計處理 ${totalProcessed} 題，${totalChanged} 題 tag 改變，${totalErrors} 失敗 ===`)
})().catch(e => { console.error(e); process.exit(1) })
