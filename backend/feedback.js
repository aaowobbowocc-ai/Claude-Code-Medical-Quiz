const supabase = require('./supabase');

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_REPORT_WEBHOOK = process.env.DISCORD_REPORT_WEBHOOK_URL;

async function sendDiscord(entry) {
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
// { examId, examName, question } or null. Question id is unique within an
// exam file but not globally — we scan every exam.
function locateQuestion(examData, examConfigs, questionId) {
  if (!examData || !questionId) return null;
  for (const [examId, data] of Object.entries(examData)) {
    const q = data.questions?.find(x => String(x.id) === String(questionId));
    if (q) {
      const examName = examConfigs?.[examId]?.name || examId;
      return { examId, examName, question: q };
    }
  }
  return null;
}

function registerRoutes(app, examData, examConfigs) {
  // POST /feedback — user submits feedback
  app.post('/feedback', async (req, res) => {
    const { message, name } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const entry = {
      message: message.trim().slice(0, 2000),
      name: (name || '匿名').slice(0, 30),
    };

    if (supabase) await supabase.from('feedback').insert(entry);

    // Send Discord notification (non-blocking)
    sendDiscord(entry);

    res.json({ ok: true });
  });

  // POST /report — user reports a question error
  app.post('/report', async (req, res) => {
    const { questionId, questionText, rocYear, session, number, message, name } = req.body;
    if (!questionId) {
      return res.status(400).json({ error: 'questionId is required' });
    }

    // Server-side enrichment: trust the question DB, not the client. The
    // client only knows what's currently rendered; here we look up the real
    // exam/paper/year/number so the Discord report always has a precise
    // locator like 「醫師一階 110年第一次 醫學(一) 第15題」.
    const found = locateQuestion(examData, examConfigs, questionId);
    const q = found?.question;
    const entry = {
      questionId,
      questionText: (questionText || q?.question || '').slice(0, 300),
      examName: found?.examName || '',
      subject: q?.subject_name || q?.subject || '',
      rocYear: q?.roc_year || rocYear || '',
      session: q?.session || session || '',
      number: q?.number || number || '',
      message: (message || '').slice(0, 500),
      name: (name || '').slice(0, 30),
    };

    if (supabase) {
      try {
        await supabase.from('reports').insert({
          question_id: entry.questionId,
          question_text: entry.questionText,
          roc_year: entry.rocYear,
          session: entry.session,
          number: String(entry.number),
          message: entry.message,
          name: entry.name,
        });
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
    const ADMIN_KEY = process.env.FEEDBACK_ADMIN_KEY || 'med-king-admin-2026';
    if (req.query.key !== ADMIN_KEY) {
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
    const ADMIN_KEY = process.env.FEEDBACK_ADMIN_KEY || 'med-king-admin-2026';
    if (req.query.key !== ADMIN_KEY) {
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
