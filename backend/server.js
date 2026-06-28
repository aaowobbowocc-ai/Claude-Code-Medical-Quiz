require('dotenv').config();

// Sentry — production-only error tracking. No-op if SENTRY_DSN unset.
// Must be required before everything else (instrument first).
let Sentry = null;
if (process.env.SENTRY_DSN && process.env.NODE_ENV === 'production') {
  Sentry = require('@sentry/node');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    environment: 'production',
  });
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const leaderboard = require('./leaderboard');
const ai = require('./ai');
const search = require('./search');
const questionsApi = require('./questions-api');
const feedback = require('./feedback');
const board = require('./board');
const commentsApi = require('./comments');
const communityNotes = require('./community-notes');
const paymentJkos = require('./payment-jkos');
const mockScores = require('./mock-scores');
const sharedBanksLoader = require('./shared-banks-loader');

const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { createCache } = require('./cache');

// Response caches with different TTLs
const staticCache  = createCache(3600_000);   // 1hr — data doesn't change after boot
const dayCache     = createCache(86400_000);  // 24hr — exam configs never change
const browseCache  = createCache(300_000);    // 5min — paginated browse queries

const app = express();
// Oracle deploy 走 Nginx → Node，信任 1 hop reverse proxy 才能正確取到 X-Forwarded-For
// 真實 client IP（街口 callback IP 白名單檢查用）。本機 dev 沒 proxy 也安全（XFF 沒就回 socket IP）。
app.set('trust proxy', 1);
app.use(compression());
app.use(cors({
  origin: (origin, cb) => cb(null, true), // allow all origins (Vercel + localhost)
  credentials: true,
}));
app.use(express.json());

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const submitLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.use('/questions', apiLimiter);
app.use('/meta', apiLimiter);
app.use('/leaderboard/submit', submitLimiter);
app.use('/explain', submitLimiter);
app.use('/feedback', submitLimiter);
app.use('/report', submitLimiter);
app.use('/comments', apiLimiter);
app.use('/community-notes', apiLimiter);
app.use('/board', rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }));
app.use('/api/coins', rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));
// /ai/vote: per-IP cap blocks mass device-ID rotation that would otherwise game
// the verified/retracted state machine to flip paid explanations to free or
// wipe the cache. Vote dedup at DB level is by (cache_key, device_id), so the
// IP-level limit complements that.
app.use('/ai/vote', rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/ai/unlocks/sync', rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false }));
// Reward + grant endpoints: idempotent server-side, but cap request rate to
// blunt brute-force retry storms against the coin economy.
app.use('/api/rewards', rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false }));
app.use('/api/grants', rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── Load exam configs from exam-configs/ directory ──────────────────────
const examConfigDir = path.join(__dirname, 'exam-configs');
const examConfigs = {};
for (const file of fs.readdirSync(examConfigDir).filter(f => f.endsWith('.json'))) {
  const cfg = JSON.parse(fs.readFileSync(path.join(examConfigDir, file), 'utf-8'));
  examConfigs[cfg.id] = cfg;
}
console.log(`Loaded ${Object.keys(examConfigs).length} exam configs: ${Object.keys(examConfigs).join(', ')}`);

const examData = {};
for (const [key, cfg] of Object.entries(examConfigs)) {
  if (!cfg.questionsFile) {
    // Shell config (no own questions yet, may pull from sharedBanks). Build a
    // minimal examData entry so endpoints that look up stages don't fall back
    // to doctor1.
    examData[key] = {
      questions: [],
      stages: cfg.stages && cfg.stages.length > 0 ? cfg.stages : [{ id: 0, tag: 'all', name: '全部' }],
      metadata: { category: cfg.name, isShell: true },
    };
    console.log(`Initialized shell ${key}: 0 own questions, sharedBanks=[${(cfg.sharedBanks || []).join(',')}]`);
    continue;
  }
  const filePath = path.join(__dirname, cfg.questionsFile);
  if (fs.existsSync(filePath)) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const questions = Array.isArray(raw) ? raw : (raw.questions || []);
    const papers = cfg.papers || [];

    // Assign paper info to each question based on position within year+session groups
    if (key !== 'doctor1' && papers.length > 0) {
      // Group questions by year+session
      const groups = {};
      questions.forEach((q, idx) => {
        const gkey = `${q.roc_year}|${q.session}`;
        if (!groups[gkey]) groups[gkey] = [];
        groups[gkey].push({ q, idx });
      });

      // Build subject→paper lookup for direct assignment when questions
      // already carry a subject field that matches a paper's subject.
      const bySubject = {};
      for (const p of papers) {
        if (p.subject) bySubject[p.subject] = p;
      }
      for (const items of Object.values(groups)) {
        // Direct assignment path: every question has a subject matching a paper
        const allMatch = items.every(({ q }) => q.subject && bySubject[q.subject]);
        if (allMatch) {
          items.forEach(({ q }) => {
            const paper = bySubject[q.subject];
            q.paper_id = paper.id;
            q.paper_name = paper.name;
            q.subject_name = q.subject_name || paper.subjects;
            q.subject_tag = q.subject_tag || paper.id;
            if (!q._idFixed) {
              q.id = `${q.id}_${paper.id}`;
              q._idFixed = true;
            }
          });
          continue;
        }
        // Fallback: assign by proportional position within the year group.
        // This is lossy when scrape yields vary by year (off-by-one paper drift),
        // but needed for legacy JSONs without a subject field.
        const totalExpected = papers.reduce((s, p) => s + p.count, 0);
        const boundaries = [];
        let cumulative = 0;
        for (const p of papers) {
          cumulative += Math.round((p.count / totalExpected) * items.length);
          boundaries.push(cumulative);
        }
        boundaries[boundaries.length - 1] = items.length;
        items.forEach(({ q }, i) => {
          const paperIdx = boundaries.findIndex(b => i < b);
          const actualIdx = paperIdx >= 0 ? paperIdx : papers.length - 1;
          const paper = papers[actualIdx];
          q.paper_id = paper.id;
          q.paper_name = paper.name;
          q.subject_name = q.subject_name || paper.subjects;
          q.subject_tag = q.subject_tag || paper.id;
          if (!q._idFixed) {
            q.id = `${q.id}_${paper.id}`;
            q._idFixed = true;
          }
        });
      }
    }

    // Prefer cfg.stages — config is authoritative (frontend reads cfg.stages
    // via /exam-registry, so backend MUST agree on stage_id→tag mapping).
    // Fall back to JSON's embedded stages only when cfg has none. Bug 2026-05-07:
    // doctor1 had stale JSON.stages with shifted ids (id=7→parasitology) that
    // disagreed with cfg.stages (id=7→pharmacology) — selecting 藥理學 returned
    // 148 寄生蟲學 questions. Same drift on doctor2/dental1/dental2/pharma2.
    let stages
    if (cfg.stages && cfg.stages.length > 1) {
      stages = cfg.stages
    } else if (raw.stages && raw.stages.length > 0) {
      stages = [{ id: 0, tag: 'all', name: '隨機混合' }, ...raw.stages.filter(s => s.count > 0)]
    } else if ((!cfg.stages || cfg.stages.length <= 1) && papers.length > 1) {
      stages = [
        { id: 0, tag: 'all', name: '全部' },
        ...papers.map(p => ({ id: p.id, tag: p.id, name: `${p.name}`, subjects: p.subjects })),
      ]
    } else {
      stages = cfg.stages || [{ id: 0, tag: 'all', name: '全部' }]
    }

    examData[key] = {
      questions,
      stages,
      metadata: raw.metadata || { category: cfg.name },
    };
    console.log(`Loaded ${key}: ${questions.length} questions, ${stages.length} stages`);
  }
}

