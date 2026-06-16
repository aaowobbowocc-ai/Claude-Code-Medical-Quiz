const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('./supabase');
const rag = require('./rag');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXPLAIN_MODEL = 'claude-haiku-4-5-20251001';
const GEMINI_MODEL = 'gemini-2.5-flash';

// ── Active text-generation provider: Vertex AI Gemini ──────────────────────
// /explain and /daily-message run exclusively on Vertex Gemini via ADC.
// The legacy generativelanguage.googleapis.com path (API key) was removed
// 2026-05-23 — it was billing-account-tier paid with no credit coverage and
// only existed as dead code. The Anthropic Claude path remains as a fallback
// for prompts that need stronger reasoning.
const { GoogleAuth } = require('google-auth-library');
const VERTEX_PROJECT = 'gen-lang-client-0502672630';
const VERTEX_REGION = 'us-central1';
const vertexAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

// Cold / low-cache exams. Fresh Haiku calls for these never amortise through
// the shared Supabase cache the way hot medical exams do, so we serve first
// generations from Gemini Flash (free tier). Cache hits still stream the
// stored text regardless of which model originally produced it.
const GEMINI_EXAMS = new Set([
  'vet', 'social-worker', 'lawyer1', 'judicial', 'customs', 'police',
  'civil-senior', 'civil-senior-general', 'civil-junior-general', 'civil-junior-civil-affairs', 'civil-elementary-general',
  'driver-car', 'driver-moto',
  'state-mgmt', 'state-hr', 'state-finance', 'state-it',
]);

// RAG context retrieval scope — medical exams use wikipedia_zh/en corpus,
// legal/civil-service exams use law_moj_tw corpus.
const MEDICAL_EXAMS = new Set([
  'doctor1','doctor2','dental1','dental2','pharma1','pharma2',
  'nursing','nutrition','medlab','pt','ot','radiology','tcm1','tcm2','vet'
]);
const LEGAL_EXAMS = new Set([
  'lawyer1','judicial','civil-senior','civil-senior-general',
  'civil-junior-general','civil-junior-civil-affairs','civil-elementary-general',
  'customs','police','police4','social-worker'
]);
const RAG_ENABLED = new Set([...MEDICAL_EXAMS, ...LEGAL_EXAMS, 'driver-car','driver-moto']);

const DRIVER_EXAMS = new Set(['driver-car', 'driver-moto']);

// Category-specific guidance injected into /explain prompt. Tailors emphasis
// to the discipline (mechanism vs articles vs safety principles) and adapts
// the final "application" section label.
function getCategoryGuidance(examId) {
  if (DRIVER_EXAMS.has(examId)) {
    return {
      extraRules: [
        '駕駛題優先依「防禦駕駛」原則：永遠假設對方會犯錯、預留緩衝、降低風險。',
        '若涉及處罰，引用《道路交通管理處罰條例》或《道路交通安全規則》具體條文編號。',
      ],
      applicationLabel: '🛣️ 路上實際應用',
      applicationDesc: '一句話說明這在真實路況怎麼運用',
    };
  }
  if (LEGAL_EXAMS.has(examId)) {
    return {
      extraRules: [
        '引用具體法條編號（民§184、刑§271 等），不要只說「依民法」這種模糊用法。',
        '法律名詞要精確（要件 vs 效果、形式 vs 實質、絕對 vs 相對）；務必區分學說/實務見解。',
        '若有最高法院重要判例或大法官解釋，可簡要引用字號與要旨。',
      ],
      applicationLabel: '⚖️ 實務應用',
      applicationDesc: '一句話說明此考點在實務上常如何被應用或考試常見變化',
    };
  }
  if (MEDICAL_EXAMS.has(examId)) {
    return {
      extraRules: [
        '醫學題以「機制優先」(mechanism-first) 解釋：先講為什麼會發生（pathophysiology），再講臨床表現/治療。',
        '藥物題注意作用機轉、副作用、禁忌、相互作用四面向。',
      ],
      applicationLabel: '🏥 臨床應用',
      applicationDesc: '一句話說明這個知識點在臨床上的意義',
    };
  }
  // Civil-service / generic fallback
  return {
    extraRules: [
      '公職題優先連結相關法規、政策方向或公文格式；引用具體條號加分。',
      '考試常考改制／新舊版差異，注意年度修法資訊。',
    ],
    applicationLabel: '📋 考試與實務',
    applicationDesc: '一句話說明這在實際業務或考試重點上的位置',
  };
}

