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
    return questionsData.questions.filter(q => q.answer);
  }
  return questionsData.questions.filter(q => q.stage_id === stageId && q.answer);
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

const QUESTION_TIME = 15; // seconds
const QUESTIONS_PER_GAME = 10;

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getRoomPlayers(room) {
  return Array.from(room.players.entries()).map(([id, p]) => ({
    id, name: p.name, score: p.score, ready: p.ready
  }));
}

function broadcastRoomState(room) {
  io.to(room.code).emit('room_state', {
    code: room.code,
    players: getRoomPlayers(room),
    stage: room.stage,
    phase: room.phase,
    hostId: room.hostId,
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

  // Send question (without answer)
  io.to(room.code).emit('question', {
    index: room.qIndex,
    total: room.questions.length,
    number: q.number,
    question: q.question,
    options: q.options,
    timeLimit: QUESTION_TIME,
  });

  // Start countdown
  let remaining = QUESTION_TIME;
  room.timer = setInterval(() => {
    remaining--;
    io.to(room.code).emit('tick', { remaining });

    if (remaining <= 0) {
      clearInterval(room.timer);
      revealAnswer(room);
    }
  }, 1000);
}

function revealAnswer(room) {
  const q = room.questions[room.qIndex];
  io.to(room.code).emit('reveal', {
    correctAnswer: q.answer,
    players: getRoomPlayers(room),
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

  const players = getRoomPlayers(room).sort((a, b) => b.score - a.score);
  io.to(room.code).emit('game_over', { players });
}

// ── Socket events ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // Create room
  socket.on('create_room', ({ playerName }) => {
    const code = makeRoomCode();
    const room = {
      code,
      hostId: socket.id,
      players: new Map([[socket.id, { name: playerName, score: 0, ready: false, answered: false }]]),
      stage: 0,
      questions: [],
      qIndex: 0,
      timer: null,
      phase: 'lobby',
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_created', { code });
    broadcastRoomState(room);
  });

  // Join room
  socket.on('join_room', ({ code, playerName }) => {
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
    room.players.set(socket.id, { name: playerName, score: 0, ready: false, answered: false });
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

    const q = room.questions[room.qIndex];
    const isCorrect = answer === q.answer;

    // Score: 100 base, no time-bonus here (timer handled server-side separately)
    // The tick event carries remaining time; we'll compute score from remaining
    // For simplicity: just award 100 per correct answer
    if (isCorrect) {
      player.score += 100;
    }

    socket.emit('answer_result', {
      correct: isCorrect,
      correctAnswer: null, // hidden until reveal
      score: player.score,
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

// ── Health + stages API ──────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/stages', (_, res) => res.json(questionsData.stages));

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
  res.json({ total, page: parseInt(page), limit: parseInt(limit), questions: list.slice(start, start + parseInt(limit)) });
});

// GET /questions/random?stage_id=1&count=10  — fast random pick, no pagination overhead
app.get('/questions/random', (req, res) => {
  const { stage_id, count = 10 } = req.query;
  const tag = stage_id && parseInt(stage_id) > 0
    ? questionsData.stages.find(s => s.id === parseInt(stage_id))?.tag
    : null;
  let pool = questionsData.questions.filter(q => q.answer);
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
  res.json({ years, sessions, stages: questionsData.stages });
});

// ── Claude AI endpoints ───────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// POST /explain  — streaming SSE explanation for a single question
// Body: { question, options:{A,B,C,D}, answer, subject_name, user_answer? }
app.post('/explain', async (req, res) => {
  const { question, options, answer, subject_name, user_answer } = req.body;
  if (!question || !options || !answer) return res.status(400).json({ error: 'missing fields' });

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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
