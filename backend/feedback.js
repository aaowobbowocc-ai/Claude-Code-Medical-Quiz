const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const FEEDBACK_FILE = path.join(__dirname, 'feedback.json');
const ADMIN_KEY = process.env.FEEDBACK_ADMIN_KEY || 'med-king-admin-2026';
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

let transporter = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
}

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

async function sendMail(entry) {
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: `醫學知識王 <${GMAIL_USER}>`,
      to: GMAIL_USER,
      subject: `[用戶回饋] ${entry.name} - ${entry.time.slice(0, 10)}`,
      text: `來自：${entry.name}\n時間：${entry.time}\n\n${entry.message}`,
    });
  } catch (e) {
    console.error('Mail send failed:', e.message);
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

    // Send email notification (non-blocking)
    sendMail(entry);

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