// Default for backward compatibility
const questionsData = examData.doctor1;

function getExamData(exam) {
  return examData[exam] || questionsData;
}

function getQuestionsByStage(stageId, exam) {
  const data = getExamData(exam);
  // PvP/practice: only single-answer questions (exclude multi-answer, voided,
  // and incomplete — image-only/empty-option/truncated questions can't be
  // answered fairly in a timed PvP round)
  // Stricter than the inline comment above suggests — garfield reported
  // (2026-05-23) seeing 題目缺漏 / 答案缺漏 in rooms, getting penalized: some
  // questions slip through with empty 題幹 or one of the 4 options being an
  // empty string, even though `incomplete` wasn't flagged. Filter those too.
  //
  // 2026-05-27: garfield 再次回報，加更精準的「截斷偵測」：
  //   - 題幹 trim 後 < 12 字（「下列敘述何者錯誤」9 字勉強，孤立短句多半截斷）
  //     但**若有 case_context / image_url / images 就放行**（題組共用題幹合法情境）
  //   - 選項長度差異 ≥ 5 倍 且 最短 < 3 字 → 視為截斷
  //     這可以擋掉「在脾臟，經F / γ receptor移除 / 長文 / 長文」這種被希臘字母切碎的，
  //     同時不誤殺學測「甲/乙/丙/丁」這種長度均勻的正常選項格式
  const valid = data.questions.filter(q => {
    if (q.incomplete) return false;
    if (!q.answer || q.answer.length !== 1) return false;
    if (!q.options || !q.options[q.answer]) return false;
    const stem = q.question && String(q.question).trim();
    if (!stem) return false;
    // 題幹過短：除非有題組 case_context 或圖片，否則視為截斷
    if (stem.length < 12 && !q.case_context && !q.image_url && !q.images) return false;
    const opts = ['A', 'B', 'C', 'D'].map(k => {
      const v = q.options[k] && String(q.options[k]).trim();
      return v || null;
    });
    if (opts.some(o => o === null)) return false;
    const lens = opts.map(o => o.length).sort((a, b) => a - b);
    // 截斷偵測：最短 < 3 字 且 最長 - 最短 ≥ 10 字
    // → 擋「甲/乙/丙/丁+黏住題組長文」這種 OCR 黏連
    // → 放行「甲/乙/丙/丁」純短選項（lens=[1,1,1,1]）跟生物科「離層酸（ABA）」(lens=[2,3,3,10])
    if (lens[0] < 3 && lens[3] - lens[0] >= 10) return false;
    return true;
  });
  // stageId 可為單一 id（向下相容）或 id 陣列（多科複選，合在一起隨機抽）
  const ids = Array.isArray(stageId) ? stageId : [stageId];
  if (ids.length === 0 || ids.includes(0)) return valid;   // 含「隨機混合(0)」= 全部
  const set = new Set(ids);
  return valid.filter(q => set.has(q.stage_id));
}

const { shuffle } = require('./questions-api');

// ── Room state ──────────────────────────────────────────────────────────
const rooms = new Map();
// room = {
//   code, hostId, players: Map<socketId, {name, score, ready, answered}>,
//   stage, questions[], qIndex, timer, phase: 'lobby'|'playing'|'ended'
// }

const QUESTIONS_PER_GAME = 10;

const AI_PROFILES = {
  easy:   { name: '🤖 簡單AI', accuracy: 0.45, minDelay: 9,  maxDelay: 14 },
  normal: { name: '🤖 普通AI', accuracy: 0.68, minDelay: 4,  maxDelay: 11 },
  hard:   { name: '🤖 困難AI', accuracy: 0.88, minDelay: 2,  maxDelay:  7 },
};

function calcTimeLimit(q) {
  const totalLen = q.question.length + Object.values(q.options).join('').length;
  // 15s base; +1s per 30 chars over 100; cap at 35s
  return Math.min(35, Math.max(15, 15 + Math.floor((totalLen - 100) / 30)));
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// Badge catalog cache — id → {icon, name}. Resolved once at startup so
// PvP room broadcasts don't pay a Supabase round-trip per join.
let badgeCatalogCache = null;
async function loadBadgeCatalog() {
  try {
    const sb = require('./supabase');
    if (!sb) { badgeCatalogCache = new Map(); return; }
    const { data, error } = await sb.from('badges').select('id, icon, name');
    if (error || !data) { badgeCatalogCache = new Map(); return; }
    badgeCatalogCache = new Map(data.map(b => [b.id, { icon: b.icon, name: b.name }]));
    console.log(`[badges] catalog loaded: ${badgeCatalogCache.size} entries`);
  } catch (e) {
    badgeCatalogCache = new Map();
    console.warn('[badges] catalog load failed:', e.message);
  }
}
loadBadgeCatalog();

// Sanitizers — match the id pattern used by migration 017 (badges) / 014 (frames).
function cleanBadgeId(v) {
  return (typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v)) ? v : null;
}
function cleanFrameId(v) {
  return (typeof v === 'string' && /^[a-z0-9_-]{1,40}$/.test(v)) ? v : null;
}

function getRoomPlayers(room, includeAnswer = false) {
  return Array.from(room.players.entries()).map(([id, p]) => {
    const b = (badgeCatalogCache && p.badgeId) ? badgeCatalogCache.get(p.badgeId) : null;
    return {
      id, name: p.name, avatar: p.avatar || '👨‍⚕️', score: p.score, ready: p.ready,
      isAI: p.isAI || false,
      frameId: p.frameId || null,
      badgeIcon: b?.icon || null,
      badgeName: b?.name || null,
      ...(includeAnswer ? { lastAnswer: p.lastAnswer, answered: p.answered } : {}),
    };
  });
}

function broadcastRoomState(room) {
  io.to(room.code).emit('room_state', {
    code: room.code,
    players: getRoomPlayers(room),
    stage: room.stage,
    stages: room.stages || [room.stage],
    phase: room.phase,
    hostId: room.hostId,
    timerMode: room.timerMode || 'auto',
    exam: room.exam || 'doctor1',
  });
}

