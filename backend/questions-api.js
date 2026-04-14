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

// Check if question is single-answer (suitable for practice/PvP)
// Multi-answer (e.g. "A,B"), voided ("送分"), or incomplete (missing image) questions are excluded
function isSingleAnswer(q) {
  return q.answer && q.answer.length === 1 && q.options[q.answer] && !q.incomplete;
}

function registerRoutes(app, examData, stats, examConfigs, { staticCache, browseCache } = {}) {
  // Helper: resolve exam data from query param
  function resolve(req) {
    const exam = req.query.exam || 'doctor1';
    return examData[exam] || examData.doctor1;
  }

  // GET /questions (browse — cacheable)
  app.get('/questions', ...(browseCache ? [browseCache] : []), (req, res) => {
    const questionsData = resolve(req);
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

  // GET /questions/random (practice & PvP — never cached, must be different each time)
  app.get('/questions/random', (req, res) => {
    res.set('Cache-Control', 'private, no-cache');
    const questionsData = resolve(req);
    const { stage_id, count = 10 } = req.query;
    const tag = stage_id && parseInt(stage_id) > 0
      ? questionsData.stages.find(s => s.id === parseInt(stage_id))?.tag
      : null;
    let pool = questionsData.questions.filter(isSingleAnswer);
    if (tag) pool = pool.filter(q => q.subject_tag === tag);
    const picked = shuffle(pool).slice(0, parseInt(count));
    res.json({ total: pool.length, questions: picked });
  });

  // GET /questions/exam-years — list available historical exams (cacheable)
  app.get('/questions/exam-years', ...(staticCache ? [staticCache] : []), (req, res) => {
    const examId = req.query.exam || 'doctor1';
    const questionsData = resolve(req);
    const exams = {};
    for (const q of questionsData.questions) {
      const key = `${q.roc_year}_${q.session}`;
      if (!exams[key]) exams[key] = { roc_year: q.roc_year, session: q.session, papers: {} };
      if (!exams[key].papers[q.subject]) exams[key].papers[q.subject] = {};
      const tag = q.subject_tag;
      exams[key].papers[q.subject][tag] = (exams[key].papers[q.subject][tag] || 0) + 1;
    }
    // Build config paper order for sorting (use paper.subject or paper.name)
    const cfg = examConfigs && examConfigs[examId];
    const paperOrder = cfg ? cfg.papers.map(p => p.subject || p.name) : [];
    function paperSortIdx(name) {
      const idx = paperOrder.indexOf(name);
      return idx >= 0 ? idx : 999;
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
        })).sort((a, b) => paperSortIdx(a.name) - paperSortIdx(b.name)),
      }))
      .sort((a, b) => b.roc_year.localeCompare(a.roc_year) || b.session.localeCompare(a.session));
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    res.json(list);
  });

  // GET /questions/exam — supports historical (year+session) or random (stages) mode
  // Not cached at middleware level: historical mode is cacheable, random mode is not
  app.get('/questions/exam', (req, res) => {
    const questionsData = resolve(req);
    const { stages, count = 100, year, session, subject } = req.query;

    // Historical mode: return ALL questions (including multi-answer & voided) for authentic exam simulation.
    // Sort by question number to preserve original order — critical for 承上題 (carryover)
    // questions to appear right after their root question, matching the printed exam.
    if (year && session && subject) {
      const pool = questionsData.questions.filter(q =>
        q.roc_year === year && q.session === session && q.subject === subject
      );
      const ordered = [...pool].sort((a, b) => (a.number || 0) - (b.number || 0));
      res.set('Cache-Control', 'public, max-age=3600');
      return res.json({ total: ordered.length, questions: ordered, mode: 'historical' });
    }

    // Random mode — pick from all questions (single-answer only for random mock)
    // If subject is given (without year), filter to that paper's questions
    if (!stages) {
      const target = parseInt(count);
      let pool = questionsData.questions.filter(isSingleAnswer);
      if (subject) {
        pool = pool.filter(q => q.subject === subject);
      }
      const picked = shuffle(pool).slice(0, target);
      return res.json({ total: picked.length, questions: picked, mode: 'random' });
    }
    const stageIds = stages.split(',').map(Number);
    const tags = stageIds
      .map(id => questionsData.stages.find(s => s.id === id)?.tag)
      .filter(Boolean);

    const target = parseInt(count);
    const byTag = {};
    for (const tag of tags) {
      byTag[tag] = questionsData.questions.filter(q => isSingleAnswer(q) && q.subject_tag === tag);
    }
    // Calculate proportional distribution from actual data counts
    const relevantTags = tags.filter(t => byTag[t]?.length > 0);
    const totalPool = relevantTags.reduce((s, t) => s + byTag[t].length, 0);
    let picked = [];
    let remaining = target;
    for (let i = 0; i < relevantTags.length; i++) {
      const tag = relevantTags[i];
      const isLast = i === relevantTags.length - 1;
      const quota = isLast ? remaining : Math.round(target * byTag[tag].length / totalPool);
      const tagPicked = shuffle(byTag[tag]).slice(0, Math.min(quota, byTag[tag].length));
      picked.push(...tagPicked);
      remaining -= tagPicked.length;
    }

    // For exams without subject tags, just pick randomly from all
    if (picked.length === 0) {
      const allValid = questionsData.questions.filter(q => q.answer && q.options[q.answer]);
      picked = shuffle(allValid).slice(0, target);
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

  // GET /questions/hardest (cacheable — stats change slowly)
  app.get('/questions/hardest', ...(browseCache ? [browseCache] : []), (req, res) => {
    const questionsData = resolve(req);
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

  // GET /meta (cacheable — static after boot)
  app.get('/meta', ...(staticCache ? [staticCache] : []), (req, res) => {
    const questionsData = resolve(req);
    const years = {}, sessions = {}, tags = {};
    const examSet = new Set();
    for (const q of questionsData.questions) {
      if (q.roc_year) years[q.roc_year] = (years[q.roc_year] || 0) + 1;
      if (q.session)  sessions[q.session] = (sessions[q.session] || 0) + 1;
      if (q.subject_tag) tags[q.subject_tag] = (tags[q.subject_tag] || 0) + 1;
      if (q.roc_year && q.session) examSet.add(`${q.roc_year}|${q.session}`);
    }
    // Build sorted year+session list for filter chips
    const exams = [...examSet].map(k => {
      const [year, session] = k.split('|');
      const shortSession = session === '第一次' ? '一' : session === '第二次' ? '二' : session;
      return { label: `${year}年${shortSession}`, year, session };
    }).sort((a, b) => a.year.localeCompare(b.year) || a.session.localeCompare(b.session));

    // Build stages with counts
    const stagesWithCount = (questionsData.stages || []).map(s => ({
      ...s,
      count: s.tag === 'all' ? questionsData.questions.length : (tags[s.tag] || 0),
    }));

    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=60');
    res.json({ years, sessions, exams, stages: stagesWithCount });
  });
}

module.exports = { registerRoutes, shuffle };
