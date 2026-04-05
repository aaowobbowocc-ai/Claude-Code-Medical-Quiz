const supabase = require('./supabase');

function getWeekKey() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function recordScore(name, correct, total, level) {
  const week = getWeekKey();

  // Try upsert: if (week, name) exists, increment; otherwise insert
  const { data: existing } = await supabase
    .from('leaderboard')
    .select('id, played, correct, total, score')
    .eq('week', week)
    .eq('name', name)
    .single();

  if (existing) {
    await supabase.from('leaderboard').update({
      played: existing.played + 1,
      correct: existing.correct + correct,
      total: existing.total + total,
      score: existing.score + correct * 10,
      level: level !== undefined ? level : existing.level,
      updated_at: new Date().toISOString(),
    }).eq('id', existing.id);
  } else {
    await supabase.from('leaderboard').insert({
      week, name,
      played: 1,
      correct,
      total,
      score: correct * 10,
      level: level !== undefined ? level : null,
    });
  }
}

function registerRoutes(app) {
  app.get('/leaderboard', async (req, res) => {
    const week = req.query.week || getWeekKey();

    const { data } = await supabase
      .from('leaderboard')
      .select('name, played, correct, total, score, level')
      .eq('week', week)
      .order('score', { ascending: false })
      .limit(50);

    const players = (data || []).map(d => ({
      ...d,
      pct: d.total > 0 ? Math.round((d.correct / d.total) * 100) : 0,
    }));

    // Get available weeks
    const { data: weeks } = await supabase
      .from('leaderboard')
      .select('week')
      .order('week', { ascending: false });

    const availableWeeks = [...new Set((weeks || []).map(w => w.week))];

    res.set('Cache-Control', 'public, max-age=60');
    res.json({ week, players, availableWeeks });
  });

  app.post('/leaderboard/submit', require('express').json(), async (req, res) => {
    const { name, correct, total, level } = req.body;
    if (!name || typeof correct !== 'number' || typeof total !== 'number') {
      return res.status(400).json({ error: 'invalid' });
    }
    await recordScore(name.slice(0, 20), correct, total, typeof level === 'number' ? level : undefined);
    res.json({ ok: true });
  });
}

module.exports = { recordScore, getWeekKey, registerRoutes };
