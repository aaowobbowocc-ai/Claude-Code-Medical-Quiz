const supabase = require('./supabase');

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

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

function registerRoutes(app) {
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
