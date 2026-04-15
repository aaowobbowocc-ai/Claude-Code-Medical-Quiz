// Weekly leaderboard with per-exam category filtering (Plan D.5).
//
// Row granularity stays (week, name) — one row per player per week. The
// `exam_id` column tracks the LAST exam that player submitted a score for
// that week, which drives:
//   - /leaderboard?category=X  → filter rows whose exam_id maps to category X
//   - 主修 badge next to player name (exam_id → category → icon)
//   - PR-vs-score display split for quota-based exams (civil-service)
//
// Legacy rows (pre-004 migration) have NULL exam_id; they're returned in the
// unfiltered view and excluded from category-specific queries.

const supabase = require('./supabase');

let examIdToCategory = {};        // examId -> 'medical' | 'civil-service' | ...
let examIdToSelectionType = {};   // examId -> 'license' | 'quota'

function configureExams(examConfigs) {
  examIdToCategory = {};
  examIdToSelectionType = {};
  for (const [id, cfg] of Object.entries(examConfigs || {})) {
    examIdToCategory[id] = cfg.category || 'medical';
    examIdToSelectionType[id] = cfg.selectionType || 'license';
  }
}

function getWeekKey() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function recordScore(name, correct, total, level, examId) {
  if (!supabase) return;
  const week = getWeekKey();

  const { data: existing } = await supabase
    .from('leaderboard')
    .select('id, played, correct, total, score')
    .eq('week', week)
    .eq('name', name)
    .single();

  if (existing) {
    const update = {
      played: existing.played + 1,
      correct: existing.correct + correct,
      total: existing.total + total,
      score: existing.score + correct * 10,
      level: level !== undefined ? level : existing.level,
      updated_at: new Date().toISOString(),
    };
    if (examId) update.exam_id = examId;
    await supabase.from('leaderboard').update(update).eq('id', existing.id);
  } else {
    await supabase.from('leaderboard').insert({
      week, name,
      played: 1,
      correct,
      total,
      score: correct * 10,
      level: level !== undefined ? level : null,
      exam_id: examId || null,
    });
  }
}

function registerRoutes(app) {
  app.get('/leaderboard', async (req, res) => {
    if (!supabase) return res.json({ week: getWeekKey(), players: [], availableWeeks: [], categoryCounts: {} });
    const week = req.query.week || getWeekKey();
    const category = req.query.category || 'all';   // all | medical | law-professional | civil-service | common-subjects

    const { data } = await supabase
      .from('leaderboard')
      .select('name, played, correct, total, score, level, exam_id')
      .eq('week', week)
      .order('score', { ascending: false })
      .limit(200);

    const raw = data || [];
    const enriched = raw.map(d => {
      const cat = d.exam_id ? (examIdToCategory[d.exam_id] || null) : null;
      const selection = d.exam_id ? (examIdToSelectionType[d.exam_id] || 'license') : 'license';
      return {
        name: d.name,
        played: d.played,
        correct: d.correct,
        total: d.total,
        score: d.score,
        level: d.level,
        pct: d.total > 0 ? Math.round((d.correct / d.total) * 100) : 0,
        examId: d.exam_id || null,
        category: cat,
        selectionType: selection,
      };
    });

    // Category count summary (drives the filter chips badge)
    const categoryCounts = enriched.reduce((acc, p) => {
      const k = p.category || 'legacy';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    categoryCounts.all = enriched.length;

    let players = enriched;
    if (category !== 'all') {
      players = enriched.filter(p => p.category === category);
    }
    players = players.slice(0, 50);

    // PR percentile — only meaningful within a category, and only surfaced for
    // quota exams (license exams keep absolute scores). Computed on the filtered
    // list so rank reflects the user's cohort, not the global mix.
    const total = players.length;
    players = players.map((p, idx) => ({
      ...p,
      rank: idx + 1,
      pr: total > 1 ? Math.round(((total - idx - 1) / (total - 1)) * 100) : 100,
    }));

    const { data: weeks } = await supabase
      .from('leaderboard')
      .select('week')
      .order('week', { ascending: false });
    const availableWeeks = [...new Set((weeks || []).map(w => w.week))];

    res.set('Cache-Control', 'public, max-age=60');
    res.json({ week, category, players, availableWeeks, categoryCounts });
  });

  app.post('/leaderboard/submit', require('express').json(), async (req, res) => {
    const { name, correct, total, level, examId } = req.body;
    if (!name || typeof correct !== 'number' || typeof total !== 'number') {
      return res.status(400).json({ error: 'invalid' });
    }
    await recordScore(
      name.slice(0, 20),
      correct,
      total,
      typeof level === 'number' ? level : undefined,
      typeof examId === 'string' ? examId.slice(0, 40) : undefined,
    );
    res.json({ ok: true });
  });
}

module.exports = { recordScore, getWeekKey, registerRoutes, configureExams };