function startQuestion(room) {
  if (room.qIndex >= room.questions.length) {
    endGame(room);
    return;
  }

  const q = room.questions[room.qIndex];
  room.phase = 'playing';

  // Reset answered flags
  for (const p of room.players.values()) {
    p.answered = false;
    p.lastAnswer = null;
  }

  const timeLimit = room.timerMode && room.timerMode !== 'auto'
    ? parseInt(room.timerMode)
    : calcTimeLimit(q);
  room.questionStartAt = Date.now();
  room.currentTimeLimit = timeLimit;

  // Send question (without answer)
  io.to(room.code).emit('question', {
    index: room.qIndex,
    total: room.questions.length,
    number: q.number,
    question: q.question,
    options: q.options,
    image_url: q.image_url || null,
    images: q.images || null,
    incomplete: q.incomplete || null,
    roc_year: q.roc_year,
    session: q.session,
    subject_name: q.subject_name,
    timeLimit,
  });

  // Start countdown (clear any previous timer first)
  if (room.timer) clearInterval(room.timer);
  let remaining = timeLimit;
  room.timer = setInterval(() => {
    remaining--;
    io.to(room.code).emit('tick', { remaining });

    if (remaining <= 0) {
      clearInterval(room.timer);
      revealAnswer(room);
    }
  }, 1000);

  // Schedule AI answers
  const capturedQIndex = room.qIndex;
  for (const [id, player] of room.players.entries()) {
    if (!player.isAI) continue;
    const profile = AI_PROFILES[player.difficulty] || AI_PROFILES.normal;
    const delayMs = (profile.minDelay + Math.random() * (profile.maxDelay - profile.minDelay)) * 1000;
    setTimeout(() => {
      if (room.qIndex !== capturedQIndex || room.phase !== 'playing') return;
      if (player.answered) return;
      const capturedQ = room.questions[capturedQIndex];
      if (!capturedQ) return;
      const correct = Math.random() < profile.accuracy;
      const wrongOpts = Object.keys(capturedQ.options).filter(k => k !== capturedQ.answer);
      const answer = correct ? capturedQ.answer : wrongOpts[Math.floor(Math.random() * wrongOpts.length)];
      player.answered = true;
      player.lastAnswer = answer;
      if (correct) {
        const elapsed = Math.floor((Date.now() - (room.questionStartAt || Date.now())) / 1000);
        const rem = Math.max(0, (room.currentTimeLimit || 15) - elapsed);
        const bonus = Math.round((rem / (room.currentTimeLimit || 15)) * 50);
        player.score += 100 + bonus;
      }
      const allAnswered = Array.from(room.players.values()).every(p => p.answered);
      if (allAnswered) {
        clearInterval(room.timer);
        revealAnswer(room);
      }
    }, delayMs);
  }
}

function revealAnswer(room) {
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
  const q = room.questions[room.qIndex];
  if (!q) return;
  io.to(room.code).emit('reveal', {
    correctAnswer: q.answer,
    explanation: q.explanation || null,
    players: getRoomPlayers(room, true),
  });

  // Next question after 3s
  setTimeout(() => {
    room.qIndex++;
    if (room.qIndex < room.questions.length) {
      startQuestion(room);
    } else {
      endGame(room);
    }
  }, 3000);
}

function endGame(room) {
  room.phase = 'ended';
  clearInterval(room.timer);
  stats.gamesPlayed++;

  const players = getRoomPlayers(room).sort((a, b) => b.score - a.score);
  io.to(room.code).emit('game_over', { players });
  recordGameResults(room); // fire-and-forget，記錄有帳號玩家的戰績
}

// socket handshake.auth 帶來的 user_id（前端 getSocket 注入）。粗略驗 uuid 樣式。
function getSocketUserId(socket) {
  const uid = socket?.handshake?.auth?.userId;
  return (typeof uid === 'string' && /^[0-9a-fA-F-]{16,40}$/.test(uid)) ? uid : null;
}

// 對戰結束寫 game_results：每個有 user_id 的玩家一列（AI/訪客跳過）。
// 只記「至少 2 人(含 AI)」的場次，避免單人練習被當對戰。表不存在時 insert 會
// 失敗 → catch 靜默（建表前不影響遊戲）。
async function recordGameResults(room) {
  if (!supabase) return;
  try {
    const all = [...room.players.values()].sort((a, b) => b.score - a.score);
    if (all.length < 2) return;
    const topScore = all[0]?.score ?? 0;
    const total = all.length;
    const rows = all
      .map((p, i) => ({ p, rank: i + 1 }))
      .filter(x => x.p.userId)
      .map(({ p, rank }) => ({
        user_id: p.userId,
        room_code: room.code,
        exam: room.exam,
        score: p.score | 0,
        rank,
        total_players: total,
        won: topScore > 0 && p.score === topScore,
      }));
    if (rows.length) await supabase.from('game_results').insert(rows);
  } catch (e) {
    console.warn('[game_results] record failed:', e.message);
  }
}

