const fs = require('fs');
const path = require('path');

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function registerRoutes(app, questionsData, stats) {
  // GET /questions
  app.get('/questions', (req, res) => {
    const { year, session, subject_tag, q, page = 1, limit = 20 } = req.query;
    let list = questionsData.questions;
    if (year)        list = list.filter(x => x.roc_year === year);
    if (session)     list = list.filter(x => x.session === session);
    if (subject_tag) list = list.filter(x => x.subject_tag === subject_tag);
    if (q)           list = list.filter(x => x.question.includes(q) || Object.values(x.options).some(o => o.includes(q)));
    const total = list.length;
    const start = (parseInt(page) - 1) * parseInt(limit);
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    res.json({ total, page: parseInt(page), limit: parseInt(limit), questions: list.slice(start, start + parseInt(limit)) });
  });

  // GET /questions/random
  app.get('/questions/random', (req, res) => {
    const { stage_id, count = 10 } = req.query;
    const tag = stage_id && parseInt(stage_id) > 0
      ? questionsData.stages.find(s => s.id === parseInt(stage_id))?.tag
      : null;
    let pool = questionsData.questions.filter(q => q.answer && q.options[q.answer]);
    if (tag) pool = pool.filter(q => q.subject_tag === tag);
    const picked = shuffle(pool).slice(0, parseInt(count));
    res.json({ total: pool.length, questions: picked });
  });

  // GET /questions/exam-years — list available historical exams
  app.get('/questions/exam-years', (req, res) => {
    const exams = {};
    for (const q of questionsData.questions) {
      if (!q.answer || !q.options[q.answer]) continue;
      const key = `${q.roc_year}_${q.session}`;
      if (!exams[key]) exams[key] = { roc_year: q.roc_year, session: q.session, papers: {} };
      if (!exams[key].papers[q.subject]) exams[key].papers[q.subject] = {};
      const tag = q.subject_tag;
      exams[key].papers[q.subject][tag] = (exams[key].papers[q.subject][tag] || 0) + 1;
    }
    const list = Object.values(exams)
      .map(e => ({
        roc_year: e.roc_year,
        session: e.session,
        label: `${e.roc_year}年${e.session}`,
        papers: Object.entries(e.papers).map(([name, dist]) => ({
          name,
          total: Object.values(dist).reduce((a, b) => a + b, 0),
          distribution: dist,
        })),
      }))
      .sort((a, b) => b.roc_year.localeCompare(a.roc_year) || b.session.localeCompare(a.session));
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(list);
  });

  // GET /questions/exam — supports historical (year+session) or random (stages) mode
  app.get('/questions/exam', (req, res) => {
    const { stages, count = 100, year, session, subject } = req.query;

    // Historical mode: return exact questions from a specific exam
    if (year && session && subject) {
      const pool = questionsData.questions.filter(q =>
        q.answer && q.options[q.answer] &&
        q.roc_year === year && q.session === session && q.subject === subject
      );
      // Return in original question number order
      pool.sort((a, b) => a.number - b.number);
      return res.json({ total: pool.length, questions: pool, mode: 'historical' });
    }

    // Random proportional mode
    if (!stages) return res.status(400).json({ error: 'stages required (or use year+session+subject for historical)' });
    const stageIds = stages.split(',').map(Number);
    const tags = stageIds
      .map(id => questionsData.stages.find(s => s.id === id)?.tag)
      .filter(Boolean);

    // Calculate average distribution from all exams for these tags
    const target = parseInt(count);
    const byTag = {};
    for (const tag of tags) {
      byTag[tag] = questionsData.questions.filter(q => q.answer && q.options[q.answer] && q.subject_tag === tag);
    }
    // Use average proportions from real exams
    const avgDist = {
      anatomy: 33, physiology: 27, biochemistry: 26, histology: 10, embryology: 4,
      microbiology: 30, parasitology: 6, pharmacology: 28, pathology: 22, public_health: 14,
    };
    let picked = [];
    let remaining = target;
    const relevantTags = tags.filter(t => byTag[t]?.length > 0);
    for (let i = 0; i < relevantTags.length; i++) {
      const tag = relevantTags[i];
      const isLast = i === relevantTags.length - 1;
      const quota = isLast ? remaining : Math.round(target * (avgDist[tag] || 10) / 100);
      const tagPicked = shuffle(byTag[tag]).slice(0, Math.min(quota, byTag[tag].length));
      picked.push(...tagPicked);
      remaining -= tagPicked.length;
    }
    picked = shuffle(picked);
    res.json({ total: picked.length, questions: picked, mode: 'random' });
  });

  // POST /questions/track
  app.post('/questions/track', (req, res) => {
    const { results } = req.body;
    if (!Array.isArray(results)) return res.status(400).json({ error: 'results array required' });
    if (!stats.questionStats) stats.questionStats = {};
    let tracked = 0;
    for (const r of results.slice(0, 200)) {
      if (!r.id) continue;
      if (!stats.questionStats[r.id]) stats.questionStats[r.id] = { correct: 0, wrong: 0 };
      stats.questionStats[r.id][r.correct ? 'correct' : 'wrong']++;
      tracked++;
    }
    res.json({ tracked });
  });

  // GET /questions/hardest
  app.get('/questions/hardest', (req, res) => {
    const count = Math.min(parseInt(req.query.count) || 20, 50);
    if (!stats.questionStats) return res.json({ questions: [] });

    const ranked = Object.entries(stats.questionStats)
      .map(([id, s]) => {
        const total = s.correct + s.wrong;
        if (total < 5) return null;
        return { id, wrongRate: s.wrong / total, total, correct: s.correct, wrong: s.wrong };
      })
      .filter(Boolean)
      .sort((a, b) => b.wrongRate - a.wrongRate)
      .slice(0, count);

    const qMap = new Map(questionsData.questions.map(q => [String(q.id), q]));
    const questions = ranked
      .map(r => {
        const q = qMap.get(String(r.id));
        if (!q) return null;
        return { ...q, wrongRate: Math.round(r.wrongRate * 100), attempts: r.total };
      })
      .filter(Boolean);

    res.json({ questions });
  });

  // GET /meta
  app.get('/meta', (_, res) => {
    const years = {}, sessions = {}, tags = {};
    for (const q of questionsData.questions) {
      years[q.roc_year]       = (years[q.roc_year]       || 0) + 1;
      sessions[q.session]     = (sessions[q.session]     || 0) + 1;
      tags[q.subject_tag]     = (tags[q.subject_tag]     || 0) + 1;
    }
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=60');
    res.json({ years, sessions, stages: questionsData.stages });
  });
}

module.exports = { registerRoutes, shuffle };
