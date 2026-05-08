#!/usr/bin/env node
/**
 * PT/OT 合卷再細分 — 把粗 tag（如 pt_foundation 涵蓋解剖+生理+肌動）
 * 用 Vertex Gemini 重新分到子主題 tag。
 *
 * 範圍：4 個 PT 合卷 + 1 個 OT 合卷
 * 共 ~11,920 題，僅處理 sourceTag 仍為粗 tag 的題目（idempotent，可中斷續跑）
 *
 * Usage:
 *   node scripts/reclassify-compound-papers.js --exam pt --subject 物理治療基礎學 [--limit N] [--dry-run]
 *   node scripts/reclassify-compound-papers.js --exam ot --subject 職能治療學概論 [--limit N]
 *   node scripts/reclassify-compound-papers.js --all  # 全跑
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')
const { atomicWriteJson } = require('./lib/atomic-write')

const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION  = 'us-central1'
const VERTEX_MODEL   = 'gemini-2.5-flash'

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

// ─── Rule definitions ────────────────────────────────────────────────────────
const RULES = {
  pt: {
    file: 'questions-pt.json',
    papers: {
      '物理治療基礎學': {
        sourceTag: 'pt_foundation',
        targets: [
          { tag: 'pt_anatomy',          desc: '人體解剖學（骨骼、肌肉、神經、血管系統的結構）' },
          { tag: 'pt_physio',           desc: '生理學（心肺、神經、肌肉、內分泌等系統機能）' },
          { tag: 'pt_kinesio',          desc: '肌動學與生物力學（動作分析、力學、姿勢、步態）' },
          { tag: 'pt_foundation_intro', desc: '物治基礎導論（物理治療基本概念與專業介紹）' },
        ],
      },
      '物理治療學概論': {
        sourceTag: 'pt_intro',
        targets: [
          { tag: 'pt_concept',  desc: '物治概念（物理治療發展、執業範疇、專業角色）' },
          { tag: 'pt_ethics',   desc: '倫理與法規（醫療倫理、物治師法、醫病關係）' },
          { tag: 'pt_evidence', desc: '循證實踐（實證醫學、研究方法、臨床決策）' },
        ],
      },
      '物理治療技術學': {
        sourceTag: 'pt_techniques',
        targets: [
          { tag: 'pt_thermal_electro', desc: '熱療與電療（熱療、冷療、電療、超音波、雷射）' },
          { tag: 'pt_hydro',           desc: '水療（水中治療、浮力應用）' },
          { tag: 'pt_manual',          desc: '徒手治療（關節鬆動、軟組織按摩、徒手技術）' },
          { tag: 'pt_exercise',        desc: '運動治療（治療性運動、肌力訓練、伸展、輔具）' },
        ],
      },
      '心肺疾病與小兒疾病物理治療學': {
        sourceTag: 'pt_cardio_peds',
        targets: [
          { tag: 'pt_cardio',    desc: '心肺疾病物治（心臟復健、肺部復健、呼吸訓練）' },
          { tag: 'pt_pediatric', desc: '小兒疾病物治（兒童發展、腦麻、發展遲緩、早療）' },
        ],
      },
    },
  },
  ot: {
    file: 'questions-ot.json',
    papers: {
      '職能治療學概論': {
        sourceTag: 'ot_intro',
        targets: [
          { tag: 'ot_history_theory', desc: '歷史、哲學與理論基礎（OT 發展史、學派理論模型）' },
          { tag: 'ot_role',           desc: '角色與執業（職能治療師角色、執業範疇、跨專業合作）' },
          { tag: 'ot_ethics_admin',   desc: '倫理與行政管理（職業倫理、行政、管理）' },
        ],
      },
    },
  },
}

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const examFilter   = args[args.indexOf('--exam') + 1]
const subjectFilter = args[args.indexOf('--subject') + 1]
const limitArg = args.indexOf('--limit') >= 0 ? parseInt(args[args.indexOf('--limit') + 1]) : 0
const isDry = args.includes('--dry-run')
const isAll = args.includes('--all')

// ─── Vertex call ─────────────────────────────────────────────────────────────
async function callGemini(prompt) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.0, maxOutputTokens: 30, thinkingConfig: { thinkingBudget: 0 } },
        }),
      })
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, Math.min(60000, 2000 * 2 ** attempt)))
        continue
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
    } catch (e) {
      if (attempt === 7) throw e
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
}

function buildPrompt(question, options, targets) {
  const opts = Object.entries(options || {}).map(([k, v]) => `(${k}) ${v}`).join('\n')
  const choices = targets.map((t, i) => `${i + 1}. ${t.tag}：${t.desc}`).join('\n')
  return `你是國考題分類員。下面這題物理治療/職能治療考題屬於哪個子科目？

題目：${question}
選項：
${opts}

候選子科目：
${choices}

只輸出一個 tag 名稱（如 pt_anatomy），不要解釋、不要標點、不要額外文字。`
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function processPaper(examId, subject, rule, limit) {
  const filePath = path.resolve(__dirname, '..', RULES[examId].file)
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  const questions = data.questions || data

  const valid = new Set(rule.targets.map(t => t.tag))
  const candidates = questions.filter(q =>
    q.subject === subject && q.subject_tag === rule.sourceTag
  )
  const target = limit > 0 ? candidates.slice(0, limit) : candidates

  console.log(`\n📂 ${examId} / ${subject}`)
  console.log(`   來源 tag: ${rule.sourceTag}, 候選: ${candidates.length}, 處理: ${target.length}`)
  console.log(`   目標 tags: ${rule.targets.map(t => t.tag).join(', ')}`)
  if (isDry) { console.log('   (dry-run, skip)'); return }

  let processed = 0, errors = 0, saved = 0
  const distribution = {}

  for (const q of target) {
    try {
      const prompt = buildPrompt(q.question, q.options, rule.targets)
      const reply = await callGemini(prompt)
      const cleanTag = reply.replace(/[`'"]/g, '').split(/\s+/)[0].trim()
      if (valid.has(cleanTag)) {
        q.subject_tag = cleanTag
        distribution[cleanTag] = (distribution[cleanTag] || 0) + 1
      } else {
        errors++
        if (errors < 5) console.log(`   ⚠ Q${q.number}: invalid reply "${reply.slice(0, 50)}"`)
      }
      processed++
      if (processed % 50 === 0) {
        atomicWriteJson(filePath, data)
        saved = processed
        process.stdout.write(`   ${processed}/${target.length} `)
        for (const [t, n] of Object.entries(distribution).sort((a,b)=>b[1]-a[1])) process.stdout.write(`${t}:${n} `)
        process.stdout.write('\n')
      }
    } catch (e) {
      errors++
      if (errors < 5) console.log(`   ✗ Q${q.number}: ${e.message}`)
    }
  }
  atomicWriteJson(filePath, data)
  console.log(`   ✓ 完成: ${processed - errors}/${target.length} 成功，${errors} 失敗`)
  console.log(`   📊 分布:`)
  for (const [t, n] of Object.entries(distribution).sort((a,b)=>b[1]-a[1])) {
    const pct = (n / processed * 100).toFixed(0)
    console.log(`      ${t.padEnd(28)} ${n.toString().padStart(5)} (${pct}%)`)
  }
}

async function main() {
  const tasks = []
  if (isAll) {
    for (const [exam, cfg] of Object.entries(RULES)) {
      for (const [subj, rule] of Object.entries(cfg.papers)) {
        tasks.push({ exam, subject: subj, rule })
      }
    }
  } else {
    if (!examFilter || !subjectFilter) {
      console.error('用法：--exam pt --subject 物理治療基礎學 [--limit 50]   或   --all')
      process.exit(1)
    }
    const rule = RULES[examFilter]?.papers[subjectFilter]
    if (!rule) { console.error(`找不到 ${examFilter} / ${subjectFilter}`); process.exit(1) }
    tasks.push({ exam: examFilter, subject: subjectFilter, rule })
  }

  for (const t of tasks) {
    await processPaper(t.exam, t.subject, t.rule, limitArg)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
