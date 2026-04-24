const fs = require('fs');
const path = require('path');
const sharedBanksLoader = require('./shared-banks-loader');

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

// Doctor1 paper-constraint: each subject_tag strictly belongs to one paper.
// 100年 (pre-101 240Q format) has many mis-tagged questions; this guard
// prevents e.g. a 醫學(二) question incorrectly tagged 'anatomy' from
// leaking into anatomy-filtered practice sessions.
const DOCTOR1_MED1_TAGS = new Set(['anatomy', 'embryology', 'histology', 'physiology', 'biochemistry']);
const DOCTOR1_MED2_TAGS = new Set(['microbiology', 'parasitology', 'public_health', 'pharmacology', 'pathology']);
function doctor1PaperOK(q, tag) {
  if (DOCTOR1_MED1_TAGS.has(tag)) return !q.subject || q.subject === '醫學(一)';
  if (DOCTOR1_MED2_TAGS.has(tag)) return !q.subject || q.subject === '醫學(二)';
  return true;
}

function registerRoutes(app, examData, stats, examConfigs, { staticCache, browseCache } = {}) {
  // Resolve exam id (default doctor1)
  function resolveExamId(req) {
    return req.query.exam || 'doctor1';
  }

  // Resolve exam data (legacy: own questions only)
  function resolve(req) {
    const exam = resolveExamId(req);
    return examData[exam] || examData.doctor1;
  }

  // Resolve effective mode for a given exam:
  //   query.mode > cfg.uxHints.defaultMode > 'pure'
  // Exams without sharedBanks always behave as pure regardless of input.
  function resolveMode(req, examId) {
    const cfg = examConfigs[examId];
    if (!cfg || !Array.isArray(cfg.sharedBanks) || cfg.sharedBanks.length === 0) return 'pure';
    const requested = req.query.mode;
    if (requested === 'pure' || requested === 'reservoir') return requested;
    return (cfg.uxHints && cfg.uxHints.defaultMode) || 'pure';
  }

  // Core helper: returns the effective question pool for an exam given mode.
  // - mode 'pure'      → exam's own questions only
  // - mode 'reservoir' → own + shared bank questions (filtered by sharedScope level)
  // Shared questions carry { isSharedBank, sourceBankId, sourceLabel } markers.
  function loadExamQuestions(examId, { mode = 'pure' } = {}) {
    const data = examData[examId];
    const own = data && data.questions ? data.questions : [];
    if (mode !== 'reservoir') return own;
    const cfg = examConfigs[examId];
    const shared = sharedBanksLoader.getSharedQuestionsForExam(cfg);
    return [...own, ...shared];
  }

  // Apply limit/offset to an array, returning { total, slice }.
  function paginate(arr, { limit, offset } = {}) {
    const total = arr.length;
    const off = Math.max(0, parseInt(offset) || 0);
    const lim = limit != null ? Math.max(0, parseInt(limit)) : total;
    return { total, slice: arr.slice(off, off + lim) };
  }

  // GET /questions (browse — cacheable)
  app.get('/questions', ...(browseCache ? [browseCache] : []), (req, res) => {
    const examId = resolveExamId(req);
    const mode = resolveMode(req, examId);
    const { year, session, subject_tag, q, page = 1, limit = 20 } = req.query;
    let list = loadExamQuestions(examId, { mode });
    if (year)        list = list.filter(x => x.roc_year === year);
    if (session)     list = list.filter(x => x.session === session);
    if (subject_tag) list = list.filter(x => x.subject_tag === subject_tag && doctor1PaperOK(x, subject_tag));
    if (q)           list = list.filter(x => x.question.includes(q) || Object.values(x.options).some(o => o.includes(q)));
    const total = list.length;
    const start = (parseInt(page) - 1) * parseInt(limit);
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    res.json({ total, page: parseInt(page), limit: parseInt(limit), mode, questions: list.slice(start, start + parseInt(limit)) });
  });

  // GET /questions/random (practice & PvP — never cached, must be different each time)
  app.get('/questions/random', (req, res) => {
    res.set('Cache-Control', 'private, no-cache');
    const examId = resolveExamId(req);
    const mode = resolveMode(req, examId);
    const data = examData[examId] || examData.doctor1;
    const { stage_id, count = 10, limit, offset } = req.query;
    // stage_id may be numeric (doctor1 classification stages) or a string paper id
    // (e.g. "paper1" for nursing/pharma/etc — see server.js stages fallback).
    // Compare as strings so both shapes resolve. '0' / falsy = no filter.
    const sidStr = stage_id != null ? String(stage_id) : '';
    const tag = sidStr && sidStr !== '0'
      ? data.stages.find(s => String(s.id) === sidStr)?.tag
      : null;
    let pool = loadExamQuestions(examId, { mode }).filter(isSingleAnswer);
    if (tag && tag !== 'all') {
      // Filter by paper_id (exams with paper-derived stages) OR subject_tag
      // (doctor1 / pharma etc with classification stages) OR subject_tags array
      // (shared bank questions).
      pool = pool.filter(q =>
        (q.paper_id === tag ||
         q.subject_tag === tag ||
         (Array.isArray(q.subject_tags) && q.subject_tags.includes(tag)))
        && doctor1PaperOK(q, tag)
      );
    }
    const target = parseInt(limit != null ? limit : count) || 50;
    const shuffled = shuffle(pool);
    const off = Math.max(0, parseInt(offset) || 0);
    const picked = shuffled.slice(off, off + target);
    res.json({ total: pool.length, mode, questions: picked });
  });

  // GET /questions/exam-years — list available historical exams (cacheable)
  // Always pure: historical structure (year+session+paper) only applies to exam's own questions.
  app.get('/questions/exam-years', ...(staticCache ? [staticCache] : []), (req, res) => {
    const examId = resolveExamId(req);
    const ownQuestions = loadExamQuestions(examId, { mode: 'pure' });
    const exams = {};
    for (const q of ownQuestions) {
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
    const examId = resolveExamId(req);
    // Mock exam mode is always pure for quota exams (preserve fixed paper structure)
    const cfg = examConfigs[examId];
    const isQuota = cfg && cfg.selectionType === 'quota';
    const mode = isQuota ? 'pure' : resolveMode(req, examId);
    const questionsData = examData[examId] || examData.doctor1;
    const pool = loadExamQuestions(examId, { mode });
    const { stages, count = 100, year, session, subject } = req.query;

    // Historical mode: return ALL questions (including multi-answer & voided) for authentic exam simulation.
    // Sort by question number to preserve original order — critical for 承上題 (carryover)
    // questions to appear right after their root question, matching the printed exam.
    if (year && session && subject) {
      const filtered = pool.filter(q =>
        q.roc_year === year && q.session === session && q.subject === subject
      );
      const ordered = [...filtered].sort((a, b) => (a.number || 0) - (b.number || 0));
      res.set('Cache-Control', 'public, max-age=3600');
      return res.json({ total: ordered.length, questions: ordered, mode: 'historical' });
    }

    // Random mode — pick from all questions (single-answer only for random mock)
    // If subject is given (without year), filter to that paper's questions
    if (!stages) {
      const target = parseInt(count);
      let valid = pool.filter(isSingleAnswer);
      if (subject) {
        valid = valid.filter(q => q.subject === subject);
      }
      const picked = shuffle(valid).slice(0, target);
      return res.json({ total: picked.length, questions: picked, mode: 'random' });
    }
    // Stages may be numeric (doctor1) or string paper ids (other exams). Compare as strings.
    const stageIds = stages.split(',').map(s => s.trim()).filter(Boolean);
    const tags = stageIds
      .map(id => questionsData.stages.find(s => String(s.id) === id)?.tag)
      .filter(Boolean)
      .filter(t => t !== 'all');

    const target = parseInt(count);
    const byTag = {};
    for (const tag of tags) {
      byTag[tag] = pool.filter(q => isSingleAnswer(q) && (
        q.paper_id === tag ||
        q.subject_tag === tag ||
        (Array.isArray(q.subject_tags) && q.subject_tags.includes(tag))
      ) && doctor1PaperOK(q, tag));
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
      const allValid = pool.filter(q => q.answer && q.options[q.answer]);
      picked = shuffle(allValid).slice(0, target);
    }

    picked = shuffle(picked);
    res.json({ total: picked.length, questions: picked, mode: 'random' });
  });

  // POST /questions/track
  // Accept both {results:[{id,correct}]} and {stats:[{questionId,correct}]}
  // (frontend Practice.jsx uses the latter; keep compat both ways)
  app.post('/questions/track', (req, res) => {
    const arr = Array.isArray(req.body?.results) ? req.body.results
              : Array.isArray(req.body?.stats)   ? req.body.stats
              : null;
    if (!arr) return res.status(400).json({ error: 'results|stats array required' });
    if (!stats.questionStats) stats.questionStats = {};
    let tracked = 0;
    for (const r of arr.slice(0, 200)) {
      const id = r.id || r.questionId;
      if (!id) continue;
      if (!stats.questionStats[id]) stats.questionStats[id] = { correct: 0, wrong: 0 };
      stats.questionStats[id][r.correct ? 'correct' : 'wrong']++;
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
    const examId = resolveExamId(req);
    const cfg = examConfigs[examId];
    const data = examData[examId];
    const own = data && data.questions ? data.questions : [];

    const years = {}, sessions = {}, tags = {};
    const examSet = new Set();
    let deprecatedCount = 0;
    for (const q of own) {
      if (q.is_deprecated) { deprecatedCount++; continue; }
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

    const stagesWithCount = (data?.stages || []).map(s => ({
      ...s,
      count: s.tag === 'all' ? own.length - deprecatedCount : (tags[s.tag] || 0),
    }));

    // Merged papers: exam's own papers + shared bank "virtual papers"
    const ownPapers = (cfg && cfg.papers) ? cfg.papers : [];
    const sharedPapers = sharedBanksLoader.getSharedPapersForExam(cfg);
    const mergedPapers = [...ownPapers, ...sharedPapers];

    // Total Q (own only, excluding deprecated)
    const totalQ = own.length - deprecatedCount;

    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=60');
    res.json({
      years, sessions, exams,
      stages: stagesWithCount,
      papers: ownPapers,
      mergedPapers,
      totalQ,
      deprecatedCount,
      defaultMode: (cfg && cfg.uxHints && cfg.uxHints.defaultMode) || 'pure',
      hasSharedBanks: sharedPapers.length > 0,
    });
  });

  // Coverage endpoint: year × session question counts for all exams
  app.get('/questions/coverage', staticCache || ((_, __, next) => next()), (req, res) => {
    const result = {};
    for (const [examId, data] of Object.entries(examData)) {
      const questions = data.questions || [];
      const yearSessions = {};
      for (const q of questions) {
        const yr = q.roc_year;
        const sess = q.session || '第一次';
        if (!yearSessions[yr]) yearSessions[yr] = {};
        yearSessions[yr][sess] = (yearSessions[yr][sess] || 0) + 1;
      }
      result[examId] = {
        name: (examConfigs[examId] && examConfigs[examId].name) || examId,
        short: (examConfigs[examId] && examConfigs[examId].short) || examId,
        icon: (examConfigs[examId] && examConfigs[examId].icon) || '',
        years: yearSessions,
      };
    }
    res.json(result);
  });
}

module.exports = { registerRoutes, shuffle };
