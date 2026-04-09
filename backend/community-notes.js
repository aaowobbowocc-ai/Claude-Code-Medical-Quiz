const fs = require('fs');
const path = require('path');

const NOTES_FILE = path.join(__dirname, 'community-notes.json');
const DISCORD_WEBHOOK = process.env.DISCORD_REPORT_WEBHOOK_URL;
const REPORT_THRESHOLD = 5;

function loadNotes() {
  try { return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf-8')); }
  catch { return {}; }
}

let notes = loadNotes(); // { "doctor1:anatomy": [note, ...], ... }

function saveNotes() {
  try { fs.writeFileSync(NOTES_FILE, JSON.stringify(notes), 'utf-8'); } catch {}
}

setInterval(saveNotes, 120_000);

async function notifyReportedNote(note) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: '🚩 社群筆記被檢舉 5 次',
          color: 0xff6600,
          fields: [
            { name: '作者', value: `${note.avatar} ${note.name}`, inline: true },
            { name: '標題', value: note.title, inline: true },
            { name: '內容', value: note.content.slice(0, 500) },
            { name: 'ID', value: `\`${note.id}\``, inline: true },
          ],
        }],
      }),
    });
  } catch {}
}

function registerRoutes(app) {
  // GET /community-notes?exam=doctor1&subject=anatomy
  app.get('/community-notes', (req, res) => {
    const { exam, subject } = req.query;
    if (!exam || !subject) return res.status(400).json({ error: 'exam and subject required' });
    const key = `${exam}:${subject}`;
    const list = (notes[key] || [])
      .filter(n => !n.deleted)
      .map(n => ({
        id: n.id,
        title: n.title,
        content: n.content,
        name: n.name,
        avatar: n.avatar,
        userId: n.userId,
        likes: n.likes.length,
        createdAt: n.createdAt,
      }))
      .sort((a, b) => b.likes - a.likes || new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ notes: list });
  });

  // POST /community-notes  body: { exam, subject, title, content, name, avatar, userId }
  app.post('/community-notes', (req, res) => {
    const { exam, subject, title, content, name, avatar, userId } = req.body;
    if (!exam || !subject || !title?.trim() || !content?.trim()) {
      return res.status(400).json({ error: 'exam, subject, title, content required' });
    }
    if (title.trim().length > 50) return res.status(400).json({ error: 'title too long (max 50)' });
    if (content.trim().length > 2000) return res.status(400).json({ error: 'content too long (max 2000)' });

    const key = `${exam}:${subject}`;
    if (!notes[key]) notes[key] = [];

    // Rate limit: max 5 notes per user per subject
    const userCount = notes[key].filter(n => n.userId === userId && !n.deleted).length;
    if (userCount >= 5) return res.status(429).json({ error: '每科最多 5 張社群筆記' });

    const note = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: title.trim().slice(0, 50),
      content: content.trim().slice(0, 2000),
      name: (name || '匿名').slice(0, 20),
      avatar: avatar || '👤',
      userId: userId || 'anon',
      likes: [],
      reported: 0,
      reportedBy: [],
      deleted: false,
      createdAt: new Date().toISOString(),
    };

    notes[key].push(note);
    saveNotes();
    res.json({
      ok: true,
      note: { id: note.id, title: note.title, content: note.content, name: note.name, avatar: note.avatar, userId: note.userId, likes: 0, createdAt: note.createdAt },
    });
  });

  // POST /community-notes/like  body: { exam, subject, noteId, userId }
  app.post('/community-notes/like', (req, res) => {
    const { exam, subject, noteId, userId } = req.body;
    if (!exam || !subject || !noteId || !userId) return res.status(400).json({ error: 'missing fields' });

    const key = `${exam}:${subject}`;
    const list = notes[key];
    if (!list) return res.status(404).json({ error: 'not found' });

    const note = list.find(n => n.id === noteId);
    if (!note || note.deleted) return res.status(404).json({ error: 'note not found' });

    const idx = note.likes.indexOf(userId);
    if (idx >= 0) { note.likes.splice(idx, 1); }
    else { note.likes.push(userId); }

    res.json({ ok: true, likes: note.likes.length, liked: idx < 0 });
  });

  // POST /community-notes/report  body: { exam, subject, noteId, userId }
  app.post('/community-notes/report', (req, res) => {
    const { exam, subject, noteId, userId } = req.body;
    if (!exam || !subject || !noteId) return res.status(400).json({ error: 'missing fields' });

    const key = `${exam}:${subject}`;
    const list = notes[key];
    if (!list) return res.status(404).json({ error: 'not found' });

    const note = list.find(n => n.id === noteId);
    if (!note || note.deleted) return res.status(404).json({ error: 'note not found' });

    if (!note.reportedBy) note.reportedBy = [];
    if (userId && note.reportedBy.includes(userId)) {
      return res.json({ ok: true, alreadyReported: true });
    }

    note.reported++;
    if (userId) note.reportedBy.push(userId);
    if (note.reported === REPORT_THRESHOLD) notifyReportedNote(note);

    res.json({ ok: true });
  });

  // POST /community-notes/delete  body: { exam, subject, noteId, userId }
  // Only author can delete their own note
  app.post('/community-notes/delete', (req, res) => {
    const { exam, subject, noteId, userId } = req.body;
    if (!exam || !subject || !noteId || !userId) return res.status(400).json({ error: 'missing fields' });

    const key = `${exam}:${subject}`;
    const list = notes[key];
    if (!list) return res.status(404).json({ error: 'not found' });

    const note = list.find(n => n.id === noteId);
    if (!note) return res.status(404).json({ error: 'note not found' });
    if (note.userId !== userId) return res.status(403).json({ error: 'not your note' });

    note.deleted = true;
    note.content = '';
    saveNotes();
    res.json({ ok: true });
  });
}

module.exports = { registerRoutes, saveNotes };
