const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const aiUsage = { date: '', count: 0 };
const AI_DAILY_LIMIT = 100;

// daily-message cache: key = "date|level", value = message text
const dailyMsgCache = new Map();

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

async function streamAnthropic(res, prompt, maxTokens = 600) {
  try {
    const stream = await anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
}

function registerRoutes(app, questionsData, stats) {
  // POST /explain
  app.post('/explain', async (req, res) => {
    const { question, options, answer, subject_name, user_answer, question_id } = req.body;
    if (!question || !options || !answer) return res.status(400).json({ error: 'missing fields' });

    // Try local pre-generated explanation first (no API cost)
    if (question_id) {
      const local = questionsData.questions.find(q => String(q.id) === String(question_id));
      if (local?.explanation) {
        sseHeaders(res);
        const chunks = local.explanation.match(/.{1,40}/gs) || [local.explanation];
        for (const chunk of chunks) {
          res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    }

    if (!checkAILimit(stats)) {
      return res.status(429).json({ error: 'daily_limit', message: '今日 AI 解說次數已達上限，明天再來喔！' });
    }

    sseHeaders(res);
    const optionText = Object.entries(options).map(([k,v]) => `${k}. ${v}`).join('\n');
    const wrongNote = user_answer && user_answer !== answer
      ? `考生選了 ${user_answer}，但正確答案是 ${answer}。` : '';

    const prompt = `你是一位臺灣醫師國考（一階）的解題老師，用繁體中文回答。

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

    await streamAnthropic(res, prompt, 600);
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

    const prompt = `你是醫學知識王的AI導師。今天是${today}。
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
