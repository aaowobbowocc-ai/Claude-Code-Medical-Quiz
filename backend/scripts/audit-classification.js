#!/usr/bin/env node
/**
 * 分類審計 — 用 Vertex Gemini 2.5 Pro 抽樣審查全站題目的 subject_tag 是否正確。
 *
 * 對每個 exam 的每個 (subject, subject_tag) 組合，隨機抽 10 題（不足全抽），
 * 讓 Pro 判斷該題應屬哪個 stage tag，與現有 subject_tag 比對統計錯誤率。
 *
 * 不修改 questions JSON。輸出：
 *   - backend/_tmp/classification-audit-pro.json
 *   - backend/_tmp/classification-audit-report.md
 *
 * Usage:
 *   node scripts/audit-classification.js [--exam doctor1] [--limit-per-combo 10] [--dry-run]
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')

const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION  = 'us-central1'
const VERTEX_MODEL   = 'gemini-2.5-pro'

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const ROOT = path.resolve(__dirname, '..')
const TMP_DIR = path.resolve(ROOT, '_tmp')
const OUT_JSON = path.resolve(TMP_DIR, 'classification-audit-pro.json')
const OUT_MD   = path.resolve(TMP_DIR, 'classification-audit-report.md')
const PROGRESS = path.resolve(TMP_DIR, 'classification-audit-progress.json')

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

// 跳過 PT/OT（剛重分類過）
const EXAM_FILES = {
  doctor1: 'questions.json',
  doctor2: 'questions-doctor2.json',
  ast: 'questions-ast.json',
  audiologist: 'questions-audiologist.json',
  'civil-senior': 'questions-civil-senior.json',
  customs: 'questions-customs.json',
  dental1: 'questions-dental1.json',
  dental2: 'questions-dental2.json',
  'driver-car': 'questions-driver-car.json',
  'driver-moto': 'questions-driver-moto.json',
  gsat: 'questions-gsat.json',
  judicial: 'questions-judicial.json',
  lawyer1: 'questions-lawyer1.json',
  medlab: 'questions-medlab.json',
  nursing: 'questions-nursing.json',
  nutrition: 'questions-nutrition.json',
  pharma1: 'questions-pharma1.json',
  pharma2: 'questions-pharma2.json',
  police: 'questions-police.json',
  police4: 'questions-police4.json',
  radiology: 'questions-radiology.json',
  rt: 'questions-rt.json',
  'social-worker': 'questions-social-worker.json',
  tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json',
  vet: 'questions-vet.json',
}

const args = process.argv.slice(2)
const examFilter = args.indexOf('--exam') >= 0 ? args[args.indexOf('--exam') + 1] : null
const limitArg   = args.indexOf('--limit-per-combo') >= 0 ? parseInt(args[args.indexOf('--limit-per-combo') + 1]) : 10
const dryRun     = args.includes('--dry-run')
const SAMPLE_SEED = 20260509

// Cost guardrail (NTD) — Vertex credit 不算預算，給合理上限避免 runaway
const MAX_NTD = 200
const USD_PER_NTD = 1 / 32 // ≈ 32 NTD/USD
const PRICE_INPUT_PER_M  = 1.25  // Pro
const PRICE_OUTPUT_PER_M = 10.0  // Pro

// Reproducible PRNG
function mulberry32(a) {
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function shuffle(arr, rng) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

async function callGemini(prompt, retries = 8) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.0,
            maxOutputTokens: 200,
            // Pro 不支援 thinkingBudget=0；用 -1 (dynamic) 並讓 Pro 用最少 thinking
            // (Pro 最低 thinking budget = 128)
            thinkingConfig: VERTEX_MODEL.includes('flash')
              ? { thinkingBudget: 0 }
              : { thinkingBudget: 128 },
          },
        }),
      })
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, Math.min(60000, 2000 * 2 ** attempt)))
        continue
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status} ${txt.slice(0, 200)}`)
      }
      const data = await resp.json()
      const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
      const usage = data.usageMetadata || {}
      return { text, usage }
    } catch (e) {
      if (attempt === retries - 1) throw e
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
}

function buildPrompt(question, options, candidateTags) {
  const opts = Object.entries(options || {}).map(([k, v]) => `(${k}) ${v}`).join('\n')
  const list = candidateTags.map(t => `- ${t.tag}：${t.name}`).join('\n')
  return `你是國考題目分類員。請根據題目內容判斷它最應該屬於哪一個科目分類。

題目：${question}
選項：
${opts}

候選分類（只能從這些選一個）：
${list}

只輸出一個 tag 名稱（例如：${candidateTags[0].tag}），不要解釋、不要標點、不要多餘文字。`
}

function loadExam(examId) {
  const file = EXAM_FILES[examId]
  if (!file) return null
  const fp = path.resolve(ROOT, file)
  if (!fs.existsSync(fp)) return null
  const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const qs = raw.questions || raw
  return qs
}

function loadStages(examId) {
  const cfg = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'exam-configs', examId + '.json'), 'utf-8'))
  // Filter out 'all' meta-tag
  return (cfg.stages || [])
    .filter(s => s.tag && s.tag !== 'all')
    .map(s => ({ tag: s.tag, name: s.name || s.tag }))
}

function buildSamplingPlan(examIds, limitPerCombo) {
  const plan = [] // [{exam, subject, subject_tag, qIds:[...]}, ...]
  const rng = mulberry32(SAMPLE_SEED)
  for (const exam of examIds) {
    const qs = loadExam(exam)
    if (!qs) { console.warn(`[skip] ${exam}: file not found`); continue }
    const groups = new Map()
    for (const q of qs) {
      const k = (q.subject || '?') + '|' + (q.subject_tag || '?')
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(q.id)
    }
    for (const [k, ids] of groups) {
      const [subject, subject_tag] = k.split('|')
      const sample = shuffle(ids, rng).slice(0, limitPerCombo)
      plan.push({ exam, subject, subject_tag, qIds: sample })
    }
  }
  return plan
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS)) return { results: {}, usage: { promptTokens: 0, outputTokens: 0 } }
  try { return JSON.parse(fs.readFileSync(PROGRESS, 'utf-8')) } catch { return { results: {}, usage: { promptTokens: 0, outputTokens: 0 } } }
}
function saveProgress(p) {
  const tmp = PROGRESS + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(p, null, 0))
  fs.renameSync(tmp, PROGRESS)
}

function estimateCostUSD(promptTokens, outputTokens) {
  return (promptTokens / 1e6) * PRICE_INPUT_PER_M + (outputTokens / 1e6) * PRICE_OUTPUT_PER_M
}

async function main() {
  const examIds = examFilter ? [examFilter] : Object.keys(EXAM_FILES)
  console.log(`[audit] exams=${examIds.length} limit/combo=${limitArg}`)

  const stagesByExam = {}
  for (const e of examIds) {
    try { stagesByExam[e] = loadStages(e) } catch (err) { console.warn(`[skip] ${e}: no config (${err.message})`); }
  }

  const plan = buildSamplingPlan(examIds.filter(e => stagesByExam[e]), limitArg)
  const totalSamples = plan.reduce((s, g) => s + g.qIds.length, 0)
  console.log(`[plan] groups=${plan.length} totalSamples=${totalSamples}`)
  // Cost estimate
  const estIn = totalSamples * 280
  const estOut = totalSamples * 12
  const estUSD = estimateCostUSD(estIn, estOut)
  const estNTD = estUSD / USD_PER_NTD
  console.log(`[cost-est] ~${estIn} input + ~${estOut} output tokens → $${estUSD.toFixed(2)} USD ≈ NTD ${estNTD.toFixed(1)}`)
  if (estNTD > MAX_NTD) {
    console.error(`[cost] estimated NTD ${estNTD.toFixed(1)} > MAX ${MAX_NTD}. Aborting.`)
    process.exit(1)
  }
  if (dryRun) { console.log('[dry-run] exit'); return }

  // Pre-load all questions for fast lookup
  const qIndex = {} // exam -> id -> question
  for (const e of examIds) {
    const qs = loadExam(e); if (!qs) continue
    qIndex[e] = {}
    for (const q of qs) qIndex[e][q.id] = q
  }

  const progress = loadProgress()
  let processed = 0
  let totalIn = progress.usage.promptTokens || 0
  let totalOut = progress.usage.outputTokens || 0
  let invalidCount = 0
  let costBreached = false

  for (const group of plan) {
    if (costBreached) break
    const stages = stagesByExam[group.exam]
    const validTags = new Set(stages.map(s => s.tag))
    for (const qid of group.qIds) {
      const key = `${group.exam}|${qid}`
      if (progress.results[key]) { processed++; continue }
      const q = qIndex[group.exam]?.[qid]
      if (!q) continue
      try {
        const prompt = buildPrompt(q.question, q.options, stages)
        const { text, usage } = await callGemini(prompt)
        const cleaned = text.replace(/[`'"]/g, '').split(/[\s\n,，。]+/)[0].trim()
        const valid = validTags.has(cleaned)
        if (!valid) invalidCount++
        progress.results[key] = {
          exam: group.exam,
          qid,
          subject: group.subject,
          current: group.subject_tag,
          suggested: valid ? cleaned : null,
          raw: valid ? null : text.slice(0, 80),
          agree: valid ? (cleaned === group.subject_tag) : null,
        }
        totalIn  += usage.promptTokenCount || 0
        totalOut += (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0)
        progress.usage = { promptTokens: totalIn, outputTokens: totalOut }
      } catch (e) {
        progress.results[key] = { exam: group.exam, qid, subject: group.subject, current: group.subject_tag, error: e.message.slice(0, 200) }
      }
      processed++
      if (processed % 25 === 0) {
        const usd = estimateCostUSD(totalIn, totalOut)
        const ntd = usd / USD_PER_NTD
        process.stdout.write(`  ${processed}/${totalSamples} (in=${totalIn} out=${totalOut} ≈$${usd.toFixed(3)} NTD${ntd.toFixed(1)} invalid=${invalidCount})\n`)
        if (ntd > MAX_NTD) {
          console.error(`[cost] NTD ${ntd.toFixed(2)} > MAX ${MAX_NTD}. Stopping.`)
          costBreached = true
          break
        }
      }
      if (processed % 100 === 0) saveProgress(progress)
    }
    saveProgress(progress)
  }
  saveProgress(progress)

  // ─── Aggregate ──────────────────────────────────────────────────────────────
  const byExam = {}
  for (const r of Object.values(progress.results)) {
    if (r.error) continue
    const ex = r.exam, sub = r.subject, tag = r.current
    if (!byExam[ex]) byExam[ex] = { by_subject: {} }
    if (!byExam[ex].by_subject[sub]) byExam[ex].by_subject[sub] = { by_tag: {} }
    if (!byExam[ex].by_subject[sub].by_tag[tag]) {
      byExam[ex].by_subject[sub].by_tag[tag] = { sampled: 0, agree: 0, disagree: 0, examples_disagree: [] }
    }
    const bucket = byExam[ex].by_subject[sub].by_tag[tag]
    bucket.sampled++
    if (r.agree === true) bucket.agree++
    else if (r.agree === false) {
      bucket.disagree++
      const q = qIndex[r.exam]?.[r.qid]
      if (bucket.examples_disagree.length < 5 && q) {
        bucket.examples_disagree.push({
          qid: r.qid,
          year: q.roc_year,
          session: q.session,
          number: q.number,
          current: r.current,
          suggested: r.suggested,
          excerpt: (q.question || '').slice(0, 80),
        })
      }
    }
  }

  const finalUsd = estimateCostUSD(totalIn, totalOut)
  const finalNtd = finalUsd / USD_PER_NTD
  const out = {
    audited_at: new Date().toISOString(),
    model: VERTEX_MODEL,
    sample_seed: SAMPLE_SEED,
    limit_per_combo: limitArg,
    usage: { promptTokens: totalIn, outputTokens: totalOut, usd: finalUsd, ntd: finalNtd },
    invalid_replies: invalidCount,
    by_exam: byExam,
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2))
  console.log(`\n[saved] ${OUT_JSON}`)

  // ─── Markdown report ───────────────────────────────────────────────────────
  let totalSampled = 0, totalAgree = 0, totalDisagree = 0
  for (const e of Object.values(byExam)) for (const s of Object.values(e.by_subject)) for (const t of Object.values(s.by_tag)) {
    totalSampled += t.sampled; totalAgree += t.agree; totalDisagree += t.disagree
  }
  const pct = (n, d) => d > 0 ? `${(n/d*100).toFixed(1)}%` : 'n/a'

  const thinkLabel = VERTEX_MODEL.includes('flash') ? 'thinkingBudget=0' : 'thinkingBudget=128 (min for Pro)'
  let md = `# 分類審計報告（Pro 模型）

- 審計時間：${out.audited_at}
- 模型：${VERTEX_MODEL}（temperature=0, ${thinkLabel}）
- 抽樣策略：每個 (exam, subject, subject_tag) 隨機抽 ${limitArg} 題（不足全抽），seed=${SAMPLE_SEED}
- 跳過：pt、ot（剛重分類過）

## 總覽

- 總抽樣數：**${totalSampled}**
- 模型同意現有分類：**${totalAgree}**（${pct(totalAgree, totalSampled)}）
- 模型不同意：**${totalDisagree}**（${pct(totalDisagree, totalSampled)}）
- 無法解析的回覆：${invalidCount}
- 預估成本：input ${totalIn} tok + output ${totalOut} tok ≈ $${finalUsd.toFixed(3)} USD ≈ **NTD ${finalNtd.toFixed(2)}**

## 高錯誤率 (exam, subject, tag) — 同意率 < 70%

| exam | subject | subject_tag | sampled | agree | disagree | accuracy |
|---|---|---|---:|---:|---:|---:|
`
  const allRows = []
  for (const [ex, eo] of Object.entries(byExam)) {
    for (const [sub, so] of Object.entries(eo.by_subject)) {
      for (const [tag, t] of Object.entries(so.by_tag)) {
        const acc = t.sampled > 0 ? t.agree / t.sampled : 0
        allRows.push({ ex, sub, tag, sampled: t.sampled, agree: t.agree, disagree: t.disagree, acc, examples: t.examples_disagree })
      }
    }
  }
  const bad = allRows.filter(r => r.sampled >= 3 && r.acc < 0.70).sort((a, b) => a.acc - b.acc)
  for (const r of bad) {
    md += `| ${r.ex} | ${r.sub} | ${r.tag} | ${r.sampled} | ${r.agree} | ${r.disagree} | ${(r.acc*100).toFixed(1)}% |\n`
  }
  if (!bad.length) md += '| _(none)_ | | | | | | |\n'

  md += `\n## 建議重跑分類器的 (exam, subject) 清單\n\n（聚合：subject 內任一 tag 同意率 < 70% 或整體錯誤率 > 30%）\n\n`
  const subjAgg = new Map()
  for (const r of allRows) {
    const k = `${r.ex}|${r.sub}`
    if (!subjAgg.has(k)) subjAgg.set(k, { ex: r.ex, sub: r.sub, sampled: 0, agree: 0, badTags: [] })
    const s = subjAgg.get(k)
    s.sampled += r.sampled; s.agree += r.agree
    if (r.sampled >= 3 && r.acc < 0.70) s.badTags.push(`${r.tag}(${(r.acc*100).toFixed(0)}%)`)
  }
  const recommend = [...subjAgg.values()]
    .filter(s => s.sampled >= 5 && (s.badTags.length > 0 || (s.agree / s.sampled) < 0.70))
    .sort((a, b) => (a.agree/a.sampled) - (b.agree/b.sampled))
  md += '| exam | subject | sampled | accuracy | bad tags |\n|---|---|---:|---:|---|\n'
  for (const s of recommend) {
    md += `| ${s.ex} | ${s.sub} | ${s.sampled} | ${(s.agree/s.sampled*100).toFixed(1)}% | ${s.badTags.join(', ') || '—'} |\n`
  }
  if (!recommend.length) md += '| _(none — 全部都健康)_ | | | | |\n'

  md += `\n## 詳細：每個 (exam, subject, tag) 的不一致樣本\n\n`
  for (const r of allRows.filter(x => x.disagree > 0).sort((a,b) => a.acc - b.acc)) {
    md += `### ${r.ex} / ${r.sub} / **${r.tag}** — ${r.agree}/${r.sampled} agree (${(r.acc*100).toFixed(0)}%)\n\n`
    for (const ex of r.examples) {
      md += `- **${ex.qid}** ${ex.year}-${ex.session} Q${ex.number}: 現 \`${ex.current}\` → 建議 \`${ex.suggested || '(invalid)'}\`\n  - 題幹節錄：${ex.excerpt}…\n`
    }
    md += '\n'
  }

  md += `\n## 完整資料\n\n結構化結果見 \`backend/_tmp/classification-audit-pro.json\`。\n`

  fs.writeFileSync(OUT_MD, md)
  console.log(`[saved] ${OUT_MD}`)
}

main().catch(e => { console.error(e); process.exit(1) })
