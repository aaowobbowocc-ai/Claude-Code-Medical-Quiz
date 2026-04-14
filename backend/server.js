require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const leaderboard = require('./leaderboard');
const ai = require('./ai');
const questionsApi = require('./questions-api');
const feedback = require('./feedback');
const board = require('./board');
const commentsApi = require('./comments');
const communityNotes = require('./community-notes');

const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { createCache } = require('./cache');

// Response caches with different TTLs
const staticCache  = createCache(3600_000);   // 1hr — data doesn't change after boot
const dayCache     = createCache(86400_000);  // 24hr — exam configs never change
const browseCache  = createCache(300_000);    // 5min — paginated browse queries

const app = express();
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
  const filePath = path.join(__dirname, cfg.questionsFile);
  if (fs.existsSync(filePath)) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const questions = raw.questions || [];
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

      for (const items of Object.values(groups)) {
        // Assign papers based on proportion of paper.count
        const totalExpected = papers.reduce((s, p) => s + p.count, 0);
        const boundaries = [];
        let cumulative = 0;
        for (const p of papers) {
          cumulative += Math.round((p.count / totalExpected) * items.length);
          boundaries.push(cumulative);
        }
        // Ensure last boundary covers all items
        boundaries[boundaries.length - 1] = items.length;
        items.forEach(({ q }, i) => {
          const paperIdx = boundaries.findIndex(b => i < b);
          const actualIdx = paperIdx >= 0 ? paperIdx : papers.length - 1;
          const paper = papers[actualIdx];
          q.paper_id = paper.id;
          q.paper_name = paper.name;
          q.subject_name = q.subject_name || paper.subjects;
          q.subject_tag = q.subject_tag || paper.id;
          // Fix duplicate IDs: append paper suffix
          if (!q._idFixed) {
            q.id = `${q.id}_${paper.id}`;
            q._idFixed = true;
          }
        });
      }
    }

    // Use stages from JSON data if available (from classification), otherwise from config
    let stages = raw.stages && raw.stages.length > 0
      ? [{ id: 0, tag: 'all', name: '隨機混合' }, ...raw.stages.filter(s => s.count > 0)]
      : cfg.stages || [{ id: 0, tag: 'all', name: '全部' }];
    if (!raw.stages && (!cfg.stages || cfg.stages.length <= 1) && papers.length > 1) {
      stages = [
        { id: 0, tag: 'all', name: '全部' },
        ...papers.map(p => ({ id: p.id, tag: p.id, name: `${p.name}`, subjects: p.subjects })),
      ];
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
  // PvP/practice: only single-answer questions (exclude multi-answer & voided)
  const valid = data.questions.filter(q => q.answer && q.answer.length === 1 && q.options[q.answer]);
  if (stageId === 0) return valid;
  return valid.filter(q => q.stage_id === stageId);
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

function getRoomPlayers(room, includeAnswer = false) {
  return Array.from(room.players.entries()).map(([id, p]) => ({
    id, name: p.name, avatar: p.avatar || '👨‍⚕️', score: p.score, ready: p.ready,
    isAI: p.isAI || false,
    ...(includeAnswer ? { lastAnswer: p.lastAnswer, answered: p.answered } : {}),
  }));
}

function broadcastRoomState(room) {
  io.to(room.code).emit('room_state', {
    code: room.code,
    players: getRoomPlayers(room),
    stage: room.stage,
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
}

// ── Socket events ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);
  stats.connections++;
  trackDailyVisit();
  const concurrent = io.engine?.clientsCount || 0;
  if (concurrent > stats.peakConcurrent) stats.peakConcurrent = concurrent;

  // Create room
  socket.on('create_room', ({ playerName, playerAvatar, isPublic = false, password = null, exam = 'doctor1' }) => {
    const code = makeRoomCode();
    const room = {
      code,
      hostId: socket.id,
      players: new Map([[socket.id, { name: playerName, avatar: playerAvatar || '👨‍⚕️', score: 0, ready: false, answered: false }]]),
      stage: 0,
      timerMode: 'auto',
      questions: [],
      qIndex: 0,
      timer: null,
      phase: 'lobby',
      isPublic: !!isPublic,
      password: password || null,
      exam: exam || 'doctor1',
      lastActivity: Date.now(),
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_created', { code });
    broadcastRoomState(room);
  });

  // Join room
  socket.on('join_room', ({ code, playerName, playerAvatar, password }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) {
      socket.emit('error', { message: '找不到房間，請確認邀請碼' });
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
    room.players.set(socket.id, { name: playerName, avatar: playerAvatar || '👨‍⚕️', score: 0, ready: false, answered: false });
    room.lastActivity = Date.now();
    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    socket.emit('room_joined', { code: code.toUpperCase() });
    broadcastRoomState(room);
  });

  // Rejoin room after reconnect
  socket.on('rejoin_room', ({ code, playerName, playerAvatar }) => {
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
    if (existingId) {
      const old = room.players.get(existingId);
      room.players.delete(existingId);
      room.players.set(socket.id, { ...old, avatar: playerAvatar || old.avatar });
      // Transfer host if needed
      if (room.hostId === existingId) room.hostId = socket.id;
    } else if (!room.players.has(socket.id)) {
      // New join (room still has space)
      if (room.players.size >= 4) { socket.emit('error', { message: '房間已滿' }); return; }
      room.players.set(socket.id, { name: playerName, avatar: playerAvatar || '👨‍⚕️', score: 0, ready: false, answered: false });
    }
    socket.join(code);
    socket.data.roomCode = code;
    room.lastActivity = Date.now();
    socket.emit('room_joined', { code });
    broadcastRoomState(room);
  });

  // Select stage (host only)
  socket.on('select_stage', ({ stageId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.stage = stageId;
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

    const pool = getQuestionsByStage(room.stage, room.exam);
    if (pool.length < QUESTIONS_PER_GAME) {
      socket.emit('error', { message: `此關卡題目不足（${pool.length}題），請換關卡` });
      return;
    }

    room.questions = shuffle(pool).slice(0, QUESTIONS_PER_GAME);
    room.qIndex = 0;
    room.phase = 'playing';
    room.lastActivity = Date.now();
    for (const p of room.players.values()) { p.score = 0; }

    io.to(room.code).emit('game_starting', {
      stageName: questionsData.stages.find(s => s.id === room.stage)?.name || '隨機',
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

  // Quick chat
  socket.on('send_chat', ({ type, content }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    io.to(room.code).emit('chat_msg', {
      fromId: socket.id,
      name: player.name,
      avatar: player.avatar || '👨‍⚕️',
      type,    // 'phrase' | 'sticker'
      content, // text or emoji
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

    // Transfer host if needed
    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value;
      io.to(code).emit('host_changed', { newHostId: room.hostId });
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

// ── Stats tracking (persist to file) ────────────────────────────────────
const STATS_FILE = path.join(__dirname, 'stats.json');

function loadStats() {
  const defaults = {
    connections: 0, peakConcurrent: 0, gamesPlayed: 0,
    questionsAnswered: 0, aiExplains: 0, dailyVisits: {},
    questionStats: {}, // { questionId: { correct: N, wrong: N } }
  };
  try {
    const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    return { ...defaults, ...data, startedAt: new Date().toISOString() };
  } catch {
    return { ...defaults, startedAt: new Date().toISOString() };
  }
}

const stats = loadStats();

function saveStats() {
  try {
    const { startedAt, ...persist } = stats;
    fs.writeFileSync(STATS_FILE, JSON.stringify(persist), 'utf-8');
  } catch {}
}

// Auto-save every 60 seconds
setInterval(saveStats, 60_000);

function trackDailyVisit() {
  const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  stats.dailyVisits[today] = (stats.dailyVisits[today] || 0) + 1;
  // 只保留最近 30 天
  const keys = Object.keys(stats.dailyVisits).sort();
  while (keys.length > 30) { delete stats.dailyVisits[keys.shift()]; }
}

// ── Register modular routes ────────────────────────────────────────────
leaderboard.registerRoutes(app);
questionsApi.registerRoutes(app, examData, stats, examConfigs, { staticCache, browseCache });
ai.registerRoutes(app, examData, stats);
commentsApi.registerRoutes(app);
communityNotes.registerRoutes(app);
feedback.registerRoutes(app, examData, examConfigs);
board.registerRoutes(app);

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

// Full exam registry (config-driven, cached aggressively)
app.get('/exam-registry', dayCache, (_, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json(examConfigs);
});

app.get('/stages', staticCache, (req, res) => {
  const exam = req.query.exam || 'doctor1';
  const data = getExamData(exam);
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(data.stages);
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
      stageName: questionsData.stages.find(s => s.id === room.stage)?.name || '隨機混合',
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

// Save stats on shutdown
process.on('SIGTERM', () => { saveStats(); commentsApi.saveComments(); communityNotes.saveNotes(); process.exit(0); });
process.on('SIGINT', () => { saveStats(); commentsApi.saveComments(); communityNotes.saveNotes(); process.exit(0); });

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
