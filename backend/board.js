const supabase = require('./supabase');

// 敏感詞列表（部分遮蔽匹配，不分大小寫）
const BLOCKED_WORDS = [
  // 髒話 / 侮辱
  '幹你', '操你', '靠北', '靠杯', '靠腰', '媽的', '他媽', '去死', '垃圾',
  '白癡', '智障', '廢物', '賤人', '婊子', '王八', '混蛋', '畜生', '狗娘',
  'fuck', 'shit', 'bitch', 'asshole', 'dick', 'pussy', 'nigger', 'cunt',
  // 色情
  '約砲', '做愛', '打砲', '口交', '肛交', '自慰', '色情', 'porn', 'sex',
  // 歧視 / 仇恨
  '支那', '台巴', '滾回',
  // 詐騙 / 廣告
  '加line', '加賴', '加我line', '代考', '代寫', '保過', '包過',
  // 政治敏感（避免爭議）
  '台獨', '統一',
];

function containsBadWords(text) {
  const lower = text.toLowerCase();
  return BLOCKED_WORDS.some(w => lower.includes(w.toLowerCase()));
}

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

    const cleanMsg = message.trim().slice(0, 500);
    const cleanName = name.trim().slice(0, 20);

    if (containsBadWords(cleanMsg) || containsBadWords(cleanName)) {
      return res.status(400).json({ error: '留言包含不當內容，請修改後再試' });
    }

    const entry = {
      name: cleanName,
      avatar: (avatar || '👨‍⚕️').slice(0, 4),
      message: cleanMsg,
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
