const fs = require('fs');
const path = require('path');

const COMMENTS_FILE = path.join(__dirname, 'comments.json');
const DISCORD_WEBHOOK = process.env.DISCORD_REPORT_WEBHOOK_URL;
const REPORT_THRESHOLD = 5;

function loadComments() {
  try {
    return JSON.parse(fs.readFileSync(COMMENTS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

let comments = loadComments();

function saveComments() {
  try {
    fs.writeFileSync(COMMENTS_FILE, JSON.stringify(comments), 'utf-8');
  } catch {}
}

setInterval(saveComments, 120_000);

async function notifyReportedComment(target, comment) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: '🚩 留言被檢舉 5 次',
          color: 0xff6600,
          fields: [
            { name: '留言者', value: `${comment.avatar} ${comment.name}`, inline: true },
            { name: '檢舉次數', value: `${comment.reported}`, inline: true },
            { name: '位置', value: target, inline: true },
            { name: '留言內容', value: comment.text.slice(0, 500) },
            { name: '留言 ID', value: `\`${comment.id}\``, inline: true },
            { name: '發表時間', value: comment.createdAt.slice(0, 19).replace('T', ' '), inline: true },
          ],
          footer: { text: '回覆 DELETE commentId 來刪除此留言' },
        }],
      }),
    });
  } catch (e) {
    console.error('Discord comment report failed:', e.message);
  }
}

function registerRoutes(app) {
  // GET /comments?target=questionId_or_noteId
  app.get('/comments', (req, res) => {
    const { target } = req.query;
    if (!target) return res.status(400).json({ error: 'target required' });
    const list = (comments[target] || [])
      .map(c => ({
        id: c.id,
        name: c.name,
        avatar: c.avatar,
        text: c.deleted ? null : c.text,
        deleted: !!c.deleted,
        likes: c.likes.length,
        createdAt: c.createdAt,
      }))
      .sort((a, b) => b.likes - a.likes || new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ comments: list });
  });

  // POST /comments  body: { target, name, avatar, text, userId }
  app.post('/comments', (req, res) => {
    const { target, name, avatar, text, userId } = req.body;
    if (!target || !text?.trim()) return res.status(400).json({ error: 'target and text required' });
    if (text.trim().length > 500) return res.status(400).json({ error: 'text too long (max 500)' });

    if (!comments[target]) comments[target] = [];

    const comment = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: (name || '匿名').slice(0, 20),
      avatar: avatar || '👤',
      text: text.trim().slice(0, 500),
      userId: userId || 'anon',
      likes: [],
      reported: 0,
      reportedBy: [],
      deleted: false,
      createdAt: new Date().toISOString(),
    };

    comments[target].push(comment);

    if (comments[target].length > 100) {
      comments[target] = comments[target].slice(-100);
    }

    saveComments();
    res.json({ ok: true, comment: { id: comment.id, name: comment.name, avatar: comment.avatar, text: comment.text, likes: 0, createdAt: comment.createdAt } });
  });

  // POST /comments/like  body: { target, commentId, userId }
  app.post('/comments/like', (req, res) => {
    const { target, commentId, userId } = req.body;
    if (!target || !commentId || !userId) return res.status(400).json({ error: 'missing fields' });

    const list = comments[target];
    if (!list) return res.status(404).json({ error: 'not found' });

    const comment = list.find(c => c.id === commentId);
    if (!comment || comment.deleted) return res.status(404).json({ error: 'comment not found' });

    const idx = comment.likes.indexOf(userId);
    if (idx >= 0) {
      comment.likes.splice(idx, 1);
    } else {
      comment.likes.push(userId);
    }

    res.json({ ok: true, likes: comment.likes.length, liked: idx < 0 });
  });

  // POST /comments/report  body: { target, commentId, userId }
  app.post('/comments/report', (req, res) => {
    const { target, commentId, userId } = req.body;
    if (!target || !commentId) return res.status(400).json({ error: 'missing fields' });

    const list = comments[target];
    if (!list) return res.status(404).json({ error: 'not found' });

    const comment = list.find(c => c.id === commentId);
    if (!comment || comment.deleted) return res.status(404).json({ error: 'comment not found' });

    // Prevent duplicate reports from same user
    if (!comment.reportedBy) comment.reportedBy = [];
    if (userId && comment.reportedBy.includes(userId)) {
      return res.json({ ok: true, alreadyReported: true });
    }

    comment.reported++;
    if (userId) comment.reportedBy.push(userId);

    // Notify on Discord when threshold reached
    if (comment.reported === REPORT_THRESHOLD) {
      notifyReportedComment(target, comment);
    }

    res.json({ ok: true });
  });

  // DELETE /comments/admin  body: { commentId, secret }
  // For admin to delete reported comments
  app.post('/comments/admin/delete', (req, res) => {
    const { commentId, secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });

    for (const target of Object.keys(comments)) {
      const comment = comments[target].find(c => c.id === commentId);
      if (comment) {
        comment.deleted = true;
        comment.text = '';
        saveComments();
        return res.json({ ok: true, target, commentId });
      }
    }
    res.status(404).json({ error: 'comment not found' });
  });
}

module.exports = { registerRoutes, saveComments };
