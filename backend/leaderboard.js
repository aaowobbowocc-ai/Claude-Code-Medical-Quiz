const fs = require('fs');
const path = require('path');

const LB_FILE = path.join(__dirname, 'leaderboard.json');

function loadLeaderboard() {
  try { return JSON.parse(fs.readFileSync(LB_FILE, 'utf-8')); } catch { return {}; }
}

function saveLeaderboard(lb) {
  try { fs.writeFileSync(LB_FILE, JSON.stringify(lb), 'utf-8'); } catch {}
}

function getWeekKey() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function recordScore(name, correct, total, level) {
  const lb = loadLeaderboard();
  const week = getWeekKey();
  if (!lb[week]) lb[week] = {};
  if (!lb[week][name]) lb[week][name] = { played: 0, correct: 0, total: 0, score: 0 };
  const entry = lb[week][name];
  entry.played += 1;
  entry.correct += correct;
  entry.total += total;
  entry.score += correct * 10;
  if (level !== undefined) entry.level = level;
  const weeks = Object.keys(lb).sort();
  while (weeks.length > 4) { delete lb[weeks.shift()]; }
  saveLeaderboard(lb);
}

function registerRoutes(app) {
  app.get('/leaderboard', (req, res) => {
    const lb = loadLeaderboard();
    const week = req.query.week || getWeekKey();
    const data = lb[week] || {};
    const ranked = Object.entries(data)
      .map(([name, d]) => ({
        name, ...d,
        pct: d.total > 0 ? Math.round((d.correct / d.total) * 100) : 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ week, players: ranked, availableWeeks: Object.keys(lb).sort().reverse() });
  });

  app.post('/leaderboard/submit', require('express').json(), (req, res) => {
    const { name, correct, total, level } = req.body;
    if (!name || typeof correct !== 'number' || typeof total !== 'number') {
      return res.status(400).json({ error: 'invalid' });
    }
    recordScore(name.slice(0, 20), correct, total, typeof level === 'number' ? level : undefined);
    res.json({ ok: true });
  });
}

module.exports = { recordScore, getWeekKey, registerRoutes };
