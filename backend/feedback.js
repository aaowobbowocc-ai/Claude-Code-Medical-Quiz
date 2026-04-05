const fs = require('fs');
const path = require('path');

const FEEDBACK_FILE = path.join(__dirname, 'feedback.json');
const ADMIN_KEY = process.env.FEEDBACK_ADMIN_KEY || 'med-king-admin-2026';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

function loadFeedback() {
  try {
    return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveFeedback(data) {
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

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
            { name: '時間', value: entry.time.slice(0, 19).replace('T', ' '), inline: true },
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
      id: Date.now(),
      message: message.trim().slice(0, 2000),
      name: (name || '匿名').slice(0, 30),
      time: new Date().toISOString(),
    };

    const feedbacks = loadFeedback();
    feedbacks.push(entry);
    saveFeedback(feedbacks);

    // Send Discord notification (non-blocking)
    sendDiscord(entry);

    res.json({ ok: true });
  });

  // GET /feedback?key=xxx — admin views feedback
  app.get('/feedback', (req, res) => {
    if (req.query.key !== ADMIN_KEY) {
      return res.status(403).json({ error: 'unauthorized' });
    }
    res.json(loadFeedback());
  });
}

module.exports = { registerRoutes };
