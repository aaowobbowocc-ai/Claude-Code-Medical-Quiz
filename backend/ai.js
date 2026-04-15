const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('./supabase');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXPLAIN_MODEL = 'claude-haiku-4-5-20251001';

// Community-voting tiers for AI explanations (see migrations/002).
//   pending   — fresh gen, unverified → half price (reward early reviewers)
//   verified  — upvotes >= 3         → free (attracts readers, amortises cost)
//   retracted — downvotes crossed    → md cleared, next reader regenerates
const EXPLAIN_PRICE_FULL     = 150;
const EXPLAIN_PRICE_PENDING  = 75;
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
const AI_DAILY_LIMIT = 100;

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
  return true;
}

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

async function streamAnthropic(res, prompt, maxTokens = 600, onComplete) {
  let fullText = '';
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
    res.write('data: [DONE]\n\n');
    res.end();
    if (onComplete && fullText) onComplete(fullText);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
}

function registerRoutes(app, examData, stats) {
  // POST /explain
  app.post('/explain', async (req, res) => {
    const { question, options, answer, subject_name, user_answer, question_id, exam, shared_bank } = req.body;
    if (!question || !options || !answer) return res.status(400).json({ error: 'missing fields' });

    const questionsData = examData[exam] || examData.doctor1;

    // Tier 1: local pre-generated explanation (no API, no DB)
    if (question_id) {
      const local = questionsData.questions.find(q => String(q.id) === String(question_id));
      if (local?.explanation) {
        sseHeaders(res);
        streamCachedText(res, local.explanation);
        return;
      }
    }

    // Tier 2: Supabase cache (shared keys are reused cross-exam)
    const cacheKey = buildCacheKey({ shared_bank, exam, question_id });
    const cached = await getCachedExplanation(cacheKey);
    if (cached) {
      stats.aiExplains++; // count as a successful explain even though no API call
      sseHeaders(res);
      // Meta frame first so the frontend can render the verified/pending badge
      // and charge the correct price before the text starts flowing.
      res.write(`data: ${JSON.stringify({ meta: {
        cacheKey,
        status: cached.status,
        upvotes: cached.upvotes,
        downvotes: cached.downvotes,
        price: priceForStatus(cached.status),
      }})}\n\n`);
      streamCachedText(res, cached.md);
      return;
    }

    // Tier 3: Claude API
    if (!checkAILimit(stats)) {
      return res.status(429).json({ error: 'daily_limit', message: '今日 AI 解說次數已達上限，明天再來喔！' });
    }

    sseHeaders(res);
    // Fresh generation — always pending, full price
    res.write(`data: ${JSON.stringify({ meta: {
      cacheKey,
      status: 'pending',
      upvotes: 0,
      downvotes: 0,
      price: EXPLAIN_PRICE_FULL,
    }})}\n\n`);
    const optionText = Object.entries(options).map(([k,v]) => `${k}. ${v}`).join('\n');
    const wrongNote = user_answer && user_answer !== answer
      ? `考生選了 ${user_answer}，但正確答案是 ${answer}。` : '';

    const examMeta = examData[exam] || examData.doctor1;
    const examName = examMeta.metadata?.category || '醫師國考';
    const prompt = `你是一位臺灣${examName}的解題老師，用繁體中文回答。

科目：${subject_name}
題目：${question}

選項：
${optionText}

正確答案：${answer}
${wrongNote}

請用以下格式回答（每段都要有，簡潔扼要）：

**✅ 為什麼答案是 ${answer}**
（說明核心機制或概念，2-3句）

**❌ 排除其他選項**
（每個錯誤選項一句話說明為何不對）

**🧠 記憶關鍵字**
（給一個好記的口訣或記憶技巧）

**🏥 臨床應用**
（一句話說明這個知識點在臨床上的意義）`;

    await streamAnthropic(res, prompt, 600, (fullText) => {
      saveCachedExplanation(cacheKey, fullText, EXPLAIN_MODEL);
    });
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

    await streamAnthropic(res, prompt, 800);
  });

  // POST /daily-message (cached per day+level)
  app.post('/daily-message', async (req, res) => {
    const { name = '學員', level = 1 } = req.body;

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
請為正在備考醫師一階國考的醫學生「${name}」（遊戲等級 Lv.${level}）寫一段今日寄語。

要求：
- 70字以內
- 語氣像過來人的前輩醫師：溫暖、真實、不說教
- 融入真實備考情感（疲憊、堅持、那個還沒放棄的自己）
- 可以用人體或醫學作隱喻，讓文字有質感
- 繁體中文，台灣語感，不要英文
- 直接輸出文字，不要任何格式標籤或前綴`;

    // Stream and collect response for caching
    let fullText = '';
    try {
      const stream = await anthropic.messages.stream({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 180,
        messages: [{ role: 'user', content: prompt }],
      });
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
          fullText += chunk.delta.text;
          res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
        }
      }
      if (fullText) dailyMsgCache.set(cacheKey, fullText);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    }
  });
}

module.exports = { registerRoutes };
