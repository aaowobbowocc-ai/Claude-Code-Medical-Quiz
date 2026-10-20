const supabase = require('./supabase');

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_REPORT_WEBHOOK = process.env.DISCORD_REPORT_WEBHOOK_URL;

async function sendDiscord(entry) {
  // entry: { message, name, user_id? }
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: '📩 新用戶回饋',
          color: 0x3b82f6,
          fields: [
            { name: '來自', value: entry.name, inline: true },
            { name: '時間', value: new Date().toISOString().slice(0, 19).replace('T', ' '), inline: true },
            ...(entry.user_id ? [{ name: 'user_id', value: '`' + entry.user_id + '`' }] : []),
            { name: '內容', value: entry.message.slice(0, 1024) },
          ],
        }],
      }),
    });
  } catch (e) {
    console.error('Discord notify failed:', e.message);
  }
}

async function sendReportDiscord(entry) {
  if (!DISCORD_REPORT_WEBHOOK) return;
  try {
    // 「定位字串」— 讓我能直接從 Discord 訊息找到題目的單行格式。
    // 例：「醫師一階 110年第一次 醫學(一) 第15題」
    const locator = [
      entry.examName || '',
      entry.rocYear ? `${entry.rocYear}年${entry.session || ''}` : '',
      entry.subject || '',
      entry.number ? `第${entry.number}題` : '',
    ].filter(Boolean).join(' ') || '未知';

    const fields = [
      { name: '來自', value: entry.name || '匿名', inline: true },
      { name: '時間', value: new Date().toISOString().slice(0, 19).replace('T', ' '), inline: true },
      { name: '定位', value: locator },
      { name: '題目 ID', value: entry.questionId || '未知', inline: true },
      ...(entry.user_id ? [{ name: 'user_id', value: '`' + entry.user_id + '`', inline: true }] : []),
    ];
    if (entry.questionText) {
      fields.push({ name: '題目內容', value: entry.questionText.slice(0, 200) });
    }
    if (entry.message) {
      fields.push({ name: '使用者描述', value: entry.message.slice(0, 1024) });
    }
    await fetch(DISCORD_REPORT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: '⚠️ 題目錯誤回報',
          color: 0xef4444,
          fields,
        }],
      }),
    });
  } catch (e) {
    console.error('Discord report notify failed:', e.message);
  }
}

// Look up a question by id across all loaded exams. Returns
// { examId, examName, question } or null.
//
// Question ids vary by source:
// - Exam own questions: "{exam_code}_{paper}_{number}" (e.g., "111100_1_17")
// - Shared bank questions: "{bankId}-{year}-{examCode}-{number}" (e.g., "common_constitution-114-civil-senior-1")
//
// When a `questionText` hint is supplied, prefer the exam whose question content
// matches; otherwise return the first match.
//
// If exact ID lookup fails, falls back to rocYear + number (useful when ID format
// is corrupted or mismatched).
/** 題幹正規化後的前 40 字——比 id 精確得多，用來驗證 id 找到的是不是同一題。 */
const stemKey = t => String(t || '').replace(/\s+/g, '').slice(0, 40);

/** 在所有考試裡用題幹找。找到唯一一題才回傳。 */
function findByStem(examData, examConfigs, questionText) {
  const want = stemKey(questionText);
  if (want.length < 12) return null;
  const hits = [];
  for (const [examId, data] of Object.entries(examData)) {
    for (const q of data.questions || []) {
      if (stemKey(q.question) === want) {
        hits.push({ examId, examName: examConfigs?.[examId]?.name || examId, question: q });
        if (hits.length > 1) return null;   // 不唯一就不猜
      }
    }
  }
  return hits[0] || null;
}

/**
 * ⚠️ id 有兩種形式。server.js 載入時會把每題的 id 改寫成 `<原id>_<paper.id>`，
 * 但前端是從 CDN 拿**原始 JSON**，使用者回報時送回來的是改寫前的 id。
 * 所以比對一定要兩種都認，否則會靜默退回「年份＋題號」比對、抓到同年同題號的
 * 第一卷，Discord 的定位就標成別的科目（2026-10-19 查出近期 5 筆裡錯 3 筆）。
 */
