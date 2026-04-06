const supabase = require('./supabase');

function registerRoutes(app) {
  // GET /board — list messages (latest 100)
  app.get('/board', async (req, res) => {
    if (!supabase) return res.json([]);
    const { data } = await supabase
      .from('board')
      .select('id, name, avatar, message, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    res.set('Cache-Control', 'public, max-age=15');
    res.json(data || []);
  });

  // POST /board — post a message
  app.post('/board', async (req, res) => {
    const { name, avatar, message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const entry = {
      name: name.trim().slice(0, 20),
      avatar: (avatar || '👨‍⚕️').slice(0, 4),
      message: message.trim().slice(0, 500),
    };

    if (!supabase) return res.status(503).json({ error: 'database unavailable' });

    const { data, error } = await supabase
      .from('board')
      .insert(entry)
      .select('id, name, avatar, message, created_at')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // DELETE /board/:id — admin delete
  app.delete('/board/:id', async (req, res) => {
    const ADMIN_KEY = process.env.FEEDBACK_ADMIN_KEY || 'med-king-admin-2026';
    if (req.query.key !== ADMIN_KEY) {
      return res.status(403).json({ error: 'unauthorized' });
    }
    if (!supabase) return res.json({ ok: true });
    await supabase.from('board').delete().eq('id', req.params.id);
    res.json({ ok: true });
  });
}

module.exports = { registerRoutes };