// Community-voting tiers for AI explanations (see migrations/002).
//   pending   — fresh gen, unverified → half price (reward early reviewers)
//   verified  — upvotes >= 3         → free (attracts readers, amortises cost)
//   retracted — downvotes crossed    → md cleared, next reader regenerates
// Pricing recalibrated 2026-05-07 — full price 150 → 100 for friendlier UX.
// Pending tier scales to roughly half (50) so community-validated content still
// has the steepest discount path. Verified stays free.
const EXPLAIN_PRICE_FULL     = 100;
const EXPLAIN_PRICE_PENDING  = 50;
const EXPLAIN_PRICE_VERIFIED = 0;
const VERIFY_THRESHOLD = 3;           // upvotes to flip pending → verified
const RETRACT_PENDING_THRESHOLD = 3;  // downvotes to retract pending
// verified retraction: downvotes >= max(3, upvotes/2) — socially-validated
// content needs more dissent to be pulled down.

function priceForStatus(status) {
  if (status === 'verified')  return EXPLAIN_PRICE_VERIFIED;
  if (status === 'pending')   return EXPLAIN_PRICE_PENDING;
  return EXPLAIN_PRICE_FULL; // no row or retracted → full price to regenerate
}

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
}

function fingerprint(text) {
  if (!text) return null;
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

const aiUsage = { date: '', count: 0 };
// AI_DAILY_LIMIT removed 2026-05-07 — site-wide cap was a tragedy-of-the-commons
// design that punished all users when one heavy day pushed it over. Per-user
// cap (frontend PERSONAL_LIMIT) + cache + per-exam Gemini routing already keep
// cost under control.
const AI_DAILY_LIMIT = Infinity;

// daily-message cache: key = "date|level", value = message text
const dailyMsgCache = new Map();

// ─── Read-through cache for AI explanations (Supabase ai_explanations table) ───
//
// Key shape:
//   shared:<bankId>:<questionId>   — shared bank questions, reused cross-exam
//   exam:<examId>:<questionId>     — exam-owned questions (existing 14 medical)
//
// Falls back to no-op if Supabase env not set; treats DB errors as cache miss
// rather than failing the request (better to spend a Claude call than 500).

function buildCacheKey({ shared_bank, exam, question_id }) {
  if (!question_id) return null;
  if (shared_bank) return `shared:${shared_bank}:${question_id}`;
  if (exam) return `exam:${exam}:${question_id}`;
  return null;
}

// Returns { md, status, upvotes, downvotes } or null for (miss | retracted).
// Retracted rows are deliberately treated as miss so the next reader pays full
// price and triggers a fresh generation.
async function getCachedExplanation(cacheKey) {
  if (!supabase || !cacheKey) return null;
  try {
    const { data, error } = await supabase
      .from('ai_explanations')
      .select('explanation_md, hit_count, status, upvotes, downvotes')
      .eq('cache_key', cacheKey)
      .maybeSingle();
    if (error || !data) return null;
    if (data.status === 'retracted' || !data.explanation_md) return null;
    // Fire-and-forget hit_count increment — don't block streaming on it
    supabase
      .from('ai_explanations')
      .update({ hit_count: (data.hit_count || 0) + 1, updated_at: new Date().toISOString() })
      .eq('cache_key', cacheKey)
      .then(() => {}, () => {});
    return {
      md: data.explanation_md,
      status: data.status || 'pending',
      upvotes: data.upvotes || 0,
      downvotes: data.downvotes || 0,
    };
  } catch {
    return null;
  }
}

// Upsert: if the row exists but is retracted, this resets it to pending with
// fresh tallies so community verification starts over on the new generation.
async function saveCachedExplanation(cacheKey, explanation_md, model) {
  if (!supabase || !cacheKey || !explanation_md) return;
  try {
    await supabase
      .from('ai_explanations')
      .upsert({
        cache_key: cacheKey,
        explanation_md,
        model,
        status: 'pending',
        upvotes: 0,
        downvotes: 0,
        hit_count: 1,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'cache_key' });
  } catch { /* swallow — cache write failures are non-fatal */ }
}

// Record a paid explanation unlock for a user. Idempotent (PRIMARY KEY on
// (user_id, question_id) means duplicates upsert harmlessly). Failures swallowed
// so a write hiccup doesn't break the explanation stream.
async function recordUnlock(userId, questionId, examId, paidAmount) {
  if (!supabase || !userId || !questionId) return;
  try {
    await supabase
      .from('user_explanation_unlocks')
      .upsert({
        user_id: String(userId),
        question_id: String(questionId),
        exam_id: examId || null,
        paid_amount: paidAmount || 0,
        unlocked_at: new Date().toISOString(),
      }, { onConflict: 'user_id,question_id', ignoreDuplicates: true });
  } catch { /* non-fatal */ }
}

// Stream a static string back over an already-open SSE response in the same
// chunked format the Claude stream produces, so the frontend doesn't care
// whether the source was cache or Claude.
function streamCachedText(res, text) {
  const chunks = text.match(/.{1,40}/gs) || [text];
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function checkAILimit(stats) {
  const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  if (aiUsage.date !== today) { aiUsage.date = today; aiUsage.count = 0; }
  if (aiUsage.count >= AI_DAILY_LIMIT) return false;
  aiUsage.count++;
  stats.aiExplains++;
  bumpAIDaily(stats, today);
  return true;
}

function bumpAIDaily(stats, today) {
  if (!stats.aiDaily) stats.aiDaily = {};
  stats.aiDaily[today] = (stats.aiDaily[today] || 0) + 1;
  // Keep only last 60 days to prevent unbounded growth
  const keys = Object.keys(stats.aiDaily).sort();
  while (keys.length > 60) {
    delete stats.aiDaily[keys.shift()];
  }
}

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

async function streamAnthropic(res, prompt, maxTokens = 600, onComplete) {
  let fullText = '';
  // Retry transient failures (Haiku 529 overloaded / 429 / 5xx) — these are the
  // usual cause of intermittent "no AI response" reports. A retry is only safe
  // while nothing has been written to the response yet (fullText empty).
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const stream = await anthropic.messages.stream({
        model: EXPLAIN_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
          fullText += chunk.delta.text;
          res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
        }
      }
      // Empty completion (model returned no text) is a failure from the user's
      // POV — signal it as an error frame, not a silent [DONE].
      if (!fullText) {
        res.write(`data: ${JSON.stringify({ error: 'empty_response' })}\n\n`);
        res.end();
        return;
      }
      res.write('data: [DONE]\n\n');
      res.end();
      if (onComplete) onComplete(fullText);
      return;
    } catch (e) {
      const transient = !e.status || [429, 500, 502, 503, 529].includes(e.status);
      // Mid-stream failure (text already sent) or non-transient or out of
      // attempts → give up and surface the error.
      if (fullText || attempt >= 3 || !transient) {
        console.warn('[explain] anthropic stream failed:', e.message);
        res.write(`data: ${JSON.stringify({ error: e.message || 'stream_failed' })}\n\n`);
        res.end();
        return;
      }
      await new Promise(r => setTimeout(r, attempt * 400));
    }
  }
}

