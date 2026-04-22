#!/usr/bin/env node
/*
 * generate-seo-intros.js — Gemini-powered long-form zh-TW intros per exam
 *
 * For each exam-config, generate a ~400-character zh-TW article paragraph
 * (opening hook + 報考資格 + 科目重點 + 及格標準 + 備考建議) and cache to
 * frontend/src/seo-intros.json, keyed by examId.
 *
 * Idempotent: if an examId already has an intro in the cache, skip.
 * Atomic write: .tmp + rename.
 *
 * Model: gemini-2.5-flash (free tier, 1500/day — 26 calls well within).
 * API key: backend/.gemini-key (gitignored).
 *
 * Usage:
 *   node frontend/scripts/generate-seo-intros.js           # fill missing only
 *   node frontend/scripts/generate-seo-intros.js --force   # regenerate all
 *   node frontend/scripts/generate-seo-intros.js doctor1   # single exam
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const CONFIGS_DIR = path.join(ROOT, 'backend', 'exam-configs')
const KEY_FILE = path.join(ROOT, 'backend', '.gemini-key')
const OUT_FILE = path.join(__dirname, '..', 'src', 'seo-intros.json')

const MODEL = 'gemini-2.5-flash'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

function loadKey() {
  if (!fs.existsSync(KEY_FILE)) {
    console.error(`[seo-intros] ${KEY_FILE} not found — cannot call Gemini`)
    process.exit(1)
  }
  return fs.readFileSync(KEY_FILE, 'utf8').trim()
}

function loadCache() {
  if (!fs.existsSync(OUT_FILE)) return {}
  try {
    return JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'))
  } catch (e) {
    console.warn(`[seo-intros] warn: cache unreadable (${e.message}) — starting fresh`)
    return {}
  }
}

function saveCache(obj) {
  const tmp = OUT_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  fs.renameSync(tmp, OUT_FILE)
}

function buildPrompt(cfg) {
  const seo = cfg.seo || {}
  const fullName = seo.fullName || cfg.name || cfg.id
  const papers = (cfg.papers || []).map(p => p.subject || p.name).filter(Boolean)
  const subjectsLine = seo.subjects || papers.join('、')
  const passScore = cfg.passScore != null ? `${cfg.passScore} 分` : ''
  const passRate = cfg.passRate != null ? `${Math.round(cfg.passRate * 100)}%` : ''
  const passLine = [passScore, passRate].filter(Boolean).join('（總分 ') + (passRate ? '）' : '')
  const examDesc = seo.examDesc || ''

  return `你是繁體中文（台灣）教育內容編輯。請為「${fullName}」撰寫一段介紹文章（單一段落，不使用條列，不加標題），給準備報考的考生閱讀。

要求：
- 全文 350-450 個繁體中文字（不含標點符號計），以單一段落呈現
- 開頭用一句吸引人的導言說明這個考試的地位或重要性
- 接著說明報考資格（若資訊不足可用通用敘述，不要編造具體學分數）
- 介紹主要科目重點：${subjectsLine}
- 說明及格標準：${passLine || '採總分 60% 及格制'}
- 以 1-2 句給出備考建議收尾
- 用專業但親切的語氣，避免過度行銷用語
- 不要使用 Markdown、不要出現 emoji、不要出現 "國考知識王" 等平台名稱
- 只輸出正文，不要加引言或結語

參考資訊：${examDesc}`
}

async function callGemini(key, prompt) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
      responseMimeType: 'text/plain',
      // 2.5-flash spends "thinking" tokens against maxOutputTokens by default,
      // truncating answers mid-sentence. Disable thinking for straight prose.
      thinkingConfig: { thinkingBudget: 0 },
    },
  }
  const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`)
  }
  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || ''
  return text.trim()
}

function zhLen(s) {
  // rough length = characters excluding whitespace
  return String(s).replace(/\s+/g, '').length
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const onlyId = args.find(a => !a.startsWith('--'))

  const key = loadKey()
  const cache = loadCache()

  const files = fs.readdirSync(CONFIGS_DIR).filter(f => f.endsWith('.json'))
  const configs = files
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8')) }
      catch { return null }
    })
    .filter(c => c && c.id && (!onlyId || c.id === onlyId))

  let done = 0, skipped = 0, failed = 0
  for (const cfg of configs) {
    if (!force && cache[cfg.id] && zhLen(cache[cfg.id]) >= 300) {
      skipped++
      continue
    }
    const prompt = buildPrompt(cfg)
    try {
      console.log(`[seo-intros] ${cfg.id} → Gemini…`)
      const text = await callGemini(key, prompt)
      if (!text || zhLen(text) < 200) {
        console.warn(`[seo-intros] ${cfg.id}: response too short (${zhLen(text)} chars) — keeping what we got`)
      }
      cache[cfg.id] = text
      saveCache(cache)  // save after each success (checkpoint)
      done++
      await sleep(400)  // gentle pacing
    } catch (e) {
      console.error(`[seo-intros] ${cfg.id} FAILED: ${e.message}`)
      failed++
    }
  }
  console.log(`[seo-intros] done: generated ${done}, skipped ${skipped}, failed ${failed}  →  ${path.relative(ROOT, OUT_FILE)}`)
  if (failed) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