const sameQid = (q, qid) =>
  String(q.id) === String(qid) || (q._rawId != null && String(q._rawId) === String(qid));

function locateQuestion(examData, examConfigs, questionId, questionText, rocYear, number, preferredExamId) {
  if (!examData || !questionId) return null;

  // Round 0: client told us which exam — trust it. Scopes the lookup to that
  // exam so cross-exam id collisions (same id in many exams) resolve correctly.
  if (preferredExamId && examData[preferredExamId]?.questions) {
    const examName = examConfigs?.[preferredExamId]?.name || preferredExamId;
    const list = examData[preferredExamId].questions;
    const byId = list.find(x => sameQid(x, questionId));
    // ⚠️ id 命中還不夠，要跟題幹對得上才算數。937 筆歷史報錯裡有 146 筆
    //    id 與題幹指向不同題（跨考試場次碼相同、純數字 id 撞號、題庫重建後位移），
    //    只信 id 會把報錯掛到別題上。題幹比 id 精確得多，矛盾時以題幹為準。
    if (byId && (!questionText || stemKey(byId.question) === stemKey(questionText))) {
      return { examId: preferredExamId, examName, question: byId };
    }
    const byStem0 = findByStem(examData, examConfigs, questionText);
    if (byStem0) return byStem0;
    if (byId) return { examId: preferredExamId, examName, question: byId };
    if (rocYear && number) {
      const byYr = list.find(x => String(x.roc_year) === String(rocYear) &&
        (x.number == number || Number(x.number) === Number(number)));
      if (byYr) return { examId: preferredExamId, examName, question: byYr };
    }
    // exam known but question not found in it → still return name-only so the
    // Discord locator carries the exam; question enrichment falls through null.
    return { examId: preferredExamId, examName, question: null };
  }

  const matches = [];

  // Round 1: Try exact ID match
  for (const [examId, data] of Object.entries(examData)) {
    const q = data.questions?.find(x => sameQid(x, questionId));
    if (q) matches.push({ examId, examName: examConfigs?.[examId]?.name || examId, question: q });
  }

  // If exact match found, use it
  if (matches.length > 0) {
    if (questionText) {
      const want = stemKey(questionText);
      const exact = matches.find(m => stemKey(m.question.question) === want);
      if (exact) return exact;
      const hint = String(questionText).slice(0, 30);
      const preferred = matches.find(m => m.question.question && m.question.question.startsWith(hint));
      if (preferred) return preferred;
      // id 命中但沒有一題的題幹對得上 → 全站用題幹再找一次
      const byStem = findByStem(examData, examConfigs, questionText);
      if (byStem) return byStem;
    }
    return matches[0];
  }

  // Round 1.5：id 完全找不到時，先用題幹找，再退到年份+題號。
  // 題幹唯一命中比「同年同題號的第一卷」可靠得多。
  const byStemOnly = findByStem(examData, examConfigs, questionText);
  if (byStemOnly) return byStemOnly;

  // Round 2: Fallback to rocYear + number if ID lookup failed
  // (e.g. ID format corrupted, frontend race-condition where questionId was "未知")
  if (rocYear && number) {
    const fallbackMatches = [];
    for (const [examId, data] of Object.entries(examData)) {
      const q = data.questions?.find(x =>
        String(x.roc_year) === String(rocYear) &&
        (x.number == number || Number(x.number) === Number(number))
      );
      if (q) {
        fallbackMatches.push({ examId, examName: examConfigs?.[examId]?.name || examId, question: q });
      }
    }

    if (fallbackMatches.length > 0) {
      // Single match — safe to return
      if (fallbackMatches.length === 1) {
        console.warn(`[locateQuestion] ID lookup failed (${questionId}), fell back to rocYear+number: ${rocYear}年第${number}題 → ${fallbackMatches[0].examId}`);
        return fallbackMatches[0];
      }
      // Multiple matches — require text disambiguation. Score by longest-prefix
      // overlap; require minimum overlap to accept (avoid arbitrary-first picks
      // that produce wrong-exam labels in Discord reports).
      if (questionText && String(questionText).length >= 10) {
        const norm = s => String(s || '').replace(/\s+/g, '').slice(0, 60);
        const userText = norm(questionText);
        let best = null, bestScore = 0;
        for (const m of fallbackMatches) {
          const candText = norm(m.question.question);
          let i = 0;
          while (i < userText.length && i < candText.length && userText[i] === candText[i]) i++;
          if (i > bestScore) { bestScore = i; best = m; }
        }
        // Require ≥ 8 chars of common prefix to accept disambiguation
        if (best && bestScore >= 8) {
          console.warn(`[locateQuestion] ID lookup failed (${questionId}), text-disambiguated to ${best.examId} (${bestScore} char prefix match)`);
          return best;
        }
      }
      // Ambiguous — refuse to guess. Better to log "unknown" than to mislabel.
      console.warn(`[locateQuestion] AMBIGUOUS: ID=${questionId} matched ${fallbackMatches.length} exams by rocYear+number, none disambiguated by text. exams: ${fallbackMatches.map(m=>m.examId).join(',')}`);
      return null;
    }
  }

  // Round 3: Last-resort question-text full search. Useful when both id and
  // rocYear/number are missing (e.g. old cached frontend, race condition where
  // user clicked report before q hydrated). Slower (full scan), but only fires
  // for the genuinely-broken submissions that already failed two rounds.
  if (questionText && String(questionText).length >= 12) {
    const hint = String(questionText).slice(0, 30);
    for (const [examId, data] of Object.entries(examData)) {
      const q = data.questions?.find(x => x.question && x.question.startsWith(hint));
      if (q) {
        console.warn(`[locateQuestion] ID + year/num lookup both failed (${questionId}), recovered via question-text: ${examId} ${q.roc_year}年第${q.number}題`);
        return { examId, examName: examConfigs?.[examId]?.name || examId, question: q };
      }
    }
  }

  return null;
}