// ── Socket events ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);
  stats.connections++;
  trackDailyVisit();
  const concurrent = io.engine?.clientsCount || 0;
  if (concurrent > stats.peakConcurrent) stats.peakConcurrent = concurrent;

  // Create room
  socket.on('create_room', ({ playerName, playerAvatar, equippedBadgeId, equippedFrameId, isPublic = false, password = null, exam = 'doctor1' }) => {
    // Sanitize player-controlled strings — playerName goes into chat/leaderboard,
    // password goes into room config, exam into questions query.
    const cleanName = (typeof playerName === 'string' ? playerName : '').slice(0, 30).trim() || '匿名';
    const cleanAvatar = (typeof playerAvatar === 'string' ? playerAvatar : '').slice(0, 8) || '👨‍⚕️';
    const cleanPw = typeof password === 'string' && password.length <= 30 ? password : null;
    const cleanExam = typeof exam === 'string' && /^[a-z0-9-]+$/.test(exam) ? exam.slice(0, 40) : 'doctor1';
    const badgeId = cleanBadgeId(equippedBadgeId);
    const frameId = cleanFrameId(equippedFrameId);
    const code = makeRoomCode();
    const room = {
      code,
      hostId: socket.id,
      players: new Map([[socket.id, { name: cleanName, avatar: cleanAvatar, badgeId, frameId, userId: getSocketUserId(socket), score: 0, ready: false, answered: false }]]),
      stage: 0,
      timerMode: 'auto',
      questions: [],
      qIndex: 0,
      timer: null,
      phase: 'lobby',
      isPublic: !!isPublic,
      password: cleanPw,
      exam: cleanExam,
      lastActivity: Date.now(),
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_created', { code });
    broadcastRoomState(room);
  });

  // Join room
  socket.on('join_room', ({ code, playerName, playerAvatar, equippedBadgeId, equippedFrameId, password }) => {
    const upper = code.toUpperCase();
    const room = rooms.get(upper);
    if (!room) {
      socket.emit('error', { message: '找不到房間，請確認邀請碼' });
      return;
    }
    // Self-invite guard: same socket already in this room (host tapping their
    // own share link, or double-tap join). Bounce to lobby without resetting
    // their existing player entry.
    if (socket.data.roomCode === upper && room.players.has(socket.id)) {
      socket.emit('room_joined', { code: upper });
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('error', { message: '遊戲已開始，無法加入' });
      return;
    }
    if (room.players.size >= 4) {
      socket.emit('error', { message: '房間已滿（最多4人）' });
      return;
    }
    if (room.password) {
      if (!password) {
        socket.emit('error', { message: 'needs_password' });
        return;
      }
      if (password !== room.password) {
        socket.emit('error', { message: 'wrong_password' });
        return;
      }
    }
    const cleanName = (typeof playerName === 'string' ? playerName : '').slice(0, 30).trim() || '匿名';
    const cleanAvatar = (typeof playerAvatar === 'string' ? playerAvatar : '').slice(0, 8) || '👨‍⚕️';
    const badgeId = cleanBadgeId(equippedBadgeId);
    const frameId = cleanFrameId(equippedFrameId);
    room.players.set(socket.id, { name: cleanName, avatar: cleanAvatar, badgeId, frameId, userId: getSocketUserId(socket), score: 0, ready: false, answered: false });
    room.lastActivity = Date.now();
    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    socket.emit('room_joined', { code: code.toUpperCase() });
    broadcastRoomState(room);
  });

  // Rejoin room after reconnect
  socket.on('rejoin_room', ({ code, playerName, playerAvatar, equippedBadgeId, equippedFrameId }) => {
    const room = rooms.get(code);
    if (!room) { socket.emit('error', { message: '房間已關閉' }); return; }
    // If player was already in room (by name), replace their entry
    let existingId = null;
    for (const [id, p] of room.players.entries()) {
      if (p.name === playerName && !p.isAI && id !== socket.id) {
        existingId = id;
        break;
      }
    }
    const badgeId = cleanBadgeId(equippedBadgeId);
    const frameId = cleanFrameId(equippedFrameId);
    if (existingId) {
      const old = room.players.get(existingId);
      room.players.delete(existingId);
      room.players.set(socket.id, {
        ...old,
        avatar: playerAvatar || old.avatar,
        // Refresh badge/frame on rejoin in case user equipped a new one before reconnecting
        badgeId: badgeId !== null ? badgeId : (old.badgeId || null),
        frameId: frameId !== null ? frameId : (old.frameId || null),
      });
      // Transfer host if needed
      if (room.hostId === existingId) room.hostId = socket.id;
    } else if (!room.players.has(socket.id)) {
      // New join (room still has space)
      if (room.players.size >= 4) { socket.emit('error', { message: '房間已滿' }); return; }
      room.players.set(socket.id, { name: playerName, avatar: playerAvatar || '👨‍⚕️', badgeId, frameId, userId: getSocketUserId(socket), score: 0, ready: false, answered: false });
    }
    socket.join(code);
    socket.data.roomCode = code;
    room.lastActivity = Date.now();
    socket.emit('room_joined', { code });
    broadcastRoomState(room);
  });

  // Select stage (host only)
  socket.on('select_stage', ({ stageId, stageIds }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    // 新格式 stageIds[]（多科複選）；舊格式 stageId（單科，向下相容）
    if (Array.isArray(stageIds) && stageIds.length > 0) {
      room.stages = stageIds.includes(0) ? [0] : [...new Set(stageIds)];
    } else {
      room.stages = [stageId];
    }
    room.stage = room.stages[0];   // 保留單一欄位給舊版 App 顯示
    broadcastRoomState(room);
  });

  // Set timer mode (host only): 'auto' | '15' | '20' | '30' | '45'
  socket.on('set_timer_mode', ({ mode }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.timerMode = mode;
    broadcastRoomState(room);
  });

  // Start game (host only)
  socket.on('start_game', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.size < 2) {
      socket.emit('error', { message: '至少需要2位玩家才能開始' });
      return;
    }

    const stages = (room.stages && room.stages.length) ? room.stages : [room.stage || 0];
    const pool = getQuestionsByStage(stages, room.exam);
    if (pool.length < QUESTIONS_PER_GAME) {
      socket.emit('error', { message: `所選科目題目不足（${pool.length}題），請增加科目或改選` });
      return;
    }

    room.questions = shuffle(pool).slice(0, QUESTIONS_PER_GAME);
    room.qIndex = 0;
    room.phase = 'playing';
    room.lastActivity = Date.now();
    for (const p of room.players.values()) { p.score = 0; }

    const stageObjs = (examData[room.exam] || questionsData).stages;
    const stageName = stages.includes(0)
      ? '隨機混合'
      : (stages.map(id => stageObjs.find(s => s.id === id)?.name).filter(Boolean).join('、') || '隨機');
    io.to(room.code).emit('game_starting', {
      stageName,
      questionCount: room.questions.length,
    });

    setTimeout(() => startQuestion(room), 3000);
  });

  // Submit answer
  socket.on('submit_answer', ({ answer }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return;

    const player = room.players.get(socket.id);
    if (!player || player.answered) return;

    player.answered = true;
    player.lastAnswer = answer;
    room.lastActivity = Date.now();
    stats.questionsAnswered++;

    const q = room.questions[room.qIndex];
    const isCorrect = answer === q.answer;

    // Track per-question stats
    if (q.id && !player.isAI) {
      if (!stats.questionStats) stats.questionStats = {};
      if (!stats.questionStats[q.id]) stats.questionStats[q.id] = { correct: 0, wrong: 0 };
      stats.questionStats[q.id][isCorrect ? 'correct' : 'wrong']++;
    }

    // Time-based scoring: 100 base + up to 50 speed bonus
    let timeBonus = 0;
    if (isCorrect) {
      const elapsed = Math.floor((Date.now() - (room.questionStartAt || Date.now())) / 1000);
      const remaining = Math.max(0, (room.currentTimeLimit || 15) - elapsed);
      timeBonus = Math.round((remaining / (room.currentTimeLimit || 15)) * 50);
      player.score += 100 + timeBonus;
    }

    socket.emit('answer_result', {
      correct: isCorrect,
      correctAnswer: null, // hidden until reveal
      score: player.score,
      timeBonus,
    });

    // If all answered, reveal early
    const allAnswered = Array.from(room.players.values()).every(p => p.answered);
    if (allAnswered) {
      clearInterval(room.timer);
      revealAnswer(room);
    }
  });

  // Play again (host)
  socket.on('play_again', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.phase = 'lobby';
    room.qIndex = 0;
    for (const p of room.players.values()) { p.score = 0; p.ready = false; }
    broadcastRoomState(room);
  });

  // Add AI player (host only)
  socket.on('add_ai_player', ({ difficulty = 'normal' }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'lobby') return;
    if (room.players.size >= 4) { socket.emit('error', { message: '房間已滿' }); return; }
    // Remove existing AI first (only one AI allowed)
    for (const [id, p] of room.players.entries()) {
      if (p.isAI) room.players.delete(id);
    }
    const profile = AI_PROFILES[difficulty] || AI_PROFILES.normal;
    const aiId = `AI_${room.code}`;
    room.players.set(aiId, {
      name: profile.name, avatar: '🤖', score: 0, ready: true,
      answered: false, isAI: true, difficulty,
    });
    broadcastRoomState(room);
  });

  // Remove AI player (host only)
  socket.on('remove_ai_player', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    for (const [id, p] of room.players.entries()) {
      if (p.isAI) room.players.delete(id);
    }
    broadcastRoomState(room);
  });

  // Kick player (host only, lobby only, cannot kick self)
  socket.on('kick_player', ({ targetId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'lobby') return;
    if (!targetId || targetId === socket.id) return;
    const target = room.players.get(targetId);
    if (!target) return;
    room.players.delete(targetId);
    if (!target.isAI) {
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) {
        targetSocket.emit('kicked_from_room', { reason: '房主已將你請出房間' });
        try { targetSocket.leave(room.code); } catch {}
        targetSocket.data.roomCode = null;
      }
    }
    broadcastRoomState(room);
  });

  // Quick chat
  socket.on('send_chat', ({ type, content }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    // Validate — prevent payload flooding / malformed types
    if (type !== 'phrase' && type !== 'sticker') return;
    if (typeof content !== 'string') return;
    const cleanContent = type === 'sticker' ? content.slice(0, 8) : content.slice(0, 60);
    if (!cleanContent.trim()) return;
    // Per-player rate limit: max 1 chat per second
    const now = Date.now();
    if (player._lastChatAt && now - player._lastChatAt < 1000) return;
    player._lastChatAt = now;
    io.to(room.code).emit('chat_msg', {
      fromId: socket.id,
      name: player.name,
      avatar: player.avatar || '👨‍⚕️',
      type,
      content: cleanContent,
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      clearInterval(room.timer);
      rooms.delete(code);
      return;
    }

    // Transfer host if needed — never transfer to AI
    if (room.hostId === socket.id) {
      const nextHumanId = [...room.players.entries()]
        .find(([, p]) => !p.isAI)?.[0];
      if (nextHumanId) {
        room.hostId = nextHumanId;
        io.to(code).emit('host_changed', { newHostId: room.hostId });
      } else {
        // Only AI players left — close the room
        clearInterval(room.timer);
        rooms.delete(code);
        return;
      }
    }

    if (room.phase === 'playing') {
      io.to(code).emit('player_left', { message: '對手已離開遊戲' });
      endGame(room);
    } else {
      broadcastRoomState(room);
    }
  });
});

