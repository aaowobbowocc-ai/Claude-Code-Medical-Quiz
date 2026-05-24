#!/usr/bin/env node
/**
 * 為每個 exam-configs/*.json 用 Vertex Gemini Flash 草擬深度 SEO 內容，
 * 寫進 seo.articleIntro / seo.subjectDeepDive / seo.studyStrategy / seo.faqs 4 個欄位。
 *
 * 動機（2026-05-24）：AdSense 拒絕「缺乏價值內容」。
 * 實測 doctor1 landing page 才 2910 字、teacher-secondary 才 1818 字。
 * 加完這 4 欄位每個 exam page 預計 3500+ 字 unique 內容。
 *
 * 用法：
 *   node scripts/gen-seo-content.js --dry-run                 # 印 prompt 不打 API
 *   node scripts/gen-seo-content.js --only=doctor1            # 只跑一個
 *   node scripts/gen-seo-content.js                           # 跑所有缺欄位的
 *   node scripts/gen-seo-content.js --force                   # 連已有的也重產
 *
 * 成本：~52 × 3000 output tokens × $0.30/M = ~$0.05 USD（Flash thinking off）
 */
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')

const CONFIG_DIR = path.join(__dirname, '..', 'exam-configs')
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const MODEL = 'gemini-2.5-flash'

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

// ─── args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const FORCE = args.includes('--force')
const ONLY = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || null

// ─── prompt builder ────────────────────────────────────────────────────
function buildPrompt(cfg) {
  const seo = cfg.seo || {}
  const papers = (cfg.papers || []).map(p => {
    const sub = p.breakdown ? p.breakdown.map(b => `${b.subject}(${b.count}題${b.note ? '，'+b.note : ''})`).join('、') : (p.subjects || p.subject || '')
    return `- ${p.name}（${p.count}題 / ${p.timeLimit || '?'}分鐘）：${sub}`
  }).join('\n') || '（無分卷資訊）'

  return `你是台灣國家考試備考內容專業編輯。請為以下考試生成繁體中文 SEO 深度內容。

## 考試資料
- 全名：${seo.fullName || cfg.name}
- 簡稱：${seo.shortName || cfg.short || cfg.name}
- 考生身分：${seo.studentType || '考生'}
- 考科總覽：${seo.subjects || ''}
- 通過標準：${cfg.passScore ? `總分 ${cfg.passScore} 分（約佔總配分 ${Math.round((cfg.passRate || 0) * 100)}%）` : (cfg.passRate ? `各科達 ${Math.round(cfg.passRate * 100)}%` : '依當年公告')}
- 題庫年度：${seo.years || '100-115'}
- 收錄題數：${cfg.totalQ || 0}

考試卷別：
${papers}

## 內容要求

請輸出 JSON（只輸出 JSON，不要任何前後文、不要 markdown code fence），格式：

{
  "articleIntro": "500-600 字深度介紹，包含：考試在職涯中的地位、為什麼重要、誰需要考、考完之後能做什麼。用台灣語感，不誇大，不編造具體薪資/職缺數字。",
  "subjectDeepDive": [
    { "name": "考科名稱", "desc": "200-300 字。說明這科考什麼、為什麼難、考生常見痛點、準備重點。給實際讀的人有用的內容，不是空話。" }
  ],
  "studyStrategy": "500-600 字備考策略，包含：建議時程（多久前開始）、各階段重點（基礎/衝刺/最後一週）、推薦學習資源類型（不要寫具體書名怕過時）、常見地雷與錯誤。",
  "faqs": [
    { "q": "簡短具體的問題", "a": "100-150 字回答，可實用。" }
  ]
}

## 重要要求

1. **subjectDeepDive 必須涵蓋上面卷別資料裡每個獨立的科目**（不是卷別，是 breakdown 裡的單科）。例如「醫學(一)」是卷別，但裡面的「解剖學」「組織學」是單科，每科一個物件。
2. **faqs 寫 6-8 個** 真實考生會問的問題（不是寫給 SEO 看的，要實際）。
3. **語感**：台灣語感，不要中國用語（如「視頻」改「影片」、「優化」OK、「給力」不行）。
4. **不誇大**：不寫「人人都該考」「保證高薪」這種話，務實。
5. **不編造數字**：除非考試官方有公告（如通過分數），不要編造錄取率、薪資、職缺等數字。
6. **這個考試獨有**：不要寫得跟其他考試 paraphrase 一樣，要突出本考試的特點。
7. **不出現品牌字眼**：不要寫「本平台」「我們」「國考知識王」。

直接輸出 JSON：`
}

// ─── Vertex Gemini call ─────────────────────────────────────────────────
async function genForExam(cfg) {
  const prompt = buildPrompt(cfg)

  if (DRY_RUN) {
    console.log(`\n========= ${cfg.id} =========`)
    console.log(prompt)
    return null
  }

  const token = await auth.getAccessToken()
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${MODEL}:generateContent`

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 6000,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error?.message || JSON.stringify(data).slice(0, 200))
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) throw new Error('empty response')
      const parsed = JSON.parse(text)
      // 基本欄位檢查
      if (!parsed.articleIntro || !Array.isArray(parsed.subjectDeepDive) || !parsed.studyStrategy || !Array.isArray(parsed.faqs)) {
        throw new Error('missing required fields in JSON')
      }
      return parsed
    } catch (e) {
      console.warn(`  attempt ${attempt + 1} failed: ${e.message}`)
      if (attempt === 2) throw e
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
}

// ─── main loop ──────────────────────────────────────────────────────────
async function main() {
  const files = fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'))
  const targets = ONLY ? files.filter(f => f.startsWith(ONLY + '.')) : files
  if (!targets.length) {
    console.error(`No matching exam configs. only=${ONLY}`)
    process.exit(1)
  }

  let done = 0, skipped = 0, failed = 0
  for (const f of targets) {
    const fp = path.join(CONFIG_DIR, f)
    const cfg = JSON.parse(fs.readFileSync(fp, 'utf8'))
    cfg.seo = cfg.seo || {}

    if (!FORCE && cfg.seo.articleIntro && cfg.seo.studyStrategy) {
      skipped++
      continue
    }

    console.log(`\n[${cfg.id}] generating…`)
    try {
      const out = await genForExam(cfg)
      if (DRY_RUN || !out) continue
      Object.assign(cfg.seo, out)
      fs.writeFileSync(fp, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
      done++
      // 字數摘要
      const total = (out.articleIntro || '').length
        + (out.subjectDeepDive || []).reduce((s, x) => s + (x.desc || '').length, 0)
        + (out.studyStrategy || '').length
        + (out.faqs || []).reduce((s, x) => s + (x.q + x.a || '').length, 0)
      console.log(`  ✓ ${cfg.id}: 共 ${total} 字 / ${out.subjectDeepDive.length} 科 / ${out.faqs.length} FAQs`)
    } catch (e) {
      failed++
      console.error(`  ✗ ${cfg.id}: ${e.message}`)
    }
  }

  console.log(`\n=== 完成 ===`)
  console.log(`✓ ${done} 個 exam 已產生 / 已跳過 ${skipped} / 失敗 ${failed}`)
  console.log(`💡 commit 前先 git diff 隨機看 2-3 個檔內容是否合理`)
}

main().catch(e => { console.error(e); process.exit(1) })