// Streaming Gemini via Vertex AI SSE. Auth is ADC (no API key) — same path as
// rag.js embeddings. Output protocol matches streamAnthropic:
// `data: {text}` frames, a final `data: [DONE]`, or `data: {error}` on failure.
//
// Retry policy mirrors streamAnthropic: transient pre-stream failures
// (429/500/502/503 or empty completion before any token streamed) get up to
// 3 attempts with linear backoff. Once a single token has been written to the
// client, a mid-stream failure is surfaced immediately — retrying would
// concatenate two partial answers into the user's view.
//
// Empty completion is included in the transient set because gemini-2.5-flash
// occasionally returns 0 tokens when safety filters flag the prompt mid-stream;
// retrying with the same prompt usually succeeds on the next attempt. If it
// keeps coming back empty after 3 tries, that's a real safety block — surface
// the error so the frontend can show "失敗請重試" and refund the coin.
async function streamVertexGemini(res, prompt, maxTokens = 600, onComplete, opts = {}) {
  let token;
  try {
    token = await vertexAuth.getAccessToken();
  } catch (e) {
    console.warn('[vertex] auth failed:', e.message);
    res.write(`data: ${JSON.stringify({ error: 'vertex_auth_failed' })}\n\n`);
    res.end();
    return;
  }

  // Google Search Grounding (opts.grounding=true): adds tools:[{googleSearch:{}}].
  // Costs an extra ~$0.035/grounded request. Whether this SKU is covered by
  // the "Trial credit for GenAI App Builder" credit depends on which family
  // Google bills it under (Discovery Engine vs base Vertex AI) — verify in
  // GCP Billing SKU breakdown after a few days of real traffic before
  // assuming it's free. The model returns groundingMetadata with citation
  // URLs we forward to the client via a meta frame before [DONE].
  const useGrounding = !!opts.grounding;

  // One attempt = one HTTPS round-trip. Returns 'done' on success or terminal
  // failure (error frame already written), or 'retry' if caller should try
  // again (no bytes written to client yet).
  function attempt() {
    return new Promise((resolve) => {
      let fullText = '';
      // Merged groundingMetadata across stream chunks. Vertex sends chunks
      // (sometimes interleaved with text deltas); the final chunk contains
      // the full citation list, but to be safe we accumulate every chunk
      // that includes groundingChunks and dedupe by uri.
      const citations = [];
      const seenUris = new Set();
      const reqBody = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          thinkingConfig: { thinkingBudget: 0 },
        },
      };
      if (useGrounding) reqBody.tools = [{ googleSearch: {} }];
      const body = JSON.stringify(reqBody);
      const req = https.request({
        hostname: `${VERTEX_REGION}-aiplatform.googleapis.com`,
        path: `/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
        },
      }, (gRes) => {
        if (gRes.statusCode !== 200) {
          let errBody = '';
          gRes.on('data', d => { errBody += d.toString(); });
          gRes.on('end', () => {
            const status = gRes.statusCode;
            const transient = [429, 500, 502, 503].includes(status);
            console.warn(`[vertex] HTTP ${status}${transient ? ' (transient)' : ''}: ${errBody.slice(0, 200)}`);
            if (transient) return resolve({ status: 'retry' });
            res.write(`data: ${JSON.stringify({ error: `vertex_${status}` })}\n\n`);
            res.end();
            resolve({ status: 'done' });
          });
          return;
        }
        let buf = '';
        gRes.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (!raw) continue;
            try {
              const parsed = JSON.parse(raw);
              const cand = parsed.candidates?.[0];
              const text = cand?.content?.parts?.[0]?.text;
              if (text) {
                fullText += text;
                res.write(`data: ${JSON.stringify({ text })}\n\n`);
              }
              const chunks = cand?.groundingMetadata?.groundingChunks;
              if (Array.isArray(chunks)) {
                for (const c of chunks) {
                  const web = c.web || c.retrievedContext;
                  const uri = web?.uri;
                  if (uri && !seenUris.has(uri)) {
                    seenUris.add(uri);
                    citations.push({ uri, title: web?.title || uri });
                  }
                }
              }
            } catch { /* partial JSON frame, ignore */ }
          }
        });
        gRes.on('end', () => {
          if (!fullText) return resolve({ status: 'retry', reason: 'empty' });
          // Send citations as a meta frame before [DONE] — frontend's
          // streamPost calls onMeta with {citations:[...]}. The hook merges
          // it into the existing meta state (price/cacheKey from earlier).
          if (citations.length) {
            res.write(`data: ${JSON.stringify({ meta: { citations } })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
          if (onComplete) onComplete(fullText, { citations });
          resolve({ status: 'done' });
        });
        gRes.on('error', (e) => {
          if (!fullText) return resolve({ status: 'retry', reason: 'gres_error', error: e });
          // mid-stream — partial answer already on the wire, can't retry
          res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
          res.end();
          resolve({ status: 'done' });
        });
      });
      req.on('error', (e) => resolve({ status: 'retry', reason: 'req_error', error: e }));
      req.write(body);
      req.end();
    });
  }

  for (let i = 1; i <= 3; i++) {
    const result = await attempt();
    if (result.status === 'done') return;
    if (i < 3) await new Promise(r => setTimeout(r, i * 400));
  }
  // Out of retries — every attempt was transient (e.g. persistent 503 or
  // safety-blocked empty). Tell the frontend so the coin gets refunded.
  res.write(`data: ${JSON.stringify({ error: 'vertex_retry_exhausted' })}\n\n`);
  res.end();
}