// ── Idle room cleanup (every 5 min, remove rooms idle > 30 min) ────────
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const age = now - (room.lastActivity || now);
    if (age > 30 * 60 * 1000) {
      clearInterval(room.timer);
      rooms.delete(code);
      console.log(`[cleanup] removed idle room ${code}`);
    }
  }
}, 5 * 60 * 1000);

// ── Stats tracking ──────────────────────────────────────────────────────
// Primary: Supabase `site_stats` table (survives Render free-tier FS wipes).
// Fallback: local stats.json (dev / Supabase down).
const supabase = require('./supabase');
const STATS_FILE = path.join(__dirname, 'stats.json');
const STATS_KEY = 'snapshot';

function emptyStats() {
  return {
    connections: 0, peakConcurrent: 0, gamesPlayed: 0,
    questionsAnswered: 0, aiExplains: 0, aiDaily: {}, dailyVisits: {},
    questionStats: {}, // { questionId: { correct: N, wrong: N } }
  };
}

function loadStatsFromFile() {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
  } catch { return null; }
}

async function loadStatsFromSupabase() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('site_stats')
      .select('data')
      .eq('key', STATS_KEY)
      .single();
    if (error || !data?.data) return null;
    return data.data;
  } catch { return null; }
}

const stats = { ...emptyStats(), startedAt: new Date().toISOString() };

// Seed synchronously from file (for immediate use), then async-merge from Supabase
Object.assign(stats, loadStatsFromFile() || {});

(async () => {
  const remote = await loadStatsFromSupabase();
  if (remote) {
    // Supabase is source of truth. Take max of numeric counters in case
    // local file has newer unsynced data; merge daily maps additively.
    const merged = { ...emptyStats(), ...remote };
    for (const k of ['connections', 'peakConcurrent', 'gamesPlayed', 'questionsAnswered', 'aiExplains']) {
      merged[k] = Math.max(remote[k] || 0, stats[k] || 0);
    }
    merged.aiDaily = { ...(remote.aiDaily || {}), ...(stats.aiDaily || {}) };
    merged.dailyVisits = { ...(remote.dailyVisits || {}), ...(stats.dailyVisits || {}) };
    Object.assign(stats, merged);
    console.log('[stats] loaded from Supabase');
  } else {
    console.log('[stats] no Supabase snapshot, using local file / defaults');
  }
})();

function saveStatsToFile() {
  try {
    const { startedAt, ...persist } = stats;
    fs.writeFileSync(STATS_FILE, JSON.stringify(persist), 'utf-8');
  } catch {}
}

