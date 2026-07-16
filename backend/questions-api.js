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
// Multi-answer (e.g. "A,B"), voided ("送分"), or incomplete (missing image) questions are excluded.
// 'image_options' is allowed — those questions show full page image and let user pick A/B/C/D visually.
function isSingleAnswer(q) {
  if (!q.answer || q.answer.length !== 1 || !q.options[q.answer]) return false;
  if (!q.incomplete) return true;
  return q.incomplete === 'image_options';
}

// Doctor1 paper-constraint: 101+ has strict paper/tag mapping.
// 醫學(一) = anatomy/embryology/histology/physiology/biochemistry
// 醫學(二) = microbiology/parasitology/public_health/pharmacology/pathology
//
// 100年 uses a DIFFERENT paper split (pre-101 format):
//   醫學(一) includes anatomy/embryology/histology + microbiology/parasitology/public_health
//   醫學(二) includes physiology/biochemistry + pharmacology/pathology
// So we exempt 100年 from the constraint — trust the existing tag as-is.
const DOCTOR1_MED1_TAGS = new Set(['anatomy', 'embryology', 'histology', 'physiology', 'biochemistry']);
const DOCTOR1_MED2_TAGS = new Set(['microbiology', 'parasitology', 'public_health', 'pharmacology', 'pathology']);
function doctor1PaperOK(q, tag, examId) {
  // Only enforce for doctor1: shared stage tags (e.g. 'pathology' for medlab,
  // 'physiology' for nursing) must NOT be filtered by 醫學(一)/醫學(二)
  // subject names. Bug observed 2026-05-06: medlab pathology pool collapsed
  // from ~1,173 → ~80 because non-doctor1 questions failed this filter.
  if (examId !== 'doctor1') return true;
  // Pre-101 uses different paper split; don't apply constraint.
  if (q.roc_year && parseInt(q.roc_year) < 101) return true;
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
    const { year, session, subject_tag, q } = req.query;
    // Clamp pagination — uncapped limit would let one request serialize a whole
    // 14k-question exam; negative/NaN page would break slice math.
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    let list = loadExamQuestions(examId, { mode });
    if (year)        list = list.filter(x => x.roc_year === year);
    if (session)     list = list.filter(x => x.session === session);
    if (subject_tag) list = list.filter(x => x.subject_tag === subject_tag && doctor1PaperOK(x, subject_tag, examId));
    if (q)           list = list.filter(x => x.question.includes(q) || Object.values(x.options || {}).some(o => o.includes(q)));
    const total = list.length;
    const start = (page - 1) * limit;
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    res.json({ total, page, limit, mode, questions: list.slice(start, start + limit) });
  });

  // GET /questions/random (practice & PvP — never cached, must be different each time)
  app.get('/questions/random', (req, res) => {
    res.set('Cache-Control', 'private, no-cache');
    const examId = resolveExamId(req);
    const mode = resolveMode(req, examId);
    const data = examData[examId] || examData.doctor1;
    const { stage_id, count = 10, limit, offset, year } = req.query;
    // stage_id may be numeric (doctor1 classification stages) or a string paper id
    // (e.g. "paper1" for nursing/pharma/etc — see server.js stages fallback).
    // Compare as strings so both shapes resolve. '0' / falsy = no filter.
    // stage_id 可為單科 "3" 或多科複選 "3,5,7"（回饋：練習區科目複選）
    const sidStr = stage_id != null ? String(stage_id) : '';
    const sids = sidStr.split(',').map(s => s.trim()).filter(s => s && s !== '0');
    const tags = sids
      .map(sid => data.stages.find(s => String(s.id) === sid)?.tag)
      .filter(t => t && t !== 'all');
    let pool = loadExamQuestions(examId, { mode }).filter(isSingleAnswer);
    // 若有選科目（且非「全部」），保留符合任一 tag 的題（paper_id / subject_tag / subject_tags）
    if (tags.length > 0 && !sids.includes('0')) {
      pool = pool.filter(q =>
        tags.some(tag =>
          (q.paper_id === tag ||
           q.subject_tag === tag ||
           (Array.isArray(q.subject_tags) && q.subject_tags.includes(tag)))
          && doctor1PaperOK(q, tag, examId)
        )
      );
    }
    // 自主練習年份篩選（回饋）：year 可為單一或逗號多年份（複選），空=全部年份
    if (year) {
      const ys = String(year).split(',').map(s => s.trim()).filter(Boolean);
      if (ys.length) pool = pool.filter(q => ys.includes(String(q.roc_year)));
    }
    // Cap target — a mock exam is at most 200 Qs; bigger requests just waste
    // bandwidth shuffling/serializing the whole pool.
    const target = Math.min(200, Math.max(1, parseInt(limit != null ? limit : count) || 50));
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
    const { stages, count = 100, year, session, subject, years } = req.query;

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
    // If subject is given (without year), filter to that paper's questions.
    // If years is given (comma-separated ROC years), restrict the pool to those years.
    if (!stages) {
      const target = parseInt(count);
      let valid = pool.filter(isSingleAnswer);
      if (subject) {
        valid = valid.filter(q => q.subject === subject);
      }
      if (years) {
        const yset = new Set(String(years).split(',').map(s => s.trim()).filter(Boolean));
        if (yset.size) valid = valid.filter(q => yset.has(q.roc_year));
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
      ) && doctor1PaperOK(q, tag, examId));
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
      const id = String(r.id || r.questionId || '');
      // Validate id shape — reject prototype-pollution keys and garbage that
      // would bloat the persisted stats object unboundedly.
      if (!id || id.length > 60 || !/^[A-Za-z0-9_-]+$/.test(id)) continue;
      if (!Object.prototype.hasOwnProperty.call(stats.questionStats, id)) {
        stats.questionStats[id] = { correct: 0, wrong: 0 };
      }
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