function registerRoutes(app, examData, examConfigs) {
  // POST /feedback — user submits feedback
  app.post('/feedback', async (req, res) => {
    const { message, name, user_id: bodyUserId } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    // user_id 雙來源 (取任一有效)：
    //   1. body.user_id (frontend 從 zustand 帶)
    //   2. Authorization Bearer token (server 解析)
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let cleanUserId = (typeof bodyUserId === 'string' && UUID_RE.test(bodyUserId)) ? bodyUserId : null;
    if (!cleanUserId) {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token && supabase) {
        try {
          const { data: { user } } = await supabase.auth.getUser(token);
          if (user?.id) cleanUserId = user.id;
        } catch {}
      }
    }

    const entry = {
      message: message.trim().slice(0, 2000),
      name: (name || '匿名').slice(0, 30),
      user_id: cleanUserId,
    };

    if (supabase) {
      const { error } = await supabase.from('feedback').insert(entry);
      if (error) {
        // schema may lack user_id column — retry without it (so insert still succeeds)
        if (/user_id/i.test(error.message || '')) {
          await supabase.from('feedback').insert({ message: entry.message, name: entry.name });
        }
      }
    }

    // Send Discord notification (non-blocking)
    sendDiscord(entry);

    res.json({ ok: true });
  });

  // POST /report — user reports a question error
  app.post('/report', async (req, res) => {
    const { questionId, questionText, examId: bodyExamId, rocYear, session, number, message, name, user_id: bodyUserId } = req.body;
    if (!questionId) {
      return res.status(400).json({ error: 'questionId is required' });
    }

    // user_id 雙來源（取任一有效）
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let cleanUserId = (typeof bodyUserId === 'string' && UUID_RE.test(bodyUserId)) ? bodyUserId : null;
    let uidSource = cleanUserId ? 'body' : null;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!cleanUserId) {
      if (token && supabase) {
        try {
          const { data: { user } } = await supabase.auth.getUser(token);
          if (user?.id) { cleanUserId = user.id; uidSource = 'token'; }
          else uidSource = 'token-no-user';
        } catch (e) { uidSource = 'token-fail:' + (e.message || '').slice(0,30); }
      } else {
        uidSource = token ? 'no-supabase' : 'no-body-no-token';
      }
    }
    console.log(`[report] uid=${cleanUserId ? cleanUserId.slice(0,8) : 'NULL'} src=${uidSource} bodyUid=${bodyUserId ? String(bodyUserId).slice(0,8) : 'unset'} authHdr=${token ? 'set('+token.length+'chars)' : 'unset'} qid=${questionId} name=${name||'匿名'}`);

    // Server-side enrichment: trust the question DB, not the client. The
    // client only knows what's currently rendered; here we look up the real
    // exam/paper/year/number so the Discord report always has a precise
    // locator like 「醫師一階 110年第一次 醫學(一) 第15題」.
    // If exact ID lookup fails, falls back to rocYear + number matching.
    const found = locateQuestion(examData, examConfigs, questionId, questionText, rocYear, number, bodyExamId);
    const q = found?.question;
    // Exam name precedence: located exam → client-supplied examId (authoritative,
    // the user IS taking that exam) → raw id. The client hint fixes cross-exam id
    // collisions (e.g. 113100_3_12 exists in many exams) where pure id/text lookup
    // can't disambiguate. Reported 2026-06-25.
    const clientExamName = bodyExamId && examConfigs?.[bodyExamId]?.name;
    const entry = {
      questionId,
      questionText: (questionText || q?.question || '').slice(0, 300),
      examName: found?.examName || clientExamName || bodyExamId || '',
      subject: q?.subject_name || q?.subject || '',
      rocYear: q?.roc_year || rocYear || '',
      session: q?.session || session || '',
      number: q?.number || number || '',
      message: (message || '').slice(0, 500),
      name: (name || '').slice(0, 30),
      user_id: cleanUserId,
    };

    if (supabase) {
      try {
        const row = {
          question_id: entry.questionId,
          question_text: entry.questionText,
          roc_year: entry.rocYear,
          session: entry.session,
          number: String(entry.number),
          message: entry.message,
          name: entry.name,
          user_id: entry.user_id,
        };
        const { error } = await supabase.from('reports').insert(row);
        if (error && /user_id/i.test(error.message || '')) {
          // schema 還沒有 user_id 欄 — fallback
          delete row.user_id;
          await supabase.from('reports').insert(row);
        }
      } catch (e) {
        console.error('reports insert failed:', e.message);
      }
    }

    // Send to Discord report channel (non-blocking)
    sendReportDiscord(entry);

    res.json({ ok: true });
  });

  // GET /reports?key=xxx — admin views question reports
  app.get('/reports', async (req, res) => {
    const ADMIN_KEY = process.env.FEEDBACK_ADMIN_KEY;
    // Refuse to authorize if no key is configured server-side. The previous
    // hardcoded fallback ('med-king-admin-2026') was publicly readable in
    // GitHub so anyone could query reports/feedback with that string.
    if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
      return res.status(403).json({ error: 'unauthorized' });
    }
    if (!supabase) return res.json([]);
    const { data } = await supabase
      .from('reports')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    res.json(data || []);
  });

  // GET /feedback?key=xxx — admin views feedback
  app.get('/feedback', async (req, res) => {
    const ADMIN_KEY = process.env.FEEDBACK_ADMIN_KEY;
    // Refuse to authorize if no key is configured server-side. The previous
    // hardcoded fallback ('med-king-admin-2026') was publicly readable in
    // GitHub so anyone could query reports/feedback with that string.
    if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
      return res.status(403).json({ error: 'unauthorized' });
    }
    if (!supabase) return res.json([]);
    const { data } = await supabase
      .from('feedback')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    res.json(data || []);
  });
}

module.exports = { registerRoutes };