async function saveStatsToSupabase() {
  if (!supabase) return;
  try {
    const { startedAt, ...persist } = stats;
    await supabase
      .from('site_stats')
      .upsert({ key: STATS_KEY, data: persist, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  } catch (e) {
    console.error('[stats] supabase upsert failed:', e?.message);
  }
}

// Auto-save locally every 60s (cheap), Supabase every 5 min (avoid quota)
setInterval(saveStatsToFile, 60_000);
setInterval(saveStatsToSupabase, 5 * 60_000);

// SIGTERM/SIGINT flush handlers are at the bottom of this file (after all
// modules initialized). They flush stats + comments + community notes + Supabase
// stats together so partial state isn't lost on graceful shutdown.

function trackDailyVisit() {
  const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  stats.dailyVisits[today] = (stats.dailyVisits[today] || 0) + 1;
  // 只保留最近 30 天
  const keys = Object.keys(stats.dailyVisits).sort();
  while (keys.length > 30) { delete stats.dailyVisits[keys.shift()]; }
}

// ── Register modular routes ────────────────────────────────────────────
leaderboard.configureExams(examConfigs);
leaderboard.registerRoutes(app);
questionsApi.registerRoutes(app, examData, stats, examConfigs, { staticCache, browseCache });
ai.registerRoutes(app, examData, stats);
search.registerSearchRoutes(app, examData);
commentsApi.registerRoutes(app);
communityNotes.registerRoutes(app);
feedback.registerRoutes(app, examData, examConfigs);
board.registerRoutes(app);
paymentJkos.registerJkosRoutes(app, supabase);
mockScores.registerRoutes(app);
const monetization = require('./monetization');
monetization.registerMonetizationRoutes(app);

const account = require('./account');
account.registerAccountRoutes(app);

// ── Coins delta endpoint ─────────────────────────────────────────────────
// Accepts { delta: number } via JWT-authenticated POST.
// Never trusts a client-supplied absolute coins value — only applies a delta
// server-side to prevent localStorage manipulation exploits.
app.post('/api/coins/delta', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' })
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  const { delta } = req.body
  if (typeof delta !== 'number' || !Number.isInteger(delta)) return res.status(400).json({ error: 'Invalid delta' })
  if (delta > 5000 || delta < -200000) return res.status(400).json({ error: 'Delta out of range' })
  try {
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' })
    const { data: profile, error: fetchErr } = await supabase.from('profiles').select('coins').eq('user_id', user.id).single()
    if (fetchErr) return res.status(500).json({ error: fetchErr.message })
    const newCoins = Math.max(0, (profile.coins || 0) + delta)
    const { error: updateErr } = await supabase.from('profiles').update({ coins: newCoins }).eq('user_id', user.id)
    if (updateErr) return res.status(500).json({ error: updateErr.message })
    res.json({ coins: newCoins })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Bind reward (Google 綁定獎勵 3000 幣) — server-authoritative ─────────
// Previously claimed client-side via persistCoinDelta with a client-controlled
// `bindRewardClaimed` flag → user could reset the flag in DevTools and re-claim
// 3000 coins unlimited times. Now the flag check + coin grant happen atomically
// server-side: the UPDATE is guarded by `bind_reward_claimed = false`, so a
// concurrent or repeat request matches 0 rows.
app.post('/api/rewards/bind', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' })
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' })
    const { data: profile, error: fErr } = await supabase
      .from('profiles').select('coins, bind_reward_claimed').eq('user_id', user.id).single()
    if (fErr) return res.status(500).json({ error: fErr.message })
    if (profile.bind_reward_claimed) {
      return res.json({ claimed: false, reason: 'already_claimed', coins: profile.coins || 0 })
    }
    const newCoins = (profile.coins || 0) + 3000
    // Guarded update — only applies if flag still false (race-safe idempotency)
    const { data: updated, error: uErr } = await supabase
      .from('profiles')
      .update({ coins: newCoins, bind_reward_claimed: true })
      .eq('user_id', user.id)
      .eq('bind_reward_claimed', false)
      .select('coins')
    if (uErr) return res.status(500).json({ error: uErr.message })
    if (!updated || updated.length === 0) {
      // Lost the race — another request already claimed
      const { data: p2 } = await supabase.from('profiles').select('coins').eq('user_id', user.id).single()
      return res.json({ claimed: false, reason: 'already_claimed', coins: p2?.coins || 0 })
    }
    res.json({ claimed: true, reward: 3000, coins: updated[0].coins })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Ad reward (看廣告獎勵 300 幣/次, 每日上限 10) — server-authoritative ──
// `ad_reward_today` + `last_ad_date` previously client-controlled. Server now
// owns the daily counter; optimistic-concurrency guard on the old count value
// prevents two parallel requests both incrementing from the same base.
app.post('/api/rewards/ad', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' })
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' })
    const { data: profile, error: fErr } = await supabase
      .from('profiles').select('coins, ad_reward_today, last_ad_date').eq('user_id', user.id).maybeSingle()
    if (fErr) return res.status(500).json({ error: fErr.message })
    // 沒有 profile 列（前端 upsert 補建應已處理；此為防禦）— 回軟性 reason 而非
    // 500，避免前端把它誤報成「廣告載入失敗」。
    if (!profile) return res.json({ claimed: false, reason: 'no_profile' })
    const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
    const sameDay = profile.last_ad_date === today
    const oldCount = sameDay ? (profile.ad_reward_today || 0) : 0
    if (oldCount >= 10) {
      return res.json({ claimed: false, reason: 'exhausted', count: oldCount, coins: profile.coins || 0 })
    }
    const newCount = oldCount + 1
    const newCoins = (profile.coins || 0) + 300
    // Optimistic-concurrency guard. Same-day: guard on (last_ad_date=today,
    // ad_reward_today=oldCount) so a parallel request can't double-increment
    // from the same base. First-of-day: guard on last_ad_date != today via
    // matching the stale value — if another request already rolled the day
    // over, this matches 0 rows.
    let query = supabase.from('profiles')
      .update({ coins: newCoins, ad_reward_today: newCount, last_ad_date: today })
      .eq('user_id', user.id)
    if (sameDay) {
      query = query.eq('last_ad_date', today).eq('ad_reward_today', oldCount)
    } else if (profile.last_ad_date) {
      query = query.eq('last_ad_date', profile.last_ad_date)
    }
    const { data: updated, error: uErr } = await query.select('coins, ad_reward_today')
    if (uErr) return res.status(500).json({ error: uErr.message })
    if (!updated || updated.length === 0) {
      return res.status(409).json({ claimed: false, reason: 'race_retry' })
    }
    res.json({ claimed: true, reward: 300, count: updated[0].ad_reward_today, coins: updated[0].coins })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Daily login bonus (每日登入獎勵 300 + streak) — server-authoritative ──
// `last_daily_bonus` was client-controlled → reset flag, re-claim unlimited.
// Server now owns the date check + streak; guarded UPDATE on the stale
// last_daily_bonus value makes a same-day repeat match 0 rows.
app.post('/api/rewards/daily', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' })
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' })
    const { data: profile, error: fErr } = await supabase
      .from('profiles').select('coins, last_daily_bonus, login_streak').eq('user_id', user.id).single()
    if (fErr) return res.status(500).json({ error: fErr.message })
    const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
    if (profile.last_daily_bonus === today) {
      return res.json({ claimed: false, reason: 'already_today', coins: profile.coins || 0, streak: profile.login_streak || 0 })
    }
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
    const newStreak = profile.last_daily_bonus === yesterday ? (profile.login_streak || 0) + 1 : 1
    const streakBonus = newStreak >= 7 ? 200 : newStreak >= 5 ? 150 : newStreak >= 3 ? 100 : newStreak >= 2 ? 50 : 0
    const totalBonus = 300 + streakBonus
    const newCoins = (profile.coins || 0) + totalBonus
    // Guard on stale last_daily_bonus — concurrent/repeat request matches 0 rows
    let query = supabase.from('profiles')
      .update({ coins: newCoins, last_daily_bonus: today, login_streak: newStreak })
      .eq('user_id', user.id)
    query = profile.last_daily_bonus
      ? query.eq('last_daily_bonus', profile.last_daily_bonus)
      : query.is('last_daily_bonus', null)
    const { data: updated, error: uErr } = await query.select('coins, login_streak')
    if (uErr) return res.status(500).json({ error: uErr.message })
    if (!updated || updated.length === 0) {
      const { data: p2 } = await supabase.from('profiles').select('coins, login_streak').eq('user_id', user.id).single()
      return res.json({ claimed: false, reason: 'already_today', coins: p2?.coins || 0, streak: p2?.login_streak || 0 })
    }
    res.json({ claimed: true, reward: totalBonus, streak: newStreak, coins: updated[0].coins })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 領 grant — 原子化操作（避免 fire-and-forget 失敗導致 3000 金幣消失 bug）
app.post('/api/grants/claim', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' })
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  const { grant_id } = req.body
  if (!grant_id) return res.status(400).json({ error: 'grant_id required' })
  try {
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' })

    // 1. Read grant — 必須沒被 claim 且 user_id 對得上
    const { data: grant, error: gErr } = await supabase.from('user_coin_grants')
      .select('*').eq('id', grant_id).eq('user_id', user.id).is('claimed_at', null).single()
    if (gErr || !grant) return res.status(404).json({ error: 'Grant not found or already claimed' })

    // 2. Mark claimed (race-safe: condition is_claimed_at is null)
    const claimedAt = new Date().toISOString()
    const { data: updGrant, error: claimErr } = await supabase.from('user_coin_grants')
      .update({ claimed_at: claimedAt }).eq('id', grant_id).is('claimed_at', null).select().single()
    if (claimErr || !updGrant) return res.status(409).json({ error: 'Grant already claimed (race)' })

    // 3. Add coins to profile (atomic — fetch + update)
    const { data: profile, error: pErr } = await supabase.from('profiles')
      .select('coins').eq('user_id', user.id).single()
    if (pErr) return res.status(500).json({ error: pErr.message })
    const newCoins = (profile.coins || 0) + grant.coins
    const { error: uErr } = await supabase.from('profiles')
      .update({ coins: newCoins }).eq('user_id', user.id)
    if (uErr) return res.status(500).json({ error: uErr.message })

    res.json({ ok: true, coins: newCoins, granted: grant.coins })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Health + stages + exams + stats API ─────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// List available exams
app.get('/exams', staticCache, (_, res) => {
  const list = Object.entries(examConfigs).map(([id, cfg]) => ({
    id,
    name: cfg.name,
    questionCount: examData[id]?.questions.length || 0,
    totalQuestions: cfg.totalQ,
    passScore: cfg.passScore,
    passRate: cfg.passRate,
    papers: cfg.papers,
    hasStages: (cfg.stages || []).length > 1,
  }));
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(list);
});

// Full exam registry (config-driven, cached aggressively).
// Backward compatible: top-level keys remain exam IDs (legacy clients iterate
// Object.entries unchanged). Shared bank metadata is exposed via the dedicated
// /shared-banks endpoint and not folded into this response.
app.get('/exam-registry', dayCache, (_, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json(examConfigs);
});

// Shared question bank metadata — scanned from backend/shared-banks/*.json.
// Returns one entry per bank file with bankId/name/levels/questionCount/bankVersion/last_synced_at.
app.get('/shared-banks', staticCache, (_, res) => {
  res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=60');
  res.json({ banks: sharedBanksLoader.getAllBankMeta() });
});

// Full bank JSON — used by frontend PWA prefetch so shared banks are available offline.
// Path shape `/shared-banks/<bankId>.json` matches the SW regex in public/sw.js.
app.get('/shared-banks/:bankId.json', (req, res) => {
  const bankId = req.params.bankId;
  if (!/^[a-z0-9_]+$/i.test(bankId)) return res.status(400).json({ error: 'invalid bankId' });
  const bank = sharedBanksLoader.loadBank(bankId);
  if (!bank) return res.status(404).json({ error: 'not found' });
  res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=300');
  res.json(bank);
});

app.get('/stages', staticCache, (req, res) => {
  const exam = req.query.exam || 'doctor1';
  const data = getExamData(exam);
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(data.stages);
});

// Public cumulative metrics (for homepage trust signals).
// Cached 5 minutes — these change slowly and the homepage hits this on every load.
app.get('/cumulative-stats', (_req, res) => {
  let totalQuestions = 0;
  let examsCount = 0;
  for (const [key, cfg] of Object.entries(examConfigs)) {
    if (cfg.questionsFile) examsCount++;
    const data = examData[key];
    if (data?.questions) totalQuestions += data.questions.length;
  }
  // Reduce explanations cache: count of verified+pending across questionStats
  const ratedQuestions = Object.keys(stats.questionStats || {}).length;
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    questionsAnswered: stats.questionsAnswered || 0,
    gamesPlayed: stats.gamesPlayed || 0,
    aiExplains: stats.aiExplains || 0,
    totalQuestions,
    examsCount,
    ratedQuestions,
  });
});

app.get('/stats', (_, res) => {
  const concurrent = io.engine?.clientsCount || 0;
  const activeRooms = Array.from(rooms.values()).filter(r => r.phase === 'playing').length;
  const lobbyRooms = Array.from(rooms.values()).filter(r => r.phase === 'lobby').length;
  const uptime = Math.floor((Date.now() - new Date(stats.startedAt).getTime()) / 1000);

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>國考知識王 Stats</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,sans-serif; background:#0f172a; color:#e2e8f0; padding:20px; max-width:600px; margin:auto; }
  h1 { font-size:1.4rem; margin-bottom:16px; }
  .card { background:#1e293b; border-radius:16px; padding:16px; margin-bottom:12px; }
  .card h2 { font-size:.85rem; color:#94a3b8; margin-bottom:10px; text-transform:uppercase; letter-spacing:1px; }
  .row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #334155; }
  .row:last-child { border:none; }
  .label { color:#94a3b8; }
  .val { font-weight:700; color:#38bdf8; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .stat-box { background:#334155; border-radius:12px; padding:12px; text-align:center; }
  .stat-box .num { font-size:1.6rem; font-weight:800; color:#38bdf8; }
  .stat-box .lbl { font-size:.75rem; color:#94a3b8; margin-top:2px; }
  .bar-row { display:flex; align-items:center; gap:8px; padding:4px 0; }
  .bar-label { width:70px; font-size:.75rem; color:#94a3b8; text-align:right; }
  .bar { height:20px; background:#38bdf8; border-radius:6px; min-width:2px; }
  .bar-val { font-size:.75rem; color:#64748b; }
  .footer { text-align:center; font-size:.7rem; color:#475569; margin-top:16px; }
</style></head><body>
<h1>📊 國考知識王 即時統計</h1>

<div class="grid">
  <div class="stat-box"><div class="num">${concurrent}</div><div class="lbl">目前在線</div></div>
  <div class="stat-box"><div class="num">${activeRooms}</div><div class="lbl">進行中對戰</div></div>
  <div class="stat-box"><div class="num">${lobbyRooms}</div><div class="lbl">等待中房間</div></div>
  <div class="stat-box"><div class="num">${stats.peakConcurrent}</div><div class="lbl">最高同時在線</div></div>
</div>

<div class="card">
  <h2>累計統計</h2>
  <div class="row"><span class="label">總連線數</span><span class="val">${stats.connections}</span></div>
  <div class="row"><span class="label">完成遊戲</span><span class="val">${stats.gamesPlayed} 局</span></div>
  <div class="row"><span class="label">回答題數</span><span class="val">${stats.questionsAnswered}</span></div>
  <div class="row"><span class="label">AI 解說</span><span class="val">${stats.aiExplains} 次</span></div>
  <div class="row"><span class="label">運行時間</span><span class="val">${Math.floor(uptime/3600)}h ${Math.floor(uptime%3600/60)}m</span></div>
  <div class="row"><span class="label">持久化</span><span class="val" style="color:${supabase ? '#10b981' : '#f97316'}">${supabase ? '✓ Supabase 同步中' : '⚠ 僅本地（重啟歸零）'}</span></div>
</div>

<div class="card">
  <h2>每日訪問（近期）</h2>
  ${(() => {
    const days = Object.entries(stats.dailyVisits).sort().slice(-7);
    const max = Math.max(...days.map(d => d[1]), 1);
    return days.map(([d, c]) =>
      '<div class="bar-row"><span class="bar-label">' + d.replace(/\d{4}\//, '') + '</span><div class="bar" style="width:' + Math.round(c/max*200) + 'px"></div><span class="bar-val">' + c + '</span></div>'
    ).join('') || '<div style="color:#475569;text-align:center;padding:12px">尚無數據</div>';
  })()}
</div>

<div class="card">
  <h2>每日 AI 解說（近 14 天）</h2>
  ${(() => {
    const days = Object.entries(stats.aiDaily || {}).sort().slice(-14);
    const max = Math.max(...days.map(d => d[1]), 1);
    return days.map(([d, c]) =>
      '<div class="bar-row"><span class="bar-label">' + d.replace(/\d{4}\//, '') + '</span><div class="bar" style="background:#a78bfa;width:' + Math.round(c/max*200) + 'px"></div><span class="bar-val">' + c + ' 次</span></div>'
    ).join('') || '<div style="color:#475569;text-align:center;padding:12px">尚無數據（從此部署開始紀錄）</div>';
  })()}
</div>

<div class="footer">自動刷新：<script>setTimeout(()=>location.reload(),30000)</script>每 30 秒 · 啟動於 ${stats.startedAt.slice(0,16).replace('T',' ')}</div>
</body></html>`);
});

// GET /rooms  — list public lobby rooms
const STAGE_ICONS = ['🎲','🦴','💓','⚗️','🔬','🦠','🪱','💊','🩺','📊'];
app.get('/rooms', (_, res) => {
  const list = [];
  for (const [code, room] of rooms) {
    if (!room.isPublic || room.phase !== 'lobby') continue;
    const humanPlayers = Array.from(room.players.values()).filter(p => !p.isAI);
    list.push({
      code,
      playerCount: humanPlayers.length,
      stageName: (() => {
        const so = (examData[room.exam] || questionsData).stages;
        const ids = (room.stages && room.stages.length) ? room.stages : [room.stage];
        if (ids.includes(0) || ids.length === 0) return '隨機混合';
        const names = ids.map(id => so.find(s => s.id === id)?.name).filter(Boolean);
        return names.length > 1 ? `${names[0]} 等 ${names.length} 科` : (names[0] || '隨機混合');
      })(),
      stageIcon: STAGE_ICONS[room.stage] || '🎲',
      hostName: humanPlayers[0]?.name || '未知',
      hasPassword: !!room.password,
    });
  }
  res.json(list);
});

// ── Crowdsourced classification ───────────────────────────────────────────
// votes: { [questionId]: { [subjectTag]: count } }
const VOTES_FILE = path.join(__dirname, 'votes.json');
const VOTE_THRESHOLD = 3;

const SUBJECT_MAP = {
  anatomy:      { name: '解剖學',      stage: 1 },
  physiology:   { name: '生理學',      stage: 2 },
  biochemistry: { name: '生物化學',    stage: 3 },
  histology:    { name: '組織胚胎學',  stage: 4 },
  microbiology: { name: '微生物與免疫', stage: 5 },
  parasitology: { name: '寄生蟲學',   stage: 6 },
  pharmacology: { name: '藥理學',     stage: 7 },
  pathology:    { name: '病理學',     stage: 8 },
  public_health:{ name: '公共衛生',   stage: 9 },
};

// Load existing votes and apply any that already hit threshold
let votes = {};
try {
  votes = JSON.parse(fs.readFileSync(VOTES_FILE, 'utf-8'));
  let applied = 0;
  for (const [qid, tagCounts] of Object.entries(votes)) {
    const winner = Object.entries(tagCounts).find(([, c]) => c >= VOTE_THRESHOLD);
    if (winner) {
      const q = questionsData.questions.find(x => x.id === qid);
      if (q && q.subject_tag === 'unknown') {
        const [tag] = winner;
        q.subject_tag = tag;
        q.subject_name = SUBJECT_MAP[tag]?.name || tag;
        q.stage_id = SUBJECT_MAP[tag]?.stage || 0;
        applied++;
      }
    }
  }
  if (applied) console.log(`Applied ${applied} crowd-voted classifications`);
} catch {}

function saveVotes() {
  try { fs.writeFileSync(VOTES_FILE, JSON.stringify(votes, null, 2), 'utf-8'); } catch {}
}

// POST /classify-vote  body: { id, subjectTag }
app.post('/classify-vote', (req, res) => {
  const { id, subjectTag } = req.body;
  if (!id || !SUBJECT_MAP[subjectTag]) return res.status(400).json({ error: 'invalid' });

  const q = questionsData.questions.find(x => x.id === id);
  if (!q) return res.status(404).json({ error: 'not found' });

  if (!votes[id]) votes[id] = {};
  votes[id][subjectTag] = (votes[id][subjectTag] || 0) + 1;
  saveVotes();

  const count = votes[id][subjectTag];
  let classified = false;

  if (count >= VOTE_THRESHOLD && q.subject_tag === 'unknown') {
    q.subject_tag   = subjectTag;
    q.subject_name  = SUBJECT_MAP[subjectTag].name;
    q.stage_id      = SUBJECT_MAP[subjectTag].stage;
    classified = true;
    console.log(`Auto-classified ${id} → ${subjectTag} (${count} votes)`);
  }

  res.json({ ok: true, count, total: VOTE_THRESHOLD, classified });
});

// GET /classify-pending  — list questions still unknown + their vote counts
app.get('/classify-pending', (_, res) => {
  const pending = questionsData.questions
    .filter(q => q.subject_tag === 'unknown')
    .map(q => ({
      id: q.id, number: q.number, roc_year: q.roc_year, session: q.session,
      question: q.question.slice(0, 60),
      votes: votes[q.id] || {},
    }));
  res.json({ count: pending.length, questions: pending });
});

// Sentry Express error handler — must be after all routes, before
// other custom error handlers. No-op if Sentry isn't initialized.
if (Sentry) {
  Sentry.setupExpressErrorHandler(app);
}

// Save stats on shutdown — use saveStatsToFile (saveStats was renamed long
// ago but SIGTERM handlers were not updated; Sentry caught this 2026-05-08).
// Async: also flushes Supabase stats before exit (was a separate SIGTERM handler
// above, but two handlers on same signal raced — sync exit killed the async one).
async function gracefulShutdown(signal) {
  console.log(`[shutdown] ${signal} — flushing all state`);
  saveStatsToFile();
  commentsApi.saveComments();
  communityNotes.saveNotes();
  try { await saveStatsToSupabase(); } catch (e) { console.warn('[shutdown] supabase flush failed:', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
