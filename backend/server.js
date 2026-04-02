require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors({
  origin: (origin, cb) => cb(null, true), // allow all origins (Vercel + localhost)
  credentials: true,
}));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── Load questions ──────────────────────────────────────────────────────
const questionsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf-8')
);

function getQuestionsByStage(stageId) {
  if (stageId === 0) {
    // All questions
    return questionsData.questions.filter(q => q.answer && q.options[q.answer]);
  }
  return questionsData.questions.filter(q => q.stage_id === stageId && q.answer && q.options[q.answer]);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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

  // Start countdown
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
  socket.on('create_room', ({ playerName, playerAvatar, isPublic = false, password = null }) => {
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
    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    socket.emit('room_joined', { code: code.toUpperCase() });
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

    const pool = getQuestionsByStage(room.stage);
    if (pool.length < QUESTIONS_PER_GAME) {
      socket.emit('error', { message: `此關卡題目不足（${pool.length}題），請換關卡` });
      return;
    }

    room.questions = shuffle(pool).slice(0, QUESTIONS_PER_GAME);
    room.qIndex = 0;
    room.phase = 'playing';
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
    stats.questionsAnswered++;

    const q = room.questions[room.qIndex];
    const isCorrect = answer === q.answer;

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

// ── Stats tracking ──────────────────────────────────────────────────────
const stats = {
  startedAt: new Date().toISOString(),
  connections: 0,         // 總連線數
  peakConcurrent: 0,      // 最高同時在線
  gamesPlayed: 0,         // 完成的遊戲局數
  questionsAnswered: 0,   // 回答的題數
  aiExplains: 0,          // AI 解說次數
  dailyVisits: {},        // { '2026-04-02': 15 }
};

function trackDailyVisit() {
  const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  stats.dailyVisits[today] = (stats.dailyVisits[today] || 0) + 1;
  // 只保留最近 30 天
  const keys = Object.keys(stats.dailyVisits).sort();
  while (keys.length > 30) { delete stats.dailyVisits[keys.shift()]; }
}

// ── Health + stages + stats API ─────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/stages', (_, res) => res.json(questionsData.stages));

app.get('/stats', (_, res) => {
  const concurrent = io.engine?.clientsCount || 0;
  const activeRooms = Array.from(rooms.values()).filter(r => r.phase === 'playing').length;
  const lobbyRooms = Array.from(rooms.values()).filter(r => r.phase === 'lobby').length;
  const uptime = Math.floor((Date.now() - new Date(stats.startedAt).getTime()) / 1000);

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>醫學知識王 Stats</title>
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
<h1>📊 醫學知識王 即時統計</h1>

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

// ── Question browser API ──────────────────────────────────────────────────
// GET /questions?year=110&session=第一次&subject_tag=anatomy&q=搜尋文字&page=1&limit=20
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

// GET /questions/random?stage_id=1&count=10  — fast random pick, no pagination overhead
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

// GET /meta  — year/session/subject_tag options with counts
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

// ── AI endpoints ─────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Daily AI usage counter (resets at midnight Taipei time) ────
const aiUsage = { date: '', count: 0 };
const AI_DAILY_LIMIT = 100;

function checkAILimit() {
  const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  if (aiUsage.date !== today) { aiUsage.date = today; aiUsage.count = 0; }
  if (aiUsage.count >= AI_DAILY_LIMIT) return false;
  aiUsage.count++;
  stats.aiExplains++;
  return true;
}

app.post('/explain', async (req, res) => {
  const { question, options, answer, subject_name, user_answer } = req.body;
  if (!question || !options || !answer) return res.status(400).json({ error: 'missing fields' });
  if (!checkAILimit()) return res.status(429).json({ error: 'daily_limit', message: '今日 AI 解說次數已達上限，明天再來喔！' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const optionText = Object.entries(options).map(([k,v]) => `${k}. ${v}`).join('\n');
  const wrongNote  = user_answer && user_answer !== answer
    ? `考生選了 ${user_answer}，但正確答案是 ${answer}。`
    : '';

  const prompt = `你是一位臺灣醫師國考（一階）的解題老師，用繁體中文回答。

科目：${subject_name}
題目：${question}

選項：
${optionText}

正確答案：${answer}
${wrongNote}

請用以下格式回答（每段都要有，簡潔扼要）：

**✅ 為什麼答案是 ${answer}**
（說明核心機制或概念，2-3句）

**❌ 排除其他選項**
（每個錯誤選項一句話說明為何不對）

**🧠 記憶關鍵字**
（給一個好記的口訣或記憶技巧）

**🏥 臨床應用**
（一句話說明這個知識點在臨床上的意義）`;

  try {
    const stream = await anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

// POST /review  — review a completed match/practice session
// Body: { questions: [{question, options, answer, user_answer, subject_name}], mode }
app.post('/review', async (req, res) => {
  const { questions, mode = 'practice' } = req.body;
  if (!questions?.length) return res.status(400).json({ error: 'no questions' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const wrong  = questions.filter(q => q.user_answer !== q.answer);
  const total  = questions.length;
  const correct = total - wrong.length;

  const wrongSummary = wrong.slice(0, 8).map((q, i) =>
    `${i+1}. [${q.subject_name}] ${q.question.slice(0,60)}…\n   我選：${q.user_answer || '未作答'}，正確：${q.answer}`
  ).join('\n');

  const subjectStats = {};
  for (const q of questions) {
    if (!subjectStats[q.subject_name]) subjectStats[q.subject_name] = { total: 0, wrong: 0 };
    subjectStats[q.subject_name].total++;
    if (q.user_answer !== q.answer) subjectStats[q.subject_name].wrong++;
  }
  const statText = Object.entries(subjectStats)
    .map(([s,v]) => `${s}: ${v.total - v.wrong}/${v.total}`)
    .join('、');

  const prompt = `你是一位臺灣醫師國考（一階）的家教老師，用繁體中文給學生檢討報告。

本次${mode === 'battle' ? '對戰' : '練習'}成績：答對 ${correct}/${total} 題
各科表現：${statText}

答錯的題目（前8題）：
${wrongSummary || '（全部答對！）'}

請用以下格式給出**個人化學習建議**：

**📊 本次表現總評**
（2句話評價整體表現，語氣鼓勵但誠實）

**💪 強項科目**
（說明哪些科目表現好，為什麼）

**⚠️ 需要加強**
（列出最需要複習的1-3個科目，具體說明弱點）

**📝 錯題分析**
（針對答錯的題目，找出共同的錯誤模式或知識盲點）

**🗓️ 建議複習計畫**
（給3個具體可執行的複習建議）`;

  try {
    const stream = await anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

// POST /daily-message — personalized daily motivational message
// Body: { name, level }
app.post('/daily-message', async (req, res) => {
  const { name = '學員', level = 1 } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const today = new Date().toLocaleDateString('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  const prompt = `你是醫學知識王的AI導師。今天是${today}。
請為正在備考醫師一階國考的醫學生「${name}」（遊戲等級 Lv.${level}）寫一段今日寄語。

要求：
- 70字以內
- 語氣像過來人的前輩醫師：溫暖、真實、不說教
- 融入真實備考情感（疲憊、堅持、那個還沒放棄的自己）
- 可以用人體或醫學作隱喻，讓文字有質感
- 繁體中文，台灣語感，不要英文
- 直接輸出文字，不要任何格式標籤或前綴`;

  try {
    const stream = await anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 180,
      messages: [{ role: 'user', content: prompt }],
    });
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