function registerRoutes(app, examData, stats) {
  console.log(`[ai] explain model: Vertex Gemini (${GEMINI_MODEL}) — generativelanguage path removed 2026-05-23`);

  // POST /explain
  app.post('/explain', async (req, res) => {
    const { question, options, answer, subject_name, user_answer, question_id, exam, shared_bank,
            incomplete, disputed, has_image, user_id } = req.body;
    if (!question || !options || !answer) return res.status(400).json({ error: 'missing fields' });

    const questionsData = examData[exam] || examData.doctor1;

    // Tier 1 short-circuit FIRST — pre-stored explanations are free, never
    // need pricing/unlock metadata, and avoid two Supabase round-trips. This
    // makes the medical exam fast path 0ms→stream.
    if (question_id) {
      const local = questionsData.questions.find(q => String(q.id) === String(question_id));
      if (local?.explanation) {
        sseHeaders(res);
        streamCachedText(res, local.explanation);
        return;
      }
    }

    // Per-user unlock check — once paid, any future view is free for THIS user
    // across devices. Looked up by Supabase auth user_id (anonymous + Google
    // linked share the same id post-link). Race against a 600ms timeout so a
    // slow Supabase response doesn't keep the user staring at a loading dot.
    //
    // 2026-05-28：新增「AI 無限包」短路檢查——若 ai_unlimited_until > now()，
    // 視同 already unlocked，整題免費。原本的 unlock check 一併查同個 profile
    // row 省一次 RTT。Feature flag 由 backend env FEATURE_AI_UNLIMITED 控制：
    // 沒開 → ai_unlimited_until 欄位不查，行為與舊版一致。
    let alreadyUnlocked = false;
    let aiUnlimitedActive = false;
    if (user_id && question_id && supabase) {
      try {
        const aiUnlimitedFlag = process.env.FEATURE_AI_UNLIMITED === '1';
        // 兩個 query 並行：unlock check + (optional) ai_unlimited_until
        const queries = [
          supabase
            .from('user_explanation_unlocks')
            .select('user_id')
            .eq('user_id', user_id)
            .eq('question_id', String(question_id))
            .maybeSingle()
            .then(({ data }) => !!data)
            .catch(() => false),
        ];
        if (aiUnlimitedFlag) {
          queries.push(
            supabase
              .from('profiles')
              .select('ai_unlimited_until')
              .eq('user_id', user_id)
              .single()
              .then(({ data }) => data?.ai_unlimited_until && new Date(data.ai_unlimited_until) > new Date())
              .catch(() => false),
          );
        }
        const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 600));
        const results = await Promise.race([Promise.all(queries), timeoutPromise]);
        if (Array.isArray(results)) {
          alreadyUnlocked = !!results[0];
          aiUnlimitedActive = !!results[1];
        }
      } catch { /* swallow — no unlock check, pay normal price */ }
    }
    // 有無限包 → 視同已解鎖（免費）
    if (aiUnlimitedActive) alreadyUnlocked = true;

    // Tier 2: Supabase cache (shared keys are reused cross-exam)
    const cacheKey = buildCacheKey({ shared_bank, exam, question_id });
    const cached = await getCachedExplanation(cacheKey);
    if (cached) {
      stats.aiExplains++; // count as a successful explain even though no API call
      bumpAIDaily(stats, new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }));
      sseHeaders(res);
      // Meta frame first so the frontend can render the verified/pending badge
      // and charge the correct price before the text starts flowing.
      const realPrice = priceForStatus(cached.status);
      res.write(`data: ${JSON.stringify({ meta: {
        cacheKey,
        status: cached.status,
        upvotes: cached.upvotes,
        downvotes: cached.downvotes,
        price: alreadyUnlocked ? 0 : realPrice,
        alreadyUnlocked,
      }})}\n\n`);
      streamCachedText(res, cached.md);
      // Record server-side unlock if this is a paid hit (user actually spent).
      if (!alreadyUnlocked && realPrice > 0 && user_id && question_id && supabase) {
        recordUnlock(user_id, question_id, exam, realPrice).catch(() => {});
      }
      return;
    }

    // Tier 3: Claude API
    if (!checkAILimit(stats)) {
      return res.status(429).json({ error: 'daily_limit', message: '今日 AI 解說次數已達上限，明天再來喔！' });
    }

    sseHeaders(res);
    // Fresh generation — always pending, full price (or 0 if user already
    // unlocked this question on another device).
    res.write(`data: ${JSON.stringify({ meta: {
      cacheKey,
      status: 'pending',
      upvotes: 0,
      downvotes: 0,
      price: alreadyUnlocked ? 0 : EXPLAIN_PRICE_FULL,
      alreadyUnlocked,
    }})}\n\n`);
    const optionText = Object.entries(options).map(([k,v]) => `${k}. ${v}`).join('\n');
    // Detect multichoice format: question lists ①②③④/1234 statements, options are combos
    const isMultiStatement = /[①②③④⑤⑥⑦]/.test(question) ||
      Object.values(options).some(v => /^[①②③④⑤⑥⑦\d]{2,3}$/.test(String(v).trim()));
    const multiNote = isMultiStatement
      ? '【題型】此為多選/組合題：題幹列出多個陳述（①②③…），選項為其組合。請逐一判斷每個陳述對錯，再對照答案組合。'
      : '';
    // Targeted wrong-answer analysis — when user picked wrong, the most useful
    // bit is *why* their pick was tempting and what specifically distinguishes it.
    const wrongNote = user_answer && user_answer !== answer && options[user_answer]
      ? `考生選了 ${user_answer}（${String(options[user_answer]).slice(0,80)}），但正確答案是 ${answer}。在「排除其他選項」段落，請特別針對 ${user_answer} 解釋常見誤解原因，並指出與 ${answer} 的關鍵差異。`
      : '';

    const examMeta = examData[exam] || examData.doctor1;
    const examName = examMeta.metadata?.category || '醫師國考';

    // RAG context retrieval — sets defined at module scope (RAG_ENABLED).
    // Best-effort: don't block explain on retrieval failure.
    let ragContext = '';
    if (RAG_ENABLED.has(exam)) {
      try {
        // Build a focused query: question text + correct option text. Keep
        // total under ~200 chars to keep embedding cost low and signal strong.
        const correctOption = options[answer] || '';
        const queryText = (question + '\n' + correctOption).slice(0, 200);
        // Retrieve from both zh and en corpora — English drug names and
        // pathophysiology concepts often have better English Wikipedia coverage.
        const chunks = await rag.retrieve(queryText, { topK: 3, threshold: 0.55, language: null });
        if (chunks.length) {
          // Label depends on source: 法規 → 法條條文; 醫學 → 醫學百科
          const isLegal = chunks.some(c => c.metadata?.attribution?.includes('全國法規資料庫'));
          const sourceLabel = isLegal ? '法規條文' : '醫學百科';
          ragContext = `\n【參考資料】（從${sourceLabel}檢索）\n` + chunks.map((c, i) =>
            `${i + 1}. 《${c.metadata?.title || c.metadata?.law_name || '參考'}》：${c.content.replace(/\n+/g, ' ').slice(0, 220)}…`
          ).join('\n') + '\n（這些段落僅供參考，請優先依照題幹判斷。）\n';
        }
      } catch (e) {
        // Retrieval failure is non-fatal — fall through to no-context generation.
        console.warn('[explain] RAG retrieve failed:', e.message);
      }
    }

    // Conditional notes based on question metadata
    const notes = [];
    if (incomplete === 'missing_image' || (incomplete === true && has_image)) {
      notes.push('⚠️ 本題原 PDF 含圖片但模型看不到。請以題目文字推斷影像特徵，並說明若是常見表現該如何判讀。');
    }
    if (incomplete === 'image_options') {
      notes.push('⚠️ 本題 4 個選項是影像（介面已顯示）。請說明每個選項代表的臨床/影像表現，協助考生比對畫面。');
    }
    if (disputed) {
      notes.push('⚠️ 本題為考選部認定的爭議題（送分），可指出題目歧義所在，並說明各選項合理性。');
    }
    const noteBlock = notes.length ? '\n' + notes.join('\n') + '\n' : '';

    const cat = getCategoryGuidance(exam);
    const extraRulesBlock = cat.extraRules.map((r, i) => `${6 + i}. ${r}`).join('\n');

    const prompt = `你是一位臺灣${examName}的解題老師，用繁體中文回答。
${ragContext}
【作答原則】
1. 以題幹線索為核心：題目給的資訊（數據、病史、條文、案例）優先使用，不要憑空加細節。
2. 台灣考試標準：以台灣現行法規、官方指引、學會共識為準（醫學題用台灣醫學會指引/健保；法律題用台灣現行法）。
3. 不確定的精確數值（劑量、年限、金額、百分比、cutoff、條號）要標「約」或「依指引」，**寧可不寫具體數字，也不要編造**。
4. 若知識點冷門或題幹資訊不足，誠實說「題幹資訊有限，常見答案是 X」，不要硬掰機制。
5. 避免無翻譯的艱澀外文；專有名詞中英並列。
6. **每段不重複資訊**：「為什麼答案是 X」講核心機制；「排除其他選項」只比較差異點，不要重述相同概念。
${extraRulesBlock}
${multiNote}
${noteBlock}
科目：${subject_name}
題目：${question}

選項：
${optionText}

正確答案：${answer}
${wrongNote}

請用以下格式回答（每段都要有，簡潔扼要）：

**✅ 為什麼答案是 ${answer}**
（從題幹線索出發，說明核心機制或概念，2-3句）

**❌ 排除其他選項**
（每個錯誤選項一句話說明為何不對）

**🧠 記憶關鍵字**
（給一個好記的口訣或記憶技巧）

**${cat.applicationLabel}**
（${cat.applicationDesc}）`;

    // Google Search grounding 已全面關閉（2026-06-16）。
    // 原因：grounding 開啟會強制 Gemini 2.5 啟用 thinking（推理），使 generationConfig
    // 的 thinkingBudget:0 失效；2026/6 帳單顯示「Thinking Text Output」單一 SKU 就 $94/月
    // （佔 Vertex 帳單 61%），遠超原註解預估的 ~$10/月。關閉後 thinkingBudget:0 生效、
    // 思考 token 歸零，帳單預估砍約六成。代價：解說不再附即時搜尋引用（模型本身知識足夠）。
    // 若日後要對特定考試重開，把該 exam 加進下面條件即可。
    const useGrounding = false;

    await streamVertexGemini(res, prompt, 600, (fullText) => {
      // Citations are surfaced live via the meta frame; we don't persist them
      // to the cache row yet (ai_explanations has no citations column —
      // adding one is a separate schema migration). Cache hits therefore
      // serve text without sources, which is acceptable degradation: the
      // explanation itself is the value, citations are nice-to-have.
      saveCachedExplanation(cacheKey, fullText, GEMINI_MODEL);
      if (!alreadyUnlocked && user_id && question_id) {
        recordUnlock(user_id, question_id, exam, EXPLAIN_PRICE_FULL).catch(() => {});
      }
    }, { grounding: useGrounding });
  });

  // POST /ai/unlocks/sync — Bulk import unlocks from a device's localStorage
  // when a user logs in. Returns the merged set so the client can update its
  // local cache. Body: { userId, questionIds: string[] }.
  // SECURITY: require auth header + verify userId matches token, otherwise any
  // attacker can mark all 193K questions as unlocked for any user_id and bypass
  // explanation paywall completely.
  app.post('/ai/unlocks/sync', async (req, res) => {
    if (!supabase) return res.json({ unlocks: [] });
    const { userId, questionIds } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'missing userId' });
    // Verify userId via Bearer token — refuse if no token or mismatch
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'missing auth' });
    try {
      const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !user || user.id !== userId) {
        return res.status(403).json({ error: 'userId does not match token' });
      }
    } catch {
      return res.status(401).json({ error: 'invalid token' });
    }
    const localList = Array.isArray(questionIds) ? questionIds.filter(Boolean).map(String).slice(0, 5000) : [];

    try {
      // Push local-only unlocks up. ignoreDuplicates=true respects rows already
      // recorded server-side.
      if (localList.length) {
        const rows = localList.map(qid => ({
          user_id: String(userId),
          question_id: qid,
          paid_amount: 0,
          unlocked_at: new Date().toISOString(),
        }));
        // chunk to stay under request size limits
        const CHUNK = 500;
        for (let i = 0; i < rows.length; i += CHUNK) {
          await supabase
            .from('user_explanation_unlocks')
            .upsert(rows.slice(i, i + CHUNK), { onConflict: 'user_id,question_id', ignoreDuplicates: true });
        }
      }
      // Pull the full set back so the client can refresh localStorage.
      const { data, error } = await supabase
        .from('user_explanation_unlocks')
        .select('question_id')
        .eq('user_id', String(userId))
        .limit(10000);
      if (error) return res.status(500).json({ error: 'fetch failed' });
      res.json({ unlocks: (data || []).map(r => r.question_id) });
    } catch (e) {
      res.status(500).json({ error: e.message?.slice(0, 200) || 'sync failed' });
    }
  });

  // POST /ai/vote — community verification of AI explanations.
  // Body: { cacheKey, value: 1|-1, deviceId, userId? }
  // Dedupe: hard unique on (cache_key, device_id); user_id + ip_hash are stored
  // for soft app-layer detection of ban-evasion via fresh device IDs.
  app.post('/ai/vote', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'voting disabled' });
    const { cacheKey, value, deviceId, userId } = req.body || {};
    if (!cacheKey || !deviceId) return res.status(400).json({ error: 'missing cacheKey or deviceId' });
    if (value !== 1 && value !== -1) return res.status(400).json({ error: 'value must be 1 or -1' });

    const ipHash = hashIp(req.ip || req.headers['x-forwarded-for']);

    try {
      // Step 1: insert the vote row. Unique index (cache_key, device_id) blocks
      // dupes; translate that into a 409 rather than a 500.
      const { error: insertErr } = await supabase
        .from('ai_votes')
        .insert({ cache_key: cacheKey, device_id: deviceId, user_id: userId || null, ip_hash: ipHash, value });
      if (insertErr) {
        if (insertErr.code === '23505' || /duplicate/i.test(insertErr.message || '')) {
          return res.status(409).json({ error: 'already voted' });
        }
        return res.status(500).json({ error: 'vote insert failed' });
      }

      // Step 2: read the current explanation row so we know its state.
      const { data: ex, error: exErr } = await supabase
        .from('ai_explanations')
        .select('explanation_md, status, upvotes, downvotes')
        .eq('cache_key', cacheKey)
        .maybeSingle();
      if (exErr || !ex) return res.status(404).json({ error: 'explanation not found' });

      const upvotes   = (ex.upvotes   || 0) + (value ===  1 ? 1 : 0);
      const downvotes = (ex.downvotes || 0) + (value === -1 ? 1 : 0);
      let status = ex.status || 'pending';
      const patch = { upvotes, downvotes, updated_at: new Date().toISOString() };

      // State machine — asymmetric thresholds.
      if (status === 'pending') {
        if (upvotes >= VERIFY_THRESHOLD) {
          status = 'verified';
        } else if (downvotes >= RETRACT_PENDING_THRESHOLD) {
          status = 'retracted';
        }
      } else if (status === 'verified') {
        const retractFloor = Math.max(3, Math.floor(upvotes / 2));
        if (downvotes >= retractFloor) status = 'retracted';
      }

      patch.status = status;
      if (status === 'retracted') {
        patch.retracted_at = new Date().toISOString();
        patch.retracted_fingerprint = fingerprint(ex.explanation_md);
        patch.explanation_md = null; // next reader triggers a fresh generation
      }

      const { error: updErr } = await supabase
        .from('ai_explanations')
        .update(patch)
        .eq('cache_key', cacheKey);
      if (updErr) return res.status(500).json({ error: 'tally update failed' });

      return res.json({ status, upvotes, downvotes, price: priceForStatus(status) });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'vote failed' });
    }
  });

  // POST /review
  app.post('/review', async (req, res) => {
    const { questions, mode = 'practice' } = req.body;
    if (!questions?.length) return res.status(400).json({ error: 'no questions' });

    sseHeaders(res);
    const wrong = questions.filter(q => q.user_answer !== q.answer);
    const total = questions.length;
    const correct = total - wrong.length;

    const wrongSummary = wrong.slice(0, 8).map((q, i) =>
      `${i+1}. [${q.subject_name}] ${q.question.slice(0,60)}…\n   我選：${q.user_answer || '未作答'}，正確：${q.answer}`
    ).join('\n');

    const subjectStats = {};
    for (const q of questions) {
      if (!subjectStats[q.subject_name]) subjectStats[q.subject_name] = { total: 0, wrong: 0 };
      subjectStats[q.subject_name].total++;
      if (q.user_answer !== q.answer) subjectStats[q.subject_name].wrong++;
    }
    const statText = Object.entries(subjectStats)
      .map(([s,v]) => `${s}: ${v.total - v.wrong}/${v.total}`)
      .join('、');

    const prompt = `你是一位臺灣醫師國考（一階）的家教老師，用繁體中文給學生檢討報告。

本次${mode === 'battle' ? '對戰' : '練習'}成績：答對 ${correct}/${total} 題
各科表現：${statText}

答錯的題目（前8題）：
${wrongSummary || '（全部答對！）'}

請用以下格式給出**個人化學習建議**：

**📊 本次表現總評**
（2句話評價整體表現，語氣鼓勵但誠實）

**💪 強項科目**
（說明哪些科目表現好，為什麼）

**⚠️ 需要加強**
（列出最需要複習的1-3個科目，具體說明弱點）

**📝 錯題分析**
（針對答錯的題目，找出共同的錯誤模式或知識盲點）

**🗓️ 建議複習計畫**
（給3個具體可執行的複習建議）`;

    // 2026-05-25 改：原本走 streamAnthropic，但 Anthropic credit 已耗盡會回
    // 400 「credit balance too low」。改走 streamVertexGemini 跟 /explain 同源。
    await streamVertexGemini(res, prompt, 800);
  });

  // POST /daily-message (cached per day+level)
  //
  // ⚠️ 2026-05-27 bug 修正：name 不再帶進 prompt。
  // 之前 cacheKey 只用 (today|level) 但 prompt 含 ${name} → 第一個請求者的
  // 名字被焊進當日 cache，同等級其他使用者都看到那個名字（anita 案例）。
  // 改成完全通用語氣（用「你」），cache 安全，UX 也沒明顯差別。
  app.post('/daily-message', async (req, res) => {
    const { level = 1 } = req.body;

    const today = new Date().toLocaleDateString('zh-TW', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    });

    const cacheKey = `${today}|${level}`;

    // Return cached message if available
    if (dailyMsgCache.has(cacheKey)) {
      sseHeaders(res);
      const cached = dailyMsgCache.get(cacheKey);
      const chunks = cached.match(/.{1,40}/gs) || [cached];
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Clear old cache entries (different date)
    for (const key of dailyMsgCache.keys()) {
      if (!key.startsWith(today)) dailyMsgCache.delete(key);
    }

    sseHeaders(res);

    const prompt = `你是國考知識王的AI導師。今天是${today}。
請為正在備考醫師一階國考的醫學生（遊戲等級 Lv.${level}）寫一段今日寄語。

要求：
- 70字以內
- 用「你」稱呼讀者，不要編造或使用任何人名
- 語氣像過來人的前輩醫師：溫暖、真實、不說教
- 融入真實備考情感（疲憊、堅持、那個還沒放棄的自己）
- 可以用人體或醫學作隱喻，讓文字有質感
- 繁體中文，台灣語感，不要英文
- 直接輸出文字，不要任何格式標籤或前綴`;

    // Stream via Vertex Gemini; cache the full text for the rest of the day.
    // Grounding intentionally NOT enabled — 70-character 暖心小語 doesn't need
    // real-time news lookup, and Grounding with Google Search is billed
    // separately (~$35/1k requests, NOT covered by the GenAI App Builder
    // credit which only covers Vertex AI Search SKUs). At ~50 unique levels/day
    // that would have been ~$50/month for cosmetic value. Disabled 2026-05-24.
    await streamVertexGemini(res, prompt, 180, (fullText) => {
      if (fullText) dailyMsgCache.set(cacheKey, fullText);
    });
  });
}

module.exports = { registerRoutes };
